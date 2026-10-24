<script setup lang="ts">
import { RAlert, RBtn, RSpinner } from "@v2/lib";
import { useEventListener } from "@vueuse/core";
import type { Emitter } from "mitt";
import { io } from "socket.io-client";
import {
  computed,
  inject,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
} from "vue";
import { useI18n } from "vue-i18n";
import type {
  DetailedRomSchema,
  SaveSchema,
  StateSchema,
} from "@/__generated__";
import api from "@/services/api";
import romApi from "@/services/api/rom";
import saveApi, { sessionSaveFile } from "@/services/api/save";
import storeAuth from "@/stores/auth";
import storeConfig from "@/stores/config";
import storePlaying from "@/stores/playing";
import type { Events } from "@/types/emitter";
import { getDownloadPath } from "@/utils/downloadPath";
import { useIsAlive } from "@/v2/composables/useIsAlive";
import { useSnackbar } from "@/v2/composables/useSnackbar";
import { saveState } from "@/views/Player/EmulatorJS/utils";
import {
  installLinkRoomMenu,
  linkCoreFor,
  linkPlatforms,
  supportsLink,
  LINK_SAVE_SLOT,
  type LinkLaunch,
  type LinkConnection,
  type LinkRoom,
  type NetplayMenu,
} from "./linkSession";

type LinkStatus =
  | "ready"
  | "waiting"
  | "connecting"
  | "connected"
  | "solo"
  | "stopped"
  | "error";
interface LinkRuntime {
  netplay: NetplayMenu;
  connect(
    room: {
      id?: string;
      name: string;
      password: string;
      player: number;
    },
    connection?: LinkConnection,
  ): void;
  battery(): Uint8Array<ArrayBuffer> | null;
  readonly player: number | null;
  captureState(): Uint8Array<ArrayBuffer>;
  restoreState(bytes: Uint8Array<ArrayBuffer>): void;
  restoreBattery(bytes: Uint8Array<ArrayBuffer>): void;
  pause(): void;
  play(): void;
  status: LinkStatus;
  stop(): void;
  destroy(): void;
  updateSave(bytes: Uint8Array<ArrayBuffer>): void;
}
interface LinkWindow extends Window {
  bootRomm(
    roms: Uint8Array<ArrayBuffer>[],
    options: {
      romId: number;
      core: "sameboy" | "mgba_splitscreen";
      gameId: string;
      name: string;
      createSocket: typeof io;
      save: Uint8Array<ArrayBuffer> | null;
      iceServers: RTCIceServer[];
      exitLabel: string;
      buttons: Window["EJS_Buttons"];
      labels: { quickLoad: string; saveQuit: string; contextMenu: string };
      onSaveState: () => Promise<void>;
      onSave: () => Promise<void>;
      onLoadState: () => Promise<void>;
      onQuickLoad: () => Promise<void>;
      canExit: () => boolean;
      onExit: () => Promise<void>;
      onStatus: (event: {
        status: LinkStatus;
        player: number | null;
        error?: string;
      }) => void;
    },
  ): Promise<LinkRuntime>;
}
const props = defineProps<{ rom: DetailedRomSchema; launch: LinkLaunch }>();
const emit = defineEmits<{
  exit: [];
  createRoom: [];
  joinRoom: [room: LinkRoom];
}>();
const { t } = useI18n();
const auth = storeAuth();
const config = storeConfig();
const alive = useIsAlive();
const snackbar = useSnackbar();
const emitter = inject<Emitter<Events>>("emitter");
const frame = ref<HTMLIFrameElement | null>(null);
const status = ref<LinkStatus>("ready");
const error = ref("");
const loading = ref(true);
const runtime = shallowRef<LinkRuntime | null>(null);
const ownRom = computed(() => props.rom);
const player = computed(() => props.launch.player);
let target: SaveSchema | null = null;
let lastBytes: Uint8Array<ArrayBuffer> | null = null;
let pending: Promise<void> | null = null;
let autosave: ReturnType<typeof setInterval> | undefined;
let exiting = false;
let removeRoomMenu: (() => void) | undefined;
let stateBusy = false;
let stateSaved = false;
let latestState: Uint8Array<ArrayBuffer> | null = null;
const stateCore = computed(
  () => `${linkCoreFor(props.rom.platform_slug)}-link`,
);
function battery() {
  if (runtime.value && runtime.value.player !== player.value) return null;
  const bytes = runtime.value?.battery() ?? props.launch.save;
  return bytes && bytes.length > 4 ? bytes : null;
}
function showError(cause: unknown) {
  if (alive.value)
    error.value =
      cause instanceof Error ? cause.message : t("play.stream-error-generic");
}
async function readBytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const { data } = await api.get<ArrayBuffer>(url.replace(/^\/api/, ""), {
    responseType: "arraybuffer",
    params: { device_id: auth.user?.current_device_id },
  });
  return new Uint8Array(data);
}
async function start() {
  try {
    const pair = await Promise.all(
      props.launch.roms.map(
        async (id) => (await romApi.getRom({ romId: id })).data,
      ),
    );
    if (
      !pair.every(
        (rom) =>
          supportsLink(rom) &&
          linkPlatforms(props.rom.platform_slug).includes(rom.platform_slug),
      )
    )
      throw new Error(t("link.supported"));
    const bytes = await Promise.all(
      pair.map((rom) => readBytes(getDownloadPath({ rom }))),
    );
    if (!alive.value) return;
    const iframe = frame.value;
    if (!iframe) throw new Error(t("play.stream-error-generic"));
    const win = await new Promise<LinkWindow>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(t("play.stream-error-generic"))),
        45000,
      );
      iframe.onload = () => {
        clearTimeout(timeout);
        resolve(iframe.contentWindow as LinkWindow);
      };
      iframe.onerror = () => {
        clearTimeout(timeout);
        reject(new Error(t("play.stream-error-generic")));
      };
      iframe.src = "/assets/emulatorjs/input-netplay/player.html?v=20261021.10";
    });
    if (!alive.value) return;
    const instance = await win.bootRomm(bytes, {
      romId: props.rom.id,
      core: linkCoreFor(pair[0].platform_slug),
      gameId: `link:${pair.map((rom) => rom.id).join(":")}`,
      name: auth.user?.username ?? "",
      createSocket: io,
      save: props.launch.save,
      iceServers: config.config.EJS_NETPLAY_ICE_SERVERS,
      exitLabel: t("play.quit"),
      buttons: { ...window.EJS_Buttons, exitEmulation: false },
      labels: {
        quickLoad: t("play.load-latest-state"),
        saveQuit: t("play.save-and-quit"),
        contextMenu: t("play.context-menu"),
      },
      onSaveState: captureState,
      onSave: () => save().catch(showError),
      onLoadState: openStatePicker,
      onQuickLoad: loadLatestState,
      canExit: () => stateSaved && !stateBusy,
      onExit: leave,
      onStatus: (event) => {
        if (!alive.value) return;
        status.value = event.status;
        if (event.error) error.value = event.error;
        if (["waiting", "connected", "solo"].includes(event.status))
          error.value = "";
        if (event.status === "solo") {
          void Promise.resolve()
            .then(async () => {
              if (!alive.value || exiting || runtime.value?.status !== "solo")
                return;
              snackbar.info(t("link.solo"));
              await save();
            })
            .catch(showError);
        }
      },
    });
    if (!alive.value) {
      instance.destroy();
      return;
    }
    runtime.value = instance;
    instance.connect(
      {
        id: props.launch.roomId,
        name: props.launch.roomName,
        password: props.launch.password,
        player: player.value,
      },
      props.launch.connection,
    );
    removeRoomMenu = installLinkRoomMenu(
      instance.netplay,
      props.rom.id,
      () => emit("createRoom"),
      (room) => emit("joinRoom", room),
    );
    autosave = setInterval(() => {
      if (["connected", "solo"].includes(status.value))
        void save().catch(showError);
    }, 10000);
  } catch (cause) {
    status.value = "error";
    props.launch.connection?.socket.disconnect();
    showError(cause);
  } finally {
    loading.value = false;
  }
}

