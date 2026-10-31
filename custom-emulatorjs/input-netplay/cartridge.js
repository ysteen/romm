import { EJS_COMPRESSION } from "../data/src/compression.js";
import { unpackLinkCartridge } from "../data/src/link-core.js?v=20261101.1";

// Room archives contain exactly one cartridge. Keep decompression bounded and
// terminate its worker after extraction; this path also runs before core boot.
export async function unpackRoomCartridge(bytes, profile) {
  const detector = new EJS_COMPRESSION(null);
  const cartridge = await unpackLinkCartridge(bytes, profile, {
    isCompressed: (data) => detector.isCompressed(data),
    async decompress(data) {
      const response = await fetch(
        new URL("../data/compression/extractzip.js", import.meta.url),
      );
      if (!response.ok)
        throw new Error("Could not load cartridge decompression support");
      const url = URL.createObjectURL(
        new Blob([await response.text()], { type: "application/javascript" }),
      );
      let worker;
      let timeout;
      try {
        worker = new Worker(url);
        return await new Promise((resolve, reject) => {
          const files = {};
          timeout = setTimeout(
            () => reject(new Error("Cartridge extraction timed out")),
            30_000,
          );
          worker.onerror = () =>
            reject(new Error("Could not extract cartridge archive"));
          worker.onmessageerror = worker.onerror;
          worker.onmessage = ({ data: message }) => {
            if (message?.t === 2) files[message.file] = message.data;
            if (message?.t === 1) resolve(files);
          };
          worker.postMessage(data);
        });
      } finally {
        clearTimeout(timeout);
        worker?.terminate();
        URL.revokeObjectURL(url);
      }
    },
  });
  return profile.core === "snes9x" ? assertNtscSnes(cartridge) : cartridge;
}

// The qualified room clock is NTSC. Fail closed for PAL or ambiguous headers
// until the frontend exports the core's parsed AV timing. This intentionally
// accepts only standard, non-interleaved LoROM/HiROM cartridges with a valid
// checksum pair, rather than guessing a region for patched/extended images.
export function assertNtscSnes(bytes) {
  const copierHeader = bytes.length % 0x8000 === 512 ? 512 : 0;
  const size = bytes.length - copierHeader;
  const headers = [];
  if (size <= 0x400000) {
    for (const [offset, modes] of [
      [0x7fc0, [0x20, 0x30, 0x23]],
      [0xffc0, [0x21, 0x31]],
    ]) {
      const start = offset + copierHeader;
      if (start + 64 > bytes.length || !modes.includes(bytes[start + 0x15]))
        continue;
      const word = (at) => bytes[start + at] | (bytes[start + at + 1] << 8);
      if (
        word(0x1c) + word(0x1e) !== 0xffff ||
        word(0x3c) < 0x8000 ||
        word(0x3c) > 0xffb0
      )
        continue;
      headers.push(bytes[start + 0x19]);
    }
  }
  if (headers.length !== 1)
    throw new Error(
      "SNES rooms currently require a standard NTSC LoROM or HiROM cartridge with a valid header.",
    );
  if ((headers[0] >= 2 && headers[0] <= 12) || headers[0] === 18)
    throw new Error(
      "PAL SNES multiplayer is not enabled yet. Choose an NTSC cartridge for this room.",
    );
  return bytes;
}
