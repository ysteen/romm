<script setup lang="ts">
import { RAlert, RBtn, RDialog, RForm, RSelect, RTextField } from "@v2/lib";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { SimpleRomSchema } from "@/__generated__";
import { notBlank } from "@/v2/utils/validation";
import type { LinkRoom } from "./linkSession";

const props = defineProps<{
  modelValue: boolean;
  rom: SimpleRomSchema;
  join?: LinkRoom | null;
  loading: boolean;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  launch: [room: LinkRoom];
}>();
const { t } = useI18n();
const open = computed({
  get: () => props.modelValue,
  set: (value) => emit("update:modelValue", value),
});
const form = ref<InstanceType<typeof RForm> | null>(null);
const name = ref("");
const password = ref("");
const maxPlayers = ref(2);
watch(open, (value) => {
  if (!value) return;
  name.value =
    props.join?.roomName ?? (props.rom.name || props.rom.fs_name).slice(0, 20);
  password.value = "";
  maxPlayers.value = props.join?.maxPlayers ?? 2;
});
async function submit() {
  if (props.loading || !(await form.value?.validate())?.valid) return;
  emit(
    "launch",
    props.join ?? {
      roms: [props.rom.id, null],
      automatic: true,
      maxPlayers: maxPlayers.value,
      manualStart: props.rom.platform_slug === "gba",
      player: 0,
      roomName: name.value.trim(),
      password: password.value,
    },
  );
}
</script>

<template>
  <RDialog
    v-model="open"
    :width="520"
    cancelable
    scroll-content
    :persistent="loading"
    :cancel-disabled="loading"
  >
    <template #header>{{ t("play.netplay") }}</template>
    <template #content>
      <RForm ref="form" class="link-room" disable-enter-submit @submit="submit">
        <RAlert type="info">{{ t("link.restart") }}</RAlert>
        <p>
          {{ t("link.your-game") }}:
          {{ rom.name || rom.fs_name }}
        </p>
        <p v-if="join?.hostGame">
          {{ t("link.host-game") }}: {{ join.hostGame }}
        </p>
        <RAlert v-else-if="!join" type="info">{{ t("link.automatic") }}</RAlert>
        <RTextField
          v-model="name"
          :label="t('common.name')"
          prefix-label="stacked"
          :maxlength="20"
          :rules="[notBlank()]"
          :disabled="loading || !!join"
        />
        <template v-if="!join">
          <RSelect
            v-if="rom.platform_slug === 'gba'"
            v-model="maxPlayers"
            :label="t('link.max-players')"
            prefix-label="stacked"
            :items="[2, 3, 4].map((value) => ({ title: String(value), value }))"
            :disabled="loading"
          />
          <RTextField
            v-model="password"
            type="password"
            :label="t('settings.password')"
            prefix-label="stacked"
            :maxlength="20"
            :disabled="loading"
          />
        </template>
        <RBtn type="submit" color="primary" :loading="loading">{{
          t(join ? "common.confirm" : "common.create")
        }}</RBtn>
      </RForm>
    </template>
  </RDialog>
</template>

<style scoped>
.link-room {
  display: flex;
  flex-direction: column;
  gap: var(--r-space-4);
}
</style>
