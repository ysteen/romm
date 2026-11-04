import { calibrateSameBoy } from "../data/src/bridge-calibration.js";
import {
  bridgeCore,
  bridgeCoreFor,
  bridgeBatteryId,
  bridgeSeed,
  bridgeSaveSelection,
} from "../data/src/bridge-profile.js?v=20261102";
import {
  BridgeConnection,
  crc32,
} from "../data/src/bridge-session.js?v=automatic-join-20261104";
import { installBridgeMenu } from "./bridge-menu.js?v=room-lifetime-20261104";
import { unpackRoomCartridge } from "./cartridge.js";
import { installNativeDownloads } from "./native-downloads.js?v=native-startup-20261102";
import {
  describeCartridge,
  assertCartridges,
  participantClient,
  encodeBattery,
} from "./room-content.js?v=native-host-20261103";
import { installPlayerScreen } from "./screen.js?v=20261021.10";

const elements = new Map(
  [...document.querySelectorAll("[id]")].map((element) => [
    element.id,
    element,
  ]),
);
const $ = (id) => elements.get(id);
let integration = {},
  updateMenu = () => {},
  gameVisible = false,
  screenView,
  cancelPlayerLoad;
function showRoom(open) {
  const playing = gameVisible && !!frame;
  const panel = $("room-panel");
  panel.hidden = playing && !open;
  $("close-room").hidden = !playing;
  $("close-game").hidden = !playing;
  $("close-game").disabled = !connection?.started;
  if (frame?.contentWindow) frame.contentWindow.localButtons = 0;
  updateMenu(
    !!frame?.contentWindow.EJS_emulator?.paused,
    playing,
    !panel.hidden,
    !!connection?.started,
  );
  if (open && playing) $("close-room").focus({ preventScroll: true });
  else if (panel.hidden)
    frame.contentWindow.EJS_emulator?.elements.parent.focus({
      preventScroll: true,
    });
}
function selectPlayerSeat(seat) {
  screenView?.select(profile.sharedSave ? 0 : seat);
  if (adapter && frame && profile.audioOption)
    frame.contentWindow.EJS_emulator.gameManager.setVariable(
      profile.audioOption,
      profile.audio[seat],
    );
}
function releaseEmulator() {
  gameVisible = false;
  cancelPlayerLoad?.();
  cancelPlayerLoad = null;
  tickerWindow?.clearInterval(ticker);
  clearInterval(autosave);
  window.bridgeAdapter = null;
  screenView?.destroy();
  screenView = null;
  frame?.contentWindow?.audioOutput?.destroy();
  document.body.append($("room-panel"));
  frame?.remove();
  frame = null;
  adapter = null;
  updateMenu = () => {};
  $("screen").hidden = true;
}
function releasePlayer() {
  room = null;
  lastLobby = null;
  connection?.stop();
  connection = null;
  window.bridgeConnection = null;
  releaseEmulator();
}
let rom, profile, coreCatalog, frame, adapter, connection, room;
let initialBattery, targetSave, lastSave, saving, pendingSave;
let nativeSession, nativePoll, lastLobby, nativeSaving;
let membership;
let nativeTicket, nativeTicketPoll;
let activeNativeAllowed = false;
const cartridgeCache = new Map();
const cartridgeNames = new Map();
const nativeSaved = new Map();
let ticker,
  tickerWindow,
  autosave,
  initialized = false;
const rooms = new Map();

function csrfHeaders() {
  const cookie = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("romm_csrftoken="));
  return {
    "x-csrftoken": cookie
      ? decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1))
      : "",
  };
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...csrfHeaders(),
      ...(options.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(
      typeof result?.detail === "string"
        ? result.detail
        : `Request failed (${response.status})`,
    );
  }
  return response.status === 204 ? null : response.json();
}

function status(text, error = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", error);
}

function fail(error) {
  releasePlayer();
  $("lobby").hidden = $("connection").hidden = $("disconnect").hidden = true;
  showRoom(true);
  status(error.message, true);
  $("setup").hidden = false;
  $("create").disabled = $("refresh").disabled = false;
  $("join").disabled = rooms.size === 0;
}

