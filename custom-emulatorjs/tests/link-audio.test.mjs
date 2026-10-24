import test from "node:test";
import assert from "node:assert/strict";
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
  }
  return { AudioNode, AudioContext, webkitAudioContext: AudioContext };
}

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
