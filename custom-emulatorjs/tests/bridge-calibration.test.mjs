import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { calibrateSameBoy } from "../data/src/bridge-calibration.js";

function snapshot(frame, seed = 17, machineSize = 50684) {
  const bytes = new Uint8Array(252666);
  const view = new DataView(bytes.buffer);
  for (const base of [0, machineSize]) {
    bytes.set([0x45, 0x4d, 0x41, 0x53, 15, 0, 0, 0], base);
    let offset = base + 8;
    for (const size of [152, 24, 96, 256, 64, 104, 32, 464, 32680]) {
      view.setUint32(offset, size, true);
      offset += 4 + size;
    }
    view.setUint32(base + 556, frame, true);
    bytes[base + 1000] = frame;
    bytes[base + 1001] = seed;
    const bessStart = base + machineSize - 384;
    offset = bessStart;
    for (const [tag, length] of [
      ["NAME", 14],
      ["INFO", 18],
      ["CORE", 208],
      ["XOAM", 96],
      ["END ", 0],
    ]) {
      bytes.set(
        [...tag].map((letter) => letter.charCodeAt(0)),
        offset,
      );
      view.setUint32(offset + 4, length, true);
      offset += 8 + length;
    }
    view.setUint32(offset, bessStart - base, true);
    bytes.set([0x42, 0x45, 0x53, 0x53], offset + 4);
  }
  return bytes;
}

class Core {
  size = 252666;
  profile = { core: "sameboy", players: 2 };
  hiddenFrame = 1;
  state = snapshot(1, 99);
  steps = 0;
  loads = 0;
  machineSize = 50684;
  save() {
    return this.state.slice();
  }
  load(bytes) {
    this.loads++;
    this.state = bytes.slice();
  }
  step(a, b, present) {
    assert.equal(a, 0);
    assert.equal(b, 0);
    assert.equal(present, false);
    this.steps++;
    this.hiddenFrame++;
    const frame = new DataView(this.state.buffer).getUint32(556, true) + 1;
    this.state = snapshot(frame, this.state[1001], this.machineSize);
    this.state[1000] = this.hiddenFrame;
    this.state[this.machineSize + 1000] = this.hiddenFrame;
  }
}

test("calibration aligns hidden execution history and verifies the complete next state", async () => {
  const core = new Core();
  const first = snapshot(27);
  const second = snapshot(28);
  const result = await calibrateSameBoy(core, first, second);
  assert.equal(result.matchedColdFrame, 27);
  assert.equal(core.loads, 1);
  assert.equal(core.steps, 27);
  assert.deepEqual(core.save(), second);
  assert.deepEqual(first, snapshot(27));
});

test("a matching phase alone cannot admit an incompatible full state", async () => {
  const core = new Core();
  const second = snapshot(4);
  second[2000] = 1;
  await assert.rejects(
    calibrateSameBoy(core, snapshot(3), second),
    /next native frame differs/,
  );
});

test("iframe-realm snapshots and ArrayBuffers calibrate without instanceof assumptions", async () => {
  const context = vm.createContext({});
  const foreign = (bytes) => {
    const result = vm.runInContext(`new Uint8Array(${bytes.length})`, context);
    result.set(bytes);
    return result;
  };
  const core = new Core();
  core.save = () => foreign(core.state);
  const result = await calibrateSameBoy(
    core,
    foreign(snapshot(3)),
    foreign(snapshot(4)).buffer,
  );
  assert.equal(result.matchedColdFrame, 3);
  assert.deepEqual(new Uint8Array(core.save()), snapshot(4));
});

test("battery RAM changes machine boundaries and embedded magic cannot replace a valid footer", async () => {
  const core = new Core();
  core.machineSize += 32768;
  core.state = snapshot(1, 99, core.machineSize);
  const first = snapshot(3, 17, core.machineSize);
  const second = snapshot(4, 17, core.machineSize);
  first.set(
    [0x42, 0x45, 0x53, 0x53, 0x45, 0x4d, 0x41, 0x53, 15, 0, 0, 0],
    40000,
  );
  const result = await calibrateSameBoy(core, first, second);
  assert.equal(result.matchedColdFrame, 3);
  assert.deepEqual(core.save(), second);
});

test("malformed, patched and wrong-profile states are rejected before advancing", async () => {
  const states = [];
  const version = snapshot(2);
  version[4] = 16;
  states.push(version);
  const section = snapshot(2);
  section[620] = 103;
  states.push(section);
  const machine = snapshot(2);
  machine[50680] = 0;
  states.push(machine);
  states.push(new Uint8Array(12));
  for (const first of states) {
    const core = new Core();
    await assert.rejects(
      calibrateSameBoy(core, first, snapshot(3)),
      /calibration failed/,
    );
    assert.equal(core.steps, 0);
  }
  const core = new Core();
  core.profile.core = "mgba_splitscreen";
  await assert.rejects(
    calibrateSameBoy(core, snapshot(2), snapshot(3)),
    /adapter\/profile/,
  );
});

test("an unmatched native phase has a finite search budget and yields to the event loop", async () => {
  const core = new Core();
  let yielded = false;
  setTimeout(() => {
    yielded = true;
  }, 0);
  await assert.rejects(
    calibrateSameBoy(core, snapshot(1801), snapshot(1802)),
    /1800 neutral frames/,
  );
  assert.equal(core.steps, 1799);
  assert.equal(core.loads, 0);
  assert.equal(yielded, true);
});