async function bytes(url) {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok)
    throw new Error(`Could not load game data (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

async function initialize({ romId, theme, resume, ...callbacks }) {
  integration = callbacks;
  if (initialized || !Number.isSafeInteger(romId) || romId <= 0) return;
  initialized = true;
  if (theme === "light" || theme === "dark")
    document.documentElement.style.colorScheme = theme;
  if (integration.labels?.back) $("back").textContent = integration.labels.back;
  try {
    rom = await api(`/roms/${romId}`);
    profile = bridgeCore(bridgeCoreFor(rom.platform_slug));
    const config = await api("/netplay/bridge/config");
    if (!config.enabled)
      throw new Error("Relay play is not enabled on this server");
    const response = await fetch("bridge-cores.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Relay core catalog is unavailable");
    coreCatalog = await response.json();
    for (const option of $("players").options)
      option.disabled = Number(option.value) > profile.maxPlayers;
    $("native").disabled = !coreCatalog[profile.core]?.native;
    $("native").checked = false;
    if (coreCatalog[profile.core]?.native) {
      $("native-details").hidden = false;
      await installNativeDownloads({
        catalog: coreCatalog[profile.core],
        select: $("native-platform"),
        download: $("core-download"),
        infoDownload: $("core-info-download"),
        infoHint: $("core-info-install"),
        hint: $("native-platform-hint"),
        instructions: $("core-build"),
      });
      $("native-game-load").hidden = profile.core !== "mgba_splitscreen";
    }
    if (resume?.stateId && !resume?.battery)
      throw new Error(
        "Save states cannot start this multiplayer core. Select an in-game save, or load the state in single-player first.",
      );
    const { selected, target } = bridgeSaveSelection(
      profile,
      rom.user_saves,
      resume?.saveId,
    );
    targetSave = target;
    initialBattery = resume?.battery
      ? new Uint8Array(resume.battery)
      : selected
        ? await bytes(selected.download_path)
        : new Uint8Array();
    cartridgeNames.set(rom.id, Promise.resolve(rom.name ?? rom.fs_name));
    $("selected-cartridge").textContent =
      `Your cartridge: ${rom.name ?? rom.fs_name}`;
    $("save-status").textContent = resume?.battery
      ? "Continuing current progress."
      : selected
        ? `Starting from: ${selected.file_name ?? selected.slot ?? "selected save"}`
        : "Starting without a save.";
    $("create").disabled = $("refresh").disabled = false;
    status("Create a room or join another player.");
    $("save-hint").textContent = profile.sharedSave
      ? "The room starts from the host's save. Shared progress saves to your own RomM account."
      : "Each participant keeps their own cartridge save in their RomM account.";
    $("play-hint").textContent = profile.sharedSave
      ? "SNES rooms support standard NTSC LoROM/HiROM cartridges. Both players share the screen and can use a keyboard, touch controls or a gamepad."
      : "Each participant controls their own screen. Select the game to use a keyboard, touch controls or a gamepad.";
    await refreshRooms();
  } catch (error) {
    fail(error);
  }
}

async function loadCartridges(ids, expected) {
  const contents = [],
    manifest = [];
  for (const id of ids) {
    let cached = cartridgeCache.get(id);
    if (!cached) {
      const item = id === rom.id ? rom : await api(`/roms/${id}`);
      const name =
        item.has_nested_single_file && item.files?.length === 1
          ? item.files[0].file_name
          : item.fs_name;
      const raw = await bytes(
        `/api/roms/${id}/content/${encodeURIComponent(name)}?purpose=play`,
      );
      const data = await unpackRoomCartridge(raw, profile);
      cached = { data, description: await describeCartridge(id, data) };
      cartridgeCache.set(id, cached);
    }
    contents.push(cached.data);
    manifest.push(cached.description);
  }
  if (expected) assertCartridges(expected, manifest);
  return { contents, manifest };
}

function updatePlayChoice() {
  const selected = room ?? rooms.get($("rooms").value);
  const allowed = room
    ? activeNativeAllowed
    : selected?.native_allowed && selected?.native_auth;
  const connected = !!room && !!connection && !connection.closed;
  const seat = lastLobby?.seats[connection?.player];
  const client = $("play-client").value;
  const needsWindowsPlatform =
    client === "windows" && !$("native-platform").value.startsWith("windows-");
  const joinedWeb = !!connection?.joinRequested;
  $("play-choice").hidden = !!nativeSession;
  $("play-client").querySelector('[value="windows"]').disabled = !allowed;
  $("play-client").disabled =
    !connected || !!nativeTicket || !!connection?.preparing;
  $("join-game").disabled =
    !connected ||
    !!connection?.preparing ||
    !Number.isInteger(seat) ||
    !client ||
    (client === "web" && joinedWeb) ||
    (client === "windows" && !allowed) ||
    needsWindowsPlatform;
  $("join-game").textContent = nativeTicket
    ? "Open launcher again"
    : client === "web" && joinedWeb
      ? "Joined in Web"
      : "Join game";
  $("join-game-help").textContent = nativeTicket
    ? "Waiting for the Windows launcher to connect…"
    : client === "web" && joinedWeb
      ? connection?.started
        ? "Playing in this browser."
        : "Joined in Web. Waiting for the host or current game state."
      : needsWindowsPlatform
        ? "Choose a Windows platform under Windows launcher & core setup below."
        : "Choose your player number and how to play, then select Join game.";
}

async function refreshRooms() {
  if (room && !connection?.closed) return;
  try {
    const previous = $("rooms").value;
    const listed = await api(`/netplay/bridge/rooms?rom_id=${rom.id}`);
    rooms.clear();
    $("rooms").replaceChildren(new Option("Choose a room", ""));
    for (const item of listed) {
      rooms.set(item.id, item);
      const option = new Option(
        `Room ${item.id.slice(0, 6)} · ${item.current}/${item.players} · ${item.started ? "Playing" : item.has_password ? "Password required" : "No password"}`,
        item.id,
      );
      option.disabled = item.current >= item.players;
      $("rooms").append(option);
    }
    const invited = new URLSearchParams(location.search).get("room");
    const selected = rooms.has(previous) ? previous : invited;
    if (selected && rooms.has(selected)) $("rooms").value = selected;
    updateJoin();
  } catch (error) {
    fail(error);
  }
}

function updateJoin() {
  const selected = rooms.get($("rooms").value);
  $("join").disabled = !selected || selected.current >= selected.players;
  $("join-password-label").hidden = !selected?.has_password;
  $("join-help").textContent = !selected
    ? "Choose an open room."
    : selected.has_password
      ? "Enter this room's password, not your RomM account password."
      : "No room password is required. Select Join room.";
  if (!selected?.has_password) $("join-password").value = "";
  if (selected?.started)
    $("join-help").textContent +=
      " Choose a player number and Web or Windows, then select Join game.";
  updatePlayChoice();
}

function renderLatency(members) {
  for (const member of members ?? []) {
    const label = $("participants").querySelector(
      `[data-ping-player="${Number(member.player)}"]`,
    );
    if (!label) continue;
    label.textContent = Number.isFinite(member.ping)
      ? `${member.ping} ms`
      : "Measuring…";
    label.title = "Round-trip time to the relay server";
  }
}

function renderLobby(value) {
  lastLobby = value;
  $("lobby").hidden = false;
  if (!gameVisible) showRoom(true);
  const ownPlayer = connection?.player ?? nativeSession?.player;
  const host = Number.isInteger(ownPlayer) && ownPlayer === value.host;
  const differentCartridges =
    value.collectCartridges &&
    value.contentPrepared &&
    value.members.some((member) => {
      const seat = value.seats[member.player];
      return (
        Number.isInteger(seat) &&
        value.cartridges?.[seat]?.romId !== member.romId
      );
    });
  $("start").hidden = !host || (value.running && !differentCartridges);
  $("start").disabled = !value.canStart;
  $("start").textContent = differentCartridges
    ? "Prepare new game"
    : "Start game";
  $("lobby-status").textContent = value.starting
    ? "Preparing the game…"
    : value.running
      ? differentCartridges
        ? "A different cartridge is waiting for the next game. The host can prepare a new game or remove that player."
        : "Game in progress. Select Join game to continue from the current state."
      : value.canStart
        ? host
          ? "Everyone is ready. You can start the game."
          : "Waiting for the host to start."
        : `${value.members.length}/${value.players} players in the room.`;
  if (!connection?.started)
    status(
      value.starting
        ? "Preparing the game…"
        : value.running
          ? "Game in progress."
          : "Waiting room",
    );
  const activePlayer =
    $("participants").ownerDocument.activeElement?.dataset.player;
  $("participants").replaceChildren();
  for (const member of value.members) {
    const row = document.createElement("li");
    const name = document.createElement("span");
    name.className = "member-name";
    name.textContent = `${member.nickname || (member.kind === "native" ? "RetroArch" : "Player")}${member.player === value.host ? " · Host" : ""}${member.player === ownPlayer ? " · You" : ""}`;
    const client = document.createElement("span");
    client.className = "member-client";
    client.textContent = participantClient(member);
    name.append(" ", client);
    const ping = document.createElement("span");
    ping.className = "member-ping";
    ping.dataset.pingPlayer = String(member.player);
    name.append(" ", ping);
    const game = document.createElement("span");
    game.className = "member-game";
    game.textContent = "Loading cartridge name…";
    if (!cartridgeNames.has(member.romId))
      cartridgeNames.set(
        member.romId,
        api(`/roms/${member.romId}`)
          .then((item) => item.name ?? item.fs_name)
          .catch(() => "Unavailable cartridge"),
      );
    void cartridgeNames.get(member.romId).then((title) => {
      game.textContent = `Cartridge: ${title}`;
    });
    name.append(game);
    const select = document.createElement("select");
    select.dataset.player = String(member.player);
    select.setAttribute(
      "aria-label",
      `Player number for ${member.nickname || "player"}`,
    );
    select.append(new Option("Not selected", ""));
    for (let seat = 0; seat < value.players; seat++) {
      const option = new Option(`P${seat + 1}`, String(seat));
      option.disabled =
        value.seats.includes(seat) && value.seats[member.player] !== seat;
      select.append(option);
    }
    select.value =
      value.seats[member.player] === null
        ? ""
        : String(value.seats[member.player]);
    select.disabled =
      value.starting ||
      (value.running && member.playing) ||
      (!host && member.player !== ownPlayer);
    select.onchange = () => {
      const seat = select.value === "" ? null : Number(select.value);
      if (connection && !nativeSession)
        connection.assignPlayer(member.player, seat);
      else void nativeControl("assign", { player: member.player, seat });
    };
    const readiness = document.createElement("span");
    readiness.className = "member-state";
    readiness.textContent = member.playing
      ? "Playing"
      : member.ready
        ? "Ready"
        : member.kind === "preparing"
          ? "Preparing…"
          : member.kind === "web"
            ? "Waiting for game"
            : "Connecting…";
    row.append(name, select, readiness);
    if (host && member.player !== ownPlayer) {
      const remove = document.createElement("button");
      remove.textContent = "Remove";
      remove.setAttribute(
        "aria-label",
        `Remove ${member.nickname || "player"} from room`,
      );
      remove.onclick = () =>
        connection && !nativeSession
          ? connection.removePlayer(member.player)
          : void nativeControl("kick", { player: member.player });
      row.append(remove);
    }
    $("participants").append(row);
    if (activePlayer === String(member.player)) select.focus();
  }
  renderLatency(value.members);
  updatePlayChoice();
}

async function boot(players, nativeAllowed, contents, keepRoom = false) {
  if (keepRoom) releaseEmulator();
  else releasePlayer();
  profile = bridgeCore(profile.core, players);
  const build = coreCatalog[profile.core]?.[nativeAllowed ? "native" : "web"];
  if (!build)
    throw new Error(
      "This core build is unavailable for the selected connection",
    );
  status("Loading the game…");
  const playerFrame = document.createElement("iframe");
  playerFrame.title = rom.name ?? rom.fs_name;
  playerFrame.allow = "autoplay; gamepad; fullscreen";
  const cancelled = new Promise((_, reject) => {
    cancelPlayerLoad = () => reject(new Error("The game was closed"));
  });
  cancelled.catch(() => {});
  const loaded = new Promise((resolve, reject) => {
    playerFrame.onload = resolve;
    playerFrame.onerror = () => reject(new Error("Could not load the player"));
  });
  playerFrame.src = "player.html?v=native-host-20261103";
  frame = playerFrame;
  $("screen").replaceChildren(playerFrame);
  await Promise.race([loaded, cancelled]);
  if (frame !== playerFrame) throw new Error("The room has closed");
  // A background tab may deny a wake lock. Emulation can continue without it.
  const wakeLock = frame.contentWindow.navigator.wakeLock;
  if (wakeLock) {
    const request = wakeLock.request.bind(wakeLock);
    wakeLock.request = (...args) => {
      const pending = request(...args);
      pending.catch(() => {});
      return pending;
    };
  }
  const paths = build.paths
    ? Object.fromEntries(
        Object.entries(build.paths).map(([name, path]) => [
          name,
          new URL(path, location.href).href,
        ]),
      )
    : undefined;
  const loadedAdapter = await Promise.race([
    cancelled,
    frame.contentWindow.boot(
      contents,
      {
        ...profile.options,
        ...build.options,
      },
      {
        core: profile.core,
        profile,
        paths,
        waitForCoreInitialization: !!build.waitForCoreInitialization,
        onNetplay: () => showRoom(true),
        bufferAudio: true,
        language: integration.language,
        buttons: {
          saveState: false,
          loadState: false,
          loadSavFiles: false,
          restart: false,
          exitEmulation: true,
          saveSavFiles: {
            displayName: integration.labels?.save ?? "Sync save",
          },
          pause: { displayName: integration.labels?.pause ?? "Pause" },
          play: { displayName: integration.labels?.resume ?? "Resume" },
          netplay: { displayName: integration.labels?.netplay ?? "Netplay" },
        },
      },
    ),
  ]);
  if (frame !== playerFrame) throw new Error("The room has closed");
  adapter = loadedAdapter;
  window.bridgeAdapter = adapter;
  const emulator = frame.contentWindow.EJS_emulator;
  frame.contentDocument.body.classList.add("romm-player");
  const style = frame.contentDocument.createElement("link");
  style.rel = "stylesheet";
  style.href = new URL("bridge.css?v=room-ui-20261104", location.href).href;
  frame.contentDocument.head.append(style);
  frame.contentDocument.documentElement.style.colorScheme =
    document.documentElement.style.colorScheme;
  updateMenu = installBridgeMenu(emulator, {
    panel: $("room-panel"),
    showRoom,
    pause: (paused) => {
      if (connection?.started) connection.pause(paused);
    },
    save: () => save().catch(saveError),
    closeGame,
  });
  updateMenu(false, false, true);
  $("screen").hidden = false;
  const screen = (screenView = installPlayerScreen(emulator, profile));
  const actualRom = emulator.gameManager.FS.readFile("/" + emulator.fileName);
  return { build, screen, contentCrc: crc32(actualRom) };
}

async function launch(joinId) {
  try {
    $("create").disabled = $("join").disabled = $("refresh").disabled = true;
    await save();
    const selected = joinId ? rooms.get(joinId) : null;
    if (joinId && !selected) throw new Error("Choose an open room");
    const players = selected?.players ?? Number($("players").value);
    const nativeAllowed = selected?.native_allowed ?? $("native").checked;
    status("Loading game…");
    const collectCartridges =
      selected?.collect_cartridges ??
      ["sameboy", "mgba_splitscreen"].includes(profile.core);
    const own = (await loadCartridges([rom.id])).manifest[0];
    let build = coreCatalog[profile.core]?.[nativeAllowed ? "native" : "web"];
    let loaded;
    let contentCrc = own.crc32;
    activeNativeAllowed = nativeAllowed;
    if (collectCartridges) {
      profile = bridgeCore(profile.core, players);
    } else {
      const ids =
        selected?.cartridges?.map((item) => item.romId) ??
        Array(profile.standardGame ? 1 : players).fill(rom.id);
      loaded = await loadCartridges(ids, selected?.cartridges);
      ({ build, contentCrc } = await boot(
        players,
        nativeAllowed,
        loaded.contents,
      ));
      if (contentCrc !== loaded.manifest[0].crc32)
        throw new Error("The loaded cartridge differs from the room manifest");
      if (
        selected &&
        (selected.state_size !== adapter.size ||
          selected.core_version !== build.coreVersion ||
          (selected.max_prediction ?? 0) !== (build.maxPrediction ?? 0) ||
          selected.content_crc !== contentCrc)
      )
        throw new Error("The room uses a different core build or cartridge");
    }
    const body = joinId
      ? { rom_id: rom.id, password: $("join-password").value, cartridge: own }
      : {
          rom_id: rom.id,
          system: profile.system,
          coreName: build.coreName,
          coreVersion: build.coreVersion,
          contentCrc,
          stateSize: adapter?.size ?? 1,
          players,
          nativeAllowed,
          password: $("create-password").value,
          maxPrediction: build.maxPrediction ?? 0,
          collectCartridges,
          cartridges: collectCartridges
            ? Array(players).fill(own)
            : loaded.manifest,
          ...(build.nativeCalibration
            ? { nativeCalibration: build.nativeCalibration }
            : {}),
        };
    room = await api(
      joinId
        ? `/netplay/bridge/rooms/${encodeURIComponent(joinId)}/join`
        : "/netplay/bridge/rooms",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
    membership = room.id;
    const player = room.player ?? 0;
    selectPlayerSeat(player);
    const socketUrl = new URL(room.websocket_url, location.href);
    socketUrl.searchParams.set("manualJoin", "1");
    socketUrl.searchParams.set("retainRoom", "1");
    const socket = new WebSocket(socketUrl.href);
    connection = new BridgeConnection(adapter, socket, {
      player,
      players,
      battery: bridgeSeed(profile, player, initialBattery),
      maxPrediction: build.maxPrediction ?? 0,
      manualJoin: true,
      calibrate:
        build.nativeCalibration === "sameboy-v1" ? calibrateSameBoy : null,
      onStatus(value) {
        if (value === "game-reset") {
          clearNativeSession();
          initialBattery = connection.battery?.slice() ?? initialBattery;
          updatePlayChoice();
          status(
            "The host is preparing a new game. Choose how to play and select Join game.",
          );
          return;
        }
        if (value === "game-closed") {
          releaseEmulator();
          if (!connection.nativeMode) clearNativeSession();
          showRoom(true);
          updatePlayChoice();
          status("Game closed. You are still in the room.");
          return;
        }
        if (value === "connected") {
          $("lobby").hidden = false;
          const firstStart = !gameVisible;
          gameVisible = true;
          if (firstStart) showRoom(false);
        }
        status(
          value === "connected"
            ? `Connected · P${connection.seats[player] + 1}`
            : value === "waiting"
              ? "Waiting for all players…"
              : value,
        );
        updateMenu(
          value === "paused",
          gameVisible,
          !$("room-panel").hidden,
          !!connection?.started,
        );
        if (value === "paused") {
          frame?.contentWindow.audioOutput?.flush();
          frame?.contentWindow.EJS_emulator?.displayMessage("Paused");
        }
        if (value === "stopped") {
          gameVisible = false;
          tickerWindow?.clearInterval(ticker);
          clearInterval(autosave);
          frame?.contentWindow.audioOutput?.flush();
          showRoom(true);
        }
      },
      onContent: async (packet) => {
        const current = connection;
        const prepared = await loadCartridges(
          packet.cartridges.map((item) => item.romId),
          packet.cartridges,
        );
        if (current?.closed || current !== connection)
          throw new Error("The room has closed");
        const result = await boot(
          players,
          nativeAllowed,
          prepared.contents,
          true,
        );
        if (current.closed || current !== connection)
          throw new Error("The room has closed");
        if (
          result.build.coreVersion !== packet.coreVersion ||
          result.contentCrc !== packet.contentCrc
        )
          throw new Error(
            "The prepared core or cartridge differs from the room",
          );
        selectPlayerSeat(connection.seats[player]);
        startPlayerLoop();
        showRoom(true);
        return adapter;
      },
      onLobby: renderLobby,
      onLatency: renderLatency,
      onRestart() {
        frame?.contentWindow.audioOutput.flush();
        if (frame) frame.contentWindow.localButtons = 0;
      },
      onSeats: selectPlayerSeat,
      onActionError: (message) => status(message, true),
      onError: fail,
      onHandoff: (retained) => {
        if (retained) releaseEmulator();
        else releasePlayer();
        showRoom(true);
        status("Continuing in Windows RetroArch…");
      },
    });
    window.bridgeConnection = connection;
    $("setup").hidden = true;
    $("disconnect").hidden = false;
    $("connection").hidden = false;
    $("address").textContent = room.native_port
      ? `RetroArch host address: ${room.native_host}|${room.native_port}`
      : `Web room: ${room.id}`;
    $("password").textContent = room.password
      ? `Room password: ${room.password}`
      : "";
    const invite = new URL("bridge.html", location.href);
    invite.searchParams.set("romId", String(rom.id));
    invite.searchParams.set("room", room.id);
    invite.searchParams.set("v", "native-host-20261103");
    $("room-link").href = invite.href;
    $("room-link").textContent = "Open room invitation";
    $("core-info").textContent = nativeAllowed
      ? `${build.coreName} ${build.coreVersion}. Choose Windows RetroArch and Join game to load the room's cartridges in order and connect.`
      : "Share this invitation with the other players.";
    if (frame) startPlayerLoop();
    showRoom(true);
    updatePlayChoice();
  } catch (error) {
    fail(error);
  }
}

