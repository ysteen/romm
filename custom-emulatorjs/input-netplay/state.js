import { stateHash } from "../data/src/input-netplay.js?v=20261021.10";

const magic = new TextEncoder().encode("ROMLINK1");

export function encodeLinkState(context, state) {
  const header = new TextEncoder().encode(
    JSON.stringify({ context, hash: stateHash(state) }),
  );
  const result = new Uint8Array(12 + header.length + state.length);
  result.set(magic);
  new DataView(result.buffer).setUint32(8, header.length, true);
  result.set(header, 12);
  result.set(state, 12 + header.length);
  return result;
}

export function decodeLinkState(context, bytes, stateSize) {
  if (bytes.length < 12 || !magic.every((byte, i) => bytes[i] === byte))
    throw new Error("Incompatible link state");
  const length = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(8, true);
  if (length > 16384 || bytes.length !== 12 + length + stateSize)
    throw new Error("Invalid link state size");
  const header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(12, 12 + length)),
  );
  const state = bytes.subarray(12 + length);
  if (
    JSON.stringify(header.context) !== JSON.stringify(context) ||
    header.hash !== stateHash(state)
  )
    throw new Error(
      "This state belongs to different cartridges, a different player, or another core build",
    );
  return state;
}
