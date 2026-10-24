import test from "node:test";
import assert from "node:assert/strict";
import {
  connectSession,
  connectGroupSession,
  confirmedMemory,
} from "../data/src/input-netplay.js";
import { Netplay } from "../data/src/netplay.js";
import { LinkNetplay } from "../data/src/link-netplay.js";

class Core {
  begin() {}
  constructor(a, b) {
    this.size = 65540;
    this.bytes = new Uint8Array(this.size);
    this.bytes.fill(a, 4, 32772);
    this.bytes.fill(b, 32772);
  }
  save() {
    return this.bytes.slice();
  }
  load(bytes) {
    this.bytes.set(bytes);
  }
  memory(id) {
    return this.bytes.slice(
      id === 256 ? 4 : 32772,
      id === 256 ? 32772 : undefined,
    );
  }
  loadMemory(id, bytes) {
    this.bytes.set(bytes, id === 256 ? 4 : 32772);
  }
  step(a, b) {
    this.bytes[0]++;
    this.bytes[4] += a;
    this.bytes[32772] += b;
  }
}

class Channel extends EventTarget {
  readyState = "open";
  bufferedAmount = 0;
  messages = [];
  send(data) {
    const copied = typeof data === "string" ? data : data.slice().buffer;
    this.messages.push(copied);
    queueMicrotask(() => {
      if (this.peer.readyState === "open")
        this.peer.onmessage?.({ data: copied });
    });
  }
  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.onclose?.();
    this.dispatchEvent(new Event("close"));
    this.peer.close();
  }
}
function pair() {
  const a = new Channel(),
    b = new Channel();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
const manifest = {
  protocol: 1,
  roms: ["gold", "silver"],
  batteries: "per-player",
  timing: { inputDelay: 2, maxPrediction: 12 },
};

test("GBA peers exchange guest SRAM on memory 256 while preserving host memory 0", async () => {
  class GbaCore extends Core {
    memoryIds = [0, 256];
    memory(id) {
      return super.memory(id === 0 ? 256 : 768);
    }
    loadMemory(id, bytes) {
      super.loadMemory(id === 0 ? 256 : 768, bytes);
    }
  }
  const channels = pair(),
    cores = [new GbaCore(31, 99), new GbaCore(88, 42)];
  const sessions = await Promise.all(
    cores.map((core, player) =>
      connectSession(
        core,
        channels[player],
        { ...manifest, core: "mgba_splitscreen" },
        player,
      ),
    ),
  );
  assert.deepEqual(cores[0].save(), cores[1].save());
  assert.equal(cores[0].memory(0)[0], 31);
  assert.equal(cores[0].memory(256)[0], 42);
  sessions.forEach((session) => {
    session.stopped = true;
  });
  channels[0].close();
});

test("handshake combines each player's own battery before sharing the initial state", async () => {
  const channels = pair(),
    cores = [new Core(11, 99), new Core(88, 22)];
  const sessions = await Promise.all(
    cores.map((core, p) => connectSession(core, channels[p], manifest, p)),
  );
  assert.deepEqual(cores[0].save(), cores[1].save());
  assert.equal(cores[0].memory(256)[0], 11);
  assert.equal(cores[0].memory(768)[0], 22);
  assert.equal(
    channels[1].messages.filter(
      (m) => typeof m === "string" && JSON.parse(m).t === "battery",
    ).length,
    1,
  );
  assert.ok(sessions.every((s) => !s.stopped));
  const before = channels.map((c) => c.messages.length);
  for (let i = 0; i < 120; i++) {
    sessions.forEach((s, p) => s.tick(i % (p + 2)));
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(sessions.every((s) => s.stats.checks === 2));
  channels.forEach((c, p) =>
    assert.ok(
      c.messages
        .slice(before[p])
        .every(
          (m) =>
            typeof m === "string" &&
            ["input", "hash"].includes(JSON.parse(m).t),
        ),
    ),
  );
  channels[0].close();
  assert.ok(sessions.every((s) => s.stopped));
});

test("legacy host-state handshake still works without the per-player battery capability", async () => {
  const channels = pair(),
    cores = [new Core(11, 12), new Core(88, 99)];
  const { batteries, ...legacy } = manifest;
  await Promise.all(
    cores.map((core, p) => connectSession(core, channels[p], legacy, p)),
  );
  assert.deepEqual(cores[0].save(), cores[1].save());
  assert.equal(cores[1].memory(768)[0], 12);
  channels[0].close();
});

test("a mismatched ROM pair or battery protocol rejects both peers without loading saves", async () => {
  for (const different of [
    { ...manifest, roms: ["silver", "gold"] },
    { ...manifest, batteries: undefined },
  ]) {
    const channels = pair(),
      cores = [new Core(11, 12), new Core(88, 99)];
    const before = cores.map((c) => c.save());
    const result = await Promise.allSettled(
      cores.map((core, p) =>
        connectSession(core, channels[p], p ? different : manifest, p),
      ),
    );
    assert.ok(result.every((r) => r.status === "rejected"));
    cores.forEach((core, p) => assert.deepEqual(core.save(), before[p]));
  }
});

test("exports use the confirmed snapshot and leave the predicted machine untouched", () => {
  const core = new Core(11, 22),
    confirmed = core.save();
  core.step(7, 9);
  const predicted = core.save();
  const bytes = confirmedMemory(
    core,
    { frame: 1, remoteThrough: -1, snapshots: new Map([[0, confirmed]]) },
    768,
  );
  assert.equal(bytes[0], 22);
  assert.deepEqual(core.save(), predicted);
});

test("room creation retains the existing events and numeric IDs for ordinary netplay", () => {
  for (const link of [false, true]) {
    const sent = [];
    const netplay = Object.create(Netplay.prototype);
    Object.assign(netplay, {
      emu: { config: { gameId: 19 } },
      name: "Player",
      players: {},
      socket: { emit: (...args) => sent.push(args) },
      _unlockMobileAudio() {},
      startSocketIO(cb) {
        cb();
      },
      inputSession: link ? { gameId: "link:19:20", prepare() {} } : null,
    });
    globalThis.window = { location: { host: "romm.test" } };
    netplay.openRoom("Room", 4, "password");
    assert.equal(sent[0][0], "open-room");
    assert.equal(sent[0][1].extra.game_id, link ? "link:19:20" : 19);
    assert.equal(sent[0][1].extra.room_password, "password");
    assert.equal(sent[0][1].maxPlayers, link ? 2 : 4);
  }
});

test("cartridges without battery RAM can complete the same handshake", async () => {
  const channels = pair(),
    cores = [new Core(0, 0), new Core(0, 0)];
  cores.forEach((core) => {
    core.memory = () => new Uint8Array();
    core.loadMemory = () =>
      assert.fail("Empty battery RAM must not be imported");
  });
  const sessions = await Promise.all(
    cores.map((core, p) => connectSession(core, channels[p], manifest, p)),
  );
  assert.ok(sessions.every((session) => !session.stopped));
  channels[0].close();
});

test("protocol errors remain errors and preserve confirmed saves for rejoining", () => {
  const core = new Core(11, 22),
    states = [],
    audio = [];
  const netplay = {
    emu: { gameManager: { setVariable: (...args) => audio.push(args) } },
    leaveRoom() {
      link.stop();
    },
  };
  const link = new LinkNetplay(netplay, core, {
    manifest,
    save: null,
    onStatus: (event) => states.push(event.status),
  });
  link.role = 1;
  link.session = {
    frame: 1,
    remoteThrough: -1,
    snapshots: new Map([[0, core.save()]]),
  };
  core.step(7, 9);
  const session = link.session;
  link.fail(new Error("State mismatch at frame 60"));
  assert.deepEqual(states, ["solo", "stopped", "error"]);
  assert.equal(link.save[0], 22);
  assert.equal(session.stopped, true);
  link.prepare(false);
  assert.equal(link.session, null);
  assert.equal(link.status, "waiting");
  assert.equal(core.memory(768)[0], 22);
  assert.deepEqual(audio.at(-1), ["sameboy_audio_output", "Game Boy #2"]);
});

function linkedCore(role) {
  const core = new Core(11, 22),
    events = [],
    variables = [];
  const netplay = {
    owner: role === 0,
    players: {
      host: { socketId: role === 0 ? "self" : "peer" },
      guest: { socketId: role === 1 ? "self" : "peer" },
    },
    peerConnections: {},
    socket: { emit() {} },
    emu: { gameManager: { setVariable: (...args) => variables.push(args) } },
    leaveRoom() {
      link.stop();
      for (const peer of Object.values(this.peerConnections)) peer.pc.close();
      this.peerConnections = {};
    },
  };
  const link = new LinkNetplay(netplay, core, {
    manifest,
    save: null,
    onStatus: (event) => events.push(event.status),
  });
  link.role = role;
  return { link, core, netplay, events, variables };
}

test("leaving resumes each cartridge from the confirmed frame with only its own input", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  globalThis.window = { localButtons: 3 };
  for (const role of [0, 1]) {
    const { link, core, netplay, events, variables } = linkedCore(role);
    const confirmed = core.save();
    link.session = {
      frame: 1,
      remoteThrough: -1,
      snapshots: new Map([[0, confirmed]]),
    };
    const session = link.session;
    core.step(7, 9);
    netplay.leaveRoom();
    assert.deepEqual(core.save(), confirmed);
    assert.equal(link.status, "solo");
    assert.equal(session.stopped, true);
    assert.deepEqual(variables.at(-1), ["sameboy_link", "disabled"]);
    const timer = link.timer;
    netplay.leaveRoom();
    assert.equal(link.timer, timer);
    assert.deepEqual(events, ["solo"]);
    t.mock.timers.tick(5);
    assert.equal(core.bytes[0], 1);
    assert.equal(core.memory(256)[0], role === 0 ? 14 : 11);
    assert.equal(core.memory(768)[0], role === 1 ? 25 : 22);
    assert.equal(link.battery()[0], role === 0 ? 14 : 25);
    link.destroy();
    const stopped = core.save();
    t.mock.timers.tick(100);
    assert.deepEqual(core.save(), stopped);
    assert.equal(link.status, "stopped");
  }
});

test("peer departure releases the room without an error or a core restart", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { link, core, netplay, events } = linkedCore(1);
  let closed = 0;
  netplay.peerConnections.peer = { pc: { close: () => closed++ } };
  core.step(1, 2);
  const before = core.save();
  link.usersUpdated({ self: { socketId: "self" } });
  assert.equal(closed, 1);
  assert.deepEqual(core.save(), before);
  assert.deepEqual(events, ["solo"]);
  link.destroy();
});