function startPlayerLoop() {
  let next = performance.now();
  tickerWindow = frame.contentWindow;
  ticker = tickerWindow.setInterval(() => {
    if (!connection || !frame) return;
    const now = performance.now();
    if (now - next > 200) next = now;
    try {
      for (let steps = 0; steps < 3 && performance.now() >= next; steps++) {
        if (
          !connection.tick(
            $("room-panel").hidden ? frame.contentWindow.localButtons || 0 : 0,
          )
        ) {
          next = performance.now();
          break;
        }
        next += 1000 / profile.frameRate;
        if (performance.now() - now >= 8) break;
      }
    } catch (error) {
      fail(error);
    }
  }, 4);
  autosave = setInterval(() => {
    if (connection?.started) void save().catch(saveError);
  }, 15000);
  frame.contentWindow.selectPlayer = () =>
    frame.contentWindow.audioOutput.setActive(true);
  frame.contentWindow.addEventListener(
    "focus",
    frame.contentWindow.selectPlayer,
  );
  frame.contentWindow.addEventListener("blur", () => {
    if (!frame) return;
    frame.contentWindow.localButtons = 0;
    frame.contentWindow.audioOutput.setActive(false);
  });
  frame.contentWindow.audioOutput.setActive(true);
}

function ownBattery() {
  if (!connection?.started) return null;
  const id = bridgeBatteryId(profile, connection.seats[connection.player]);
  return connection.session?.maxPrediction
    ? connection.session.confirmedMemory(id)
    : adapter.memory(id);
}

