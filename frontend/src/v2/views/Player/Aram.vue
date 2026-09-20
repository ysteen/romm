<script setup lang="ts">
import { RAlert, RBtn, RCard, RSkeletonBlock, RSpinner } from "@v2/lib";
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { useI18n } from "vue-i18n";
import {
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
  useRoute,
  useRouter,
} from "vue-router";
import {
  AramContentError,
  aramContentRequest,
  downloadAramContent,
  isAramEmulationSupported,
} from "@/players/aram/content";
import {
  ARAM_CHANNEL,
  ARAM_MAX_ROM_BYTES,
  ARAM_VERSION,
  isAramHostEvent,
  type AramLaunch,
} from "@/players/aram/protocol";
import { ROUTES } from "@/plugins/router";
import romApi from "@/services/api/rom";
import { useAramStore } from "@/stores/aram";
import storeAuth from "@/stores/auth";
import storeConfig from "@/stores/config";
import storePlaying from "@/stores/playing";
import storeRoms, { type DetailedRom } from "@/stores/roms";
import GameCover from "@/v2/components/shared/GameCover.vue";
import { useBackgroundArt } from "@/v2/composables/useBackgroundArt";
import { useCan } from "@/v2/composables/useCan";
import { useConfirm } from "@/v2/composables/useConfirm";
import { usePageTitle } from "@/v2/composables/usePageTitle";
import { usePlaySession } from "@/v2/composables/usePlaySession";
import { useSnackbar } from "@/v2/composables/useSnackbar";

const { t, locale } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = storeAuth();
const config = storeConfig();
const runtime = useAramStore();
const playing = storePlaying();
const session = usePlaySession();
const snackbar = useSnackbar();
const confirm = useConfirm();
const mayPlay = useCan("rom.play");
const setBackground = useBackgroundArt();
const seeded = storeRoms().currentRom;
const rom = ref<DetailedRom | null>(
  String(seeded?.id) === route.params.rom ? seeded : null,
);
const loading = ref(true);
const phase = ref<"idle" | "loading" | "running">("idle");
const errorKey = ref<string | null>(null);
const frameVisible = ref(false);
const frame = ref<HTMLIFrameElement | null>(null);
const stage = ref<HTMLElement | null>(null);
const controls = ref<HTMLElement | null>(null);
let abort: AbortController | null = null;
let bootTimer: ReturnType<typeof setTimeout> | null = null;
let pendingLaunch: AramLaunch | null = null;
let disposed = false;
let loadSequence = 0;
const title = computed(
  () => rom.value?.name || rom.value?.fs_name_no_ext || "ARAM",
);
const supported = computed(() =>
  Boolean(
    rom.value &&
    isAramEmulationSupported(rom.value.platform_slug, config.config),
  ),
);
const launchable = computed(
  () => !loading.value && runtime.available && supported.value && mayPlay.value,
);

usePageTitle(() => t("play.page-title", { name: title.value }));
watch(
  rom,
  (value) => {
    if (value)
      setBackground(
        value.path_cover_large ??
          value.path_cover_small ??
          value.url_cover ??
          null,
      );
  },
  { immediate: true },
);

function clearBootTimer() {
  if (bootTimer) clearTimeout(bootTimer);
  bootTimer = null;
}

function stop() {
  clearBootTimer();
  abort?.abort();
  abort = null;
  pendingLaunch = null;
  frameVisible.value = false;
  phase.value = "idle";
  playing.setPlaying(false);
  session.flush();
}

function fail(key: string) {
  stop();
  errorKey.value = key;
  snackbar.error(t(key));
}

async function play() {
  if (!rom.value || !launchable.value || phase.value !== "idle") return;
  errorKey.value = null;
  const current = new AbortController();
  abort = current;
  phase.value = "loading";
  playing.setPlaying(true);
  bootTimer = setTimeout(() => fail("play.aram-error-runtime"), 120000);
  try {
    const userId = auth.user?.id;
    if (!userId) throw new Error("ARAM requires a signed-in user");
    if (rom.value.fs_size_bytes > ARAM_MAX_ROM_BYTES)
      throw new AramContentError("size");
    const content = aramContentRequest(rom.value);
    const data = await downloadAramContent(content.url, current.signal);
    if (current.signal.aborted || disposed) return;
    pendingLaunch = {
      channel: ARAM_CHANNEL,
      type: "launch",
      name: content.name,
      data,
      userId,
      theme: document.documentElement.classList.contains("r-v2-light")
        ? "light"
        : "dark",
      language: locale.value,
      touch: navigator.maxTouchPoints > 0,
    };
    frameVisible.value = true;
  } catch (error) {
    if (current.signal.aborted || disposed) return;
    fail(
      error instanceof AramContentError && error.reason === "size"
        ? "play.aram-error-size"
        : error instanceof AramContentError && error.reason === "format"
          ? "play.aram-error-format"
          : "play.aram-error-runtime",
    );
  }
}

