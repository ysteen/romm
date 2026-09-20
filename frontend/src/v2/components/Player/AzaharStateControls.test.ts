import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computed } from "vue";
import type { StateSchema } from "@/__generated__";
import type { DetailedRom } from "@/stores/roms";
import AzaharStateControls from "@/v2/components/Player/AzaharStateControls.vue";
import type { AzaharStateRuntime } from "@/v2/utils/azaharState";

const mocks = vi.hoisted(() => ({
  permission: true,
  upload: vi.fn(),
  updateRom: vi.fn(),
  confirm: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/v2/composables/useCan", () => ({
  useCan: () => computed(() => mocks.permission),
}));
vi.mock("@/v2/composables/useConfirm", () => ({
  useConfirm: () => mocks.confirm,
}));
vi.mock("@/v2/composables/useSnackbar", () => ({
  useSnackbar: () => ({ success: mocks.success, error: mocks.error }),
}));
vi.mock("@/services/api/state", () => ({
  default: { uploadStates: mocks.upload },
}));
vi.mock("@/stores/roms", () => ({
  default: () => ({ update: mocks.updateRom }),
}));

const STUBS = {
  RAlert: { template: "<div><slot /></div>" },
  RBtn: {
    props: ["disabled", "loading"],
    template:
      '<button :disabled="disabled" :data-loading="loading"><slot /></button>',
  },
  RSelect: {
    props: ["modelValue", "items", "disabled"],
    emits: ["update:modelValue"],
    template:
      '<select :disabled="disabled" :value="modelValue" @change="$emit(\'update:modelValue\', Number($event.target.value))"><option value="">None</option><option v-for="item in items" :key="item.value" :value="item.value">{{ item.title }}</option></select>',
  },
};

function state(overrides: Partial<StateSchema> = {}): StateSchema {
  return {
    id: 15,
    rom_id: 7,
    user_id: 1,
    emulator: "azahar",
    file_name: "manual.state",
    file_name_no_tags: "manual.state",
    file_name_no_ext: "manual",
    file_extension: "state",
    file_path: "states/manual.state",
    file_size_bytes: 3,
    full_path: "/states/manual.state",
    download_path: "/api/states/15/content",
    missing_from_fs: false,
    created_at: "2026-09-21T08:00:00Z",
    updated_at: "2026-09-21T08:00:00Z",
    screenshot: null,
    ...overrides,
  };
}

function core(): AzaharStateRuntime {
  return {
    started: true,
    paused: false,
    getCore: () => "azahar",
    play: vi.fn(),
    pause: vi.fn(),
    gameManager: {
      supportsStates: () => true,
      getState: vi.fn(async () => new Uint8Array([1, 2, 3])),
      loadState: vi.fn(async () => undefined),
      screenshot: vi.fn(async () => new Uint8Array([4])),
    },
  };
}

const mounted: ReturnType<typeof mount>[] = [];

