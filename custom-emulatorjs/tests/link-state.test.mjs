import test from "node:test";
import assert from "node:assert/strict";
import { encodeLinkState, decodeLinkState } from "../input-netplay/state.js";

const context = {
  manifest: { core: "mgba_splitscreen", roms: ["gold", "silver"] },
  player: 1,
};
const state = Uint8Array.of(4, 7, 8, 12);

test("solo link states round-trip their core state", () => {
  assert.deepEqual(
    decodeLinkState(context, encodeLinkState(context, state), state.length),
    state,
  );
});

test("states reject another cartridge, player, build, or damaged data before core restore", () => {
  const encoded = encodeLinkState(context, state);
  for (const other of [
    { ...context, player: 0 },
    {
      ...context,
      manifest: { ...context.manifest, roms: ["gold", "crystal"] },
    },
    { ...context, manifest: { ...context.manifest, core: "sameboy" } },
  ])
    assert.throws(() => decodeLinkState(other, encoded, state.length));
  encoded[encoded.length - 1] ^= 1;
  assert.throws(() => decodeLinkState(context, encoded, state.length));
  assert.throws(() =>
    decodeLinkState(context, encoded.subarray(1), state.length),
  );
  assert.throws(() =>
    decodeLinkState(context, encodeLinkState(context, state), 5),
  );
});
