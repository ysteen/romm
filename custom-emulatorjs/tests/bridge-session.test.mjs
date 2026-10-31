import assert from "node:assert/strict";
import test from "node:test";
import {
  BridgeConnection,
  BridgeSession,
  crc32,
} from "../data/src/bridge-session.js";

class Core {
  constructor(players = 2) {
    this.values = new Uint32Array(players + 1);
    this.size = this.values.byteLength;
  }
  save() {
    return new Uint8Array(this.values.buffer.slice(0));
  }
  load(bytes) {
    new Uint8Array(this.values.buffer).set(bytes);
  }
  memory() {
    return new Uint8Array();
  }
  stepPlayers(buttons) {
    this.values[0]++;
    buttons.forEach((value, player) => {
      this.values[player + 1] += value;
    });
  }
}

test("CRC32 matches the RetroArch CRC polynomial", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
});

test("relay stalls without guessing input and sends each delayed input once", () => {
  const packets = [];
  const core = new Core();
  const session = new BridgeSession(core, {
    player: 0,
    players: 2,
    send: (p) => packets.push(p),
  });
  session.start();
  for (let i = 0; i < 20; i++) assert.equal(session.tick(256), false);
  assert.equal(core.values[0], 0);
  assert.deepEqual(
    packets.map((p) => p.f),
    [0, 1, 2],
  );
  session.receive({ player: 1, f: 0, b: 128 });
  assert.equal(session.tick(256), true);
  assert.deepEqual([...core.values], [1, 0, 128]);
  session.paused = true;
  assert.equal(session.tick(512), false);
  assert.equal(session.nextInput, 3);
});

test("four web peers retain matching states under uneven delivery", () => {
  const queues = Array.from({ length: 4 }, () => []);
  const cores = Array.from({ length: 4 }, () => new Core(4));
  const sessions = cores.map(
    (core, player) =>
      new BridgeSession(core, {
        player,
        players: 4,
        send(packet) {
          if (packet.t === "input")
            queues.forEach((queue, peer) => {
              if (peer !== player) queue.push({ ...packet, player });
            });
        },
      }),
  );
  sessions.forEach((session) => session.start());
  for (
    let step = 0;
    step < 2000 && sessions.some((s) => s.frame < 180);
    step++
  ) {
    sessions.forEach((session, player) => {
      if (step % (player + 2) !== 0) return;
      for (const packet of queues[player].splice(0)) session.receive(packet);
      if (session.frame < 180) session.tick((session.frame + 1) * (player + 1));
    });
  }
  assert.ok(sessions.every((session) => session.frame === 180));
  for (const core of cores.slice(1))
    assert.deepEqual(core.save(), cores[0].save());
  assert.ok(sessions.every((session) => session.stats.checks === 3));
  assert.ok(sessions.every((session) => session.snapshots.size <= 8));
  assert.throws(() => sessions[0].stateAt(0), /no longer/);
});

test("relay rejects gaps, conflicting frames and invalid controller slots", () => {
  const session = new BridgeSession(new Core(), {
    player: 0,
    players: 2,
    send() {},
  });
  for (const packet of [
    { player: 1, f: 1, b: 0 },
    { player: 0, f: 0, b: 0 },
    { player: 2, f: 0, b: 0 },
    { player: 1, f: 0, b: 65536 },
  ])
    assert.throws(() => session.receive(packet), /sequence/);
  session.receive({ player: 1, f: 0, b: 2 });
  assert.throws(() => session.receive({ player: 1, f: 0, b: 3 }), /sequence/);
});

class Socket extends EventTarget {
  readyState = 1;
  bufferedAmount = 0;
  sent = [];
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
}

test("guest loads initial state and acknowledges its exact revision before starting", () => {
  const core = new Core();
  const socket = new Socket();
  const link = new BridgeConnection(core, socket, { player: 1, players: 2 });
  link.receive(JSON.stringify({ t: "joined", player: 1, players: 2 }));
  assert.deepEqual(JSON.parse(socket.sent[0]), { t: "battery", size: 0 });
  const host = new Core();
  host.values[1] = 123;
  link.receive(
    JSON.stringify({ t: "state", f: 0, size: core.size, revision: 4 }),
  );
  link.receive(host.save().buffer);
  assert.deepEqual(core.save(), host.save());
  assert.deepEqual(JSON.parse(socket.sent[2]), { t: "ready", revision: 4 });
  link.receive(JSON.stringify({ t: "start", f: 0, player: 1, players: 2 }));
  assert.ok(link.session);
  link.stop();
  assert.ok(link.session.stopped);
});

