import { importBattery } from "./link-core.js?v=20261021.10";

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes)
    value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function frameNumber(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
}

function playerSeats(seats, players, allowUnassigned = false) {
  const result =
    seats ?? Array.from({ length: players }, (_, player) => player);
  const assigned = Array.isArray(result)
    ? result.filter((seat) => seat !== null)
    : [];
  if (
    !Array.isArray(result) ||
    result.length !== players ||
    new Set(assigned).size !== assigned.length ||
    result.some(
      (seat) =>
        !(allowUnassigned && seat === null) &&
        (!Number.isInteger(seat) || seat < 0 || seat >= players),
    )
  )
    throw new Error("Invalid player assignments");
  return result.slice();
}

function base64(bytes) {
  let text = "";
  for (let at = 0; at < bytes.length; at += 8192)
    text += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(text);
}

export class BridgeSession {
  constructor(
    adapter,
    { player, players, send, inputDelay = 2, maxPrediction = 0, seats },
  ) {
    if (
      !Number.isInteger(players) ||
      players < 2 ||
      players > 4 ||
      !Number.isInteger(player) ||
      player < 0 ||
      player >= players ||
      !Number.isInteger(inputDelay) ||
      inputDelay < 1 ||
      inputDelay > 8 ||
      !Number.isInteger(maxPrediction) ||
      maxPrediction < 0 ||
      maxPrediction > 30
    )
      throw new Error("Invalid relay session settings");
    Object.assign(this, {
      adapter,
      player,
      players,
      send,
      inputDelay,
      maxPrediction,
    });
    this.frame = 0;
    this.seats = playerSeats(seats, players);
    this.confirmed = 0;
    this.nextInput = 0;
    this.inputs = Array.from({ length: players }, () => new Map());
    this.nextReceived = Array(players).fill(0);
    this.used = new Map();
    this.snapshots = new Map([[0, this.saveState()]]);
    this.lastCheckpoint = 0;
    this.stats = {
      frames: 0,
      stalls: 0,
      checks: 0,
      rollbacks: 0,
      replayedFrames: 0,
    };
    this.stopped = false;
    this.paused = false;
  }

  saveState() {
    const state = this.adapter.save();
    if (
      !ArrayBuffer.isView(state) ||
      state.BYTES_PER_ELEMENT !== 1 ||
      !state.byteLength ||
      state.byteLength * (this.maxPrediction + 8) > 64 * 1024 * 1024 ||
      (this.stateSize !== undefined && state.byteLength !== this.stateSize)
    )
      throw new Error("Invalid or oversized relay snapshot");
    this.stateSize = state.byteLength;
    return new Uint8Array(
      state.buffer,
      state.byteOffset,
      state.byteLength,
    ).slice();
  }

  submit(buttons) {
    const f = this.nextInput++;
    if (!frameNumber(f)) throw new Error("Relay frame counter exhausted");
    this.inputs[this.player].set(f, buttons);
    this.send({ t: "input", f, b: buttons });
  }

  start() {
    if (this.nextInput !== 0) throw new Error("Relay session already started");
    for (let f = 0; f < this.inputDelay; f++) this.submit(0);
  }

  receive({ player, f, b }) {
    if (this.stopped) return;
    if (
      !Number.isInteger(player) ||
      player < 0 ||
      player >= this.players ||
      player === this.player ||
      !frameNumber(f) ||
      f !== this.nextReceived[player] ||
      f > this.frame + 600 ||
      !Number.isInteger(b) ||
      b < 0 ||
      b > 65535
    )
      throw new Error("Invalid relay input sequence");
    this.inputs[player].set(f, b);
    this.nextReceived[player]++;
    if (f < this.frame && this.used.get(f)?.[player] !== b) this.rollback(f);
    this.publishProgress();
    this.prune();
  }

