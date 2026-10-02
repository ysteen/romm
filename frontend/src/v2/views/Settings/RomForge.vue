<script setup lang="ts">
import { RAlert, RBtn, RChip, RSkeletonBlock } from "@v2/lib";
import { useDocumentVisibility } from "@vueuse/core";
import { computed, onScopeDispose, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { RomForgeStatus } from "@/__generated__";
import api from "@/services/api";
import storeAuth from "@/stores/auth";
import { formatTimestamp } from "@/utils";
import RomForgeJobs from "@/v2/components/Settings/RomForgeJobs.vue";
import SettingsSection from "@/v2/components/Settings/SettingsSection.vue";
import { useCan } from "@/v2/composables/useCan";
import { useIsAlive } from "@/v2/composables/useIsAlive";

const { t, locale } = useI18n();
const auth = storeAuth();
const isAdmin = useCan("app.admin");
const canView = computed(
  () => isAdmin.value && auth.scopes.includes("tasks.run"),
);
const alive = useIsAlive();
const visibility = useDocumentVisibility();
const status = ref<RomForgeStatus | null>(null);
const loading = ref(false);
const failed = ref(false);
const updatedAt = ref<string | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
const abort = new AbortController();

const workerState = computed(() => {
  if (!status.value?.worker.enabled) return "disabled";
  return status.value.worker.available ? "online" : "offline";
});
const metrics = computed(() => [
  {
    label: t("settings.running"),
    count:
      status.value?.active.filter((job) => job.status === "running").length ??
      0,
  },
  {
    label: t("settings.queued"),
    count:
      status.value?.active.filter((job) => job.status === "queued").length ?? 0,
  },
  {
    label: t("romforge.pending-normalizations"),
    count: status.value?.pending_normalizations ?? 0,
  },
]);
const normalizationNotice = computed(() => {
  const data = status.value;
  if (!data?.pending_normalizations) return null;
  if (!data.worker.normalize_on_scan) return "romforge.normalization-disabled";
  if (!data.worker.keys_ready) return "romforge.waiting-keys";
  if (data.scan_running) return "romforge.waiting-scan";
  return null;
});

async function refresh() {
  clearTimeout(timer);
  if (!canView.value || !alive.value || loading.value) return;
  loading.value = true;
  try {
    const { data } = await api.get<RomForgeStatus>("/roms/patcher/status", {
      signal: abort.signal,
    });
    if (!alive.value || !canView.value) return;
    status.value = data;
    updatedAt.value = new Date().toISOString();
    failed.value = false;
  } catch {
    if (alive.value && canView.value) failed.value = true;
  } finally {
    if (alive.value) {
      loading.value = false;
      if (canView.value && visibility.value === "visible")
        timer = setTimeout(refresh, 5000);
    }
  }
}

watch(
  [canView, visibility],
  () => {
    clearTimeout(timer);
    if (!canView.value) {
      status.value = null;
      updatedAt.value = null;
    } else if (visibility.value === "visible") {
      void refresh();
    }
  },
  { immediate: true },
);

onScopeDispose(() => {
  clearTimeout(timer);
  abort.abort();
});
</script>

<template>
  <div class="romforge">
    <header class="romforge__header">
      <div>
        <h1 class="romforge__title">{{ t("romforge.title") }}</h1>
        <p class="romforge__subtitle">{{ t("romforge.subtitle") }}</p>
      </div>
      <RBtn
        v-if="canView"
        prepend-icon="mdi-refresh"
        variant="outlined"
        :loading="loading"
        @click="refresh"
      >
        {{ t("romforge.refresh") }}
      </RBtn>
    </header>

    <RAlert v-if="!canView" type="warning">{{
      t("romforge.access-denied")
    }}</RAlert>
    <template v-else>
      <RAlert v-if="failed" type="error" role="alert">{{
        t("romforge.load-error")
      }}</RAlert>
      <div
        v-if="!status && loading"
        class="romforge__skeleton"
        :aria-label="t('common.loading-ellipsis')"
        aria-busy="true"
      >
        <RSkeletonBlock height="100px" />
        <RSkeletonBlock height="180px" />
        <RSkeletonBlock height="180px" />
      </div>
      <template v-if="status">
        <SettingsSection :title="t('romforge.worker')" icon="mdi-hammer-wrench">
          <template #header-actions>
            <RChip
              :color="workerState === 'online' ? 'success' : 'warning'"
              size="small"
            >
              {{ t(`romforge.worker-${workerState}`) }}
            </RChip>
          </template>
          <dl class="romforge__metrics">
            <div
              v-for="metric in metrics"
              :key="metric.label"
              class="romforge__metric"
            >
              <dt>{{ metric.label }}</dt>
              <dd>{{ metric.count }}</dd>
            </div>
          </dl>
          <p class="romforge__note">
            {{ t("romforge.automatic-normalization") }}:
            {{
              t(
                status.worker.normalize_on_scan
                  ? "console.enabled"
                  : "console.disabled",
              )
            }}
          </p>
        </SettingsSection>
        <RAlert v-if="workerState !== 'online'" type="warning">
          {{ t(`romforge.worker-${workerState}-info`) }}
        </RAlert>
        <RAlert v-if="normalizationNotice" type="info">{{
          t(normalizationNotice)
        }}</RAlert>

        <SettingsSection
          :title="t('romforge.active')"
          icon="mdi-progress-clock"
        >
          <RomForgeJobs
            :jobs="status.active"
            :available="status.worker.available"
            :empty-text="t('romforge.no-active')"
          />
        </SettingsSection>
        <SettingsSection :title="t('romforge.recent')" icon="mdi-history">
          <p class="romforge__note">
            {{
              t("romforge.history-hint", {
                count: status.history_limit,
                days: status.retention_days,
              })
            }}
          </p>
          <RomForgeJobs
            :jobs="status.history"
            :available="status.worker.available"
            :empty-text="t('romforge.no-history')"
          />
        </SettingsSection>
        <p v-if="updatedAt" class="romforge__updated">
          {{
            t("romforge.updated-at", {
              time: formatTimestamp(updatedAt, locale),
            })
          }}
        </p>
      </template>
    </template>
  </div>
</template>

<style scoped>
.romforge,
.romforge__skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--r-space-4);
  min-width: 0;
}
.romforge__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--r-space-3);
}
.romforge__title {
  margin: 0;
  font-size: var(--r-font-size-xl);
  font-weight: var(--r-font-weight-bold);
}
.romforge__subtitle,
.romforge__updated {
  margin: var(--r-space-2) 0 0;
  color: var(--r-color-fg-muted);
  font-size: var(--r-font-size-sm);
}
.romforge__metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--r-space-4);
  margin: 0;
  padding: var(--r-space-5);
}
.romforge__metric {
  display: flex;
  flex-direction: column;
  gap: var(--r-space-2);
}
.romforge__metric dt {
  font-size: var(--r-font-size-sm);
  color: var(--r-color-fg-muted);
}
.romforge__metric dd {
  margin: 0;
  font-size: var(--r-font-size-2xl);
  font-weight: var(--r-font-weight-bold);
  font-variant-numeric: tabular-nums;
}
.romforge__note {
  margin: 0;
  padding: var(--r-space-3) var(--r-space-4);
  font-size: var(--r-font-size-sm);
  color: var(--r-color-fg-muted);
  border-top: 1px solid var(--r-color-border);
}
html[data-bp~="xs"] .romforge__metrics {
  grid-template-columns: 1fr;
}
</style>