function onMessage(event: MessageEvent<unknown>) {
  if (
    event.origin !== window.location.origin ||
    event.source !== frame.value?.contentWindow ||
    !isAramHostEvent(event.data) ||
    phase.value === "idle"
  )
    return;
  if (event.data.type === "ready" && pendingLaunch) {
    const packet = pendingLaunch;
    pendingLaunch = null;
    frame.value?.contentWindow?.postMessage(packet, window.location.origin, [
      packet.data,
    ]);
  } else if (
    event.data.type === "started" &&
    phase.value === "loading" &&
    !pendingLaunch
  ) {
    clearBootTimer();
    phase.value = "running";
    if (rom.value) session.start(rom.value);
    frame.value?.focus();
  } else if (event.data.type === "error") {
    fail("play.aram-error-runtime");
  }
}

async function fullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await stage.value?.requestFullscreen();
  } catch {
    snackbar.error(t("play.aram-error-runtime"));
  }
}

function back() {
  void router.push({ name: ROUTES.ROM, params: { rom: route.params.rom } });
}

// The app's gamepad navigation emits arrow keys against the focused button.
function navigateControls(event: KeyboardEvent) {
  if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key))
    return;
  const buttons = Array.from(
    controls.value?.querySelectorAll<HTMLButtonElement>(
      "button:not(:disabled)",
    ) ?? [],
  );
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0 || !buttons.length) return;
  event.preventDefault();
  const step = ["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1;
  buttons[(index + step + buttons.length) % buttons.length]?.focus();
}

function beforeUnload(event: BeforeUnloadEvent) {
  if (phase.value !== "running") return;
  event.preventDefault();
  event.returnValue = "";
}

async function confirmExit() {
  if (phase.value !== "running") return true;
  return confirm({
    title: t("play.quit"),
    body: t("play.aram-exit-warning"),
    confirmText: t("play.quit"),
    tone: "warning",
  });
}

onBeforeRouteLeave(confirmExit);
onBeforeRouteUpdate(async (to, from) => {
  if (to.params.rom === from.params.rom) return true;
  if (!(await confirmExit())) return false;
  stop();
  return true;
});

async function loadRom(id: number) {
  const sequence = ++loadSequence;
  loading.value = true;
  errorKey.value = null;
  if (rom.value?.id !== id) rom.value = null;
  try {
    const [response] = await Promise.all([
      romApi.getRom({ romId: id }),
      runtime.checkRuntime(),
    ]);
    if (disposed || sequence !== loadSequence) return;
    rom.value = response.data;
  } catch {
    if (!disposed && sequence === loadSequence) {
      rom.value = null;
      errorKey.value = "play.stream-error-load-rom";
    }
  } finally {
    if (!disposed && sequence === loadSequence) {
      loading.value = false;
      await nextTick();
      controls.value
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus();
    }
  }
}

watch(
  () => route.params.rom,
  (id) => {
    if (route.name === ROUTES.ARAM) void loadRom(Number(id));
  },
);
onMounted(() => {
  window.addEventListener("message", onMessage);
  window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener("pagehide", session.flush);
  void loadRom(Number(route.params.rom));
});

onBeforeUnmount(() => {
  disposed = true;
  stop();
  window.removeEventListener("message", onMessage);
  window.removeEventListener("beforeunload", beforeUnload);
  window.removeEventListener("pagehide", session.flush);
});
</script>