test("offline playback can return to the native loop and be reclaimed before rejoining", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { link, core, netplay, variables } = linkedCore(1);
  const confirmed = core.save();
  let active = true;
  let resumed = 0;
  core.begin = () => {
    active = true;
  };
  const save = core.save.bind(core);
  core.save = () => {
    assert.equal(active, true, "Snapshots require the synchronized loop");
    return save();
  };
  link.onSolo = (role) => {
    assert.equal(role, 1);
    assert.deepEqual(core.save(), confirmed);
    assert.deepEqual(variables.at(-1), ["sameboy_link", "disabled"]);
    active = false;
    resumed++;
  };
  link.session = {
    frame: 1,
    remoteThrough: -1,
    snapshots: new Map([[0, confirmed]]),
  };
  core.step(7, 9);
  netplay.leaveRoom();
  assert.equal(link.status, "solo");
  assert.equal(link.timer, null);
  t.mock.timers.tick(100);
  assert.deepEqual(save(), confirmed);
  netplay.leaveRoom();
  assert.equal(active, false);
  assert.equal(resumed, 1);

  // Native play can update SRAM without re-enabling snapshot callbacks.
  core.step(0, 3);
  assert.equal(link.battery()[0], 25);
  link.prepare(false);
  assert.equal(active, true);
  assert.equal(link.status, "waiting");
  assert.equal(core.memory(768)[0], 25);
  link.destroy();
});

