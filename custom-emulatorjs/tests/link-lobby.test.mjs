import test from "node:test";
import assert from "node:assert/strict";
import { LinkLobby } from "../data/src/link-lobby.js";

test("lobby discovers the joining player's cartridge without guessing or starting streaming", async () => {
  const ready = [];
  const inputs = [];
  const previous = {};
  const netplay = {
    inputSession: previous,
    players: { host: { cartridge: { id: 22 } } },
    emu: {
      gameManager: {
        functions: { simulateInput: (...args) => inputs.push(args) },
      },
    },
  };
  const lobby = new LinkLobby(netplay, {
    romId: 22,
    onReady: (pair) => ready.push(pair),
    onError: assert.fail,
  });
  lobby.joined();
  assert.equal(lobby.ready, false);
  assert.deepEqual(ready, []);
  lobby.simulateInput(0, 8, 1);
  assert.deepEqual(inputs, [[0, 8, 1]]);
  const players = { ...netplay.players, guest: { cartridge: { id: 21 } } };
  lobby.usersUpdated(players);
  lobby.usersUpdated(players);
  assert.deepEqual(ready, [[22, 21]]);
  lobby.stop();
  assert.equal(netplay.inputSession, previous);
});

test("lobby waits for join acknowledgement and ignores canceled or malformed participants", () => {
  const ready = [];
  const netplay = {
    players: {
      host: { cartridge: { id: 22 } },
      guest: { cartridge: { id: 21 } },
    },
  };
  const lobby = new LinkLobby(netplay, {
    romId: 21,
    onReady: (pair) => ready.push(pair),
    onError: assert.fail,
  });
  lobby.usersUpdated(netplay.players);
  assert.deepEqual(ready, []);
  lobby.stop();
  lobby.joined();
  assert.deepEqual(ready, []);
});

function element(tag) {
  return {
    style: {},
    options: [],
    events: {},
    children: [],
    querySelector() {
      return this.children.find((child) => child.tag === "select");
    },
    tag,
    replaceChildren(child) {
      this.children = [child];
    },
    setAttribute() {},
    append(child) {
      this.children.push(child);
      if (tag === "select") this.options.push(child);
    },
    addEventListener(type, fn) {
      this.events[type] = fn;
    },
    remove() {
      this.removed = true;
    },
  };
}

for (const count of [2, 3, 4])
  test(`GBA host starts ${count} selected seats independently of join order`, async () => {
    const ready = [];
    let ack;
    const users = Object.fromEntries(
      Array.from({ length: count }, (_, i) => [
        `p${i}`,
        { cartridge: { id: 20 + i }, is_host: i === 0 },
      ]),
    );
    const netplay = {
      playerID: "p0",
      players: { p0: users.p0 },
      _menuElement: {},
      createButton: { parentElement: element("div") },
      emu: { createElement: element },
      socket: {
        emit: (event, callback) => {
          assert.equal(event, "link-start");
          ack = callback;
        },
      },
    };
    const lobby = new LinkLobby(netplay, {
      romId: 20,
      room: { manualStart: true, maxPlayers: 4 },
      startLabel: "Start game",
      seatLabel: "Player slot",
      chooseSeatLabel: "Choose",
      seatHint: "Choose consecutive slots",
      onReady: (...args) => ready.push(args),
      onError: assert.fail,
    });
    lobby.joined();
    assert.equal(lobby.startButton.disabled, true);
    assert.equal(lobby.seatSelect.value, "");
    netplay.players = users;
    lobby.usersUpdated(users);
    assert.equal(lobby.startButton.disabled, true);
    Object.values(users).forEach((p, i) => (p.link_slot = count - 1 - i));
    lobby.usersUpdated(users);
    assert.equal(lobby.startButton.disabled, false);
    assert.equal(lobby.startButton.hidden, false);
    assert.equal(lobby.seatSelect.value, String(count - 1));
    assert.equal(lobby.seatSelect.options[1].disabled, true);
    lobby.startButton.events.click();
    assert.equal(lobby.startButton.disabled, true);
    lobby.started(users);
    ack(null);
    lobby.started(users);
    assert.deepEqual(ready, [
      [Array.from({ length: count }, (_, i) => 20 + count - 1 - i), count - 1],
    ]);
    assert.equal(lobby.controls.removed, true);
  });