async function captureState() {
  if (stateBusy || runtime.value?.status !== "solo") return;
  stateBusy = true;
  stateSaved = false;
  try {
    const bytes = new Uint8Array(runtime.value.captureState());
    const result = await saveState({
      rom: props.rom,
      stateFile: bytes,
      emulator: stateCore.value,
    });
    if (!result.state && !result.kept)
      throw new Error(t("play.stream-error-generic"));
    latestState = bytes;
    stateSaved = true;
    snackbar.success(
      t(result.state ? "play.state-synced" : "play.state-kept-for-later"),
    );
  } catch (cause) {
    showError(cause);
  } finally {
    stateBusy = false;
  }
}

async function restoreAsset(
  asset: StateSchema | SaveSchema,
  kind: "state" | "save",
) {
  if (stateBusy || runtime.value?.status !== "solo") return;
  stateBusy = true;
  try {
    if (
      asset.rom_id !== props.rom.id ||
      asset.missing_from_fs ||
      (kind === "state" && asset.emulator !== stateCore.value)
    )
      throw new Error(t("link.incompatible-state"));
    const bytes = await readBytes(asset.download_path);
    if (!alive.value || runtime.value?.status !== "solo") return;
    if (kind === "state") {
      try {
        runtime.value.restoreState(bytes);
      } catch {
        throw new Error(t("link.incompatible-state"));
      }
    } else runtime.value.restoreBattery(bytes);
    error.value = "";
    // Restoring progress is deliberate; do not write an older queued capture over it.
    if (pending) await pending;
    lastBytes = runtime.value.battery();
  } catch (cause) {
    showError(cause);
  } finally {
    stateBusy = false;
  }
}

