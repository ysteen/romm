import { defineStore } from "pinia";
import { ref } from "vue";
import {
  ARAM_RUNTIME_PATH,
  isAramRuntimeManifest,
} from "@/players/aram/protocol";

export const useAramStore = defineStore("aram", () => {
  const available = ref(false);
  const checked = ref(false);
  let pending: Promise<void> | null = null;

  function checkRuntime(): Promise<void> {
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await fetch(`${ARAM_RUNTIME_PATH}/runtime.json`, {
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        });
        available.value =
          response.ok && isAramRuntimeManifest(await response.json());
      } catch {
        available.value = false;
      } finally {
        checked.value = true;
        pending = null;
      }
    })();
    return pending;
  }

  return { available, checked, checkRuntime };
});
