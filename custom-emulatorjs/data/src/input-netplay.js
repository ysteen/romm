// Digital rollback. Link emulation belongs to the libretro core.
import { linkCore } from "./link-core.js?v=20261021.10";

export const PROTOCOL = 1;

export class PeerDisconnectedError extends Error {}

export function stateHash(bytes) {
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export async function sha256(bytes) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export class RollbackSession {
  constructor(
    adapter,
    {
      player,
      players = 2,
      send,
      inputDelay = 2,
      maxPrediction = 12,
      onError = () => {},
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
      inputDelay < 0 ||
      inputDelay > 8 ||
      !Number.isInteger(maxPrediction) ||
      maxPrediction < 1 ||
      maxPrediction > 30
    ) {
      throw new Error("Invalid synchronization settings");
    }
    Object.assign(this, {
      adapter,
      player,
      players,
      send,
      inputDelay,
      maxPrediction,
      onError,
    });
    this.frame = 0;
    this.through = Array(players).fill(inputDelay - 1);
    this.advantages = Array(players).fill(null);
    this.timingFrames = Array(players).fill(-1);
    this.inputs = Array.from({ length: players }, () => new Map());
    for (const inputs of this.inputs) {
      for (let f = 0; f < inputDelay; f++) inputs.set(f, 0);
    }
    this.snapshots = new Map([[0, adapter.save()]]);
    this.used = new Map();
    this.hashes = new Map();
    this.remoteHashes = Array.from({ length: players }, () => new Map());
    this.lastCheckpoint = 0;
    this.stats = {
      rollbacks: 0,
      replayedFrames: 0,
      stalls: 0,
      checks: 0,
      pacing: 0,
    };
    this.stopped = false;
  }

  get remoteThrough() {
    return Math.min(...this.through.filter((_, p) => p !== this.player));
  }

  get remoteAdvantage() {
    return this.advantages[1 - this.player];
  }

  fail(error) {
    if (this.stopped) return;
    this.stopped = true;
    this.onError(error instanceof Error ? error : new Error(error));
  }

  receive(packet, peer = 1 - this.player) {
    if (this.stopped) return;
    try {
      if (
        !Number.isInteger(peer) ||
        peer < 0 ||
        peer >= this.players ||
        peer === this.player
      )
        throw new Error("Invalid input peer");
      if (packet.t === "input") {
        const { f, b, a } = packet;
        const estimates = Array.isArray(a) ? a : [a];
        if (
          !Number.isSafeInteger(f) ||
          f < this.inputDelay ||
          // Both peers queue delayed input, including while stalled.
          f > this.frame + this.maxPrediction + 2 * this.inputDelay + 1 ||
          !Number.isInteger(b) ||
          b < 0 ||
          b > 65535 ||
          (a !== undefined &&
            ((this.players > 2 &&
              (!Array.isArray(a) || a.length !== this.players)) ||
              estimates.some(
                (value) =>
                  !Number.isSafeInteger(value) ||
                  Math.abs(value) >
                    2 * (this.maxPrediction + this.inputDelay + 1),
              )))
        ) {
          throw new Error("Invalid input frame");
        }
        const remote = this.inputs[peer];
        if (f < this.frame - this.maxPrediction - 2) return;
        if (remote.has(f) && remote.get(f) !== b)
          throw new Error("Conflicting input frame");
        remote.set(f, b);
        while (remote.has(this.through[peer] + 1)) this.through[peer]++;
        if (a !== undefined && f > this.timingFrames[peer]) {
          this.advantages[peer] = Array.isArray(a) ? a[this.player] : a;
          this.timingFrames[peer] = f;
        }
        if (f < this.frame && this.used.get(f)?.[peer] !== b) {
          this.rollback(f);
        }
        this.checkpoint();
      } else if (packet.t === "hash") {
        if (
          !Number.isSafeInteger(packet.f) ||
          packet.f < 60 ||
          packet.f % 60 ||
          packet.f > this.frame + this.maxPrediction + 60 ||
          typeof packet.h !== "string" ||
          !/^[0-9a-f]{8}$/.test(packet.h)
        ) {
          throw new Error("Invalid state checkpoint");
        }
        if (packet.f < this.lastCheckpoint - 120) return;
        this.remoteHashes[peer].set(packet.f, packet.h);
        this.compareHash(packet.f, peer);
      } else {
        throw new Error("Unexpected synchronization message");
      }
    } catch (error) {
      this.fail(error);
    }
  }

  advance(present) {
    const f = this.frame;
    const previous = this.used.get(f - 1) ?? Array(this.players).fill(0);
    const buttons = this.inputs.map(
      (inputs, p) => inputs.get(f) ?? previous[p],
    );
    this.used.set(f, buttons);
    if (this.players === 2) this.adapter.step(buttons[0], buttons[1], present);
    else this.adapter.stepPlayers(buttons, present);
    this.frame++;
    this.snapshots.set(this.frame, this.adapter.save());
  }

  rollback(frame) {
    const state = this.snapshots.get(frame);
    if (!state) throw new Error("Input arrived outside the rollback window");
    const end = this.frame;
    this.adapter.load(state);
    this.frame = frame;
    this.stats.rollbacks++;
    this.stats.replayedFrames += end - frame;
    while (this.frame < end) this.advance(false);
  }

  tick(buttons = 0) {
    if (this.stopped) return false;
    try {
      const target = this.frame + this.inputDelay;
      const advantages = this.through.map((through, p) =>
        p === this.player ? 0 : this.frame - through + this.inputDelay - 1,
      );
      const local = this.inputs[this.player];
      if (!local.has(target)) {
        local.set(target, buttons & 65535);
        this.send({
          t: "input",
          f: target,
          b: buttons & 65535,
          a: this.players === 2 ? advantages[1 - this.player] : advantages,
        });
      }
      if (this.frame > this.remoteThrough + this.maxPrediction) {
        this.stats.stalls++;
        return false;
      }
      // Compare both estimates so ordinary transit delay does not pause both peers.
      if (
        this.advantages.some(
          (remote, p) =>
            p !== this.player && remote !== null && advantages[p] - remote > 4,
        )
      ) {
        this.stats.pacing++;
        return false;
      }
      this.advance(true);
      this.checkpoint();
      const oldest = this.frame - this.maxPrediction - 2;
      for (const map of [...this.inputs, this.snapshots, this.used]) {
        for (const f of map.keys()) if (f < oldest) map.delete(f);
      }
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  checkpoint() {
    // Only compare states whose inputs are final on this peer.
    const confirmed = Math.min(this.frame, this.remoteThrough + 1);
    const next = this.lastCheckpoint + 60;
    if (confirmed >= next && this.snapshots.has(next)) {
      const hash = stateHash(this.snapshots.get(next));
      this.hashes.set(next, hash);
      this.lastCheckpoint = next;
      this.send({ t: "hash", f: next, h: hash });
      for (let p = 0; p < this.players; p++)
        if (p !== this.player) this.compareHash(next, p);
      for (const map of [this.hashes, ...this.remoteHashes]) {
        for (const f of map.keys()) if (f < next - 120) map.delete(f);
      }
    }
  }

  compareHash(frame, peer) {
    const local = this.hashes.get(frame);
    const remote = this.remoteHashes[peer].get(frame);
    if (!local || !remote) return;
    if (local !== remote) throw new Error(`State mismatch at frame ${frame}`);
    this.remoteHashes[peer].delete(frame);
    this.stats.checks++;
  }
}

export class LibretroAdapter {
  constructor(module, core = "sameboy", players = 2) {
    this.module = module;
    this.profile = linkCore(core, players);
    this.memoryIds = this.profile.memoryIds;
    this.begin();
    // SameBoy initializes its snapshot format on the first frame.
    this.step(0, 0, true);
    this.size = module._ejs_sync_state_size();
    if (!this.size || this.size > 16 * 1024 * 1024)
      throw new Error("Invalid core snapshot size");
    this.pointer = module._malloc(this.size);
    if (!this.pointer) throw new Error("Could not allocate snapshot memory");
  }

  begin() {
    if (
      typeof this.module._ejs_sync_begin !== "function" ||
      !this.module._ejs_sync_begin()
    )
      throw new Error("This core build does not support input synchronization");
  }

  end() {
    this.module._ejs_sync_end();
  }

  step(p1, p2, present = true) {
    if (!this.module._ejs_sync_step(p1, p2, Number(present)))
      throw new Error("Core frame failed");
  }

  stepPlayers(buttons, present = true) {
    if (
      !this.module._ejs_sync_step_multi?.(
        ...Array.from({ length: 4 }, (_, p) => buttons[p] ?? 0),
        Number(present),
      )
    )
      throw new Error("This core build does not support four-player input");
  }

  save() {
    if (!this.module._ejs_sync_save(this.pointer, this.size))
      throw new Error("Core snapshot failed");
    return this.module.HEAPU8.slice(this.pointer, this.pointer + this.size);
  }

  load(bytes) {
    if (bytes.length !== this.size)
      throw new Error("Incompatible snapshot size");
    this.module.HEAPU8.set(bytes, this.pointer);
    if (!this.module._ejs_sync_load(this.pointer, this.size))
      throw new Error("Core restore failed");
  }

  memory(id) {
    const pointer = this.module._ejs_sync_memory_data(id);
    const size = this.module._ejs_sync_memory_size(id);
    return pointer && size
      ? this.module.HEAPU8.slice(pointer, pointer + size)
      : new Uint8Array();
  }

  loadMemory(id, bytes) {
    const size = this.module._ejs_sync_memory_size(id);
    const pointer = this.module._ejs_sync_memory_data(id);
    if (!pointer || size !== bytes.length)
      throw new Error("Battery save does not match this cartridge");
    this.module.HEAPU8.set(bytes, pointer);
  }

  close() {
    this.module._free(this.pointer);
    this.end();
  }
}

export function waitForOpen(channel) {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new PeerDisconnectedError("Peer connection timed out")),
      180000,
    );
    const opened = () => finish();
    const closed = () =>
      finish(new PeerDisconnectedError("Peer connection closed"));
    function finish(error) {
      clearTimeout(timer);
      channel.removeEventListener("open", opened);
      channel.removeEventListener("close", closed);
      error ? reject(error) : resolve();
    }
    channel.addEventListener("open", opened);
    channel.addEventListener("close", closed);
  });
}