async function loadLatestState() {
  if (stateBusy || runtime.value?.status !== "solo") return;
  try {
    if (latestState) {
      runtime.value.restoreState(latestState);
      lastBytes = runtime.value.battery();
      return;
    }
    const { data } = await romApi.getRom({ romId: props.rom.id });
    if (!alive.value) return;
    const state = data.user_states
      .filter(
        (state) => state.emulator === stateCore.value && !state.missing_from_fs,
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!state) throw new Error(t("link.no-state"));
    await restoreAsset(state, "state");
  } catch (cause) {
    showError(cause);
  }
}

async function openStatePicker() {
  if (stateBusy || runtime.value?.status !== "solo") return;
  try {
    const { data } = await romApi.getRom({ romId: props.rom.id });
    if (!alive.value || runtime.value?.status !== "solo") return;
    if (document.fullscreenElement) await document.exitFullscreen();
    runtime.value.pause();
    emitter?.emit("selectStateDialog", {
      ...data,
      player: {
        core: stateCore.value,
        loadState: (state) => restoreAsset(state, "state"),
        loadSave: (save) => restoreAsset(save, "save"),
        close: () => {
          if (runtime.value?.status === "solo") runtime.value.play();
        },
      },
    });
  } catch (cause) {
    showError(cause);
  }
}

function save(): Promise<void> {
  if (stateBusy) return Promise.resolve();
  if (pending) return pending.then(() => save());
  const bytes = battery();
  const rom = ownRom.value;
  const role = player.value;
  const selectedTarget = target;
  if (!bytes?.length || !rom || role === null) return Promise.resolve();
  if (
    lastBytes?.length === bytes.length &&
    bytes.every((b, i) => b === lastBytes?.[i])
  )
    return Promise.resolve();
  const file = sessionSaveFile(rom, target, bytes);
  pending = (async () => {
    let uploaded: SaveSchema;
    if (selectedTarget) {
      const { data } = await saveApi.updateSave({
        save: selectedTarget,
        saveFile: file,
        deviceId: auth.user?.current_device_id ?? undefined,
      });
      uploaded = data;
    } else {
      const [result] = await saveApi.uploadSaves({
        rom,
        emulator: linkCoreFor(rom.platform_slug),
        slot: LINK_SAVE_SLOT,
        deviceId: auth.user?.current_device_id ?? undefined,
        savesToUpload: [{ saveFile: file }],
      });
      if (result.status === "rejected") throw result.reason;
      uploaded = result.value;
    }
    target = uploaded;
    lastBytes = bytes;
    runtime.value?.updateSave(bytes);
  })().finally(() => {
    pending = null;
  });
  return pending;
}

async function leave() {
  if (exiting || stateBusy) return;
  exiting = true;
  try {
    await save();
    if (runtime.value?.status !== "stopped") runtime.value?.stop();
    emit("exit");
  } catch (cause) {
    exiting = false;
    showError(cause);
  }
}
useEventListener(window, "pagehide", () => {
  const bytes = battery();
  if (!bytes?.length) return;
  saveApi.sendSaveOnUnload({
    rom: props.rom,
    save: target,
    saveFile: sessionSaveFile(props.rom, target, bytes),
    emulator: linkCoreFor(props.rom.platform_slug),
    slot: LINK_SAVE_SLOT,
    deviceId: auth.user?.current_device_id ?? undefined,
  });
});
onBeforeUnmount(() => {
  clearInterval(autosave);
  removeRoomMenu?.();
  if (!runtime.value) props.launch.connection?.socket.disconnect();
  runtime.value?.destroy();
});
onMounted(() => {
  storePlaying().setPlaying(true);
  void start();
});
defineExpose({
  flushPendingSave: save,
  battery,
  netplay: () => runtime.value?.netplay,
});
</script>

<template>
  <div class="link-stage">
    <RAlert v-if="error" type="error" role="alert">
      {{ error }}
      <RBtn @click="leave">{{ t("play.quit") }}</RBtn>
    </RAlert>
    <RSpinner
      v-if="loading"
      class="link-stage__loading"
      :aria-label="t('common.loading')"
    />
    <iframe
      ref="frame"
      class="link-stage__screen"
      :title="rom.name || rom.fs_name"
      allow="autoplay; gamepad"
    />
  </div>
</template>

<style scoped>
.link-stage {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: var(--r-color-bg);
}
.link-stage__loading {
  position: absolute;
  z-index: 1;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}
.link-stage__screen {
  width: 100%;
  flex: 1;
  min-height: 0;
  border: 0;
  background: var(--r-color-canvas-bg);
}
</style>
