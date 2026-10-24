// Route every Web Audio driver through one gain node in this player iframe.
export function installPlayerAudio(scope = window) {
  const gains = new Map();
  const connect = scope.AudioNode.prototype.connect;
  const disconnect = scope.AudioNode.prototype.disconnect;
  let volume = 0;
  let active = true;

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
      gain.gain.setValueAtTime(value, context.currentTime);
      if (value && context.state === "suspended")
        context.resume().catch(() => {});
    }
  }

  return {
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
