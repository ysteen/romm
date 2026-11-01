// Route every Web Audio driver through one gain node in this player iframe.
export function installPlayerAudio(scope = window) {
  const gains = new Map();
  const connect = scope.AudioNode.prototype.connect;
  const disconnect = scope.AudioNode.prototype.disconnect;
  let volume = 0;
  let active = true;
  let buffered = false;
  let discontinuity = false;
  const queues = new Map();
  const bufferStart = scope.AudioBufferSourceNode?.prototype.start;
  if (bufferStart)
    scope.AudioBufferSourceNode.prototype.start = function (when, ...args) {
      if (!buffered || !this.buffer || this.loop || args.length)
        return bufferStart.call(this, when, ...args);
      const context = this.context,
        now = context.currentTime;
      let queue = queues.get(context);
      if (!queue) {
        queue = {
          end: 0,
          buffers: 0,
          underruns: 0,
          dropped: 0,
          last: [],
          sources: new Set(),
        };
        queues.set(context, queue);
      }
      if (queue.end - now > 0.25) {
        queue.dropped++;
        this.disconnect();
        discontinuity = true;
        return;
      }
      const gap = queue.end < now + 0.002;
      if (gap && queue.buffers) queue.underruns++;
      const start = gap ? now + 0.06 : queue.end;
      const buffer = this.buffer;
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const samples = buffer.getChannelData(channel);
        if (gap || discontinuity) {
          const from = gap ? 0 : (queue.last[channel] ?? 0);
          const count = Math.min(
            samples.length,
            Math.round(buffer.sampleRate * 0.002),
          );
          for (let i = 0; i < count; i++) {
            const mix = (i + 1) / count;
            samples[i] = from * (1 - mix) + samples[i] * mix;
          }
        }
        queue.last[channel] = samples.at(-1) ?? 0;
      }
      discontinuity = false;
      queue.end = start + buffer.duration;
      queue.buffers++;
      queue.sources.add(this);
      this.addEventListener("ended", () => queue.sources.delete(this), {
        once: true,
      });
      return bufferStart.call(this, start);
    };

  function output(context) {
    if (!gains.has(context)) {
      const gain = context.createGain();
      gain.gain.value = active ? volume : 0;
      connect.call(gain, context.destination);
      gains.set(context, gain);
      context.addEventListener("statechange", () => {
        if (context.state === "closed") gains.delete(context);
      });
    }
    return gains.get(context);
  }

  // Drivers may wait for a running context before connecting their first buffer.
  const constructors = new Map();
  for (const name of ["AudioContext", "webkitAudioContext"]) {
    const Original = scope[name];
    if (!Original) continue;
    if (!constructors.has(Original)) {
      constructors.set(
        Original,
        new Proxy(Original, {
          construct(target, args, newTarget) {
            const context = Reflect.construct(target, args, newTarget);
            output(context);
            return context;
          },
        }),
      );
    }
    scope[name] = constructors.get(Original);
  }

  scope.AudioNode.prototype.connect = function (destination, ...args) {
    if (destination === this.context.destination) {
      connect.call(this, output(this.context), ...args);
      return destination;
    }
    return connect.call(this, destination, ...args);
  };
  scope.AudioNode.prototype.disconnect = function (...args) {
    if (args[0] === this.context.destination && gains.has(this.context))
      args[0] = gains.get(this.context);
    return disconnect.apply(this, args);
  };

  function apply() {
    const value = active ? volume : 0;
    for (const [context, gain] of gains) {
      const now = context.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(value, now + 0.008);
      if (value && context.state === "suspended")
        context.resume().catch(() => {});
    }
  }

  return {
    enableBuffering() {
      buffered = true;
    },
    markDiscontinuity() {
      discontinuity = true;
    },
    flush() {
      for (const [context, queue] of queues) {
        const now = context.currentTime,
          gain = gains.get(context)?.gain;
        if (gain) {
          gain.cancelScheduledValues(now);
          gain.setValueAtTime(gain.value, now);
          gain.linearRampToValueAtTime(0, now + 0.008);
          gain.linearRampToValueAtTime(active ? volume : 0, now + 0.06);
        }
        for (const source of queue.sources) {
          try {
            source.stop(now + 0.008);
          } catch {
            /* Already ended buffers need no stop. */
          }
        }
        queue.sources.clear();
        queue.end = 0;
        queue.last = [];
      }
      discontinuity = true;
    },
    destroy() {
      for (const context of gains.keys()) void context.close().catch(() => {});
      queues.clear();
    },
    get stats() {
      return Array.from(queues, ([context, queue]) => ({
        buffers: queue.buffers,
        underruns: queue.underruns,
        dropped: queue.dropped,
        ahead: Math.max(0, queue.end - context.currentTime),
        bufferTarget: 0.06,
      }));
    },
    setVolume(value) {
      volume = Math.min(1, Math.max(0, value));
      apply();
    },
    setActive(value) {
      active = !!value;
      apply();
    },
    get active() {
      return active;
    },
    get volume() {
      return volume;
    },
    get outputs() {
      return Array.from(gains, ([context, gain]) => ({
        state: context.state,
        gain: gain.gain.value,
      }));
    },
  };
}

export function bindPlayerVolume(emulator, output) {
  const setVolume = emulator.setVolume.bind(emulator);
  emulator.setVolume = (value) => {
    setVolume(value);
    output.setVolume(value);
  };
  const slider = emulator.elements.menu.querySelector('[data-range="volume"]');
  slider?.addEventListener("input", () => {
    emulator.volume = Number(slider.value);
    emulator.setVolume(emulator.volume);
  });
  emulator.setVolume(emulator.muted ? 0 : emulator.volume);
  output.setActive(false);
}
