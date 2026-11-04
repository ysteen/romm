<script setup lang="ts">
import { RAlert, RBtn, RSpinner } from "@v2/lib";
import { onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { DetailedRomSchema } from "@/__generated__";
import { useIsAlive } from "@/v2/composables/useIsAlive";
import { BRIDGE_PLAYER_PATH, type BridgeLaunch } from "./bridgeLaunch";

interface BridgePlayer {
  initialize(
    options: BridgeLaunch & {
      theme: string;
      language: string;
      labels: Record<string, string>;
      onExit: () => void;
    },
  ): Promise<void>;
  save(): Promise<void>;
  destroy(): void;
}
interface BridgeWindow extends Window {
  bridgePlayer: BridgePlayer;
}
const props = defineProps<{ rom: DetailedRomSchema; launch: BridgeLaunch }>();
const emit = defineEmits<{ exit: [] }>();
const { t, locale } = useI18n();
const alive = useIsAlive();
const frame = ref<HTMLIFrameElement | null>(null);
const loading = ref(true);
const error = ref("");
let player: BridgePlayer | undefined;
async function start() {
  const win = frame.value?.contentWindow as BridgeWindow | null;
  if (!win || !alive.value) return;
  try {
    player = win.bridgePlayer;
    if (!player) throw new Error(t("link.relay-launch-error"));
    await player.initialize({
      ...props.launch,
      theme: document.documentElement.classList.contains("r-v2-light")
        ? "light"
        : "dark",
      language: locale.value.replace("_", "-"),
      labels: {
        save: t("play.sync-save"),
        exit: t("play.save-and-quit"),
        back: t("common.back"),
        resume: t("play.resume"),
        pause: t("play.pause"),
        netplay: t("play.netplay"),
      },
      onExit: () => {
        if (alive.value) emit("exit");
      },
    });
  } catch (cause) {
    if (alive.value)
      error.value =
        cause instanceof Error ? cause.message : t("link.relay-launch-error");
  } finally {
    if (alive.value) loading.value = false;
  }
}
onBeforeUnmount(() => player?.destroy());
defineExpose({
  flushPendingSave: async () => {
    await player?.save();
  },
});
</script>

<template>
  <div class="bridge-stage">
    <RAlert v-if="error" type="error" role="alert"
      >{{ error
      }}<RBtn @click="emit('exit')">{{ t("play.quit") }}</RBtn></RAlert
    >
    <RSpinner
      v-if="loading"
      class="bridge-stage__loading"
      :aria-label="t('common.loading')"
    />
    <iframe
      ref="frame"
      :src="`${BRIDGE_PLAYER_PATH}?v=reusable-launcher-20261102`"
      :title="rom.name || rom.fs_name"
      allow="autoplay; gamepad; fullscreen"
      @load="start"
    />
  </div>
</template>

<style scoped>
.bridge-stage {
  position: relative;
  width: 100%;
  height: 100%;
  background: var(--r-color-canvas-bg);
}
.bridge-stage iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}
.bridge-stage__loading {
  position: absolute;
  z-index: 1;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}
</style>