export async function connectSession(
  adapter,
  channel,
  manifest,
  player,
  onError = () => {},
) {
  channel.binaryType = "arraybuffer";
  const guestMemory = adapter.memoryIds?.[1] ?? 768;
  await waitForOpen(channel);
  return new Promise((resolve, reject) => {
    let remoteHello = false;
    let state = null;
    let offset = 0;
    let expectedHash;
    let stateSent = false;
    let session;
    let loaded = false;
    let batteryLoaded = manifest.batteries !== "per-player";
    let transferKind;
    let failed = false;
    const send = (packet) => {
      if (
        channel.readyState !== "open" ||
        channel.bufferedAmount > 2 * 1024 * 1024
      ) {
        throw new PeerDisconnectedError(
          "Peer connection is unavailable or congested",
        );
      }
      channel.send(JSON.stringify(packet));
    };
    const timer = setTimeout(
      () => fail(new PeerDisconnectedError("Session setup timed out")),
      30000,
    );
    function fail(error) {
      if (failed) return;
      failed = true;
      clearTimeout(timer);
      if (session) session.fail(error);
      else reject(error);
      channel.close();
    }
    function start() {
      clearTimeout(timer);
      session = new RollbackSession(adapter, {
        player,
        send,
        onError,
        ...manifest.timing,
      });
      resolve(session);
    }
    async function transfer(kind, bytes) {
      const hash = await sha256(bytes);
      if (failed) return;
      send({ t: kind, size: bytes.length, hash });
      for (let at = 0; at < bytes.length; at += 16384)
        channel.send(bytes.slice(at, at + 16384));
      if (kind === "state") stateSent = true;
      send({ t: kind + "-end" });
    }
    channel.onclose = () =>
      fail(new PeerDisconnectedError("Peer disconnected"));
    channel.onerror = () =>
      fail(new PeerDisconnectedError("Peer data channel failed"));
    let incoming = Promise.resolve();
    channel.onmessage = (event) => {
      incoming = incoming.then(async () => {
        if (failed) return;
        try {
          if (event.data instanceof ArrayBuffer) {
            if (!state || offset + event.data.byteLength > state.length)
              throw new Error("Invalid initial state chunk");
            state.set(new Uint8Array(event.data), offset);
            offset += event.data.byteLength;
            return;
          }
          if (typeof event.data !== "string" || event.data.length > 16384)
            throw new Error("Invalid peer message");
          const packet = JSON.parse(event.data);
          if (!packet || typeof packet !== "object")
            throw new Error("Invalid peer message");
          if (session) {
            session.receive(packet);
            return;
          }
          if (packet.t === "hello" && !remoteHello) {
            if (
              packet.player !== 1 - player ||
              JSON.stringify(packet.manifest) !== JSON.stringify(manifest)
            ) {
              throw new Error(
                "ROMs, core build, or synchronization settings do not match",
              );
            }
            remoteHello = true;
            if (player === 0 && batteryLoaded)
              await transfer("state", adapter.save());
            if (player === 1 && !batteryLoaded)
              await transfer("battery", adapter.memory(guestMemory));
          } else if (
            packet.t === "battery" &&
            player === 0 &&
            remoteHello &&
            !batteryLoaded &&
            !state
          ) {
            if (
              packet.size !== adapter.memory(guestMemory).length ||
              packet.size > 131072
            )
              throw new Error("Incompatible peer battery save");
            state = new Uint8Array(packet.size);
            offset = 0;
            transferKind = "battery";
            expectedHash = packet.hash;
          } else if (
            packet.t === "battery-end" &&
            player === 0 &&
            state &&
            transferKind === "battery"
          ) {
            if (
              offset !== state.length ||
              (await sha256(state)) !== expectedHash
            )
              throw new Error("Peer battery save is incomplete");
            if (failed) return;
            if (state.length) adapter.loadMemory(guestMemory, state);
            state = null;
            batteryLoaded = true;
            await transfer("state", adapter.save());
          } else if (
            packet.t === "state" &&
            player === 1 &&
            remoteHello &&
            !state &&
            !loaded
          ) {
            if (packet.size !== adapter.size)
              throw new Error("Incompatible initial state");
            state = new Uint8Array(packet.size);
            offset = 0;
            transferKind = "state";
            expectedHash = packet.hash;
          } else if (
            packet.t === "state-end" &&
            player === 1 &&
            state &&
            transferKind === "state" &&
            !loaded
          ) {
            if (
              offset !== state.length ||
              (await sha256(state)) !== expectedHash
            )
              throw new Error("Initial state is incomplete");
            if (failed) return;
            adapter.load(state);
            state = null;
            loaded = true;
            send({ t: "ready" });
          } else if (packet.t === "ready" && player === 0 && stateSent) {
            send({ t: "go" });
            start();
          } else if (packet.t === "go" && player === 1 && loaded) {
            start();
          } else {
            throw new Error("Unexpected session setup message");
          }
        } catch (error) {
          fail(error);
        }
      });
    };
    for (const event of channel.linkMessages ?? []) channel.onmessage(event);
    delete channel.linkMessages;
    send({ t: "hello", player, manifest });
  });
}

