<script setup lang="ts">
import { RAlert, RBtn, RSelect } from "@v2/lib";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { StateSchema } from "@/__generated__";
import stateApi from "@/services/api/state";
import storeRoms, { type DetailedRom } from "@/stores/roms";
import { useCan } from "@/v2/composables/useCan";
import { useConfirm } from "@/v2/composables/useConfirm";
import { useSnackbar } from "@/v2/composables/useSnackbar";
import {
  assertStateOperationActive,
  azaharStateFilename,
  captureAzaharState,
  downloadAzaharState,
  getAzaharStateRuntime,
  MAX_AZAHAR_STATE_BYTES,
  restoreAzaharState,
  type AzaharStateRuntime,
} from "@/v2/utils/azaharState";

interface Props {
  rom: DetailedRom;
  initialState?: StateSchema | null;
}

const props = defineProps<Props>();
const emit = defineEmits<{ "update:rom": [rom: DetailedRom] }>();
const { t } = useI18n();
const canPlay = useCan("rom.play");
const confirm = useConfirm();
const snackbar = useSnackbar();
const romsStore = storeRoms();
const controls = ref<HTMLElement | null>(null);
const ready = ref(false);
const busy = ref<"save" | "load" | null>(null);
const selectedId = ref<number | null>(null);
const uploadedStates = ref<StateSchema[]>([]);
let disposed = false;
let initialAttempted = false;
let controller: AbortController | null = null;
let readinessTimer: ReturnType<typeof setInterval> | undefined;

const states = computed(() => {
  const merged = new Map<number, StateSchema>();
  for (const state of [...props.rom.user_states, ...uploadedStates.value]) {
    if (
      state.emulator === "azahar" &&
      state.rom_id === props.rom.id &&
      !state.missing_from_fs
    ) {
      merged.set(state.id, state);
    }
  }
  return [...merged.values()].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );
});
const stateItems = computed(() =>
  states.value.map((state) => ({
    title: state.file_name,
    value: state.id,
  })),
);
const selectedState = computed(() =>
  states.value.find((state) => state.id === selectedId.value),
);

function currentRuntime() {
  const candidate: unknown = window.EJS_emulator;
  return getAzaharStateRuntime(candidate);
}

function isSameSession(runtime: AzaharStateRuntime, romId: number): boolean {
  return !disposed && props.rom.id === romId && window.EJS_emulator === runtime;
}

function setSelectedState(value: unknown) {
  selectedId.value = typeof value === "number" ? value : null;
}

function navigateControls(event: KeyboardEvent) {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  if (
    event.target instanceof HTMLElement &&
    event.target.closest(
      'button[aria-haspopup="listbox"][aria-expanded="true"]',
    )
  ) {
    return;
  }
  const elements = controls.value?.querySelectorAll<HTMLElement>(
    "button:not(:disabled)",
  );
  if (!elements?.length) return;
  const items = Array.from(elements);
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (index < 0) return;
  event.preventDefault();
  event.stopPropagation();
  items[
    (index + (event.key === "ArrowRight" ? 1 : -1) + items.length) %
      items.length
  ]?.focus();
}

function activeCheck(runtime: AzaharStateRuntime, romId: number) {
  return () => isSameSession(runtime, romId) && runtime.started;
}

async function saveState() {
  if (busy.value || !canPlay.value) return;
  const runtime = currentRuntime();
  if (!runtime) {
    snackbar.error(t("play.azahar-state-unavailable"));
    return;
  }
  const rom = props.rom;
  const operation = new AbortController();
  controller = operation;
  busy.value = "save";
  const check = activeCheck(runtime, rom.id);
  try {
    const { data, screenshot } = await captureAzaharState(
      runtime,
      operation.signal,
      check,
    );
    assertStateOperationActive(operation.signal, check);
    const filename = azaharStateFilename(rom.id);
    const results = await stateApi.uploadStates({
      rom,
      emulator: "azahar",
      statesToUpload: [
        {
          stateFile: new File([data], filename),
          screenshotFile: screenshot
            ? new File([screenshot], `${filename}.png`, { type: "image/png" })
            : undefined,
        },
      ],
    });
    assertStateOperationActive(operation.signal, check);
    const result = results[0];
    if (!result || result.status === "rejected") {
      throw new Error("RomM state upload failed");
    }
    const state = result.value;
    uploadedStates.value.push(state);
    selectedId.value = state.id;
    const updated = {
      ...props.rom,
      user_states: [...props.rom.user_states, state],
    };
    romsStore.update(updated);
    emit("update:rom", updated);
    snackbar.success(t("play.azahar-state-saved"));
  } catch (error) {
    if (!operation.signal.aborted && isSameSession(runtime, rom.id)) {
      console.error("Azahar state save failed", error);
      snackbar.error(t("play.azahar-state-error-save"));
    }
  } finally {
    if (controller === operation) {
      controller = null;
      busy.value = null;
    }
  }
}