test("initial transfer cannot overwrite an active session", () => {
  const core = new Core();
  const link = new BridgeConnection(core, new Socket(), {
    player: 1,
    players: 2,
  });
  link.receive(JSON.stringify({ t: "start", f: 0, player: 1, players: 2 }));
  assert.throws(
    () =>
      link.receive(
        JSON.stringify({ t: "state", f: 0, size: core.size, revision: 1 }),
      ),
    /Incompatible/,
  );
});

test("relay disconnect preserves the server failure reason for the UI", () => {
  const socket = new Socket();
  const errors = [];
  const link = new BridgeConnection(new Core(), socket, {
    player: 0,
    players: 2,
    onError: (error) => errors.push(error.message),
  });
  link.receive(JSON.stringify({ t: "start", f: 0, player: 0, players: 2 }));
  const message = "Rollback state mismatch; core compatibility failed";
  socket.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({ t: "disconnect", message }),
    }),
  );
  assert.deepEqual(errors, [message]);
  assert.ok(link.closed);
  assert.ok(link.session.stopped);
  assert.equal(socket.readyState, 3);
});

test("an intentional relay disconnect without a reason stops without an error", () => {
  const socket = new Socket();
  const errors = [];
  const statuses = [];
  const link = new BridgeConnection(new Core(), socket, {
    player: 0,
    players: 2,
    onError: (error) => errors.push(error),
    onStatus: (status) => statuses.push(status),
  });
  socket.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({ t: "disconnect" }),
    }),
  );
  assert.ok(link.closed);
  assert.equal(socket.readyState, 3);
  assert.deepEqual(errors, []);
  assert.deepEqual(statuses, ["stopped"]);
});

test("future native state requests wait for the matching confirmed frame", () => {
  const core = new Core();
  const socket = new Socket();
  const link = new BridgeConnection(core, socket, { player: 0, players: 2 });
  link.receive(JSON.stringify({ t: "start", f: 0, player: 0, players: 2 }));
  link.receive(JSON.stringify({ t: "state-request", f: 2 }));
  for (let f = 0; f < 2; f++) {
    link.receive(JSON.stringify({ t: "input", player: 1, f, b: 17 }));
    link.tick(0);
  }
  const header = socket.sent.findIndex(
    (packet) => typeof packet === "string" && JSON.parse(packet).t === "state",
  );
  assert.deepEqual(JSON.parse(socket.sent[header]), {
    t: "state",
    f: 2,
    size: core.size,
  });
  assert.deepEqual(socket.sent[header + 1], core.save());
  assert.equal(link.stateRequests.size, 0);
});

test("native calibration waits for verification and preserves the host's state", async () => {
  const core = new Core();
  core.values[1] = 42;
  const original = core.save();
  const first = new Core().save(),
    second = new Core().save();
  let release;
  const done = new Promise((resolve) => {
    release = resolve;
  });
  const socket = new Socket();
  const link = new BridgeConnection(core, socket, {
    player: 0,
    players: 2,
    async calibrate(adapter, a, b) {
      assert.deepEqual(a, first);
      assert.deepEqual(b, second);
      adapter.values[1] = 999;
      await done;
    },
  });
  for (let stage = 0; stage < 2; stage++) {
    link.receive(
      JSON.stringify({
        t: "native-calibration",
        player: 1,
        stage,
        size: core.size,
      }),
    );
    link.receive((stage ? second : first).buffer);
  }
  await Promise.resolve();
  assert.equal(socket.sent.length, 0);
  assert.throws(
    () =>
      link.receive(JSON.stringify({ t: "start", f: 0, player: 0, players: 2 })),
    /Invalid/,
  );
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(core.save(), original);
  assert.deepEqual(JSON.parse(socket.sent[0]), { t: "native-ready" });
});