test("GBA guest waits for host even if start arrives before the join acknowledgment", () => {
  const ready = [];
  const users = {
    host: { cartridge: { id: 20 }, link_slot: 2, is_host: true },
    guest: { cartridge: { id: 21 }, link_slot: 1 },
    third: { cartridge: { id: 22 }, link_slot: 0 },
  };
  const netplay = {
    playerID: "third",
    players: users,
    socket: { emit: assert.fail },
  };
  const lobby = new LinkLobby(netplay, {
    romId: 22,
    room: { manualStart: true, maxPlayers: 4 },
    onReady: (...args) => ready.push(args),
    onError: assert.fail,
  });
  lobby.start();
  lobby.started(users);
  assert.deepEqual(ready, []);
  lobby.joined();
  assert.deepEqual(ready, [[[22, 21, 20], 0]]);
});

test("a rejected slot claim restores the selected seat and guests cannot start", () => {
  let ack;
  const errors = [];
  const users = {
    host: { is_host: true, cartridge: { id: 20 }, link_slot: 0 },
    guest: { is_host: false, cartridge: { id: 21 } },
  };
  const netplay = {
    playerID: "guest",
    players: users,
    _menuElement: {},
    createButton: { parentElement: element("div") },
    emu: { createElement: element },
    socket: {
      emit: (event, payload, callback) => {
        assert.equal(event, "link-seat");
        assert.deepEqual(payload, { slot: 0 });
        ack = callback;
      },
    },
  };
  const lobby = new LinkLobby(netplay, {
    romId: 21,
    room: { manualStart: true, maxPlayers: 4 },
    onReady: assert.fail,
    onError: (error) => errors.push(error.message),
  });
  lobby.joined();
  lobby.start();
  assert.equal(lobby.startButton.hidden, true);
  lobby.chooseSlot(0);
  assert.equal(lobby.seatSelect.disabled, true);
  ack("This player slot is already taken");
  assert.equal(lobby.seatSelect.value, "");
  assert.equal(!!lobby.seatSelect.disabled, false);
  assert.deepEqual(errors, ["This player slot is already taken"]);
  users.guest.link_slot = 3;
  assert.equal(lobby.canStart(users), false);
  users.guest.link_slot = 1;
  assert.equal(lobby.canStart(users), true);
});

test("the host assigns another participant from the roster and guests see only their own selector", () => {
  const users = {
    host: {
      is_host: true,
      player_name: "Host",
      cartridge: { id: 20 },
      link_slot: 0,
    },
    guest: { player_name: "Guest", cartridge: { id: 21 }, link_slot: 1 },
  };
  const table = element("tbody");
  for (const _ of Object.keys(users)) {
    const row = element("tr");
    row.append(element("td"));
    table.append(row);
  }
  let ack;
  const netplay = {
    playerID: "host",
    players: users,
    playerTable: table,
    _menuElement: {},
    createButton: { parentElement: element("div") },
    emu: { createElement: element },
    socket: {
      emit(event, payload, callback) {
        assert.equal(event, "link-seat");
        assert.deepEqual(payload, { slot: 0, player_id: "guest" });
        ack = callback;
      },
    },
  };
  const lobby = new LinkLobby(netplay, {
    romId: 20,
    room: { manualStart: true, maxPlayers: 4 },
    onError: assert.fail,
  });
  lobby.joined();
  assert.equal(lobby.seatLabelElement.hidden, true);
  const guest = table.children[1].children[0].children[0];
  assert.equal(guest.value, "1");
  guest.value = "0";
  guest.events.change();
  assert.equal(guest.disabled, true);
  users.guest.link_slot = 0;
  users.host.link_slot = 1;
  lobby.usersUpdated(users);
  ack(null);
  assert.equal(guest.value, "0");
  assert.equal(!!guest.disabled, false);
  assert.equal(table.children[0].children[0].children[0].value, "1");
  netplay.playerID = "guest";
  lobby.usersUpdated(users);
  assert.equal(lobby.seatLabelElement.hidden, false);
  assert.equal(lobby.startButton.hidden, true);
});