function saveError(error) {
  $("save-status").textContent = `Could not save: ${error.message}`;
  $("save-status").classList.add("error");
  if (gameVisible)
    frame?.contentWindow.EJS_emulator?.displayMessage(
      "Could not sync save. Open Netplay for details.",
    );
  else showRoom(true);
}

async function save() {
  const latest = ownBattery();
  if (latest?.length) pendingSave = latest.slice();
  if (saving) return saving.then(() => save());
  await saveNativeProgress();
  const data = pendingSave;
  if (
    !data?.length ||
    (lastSave?.length === data.length &&
      data.every((b, i) => b === lastSave[i]))
  )
    return;
  const form = new FormData();
  form.append(
    "saveFile",
    new Blob([data]),
    targetSave?.file_name ?? `${rom.fs_name_no_ext}.srm`,
  );
  const query = new URLSearchParams({
    rom_id: String(rom.id),
    emulator: profile.core,
    slot: profile.saveSlot,
  });
  saving = api(targetSave ? `/saves/${targetSave.id}` : `/saves?${query}`, {
    method: targetSave ? "PUT" : "POST",
    body: form,
  })
    .then((uploaded) => {
      targetSave = uploaded;
      lastSave = data;
      initialBattery = data.slice();
      if (pendingSave === data) pendingSave = null;
      $("save-status").textContent = "Progress saved.";
      $("save-status").classList.remove("error");
      frame?.contentWindow?.EJS_emulator?.displayMessage("Progress saved.");
    })
    .finally(() => {
      saving = null;
    });
  return saving;
}

