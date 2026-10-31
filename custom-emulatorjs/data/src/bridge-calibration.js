const HEADER = [0x45, 0x4d, 0x41, 0x53, 15, 0, 0, 0];
const MAX_FRAMES = 1800;
const MAX_MILLISECONDS = 15000;

function incompatible(detail) {
  return new Error(`SameBoy startup calibration failed: ${detail}. Use the matched SameBoy 1.0.4 c87d256 core, identical ROMs/options and 48000 Hz audio; restart the room without pressing game controls during connection.`);
}

function equal(a, b, start = 0, end = a.length) {
  if (a.length !== b.length) return false;
  for (let at = start; at < end; at++) if (a[at] !== b[at]) return false;
  return true;
}

function viewBytes(value) {
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]")
    return new Uint8Array(value);
  return null;
}

function bytes(value, size) {
  value = viewBytes(value);
  if (!value || value.length !== size)
    throw incompatible("unexpected native snapshot size");
  return value.slice();
}

function layout(state) {
  const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
  const headerAt = (offset) => HEADER.every((byte, i) => state[offset + i] === byte);
  const tagAt = (offset, tag) => [...tag].every((letter, i) => state[offset + i] === letter.charCodeAt(0));
  if (!headerAt(0)) throw incompatible("unsupported state header/version");
  const offsets = [], sectionSizes = [], ends = [];
  const ranges = [];
  let base = 0;
  for (let player = 0; player < 2; player++) {
    if (!headerAt(base)) throw incompatible("expected two linked Game Boy states");
    offsets.push(base);
    let offset = base + HEADER.length;
    const sizes = [];
    for (let section = 0; section < 9; section++) {
      if (offset + 4 > state.length) throw incompatible("truncated state section");
      const size = view.getUint32(offset, true);
      if (size < 4 || size > 65536 || offset + 4 + size > state.length)
        throw incompatible("unsupported core state layout");
      sizes.push(size);
      // Timing and APU fingerprints exclude randomized power-on RAM.
      if (section === 4 || section === 5) ranges.push([offset + 4, offset + 4 + size]);
      offset += 4 + size;
    }
    sectionSizes.push(sizes);
    // Cartridge RAM and CGB/SGB memory make each machine's length variable.
    // Validate the BESS footer's relative pointer and complete block chain;
    // a literal BESS/EMAS sequence inside cartridge RAM is not a boundary.
    let end = 0;
    for (let magic = offset + 4; magic + 4 <= state.length; magic++) {
      if (!tagAt(magic, "BESS")) continue;
      const footer = magic - 4;
      const start = base + view.getUint32(footer, true);
      if (start < offset || start + 8 > footer || !tagAt(start, "NAME")) continue;
      let block = start, blocks = 0, valid = false;
      while (block + 8 <= footer && blocks < 64) {
        const length = view.getUint32(block + 4, true);
        if (length > 1024 * 1024 || block + 8 + length > footer) break;
        const required = ["NAME", "INFO", "CORE"][blocks];
        if (required && !tagAt(block, required)) break;
        blocks++;
        if (tagAt(block, "END ")) {
          const padding = footer - block - 8;
          valid = blocks >= 4 && length === 0 && padding <= 256;
          for (let at = block + 8; valid && at < footer; at++) valid = state[at] === 0;
          break;
        }
        block += 8 + length;
      }
      if (valid && (player === 1 || headerAt(magic + 4))) {
        end = magic + 4;
        break;
      }
    }
    if (!end) throw incompatible("invalid cartridge state footer");
    ends.push(end);
    base = end;
  }
  return { offsets, ranges, sectionSizes, ends };
}

function sameLayout(a, b) {
  return a.offsets.every((offset, player) => offset === b.offsets[player] &&
    a.ends[player] === b.ends[player] &&
    a.sectionSizes[player].every((size, section) => size === b.sectionSizes[player][section]));
}

/**
 * Start with a fresh stock SameBoy adapter after its single neutral warmup frame.
 * `first` and `second` must be consecutive untouched native snapshots separated
 * by exactly one neutral frame, captured before any state is sent to that PC.
 * On success the adapter remains at `second`, with matching hidden audio timing.
 * The caller owns restoring its original host state and sending that same state
 * to the paused native peer. On failure discard the adapter; loading a snapshot
 * cannot undo the stock core's hidden audio history. No caller state is restored.
 */
export async function calibrateSameBoy(adapter, first, second) {
  if (adapter?.profile?.core !== "sameboy" || adapter.profile.players !== 2 ||
      !Number.isSafeInteger(adapter.size) || adapter.size < 64 || adapter.size > 16 * 1024 * 1024 ||
      typeof adapter.save !== "function" ||
      typeof adapter.load !== "function" || typeof adapter.step !== "function")
    throw incompatible("unsupported adapter/profile");
  first = bytes(first, adapter.size);
  second = bytes(second, adapter.size);
  const firstLayout = layout(first);
  const { ranges } = firstLayout;
  const secondLayout = layout(second);
  if (!sameLayout(firstLayout, secondLayout))
    throw incompatible("native snapshots use different cartridge layouts");

  const start = performance.now();
  let lastYield = start;
  let stepsSinceYield = 0;
  for (let frame = 1; frame <= MAX_FRAMES; frame++) {
    if (performance.now() - start > MAX_MILLISECONDS)
      throw incompatible("native startup exceeded the calibration time limit");
    const candidate = viewBytes(adapter.save());
    if (!candidate || candidate.length !== adapter.size)
      throw incompatible("web core produced an invalid snapshot");
    if (frame === 1) {
      const candidateLayout = layout(candidate);
      if (!sameLayout(firstLayout, candidateLayout))
        throw incompatible("web and native cartridge layouts differ");
    }
    if (ranges.every(([from, to]) => equal(candidate, first, from, to))) {
      adapter.load(first);
      const restored = viewBytes(adapter.save());
      if (!restored || !equal(restored, first))
        throw incompatible("native state did not round-trip exactly");
      adapter.step(0, 0, false);
      const continued = viewBytes(adapter.save());
      if (!continued || !equal(continued, second))
        throw incompatible("the next native frame differs after phase alignment");
      return { matchedColdFrame: frame, elapsedMilliseconds: performance.now() - start };
    }
    if (frame === MAX_FRAMES) break;
    adapter.step(0, 0, false);
    stepsSinceYield++;
    if (stepsSinceYield >= 8 || performance.now() - lastYield >= 12) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      lastYield = performance.now();
      stepsSinceYield = 0;
    }
  }
  throw incompatible(`native phase was not found within ${MAX_FRAMES} neutral frames`);
}