class ReplayCore extends Core {
  presented = [];
  replayed = [];
  stepPlayers(buttons, present = true) {
    this.values[0]++;
    buttons.forEach((value, player) => {
      this.values[player + 1] =
        Math.imul(this.values[player + 1], 31) + value + this.values[0];
    });
    (present ? this.presented : this.replayed).push([...buttons]);
  }
  memory() {
    return new Uint8Array(this.values.buffer);
  }
}

function predictedSession({ core = new ReplayCore(), maxPrediction = 4 } = {}) {
  const packets = [];
  const session = new BridgeSession(core, {
    player: 0,
    players: 2,
    maxPrediction,
    send: (packet) => packets.push(packet),
  });
  session.start();
  return { session, core, packets };
}

test("late input restores the original frame and replays without presenting or resending", () => {
  const { session, core, packets } = predictedSession();
  for (let f = 0; f < 4; f++) assert.equal(session.tick(7), true);
  const inputCount = packets.filter((p) => p.t === "input").length;
  const progressCount = packets.filter((p) => p.t === "progress").length;
  assert.equal(session.confirmed, 0);
  assert.throws(() => session.stateAt(1), /not confirmed/);
  session.receive({ player: 1, f: 0, b: 9 });
  session.receive({ player: 1, f: 1, b: 9 });
  session.receive({ player: 1, f: 2, b: 3 });
  session.receive({ player: 1, f: 3, b: 3 });
  const baseline = new ReplayCore();
  for (let f = 0; f < 4; f++)
    baseline.stepPlayers([f < 2 ? 0 : 7, f < 2 ? 9 : 3]);
  assert.deepEqual(core.save(), baseline.save());
  assert.equal(session.confirmed, 4);
  assert.equal(session.stats.rollbacks, 2);
  assert.equal(session.stats.replayedFrames, 6);
  assert.equal(session.stats.frames, 4);
  assert.equal(core.presented.length, 4);
  assert.equal(core.replayed.length, 6);
  assert.equal(packets.filter((p) => p.t === "input").length, inputCount);
  assert.equal(
    packets.filter((p) => p.t === "progress").length,
    progressCount + 4,
  );
});

test("prediction stalls at its limit without filling input queues indefinitely", () => {
  const { session, packets } = predictedSession({ maxPrediction: 3 });
  for (let f = 0; f < 3; f++) assert.equal(session.tick(4), true);
  for (let i = 0; i < 1000; i++) assert.equal(session.tick(4), false);
  assert.equal(session.frame, 3);
  assert.equal(session.snapshots.size, 4);
  assert.equal(packets.filter((p) => p.t === "input").length, 6);
  session.receive({ player: 1, f: 0, b: 0 });
  assert.equal(session.stats.rollbacks, 0);
  assert.equal(session.tick(4), true);
});

test("a predicted checkpoint is sent only after correction and confirmation", () => {
  const { session, core, packets } = predictedSession();
  for (let f = 0; f < 58; f++) {
    session.receive({ player: 1, f, b: 0 });
    session.tick(0);
  }
  session.tick(0);
  session.tick(0);
  assert.equal(session.frame, 60);
  assert.equal(session.confirmed, 58);
  assert.equal(packets.filter((p) => p.t === "crc").length, 0);
  session.receive({ player: 1, f: 58, b: 9 });
  session.receive({ player: 1, f: 59, b: 9 });
  const checks = packets.filter((p) => p.t === "crc");
  assert.deepEqual(checks, [{ t: "crc", f: 60, crc: crc32(core.save()) }]);
  session.receive({ player: 1, f: 60, b: 9 });
  assert.equal(packets.filter((p) => p.t === "crc").length, 1);
  assert.equal(session.stats.checks, 1);
  const beforeCheck = packets.indexOf(checks[0]) - 1;
  assert.deepEqual(packets[beforeCheck], {
    t: "progress",
    f: 60,
    confirmed: 60,
  });
});