async function saveNativeProgress() {
  if (nativeSaving) return nativeSaving;
  if (
    !connection?.started ||
    connection.player !== (lastLobby?.saveHost ?? connection.host) ||
    !lastLobby ||
    !room
  )
    return;
  const currentRoom = room.id;
  const generation = connection.generation;
  const confirmed = connection.session?.confirmed ?? 0;
  const snapshots = [];
  for (const member of lastLobby.members) {
    if (member.kind !== "native" || !member.playing || !member.owner) continue;
    const id = bridgeBatteryId(profile, connection.seats[member.player]);
    const data = connection.session?.maxPrediction
      ? connection.session.confirmedMemory(id)
      : adapter.memory(id).slice();
    if (!data?.length) continue;
    const encoded = encodeBattery(data);
    const key = `${currentRoom}:${generation}:${member.player}:${member.owner}`;
    if (nativeSaved.get(key) === encoded) continue;
    snapshots.push({
      key,
      encoded,
      player: member.player,
      owner: member.owner,
    });
  }
  nativeSaving = (async () => {
    for (const item of snapshots) {
      await api(`/netplay/bridge/rooms/${currentRoom}/native/saves`, {
        method: "POST",
        body: JSON.stringify({
          player: item.player,
          owner: item.owner,
          generation,
          frame: confirmed,
          battery: item.encoded,
        }),
      });
      nativeSaved.set(item.key, item.encoded);
    }
  })().finally(() => {
    nativeSaving = null;
  });
  return nativeSaving;
}

