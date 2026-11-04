import { crc32 } from "../data/src/bridge-session.js";

export async function describeCartridge(romId, bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return {
    romId,
    size: bytes.length,
    crc32: crc32(bytes),
    sha256: Array.from(hash, (value) =>
      value.toString(16).padStart(2, "0"),
    ).join(""),
  };
}

export function assertCartridges(expected, actual) {
  if (
    expected.length !== actual.length ||
    expected.some((rom, i) =>
      ["romId", "sha256", "size", "crc32"].some(
        (key) => rom[key] !== actual[i][key],
      ),
    )
  )
    throw new Error(
      "The room's cartridge order or game files have changed. Prepare the room again.",
    );
}

export function participantClient(member) {
  if (member.clientPlatform?.startsWith("windows-"))
    return member.kind === "preparing"
      ? "Windows · Preparing"
      : member.ready
        ? "Windows · RetroArch"
        : "Windows · Connecting";
  return member.kind === "web" ? "Web" : "RetroArch";
}

export function encodeBattery(bytes) {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(text);
}
