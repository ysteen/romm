/* eslint-disable vue/one-component-per-file */
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, nextTick, ref } from "vue";
import type { RomForgeJobSchema, RomForgeStatus } from "@/__generated__";
import api from "@/services/api";
import RomForge from "./RomForge.vue";

const admin = ref(true);
const visibility = ref("visible");

vi.mock("@/services/api", () => ({ default: { get: vi.fn() } }));
vi.mock("@/stores/auth", () => ({
  default: () => ({ scopes: ["tasks.run"] }),
}));
vi.mock("@/v2/composables/useCan", () => ({ useCan: () => admin }));
vi.mock("@vueuse/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vueuse/core")>()),
  useDocumentVisibility: () => visibility,
}));
vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key, locale: ref("en_US") }),
}));
vi.mock("@v2/lib", () => ({
  RAlert: defineComponent({ template: '<div role="alert"><slot /></div>' }),
  RBtn: defineComponent({
    props: { loading: Boolean },
    template: '<button :disabled="loading"><slot /></button>',
  }),
  RChip: defineComponent({ template: "<span><slot /></span>" }),
  RList: defineComponent({ template: "<ul><slot /></ul>" }),
  RListItem: defineComponent({
    template: '<li><slot name="title" /><slot name="subtitle" /><slot /></li>',
  }),
  RProgressLinear: defineComponent({ template: '<div role="progressbar" />' }),
  RSkeletonBlock: defineComponent({ template: '<span class="skeleton" />' }),
}));
vi.mock("@/v2/components/Settings/SettingsSection.vue", () => ({
  default: defineComponent({
    props: { title: { type: String, default: "" } },
    template:
      '<section><h2>{{ title }}</h2><slot name="header-actions" /><slot /></section>',
  }),
}));

function job(overrides: Partial<RomForgeJobSchema> = {}): RomForgeJobSchema {
  return {
    id: "job-1",
    status: "running",
    stage: "hashing",
    operation: "patch",
    file_id: 1,
    rom_id: 2,
    source_name: "Example.3ds",
    created_at: "2026-10-03T00:00:00Z",
    started_at: "2026-10-03T00:01:00Z",
    ended_at: null,
    ...overrides,
  };
}

function status(overrides: Partial<RomForgeStatus> = {}): RomForgeStatus {
  return {
    worker: {
      enabled: true,
      available: true,
      extensions: [".ips"],
      max_file_size: 1000,
      max_patch_size: 100,
      max_3ds_size: 2000,
      max_expanded_size: 2000,
      keys_ready: true,
      cia_ready: true,
      normalize_on_scan: true,
    },
    active: [job()],
    history: [],
    pending_normalizations: 8,
    scan_running: false,
    history_limit: 50,
    retention_days: 7,
    ...overrides,
  };
}

enableAutoUnmount(afterEach);
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  admin.value = true;
  visibility.value = "visible";
  vi.mocked(api.get).mockResolvedValue({ data: status() });
});
afterEach(() => vi.useRealTimers());

describe("RomForge status", () => {
  it("shows real stages, queue counts and completed or failed results", async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: status({
        active: [
          job(),
          job({ id: "queued", status: "queued", stage: "queued" }),
        ],
        history: [
          job({ id: "failed", status: "failed", error: "Source changed" }),
          job({
            id: "done",
            status: "completed",
            output_rom_id: 3,
            output_file_name: "Converted.cci",
          }),
        ],
      }),
    });
    const wrapper = mount(RomForge);
    expect(wrapper.findAll(".skeleton")).toHaveLength(3);
    await flushPromises();
    expect(
      wrapper.findAll(".romforge__metric dd").map((entry) => entry.text()),
    ).toEqual(["1", "1", "8"]);
    expect(wrapper.text()).toContain("patcher.job-hashing");
    expect(wrapper.text()).toContain("Source changed");
    expect(wrapper.text()).toContain("Converted.cci");
  });

  it("keeps the last snapshot visible on failure and recovers on refresh", async () => {
    const wrapper = mount(RomForge);
    await flushPromises();
    vi.mocked(api.get).mockRejectedValueOnce(new Error("offline"));
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("romforge.load-error");
    expect(wrapper.text()).toContain("Example.3ds");
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(wrapper.text()).not.toContain("romforge.load-error");
  });

  it("polls only while visible and resumes immediately", async () => {
    mount(RomForge);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.get).toHaveBeenCalledTimes(2);
    visibility.value = "hidden";
    await nextTick();
    await vi.advanceTimersByTimeAsync(20000);
    expect(api.get).toHaveBeenCalledTimes(2);
    visibility.value = "visible";
    await nextTick();
    await flushPromises();
    expect(api.get).toHaveBeenCalledTimes(3);
  });

  it("does not overlap requests and aborts on unmount", async () => {
    let resolve: ((value: { data: RomForgeStatus }) => void) | undefined;
    vi.mocked(api.get).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const wrapper = mount(RomForge);
    await vi.advanceTimersByTimeAsync(15000);
    expect(api.get).toHaveBeenCalledTimes(1);
    const signal = vi.mocked(api.get).mock.calls[0][1]?.signal;
    wrapper.unmount();
    expect(signal?.aborted).toBe(true);
    resolve?.({ data: status() });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10000);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("does not fetch without permission and clears data if permission is revoked", async () => {
    admin.value = false;
    const wrapper = mount(RomForge);
    expect(api.get).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("romforge.access-denied");
    admin.value = true;
    await nextTick();
    await flushPromises();
    expect(wrapper.text()).toContain("Example.3ds");
    admin.value = false;
    await nextTick();
    expect(wrapper.text()).not.toContain("Example.3ds");
    await vi.advanceTimersByTimeAsync(10000);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it.each(["disabled", "offline"])(
    "shows %s worker state without hiding history",
    async (state) => {
      const data = status({
        active: [],
        history: [job({ status: "completed" })],
      });
      data.worker.available = false;
      data.worker.enabled = state !== "disabled";
      vi.mocked(api.get).mockResolvedValue({ data });
      const wrapper = mount(RomForge);
      await flushPromises();
      expect(wrapper.text()).toContain(`romforge.worker-${state}-info`);
      expect(wrapper.text()).toContain("Example.3ds");
      expect(wrapper.text()).toContain("romforge.no-active");
    },
  );

  it("explains why automatic conversion is waiting for a scan", async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: status({ scan_running: true }),
    });
    const wrapper = mount(RomForge);
    await flushPromises();
    expect(wrapper.text()).toContain("romforge.waiting-scan");
  });
});
