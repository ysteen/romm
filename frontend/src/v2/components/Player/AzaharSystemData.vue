<script setup lang="ts">
import { RAlert, RBtn } from "@v2/lib";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { FirmwareSchema } from "@/__generated__";
import { AZAHAR_SYSTEM_FIRMWARE_NAME } from "@/v2/utils/playerFirmware";

interface Props {
  firmware: FirmwareSchema | null;
  platformFsSlug: string;
}
const props = defineProps<Props>();
const { t } = useI18n();
const serverPaths = computed(() =>
  props.firmware
    ? [`${props.firmware.file_path}/${props.firmware.file_name}`]
    : [
        `bios/${props.platformFsSlug}/${AZAHAR_SYSTEM_FIRMWARE_NAME}`,
        `${props.platformFsSlug}/bios/${AZAHAR_SYSTEM_FIRMWARE_NAME}`,
      ],
);
</script>

<template>
  <div class="r-azahar-system">
    <strong>{{ t("play.azahar-system-title") }}</strong>
    <p>{{ t("play.azahar-system-notice") }}</p>
    <p>{{ t("play.azahar-system-path") }}</p>
    <code
      v-for="path in serverPaths"
      :key="path"
      class="r-azahar-system__server-path"
      v-text="path"
    />
    <RAlert :type="firmware ? 'success' : 'info'" density="compact">
      {{
        firmware
          ? t("play.azahar-system-registered", { file: firmware.file_name })
          : t("play.azahar-system-missing")
      }}
    </RAlert>
    <details>
      <summary>{{ t("play.azahar-system-guide") }}</summary>
      <ol>
        <li>{{ t("play.azahar-system-step-dump") }}</li>
        <li>{{ t("play.azahar-system-step-zip") }}</li>
        <li>{{ t("play.azahar-system-step-play") }}</li>
      </ol>
      <code
        >nand/00000000000000000000000000000000/title/0004009b/00010202/content/</code
      >
      <p>{{ t("play.azahar-system-warning") }}</p>
      <RBtn
        href="https://github.com/d0k3/GodMode9#readme"
        target="_blank"
        rel="noopener noreferrer"
        variant="text"
        size="small"
        append-icon="mdi-open-in-new"
      >
        {{ t("play.azahar-system-source") }}
      </RBtn>
    </details>
  </div>
</template>

<style scoped>
.r-azahar-system {
  display: grid;
  gap: var(--r-space-3);
  color: var(--r-color-fg-secondary);
  font-size: var(--r-font-size-sm);
}
.r-azahar-system p {
  margin: 0;
}
.r-azahar-system strong {
  color: var(--r-color-fg);
}
.r-azahar-system code {
  overflow-wrap: anywhere;
}
.r-azahar-system summary {
  cursor: pointer;
  color: var(--r-color-fg);
}
.r-azahar-system summary:focus-visible {
  outline: 2px solid var(--r-color-brand-primary);
  outline-offset: 2px;
}
.r-azahar-system ol {
  padding-inline-start: var(--r-space-5);
}
.r-azahar-system li {
  margin-block: var(--r-space-2);
}
</style>