function mountControls(
  states: StateSchema[] = [],
  initialState?: StateSchema,
  realSelect = false,
) {
  const rom = { id: 7, user_states: states } as DetailedRom;
  const wrapper = mount(AzaharStateControls, {
    props: { rom, initialState },
    global: {
      stubs: { ...STUBS, RSelect: realSelect ? false : STUBS.RSelect },
    },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.permission = true;
  mocks.confirm.mockResolvedValue(true);
  mocks.upload.mockResolvedValue([{ status: "fulfilled", value: state() }]);
  vi.stubGlobal("EJS_emulator", core());
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
  );
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Azahar manual state controls", () => {
  it("navigates real select buttons without moving focus out of an open menu", async () => {
    const wrapper = mountControls([state()], undefined, true);
    await flushPromises();
    const save = wrapper.get<HTMLButtonElement>(".r-v2-azahar-states__save");
    const picker = wrapper.get<HTMLButtonElement>(
      'button[aria-haspopup="listbox"]',
    );
    save.element.focus();
    await save.trigger("keydown", { key: "ArrowRight" });
    expect(document.activeElement).toBe(picker.element);
    await picker.trigger("click");
    await picker.trigger("keydown", { key: "ArrowRight" });
    expect(document.activeElement).toBe(picker.element);
    expect(picker.attributes("aria-expanded")).toBe("true");
    await picker.trigger("keydown", { key: "Enter" });
    await flushPromises();
    await picker.trigger("keydown", { key: "ArrowRight" });
    expect(document.activeElement).toBe(
      wrapper.get(".r-v2-azahar-states__load").element,
    );
  });

  it("hides all actions without rom.play permission", () => {
    mocks.permission = false;
    const wrapper = mountControls();
    expect(wrapper.find("button").exists()).toBe(false);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("filters other cores, untagged states, wrong ROMs and missing files", () => {
    const wrapper = mountControls([
      state(),
      state({ id: 16, emulator: "citra" }),
      state({ id: 17, emulator: null }),
      state({ id: 18, rom_id: 8 }),
      state({ id: 19, missing_from_fs: true }),
    ]);
    expect(
      wrapper.findAll("option").map((option) => option.attributes("value")),
    ).toEqual(["", "15"]);
  });

  it("creates a uniquely named state and updates the reactive ROM list", async () => {
    const wrapper = mountControls();
    await flushPromises();
    await wrapper.get(".r-v2-azahar-states__save").trigger("click");
    await flushPromises();
    expect(mocks.upload).toHaveBeenCalledOnce();
    const input = mocks.upload.mock.calls[0][0];
    expect(input.emulator).toBe("azahar");
    expect(input.statesToUpload[0].stateFile.name).toMatch(
      /^azahar-7-.+\.state$/,
    );
    expect(input.statesToUpload[0].stateFile.size).toBe(3);
    expect(input.statesToUpload[0].screenshotFile.size).toBe(1);
    expect(mocks.success).toHaveBeenCalledWith("play.azahar-state-saved");
    expect(mocks.updateRom).toHaveBeenCalledWith(
      expect.objectContaining({ user_states: [state()] }),
    );
    expect(wrapper.emitted("update:rom")).toHaveLength(1);
    expect(wrapper.findAll("option")).toHaveLength(2);
  });

  it("does not report success when the settled upload result rejects", async () => {
    mocks.upload.mockResolvedValue([
      { status: "rejected", reason: new Error("Forbidden") },
    ]);
    const wrapper = mountControls();
    await flushPromises();
    await wrapper.get(".r-v2-azahar-states__save").trigger("click");
    await flushPromises();
    expect(mocks.error).toHaveBeenCalledWith("play.azahar-state-error-save");
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.updateRom).not.toHaveBeenCalled();
    expect(
      wrapper.get(".r-v2-azahar-states__save").attributes("disabled"),
    ).toBeUndefined();
  });

  it("does not upload empty core captures", async () => {
    const runtime = core();
    runtime.gameManager.getState = async () => new Uint8Array();
    vi.stubGlobal("EJS_emulator", runtime);
    const wrapper = mountControls();
    await flushPromises();
    await wrapper.get(".r-v2-azahar-states__save").trigger("click");
    await flushPromises();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith("play.azahar-state-error-save");
  });

  it("prevents reentry while state serialization is pending", async () => {
    const runtime = core();
    let finish: ((data: Uint8Array) => void) | undefined;
    runtime.gameManager.getState = vi.fn(
      () =>
        new Promise<Uint8Array>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("EJS_emulator", runtime);
    const wrapper = mountControls([state()]);
    await flushPromises();
    const save = wrapper.get(".r-v2-azahar-states__save");
    await save.trigger("click");
    await save.trigger("click");
    expect(runtime.gameManager.getState).toHaveBeenCalledOnce();
    expect(save.attributes("disabled")).toBeDefined();
    expect(
      wrapper.get(".r-v2-azahar-states__load").attributes("disabled"),
    ).toBeDefined();
    finish?.(new Uint8Array([1]));
    await flushPromises();
    expect(mocks.upload).toHaveBeenCalledOnce();
  });

  it("cancels restoring without downloading or changing the running state", async () => {
    mocks.confirm.mockResolvedValue(false);
    const runtime = core();
    vi.stubGlobal("EJS_emulator", runtime);
    const wrapper = mountControls([state()]);
    await wrapper.get("select").setValue("15");
    await wrapper.get(".r-v2-azahar-states__load").trigger("click");
    await flushPromises();
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "danger" }),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(runtime.gameManager.loadState).not.toHaveBeenCalled();
  });

  it("awaits a selected state restore and confirms only once", async () => {
    const runtime = core();
    vi.stubGlobal("EJS_emulator", runtime);
    const wrapper = mountControls([state()]);
    await wrapper.get("select").setValue("15");
    await wrapper.get(".r-v2-azahar-states__load").trigger("click");
    await flushPromises();
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(runtime.gameManager.loadState).toHaveBeenCalledWith(
      new Uint8Array([1, 2, 3]),
    );
    expect(mocks.success).toHaveBeenCalledWith("play.azahar-state-loaded");
  });

  it("reports core restore failure without a success toast", async () => {
    const runtime = core();
    runtime.gameManager.loadState = async () => {
      throw new Error("Invalid format");
    };
    vi.stubGlobal("EJS_emulator", runtime);
    const wrapper = mountControls([state()]);
    await wrapper.get("select").setValue("15");
    await wrapper.get(".r-v2-azahar-states__load").trigger("click");
    await flushPromises();
    expect(mocks.error).toHaveBeenCalledWith("play.azahar-state-error-load");
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("still reports restore failure when the current core stops", async () => {
    const runtime = core();
    runtime.gameManager.loadState = async () => {
      runtime.started = false;
      throw new Error("Core stopped");
    };
    vi.stubGlobal("EJS_emulator", runtime);
    const wrapper = mountControls([state()]);
    await wrapper.get("select").setValue("15");
    await wrapper.get(".r-v2-azahar-states__load").trigger("click");
    await flushPromises();
    expect(mocks.error).toHaveBeenCalledWith("play.azahar-state-error-load");
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("aborts a download on unmount and never loads the detached runtime", async () => {
    const runtime = core();
    vi.stubGlobal("EJS_emulator", runtime);
    let finish: ((response: Response) => void) | undefined;
    const download = vi.fn(
      (_url: string, _options: RequestInit) =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", download);
    const wrapper = mountControls([state()]);
    await wrapper.get("select").setValue("15");
    await wrapper.get(".r-v2-azahar-states__load").trigger("click");
    await flushPromises();
    const options = download.mock.calls[0][1];
    wrapper.unmount();
    expect(options.signal?.aborted).toBe(true);
    finish?.(new Response(new Uint8Array([1])));
    await flushPromises();
    expect(runtime.gameManager.loadState).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("does not pause or upload after a capture's component unmounts", async () => {
    const runtime = core();
    runtime.paused = true;
    let finish: ((data: Uint8Array) => void) | undefined;
    runtime.gameManager.getState = () =>
      new Promise<Uint8Array>((resolve) => {
        finish = resolve;
      });
    vi.stubGlobal("EJS_emulator", runtime);
    const wrapper = mountControls();
    await flushPromises();
    await wrapper.get(".r-v2-azahar-states__save").trigger("click");
    wrapper.unmount();
    finish?.(new Uint8Array([1]));
    await flushPromises();
    expect(runtime.play).toHaveBeenCalledOnce();
    expect(runtime.pause).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("waits for core readiness then loads the initial state once without another confirmation", async () => {
    vi.useFakeTimers();
    const runtime = core();
    runtime.started = false;
    vi.stubGlobal("EJS_emulator", runtime);
    mountControls([state()], state());
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).not.toHaveBeenCalled();
    runtime.started = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();
    expect(runtime.gameManager.loadState).toHaveBeenCalledOnce();
    expect(mocks.confirm).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(runtime.gameManager.loadState).toHaveBeenCalledOnce();
  });

  it("abandons initial state loading when unmounted during the settle delay", async () => {
    vi.useFakeTimers();
    const wrapper = mountControls([state()], state());
    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(500);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });
});
