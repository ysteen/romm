const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

const read = (file) =>
  readFileSync(require.resolve("../data/src/" + file), "utf8");
const constants = runInNewContext(
  read("consts.js").replace(/^export /gm, "") + "\n({ cores, netplaySystems })",
);
const Emulator = runInNewContext(
  read("emulator.js")
    .replace(/^import .*;$/gm, "")
    .replace(/^export .*;$/gm, "") + "\nEmulatorJS",
  { CONSTS: constants },
);

function runtime(core, controlScheme) {
  return Object.assign(Object.create(Emulator.prototype), {
    config: { system: core, controlScheme },
    preGetSetting: () => null,
  });
}

test("DOS automatic mouse input follows touch and physical mouse without saving a preference", () => {
  const emu = runtime("dosbox_pure");
  const changes = [];
  emu.started = true;
  emu.paused = false;
  emu.getSettingValue = () => "true";
  emu.gameManager = { setVariable: (key, value) => changes.push([key, value]) };
  for (const pointerType of [
    "touch",
    "touch",
    "mouse",
    "mouse",
    "touch",
    "pen",
  ]) {
    emu.updateDosBoxMouseInput({ pointerType });
  }
  assert.deepEqual(
    changes,
    ["pad", "true", "pad", "true"].map((value) => [
      "dosbox_pure_mouse_input",
      value,
    ]),
  );
});

test("DOS touch input respects explicit core modes and paused or stopped sessions", () => {
  const emu = runtime("dosbox_pure");
  emu.started = true;
  emu.gameManager = {
    setVariable: () => assert.fail("The explicit mouse mode must not change"),
  };
  for (const mode of ["false", "virtual", "direct", "pad"]) {
    emu.getSettingValue = () => mode;
    emu.updateDosBoxMouseInput({ pointerType: "touch" });
    emu.updateDosBoxMouseInput({ pointerType: "mouse" });
  }
  emu.getSettingValue = () => "true";
  emu.paused = true;
  emu.updateDosBoxMouseInput({ pointerType: "touch" });
  emu.paused = false;
  emu.started = false;
  emu.updateDosBoxMouseInput({ pointerType: "touch" });
});

test("netplay is limited to supported systems and cores, including shared Sega cores", () => {
  for (const core of [
    "azahar",
    "3ds",
    "melonds",
    "desmume",
    "nds",
    "ppsspp",
    "psp",
    "beetle_vb",
    "handy",
    "mednafen_ngp",
    "mednafen_wswan",
    "unknown",
    "dosbox_pure",
  ]) {
    assert.equal(runtime(core).supportsNetplay(), false, core);
  }
  for (const core of [
    "snes9x",
    "fceumm",
    "pcsx_rearmed",
    "mupen64plus_next",
    "fbneo",
    "sameboy",
    "gambatte",
    "mgba",
    "mgba_splitscreen",
  ]) {
    assert.equal(runtime(core).supportsNetplay(), true, core);
  }
  assert.equal(runtime("genesis_plus_gx", "segaGG").supportsNetplay(), false);
  assert.equal(runtime("genesis_plus_gx", "segaMD").supportsNetplay(), true);
  assert.equal(runtime("azahar", "snes").supportsNetplay(), false);
});

test("Azahar linear volume reaches RetroArch in decibels, including exact mute", () => {
  const emu = runtime("azahar");
  const gains = [];
  emu.Module = { _cmd_set_volume: (gain) => gains.push(gain) };
  for (const volume of [1, 0.5, 0, 0.25, 1]) emu.setAudioVolume(volume);
  assert.deepEqual(gains, [
    0,
    20 * Math.log10(0.5),
    -Infinity,
    20 * Math.log10(0.25),
    0,
  ]);
});

test("OpenAL keeps linear gain without applying RetroArch gain twice", () => {
  const emu = runtime("snes9x");
  const source = { gain: { gain: { value: 1 } } };
  emu.Module = {
    AL: { currentCtx: { sources: [source] } },
    _cmd_set_volume: () => assert.fail("double gain"),
  };
  emu.setAudioVolume(0.25);
  assert.equal(source.gain.gain.value, 0.25);
  emu.setAudioVolume(0);
  assert.equal(source.gain.gain.value, 0);
});

test("remote netplay volume retains its route and local owners fall back to core audio", () => {
  const emu = runtime("azahar");
  const local = [],
    remote = [];
  emu.Module = { _cmd_set_volume: (gain) => local.push(gain) };
  emu.isNetplay = true;
  emu.netplay = {
    setVolume: (volume) => {
      remote.push(volume);
      return true;
    },
  };
  emu.setAudioVolume(0.25);
  assert.deepEqual(remote, [0.25]);
  assert.deepEqual(local, []);
  emu.netplay.setVolume = () => false;
  emu.setAudioVolume(1);
  assert.deepEqual(local, [0]);
  delete emu.Module;
  assert.doesNotThrow(() => emu.setAudioVolume(0));
});
