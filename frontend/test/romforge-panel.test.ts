import { flushPromises, shallowMount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "vue-i18n";
import type { DetailedRomSchema } from "@/__generated__";
import api from "@/services/api";
import storePermissions from "@/stores/permissions";
import RomForgePanel from "@/v2/components/GameDetails/RomForgePanel.vue";

vi.mock("@/services/api", () => ({ default: { get: vi.fn(), post: vi.fn() } }));

const rom = {
  id: 1,
  files: [
    { id: 10, file_name: "game.bin", file_size_bytes: 8, category: "game" },
  ],
} as DetailedRomSchema;
const caps = {
  enabled: true,
  available: true,
  extensions: [".ips"],
  max_file_size: 1024,
  max_patch_size: 512,
};
const queued = { id: "abc", status: "queued", stage: "queued", reused: false };
let mounted: ReturnType<typeof shallowMount> | undefined;

function render(admin = true) {
  const pinia = createPinia();
  setActivePinia(pinia);
  storePermissions().isAdmin = admin;
  mounted = shallowMount(RomForgePanel, {
    props: { rom },
    global: {
      renderStubDefaultSlot: true,
      plugins: [
        pinia,
        createI18n({
          legacy: false,
          locale: "en",
          missingWarn: false,
          fallbackWarn: false,
        }),
      ],
    },
  });
  return mounted;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.get).mockImplementation(async (url) => ({
    data: url.includes("capabilities") ? caps : [],
  }));
});
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.useRealTimers();
});

describe("RomForge queue panel", () => {
  it("uploads only the patch and never downloads the original or result", async () => {
    const wrapper = render();
    await flushPromises();
    const patch = new File(["patch"], "translation.ips");
    wrapper.findComponent({ name: "RDropzone" }).vm.$emit("files", [patch]);
    await flushPromises();
    vi.mocked(api.post).mockResolvedValue({ data: queued });
    wrapper.findComponent({ name: "RBtn" }).vm.$emit("click");
    await flushPromises();
    expect(api.post).toHaveBeenCalledTimes(1);
    const [url, form] = vi.mocked(api.post).mock.calls[0];
    expect(url).toBe("/roms/10/patch-jobs");
    expect([...(form as FormData).keys()]).toEqual([
      "operation",
      "output_format",
      "patch_file",
    ]);
    expect(
      vi
        .mocked(api.get)
        .mock.calls.every(([path]) => !path.includes("content")),
    ).toBe(true);
  });

  it("restores queued work from server history and prevents duplicate submission", async () => {
    vi.mocked(api.get).mockImplementation(async (url) => ({
      data: url.includes("capabilities") ? caps : [queued],
    }));
    const wrapper = render();
    await flushPromises();
    expect(wrapper.text()).toContain("patcher.job-queued");
    expect(wrapper.findComponent({ name: "RBtn" }).props("disabled")).toBe(
      true,
    );
    const calls = vi.mocked(api.get).mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.mocked(api.get).mock.calls.length).toBeGreaterThan(calls);
  });

  it("shows worker disconnection and disables submission", async () => {
    vi.mocked(api.get).mockImplementation(async (url) => ({
      data: url.includes("capabilities") ? { ...caps, available: false } : [],
    }));
    const wrapper = render();
    await flushPromises();
    expect(wrapper.text()).toContain("patcher.worker-unavailable");
    expect(wrapper.findComponent({ name: "RBtn" }).props("disabled")).toBe(
      true,
    );
  });

  it("hides the submit action from viewers", async () => {
    const wrapper = render(false);
    await flushPromises();
    expect(wrapper.findComponent({ name: "RBtn" }).exists()).toBe(false);
  });

  it("stops polling on unmount", async () => {
    const wrapper = render();
    await flushPromises();
    wrapper.unmount();
    mounted = undefined;
    const calls = vi.mocked(api.get).mock.calls.length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(vi.mocked(api.get).mock.calls.length).toBe(calls);
  });
});

describe("3DS export", () => {
  it("requests a temporary CIA without sending a patch", async () => {
    vi.mocked(api.get).mockImplementation(async (url) => ({
      data: url.includes("capabilities")
        ? { ...caps, max_3ds_size: 4096, keys_ready: true, cia_ready: true }
        : [],
    }));
    const wrapper = render();
    await wrapper.setProps({ initialOperation: "3ds-convert" });
    wrapper
      .findAllComponents({ name: "RSelect" })[1]
      .vm.$emit("update:modelValue", "3ds-convert");
    await flushPromises();
    expect(wrapper.findComponent({ name: "RDropzone" }).exists()).toBe(false);
    vi.mocked(api.post).mockResolvedValue({ data: queued });
    wrapper.findComponent({ name: "RBtn" }).vm.$emit("click");
    await flushPromises();
    const form = vi.mocked(api.post).mock.calls[0][1] as FormData;
    expect(form.get("operation")).toBe("3ds-convert");
    expect(form.get("output_format")).toBe("cia");
    expect(form.has("patch_file")).toBe(false);
  });
});
