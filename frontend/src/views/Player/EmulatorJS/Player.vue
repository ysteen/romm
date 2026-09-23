<script setup lang="ts">
import type { Emitter } from "mitt";
import { storeToRefs } from "pinia";
import { inject, onBeforeUnmount, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useTheme } from "vuetify";
import type {
  FirmwareSchema,
  SaveSchema,
  StateSchema,
  NetplayICEServer,
} from "@/__generated__";
import { ROUTES } from "@/plugins/router";
import { saveApi as api } from "@/services/api/save";
import storeAuth from "@/stores/auth";
import storeConfig from "@/stores/config";
import storeLanguage from "@/stores/language";
import storePlaying from "@/stores/playing";
import storeRoms, { type DetailedRom } from "@/stores/roms";
import type { Events } from "@/types/emitter";
import {
  captureAzaharState,
  downloadAzaharState,
  getAzaharStateRuntime,
  MAX_AZAHAR_STATE_BYTES,
} from "@/utils/azaharState";
import {
  areThreadsRequiredForEJSCore,
  getSupportedEJSCores,
  getControlSchemeForPlatform,
  getDownloadPath,
} from "@/utils";
import {
  saveSave,
  saveState,
  loadEmulatorJSSave,
  loadEmulatorJSState,
  invalidateEmulatorJSRomCacheIfRenamed,
  installEJSDefaultOptionsTrap,
  createQuickLoadButton,
  createSaveQuitButton,
  createExitEmulationButton,
} from "./utils";