  advance(present) {
    const previous =
      this.used.get(this.frame - 1) ?? Array(this.players).fill(0);
    const values = this.inputs.map(
      (inputs, player) => inputs.get(this.frame) ?? previous[player],
    );
    this.used.set(this.frame, values);
    const controls = Array(this.players);
    for (let player = 0; player < this.players; player++)
      controls[this.seats[player]] = values[player];
    if (this.players === 2 && this.adapter.step)
      this.adapter.step(controls[0], controls[1], present);
    else this.adapter.stepPlayers(controls, present);
    this.frame++;
    this.snapshots.set(this.frame, this.saveState());
  }

  rollback(frame) {
    const state = this.snapshots.get(frame);
    if (!this.maxPrediction || !state || frame < this.confirmed)
      throw new Error("Input arrived outside the relay rollback window");
    const end = this.frame;
    this.adapter.load(state);
    this.frame = frame;
    this.stats.rollbacks++;
    while (this.frame < end) {
      this.advance(false);
      this.stats.replayedFrames++;
    }
  }

  publishProgress(advanced = false) {
    const confirmed = Math.min(
      this.frame,
      this.nextInput,
      ...this.nextReceived.filter((_, player) => player !== this.player),
    );
    if (!advanced && confirmed === this.confirmed) return;
    this.confirmed = confirmed;
    this.send({ t: "progress", f: this.frame, confirmed });
    while (this.lastCheckpoint + 60 <= confirmed) {
      const f = this.lastCheckpoint + 60;
      this.send({ t: "crc", f, crc: crc32(this.stateAt(f)) });
      this.lastCheckpoint = f;
      this.stats.checks++;
    }
  }

  prune() {
    const oldest = Math.max(0, this.confirmed - 7);
    for (const f of this.snapshots.keys())
      if (f < oldest) this.snapshots.delete(f);
    for (const map of [...this.inputs, this.used])
      for (const f of map.keys()) if (f < oldest - 1) map.delete(f);
  }

  tick(buttons) {
    if (this.stopped || this.paused) return false;
    if (!Number.isInteger(buttons) || buttons < 0 || buttons > 65535)
      throw new Error("Invalid controller input");
    if (this.nextInput <= this.frame + this.inputDelay) this.submit(buttons);
    const missing = this.inputs.some((inputs) => !inputs.has(this.frame));
    if (
      !this.inputs[this.player].has(this.frame) ||
      (missing && this.frame - this.confirmed >= this.maxPrediction)
    ) {
      this.stats.stalls++;
      return false;
    }
    this.advance(true);
    this.stats.frames++;
    this.publishProgress(true);
    this.prune();
    return true;
  }

  stateAt(frame) {
    if (frame > this.confirmed)
      throw new Error("Requested relay state is not confirmed");
    const bytes = this.snapshots.get(frame);
    if (!bytes) throw new Error("Requested relay state is no longer available");
    return bytes;
  }

  confirmedMemory(id) {
    if (this.frame === this.confirmed) return this.adapter.memory(id).slice();
    const current = this.saveState();
    try {
      this.adapter.load(this.stateAt(this.confirmed));
      return this.adapter.memory(id).slice();
    } finally {
      this.adapter.load(current);
    }
  }
}

