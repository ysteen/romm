<script setup lang="ts">
import { RBtn, RChip, RList, RListItem, RProgressLinear } from "@v2/lib";
import { useI18n } from "vue-i18n";
import type { RomForgeJobSchema } from "@/__generated__";
import { ROUTES } from "@/plugins/routeNames";
import { formatTimestamp } from "@/utils";

defineProps<{
  jobs: RomForgeJobSchema[];
  available: boolean;
  emptyText: string;
}>();

const { t, locale } = useI18n();
const tones = {
  queued: "warning",
  running: "info",
  completed: "success",
  failed: "danger",
};
const operations: Record<string, string> = {
  patch: "patcher.binary-patch",
  "3ds-repack": "patcher.repack-3ds",
  "3ds-convert": "patcher.install-cia",
  "3ds-normalize": "romforge.normalize-3ds",
};
const stages: Record<string, string> = {
  hashing: "patcher.job-hashing",
  patching: "romforge.processing",
  saving: "patcher.job-saving",
};
</script>

<template>
  <p v-if="!jobs.length" class="romforge-jobs__empty">{{ emptyText }}</p>
  <RList v-else class="romforge-jobs">
    <RListItem v-for="job in jobs" :key="job.id" :data-job-id="job.id">
      <template #title>
        <span class="romforge-jobs__heading">
          <RBtn
            v-if="job.rom_id"
            :to="{ name: ROUTES.ROM, params: { rom: job.rom_id } }"
            variant="text"
            size="small"
            class="romforge-jobs__source"
          >
            {{ job.source_name }}
          </RBtn>
          <span v-else>{{
            job.source_name || t("romforge.source-unavailable")
          }}</span>
          <RChip :color="tones[job.status]" size="small">
            {{ t(`settings.${job.status}`) }}
          </RChip>
        </span>
      </template>
      <template #subtitle>
        <span class="romforge-jobs__details">
          <span>{{
            operations[job.operation]
              ? t(operations[job.operation])
              : job.operation
          }}</span>
          <span v-if="job.status === 'running' && stages[job.stage]">
            {{ t(stages[job.stage]) }}
          </span>
          <time :datetime="job.ended_at || job.started_at || job.created_at">
            {{
              formatTimestamp(
                job.ended_at || job.started_at || job.created_at,
                locale,
              )
            }}
          </time>
        </span>
      </template>
      <RProgressLinear
        v-if="job.status === 'running' && available"
        indeterminate
        :aria-label="t('settings.running')"
        class="romforge-jobs__progress"
      />
      <span v-if="job.error" class="romforge-jobs__error">{{ job.error }}</span>
      <span v-if="job.status === 'completed'" class="romforge-jobs__result">
        <RBtn
          v-if="job.output_rom_id"
          :to="{ name: ROUTES.ROM, params: { rom: job.output_rom_id } }"
          variant="text"
          size="small"
          prepend-icon="mdi-open-in-new"
        >
          {{ job.output_file_name || t("patcher.open-result") }}
        </RBtn>
        <span v-else-if="job.download_ready">{{
          t("romforge.output-ready")
        }}</span>
        <span v-if="job.reused">{{ t("patcher.job-reused") }}</span>
      </span>
    </RListItem>
  </RList>
</template>

<style scoped>
.romforge-jobs__empty {
  margin: 0;
  padding: var(--r-space-5);
  color: var(--r-color-fg-muted);
}
.romforge-jobs :deep(.r-list-item) {
  padding: var(--r-space-4);
  border-bottom: 1px solid var(--r-color-border);
}
.romforge-jobs :deep(.r-list-item-wrap:last-child .r-list-item) {
  border-bottom: 0;
}
.romforge-jobs__heading,
.romforge-jobs__details,
.romforge-jobs__result {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--r-space-2) var(--r-space-3);
  overflow-wrap: anywhere;
}
.romforge-jobs__heading {
  justify-content: space-between;
}
.romforge-jobs__source {
  min-width: 0;
  max-width: 100%;
  height: auto;
  white-space: normal;
  text-align: left;
}
.romforge-jobs__source :deep(.r-btn__content) {
  white-space: normal;
  overflow-wrap: anywhere;
}
.romforge-jobs__details {
  margin-top: var(--r-space-2);
  color: var(--r-color-fg-muted);
  font-size: var(--r-font-size-sm);
}
.romforge-jobs__progress,
.romforge-jobs__result,
.romforge-jobs__error {
  margin-top: var(--r-space-3);
}
.romforge-jobs__result {
  color: var(--r-color-fg-muted);
  font-size: var(--r-font-size-sm);
}
.romforge-jobs__result :deep(.r-btn) {
  max-width: 100%;
  height: auto;
  white-space: normal;
}
.romforge-jobs__error {
  display: block;
  color: var(--r-color-danger);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
</style>
