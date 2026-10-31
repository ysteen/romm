import { calibrateSameBoy } from "../data/src/bridge-calibration.js";
import {
  bridgeCore,
  bridgeCoreFor,
  bridgeBatteryId,
  bridgeSeed,
  bridgeSaveSelection,
} from "../data/src/bridge-profile.js";
import { BridgeConnection, crc32 } from "../data/src/bridge-session.js";
import { installPlayerScreen } from "./screen.js?v=20261021.10";

const $ = (id) => document.getElementById(id);
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
  clearInterval(ticker);
  clearInterval(autosave);
  connection?.stop();
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

async function initialize({ romId, theme }) {
  if (initialized || !Number.isSafeInteger(romId) || romId <= 0) return;
  initialized = true;
  if (theme === "light" || theme === "dark")
    document.documentElement.style.colorScheme = theme;
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
    $("native").checked = !$("native").disabled;
    const nested =
      rom.has_nested_single_file && rom.files?.length === 1
        ? rom.files[0].file_name
        : rom.fs_name;
    cartridge = await bytes(
      `/api/roms/${rom.id}/content/${encodeURIComponent(nested)}?purpose=play`,
    );
    const { selected, target } = bridgeSaveSelection(profile, rom.user_saves);
    targetSave = target;
    initialBattery = selected
      ? await bytes(selected.download_path)
      : new Uint8Array();
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
  try {
    const listed = await api(`/netplay/bridge/rooms?rom_id=${rom.id}`);
    rooms.clear();
    $("rooms").replaceChildren(new Option("Choose a room", ""));
    for (const item of listed) {
      rooms.set(item.id, item);
      $("rooms").append(
        new Option(
          `${item.nickname || item.id} · ${item.players} players`,
          item.id,
        ),
      );
    }
    const invited = new URLSearchParams(location.search).get("room");
    if (invited && rooms.has(invited)) {
      $("rooms").value = invited;
      status("Room selected. Enter its password and join.");
    }
    $("join").disabled = rooms.size === 0;
  } catch (error) {
    fail(error);
  }
}

async function boot(players, nativeAllowed) {
  connection?.stop();
  clearInterval(ticker);
  clearInterval(autosave);
  frame?.remove();
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
  frame.src = "player.html?v=rollback-20261101";
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
    },
  );
  window.bridgeAdapter = adapter;
  const emulator = frame.contentWindow.EJS_emulator;
  emulator.setVolume(Number($("volume").value));
  const screen = installPlayerScreen(emulator, profile);
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
        status(
          value === "connected"
            ? `Connected · player ${player + 1}`
            : value === "waiting"
              ? "Waiting for all players…"
              : value,
        );
        $("pause").textContent = value === "paused" ? "Resume" : "Pause";
        if (value === "stopped") {
          clearInterval(ticker);
          clearInterval(autosave);
        }
      },
      onError: fail,
    });
    window.bridgeConnection = connection;
    $("setup").hidden = true;
    $("controls").hidden = false;
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
    $("room-link").href = invite.href;
    $("room-link").textContent = "Open room invitation";
    $("native-details").hidden = !nativeAllowed;
    $("core-info").textContent = nativeAllowed
      ? `${build.coreName} ${build.coreVersion}. ${profile.standardGame ? "Load the game once" : `Load the same cartridge in all ${players} link slots`}, then connect through RetroArch Netplay.${profile.core === "sameboy" ? " Use 48000 Hz audio." : ""}`
      : "Invite another web player to begin.";
    $("core-download").href = new URL(build.nativeDownload, location.href).href;
    $("core-download").textContent =
      `Download matching core (${build.nativePlatform})`;
    $("core-build").href = new URL(build.buildInstructions, location.href).href;
    let next = performance.now();
    ticker = setInterval(() => {
      const now = performance.now();
      if (now - next > 200) next = now;
      if (now < next) return;
      if (connection.tick(frame.contentWindow.localButtons || 0))
        next += 1000 / profile.frameRate;
      else next = now;
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
    frame.contentWindow.focus();
  } catch (error) {
    fail(error);
  }
}

function ownBattery() {
  if (!connection?.started) return null;
  const id = bridgeBatteryId(profile, connection.player);
  return connection.session?.maxPrediction
    ? connection.session.confirmedMemory(id)
    : adapter.memory(id);
}

function saveError(error) {
  $("save-status").textContent = `Could not save: ${error.message}`;
  $("save-status").classList.add("error");
}

async function save() {
  if (saving) return saving;
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
    })
    .finally(() => {
      saving = null;
    });
  return saving;
}

$("create").onclick = () => launch();
$("join").onclick = () => launch($("rooms").value);
$("refresh").onclick = refreshRooms;
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
$("volume").oninput = () =>
  frame?.contentWindow.EJS_emulator.setVolume(Number($("volume").value));
$("pause").onclick = () => connection?.pause(!connection.session?.paused);
$("save").onclick = () => save().catch(saveError);
$("disconnect").onclick = async () => {
  $("disconnect").disabled = true;
  await save().catch(saveError);
  connection?.stop();
  $("setup").hidden = false;
  $("create").disabled = $("refresh").disabled = false;
  $("disconnect").disabled = false;
  void refreshRooms();
};
$("download").onclick = () => {
  const data = ownBattery();
  if (!data?.length) return;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([data]));
  link.download = `${rom.fs_name_no_ext}.srm`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};
$("quit").onclick = async () => {
  try {
    await save();
    closed = true;
    connection?.stop();
    window.close();
  } catch (error) {
    saveError(error);
  }
};
window.addEventListener("beforeunload", (event) => {
  if (!closed && connection?.started && ownBattery()?.length) {
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
window.opener?.postMessage({ type: "romm-bridge-ready" }, location.origin);
const romId = Number(new URLSearchParams(location.search).get("romId"));
if (romId > 0) void initialize({ romId });