test("confirmed memory excludes speculative writes and survives restoring a borrowed view", () => {
  const { session, core } = predictedSession();
  const initial = core.save();
  session.tick(3);
  session.tick(3);
  const predicted = core.save();
  const saved = session.confirmedMemory(0);
  assert.deepEqual(saved, initial);
  assert.deepEqual(core.save(), predicted);
  session.receive({ player: 1, f: 0, b: 5 });
  const baseline = new ReplayCore();
  baseline.stepPlayers([0, 5]);
  assert.deepEqual(session.confirmedMemory(0), baseline.save());
  assert.equal(session.frame, 2);
  assert.equal(session.confirmed, 1);
  assert.deepEqual(saved, initial);
});

test("four rollback peers converge with bounded histories under delayed input", () => {
  const queues = Array.from({ length: 4 }, () => []);
  const cores = Array.from({ length: 4 }, () => new ReplayCore(4));
  const sessions = cores.map(
    (core, player) =>
      new BridgeSession(core, {
        player,
        players: 4,
        maxPrediction: 6,
        send(packet) {
          if (packet.t === "input")
            queues.forEach((queue, peer) => {
              if (peer !== player) queue.push({ ...packet, player });
            });
        },
      }),
  );
  sessions.forEach((session) => session.start());
  for (
    let turn = 0;
    turn < 2000 && sessions.some((s) => s.confirmed < 180);
    turn++
  ) {
    sessions.forEach((session, player) => {
      if (turn % (player + 4) === 0)
        for (const packet of queues[player].splice(0)) session.receive(packet);
      if (session.frame < 180) session.tick((session.frame + 3) * (player + 1));
      assert.ok(session.frame - session.confirmed <= 6);
      assert.ok(session.snapshots.size <= 14);
      assert.ok(session.used.size <= 14);
    });
  }
  assert.ok(sessions.every((s) => s.frame === 180 && s.confirmed === 180));
  assert.ok(sessions.every((s) => s.stats.rollbacks > 0));
  for (const core of cores.slice(1))
    assert.deepEqual(core.save(), cores[0].save());
  assert.ok(sessions.every((s) => s.stats.checks === 3));
});

test("rollback requires matching local and server opt-in", () => {
  for (const [local, remote] of [
    [0, 4],
    [4, undefined],
    [4, 3],
  ]) {
    const link = new BridgeConnection(new Core(), new Socket(), {
      player: 0,
      players: 2,
      maxPrediction: local,
    });
    assert.throws(
      () =>
        link.receive(
          JSON.stringify({
            t: "start",
            f: 0,
            player: 0,
            players: 2,
            maxPrediction: remote,
          }),
        ),
      /Invalid relay session start/,
    );
    assert.equal(link.session, null);
  }
});

test("state requests wait for predicted frames to become confirmed", () => {
  const socket = new Socket();
  const core = new ReplayCore();
  const link = new BridgeConnection(core, socket, {
    player: 0,
    players: 2,
    maxPrediction: 3,
  });
  link.receive(
    JSON.stringify({
      t: "start",
      f: 0,
      player: 0,
      players: 2,
      maxPrediction: 3,
    }),
  );
  link.tick(0);
  link.tick(0);
  link.receive(JSON.stringify({ t: "state-request", f: 2 }));
  assert.equal(link.stateRequests.size, 1);
  assert.equal(
    socket.sent.some(
      (x) => typeof x === "string" && JSON.parse(x).t === "state",
    ),
    false,
  );
  link.receive(JSON.stringify({ t: "input", player: 1, f: 0, b: 7 }));
  link.receive(JSON.stringify({ t: "input", player: 1, f: 1, b: 8 }));
  link.session.paused = true;
  link.tick(0);
  const i = socket.sent.findIndex(
    (x) => typeof x === "string" && JSON.parse(x).t === "state",
  );
  assert.deepEqual(JSON.parse(socket.sent[i]), {
    t: "state",
    f: 2,
    size: core.size,
  });
  assert.deepEqual(socket.sent[i + 1], core.save());
  assert.equal(link.stateRequests.size, 0);
});

test("rollback settings and snapshot capacity are bounded", () => {
  for (const maxPrediction of [-1, 31, 0.5, true])
    assert.throws(() => predictedSession({ maxPrediction }), /settings/);
  const core = new Core();
  core.save = () => new Uint8Array(2 * 1024 * 1024);
  assert.throws(
    () => predictedSession({ core, maxPrediction: 30 }),
    /oversized/,
  );
});