test("a data channel closing resumes both players and ignores later connection callbacks", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const channels = pair();
  class PeerConnection {
    connectionState = "connected";
    createDataChannel() {
      this.channel = channels[0];
      return this.channel;
    }
    async createOffer() {
      return {};
    }
    async setLocalDescription(offer) {
      this.localDescription = offer;
    }
    close() {
      this.connectionState = "closed";
      this.onconnectionstatechange?.();
      this.channel?.close();
    }
  }
  const original = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = PeerConnection;
  t.after(() => {
    globalThis.RTCPeerConnection = original;
  });
  const players = [linkedCore(0), linkedCore(1)];
  t.after(() => players.forEach((p) => p.link.destroy()));
  const pcs = players.map(({ link }) => link.createPeerConnection("peer"));
  pcs[1].channel = channels[1];
  pcs[1].ondatachannel({ channel: channels[1] });
  const deadline = performance.now() + 1000;
  while (
    performance.now() < deadline &&
    players.some((p) => p.link.status !== "connected")
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(players.every((p) => p.link.status === "connected"));
  channels[0].close();
  players.forEach(({ link, events }) => {
    assert.equal(link.status, "solo");
    assert.equal(events.includes("error"), false);
  });
  pcs.forEach((pc) => pc.onconnectionstatechange());
  assert.ok(players.every((p) => p.link.status === "solo"));
  players.forEach((p) => p.link.destroy());
});

test("input netplay keeps guest menus while ordinary streaming retains guest restrictions", () => {
  for (const link of [false, true]) {
    const hidden = [];
    const button = {
      classList: { toggle: (_name, value) => hidden.push(value) },
    };
    const netplay = Object.create(Netplay.prototype);
    Object.assign(netplay, {
      owner: false,
      inputSession: link ? {} : null,
      emu: { elements: { bottomBar: { exit: [button], restart: [button] } } },
    });
    netplay.updateNetplayUI(true);
    assert.deepEqual(hidden, [!link, !link]);
  }
});

