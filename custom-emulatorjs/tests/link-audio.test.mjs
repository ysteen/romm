import assert from "node:assert/strict";
import test from "node:test";
import {
  bindPlayerVolume,
  installPlayerAudio,
} from "../input-netplay/audio.js";

function audioScope() {
  class AudioNode {
    constructor(context) {
      this.context = context;
      this.connections = [];
    }
    connect(destination) {
      this.connections.push(destination);
      return destination;
    }
    disconnect(destination) {
      this.connections = this.connections.filter(
        (node) => node !== destination,
      );
    }
  }
  class AudioContext extends EventTarget {
    state = "suspended";
    currentTime = 0;
    resumes = 0;
    destination = new AudioNode(this);
    createGain() {
      const node = new AudioNode(this);
      node.gain = {
        value: 1,
        cancelScheduledValues() {},
        linearRampToValueAtTime(value) {
          this.value = value;
        },
        setValueAtTime(value) {
          this.value = value;
        },
      };
      return node;
    }
    resume() {
      this.resumes++;
      this.state = "running";
      return Promise.resolve();
    }
    close() {
      this.state = "closed";
      this.dispatchEvent(new Event("statechange"));
      return Promise.resolve();
    }
  }
  class AudioBufferSourceNode extends AudioNode {
    loop = false;
    starts = [];
    addEventListener() {}
    start(when) {
      this.starts.push(when);
    }
    stop() {
      this.stopped = true;
    }
  }
  return {
    AudioNode,
    AudioContext,
    AudioBufferSourceNode,
    webkitAudioContext: AudioContext,
  };
}

test("relay audio absorbs short scheduling gaps without replaying or accumulating delay", () => {
  const scope = audioScope(),
    output = installPlayerAudio(scope);
  const context = new scope.AudioContext();
  output.enableBuffering();
  function buffer(now, level = 1) {
    context.currentTime = now;
    const source = new scope.AudioBufferSourceNode(context);
    const samples = new Float32Array(960).fill(level);
    source.buffer = {
      duration: 0.02,
      sampleRate: 48000,
      numberOfChannels: 1,
      getChannelData: () => samples,
    };
    source.start(now + 0.01);
    return { source, samples };
  }
  assert.equal(buffer(0).source.starts[0], 0.06);
  assert.equal(buffer(0.02).source.starts[0], 0.08);
  assert.equal(buffer(0.075).source.starts[0], 0.1);
  assert.equal(output.stats[0].underruns, 0);
  output.markDiscontinuity();
  const corrected = buffer(0.08, -1);
  assert(corrected.samples[0] > 0.9);
  assert.equal(corrected.samples[95], -1);
  const recovered = buffer(0.3);
  assert.equal(recovered.source.starts[0], 0.36);
  assert(recovered.samples[0] < 0.02);
  assert.equal(output.stats[0].underruns, 1);
  for (let i = 0; i < 30; i++) buffer(0.31);
  assert(output.stats[0].dropped > 0);
  assert(output.stats[0].ahead < 0.28);
  output.flush();
  assert.equal(recovered.source.stopped, true);
  assert.equal(output.stats[0].ahead, 0);
  output.destroy();
  assert.equal(output.outputs.length, 0);
});

test("ordinary player audio preserves the driver's scheduling", () => {
  const scope = audioScope();
  installPlayerAudio(scope);
  const source = new scope.AudioBufferSourceNode(new scope.AudioContext());
  source.buffer = { duration: 0.02 };
  source.start(0.125);
  assert.deepEqual(source.starts, [0.125]);
});

test("unlocks a suspended driver before it connects its first audio buffer", () => {
  const scope = audioScope();
  const NativeContext = scope.AudioContext;
  const output = installPlayerAudio(scope);
  output.setActive(false);
  output.setVolume(0.35);
  const context = new scope.AudioContext();
  assert.ok(context instanceof NativeContext);
  assert.equal(scope.AudioContext, scope.webkitAudioContext);
  assert.equal(context.resumes, 0);
  assert.deepEqual(output.outputs, [{ state: "suspended", gain: 0 }]);
  output.setActive(true);
  assert.equal(context.resumes, 1);
  assert.deepEqual(output.outputs, [{ state: "running", gain: 0.35 }]);
  const source = new scope.AudioNode(context);
  assert.equal(source.connect(context.destination), context.destination);
  assert.notEqual(source.connections[0], context.destination);
  assert.equal(source.connections[0].gain.value, 0.35);
  source.disconnect(context.destination);
  assert.equal(source.connections.length, 0);
  context.state = "closed";
  context.dispatchEvent(new Event("statechange"));
  assert.equal(output.outputs.length, 0);
});

test("slider input applies immediately and focus changes preserve volume and mute", () => {
  const scope = audioScope();
  const output = installPlayerAudio(scope);
  new scope.AudioContext();
  const slider = new EventTarget();
  slider.value = "0.4";
  const emulator = {
    volume: 0.4,
    muted: false,
    elements: { menu: { querySelector: () => slider } },
    setVolume(value) {
      this.muted = value === 0;
      slider.value = String(value);
    },
  };
  bindPlayerVolume(emulator, output);
  output.setActive(true);
  slider.value = "0.72";
  slider.dispatchEvent(new Event("input"));
  assert.equal(emulator.volume, 0.72);
  assert.equal(output.outputs[0].gain, 0.72);
  output.setActive(false);
  assert.equal(output.outputs[0].gain, 0);
  assert.equal(emulator.muted, false);
  assert.equal(slider.value, "0.72");
  output.setActive(true);
  assert.equal(output.outputs[0].gain, 0.72);
  emulator.setVolume(0);
  output.setActive(false);
  output.setActive(true);
  assert.equal(output.outputs[0].gain, 0);
  assert.equal(emulator.muted, true);
  assert.equal(emulator.volume, 0.72);
});
