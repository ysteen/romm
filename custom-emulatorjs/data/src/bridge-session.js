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
    {
      player,
      players,
      send,
      inputDelay = 2,
      maxPrediction = 0,
      seats,
      startFrame = 0,
      inputs = [],
    },
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
      maxPrediction > 30 ||
      !frameNumber(startFrame) ||
      !Array.isArray(inputs) ||
      inputs.length > players * 600
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
    this.frame = startFrame;
    this.seats = playerSeats(seats, players);
    this.confirmed = startFrame;
    this.nextInput = startFrame;
    this.inputs = Array.from({ length: players }, () => new Map());
    this.nextReceived = Array(players).fill(startFrame);
    this.used = new Map();
    this.snapshots = new Map([[startFrame, this.saveState()]]);
    this.lastCheckpoint = Math.floor(startFrame / 60) * 60;
    this.stats = {
      frames: 0,
      stalls: 0,
      checks: 0,
      rollbacks: 0,
      replayedFrames: 0,
    };
    this.stopped = false;
    this.paused = false;
    this.initializing = true;
    for (const packet of inputs) {
      if (packet.player !== this.player) this.receive(packet);
      else {
        if (
          packet.f !== this.nextInput ||
          packet.f >= startFrame + 600 ||
          !Number.isInteger(packet.b) ||
          packet.b < 0 ||
          packet.b > 65535
        )
          throw new Error("Invalid resumed local input");
        this.inputs[this.player].set(this.nextInput++, packet.b);
      }
    }
    this.initializing = false;
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
    if (this.hasStarted) throw new Error("Relay session already started");
    this.hasStarted = true;
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
    if (this.initializing) return;
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

  tick(buttons, present = true) {
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
    this.advance(present);
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
      autoResume = false,
      manualJoin = false,
      onStatus = () => {},
      onError = () => {},
      onLobby = () => {},
      onSeats = () => {},
      onActionError = () => {},
      onLatency = () => {},
      onRestart = () => {},
      onHandoff = () => {},
      onContent = null,
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
      autoResume,
      manualJoin,
      onStatus,
      onError,
      onLobby,
      onSeats,
      onActionError,
      onLatency,
      onRestart,
      onHandoff,
      onContent,
    });
    this.session = null;
    this.transfer = null;
    this.stateRequests = new Set();
    this.contentEpoch = 0;
    this.gameClosed = false;
    this.closed = false;
    this.started = false;
    this.host = 0;
    this.generation = 0;
    this.initialState = this.adapter?.save().slice() ?? null;
    this.initialMemories = (this.adapter?.profile?.memoryIds ?? []).map((id) =>
      this.adapter.memory(id).slice(),
    );
    this.seats = playerSeats(undefined, players);
    this.manualStart = false;
    this.preparing = false;
    this.joinRequested = !manualJoin;
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
    this.socket.send(
      JSON.stringify(
        this.manualStart ? { ...packet, generation: this.generation } : packet,
      ),
    );
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
      let bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const transfer = this.transfer;
      this.transfer = null;
      if (!transfer || bytes.length !== transfer.size)
        throw new Error("Invalid relay binary transfer");
      if (transfer.discard || this.gameClosed) return;
      if (transfer.t === "resume") {
        this.hostFrame = null;
        this.adapter.load(bytes);
        this.seats = playerSeats(transfer.seats, this.players);
        this.onSeats(this.seats[this.player]);
        this.session = new BridgeSession(this.adapter, {
          player: this.player,
          players: this.players,
          seats: this.seats,
          maxPrediction: this.maxPrediction,
          startFrame: transfer.f,
          inputs: transfer.inputs,
          send: (packet) => this.send(packet),
        });
        this.started = true;
        this.preparing = false;
        this.session.start();
        this.onStatus("connected");
      } else if (transfer.t === "restart-source") {
        this.restartSource = bytes.slice();
      } else if (transfer.t === "native-calibration") {
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
        const seat = this.seats[transfer.player];
        if (!bytes.length && !this.adapter.profile.sharedSave)
          bytes = this.initialMemories[seat] ?? bytes;
        if (bytes.length)
          importBattery(this.adapter, this.adapter.profile, seat, bytes);
        this.sendState(0, this.adapter.save(), transfer.player);
      } else {
        this.adapter.load(bytes);
        this.relayState = false;
        this.send({ t: "ready", revision: transfer.revision });
      }
      return;
    }
    if (typeof data !== "string" || data.length > 512 * 1024 || this.transfer)
      throw new Error("Invalid relay message");
    const packet = JSON.parse(data);
    if (
      this.gameClosed &&
      ![
        "lobby",
        "latency",
        "ping",
        "handoff",
        "returned",
        "game-reset",
        "disconnect",
        "action-error",
        "peer-left",
        "peer-error",
      ].includes(packet.t)
    ) {
      if (Number.isInteger(packet.size))
        this.transfer = { ...packet, discard: true };
      return;
    }
    if (packet.t === "input" && (packet.generation ?? 0) < this.generation)
      return;
    switch (packet.t) {
      case "game-reset":
        if (!frameNumber(packet.generation))
          throw new Error("Invalid room generation");
        this.closeGame(false);
        this.generation = packet.generation;
        this.roomRunning = false;
        if (this.nativeAuthority)
          this.send({ t: "seed-battery", battery: base64(this.battery) });
        this.onStatus("game-reset");
        break;
      case "handoff":
        if (packet.retainRoom) {
          this.nativeMode = true;
          this.closeGame(false);
        } else this.stop();
        this.onHandoff(!!packet.retainRoom);
        break;
      case "returned":
        if (!this.nativeMode || !frameNumber(packet.generation))
          throw new Error("Unexpected return to the room");
        this.nativeMode = false;
        this.generation = packet.generation;
        this.onStatus("game-closed");
        break;
      case "ping":
        this.send({ t: "pong", nonce: packet.nonce });
        break;
      case "latency":
        this.onLatency(packet.members);
        break;
      case "clock":
        if (
          this.started &&
          this.host !== this.player &&
          packet.generation === this.generation &&
          packet.host === this.host &&
          frameNumber(packet.f)
        )
          this.hostFrame = packet.f;
        break;
      case "joined":
        if (packet.player !== this.player || packet.players !== this.players)
          throw new Error("Relay assigned an unexpected player slot");
        this.manualStart = packet.manualStart === true;
        this.nativeAuthority = packet.nativeAuthority === true;
        this.host = packet.host ?? 0;
        this.generation = packet.generation ?? 0;
        this.roomRunning = !!packet.running;
        if (packet.nativeAuthority)
          this.send({ t: "seed-battery", battery: base64(this.battery) });
        if (this.adapter && this.player === this.host && !packet.running) {
          if (this.battery.length)
            importBattery(this.adapter, this.adapter.profile, 0, this.battery);
          this.sendState(0);
        } else if (!this.manualStart)
          this.send({ t: "battery", size: this.battery.length }, this.battery);
        this.onStatus("waiting");
        if (this.autoResume && this.adapter) this.openGame();
        break;
      case "content": {
        if (this.manualJoin && !this.joinRequested) break;
        if (
          this.adapter ||
          this.loadingContent ||
          typeof this.onContent !== "function"
        )
          throw new Error("Unexpected cartridge preparation");
        this.loadingContent = true;
        const epoch = ++this.contentEpoch;
        this.onStatus("Preparing the room's cartridges…");
        Promise.resolve(this.onContent(packet))
          .then((adapter) => {
            if (this.closed || epoch !== this.contentEpoch) return;
            this.adapter = adapter;
            this.initialState = adapter.save().slice();
            this.initialMemories = adapter.profile.memoryIds.map((id) =>
              adapter.memory(id).slice(),
            );
            this.loadingContent = false;
            this.send({
              t: "content-ready",
              size: adapter.size,
              contentCrc: packet.contentCrc,
              resume:
                this.autoResume || (this.manualJoin && this.joinRequested),
            });
            if (this.player === this.host && !this.roomRunning)
              this.sendState(0);
          })
          .catch((error) => {
            if (!this.closed && epoch === this.contentEpoch) this.fail(error);
          });
        break;
      }
      case "lobby": {
        if (!this.manualStart) break;
        if (this.gameClosed && frameNumber(packet.generation))
          this.generation = packet.generation;
        const previousHost = this.host;
        this.host = packet.host ?? null;
        if (previousHost !== this.host) this.hostFrame = null;
        this.roomRunning = !!packet.running;
        this.seats = playerSeats(packet.seats, this.players, true);
        if (!this.started && this.seats[this.player] !== null)
          this.onSeats(this.seats[this.player]);
        this.onLobby(packet);
        if (
          previousHost !== this.host &&
          this.adapter &&
          this.host === this.player &&
          !packet.running &&
          !packet.starting
        ) {
          if (this.battery.length)
            importBattery(this.adapter, this.adapter.profile, 0, this.battery);
          this.sendState(0);
        }
        break;
      }
      case "restart-source":
        if (this.player !== this.host || packet.size !== this.adapter.size)
          throw new Error("Invalid restart source");
        this.transfer = packet;
        break;
      case "prepare": {
        if (
          !this.manualStart ||
          !frameNumber(packet.generation) ||
          packet.generation <= this.generation
        )
          throw new Error("Unexpected lobby start");
        const memories = this.adapter.profile.memoryIds.map((id) =>
          this.session ? this.session.confirmedMemory(id) : null,
        );
        if (this.session) {
          const seat = this.adapter.profile.sharedSave
            ? 0
            : this.session.seats[this.player];
          this.battery = memories[seat]?.slice() ?? this.battery;
          this.session.stopped = true;
        }
        this.session = null;
        this.hostFrame = null;
        this.stateRequests.clear();
        this.started = false;
        this.host = packet.host ?? 0;
        this.generation = packet.generation;
        this.preparing = true;
        this.onRestart();
        this.onStatus("preparing");
        this.seats = playerSeats(packet.seats, this.players);
        this.onSeats(this.seats[this.player]);
        this.relayState = packet.nativeState === true;
        if (this.relayState) break;
        if (this.player === this.host) {
          if (this.restartSource) {
            this.adapter.load(this.restartSource);
            this.adapter.profile.memoryIds.forEach((id, index) => {
              memories[index] = this.adapter.memory(id).slice();
            });
            this.restartSource = null;
            if (this.adapter.profile.sharedSave)
              this.battery = memories[0].slice();
          }
          this.adapter.load(this.initialState);
          memories.forEach((bytes, seat) => {
            if (bytes?.length)
              importBattery(this.adapter, this.adapter.profile, seat, bytes);
          });
          if (this.battery.length)
            importBattery(
              this.adapter,
              this.adapter.profile,
              this.adapter.profile.sharedSave ? 0 : this.seats[this.player],
              this.battery,
            );
          this.sendState(0);
        } else {
          const battery = this.adapter.profile.sharedSave
            ? new Uint8Array()
            : this.battery;
          this.send({ t: "battery", size: battery.length }, battery);
        }
        break;
      }
      case "action-error":
        this.onActionError(String(packet.message ?? "Lobby action failed"));
        break;
      case "state-ready":
        if (this.player !== this.host || !frameNumber(packet.revision))
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
            ((this.player === this.host && !this.relayState) ||
              packet.size !== this.adapter.size ||
              packet.f !== 0 ||
              !frameNumber(packet.revision))) ||
          (packet.t === "battery" &&
            (this.player !== this.host ||
              packet.size > 131072 ||
              !Number.isInteger(packet.player) ||
              packet.player < 0 ||
              packet.player >= this.players))
        )
          throw new Error("Incompatible relay state transfer");
        this.transfer = packet;
        break;
      case "native-calibration":
        if (
          this.started ||
          this.calibrating ||
          this.player !== this.host ||
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
        this.preparing = false;
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
      case "resume-source": {
        if (
          !this.session ||
          !this.started ||
          typeof packet.id !== "string" ||
          packet.id.length > 64
        )
          throw new Error("Invalid resume state request");
        const f = this.session.confirmed;
        const bytes = this.session.stateAt(f);
        this.send(
          { t: "resume-state", id: packet.id, f, size: bytes.length },
          bytes,
        );
        break;
      }
      case "resume":
        if (
          this.started ||
          !this.adapter ||
          !frameNumber(packet.f) ||
          packet.size !== this.adapter.size ||
          !Array.isArray(packet.inputs)
        )
          throw new Error("Invalid resumed game state");
        this.transfer = packet;
        break;
      case "state-request":
        if (
          this.player !== this.host ||
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
        if (typeof packet.paused !== "boolean")
          throw new Error("Invalid relay pause command");
        if (!this.session && this.manualStart && this.preparing) break;
        if (!this.session) throw new Error("Invalid relay pause command");
        this.session.paused = packet.paused;
        this.onStatus(packet.paused ? "paused" : "connected");
        break;
      case "error":
        throw new Error(
          String(packet.message ?? "Relay synchronization failed"),
        );
      case "peer-error":
      case "peer-left":
        if (!this.started)
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
      if (this.session && this.hostFrame > this.session.frame + 3)
        this.session.tick(buttons, false);
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

  closeGame(notify = true) {
    if (this.closed || this.gameClosed) return;
    if (this.session) {
      const seat = this.adapter.profile.sharedSave
        ? 0
        : this.seats[this.player];
      const id = this.adapter.profile.memoryIds[seat];
      try {
        this.battery = this.session.confirmedMemory(id).slice();
      } catch {
        /* A closing player may already have released its core. */
      }
      this.session.stopped = true;
    }
    this.gameClosed = true;
    this.joinRequested = false;
    this.contentEpoch++;
    this.loadingContent = this.started = this.preparing = false;
    this.session = this.adapter = this.initialState = null;
    this.hostFrame = null;
    this.initialMemories = [];
    this.stateRequests.clear();
    if (this.transfer) this.transfer.discard = true;
    if (notify) this.send({ t: "game-close" });
    this.onStatus("game-closed");
  }

  openGame() {
    if (this.closed || this.started) return;
    this.joinRequested = true;
    this.gameClosed = false;
    this.send({ t: "game-open" });
  }

  removePlayer(player) {
    this.send({ t: "kick", player });
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