test("ordinary playback commands cannot resume the paused native loop in input netplay", () => {
  for (const link of [false, true]) {
    const calls = [];
    const netplay = Object.create(Netplay.prototype);
    Object.assign(netplay, {
      inputSession: link ? {} : null,
      emu: {
        pause: () => calls.push("pause"),
        play: () => calls.push("play"),
        gameManager: { restart: () => calls.push("restart") },
      },
    });
    netplay.dataMessage({ pause: true, play: true, restart: true });
    assert.deepEqual(calls, link ? [] : ["pause", "play", "restart"]);
  }
});

test("three and four peers tolerate late mesh connections, exchange own SRAM, then only direct inputs and hashes", async () => {
  for (const [players, delayed] of [
    [3, false],
    [4, false],
    [3, true],
    [4, true],
  ]) {
    class MultiCore {
      constructor(player) {
        this.memoryIds = [0, 256, 257, 258].slice(0, players);
        this.size = 4 + players * 32;
        this.bytes = new Uint8Array(this.size).fill(99);
        this.bytes.fill(0, 0, 4);
        this.loadMemory(
          this.memoryIds[player],
          new Uint8Array(32).fill(player + 10),
        );
      }
      save() {
        return this.bytes.slice();
      }
      load(bytes) {
        this.bytes.set(bytes);
      }
      memory(id) {
        const at = 4 + 32 * this.memoryIds.indexOf(id);
        return this.bytes.slice(at, at + 32);
      }
      loadMemory(id, bytes) {
        this.bytes.set(bytes, 4 + 32 * this.memoryIds.indexOf(id));
      }
      stepPlayers(buttons) {
        this.bytes[0]++;
        buttons.forEach((b, p) => (this.bytes[4 + 32 * p] += b));
      }
    }
    const channels = Array.from({ length: players }, () => new Map());
    for (let a = 0; a < players; a++)
      for (let b = a + 1; b < players; b++) {
        const [first, second] = pair();
        channels[a].set(b, first);
        channels[b].set(a, second);
      }
    const cores = Array.from({ length: players }, (_, p) => new MultiCore(p));
    const errors = [];
    const groupManifest = {
      ...manifest,
      core: "mgba_splitscreen",
      roms: cores.map((_, p) => String(p)),
    };
    const late = [channels[1].get(2), channels[2].get(1)];
    const send = late[0].send.bind(late[0]);
    if (delayed) {
      late.forEach((channel) => (channel.readyState = "connecting"));
      late[0].send = (data) => setTimeout(() => send(data), 30);
      setTimeout(() => {
        late.forEach((channel) => {
          channel.readyState = "open";
          channel.dispatchEvent(new Event("open"));
        });
      }, 10);
    }
    const sessions = await Promise.all(
      cores.map((core, p) =>
        connectGroupSession(core, channels[p], groupManifest, p, (e) =>
          errors.push(e),
        ),
      ),
    );
    late[0].send = send;
    for (const peers of channels)
      for (const channel of peers.values())
        assert.equal(JSON.parse(channel.messages[0]).t, "hello");
    cores.forEach((core) => {
      assert.deepEqual(core.save(), cores[0].save());
      core.memoryIds.forEach((id, p) =>
        assert.equal(core.memory(id)[0], p + 10),
      );
    });
    const before = channels.map(
      (peers) => new Map([...peers].map(([p, c]) => [p, c.messages.length])),
    );
    for (let frame = 0; frame < 180; frame++) {
      sessions.forEach((session, p) => session.tick(p + 1));
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(errors, []);
    sessions.forEach((session, p) => {
      assert.equal(session.stats.checks, 3 * (players - 1));
      assert.deepEqual(
        confirmedMemory(cores[p], session, cores[p].memoryIds[p]),
        cores[p].memory(cores[p].memoryIds[p]),
      );
      for (const [other, channel] of channels[p]) {
        assert.ok(
          channel.messages
            .slice(before[p].get(other))
            .every(
              (message) =>
                typeof message === "string" &&
                ["input", "hash"].includes(JSON.parse(message).t),
            ),
        );
      }
      session.stopped = true;
    });
    channels[0].get(1).close();
  }
});

test("room ownership does not choose the local cartridge slot", () => {
  for (const role of [0, 1]) {
    const { link, netplay } = linkedCore(role);
    netplay.owner = role !== 0;
    netplay.playerID = role === 0 ? "host" : "guest";
    link.prepare(netplay.owner);
    assert.equal(link.role, role);
    assert.equal(link.battery()[0], role === 0 ? 11 : 22);
    link.destroy();
  }
});