async function pollNativeRoom() {
  clearTimeout(nativePoll);
  if (!nativeSession) return;
  const session = nativeSession;
  try {
    const listed = await api(`/netplay/bridge/rooms?rom_id=${rom.id}`);
    if (nativeSession !== session) return;
    const current = listed.find((item) => item.id === session.id);
    const member = current?.members.find(
      (item) => item.player === session.player,
    );
    if (!member) {
      clearTimeout(nativePoll);
      nativeSession = null;
      $("native-session").hidden = $("lobby").hidden = true;
      $("setup").hidden = false;
      $("native-status").textContent =
        "The Windows session ended or preparation expired. You can prepare again.";
      await refreshRooms();
      return;
    }
    if (member.kind === "web" && connection && !connection.nativeMode) {
      clearNativeSession();
      renderLobby({
        ...current,
        contentPrepared: current.content_prepared,
        collectCartridges: current.collect_cartridges,
        canStart: current.can_start,
      });
      showRoom(true);
      status("Windows game closed. You are still in the room.");
      return;
    }
    $("native-cancel").hidden = member.kind === "native";
    $("native-status").textContent = member.playing
      ? "Playing in Windows RetroArch. Keep this room open to stay connected."
      : current.running
        ? "Waiting for the current game state. A different cartridge stays in the room until the host prepares a new game."
        : current.host === session.player
          ? "You are the host. Start when everyone has joined and chosen a player number."
          : member.ready
            ? "Windows RetroArch is connected. Choose a number and wait for the host to start."
            : "The Windows launcher is preparing RetroArch. Choose your player number; the host starts the game.";
    if (
      member.playing &&
      current.native_authority &&
      current.save_host === null
    )
      $("native-status").textContent +=
        " Automatic RomM save uploads require a playing web participant.";
    renderLobby({
      ...current,
      contentPrepared: current.content_prepared,
      collectCartridges: current.collect_cartridges,
      running: current.running,
      starting: current.starting,
      canStart: current.can_start,
      saveHost: current.save_host,
    });
  } catch (error) {
    $("native-status").textContent = error.message;
  }
  if (nativeSession === session) {
    clearTimeout(nativePoll);
    nativePoll = setTimeout(pollNativeRoom, 2000);
  }
}