async function loadState(state: StateSchema, initial = false) {
  if (busy.value || !canPlay.value) return;
  const runtime = currentRuntime();
  if (!runtime) {
    snackbar.error(t("play.azahar-state-unavailable"));
    return;
  }
  const romId = props.rom.id;
  const operation = new AbortController();
  controller = operation;
  busy.value = "load";
  const check = activeCheck(runtime, romId);
  try {
    if (initial) {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    } else {
      const accepted = await confirm({
        title: t("play.azahar-state-load"),
        body: t("play.azahar-state-confirm"),
        confirmText: t("play.azahar-state-load"),
        tone: "danger",
      });
      if (!accepted) return;
    }
    assertStateOperationActive(operation.signal, check);
    if (
      state.rom_id !== romId ||
      state.emulator !== "azahar" ||
      state.missing_from_fs ||
      state.file_size_bytes > MAX_AZAHAR_STATE_BYTES
    ) {
      throw new Error("Incompatible Azahar state");
    }
    const data = await downloadAzaharState(
      state.download_path,
      operation.signal,
    );
    assertStateOperationActive(operation.signal, check);
    await restoreAzaharState(runtime, data, operation.signal, check);
    snackbar.success(t("play.azahar-state-loaded"));
  } catch (error) {
    if (!operation.signal.aborted && isSameSession(runtime, romId)) {
      console.error("Azahar state load failed", error);
      snackbar.error(t("play.azahar-state-error-load"));
    }
  } finally {
    if (controller === operation) {
      controller = null;
      busy.value = null;
    }
  }
}

function loadSelectedState() {
  if (selectedState.value) void loadState(selectedState.value);
}

function checkReadiness() {
  ready.value = currentRuntime() !== null;
  if (ready.value && canPlay.value && !busy.value && !initialAttempted) {
    initialAttempted = true;
    if (props.initialState) {
      selectedId.value = props.initialState.id;
      void loadState(props.initialState, true);
    }
  }
}

watch(
  () => props.rom.id,
  () => {
    controller?.abort();
    controller = null;
    busy.value = null;
    uploadedStates.value = [];
    selectedId.value = null;
    initialAttempted = false;
    checkReadiness();
  },
);

onMounted(() => {
  checkReadiness();
  readinessTimer = setInterval(checkReadiness, 500);
});

onBeforeUnmount(() => {
  disposed = true;
  controller?.abort();
  if (readinessTimer) clearInterval(readinessTimer);
});
</script>

<template>
  <section v-if="canPlay" class="r-v2-azahar-states d-flex flex-column ga-3">
    <RAlert type="info" density="compact">
      {{ t("play.azahar-state-notice") }}
    </RAlert>
    <div
      ref="controls"
      class="d-flex align-end flex-wrap ga-3"
      :aria-busy="!!busy"
    >
      <RBtn
        class="r-v2-azahar-states__save"
        prepend-icon="mdi-content-save-outline"
        :disabled="!ready || !!busy"
        :loading="busy === 'save'"
        @keydown="navigateControls"
        @click="saveState"
      >
        {{ t("play.azahar-state-save") }}
      </RBtn>
      <RSelect
        class="r-v2-azahar-states__select"
        :model-value="selectedId"
        :items="stateItems"
        :label="t('play.select-state')"
        :placeholder="t('play.no-states-available')"
        :disabled="!!busy || !stateItems.length"
        hide-details
        @update:model-value="setSelectedState"
        @keydown="navigateControls"
      />
      <RBtn
        class="r-v2-azahar-states__load"
        prepend-icon="mdi-restore"
        :disabled="!ready || !!busy || !selectedState"
        :loading="busy === 'load'"
        @keydown="navigateControls"
        @click="loadSelectedState"
      >
        {{ t("play.azahar-state-load") }}
      </RBtn>
    </div>
    <p v-if="!ready" class="r-v2-azahar-states__hint ma-0" role="status">
      {{ t("play.azahar-state-unavailable") }}
    </p>
  </section>
</template>

<style scoped>
.r-v2-azahar-states {
  flex-shrink: 0;
  min-width: 0;
  color: var(--r-color-fg);
  padding: var(--r-space-3);
  /* The game canvas is always black, including in the light theme. */
  background: var(--r-color-bg);
}

.r-v2-azahar-states__select {
  flex: 1 1 240px;
  min-width: 0;
}

.r-v2-azahar-states__hint {
  color: var(--r-color-fg-muted);
  font-size: var(--r-font-size-sm);
}

html[data-bp~="xs"] .r-v2-azahar-states__select,
html[data-bp~="xs"] .r-v2-azahar-states__save,
html[data-bp~="xs"] .r-v2-azahar-states__load {
  flex-basis: 100%;
}
</style>
