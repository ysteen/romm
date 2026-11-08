const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

function manager(core, rate) {
  let opened = 0,
    closed = 0;
  const source = readFileSync(
    require.resolve("../data/src/GameManager.js"),
    "utf8",
  ).replace(/^export .*$/gm, "");
  const Manager = runInNewContext(source + "\nEJS_GameManager", {
    console: { log() {} },
    AudioContext: class {
      constructor() {
        opened++;
        this.sampleRate = rate;
      }
      close() {
        closed++;
        return Promise.resolve();
      }
    },
  });
  const value = Object.assign(Object.create(Manager.prototype), {
    EJS: {
      getCore: () => core,
      preGetSetting: () => 44100,
      retroarchOpts: [],
    },
  });
  return { value, counts: () => ({ opened, closed }) };
}

for (const rate of [44100, 48000]) {
  test(`SameBoy initializes its target rate from the ${rate} Hz device`, () => {
    const h = manager("sameboy", rate);
    for (let i = 0; i < 2; i++) {
      const config = h.value.getRetroArchCfg();
      const rates = [...config.matchAll(/^audio_out_rate = (\d+)$/gm)];
      assert.equal(Number(rates.at(-1)[1]), rate);
    }
    assert.deepEqual(h.counts(), { opened: 1, closed: 1 });
  });
}

test("other cores keep their configured output rate without probing a device", () => {
  for (const core of ["gambatte", "mgba", "snes9x", "melondsds"]) {
    const h = manager(core, 48000);
    h.value.EJS.retroarchOpts = [
      { name: "audio_out_rate", default: 44100, isString: false },
    ];
    assert.match(h.value.getRetroArchCfg(), /audio_out_rate = 44100/);
    assert.deepEqual(h.counts(), { opened: 0, closed: 0 });
  }
});

test("a pinned multiplayer core keeps its shared rate across audio devices", () => {
  const h = manager("sameboy", 44100);
  h.value.EJS.preGetSetting = () => 48000;
  h.value.EJS.retroarchOpts = [
    { name: "audio_out_rate", default: 48000, isString: false },
  ];
  assert.match(h.value.getRetroArchCfg(), /audio_out_rate = 48000/);
  assert.deepEqual(h.counts(), { opened: 0, closed: 0 });
});