async function nativeControl(action, fields = {}) {
  if (!nativeSession) return;
  try {
    await api(`/netplay/bridge/rooms/${nativeSession.id}/control`, {
      method: "POST",
      body: JSON.stringify({ action, ...fields }),
    });
    await pollNativeRoom();
  } catch (error) {
    status(error.message, true);
  }
}

async function pollNativeTicket() {
  const pending = nativeTicket;
  if (!pending) return;
  try {
    const result = await api(
      `/netplay/bridge/rooms/${pending.id}/native/ticket`,
      {
        headers: { "X-Netplay-Launch": pending.ticket },
      },
    );
    if (nativeTicket !== pending) return;
    if (result.session) {
      nativeSession = result.session;
      nativeTicket = null;
      if (connection && !connection.closed) releaseEmulator();
      else releasePlayer();
      $("setup").hidden = true;
      $("native-session").hidden = false;
      $("disconnect").hidden = false;
      $("native-credentials").textContent =
        `Manual connection: ${nativeSession.native_host}|${nativeSession.native_port} · Personal connection password: ${nativeSession.native_password}`;
      updatePlayChoice();
      await pollNativeRoom();
      return;
    }
  } catch (error) {
    if (nativeTicket !== pending) return;
    nativeTicket = null;
    $("native-status").textContent = error.message;
    updatePlayChoice();
    return;
  }
  if (nativeTicket === pending)
    nativeTicketPoll = setTimeout(pollNativeTicket, 1000);
}

function openNativeLauncher(url) {
  const link = document.createElement("a");
  link.href = url;
  document.body.append(link);
  link.click();
  link.remove();
}

