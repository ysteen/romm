import assert from "node:assert/strict";
import test from "node:test";
import {
  describeCartridge,
  assertCartridges,
  participantClient,
  encodeBattery,
} from "../input-netplay/room-content.js";

test("cartridge vectors detect reordered slots and a changed secondary ROM", async () => {
  const first = await describeCartridge(11, Uint8Array.of(1, 2));
  const second = await describeCartridge(12, Uint8Array.of(3, 4));
  assertCartridges([first, second], [{ ...first }, { ...second }]);
  assert.throws(() => assertCartridges([first, second], [second, first]));
  assert.throws(() =>
    assertCartridges(
      [first, second],
      [first, { ...second, sha256: first.sha256 }],
    ),
  );
});
test("participant badges distinguish preparation, connecting and Windows play", () => {
  const windows = {
    clientPlatform: "windows-x86_64",
    kind: "preparing",
    ready: false,
  };
  assert.equal(participantClient(windows), "Windows · Preparing");
  assert.equal(
    participantClient({ ...windows, kind: "native" }),
    "Windows · Connecting",
  );
  assert.equal(
    participantClient({ ...windows, kind: "native", ready: true }),
    "Windows · RetroArch",
  );
  assert.equal(participantClient({ kind: "web" }), "Web");
  const battery = Uint8Array.from({ length: 131072 }, (_, i) => i % 256);
  assert.deepEqual(
    Buffer.from(encodeBattery(battery), "base64"),
    Buffer.from(battery),
  );
});