export async function connectGroupSession(
  adapter,
  channels,
  manifest,
  player,
  onError = () => {},
) {
  const players = manifest.roms.length;
  if (
    players < 3 ||
    players > 4 ||
    channels.size !== players - 1 ||
    channels.has(player)
  )
    throw new Error("Invalid link participants");
  return new Promise((resolve, reject) => {
    const hellos = new Set(),
      batteries = new Set([player]),
      ready = new Set([0]);
    const transfers = new Map(),
      earlyInputs = [];
    let session,
      failed = false,
      stateSent = false,
      loaded = false,
      readySent = false;
    const timer = setTimeout(
      () => fail(new PeerDisconnectedError("Session setup timed out")),
      45000,
    );
    function fail(error) {
      if (failed) return;
      failed = true;
      clearTimeout(timer);
      if (session) session.fail(error);
      else reject(error);
      for (const channel of channels.values()) channel.close();
    }
    function send(peer, packet) {
      const channel = channels.get(peer);
      if (
        channel?.readyState !== "open" ||
        channel.bufferedAmount > 16 * 1024 * 1024
      )
        throw new PeerDisconnectedError(
          "Peer connection is unavailable or congested",
        );
      channel.send(JSON.stringify(packet));
    }
    function start() {
      clearTimeout(timer);
      session = new RollbackSession(adapter, {
        ...manifest.timing,
        player,
        players,
        onError,
        send: (packet) => {
          for (const peer of channels.keys()) send(peer, packet);
        },
      });
      for (const [peer, packet] of earlyInputs) session.receive(packet, peer);
      resolve(session);
    }
    async function transfer(peer, kind, bytes) {
      const hash = await sha256(bytes);
      if (failed) return;
      send(peer, { t: kind, size: bytes.length, hash });
      const channel = channels.get(peer);
      for (let at = 0; at < bytes.length; at += 16384)
        channel.send(bytes.slice(at, at + 16384));
      send(peer, { t: kind + "-end" });
    }
    async function shareState() {
      if (
        player !== 0 ||
        stateSent ||
        hellos.size !== players - 1 ||
        batteries.size !== players
      )
        return;
      stateSent = true;
      const state = adapter.save();
      await Promise.all(
        [...channels.keys()].map((peer) => transfer(peer, "state", state)),
      );
    }
    function reportReady() {
      if (player !== 0 && loaded && hellos.size === players - 1 && !readySent) {
        readySent = true;
        send(0, { t: "ready" });
      }
    }
    async function receive(peer, event) {
      if (failed) return;
      if (event.data instanceof ArrayBuffer) {
        const transfer = transfers.get(peer);
        if (
          !transfer ||
          transfer.offset + event.data.byteLength > transfer.bytes.length
        )
          throw new Error("Invalid initial state chunk");
        transfer.bytes.set(new Uint8Array(event.data), transfer.offset);
        transfer.offset += event.data.byteLength;
        return;
      }
      if (typeof event.data !== "string" || event.data.length > 16384)
        throw new Error("Invalid peer message");
      const packet = JSON.parse(event.data);
      if (!packet || typeof packet !== "object")
        throw new Error("Invalid peer message");
      if (session) {
        session.receive(packet, peer);
        return;
      }
      if (["input", "hash"].includes(packet.t) && (loaded || stateSent)) {
        if (earlyInputs.length > 128)
          throw new Error("Too many early input frames");
        earlyInputs.push([peer, packet]);
      } else if (packet.t === "hello" && !hellos.has(peer)) {
        if (
          packet.player !== peer ||
          JSON.stringify(packet.manifest) !== JSON.stringify(manifest)
        )
          throw new Error(
            "ROMs, core build, or synchronization settings do not match",
          );
        hellos.add(peer);
        if (peer === 0)
          await transfer(
            0,
            "battery",
            adapter.memory(adapter.memoryIds[player]),
          );
        await shareState();
        reportReady();
      } else if (
        packet.t === "battery" &&
        player === 0 &&
        hellos.has(peer) &&
        !batteries.has(peer) &&
        !transfers.has(peer)
      ) {
        if (
          packet.size !== adapter.memory(adapter.memoryIds[peer]).length ||
          packet.size > 131072
        )
          throw new Error("Incompatible peer battery save");
        transfers.set(peer, {
          kind: "battery",
          bytes: new Uint8Array(packet.size),
          offset: 0,
          hash: packet.hash,
        });
      } else if (
        packet.t === "state" &&
        player !== 0 &&
        peer === 0 &&
        hellos.has(0) &&
        !loaded &&
        !transfers.has(peer)
      ) {
        if (packet.size !== adapter.size)
          throw new Error("Incompatible initial state");
        transfers.set(peer, {
          kind: "state",
          bytes: new Uint8Array(packet.size),
          offset: 0,
          hash: packet.hash,
        });
      } else if (["state-end", "battery-end"].includes(packet.t)) {
        const incoming = transfers.get(peer);
        if (
          !incoming ||
          packet.t !== incoming.kind + "-end" ||
          incoming.offset !== incoming.bytes.length ||
          (await sha256(incoming.bytes)) !== incoming.hash
        )
          throw new Error("Initial data is incomplete");
        if (failed) return;
        transfers.delete(peer);
        if (incoming.kind === "battery") {
          adapter.loadMemory(adapter.memoryIds[peer], incoming.bytes);
          batteries.add(peer);
          await shareState();
        } else {
          adapter.load(incoming.bytes);
          loaded = true;
          reportReady();
        }
      } else if (
        packet.t === "ready" &&
        player === 0 &&
        stateSent &&
        !ready.has(peer)
      ) {
        ready.add(peer);
        if (ready.size === players) {
          for (const target of channels.keys()) send(target, { t: "go" });
          start();
        }
      } else if (packet.t === "go" && player !== 0 && peer === 0 && loaded)
        start();
      else throw new Error("Unexpected session setup message");
    }
    const announced = Promise.all([...channels.values()].map(waitForOpen))
      .then(() => {
        if (!failed)
          for (const peer of channels.keys())
            send(peer, { t: "hello", player, manifest });
      })
      .catch(fail);
    for (const [peer, channel] of channels) {
      channel.binaryType = "arraybuffer";
      channel.onclose = () =>
        fail(new PeerDisconnectedError("Peer disconnected"));
      channel.onerror = () =>
        fail(new PeerDisconnectedError("Peer data channel failed"));
      let incoming = announced;
      channel.onmessage = (event) => {
        incoming = incoming.then(() => receive(peer, event)).catch(fail);
      };
      for (const event of channel.linkMessages ?? []) channel.onmessage(event);
      delete channel.linkMessages;
    }
  });
}

export function confirmedMemory(adapter, session, id) {
  if (!session) return adapter.memory(id);
  const current = adapter.save();
  const confirmed = session.snapshots.get(
    Math.min(session.frame, session.remoteThrough + 1),
  );
  if (!confirmed) throw new Error("No confirmed save is available");
  try {
    adapter.load(confirmed);
    return adapter.memory(id);
  } finally {
    adapter.load(current);
  }
}

export async function gatherDescription(connection) {
  if (connection.iceGatheringState !== "complete") {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error("ICE discovery timed out")),
        15000,
      );
      function finish(error) {
        clearTimeout(timer);
        connection.removeEventListener("icegatheringstatechange", changed);
        error ? reject(error) : resolve();
      }
      function changed() {
        if (connection.iceGatheringState === "complete") finish();
      }
      connection.addEventListener("icegatheringstatechange", changed);
    });
  }
  return JSON.stringify(connection.localDescription);
}
