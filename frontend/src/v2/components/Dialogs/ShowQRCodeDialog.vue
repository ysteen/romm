<script setup lang="ts">
// ShowQRCodeDialog: emitter-driven QR for downloading a single ROM from a
// handheld/phone.
import { RDialog, RAlert } from "@v2/lib";
import { useQRCode } from "@vueuse/integrations/useQRCode";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { DetailedRomSchema } from "@/__generated__";
import api from "@/services/api";
import RomForgePanel from "@/v2/components/GameDetails/RomForgePanel.vue";
import type { SimpleRom } from "@/stores/roms";
import { getNintendoDSFiles, getDownloadLink, isNintendoDSFile } from "@/utils";
import { useEmitterEvent } from "@/v2/composables/useEmitterEvent";
import { colorCanvas, colorOverlay } from "@/v2/tokens";

defineOptions({ inheritAttrs: false });

const { t } = useI18n();
const show = ref(false);
const rom = ref<SimpleRom | null>(null);
const installRom = ref<DetailedRomSchema | null>(null);
const loading = ref(false);
const loadError = ref(false);
let openGeneration = 0;

const downloadLink = computed(() => {
  if (!rom.value) return "";
  const isNDSFile = isNintendoDSFile(rom.value);
  const [dsFile] = getNintendoDSFiles(rom.value);
  return getDownloadLink({
    rom: rom.value,
    fileIDs: isNDSFile || !dsFile ? [] : [dsFile.id],
  });
});

// Rendered at 2x the largest display size so it stays sharp on HiDPI screens.
const qrCode = useQRCode(downloadLink, {
  margin: 1,
  width: 600,
  color: {
    dark: colorCanvas.bgDeep,
    light: colorOverlay.emphasisBg,
  },
});
// useQRCode keeps the previous image until the new one resolves; drop it so
// the next ROM never briefly shows the last ROM's code.
watch(downloadLink, () => (qrCode.value = ""));

const openHandler = async (romToView: SimpleRom) => {
  show.value = true;
  rom.value = romToView;
  installRom.value = null;
  loadError.value = false;
  loading.value = false;
  const generation = ++openGeneration;
  if (["3ds", "new-nintendo-3ds"].includes(romToView.platform_slug)) {
    loading.value = true;
    try {
      const { data } = await api.get<DetailedRomSchema>(
        `/roms/${romToView.id}`,
      );
      if (generation === openGeneration) installRom.value = data;
    } catch {
      if (generation === openGeneration) loadError.value = true;
    } finally {
      if (generation === openGeneration) loading.value = false;
    }
    return;
  }

};
useEmitterEvent("showQRCodeDialog", (payload) => {
  void openHandler(payload);
});

function closeDialog() {
  openGeneration++;
  loading.value = false;
  installRom.value = null;
  show.value = false;
  rom.value = null;
}
</script>

<template>
  <RDialog v-model="show" icon="mdi-qrcode" width="380" @close="closeDialog">
    <template #header>
      <span>{{ t("rom.qr-scan-to-download") }}</span>
    </template>
    <template #content>
      <RAlert v-if="loadError" type="error">
        {{ t("common.unknown-error") }}
      </RAlert>
      <p v-else-if="loading">
        {{ t("patcher.status-preparing") }}
      </p>
      <RomForgePanel
        v-else-if="installRom"
        :rom="installRom"
        initial-operation="3ds-convert"
      />
      <div v-else class="r-v2-qr">
        <p v-if="rom" class="r-v2-qr__name" :title="rom.name ?? undefined">
          {{ rom.name }}
        </p>
        <p v-if="rom" class="r-v2-qr__filename" :title="rom.fs_name">
          {{ rom.fs_name }}
        </p>
        <div class="r-v2-qr__code-wrap">
          <img
            v-if="qrCode"
            :src="qrCode"
            :alt="t('rom.qr-scan-to-download')"
            class="r-v2-qr__code"
          />
        </div>
      </div>
    </template>
  </RDialog>
</template>

<style scoped>
.r-v2-qr {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 4px;
}

.r-v2-qr__name {
  margin: 0;
  font-size: var(--r-font-size-md);
  font-weight: var(--r-font-weight-semibold);
  color: var(--r-color-fg);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
}

.r-v2-qr__filename {
  margin: 0;
  font-size: 11px;
  color: var(--r-color-brand-primary);
  font-family: var(--r-font-family-mono, monospace);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
}

.r-v2-qr__code-wrap {
  box-sizing: content-box;
  width: 220px;
  height: 220px;
  margin: 20px 0px 0px;
  padding: 6px;
  background: var(--r-color-overlay-emphasis-bg);
  border-radius: var(--r-radius-md);
  box-shadow: 0 8px 20px color-mix(in srgb, black 35%, transparent);
  display: grid;
  place-items: center;
}

html[data-bp~="lg-and-up"] .r-v2-qr__code-wrap {
  width: 300px;
  height: 300px;
}

.r-v2-qr__code {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
