<script setup lang="ts">
import { RAlert, RBtn, RDropzone, RImg, RSelect } from "@v2/lib";
import qrcode from "qrcode";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type {
  DetailedRomSchema,
  PatchJobSchema,
  PatchDownloadLink,
  PatchWorkerCapabilities,
} from "@/__generated__";
import api from "@/services/api";
import { formatBytes } from "@/utils";
import { useCan } from "@/v2/composables/useCan";

const props = defineProps<{
  rom: DetailedRomSchema;
  initialOperation?: string;
}>();
const { t } = useI18n();
const canUpload = useCan("rom.upload");
const capabilities = ref<PatchWorkerCapabilities | null>(null);
const sourceId = ref<number | null>(null);
const patchId = ref<number | null>(null);
const patchSource = ref("upload");
const upload = ref<File | null>(null);
const jobs = ref<PatchJobSchema[]>([]);
const error = ref("");
const submitting = ref(false);
const operation = ref(props.initialOperation ?? "patch");
const qr = ref("");
const downloadUrl = ref("");
const operations = computed(() => [
  { id: "patch", title: t("patcher.binary-patch") },
  { id: "3ds-repack", title: t("patcher.repack-3ds") },
  { id: "3ds-convert", title: t("patcher.install-cia") },
]);
const sourceLimit = computed(() =>
  operation.value === "patch"
    ? capabilities.value?.max_file_size
    : capabilities.value?.max_3ds_size,
);
watch(operation, () => {
  upload.value = null;
  patchId.value = null;
  qr.value = "";
  downloadUrl.value = "";
});
async function showInstall(job: PatchJobSchema) {
  try {
    const { data } = await api.post<PatchDownloadLink>(
      `/roms/${sourceId.value}/patch-jobs/${job.id}/download-link`,
    );
    downloadUrl.value = new URL(data.path, window.location.origin).href;
    qr.value = await qrcode.toDataURL(downloadUrl.value, {
      width: 240,
      margin: 2,
    });
  } catch (err) {
    error.value = errorDetail(err);
  }
}

const sourceFiles = computed(() =>
  props.rom.files.filter((file) => file.category === "game"),
);
const patchFiles = computed(() =>
  props.rom.files.filter((file) =>
    capabilities.value?.extensions.some((ext) =>
      file.file_name.toLowerCase().endsWith(ext),
    ),
  ),
);
const selectedSource = computed(() =>
  sourceFiles.value.find((file) => file.id === sourceId.value),
);
const patchSources = computed(() => [
  { id: "upload", label: t("common.upload") },
  { id: "library", label: t("common.library") },
]);
const active = computed(() =>
  jobs.value.some((job) => job.status === "queued" || job.status === "running"),
);
const canSubmit = computed(
  () =>
    canUpload.value &&
    capabilities.value?.available &&
    sourceId.value &&
    (operation.value !== "3ds-convert" ||
      (capabilities.value?.keys_ready && capabilities.value?.cia_ready)) &&
    (operation.value === "3ds-convert" ||
      (patchSource.value === "upload" ? upload.value : patchId.value)) &&
    !submitting.value &&
    !active.value,
);
const stages: Record<string, string> = {
  queued: "patcher.job-queued",
  hashing: "patcher.job-hashing",
  patching: "patcher.status-patching",
  saving: "patcher.job-saving",
  completed: "patcher.job-completed",
  failed: "patcher.job-failed",
};
let disposed = false;
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const abort = new AbortController();

function errorDetail(value: unknown): string {
  const err = value as {
    response?: { data?: { detail?: string } };
    message?: string;
  };
  return err.response?.data?.detail || err.message || t("common.unknown-error");
}

async function refresh() {
  const current = ++generation;
  const fileId = sourceId.value;
  try {
    const [caps, history] = await Promise.all([
      api.get<PatchWorkerCapabilities>("/roms/patcher/capabilities", {
        signal: abort.signal,
      }),
      fileId
        ? api.get<PatchJobSchema[]>(`/roms/${fileId}/patch-jobs`, {
            signal: abort.signal,
          })
        : null,
    ]);
    if (disposed || current !== generation) return;
    capabilities.value = caps.data;
    jobs.value = history?.data ?? [];
    error.value = "";
  } catch (err) {
    if (!disposed && current === generation) error.value = errorDetail(err);
  } finally {
    if (!disposed && current === generation) {
      clearTimeout(timer);
      timer = setTimeout(refresh, active.value ? 5000 : 15000);
    }
  }
}

watch(
  () => props.rom.id,
  () => {
    sourceId.value =
      sourceFiles.value.length === 1 ? sourceFiles.value[0].id : null;
    patchId.value = null;
    upload.value = null;
    qr.value = "";
    downloadUrl.value = "";
    jobs.value = [];
  },
  { immediate: true },
);
watch(
  sourceId,
  () => {
    jobs.value = [];
    qr.value = "";
    downloadUrl.value = "";
    clearTimeout(timer);
    void refresh();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  disposed = true;
  generation++;
  clearTimeout(timer);
  abort.abort();
});

