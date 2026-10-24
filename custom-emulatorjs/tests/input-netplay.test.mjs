import test from "node:test";
import assert from "node:assert/strict";
import { RollbackSession } from "../data/src/input-netplay.js";

class DeterministicCore {
  constructor() {
    this.value = new Uint32Array(4);
  }
  step(a, b) {
    this.value[0]++;
    this.value[1] = Math.imul(this.value[1] ^ a, 1664525) + b + 1013904223;
    this.value[2] += a;
    this.value[3] += b;
  }
  save() {
    return new Uint8Array(this.value.buffer).slice();
  }
  load(bytes) {
    new Uint8Array(this.value.buffer).set(bytes);
  }
}

const buttons = (player, frame) =>
  (frame * (player + 3)) % 23 < 9 ? 1 << (player ? 8 : 0) : 0;

test("two peers converge to an offline reference with delayed, reordered input", () => {
  const queue = [];
  let now = 0;
  const errors = [];
  const cores = [new DeterministicCore(), new DeterministicCore()];
  const sessions = cores.map(
    (core, player) =>
      new RollbackSession(core, {
        player,
        onError: (error) => errors.push(error),
        send: (packet) =>
          queue.push({
            at: now + ((packet.f * 7 + player) % 9) + 1,
            player: 1 - player,
            packet,
          }),
      }),
  );
  for (; now < 1200; now++) {
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].at <= now) {
        const item = queue.splice(i, 1)[0];
        sessions[item.player].receive(item.packet);
      }
    }
    for (let p = 0; p < 2; p++)
      if (sessions[p].frame < 600)
        sessions[p].tick(buttons(p, sessions[p].frame));
  }
  assert.deepEqual(errors, []);
  const reference = new DeterministicCore();
  for (let f = 0; f < 600; f++)
    reference.step(
      f < 2 ? 0 : buttons(0, f - 2),
      f < 2 ? 0 : buttons(1, f - 2),
    );
  for (let p = 0; p < 2; p++) {
    assert.equal(sessions[p].frame, 600);
    assert.deepEqual(cores[p].save(), reference.save());
    assert.ok(sessions[p].stats.rollbacks > 50);
    assert.equal(sessions[p].stats.checks, 10);
    assert.ok(sessions[p].snapshots.size <= 16);
  }
});

test("a missing peer stalls at a bounded prediction window without changing sampled input", () => {
  const sent = [];
  const session = new RollbackSession(new DeterministicCore(), {
    player: 0,
    send: (packet) => sent.push(packet),
  });
  for (let f = 0; f < 1000; f++) session.tick(f);
  assert.equal(session.frame, 14);
  assert.equal(sent.filter((p) => p.t === "input").length, 15);
  assert.ok(session.snapshots.size <= 16);
  const sampled = session.inputs[0].get(16);
  session.tick(65535);
  assert.equal(session.inputs[0].get(16), sampled);
});

test("a peer that starts late catches up without retaining a prediction-window delay", () => {
  const queues = [[], []],
    errors = [];
  const cores = [new DeterministicCore(), new DeterministicCore()];
  const sessions = cores.map(
    (core, player) =>
      new RollbackSession(core, {
        player,
        send: (packet) => queues[1 - player].push(packet),
        onError: (error) => errors.push(error),
      }),
  );
  for (let time = 0; time < 700; time++) {
    for (let p = 0; p < 2; p++) {
      if (p === 1 && time < 25) continue;
      for (const packet of queues[p].splice(0)) sessions[p].receive(packet);
      if (sessions[p].frame < 600)
        sessions[p].tick(buttons(p, sessions[p].frame));
    }
    if (time > 60)
      assert.ok(Math.abs(sessions[0].frame - sessions[1].frame) <= 3);
  }
  assert.deepEqual(errors, []);
  assert.ok(sessions[0].stats.pacing > 0);
  assert.ok(sessions.every((s) => s.frame === 600 && s.stats.checks === 10));
  const reference = new DeterministicCore();
  for (let f = 0; f < 600; f++)
    reference.step(
      f < 2 ? 0 : buttons(0, f - 2),
      f < 2 ? 0 : buttons(1, f - 2),
    );
  for (const core of cores) assert.deepEqual(core.save(), reference.save());
});

test("pacing corrects clock drift while allowing real network latency", () => {
  for (const delays of [
    [5, 5],
    [5, 9],
  ]) {
    let time = 0;
    const queue = [],
      errors = [];
    const cores = [new DeterministicCore(), new DeterministicCore()];
    const sessions = cores.map(
      (core, player) =>
        new RollbackSession(core, {
          player,
          send: (packet) =>
            queue.push({
              at: time + delays[player],
              player: 1 - player,
              packet,
            }),
          onError: (error) => errors.push(error),
        }),
    );
    for (; time < 1200; time++) {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].at <= time) {
          const item = queue.splice(i, 1)[0];
          sessions[item.player].receive(item.packet);
        }
      }
      for (let p = 0; p < 2; p++) {
        if (p === 1 && time % 37 === 0) continue;
        if (sessions[p].frame < 900)
          sessions[p].tick(buttons(p, sessions[p].frame));
      }
      if (time > 100)
        assert.ok(Math.abs(sessions[0].frame - sessions[1].frame) <= 6);
    }
    assert.deepEqual(errors, []);
    assert.ok(sessions[0].stats.pacing > 0);
    assert.ok(sessions.every((s) => s.frame === 900 && s.stats.checks === 15));
    assert.deepEqual(cores[0].save(), cores[1].save());
  }
});

