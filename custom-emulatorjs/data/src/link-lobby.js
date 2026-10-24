// Cartridge discovery uses the same room and socket as the running session.
export class LinkLobby {
  constructor(
    netplay,
    {
      romId,
      room = {},
      startLabel,
      seatLabel,
      chooseSeatLabel,
      seatHint,
      onReady,
      onError,
    },
  ) {
    this.netplay = netplay;
    this.previous = netplay.inputSession;
    this.cartridgeId = romId;
    this.gameId = `link:auto:${romId}`;
    this.onReady = onReady;
    this.onError = onError;
    this.manualStart = !!room.manualStart;
    this.maxPlayers = room.maxPlayers ?? 2;
    this.startLabel = startLabel;
    this.seatLabel = seatLabel;
    this.chooseSeatLabel = chooseSeatLabel;
    this.seatHint = seatHint;
    this.ready = false;
    this.joinedRoom = false;
    this.starting = false;
    this.stopped = false;
    netplay.inputSession = this;
  }

  prepare() {}

  joined() {
    this.joinedRoom = true;
    if (this.startedUsers) {
      this.started(this.startedUsers);
      return;
    }
    this.usersUpdated(this.netplay.players);
  }

  usersUpdated(users) {
    if (!this.joinedRoom || this.starting || this.stopped) return;
    if (this.manualStart) {
      this.netplay.owner = !!users[this.netplay.playerID]?.is_host;
      this.updateStartButton(users);
      return;
    }
    this.started(users);
  }

  updateStartButton(users) {
    if (!this.startButton && this.netplay._menuElement) {
      const controls = this.netplay.emu.createElement("div");
      controls.style.cssText =
        "display:inline-flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px;max-width:100%;padding-top:8px";
      const label = this.netplay.emu.createElement("label");
      label.textContent = this.seatLabel;
      const select = this.createSeatSelect();
      select.style.marginLeft = "8px";
      label.append(select);
      controls.append(label);
      const hint = this.netplay.emu.createElement("span");
      hint.textContent = this.seatHint;
      hint.style.cssText = "flex-basis:100%;font-size:12px";
      controls.append(hint);
      const button = this.netplay.emu.createElement("button");
      button.type = "button";
      button.className = "ejs_button_button";
      button.textContent = this.startLabel;
      button.addEventListener("click", () => this.start());
      controls.append(button);
      this.netplay.createButton.parentElement.append(controls);
      this.controls = controls;
      this.seatLabelElement = label;
      this.seatSelect = select;
      this.slotHint = hint;
      this.startButton = button;
    }
    if (!this.startButton) return;
    this.seatLabelElement.hidden = this.netplay.owner;
    const ownSlot = users[this.netplay.playerID]?.link_slot;
    this.seatSelect.value = Number.isInteger(ownSlot) ? String(ownSlot) : "";
    this.seatSelect.disabled =
      this.seatPending || this.pending || this.starting;
    for (const option of this.seatSelect.options) {
      option.disabled =
        option.value !== "" &&
        Object.entries(users).some(
          ([id, player]) =>
            id !== this.netplay.playerID &&
            player.link_slot === Number(option.value),
        );
    }
    this.updateHostSeats(users);
    this.slotHint.hidden = this.canStart(users);
    this.startButton.hidden = !this.netplay.owner || this.stopped;
    this.startButton.disabled =
      !this.canStart(users) || this.pending || this.starting;
  }

  createSeatSelect(playerId) {
    const select = this.netplay.emu.createElement("select");
    select.style.cssText =
      "padding:6px;min-height:44px;min-width:80px;max-width:100%;appearance:auto;border:1px solid currentColor;border-radius:4px;color-scheme:dark;background:rgba(0,0,0,.75)";
    const name = this.netplay.players[playerId]?.player_name;
    select.setAttribute(
      "aria-label",
      name ? `${name}: ${this.seatLabel}` : this.seatLabel,
    );
    for (let slot = -1; slot < this.maxPlayers; slot++) {
      const option = this.netplay.emu.createElement("option");
      option.value = slot < 0 ? "" : String(slot);
      option.textContent = slot < 0 ? this.chooseSeatLabel : `${slot + 1}P`;
      select.append(option);
    }
    select.addEventListener("change", () =>
      this.chooseSlot(
        select.value === "" ? null : Number(select.value),
        playerId,
      ),
    );
    return select;
  }

  updateHostSeats(users) {
    if (!this.netplay.owner || !this.netplay.playerTable) return;
    Object.entries(users).forEach(([id, player], index) => {
      const cell = this.netplay.playerTable.children[index]?.children[0];
      if (!cell) return;
      let select = cell.querySelector("select");
      if (!select) {
        select = this.createSeatSelect(id);
        cell.replaceChildren(select);
      }
      select.value = Number.isInteger(player.link_slot)
        ? String(player.link_slot)
        : "";
      select.disabled = this.seatPending || this.pending || this.starting;
    });
  }

  canStart(users) {
    const slots = Object.values(users)
      .map((player) => player.link_slot)
      .sort((a, b) => a - b);
    return (
      slots.length >= 2 &&
      slots.length <= this.maxPlayers &&
      slots.every((slot, index) => slot === index)
    );
  }

  chooseSlot(slot, playerId) {
    if (this.stopped || this.starting || this.seatPending || this.pending)
      return;
    this.seatPending = true;
    this.updateStartButton(this.netplay.players);
    const payload =
      playerId === undefined ? { slot } : { slot, player_id: playerId };
    this.netplay.socket.emit("link-seat", payload, (error) => {
      if (this.stopped) return;
      this.seatPending = false;
      this.updateStartButton(this.netplay.players);
      if (error) this.onError(new Error(error));
    });
  }

  start() {
    if (
      !this.netplay.owner ||
      !this.canStart(this.netplay.players) ||
      this.pending ||
      this.starting ||
      this.stopped
    )
      return;
    this.pending = true;
    this.updateStartButton(this.netplay.players);
    this.netplay.socket.emit("link-start", (error) => {
      if (this.stopped) return;
      this.pending = false;
      this.updateStartButton(this.netplay.players);
      if (error) this.onError(new Error(error));
    });
  }

  started(users) {
    if (!this.joinedRoom) {
      this.startedUsers = users;
      return;
    }
    if (this.starting || this.stopped) return;
    if (this.manualStart) {
      if (!this.canStart(users)) return;
      users = Object.fromEntries(
        Object.entries(users).sort((a, b) => a[1].link_slot - b[1].link_slot),
      );
    }
    const players = Object.values(users);
    if (players.length < 2 || players.length > this.maxPlayers) return;
    const roms = players.map((player) => player.cartridge?.id);
    if (!roms.every((id) => Number.isSafeInteger(id) && id > 0)) return;
    const role = Object.keys(users).indexOf(this.netplay.playerID);
    if (this.manualStart && role < 0) return;
    this.starting = true;
    this.controls?.remove();
    this.netplay.players = users;
    Promise.resolve(this.onReady(roms, Math.max(0, role))).catch((error) => {
      this.netplay.leaveRoom();
      this.onError(error);
    });
  }

  simulateInput(player, index, value) {
    this.netplay.emu.gameManager.functions.simulateInput(player, index, value);
  }

  stop() {
    this.stopped = true;
    this.controls?.remove();
    if (this.netplay.inputSession === this)
      this.netplay.inputSession = this.previous;
  }
}