async function submit() {
  if (!canSubmit.value || !sourceId.value) return;
  const fileId = sourceId.value;
  if (
    selectedSource.value &&
    capabilities.value &&
    selectedSource.value.file_size_bytes > (sourceLimit.value ?? 0)
  ) {
    error.value = t("patcher.romforge-limit", {
      rom: formatBytes(sourceLimit.value ?? 0),
      patch: formatBytes(capabilities.value.max_patch_size),
    });
    return;
  }
  if (
    operation.value !== "3ds-convert" &&
    patchSource.value === "upload" &&
    upload.value &&
    capabilities.value &&
    upload.value.size > capabilities.value.max_patch_size
  ) {
    error.value = t("patcher.romforge-limit", {
      rom: formatBytes(sourceLimit.value ?? 0),
      patch: formatBytes(capabilities.value.max_patch_size),
    });
    return;
  }
  submitting.value = true;
  error.value = "";
  const form = new FormData();
  form.append("operation", operation.value);
  form.append(
    "output_format",
    operation.value === "3ds-convert" ? "cia" : "cci",
  );
  if (
    operation.value !== "3ds-convert" &&
    patchSource.value === "upload" &&
    upload.value
  )
    form.append("patch_file", upload.value);
  else if (operation.value !== "3ds-convert" && patchId.value)
    form.append("patch_file_id", String(patchId.value));
  try {
    const response = await api.post<PatchJobSchema>(
      `/roms/${fileId}/patch-jobs`,
      form,
      { signal: abort.signal },
    );
    if (!disposed && sourceId.value === fileId) {
      jobs.value = [response.data, ...jobs.value];
      upload.value = null;
      await refresh();
    }
  } catch (err) {
    if (!disposed && sourceId.value === fileId) error.value = errorDetail(err);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="r-v2-section-stack">
    <RAlert type="info">
      {{ t("patcher.archive-info") }}
    </RAlert>
    <RAlert v-if="capabilities && !capabilities.available" type="warning">
      {{ t("patcher.worker-unavailable") }}
    </RAlert>
    <p v-if="capabilities">
      {{
        t("patcher.romforge-limit", {
          rom: formatBytes(sourceLimit ?? 0),
          patch: formatBytes(capabilities.max_patch_size),
        })
      }}
    </p>
    <RAlert v-if="error" type="error">
      {{ error }}
    </RAlert>
    <RSelect
      v-model="sourceId"
      :items="sourceFiles"
      item-title="file_name"
      item-value="id"
      :label="t('patcher.rom-file')"
      prefix-label="stacked"
      :disabled="submitting"
      hide-details
    />
    <RSelect
      v-model="operation"
      :items="operations"
      item-title="title"
      item-value="id"
      :label="t('patcher.operation')"
      prefix-label="stacked"
      :disabled="submitting || active"
      hide-details
    />
    <RAlert v-if="operation !== 'patch'" type="info">
      {{ t("patcher.threeds-info") }}
    </RAlert>
    <RAlert
      v-if="
        capabilities &&
        (!capabilities.keys_ready ||
          (operation === '3ds-convert' && !capabilities.cia_ready)) &&
        operation !== 'patch'
      "
      type="warning"
    >
      {{ t("patcher.keys-required") }}
    </RAlert>
    <template v-if="operation !== '3ds-convert'">
      <RSelect
        v-model="patchSource"
        :items="patchSources"
        item-title="label"
        item-value="id"
        :label="t('patcher.patch-file')"
        prefix-label="stacked"
        :disabled="submitting"
        hide-details
      />
      <RSelect
        v-if="patchSource === 'library'"
        v-model="patchId"
        :items="patchFiles"
        item-title="file_name"
        item-value="id"
        :label="t('patcher.patch-file')"
        prefix-label="stacked"
        :disabled="submitting"
        hide-details
      />
      <RDropzone
        v-else
        :accept="capabilities?.extensions.join(',')"
        :multiple="false"
        :title="t('patcher.choose-patch')"
        :hint="t('patcher.drag-drop-patch')"
        :input-label="t('patcher.choose-patch')"
        :disabled="submitting"
        @files="(files: File[]) => (upload = files[0] ?? null)"
      />
      <p v-if="upload">{{ upload.name }} ({{ formatBytes(upload.size) }})</p>
    </template>
    <RBtn
      v-if="canUpload"
      :disabled="!canSubmit"
      :loading="submitting"
      @click="submit"
    >
      {{
        t(
          operation === "3ds-convert"
            ? "patcher.install-cia"
            : "patcher.queue-patch",
        )
      }}
    </RBtn>
    <div v-for="job in jobs" :key="job.id" class="d-flex flex-column ga-2">
      <RAlert
        :type="
          job.status === 'failed'
            ? 'error'
            : job.status === 'completed'
              ? 'success'
              : 'info'
        "
        aria-live="polite"
      >
        {{
          t(
            job.download_ready
              ? "patcher.install-cia"
              : (stages[job.stage] ?? "patcher.job-queued"),
          )
        }}
        <span v-if="job.error"> {{ job.error }}</span>
        <span v-if="job.reused"> {{ t("patcher.job-reused") }}</span>
        <span v-if="job.output_file_name"> {{ job.output_file_name }}</span>
      </RAlert>
      <RBtn v-if="job.download_ready" @click="showInstall(job)">
        {{ t("rom.share-qr") }}
      </RBtn>
      <RBtn
        v-if="job.output_rom_id"
        :to="`/rom/${job.output_rom_id}`"
        variant="text"
      >
        {{ t("patcher.open-result") }}
      </RBtn>
    </div>
    <div v-if="qr" class="d-flex flex-column align-center ga-2">
      <RImg :src="qr" :alt="t('rom.share-qr')" width="240" height="240" />
      <RBtn :href="downloadUrl">
        {{ t("common.download") }}
      </RBtn>
    </div>
  </div>
</template>