export class BridgeConnection {
  constructor(
    adapter,
    socket,
    {
      player,
      players,
      battery = new Uint8Array(),
      calibrate = null,
      maxPrediction = 0,
      onStatus = () => {},
      onError = () => {},
      onLobby = () => {},
      onSeats = () => {},
      onActionError = () => {},
    },
  ) {
    Object.assign(this, {
      adapter,
      socket,
      player,
      players,
      battery,
      calibrate,
      maxPrediction,
      onStatus,
      onError,
      onLobby,
      onSeats,
      onActionError,
    });
    this.session = null;
    this.transfer = null;
    this.stateRequests = new Set();
    this.closed = false;
    this.started = false;
    this.seats = playerSeats(undefined, players);
    this.manualStart = false;
    this.preparing = false;
    this.calibration = null;
    this.calibrating = false;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      try {
        this.receive(event.data);
      } catch (error) {
        this.fail(error);
      }
    });
    socket.addEventListener("close", () => this.stop());
    socket.addEventListener("error", () =>
      this.fail(new Error("Relay connection failed")),
    );
  }

  send(packet, bytes) {
    if (
      this.closed ||
      this.socket.readyState !== 1 ||
      this.socket.bufferedAmount > 32 * 1024 * 1024
    )
      throw new Error("Relay connection is unavailable or congested");
    this.socket.send(JSON.stringify(packet));
    if (bytes !== undefined) this.socket.send(bytes);
  }

  sendState(frame, bytes = this.adapter.save(), batteryPlayer) {
    const packet = { t: "state", f: frame, size: bytes.length };
    if (!this.started) packet.sram = base64(this.adapter.memory(0));
    if (batteryPlayer !== undefined) packet.batteryPlayer = batteryPlayer;
    this.send(packet, bytes);
  }

  receive(data) {
    if (this.closed) return;
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const transfer = this.transfer;
      this.transfer = null;
      if (!transfer || bytes.length !== transfer.size)
        throw new Error("Invalid relay binary transfer");
      if (transfer.t === "native-calibration") {
        if (transfer.stage === 0) {
          this.calibration = {
            original: this.adapter.save(),
            first: bytes.slice(),
          };
        } else {
          this.calibrating = true;
          this.onStatus("Matching the PC's initial state…");
          const { original, first } = this.calibration;
          Promise.resolve()
            .then(() => this.calibrate(this.adapter, first, bytes))
            .then(() => {
              if (this.closed) return;
              this.adapter.load(original);
              this.calibration = null;
              this.calibrating = false;
              this.send({ t: "native-ready" });
              this.onStatus("waiting");
            })
            .catch((error) => this.fail(error));
        }
      } else if (transfer.t === "battery") {
        if (bytes.length)
          importBattery(
            this.adapter,
            this.adapter.profile,
            this.seats[transfer.player],
            bytes,
          );
        this.sendState(0, this.adapter.save(), transfer.player);
      } else {
        this.adapter.load(bytes);
        this.send({ t: "ready", revision: transfer.revision });
      }
      return;
    }
    if (typeof data !== "string" || data.length > 512 * 1024 || this.transfer)
      throw new Error("Invalid relay message");
    const packet = JSON.parse(data);
    switch (packet.t) {
      case "joined":
        if (packet.player !== this.player || packet.players !== this.players)
          throw new Error("Relay assigned an unexpected player slot");
        this.manualStart = packet.manualStart === true;
        if (this.manualStart && this.player === 0)
          this.initialState = this.adapter.save().slice();
        if (this.player === 0) {
          if (this.battery.length)
            importBattery(this.adapter, this.adapter.profile, 0, this.battery);
          this.sendState(0);
        } else if (!this.manualStart)
          this.send({ t: "battery", size: this.battery.length }, this.battery);
        this.onStatus("waiting");
        break;
      case "lobby":
        if (!this.manualStart || this.started) break;
        this.seats = playerSeats(packet.seats, this.players, true);
        if (this.seats[this.player] !== null)
          this.onSeats(this.seats[this.player]);
        this.onLobby(packet);
        break;
      case "prepare":
        if (!this.manualStart || this.started || this.preparing)
          throw new Error("Unexpected lobby start");
        this.preparing = true;
        this.seats = playerSeats(packet.seats, this.players);
        this.onSeats(this.seats[this.player]);
        if (this.player === 0) {
          this.adapter.load(this.initialState);
          if (this.battery.length)
            importBattery(
              this.adapter,
              this.adapter.profile,
              this.adapter.profile.sharedSave ? 0 : this.seats[0],
              this.battery,
            );
          this.sendState(0);
        } else
          this.send({ t: "battery", size: this.battery.length }, this.battery);
        break;
      case "action-error":
        this.onActionError(String(packet.message ?? "Lobby action failed"));
        break;
      case "state-ready":
        if (this.player !== 0 || !frameNumber(packet.revision))
          throw new Error("Unexpected relay state acknowledgement");
        if (!this.started) this.send({ t: "ready", revision: packet.revision });
        break;
      case "state":
      case "battery":
        if (
          this.started ||
          !Number.isInteger(packet.size) ||
          packet.size < 0 ||
          packet.size > 16 * 1024 * 1024 ||
          (packet.t === "state" &&
            (this.player === 0 ||
              packet.size !== this.adapter.size ||
              packet.f !== 0 ||
              !frameNumber(packet.revision))) ||
          (packet.t === "battery" &&
            (this.player !== 0 ||
              packet.size > 131072 ||
              !Number.isInteger(packet.player) ||
              packet.player < 1 ||
              packet.player >= this.players))
        )
          throw new Error("Incompatible relay state transfer");
        this.transfer = packet;
        break;
      case "native-calibration":
        if (
          this.started ||
          this.calibrating ||
          this.player !== 0 ||
          this.players !== 2 ||
          typeof this.calibrate !== "function" ||
          packet.player !== 1 ||
          packet.size !== this.adapter.size ||
          packet.stage !== (this.calibration ? 1 : 0)
        )
          throw new Error("Unexpected PC startup calibration");
        this.transfer = packet;
        break;
      case "start":
        if (
          this.started ||
          this.calibration ||
          this.calibrating ||
          packet.f !== 0 ||
          packet.player !== this.player ||
          packet.players !== this.players ||
          (packet.maxPrediction ?? 0) !== this.maxPrediction
        )
          throw new Error("Invalid relay session start");
        this.started = true;
        this.session = new BridgeSession(this.adapter, {
          player: this.player,
          players: this.players,
          maxPrediction: this.maxPrediction,
          seats: this.seats,
          send: (packet) => this.send(packet),
        });
        this.session.start();
        this.onStatus("connected");
        break;
      case "input":
        if (!this.session)
          throw new Error("Relay input arrived before session start");
        this.session.receive(packet);
        this.flushStateRequests();
        break;
      case "state-request":
        if (
          this.player !== 0 ||
          !this.session ||
          !frameNumber(packet.f) ||
          packet.f > this.session.frame + 600 ||
          this.stateRequests.size >= 8
        )
          throw new Error("Unexpected relay state request");
        if (packet.f <= this.session.confirmed)
          this.sendState(packet.f, this.session.stateAt(packet.f));
        else this.stateRequests.add(packet.f);
        break;
      case "pause":
        if (!this.session || typeof packet.paused !== "boolean")
          throw new Error("Invalid relay pause command");
        this.session.paused = packet.paused;
        this.onStatus(packet.paused ? "paused" : "connected");
        break;
      case "error":
        throw new Error(
          String(packet.message ?? "Relay synchronization failed"),
        );
      case "peer-error":
      case "peer-left":
        if (this.started)
          throw new Error(
            String(packet.message ?? "A relay participant disconnected"),
          );
        this.onStatus(packet.message ? String(packet.message) : "waiting");
        break;
      case "disconnect":
        if (packet.message) throw new Error(String(packet.message));
        this.stop();
        break;
      default:
        throw new Error("Unsupported relay message");
    }
  }

  flushStateRequests() {
    for (const frame of this.stateRequests) {
      if (frame > this.session.confirmed) continue;
      this.sendState(frame, this.session.stateAt(frame));
      this.stateRequests.delete(frame);
    }
  }

  tick(buttons) {
    try {
      const advanced = this.session?.tick(buttons) ?? false;
      this.flushStateRequests();
      return advanced;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  pause(paused) {
    if (this.session) this.send({ t: "pause", paused });
  }

  assignPlayer(player, seat) {
    this.send({ t: "assign", player, seat });
  }

  startGame() {
    this.send({ t: "start-request" });
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    if (this.session) this.session.stopped = true;
    this.socket.close();
    this.onStatus("stopped");
  }

  fail(error) {
    this.stop();
    this.onError(error);
  }
}
