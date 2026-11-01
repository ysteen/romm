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
} from "../data/src/bridge-session.js?v=lifecycle-20261102";
import { installBridgeMenu } from "./bridge-menu.js?v=20261102";
import { installNativeDownloads } from "./native-downloads.js?v=20261101";
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
  screenView;
function showRoom(open) {
  const panel = $("room-panel");
  panel.hidden = !open;
  $("close-room").hidden = !connection?.started;
  if (frame?.contentWindow) frame.contentWindow.localButtons = 0;
  if (open) (connection?.started ? $("close-room") : $("create")).focus();
  else
    frame?.contentWindow.EJS_emulator.elements.parent.focus({
      preventScroll: true,
    });
}
function releasePlayer() {
  clearInterval(ticker);
  clearInterval(autosave);
  room = null;
  connection?.stop();
  connection = null;
  window.bridgeConnection = null;
  window.bridgeAdapter = null;
  screenView?.destroy();
  frame?.contentWindow.audioOutput?.destroy();
  document.body.append($("room-panel"));
  frame?.remove();
  frame = null;
  adapter = null;
  updateMenu = () => {};
  $("screen").hidden = true;
}
let rom, profile, coreCatalog, frame, adapter, connection, room;
let cartridge, initialBattery, targetSave, lastSave, saving;
let ticker,
  autosave,
  closed = false,
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
  if (integration.labels?.resume)
    $("close-room").textContent = integration.labels.resume;
  try {
    rom = await api(`/roms/${romId}`);
    profile = bridgeCore(bridgeCoreFor(rom.platform_slug));
    const config = await api("/netplay/bridge/config");
    if (!config.enabled)
      throw new Error("Relay play is not enabled on this server");
    const response = await fetch("bridge-cores.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Relay core catalog is unavailable");
    coreCatalog = await response.json();
    $("title").textContent = rom.name ?? rom.fs_name;
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
        hint: $("native-platform-hint"),
        instructions: $("core-build"),
      });
    }
    const nested =
      rom.has_nested_single_file && rom.files?.length === 1
        ? rom.files[0].file_name
        : rom.fs_name;
    cartridge = await bytes(
      `/api/roms/${rom.id}/content/${encodeURIComponent(nested)}?purpose=play`,
    );
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
      " The current game continues until the host restarts for you.";
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
  $("lobby").hidden = false;
  if (!connection.started) showRoom(true);
  const host = connection.player === value.host;
  $("start").hidden = !host;
  $("start").disabled = !value.canStart;
  $("start").textContent = value.running
    ? "Restart game for waiting players"
    : "Start game";
  $("lobby-status").textContent = value.starting
    ? "Preparing the game…"
    : value.running
      ? "The game continues. The host can restart once waiting players choose their numbers."
      : value.canStart
        ? host
          ? "Everyone has a number. Start when you are ready."
          : "Waiting for the host to start."
        : `${value.members.length}/${value.players} connected. Every player must choose a number.`;
  if (!connection.started)
    status(value.starting ? "Preparing the game…" : "Waiting room");
  const activePlayer =
    $("participants").ownerDocument.activeElement?.dataset.player;
  $("participants").replaceChildren();
  for (const member of value.members) {
    const row = document.createElement("li");
    const name = document.createElement("span");
    name.className = "member-name";
    name.textContent = `${member.nickname || (member.kind === "native" ? "RetroArch" : "Player")}${member.player === value.host ? " · Host" : ""}${member.player === connection.player ? " · You" : ""}`;
    const ping = document.createElement("span");
    ping.className = "member-ping";
    ping.dataset.pingPlayer = String(member.player);
    name.append(" ", ping);
    const select = document.createElement("select");
    select.dataset.player = String(member.player);
    select.setAttribute("aria-label", `Player number for ${name.textContent}`);
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
      (!host && member.player !== connection.player);
    select.onchange = () =>
      connection.assignPlayer(
        member.player,
        select.value === "" ? null : Number(select.value),
      );
    const readiness = document.createElement("span");
    readiness.textContent = member.playing
      ? "Playing"
      : member.ready
        ? "Ready"
        : "Connecting…";
    row.append(name, select, readiness);
    $("participants").append(row);
    if (activePlayer === String(member.player)) select.focus();
  }
  renderLatency(value.members);
}