async function prepareNative() {
  const target = room;
  if (!target || !connection || connection.closed) return;
  if (nativeTicket) {
    openNativeLauncher(nativeTicket.launch_url);
    return;
  }
  $("join-game").disabled = true;
  try {
    await save();
    const own = (await loadCartridges([rom.id])).manifest[0];
    const battery = ownBattery() ?? initialBattery;
    const current = await api(
      `/netplay/bridge/rooms/${target.id}/native/ticket`,
      {
        method: "POST",
        body: JSON.stringify({
          rom_id: rom.id,
          cartridge: own,
          platform: $("native-platform").value,
          password: room?.password ?? $("join-password").value,
          battery: encodeBattery(battery),
        }),
      },
    );
    clearTimeout(nativeTicketPoll);
    nativeTicket = { ...current, id: target.id };
    $("native-status").textContent =
      "Opening the Windows launcher. If nothing opens, download and register the launcher once, then select Join game again.";
    openNativeLauncher(current.launch_url);
    void pollNativeTicket();
  } catch (error) {
    status(error.message, true);
  } finally {
    updatePlayChoice();
  }
}

$("create").onclick = () => launch();
$("join").onclick = () => launch($("rooms").value);
$("refresh").onclick = refreshRooms;
$("rooms").onchange = updateJoin;
$("join-game").onclick = () => {
  if ($("join-game").disabled) return;
  if ($("play-client").value === "windows") void prepareNative();
  else {
    connection?.openGame();
    updatePlayChoice();
  }
};
$("play-client").addEventListener("change", updatePlayChoice);
$("native-platform").addEventListener("change", updatePlayChoice);
$("native-cancel").onclick = async () => {
  try {
    await api(`/netplay/bridge/rooms/${nativeSession.id}/native`, {
      method: "DELETE",
      headers: { "X-Netplay-Launch": nativeSession.credential },
    });
    clearTimeout(nativePoll);
    await pollNativeRoom();
  } catch (error) {
    status(error.message, true);
  }
};
$("start").onclick = () => {
  if (connection && !nativeSession) connection.startGame();
  else void nativeControl("start");
};
$("join-password").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !$("join").disabled) {
    event.preventDefault();
    $("join").click();
  }
});
$("copy-room").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("room-link").href);
    status("Room invitation copied.");
  } catch {
    status("Open the room invitation and copy its address.");
  }
};
$("disconnect").onclick = async () => {
  $("disconnect").disabled = true;
  try {
    await save();
    await leaveMembership();
    releasePlayer();
    $("lobby").hidden = $("connection").hidden = $("disconnect").hidden = true;
    $("setup").hidden = false;
    $("create").disabled = $("refresh").disabled = false;
    showRoom(true);
    void refreshRooms();
  } catch (error) {
    saveError(error);
  } finally {
    $("disconnect").disabled = false;
  }
};
async function leave() {
  try {
    await save();
    await leaveMembership();
    nativeTicket = null;
    clearTimeout(nativeTicketPoll);
    releasePlayer();
    if (integration.onExit) integration.onExit();
    else location.assign(`/rom/${rom.id}/ejs`);
  } catch (error) {
    saveError(error);
  }
}
function clearNativeSession() {
  clearTimeout(nativePoll);
  clearTimeout(nativeTicketPoll);
  nativeSession = nativeTicket = null;
  $("native-session").hidden = true;
  $("native-credentials").textContent = "";
  $("native-status").textContent = "";
}

async function closeGame() {
  try {
    await save();
    connection?.closeGame();
    initialBattery = connection?.battery?.slice() ?? initialBattery;
  } catch (error) {
    saveError(error);
  }
}
$("back").onclick = leave;
$("close-game").onclick = closeGame;
$("close-room").onclick = () => showRoom(false);
$("room-panel").addEventListener("keydown", (event) => {
  event.stopPropagation();
  if (event.key === "Escape" && gameVisible) {
    event.preventDefault();
    event.stopPropagation();
    showRoom(false);
  }
});
$("room-panel").addEventListener("keyup", (event) => event.stopPropagation());
async function leaveMembership() {
  const id = membership ?? nativeSession?.id;
  const session = nativeSession;
  nativeTicket = null;
  clearTimeout(nativePoll);
  clearTimeout(nativeTicketPoll);
  if (id)
    await api(`/netplay/bridge/rooms/${id}/membership`, {
      method: "DELETE",
      keepalive: true,
    });
  if (membership === id) membership = null;
  if (nativeSession === session) nativeSession = null;
}
function destroy() {
  void leaveMembership().catch(() => {});
  releasePlayer();
}
window.addEventListener("pagehide", destroy);
window.addEventListener("message", (event) => {
  if (
    event.origin !== location.origin ||
    event.source !== window.opener ||
    event.data?.type !== "romm-bridge-init"
  )
    return;
  void initialize(event.data);
});
window.bridgePlayer = { initialize, save, destroy };
window.opener?.postMessage({ type: "romm-bridge-ready" }, location.origin);
const romId = Number(new URLSearchParams(location.search).get("romId"));
if (romId > 0) void initialize({ romId });