<template>
  <section class="r-v2-aram">
    <RSkeletonBlock v-if="loading && !rom" height="320px" />
    <div v-if="phase === 'idle'" class="r-v2-aram__config">
      <aside v-if="rom" class="d-flex flex-column align-center ga-3">
        <GameCover
          class="r-v2-aram__cover"
          :rom="rom"
          :title="title"
          :identified="rom.is_identified"
          :morph-id="String(rom.id)"
          style-context="player"
          morph-static
        />
        <h1 class="r-v2-aram__title">
          {{ title }}
        </h1>
        <p>{{ rom.platform_custom_name || rom.platform_display_name }}</p>
      </aside>
      <RCard class="pa-5" variant="flat">
        <div ref="controls" class="d-flex flex-column ga-4">
          <h2>ARAM {{ ARAM_VERSION }}</h2>
          <RAlert type="info">
            {{ t("play.aram-save-notice") }}
          </RAlert>
          <RAlert v-if="!loading && !runtime.available" type="warning">
            {{ t("play.aram-not-installed") }}
          </RAlert>
          <RAlert v-else-if="!loading && rom && !supported" type="warning">
            {{ t("play.aram-error-format") }}
          </RAlert>
          <RAlert v-if="errorKey" type="error">
            {{ t(errorKey) }}
          </RAlert>
          <RBtn
            block
            size="large"
            variant="flat"
            color="primary"
            prepend-icon="mdi-play-circle"
            :disabled="!launchable"
            :loading="loading"
            @click="play"
            @keydown="navigateControls"
          >
            {{ t("play.play") }}
          </RBtn>
          <RBtn
            block
            variant="text"
            prepend-icon="mdi-arrow-left"
            @click="back"
            @keydown="navigateControls"
          >
            {{ t("play.back-to-game-details") }}
          </RBtn>
        </div>
      </RCard>
    </div>
    <div v-else ref="stage" class="r-v2-aram__stage d-flex flex-column">
      <div class="r-v2-aram__toolbar d-flex align-center flex-wrap ga-2 pa-2">
        <span class="flex-grow-1">{{ title }}</span>
        <RBtn
          variant="translucent"
          prepend-icon="mdi-fullscreen"
          @click="fullscreen"
        >
          {{ t("play.full-screen") }}
        </RBtn>
        <RBtn
          variant="translucent"
          prepend-icon="mdi-exit-to-app"
          @click="back"
        >
          {{ t("play.quit") }}
        </RBtn>
      </div>
      <div
        v-if="phase === 'loading'"
        class="r-v2-aram__loading d-flex align-center justify-center ga-3"
        role="status"
      >
        <RSpinner :size="24" />{{ t("common.loading") }}
      </div>
      <iframe
        v-if="frameVisible"
        ref="frame"
        class="r-v2-aram__frame"
        src="/aram.html"
        :title="`ARAM: ${title}`"
        sandbox="allow-scripts allow-same-origin allow-downloads"
        allow="autoplay; fullscreen; gamepad"
        referrerpolicy="no-referrer"
      />
    </div>
  </section>
</template>

<style scoped>
.r-v2-aram {
  padding: 24px var(--r-row-pad);
  min-height: calc(100dvh - var(--r-nav-h));
}
.r-v2-aram__config {
  display: grid;
  grid-template-columns: minmax(180px, 300px) minmax(0, 580px);
  gap: 32px;
  justify-content: center;
}
.r-v2-aram__cover {
  width: min(100%, 240px);
}
.r-v2-aram__title {
  font-size: 1.4rem;
  overflow-wrap: anywhere;
  text-align: center;
}
.r-v2-aram__stage {
  position: relative;
  height: calc(100dvh - var(--r-nav-h) - 48px);
  min-height: 360px;
  background: var(--r-color-canvas-bg);
}
.r-v2-aram__stage:fullscreen {
  height: 100dvh;
}
.r-v2-aram__toolbar {
  background: var(--r-color-surface);
  color: var(--r-color-fg);
}
.r-v2-aram__toolbar > span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.r-v2-aram__frame {
  border: 0;
  width: 100%;
  min-height: 0;
  flex: 1;
}
.r-v2-aram__loading {
  padding: 16px;
  color: var(--r-color-fg);
  background: var(--r-color-bg);
}
html[data-bp~="sm-and-down"] .r-v2-aram__config {
  grid-template-columns: minmax(0, 1fr);
  gap: 20px;
}
html[data-bp~="xs"] .r-v2-aram__cover {
  width: 140px;
}
</style>