const INVALID_CHARS_REGEX = /[#<$+%>!`&*'|{}/\\?"=@:^\r\n]/gi;

const authStore = storeAuth();
const romsStore = storeRoms();
const playingStore = storePlaying();
const configStore = storeConfig();
const languageStore = storeLanguage();
const router = useRouter();

const props = defineProps<{
  rom: DetailedRom;
  save: SaveSchema | null;
  state: StateSchema | null;
  bios: FirmwareSchema | null;
  core: string | null;
  disc: number | null;
}>();
const romRef = ref<DetailedRom>(props.rom);
const saveRef = ref<SaveSchema | null>(props.save);
const deviceIDRef = ref(authStore.user?.current_device_id ?? undefined);
const theme = useTheme();
const emitter = inject<Emitter<Events>>("emitter");
const { playing, fullScreen } = storeToRefs(playingStore);
const { selectedLanguage } = storeToRefs(languageStore);
const stateSession = new AbortController();
let stateBusy = false;

// Declare global variables for EmulatorJS
declare global {
  interface Window {
    EJS_core: string;
    EJS_biosUrl: string;
    EJS_player: string;
    EJS_pathtodata: string;
    EJS_color: string;
    EJS_gameID: number;
    EJS_gameName: string;
    EJS_backgroundImage: string;
    EJS_backgroundColor: string;
    EJS_backgroundBlur: boolean;
    EJS_gameUrl: string;
    EJS_loadStateURL: string | null;
    EJS_cheats: string;
    EJS_gameParentUrl: string;
    EJS_gamePatchUrl: string;
    EJS_netplayServer: string;
    EJS_netplayICEServers: NetplayICEServer[];
    EJS_alignStartButton: "top" | "center" | "bottom";
    EJS_startOnLoaded: boolean;
    EJS_fullscreenOnLoaded: boolean;
    EJS_threads: boolean;
    EJS_controlScheme: string | null;
    EJS_defaultOptions: object;
    EJS_defaultControls: object;
    EJS_emulator: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    EJS_language: string;
    EJS_disableAutoLang: boolean;
    EJS_DEBUG_XX: boolean;
    EJS_CacheLimit: number;
    EJS_Buttons: Record<string, boolean>;
    EJS_VirtualGamepadSettings: Record<string, unknown>;
    EJS_volume: number;
    EJS_paths: Record<string, string>;
    EJS_startButtonName: string;
    EJS_softLoad: boolean;
    EJS_screenCapture: object;
    EJS_externalFiles: Record<string, string>;
    EJS_videoRotation: number;
    EJS_fixedSaveInterval: number;
    EJS_disableCue: boolean;
    EJS_dontExtractRom: boolean;
    EJS_dontExtractBIOS: boolean;
    EJS_disableDatabases: boolean;
    EJS_disableLocalStorage: boolean;
    EJS_disableAutoUnload: boolean;
    EJS_disableBatchBootup: boolean;
    EJS_onGameStart: () => void;
    EJS_onSaveState: (args: {
      screenshot?: ArrayBuffer;
      state: ArrayBuffer;
    }) => void;
    EJS_onLoadState: () => void;
    EJS_onSaveSave: (args: {
      screenshot: ArrayBuffer;
      save: ArrayBuffer;
    }) => void;
    EJS_onLoadSave: () => void;
    // Socket.IO global, bundled by EmulatorJS and used by its netplay code.
    io?: ((url: string, opts?: Record<string, unknown>) => unknown) & {
      __rommNetplayPatched?: boolean;
    };
  }
}

const supportedCores = getSupportedEJSCores(
  romRef.value.platform_slug,
  configStore.config.EJS_NETPLAY_ENABLED,
);
window.EJS_core =
  supportedCores.find((core) => core === props.core) ?? supportedCores[0];
const isDosBoxPure = ["dos", "dosbox_pure"].includes(window.EJS_core);
const isPpsspp = window.EJS_core === "ppsspp";
const isAzahar = window.EJS_core === "azahar";
const usesDirectorySaveBundle = isDosBoxPure || isPpsspp || isAzahar;
// Keep DOSBox Pure packages intact. The core scans ZIP contents itself for
// AUTOBOOT.DBP, ISO/CUE media, and disk images.
window.EJS_dontExtractRom = isDosBoxPure;
// Directory-backed cores need their RomM save bundle restored before startup.
window.EJS_externalFiles =
  usesDirectorySaveBundle && props.save?.download_path
    ? { "/data/saves/": props.save.download_path }
    : {};
window.EJS_controlScheme = getControlSchemeForPlatform(
  romRef.value.platform_slug,
);
window.EJS_threads = areThreadsRequiredForEJSCore(window.EJS_core);
window.EJS_gameID = romRef.value.id;
invalidateEmulatorJSRomCacheIfRenamed(romRef.value);
window.EJS_gameUrl = getDownloadPath({
  rom: romRef.value,
  fileIDs: props.disc ? [props.disc] : [],
});
window.EJS_biosUrl = props.bios
  ? `/api/firmware/${props.bios.id}/content/${props.bios.file_name}`
  : "";
window.EJS_player = "#game";
window.EJS_color = "#A453FF";
window.EJS_alignStartButton = "center";
window.EJS_startOnLoaded = true;
window.EJS_backgroundImage = `${window.location.origin}/assets/logos/romm_logo_xbox_one_circle_boot.svg`;
window.EJS_backgroundColor = theme.current.value.colors.background;
window.EJS_Buttons = {
  // Disable the standard exit button to implement our own
  exitEmulation: false,
};
const coreOptions = configStore.getEJSCoreOptions(window.EJS_core);
window.EJS_defaultOptions = {
  // Force saving saves and states to the browser
  "save-state-location": "browser",
  rewindEnabled: "enabled",
  ...coreOptions,
  // Azahar savestate serialization is currently too expensive for realtime
  // rewind and can starve the emulator before the first frame is displayed.
  ...(isAzahar ? { rewindEnabled: "disabled" } : {}),
};
const ejsControls = configStore.getEJSControls(props.core);
if (ejsControls) window.EJS_defaultControls = ejsControls;
// Set a valid game name
window.EJS_gameName = romRef.value.fs_name_no_tags
  .replace(INVALID_CHARS_REGEX, "")
  .trim();
window.EJS_language = selectedLanguage.value.value.replace("_", "-");
window.EJS_disableAutoLang = true;

const {
  EJS_DEBUG,
  EJS_CACHE_LIMIT,
  EJS_DISABLE_AUTO_UNLOAD,
  EJS_DISABLE_BATCH_BOOTUP,
  EJS_NETPLAY_ICE_SERVERS,
  EJS_NETPLAY_ENABLED,
} = configStore.config;
// Full origin (with scheme)
window.EJS_netplayServer = EJS_NETPLAY_ENABLED ? window.location.origin : "";
window.EJS_netplayICEServers = EJS_NETPLAY_ENABLED
  ? EJS_NETPLAY_ICE_SERVERS
  : [];
window.EJS_DEBUG_XX = EJS_DEBUG;
window.EJS_disableAutoUnload = EJS_DISABLE_AUTO_UNLOAD;
window.EJS_disableBatchBootup = EJS_DISABLE_BATCH_BOOTUP;
if (EJS_CACHE_LIMIT !== null) window.EJS_CacheLimit = EJS_CACHE_LIMIT;

installEJSDefaultOptionsTrap();

onMounted(() => {
  window.scrollTo(0, 0);
  if (props.bios) {
    localStorage.setItem(
      `player:${romRef.value.platform_slug}:bios_id`,
      props.bios.id.toString(),
    );
  } else {
    localStorage.removeItem(`player:${romRef.value.platform_slug}:bios_id`);
  }

  if (props.core) {
    // Remember the core per-game, and per-platform as the fallback default
    localStorage.setItem(`player:${romRef.value.id}:core`, props.core);
    localStorage.setItem(
      `player:${romRef.value.platform_slug}:core`,
      props.core,
    );
  } else {
    localStorage.removeItem(`player:${romRef.value.id}:core`);
    localStorage.removeItem(`player:${romRef.value.platform_slug}:core`);
  }

  if (props.disc) {
    localStorage.setItem(
      `player:${romRef.value.id}:disc`,
      props.disc.toString(),
    );
  } else {
    localStorage.removeItem(`player:${romRef.value.id}:disc`);
  }

  emitter?.on("saveSelected", loadSave);
  emitter?.on("stateSelected", loadState);
});

onBeforeUnmount(async () => {
  stateSession.abort();
  emitter?.off("saveSelected", loadSave);
  emitter?.off("stateSelected", loadState);
  window.EJS_emulator?.callEvent("exit");
  fullScreen.value = false;
  playing.value = false;
});

function displayMessage(
  message: string,
  {
    duration,
    className = "msg-info",
    icon = "",
  }: {
    duration: number;
    className?: "msg-info" | "msg-error" | "msg-success";
    icon?: string;
  },
) {
  window.EJS_emulator.displayMessage(message, duration);
  const element = document.querySelector("#game .ejs_message");
  if (element) {
    element.classList.add(className, icon);
    setTimeout(() => {
      element.classList.remove(className, icon);
    }, duration);
  }
}

// Poll until EmulatorJS' gameManager is ready to accept save/state
// injection. A fixed delay is unreliable: heavier/threaded cores (SNES with
// enhancement chips, N64, DS) need longer than a few ms to boot, and applying
// a state before the core is ready leaves it broken (black screen).
async function waitForGameManager(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const gameManager = window.EJS_emulator?.gameManager;
    if (gameManager?.FS && gameManager.getSaveFilePath) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

// Settle window after boot before applying a state. Some cores need a few
// frames rendered before loadState takes cleanly.
const STATE_APPLY_SETTLE_MS = 500;

// Saves management
async function loadSave(save: SaveSchema) {
  saveRef.value = save;

  const { data } = await api.get(save.download_path.replace("/api", ""), {
    responseType: "arraybuffer",
  });
  if (data) {
    if (usesDirectorySaveBundle) {
      await window.EJS_emulator.gameManager.loadDirectorySaveBundle(
        new Uint8Array(data),
      );
    } else {
      loadEmulatorJSSave(new Uint8Array(data));
    }
    displayMessage("Save loaded from server", {
      duration: 3000,
      icon: "mdi-cloud-download-outline",
    });
    return;
  }

  const file = await window.EJS_emulator.selectFile();
  const saveData = new Uint8Array(await file.arrayBuffer());
  if (usesDirectorySaveBundle) {
    await window.EJS_emulator.gameManager.loadDirectorySaveBundle(saveData);
  } else {
    loadEmulatorJSSave(saveData);
  }
}

window.EJS_onLoadSave = async function () {
  window.EJS_emulator.pause();
  window.EJS_emulator.toggleFullscreen(false);
  emitter?.emit("selectSaveDialog", romRef.value);
};

window.EJS_onSaveSave = async function ({
  save: saveFile,
  screenshot: screenshotFile,
}) {
  const save = await saveSave({
    rom: romRef.value,
    save: saveRef.value,
    saveFile,
    screenshotFile,
    deviceId: deviceIDRef.value,
  });

  romsStore.update(romRef.value);

  if (save) {
    displayMessage("Save synced with server", {
      duration: 4000,
      icon: "mdi-cloud-sync",
    });
  } else {
    displayMessage("Error syncing save with server", {
      duration: 4000,
      className: "msg-error",
      icon: "mdi-sync-alert",
    });
  }
};

// States management
async function loadState(state: StateSchema) {
  if (
    stateBusy ||
    window.EJS_emulator?.stateActionPending ||
    stateSession.signal.aborted
  )
    return;
  stateBusy = true;
  const emulator = window.EJS_emulator;
  emulator.stateActionPending = true;
  try {
    if (
      state.rom_id !== romRef.value.id ||
      state.missing_from_fs ||
      (state.emulator && state.emulator !== window.EJS_core) ||
      (isAzahar && state.file_size_bytes > MAX_AZAHAR_STATE_BYTES)
    )
      throw new Error("Incompatible state");
    const data = isAzahar
      ? await downloadAzaharState(state.download_path, stateSession.signal)
      : new Uint8Array(
          (
            await api.get(state.download_path.replace("/api", ""), {
              responseType: "arraybuffer",
              signal: stateSession.signal,
            })
          ).data,
        );
    stateSession.signal.throwIfAborted();
    if (window.EJS_emulator !== emulator) return;
    await loadEmulatorJSState(data, stateSession.signal);
    displayMessage("State loaded from server", {
      duration: 3000,
      icon: "mdi-cloud-download-outline",
    });
  } catch (error) {
    if (!stateSession.signal.aborted && window.EJS_emulator === emulator) {
      console.error("State restore failed", error);
      displayMessage(window.EJS_emulator.localization("FAILED TO LOAD STATE"), {
        duration: 4000,
        className: "msg-error",
        icon: "mdi-sync-alert",
      });
    }
  } finally {
    emulator.stateActionPending = false;
    stateBusy = false;
  }
}

window.EJS_onLoadState = async function () {
  if (stateBusy || stateSession.signal.aborted) return;
  window.EJS_emulator.pause();
  window.EJS_emulator.toggleFullscreen(false);
  emitter?.emit("selectStateDialog", {
    ...romRef.value,
    user_states: romRef.value.user_states.filter(
      (state) =>
        !state.missing_from_fs &&
        (!state.emulator || state.emulator === window.EJS_core),
    ),
  });
};

window.EJS_onSaveState = async function ({
  state: stateFile,
  screenshot: screenshotFile,
}) {
  if (stateBusy || stateSession.signal.aborted) return;
  stateBusy = true;
  const emulator = window.EJS_emulator;
  try {
    const state = await saveState({
      rom: romRef.value,
      stateFile,
      screenshotFile,
    });
    stateSession.signal.throwIfAborted();
    if (window.EJS_emulator !== emulator) return;
    if (state) {
      try {
        await emulator.storage.states.put(
          emulator.getBaseFileName() + ".state",
          stateFile,
        );
      } catch (error) {
        console.error("Could not cache the server state locally", error);
      }
    }

    romsStore.update(romRef.value);

    if (state) {
      displayMessage("State synced with server", {
        duration: 4000,
        icon: "mdi-cloud-sync",
      });
    } else {
      displayMessage("Error syncing state with server", {
        duration: 4000,
        className: "msg-error",
        icon: "mdi-sync-alert",
      });
    }
  } finally {
    stateBusy = false;
  }
};

window.EJS_onGameStart = async () => {
  // The emulator now owns the keyboard: every key, "/" included, belongs to
  // the game (a DOS prompt typing "mount A / -t floppy" must not reach the
  // global hotkeys). Callers flag this at launch too, but taking it from the
  // emulator's own start hook keeps the flag true for any entry point.
  playing.value = true;

  // Install netplay overrides synchronously, before any await below, so they
  // are in place before room polling or a Create/Join action can start.
  const netplay = window.EJS_emulator?.netplay;
  if (netplay) {
    // EmulatorJS only prompts for a player name when netplay.name is unset,
    // so presetting it adopts the RomM account username automatically.
    if (!netplay.name && authStore.user?.username) {
      netplay.name = authStore.user.username;
    }
    netplay.getOpenRooms = async () => {
      try {
        const response = await fetch(
          `/api/netplay/list?game_id=${window.EJS_gameID}`,
        );
        if (!response.ok) return {};
        return await response.json();
      } catch (error) {
        console.error("Error fetching netplay rooms:", error);
        return {};
      }
    };
  }

  // Wrap the bundled global `io` so netplay uses mounted socket path.
  if (window.io && !window.io.__rommNetplayPatched) {
    const originalIo = window.io;
    const patchedIo = ((url: string, opts?: Record<string, unknown>) =>
      originalIo(url, {
        ...opts,
        path: "/netplay/socket.io",
      })) as NonNullable<Window["io"]>;
    patchedIo.__rommNetplayPatched = true;
    window.io = patchedIo;
  }

  void (async () => {
    const ready = await waitForGameManager();
    if (!ready) {
      console.warn("Game manager not ready for save/state injection");
    } else {
      // A state restores the whole machine, SRAM included, so a save applied
      // alongside it would be discarded: the state wins when both are set.
      if (props.state) {
        await new Promise((resolve) =>
          setTimeout(resolve, STATE_APPLY_SETTLE_MS),
        );
        await loadState(props.state);
      } else if (props.save && !usesDirectorySaveBundle) {
        await loadSave(props.save);
      }
    }

    if (window.EJS_emulator) {
      window.EJS_emulator.settings = {
        ...window.EJS_emulator.settings,
        "save-state-location": "browser",
      };
    }
  })();

  const quickLoad = createQuickLoadButton();
  quickLoad.addEventListener("click", async () => {
    if (
      stateBusy ||
      window.EJS_emulator?.stateActionPending ||
      stateSession.signal.aborted
    )
      return;
    if (isAzahar) {
      const latest = romRef.value.user_states
        .filter(
          (state) => state.emulator === "azahar" && !state.missing_from_fs,
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      if (latest) return loadState(latest);
    }
    if (
      window.EJS_emulator.settings["save-state-location"] === "browser" &&
      window.EJS_emulator.saveInBrowserSupported()
    ) {
      stateBusy = true;
      const emulator = window.EJS_emulator;
      emulator.stateActionPending = true;
      try {
        const data = await emulator.storage.states.get(
          emulator.getBaseFileName() + ".state",
        );
        stateSession.signal.throwIfAborted();
        if (!data?.byteLength) throw new Error("No saved state");
        await loadEmulatorJSState(data, stateSession.signal);
        displayMessage(
          window.EJS_emulator.localization("LOADED STATE FROM BROWSER"),
          {
            duration: 3000,
            icon: "mdi-flash",
          },
        );
      } catch (error) {
        if (!stateSession.signal.aborted) {
          console.error("Quick state restore failed", error);
          displayMessage(
            window.EJS_emulator.localization("FAILED TO LOAD STATE"),
            { duration: 4000, className: "msg-error" },
          );
        }
      } finally {
        emulator.stateActionPending = false;
        stateBusy = false;
      }
    }
  });

  const exitEmulation = createExitEmulationButton();
  exitEmulation.addEventListener("click", async () => {
    if (stateBusy || window.EJS_emulator?.stateActionPending) return;
    if (!romRef.value || !window.EJS_emulator) return immediateExit();
    romsStore.update(romRef.value);
    await flushDosBoxPureCacheOnQuit();
    immediateExit();
  });

  const saveAndQuit = createSaveQuitButton();
  saveAndQuit.addEventListener("click", async () => {
    if (
      stateBusy ||
      window.EJS_emulator?.stateActionPending ||
      stateSession.signal.aborted
    )
      return;
    if (!romRef.value || !window.EJS_emulator) return immediateExit();

    stateBusy = true;
    const emulator = window.EJS_emulator;
    emulator.stateActionPending = true;
    try {
      const gameManager = emulator.gameManager;
      const supportsStates = gameManager.supportsStates();

      // EmulatorJS screenshots and 4.3 state serialization both require the
      // core's main loop to be running. Pausing here makes threaded cores such
      // as melonDS fail inside EmulatorJSGetState and may also trigger a
      // rejected browser wake-lock request.
      const screenshotFile = isAzahar
        ? undefined
        : await gameManager.screenshot();
      let saveCompleted = false;
      const failures: unknown[] = [];

      // Some cores (including PPSSPP) persist a directory-backed virtual
      // memory card and deliberately expose no single save file. Flush those
      // files through the core, but do not upload a bogus null `.srm`.
      try {
        if (
          window.EJS_emulator.saveFileExt === false &&
          !usesDirectorySaveBundle
        ) {
          gameManager.saveSaveFiles();
          await new Promise<void>((resolve, reject) => {
            gameManager.FS.syncfs(false, (error?: Error) => {
              if (error) reject(error);
              else resolve();
            });
          });
          saveCompleted = true;
        } else {
          const saveFile = await Promise.resolve(gameManager.getSaveFile());
          if (saveFile?.byteLength) {
            const saved = await saveSave({
              rom: romRef.value,
              save: saveRef.value,
              saveFile,
              screenshotFile,
              deviceId: deviceIDRef.value,
            });
            if (!saved) throw new Error("Save upload failed");
            saveCompleted = saved !== null;
          } else {
            gameManager.saveSaveFiles();
            saveCompleted = true;
          }
        }
      } catch (error) {
        failures.push(error);
        console.error("Failed to save in-game save data", error);
      }

      // State support is independent from normal in-game saves. Never let a
      // state failure prevent an NDS/PSP memory-card save from being committed.
      if (supportsStates) {
        try {
          const runtime = isAzahar
            ? getAzaharStateRuntime(window.EJS_emulator)
            : null;
          const captured = runtime
            ? await captureAzaharState(
                runtime,
                stateSession.signal,
                () => window.EJS_emulator === runtime,
              )
            : null;
          const stateFile =
            captured?.data ?? (await Promise.resolve(gameManager.getState()));
          stateSession.signal.throwIfAborted();
          const state = await saveState({
            rom: romRef.value,
            stateFile,
            screenshotFile: captured?.screenshot ?? screenshotFile,
          });
          if (!state) throw new Error("State upload failed");
          saveCompleted ||= state !== null;
        } catch (error) {
          failures.push(error);
          console.error("Failed to save emulator state", error);
        }
      }

      if (!saveCompleted || failures.length) {
        throw new AggregateError(failures, "No save data could be persisted");
      }
      romsStore.update(romRef.value);
      stateSession.signal.throwIfAborted();
      await flushDosBoxPureCacheOnQuit();
      immediateExit();
    } catch (error) {
      if (stateSession.signal.aborted) return;
      console.error("Save & Quit failed", error);
      displayMessage("Error saving game", {
        duration: 4000,
        className: "msg-error",
        icon: "mdi-sync-alert",
      });
    } finally {
      emulator.stateActionPending = false;
      stateBusy = false;
    }
  });
};

async function flushDosBoxPureCacheOnQuit() {
  if (!isDosBoxPure) return;

  const flushSaveCache =
    window.EJS_emulator?.gameManager?.flushDosBoxPureSaveCache;
  if (typeof flushSaveCache !== "function") {
    // The player can briefly run with an older cached EmulatorJS asset after
    // a RomM frontend update. Cache cleanup is an optional DOSBox Pure
    // extension, so its absence must not break Save & Quit for the game.
    console.warn(
      "DOSBox Pure save cache cleanup is unavailable; continuing with normal exit",
    );
    return;
  }

  try {
    await flushSaveCache.call(window.EJS_emulator.gameManager);
  } catch (error) {
    // Do not trap the user in the player if IndexedDB cleanup fails. The
    // failure remains visible in the console and the normal exit still runs.
    console.error("Failed to flush DOSBox Pure save cache", error);
  }
}

function immediateExit() {
  // Play-session recording is owned by the v2 player shell (usePlaySession);
  // this only returns to the game details view.
  router
    .push({ name: ROUTES.ROM, params: { rom: romRef.value.id } })
    .catch((error) => {
      console.error("Error navigating to console rom", error);
    });
}

onUnmounted(() => {
  // Force full reload to reset COEP/COOP, so cross-origin isolation is turned off.
  window.location.reload();
});
</script>

<template>
  <div id="game" />
  <div
    v-if="rom.ss_metadata?.bezel_path"
    class="pointer-events-none fixed inset-0 flex items-center justify-center z-20 overflow-hidden"
    aria-hidden="true"
  >
    <img
      :src="rom.ss_metadata.bezel_path"
      alt=""
      class="select-none"
      draggable="false"
      style="height: 100vh; max-height: 100%; width: auto; object-fit: cover"
    />
  </div>
</template>

<style>
#game .ejs_cheat_code {
  background-color: white;
}

#game .ejs_settings_transition {
  height: fit-content;
}

#game .ejs_game_background {
  background-size: 40%;
}

/* Hide the exit button */
#game .ejs_menu_bar .ejs_menu_button:nth-child(-1) {
  display: none;
}

#game .ejs_message {
  visibility: hidden;
  margin: 1rem;
  padding: 0.25rem 0.75rem;
  border-radius: 4px;
  color: white;
  text-transform: uppercase;
  display: flex;
  align-items: center;
  filter: opacity(0.85) drop-shadow(0 0 0.5rem rgba(0, 0, 0, 0.5));
}

#game .ejs_message::before {
  margin-right: 8px;
  font-size: 20px !important;
  font: normal normal normal 24px / 1 "Material Design Icons";
}

#game .ejs_message.msg-info {
  visibility: visible;
  background-color: rgba(var(--v-theme-romm-blue));
}

#game .ejs_message.msg-error {
  visibility: visible;
  background-color: rgba(var(--v-theme-romm-red));
}

#game .ejs_message.msg-success {
  visibility: visible;
  background-color: rgba(var(--v-theme-romm-green));
}
</style>