async function boot(players, nativeAllowed) {
  releasePlayer();
  profile = bridgeCore(profile.core, players);
  const build = coreCatalog[profile.core]?.[nativeAllowed ? "native" : "web"];
  if (!build)
    throw new Error(
      "This core build is unavailable for the selected connection",
    );
  frame = document.createElement("iframe");
  frame.title = profile.standardGame
    ? "Multiplayer game"
    : "Linked game consoles";
  frame.allow = "autoplay; gamepad; fullscreen";
  const loaded = new Promise((resolve, reject) => {
    frame.onload = resolve;
    frame.onerror = () => reject(new Error("Could not open player"));
  });
  frame.src = "player.html?v=player-20261102";
  $("screen").replaceChildren(frame);
  await loaded;
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
  adapter = await frame.contentWindow.boot(
    Array(profile.standardGame ? 1 : players).fill(cartridge),
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
        saveSavFiles: { displayName: integration.labels?.save ?? "Sync save" },
        pause: { displayName: integration.labels?.pause ?? "Pause" },
        play: { displayName: integration.labels?.resume ?? "Resume" },
        netplay: { displayName: integration.labels?.netplay ?? "Netplay" },
      },
    },
  );
  window.bridgeAdapter = adapter;
  const emulator = frame.contentWindow.EJS_emulator;
  frame.contentDocument.body.classList.add("romm-player");
  const style = frame.contentDocument.createElement("link");
  style.rel = "stylesheet";
  style.href = new URL("bridge.css?v=lifecycle-20261102", location.href).href;
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
    leave,
    exitLabel: integration.labels?.exit,
  });
  updateMenu(false, false);
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
    const { build, screen, contentCrc } = await boot(players, nativeAllowed);
    if (
      selected &&
      (selected.state_size !== adapter.size ||
        selected.core_version !== build.coreVersion ||
        (selected.max_prediction ?? 0) !== (build.maxPrediction ?? 0) ||
        selected.content_crc !== contentCrc)
    )
      throw new Error("The room uses a different core build or cartridge");
    const body = joinId
      ? { rom_id: rom.id, password: $("join-password").value }
      : {
          rom_id: rom.id,
          system: profile.system,
          coreName: build.coreName,
          coreVersion: build.coreVersion,
          contentCrc,
          stateSize: adapter.size,
          players,
          nativeAllowed,
          password: $("create-password").value,
          maxPrediction: build.maxPrediction ?? 0,
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
    const player = room.player ?? 0;
    screen.select(profile.sharedSave ? 0 : player);
    if (profile.audioOption)
      frame.contentWindow.EJS_emulator.gameManager.setVariable(
        profile.audioOption,
        profile.audio[player],
      );
    const socket = new WebSocket(room.websocket_url);
    connection = new BridgeConnection(adapter, socket, {
      player,
      players,
      battery: bridgeSeed(profile, player, initialBattery),
      maxPrediction: build.maxPrediction ?? 0,
      calibrate:
        build.nativeCalibration === "sameboy-v1" ? calibrateSameBoy : null,
      onStatus(value) {
        if (value === "connected") {
          $("lobby").hidden = false;
          $("screen").hidden = false;
          showRoom(false);
        }
        status(
          value === "connected"
            ? `Connected · P${connection.seats[player] + 1}`
            : value === "waiting"
              ? "Waiting for all players…"
              : value,
        );
        updateMenu(value === "paused", !!connection?.started);
        if (value === "paused") {
          frame?.contentWindow.audioOutput.flush();
          frame?.contentWindow.EJS_emulator.displayMessage("Paused");
        }
        if (value === "stopped") {
          clearInterval(ticker);
          clearInterval(autosave);
          frame?.contentWindow.audioOutput.flush();
          showRoom(true);
        }
      },
      onLobby: renderLobby,
      onLatency: renderLatency,
      onRestart() {
        frame?.contentWindow.audioOutput.flush();
        frame.contentWindow.localButtons = 0;
      },
      onSeats(seat) {
        screen.select(profile.sharedSave ? 0 : seat);
        if (profile.audioOption)
          frame.contentWindow.EJS_emulator.gameManager.setVariable(
            profile.audioOption,
            profile.audio[seat],
          );
      },
      onActionError: (message) => status(message, true),
      onError: fail,
    });
    window.bridgeConnection = connection;
    $("setup").hidden = true;
    $("disconnect").hidden = false;
    $("connection").hidden = false;
    $("address").textContent = room.native_port
      ? `RetroArch: ${room.native_host}:${room.native_port}`
      : `Web room: ${room.id}`;
    $("password").textContent = room.password
      ? `Room password: ${room.password}`
      : "";
    const invite = new URL("bridge.html", location.href);
    invite.searchParams.set("romId", String(rom.id));
    invite.searchParams.set("room", room.id);
    invite.searchParams.set("v", "lifecycle-20261102");
    $("room-link").href = invite.href;
    $("room-link").textContent = "Open room invitation";
    $("core-info").textContent = nativeAllowed
      ? `${build.coreName} ${build.coreVersion}. ${profile.standardGame ? "Load the game once" : `Load the same cartridge in all ${players} link slots`}, then connect through RetroArch Netplay.${profile.core === "sameboy" ? " Use 48000 Hz audio." : ""}`
      : "Share this invitation with the other players.";
    let next = performance.now();
    ticker = setInterval(() => {
      if (!connection || !frame) return;
      const now = performance.now();
      if (now - next > 200) next = now;
      try {
        for (let steps = 0; steps < 3 && performance.now() >= next; steps++) {
          if (
            !connection.tick(
              $("room-panel").hidden
                ? frame.contentWindow.localButtons || 0
                : 0,
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
    frame.contentWindow.addEventListener("blur", () =>
      frame.contentWindow.audioOutput.setActive(false),
    );
    frame.contentWindow.audioOutput.setActive(true);
    showRoom(true);
  } catch (error) {
    fail(error);
  }
}

function ownBattery() {
  if (!connection?.started) return null;
  const id = bridgeBatteryId(profile, connection.seats[connection.player]);
  return connection.session?.maxPrediction
    ? connection.session.confirmedMemory(id)
    : adapter.memory(id);
}

function saveError(error) {
  showRoom(true);
  $("save-status").textContent = `Could not save: ${error.message}`;
  $("save-status").classList.add("error");
}

async function save() {
  if (saving) return saving.then(() => save());
  const data = ownBattery();
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
      $("save-status").textContent = "Progress saved.";
      $("save-status").classList.remove("error");
      frame?.contentWindow.EJS_emulator.displayMessage("Progress saved.");
    })
    .finally(() => {
      saving = null;
    });
  return saving;
}

$("create").onclick = () => launch();
$("join").onclick = () => launch($("rooms").value);
$("refresh").onclick = refreshRooms;
$("rooms").onchange = updateJoin;
$("start").onclick = () => connection?.startGame();
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
    closed = true;
    releasePlayer();
    if (integration.onExit) integration.onExit();
    else location.assign(`/rom/${rom.id}/ejs`);
  } catch (error) {
    saveError(error);
  }
}
$("back").onclick = leave;
$("close-room").onclick = () => showRoom(false);
$("room-panel").addEventListener("keydown", (event) => {
  event.stopPropagation();
  if (event.key === "Escape" && connection?.started) {
    event.preventDefault();
    event.stopPropagation();
    showRoom(false);
  }
});
$("room-panel").addEventListener("keyup", (event) => event.stopPropagation());
window.addEventListener("beforeunload", (event) => {
  if (
    !integration.onExit &&
    !closed &&
    connection?.started &&
    ownBattery()?.length
  ) {
    event.preventDefault();
    event.returnValue = "";
  }
});
window.addEventListener("pagehide", () => {
  clearInterval(ticker);
  clearInterval(autosave);
  connection?.stop();
});
window.addEventListener("message", (event) => {
  if (
    event.origin !== location.origin ||
    event.source !== window.opener ||
    event.data?.type !== "romm-bridge-init"
  )
    return;
  void initialize(event.data);
});
window.bridgePlayer = { initialize, save, destroy: releasePlayer };
window.opener?.postMessage({ type: "romm-bridge-ready" }, location.origin);
const romId = Number(new URLSearchParams(location.search).get("romId"));
if (romId > 0) void initialize({ romId });