test("contradictory input and out-of-range frames stop the session", () => {
  for (const packet of [
    { t: "input", f: 2, b: 2 },
    { t: "input", f: 100000, b: 0 },
    { t: "input", f: 3, b: -1 },
    { t: "input", f: 3, b: 0, a: 9999 },
    { t: "input", f: 3, b: 0, a: 1.5 },
  ]) {
    const errors = [];
    const session = new RollbackSession(new DeterministicCore(), {
      player: 0,
      send: () => {},
      onError: (e) => errors.push(e),
    });
    session.receive({ t: "input", f: 2, b: 1 });
    session.receive(packet);
    assert.equal(errors.length, 1);
    assert.equal(session.tick(0), false);
  }
});

test("a stalled peer accepts the other peer's delayed input at the prediction boundary", () => {
  const queues = [[], []],
    errors = [];
  const cores = [new DeterministicCore(), new DeterministicCore()];
  const sessions = cores.map(
    (core, player) =>
      new RollbackSession(core, {
        player,
        send: (packet) => queues[1 - player].push(packet),
        onError: (error) => errors.push(error),
      }),
  );
  const deliver = (player) => {
    for (const packet of queues[player].splice(0))
      sessions[player].receive(packet);
  };
  for (let i = 0; i < 100; i++) sessions[0].tick();
  deliver(1);
  for (let i = 0; i < 100; i++) sessions[1].tick();
  deliver(0);
  assert.deepEqual(errors, []);
  for (let i = 0; i < 240; i++) {
    for (let p = 0; p < 2; p++) {
      deliver(p);
      if (sessions[p].frame < 120) sessions[p].tick();
    }
  }
  assert.deepEqual(errors, []);
  assert.ok(sessions.every((s) => s.frame === 120 && s.stats.checks === 2));
  assert.deepEqual(cores[0].save(), cores[1].save());
});

test("a confirmed state mismatch stops emulation", () => {
  const errors = [];
  const session = new RollbackSession(new DeterministicCore(), {
    player: 0,
    send: () => {},
    onError: (e) => errors.push(e),
  });
  for (let f = 0; f < 60; f++) {
    session.receive({ t: "input", f: f + 2, b: 0 });
    session.tick(0);
  }
  session.receive({ t: "hash", f: 60, h: "00000000" });
  assert.match(errors[0].message, /State mismatch at frame 60/);
  assert.equal(session.stopped, true);
});

test("three and four direct peers converge with jitter, a late peer and clock drift", () => {
  for (const players of [3, 4]) {
    class MultiCore extends DeterministicCore {
      constructor() {
        super();
        this.value = new Uint32Array(players + 2);
      }
      stepPlayers(inputs) {
        this.value[0]++;
        inputs.forEach((input, p) => {
          this.value[1] =
            Math.imul(this.value[1] ^ input, 1664525) + p + 1013904223;
          this.value[p + 2] += input;
        });
      }
    }
    const cores = Array.from({ length: players }, () => new MultiCore());
    const queue = [],
      errors = [];
    let time = 0;
    const sessions = cores.map(
      (core, player) =>
        new RollbackSession(core, {
          player,
          players,
          onError: (error) => errors.push(error),
          send: (packet) => {
            for (let peer = 0; peer < players; peer++)
              if (peer !== player)
                queue.push({
                  at: time + 1 + ((packet.f + player * 3 + peer) % 7),
                  peer,
                  player,
                  packet,
                });
          },
        }),
    );
    for (; time < 1000; time++) {
      for (let i = queue.length - 1; i >= 0; i--)
        if (queue[i].at <= time) {
          const { peer, player, packet } = queue.splice(i, 1)[0];
          sessions[peer].receive(packet, player);
        }
      sessions.forEach((session, p) => {
        if (p === players - 1 && (time < 25 || time % 37 === 0)) return;
        if (session.frame < 600) session.tick(buttons(p, session.frame));
      });
    }
    assert.deepEqual(errors, []);
    const reference = new MultiCore();
    for (let f = 0; f < 600; f++)
      reference.stepPlayers(
        cores.map((_, p) => (f < 2 ? 0 : buttons(p, f - 2))),
      );
    cores.forEach((core, p) => {
      assert.equal(sessions[p].frame, 600);
      assert.equal(sessions[p].stats.checks, 10 * (players - 1));
      assert.deepEqual(core.save(), reference.save());
    });
    assert.ok(sessions.some((s) => s.stats.pacing > 0));
  }
});
