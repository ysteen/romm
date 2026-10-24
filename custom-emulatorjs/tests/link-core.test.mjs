import test from "node:test";
import assert from "node:assert/strict";
import {
  importBattery,
  linkCore,
  unpackLinkCartridge,
} from "../data/src/link-core.js";

test("maps each linked console to its own SRAM and libretro subsystem", () => {
  const gb = linkCore("sameboy"),
    gba = linkCore("mgba_splitscreen");
  assert.deepEqual(gb.memoryIds, [256, 768]);
  assert.deepEqual(gba.memoryIds, [0, 256]);
  assert.equal(gb.subsystem, "gb_link_2p");
  assert.equal(gba.subsystem, "gba_link_2p");
  assert.equal(gba.width / gba.height, 1.5);
  assert.throws(() => linkCore("mgba"), /does not support/);
});

test("imports ordinary GBA SRAM sizes without changing the other cartridge", () => {
  const memory = [
    new Uint8Array(131072).fill(71),
    new Uint8Array(131072).fill(83),
  ];
  const core = {
    memory: (id) => memory[id === 0 ? 0 : 1],
    loadMemory(id, bytes) {
      assert.equal(bytes.length, 131072);
      memory[id === 0 ? 0 : 1].set(bytes);
    },
  };
  for (const size of [512, 8192, 32768, 65536, 131072]) {
    importBattery(
      core,
      linkCore("mgba_splitscreen"),
      1,
      new Uint8Array(size).fill(19),
    );
    assert.ok(memory[0].every((b) => b === 71));
    assert.ok(memory[1].slice(0, size).every((b) => b === 19));
    assert.ok(memory[1].slice(size).every((b) => b === 255));
  }
  assert.throws(() =>
    importBattery(core, linkCore("mgba_splitscreen"), 0, new Uint8Array(777)),
  );
});

test("uses the cartridge bytes from a ZIP, ignoring documents and resource forks", async () => {
  const rom = new Uint8Array(1024).fill(7);
  const compression = {
    isCompressed: () => "zip",
    decompress: async () => ({
      "설명.txt": new Uint8Array(9),
      "__MACOSX/._game.gba": new Uint8Array(12),
      "젤다/게임.GBA": rom,
    }),
  };
  const result = await unpackLinkCartridge(
    new Uint8Array(50),
    linkCore("mgba_splitscreen"),
    compression,
  );
  assert.equal(result, rom);
  compression.decompress = async () => ({ "Gold.GBC": rom });
  assert.equal(
    await unpackLinkCartridge(
      new Uint8Array(50),
      linkCore("sameboy"),
      compression,
    ),
    rom,
  );
});

test("rejects ambiguous, wrong-system and oversized archive cartridges before boot", async () => {
  const rom = new Uint8Array(1024);
  const profile = linkCore("mgba_splitscreen");
  for (const files of [
    { "one.gba": rom, "two.gba": rom },
    { "other.gbc": rom },
    { README: rom },
    { "tiny.gba": new Uint8Array(1) },
    { "huge.gba": { length: profile.maxRomSize + 1 } },
  ]) {
    const compression = {
      isCompressed: () => "zip",
      decompress: async () => files,
    };
    await assert.rejects(
      unpackLinkCartridge(rom, profile, compression),
      /cartridge/,
    );
  }
  await assert.rejects(
    unpackLinkCartridge(rom, profile, { isCompressed: () => "7z" }),
    /ZIP/,
  );
});

test("raw cartridges use the same validation without invoking decompression", async () => {
  const rom = new Uint8Array(1024);
  const compression = { isCompressed: () => null, decompress: assert.fail };
  assert.equal(
    await unpackLinkCartridge(rom, linkCore("mgba_splitscreen"), compression),
    rom,
  );
  await assert.rejects(
    unpackLinkCartridge(new Uint8Array(8), linkCore("sameboy"), compression),
    /size/,
  );
});
