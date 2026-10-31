import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  bridgeCore,
  bridgeCoreFor,
  bridgeBatteryId,
  bridgeSeed,
  bridgeSaveSelection,
} from "../data/src/bridge-profile.js";
import { unpackLinkCartridge, importBattery } from "../data/src/link-core.js";

test("handheld room profiles retain separate cartridges and battery slots", () => {
  for (const [platform, core] of [
    ["gb", "sameboy"],
    ["gbc", "sameboy"],
    ["gba", "mgba_splitscreen"],
  ]) {
    const profile = bridgeCore(bridgeCoreFor(platform));
    assert.equal(profile.core, core);
    assert.equal(profile.sharedSave, false);
    assert.notEqual(bridgeBatteryId(profile, 0), bridgeBatteryId(profile, 1));
    const seed = new Uint8Array([7]);
    assert.equal(bridgeSeed(profile, 1, seed), seed);
  }
  assert.equal(bridgeCore("mgba_splitscreen", 4).players, 4);
  assert.throws(() => bridgeCoreFor("nes"), /support/);
});

test("SNES uses one cartridge and preserves the host's shared save", () => {
  const profile = bridgeCore("snes9x");
  assert.equal(profile.standardGame, true);
  assert.equal(profile.system, "snes");
  assert.equal(profile.columns, 1);
  assert.equal(bridgeBatteryId(profile, 0), 0);
  assert.equal(bridgeBatteryId(profile, 1), 0);
  assert.throws(() => bridgeCore("snes9x", 3), /two players/);
  const seed = new Uint8Array(2048).fill(49);
  assert.equal(bridgeSeed(profile, 0, seed), seed);
  assert.equal(bridgeSeed(profile, 1, seed).length, 0);
  let saved;
  importBattery(
    {
      memory: () => new Uint8Array(2048),
      loadMemory(id, bytes) {
        assert.equal(id, 0);
        saved = bytes;
      },
    },
    profile,
    0,
    seed,
  );
  assert.equal(saved, seed);
});

test("SNES archives select one cartridge and reject ambiguous or wrong-system files", async () => {
  const profile = bridgeCore("snes9x"),
    rom = new Uint8Array(32768);
  const compression = {
    isCompressed: () => "zip",
    decompress: async () => ({
      "README.txt": new Uint8Array(3),
      "game.SMC": rom,
    }),
  };
  assert.equal(
    await unpackLinkCartridge(new Uint8Array(), profile, compression),
    rom,
  );
  compression.decompress = async () => ({ "a.sfc": rom, "b.smc": rom });
  await assert.rejects(
    unpackLinkCartridge(rom, profile, compression),
    /exactly one/,
  );
  compression.decompress = async () => ({ "other.gba": rom });
  await assert.rejects(
    unpackLinkCartridge(rom, profile, compression),
    /exactly one/,
  );
});

test("published room profiles use matching qualified web and native artifacts", async () => {
  const catalog = JSON.parse(
    await readFile(
      new URL("../input-netplay/bridge-cores.json", import.meta.url),
    ),
  );
  for (const core of ["sameboy", "mgba_splitscreen", "snes9x"]) {
    const { web, native } = catalog[core];
    assert.equal(web.maxPrediction, 12);
    assert.equal(native.maxPrediction, 12);
    assert.equal(web.coreVersion, native.coreVersion);
    assert.deepEqual(web.paths, native.paths);
    assert.equal(native.nativeCalibration, undefined);
    const base = new URL("../input-netplay/", import.meta.url);
    const manifest = JSON.parse(await readFile(new URL(native.manifest, base)));
    assert.equal(manifest.version, native.coreVersion);
    assert.equal(manifest.platform, "linux-x86_64");
    for (const [filename, digest] of Object.entries(manifest.sha256)) {
      const bytes = await readFile(
        new URL(filename, new URL(native.manifest, base)),
      );
      assert.equal(createHash("sha256").update(bytes).digest("hex"), digest);
    }
  }
});

test("SNES room timing gate accepts NTSC headers and rejects PAL or uncertain layouts", async () => {
  const { assertNtscSnes } = await import("../input-netplay/cartridge.js");
  function cartridge({ hirom = false, region = 1, copier = false } = {}) {
    const data = new Uint8Array(0x20000 + (copier ? 512 : 0));
    const base = (hirom ? 0xffc0 : 0x7fc0) + (copier ? 512 : 0);
    data[base + 0x15] = hirom ? 0x21 : 0x20;
    data[base + 0x19] = region;
    data[base + 0x1c] = data[base + 0x1d] = 0xff;
    data[base + 0x3d] = 0x80;
    return data;
  }
  for (const hirom of [true, false])
    for (const copier of [true, false]) {
      const ntsc = cartridge({ hirom, copier });
      assert.equal(assertNtscSnes(ntsc), ntsc);
      for (const region of [2, 12, 18])
        assert.throws(
          () => assertNtscSnes(cartridge({ hirom, copier, region })),
          /PAL/,
        );
    }
  assert.throws(() => assertNtscSnes(new Uint8Array(0x20000)), /valid header/);
  const ambiguous = cartridge();
  ambiguous.set(cartridge({ hirom: true }).subarray(0xffc0, 0x10000), 0xffc0);
  assert.throws(() => assertNtscSnes(ambiguous), /valid header/);
});

test("mGBA rooms seed from the newest compatible single-player save and preserve its slot", () => {
  const oldRoom = {
    id: 1,
    emulator: "mgba_splitscreen",
    slot: "link",
    updated_at: "2026-10-01T00:00:00Z",
  };
  const latest = {
    id: 2,
    emulator: "mgba",
    slot: "default",
    updated_at: "2026-11-01T00:00:00Z",
  };
  const unrelated = {
    id: 3,
    emulator: "vba_next",
    updated_at: "2026-11-02T00:00:00Z",
  };
  const missing = {
    ...latest,
    id: 4,
    missing_from_fs: true,
    updated_at: "2026-11-03T00:00:00Z",
  };
  const result = bridgeSaveSelection(bridgeCore("mgba_splitscreen"), [
    oldRoom,
    latest,
    unrelated,
    missing,
  ]);
  assert.equal(result.selected, latest);
  assert.equal(result.target, oldRoom);
  assert.equal(
    bridgeSaveSelection(bridgeCore("mgba_splitscreen"), [latest]).target,
    null,
  );
  assert.equal(
    bridgeSaveSelection(bridgeCore("sameboy"), [latest]).selected,
    null,
  );
  let imported;
  importBattery(
    {
      memory: () => new Uint8Array(131072),
      loadMemory: (id, data) => {
        imported = { id, data };
      },
    },
    bridgeCore("mgba_splitscreen"),
    0,
    new Uint8Array(32768).fill(71),
  );
  assert.equal(imported.id, 0);
  assert.equal(imported.data.length, 131072);
  assert.equal(imported.data[32767], 71);
  assert.equal(imported.data[32768], 255);
});
