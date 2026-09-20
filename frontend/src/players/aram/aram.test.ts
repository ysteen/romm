import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AramContentError,
  aramContentRequest,
  downloadAramContent,
  isAramEmulationSupported,
} from "@/players/aram/content";
import {
  ARAM_CHANNEL,
  ARAM_MAX_ROM_BYTES,
  ARAM_RUNTIME_PATH,
  isAramHostEvent,
  isAramLaunch,
  isAramRuntimeManifest,
} from "@/players/aram/protocol";
import runtimeLock from "@/players/aram/runtime-lock.json";
import { createAramStorage, prepareAramSettings } from "@/players/aram/storage";
import { useAramStore } from "@/stores/aram";
import type { SimpleRom } from "@/stores/roms";

afterEach(() => vi.unstubAllGlobals());

describe("ARAM platform registration", () => {
  it.each(["aram", "wipi", "skvm", "raptor", "WIPI"])("supports %s", (slug) => {
    expect(isAramEmulationSupported(slug)).toBe(true);
  });
  it.each(["java", "j2me", "snes", "flash", "browser", "android", ""])(
    "does not claim %s",
    (slug) => {
      expect(isAramEmulationSupported(slug)).toBe(false);
    },
  );
  it("resolves custom platform versions", () => {
    expect(
      isAramEmulationSupported("ktf", { PLATFORMS_VERSIONS: { ktf: "wipi" } }),
    ).toBe(true);
    expect(
      isAramEmulationSupported("wipi", {
        PLATFORMS_VERSIONS: { wipi: "flash" },
      }),
    ).toBe(false);
  });
});

describe("ARAM content loading", () => {
  function rom(
    overrides: Partial<Parameters<typeof aramContentRequest>[0]> = {},
  ) {
    return {
      id: 17,
      fs_name: "Game #1 ?.jar",
      has_multiple_files: false,
      files: [],
      ...overrides,
    };
  }
  it("encodes special characters in authenticated content URLs", () => {
    expect(aramContentRequest(rom())).toEqual({
      name: "Game #1 ?.jar",
      url: "/api/roms/17/content/Game%20%231%20%3F.jar",
    });
  });
  it("requests the actual single file in a directory entry", () => {
    const file = { id: 4, file_name: "Game.dat" } as SimpleRom["files"][number];
    expect(
      aramContentRequest(
        rom({ fs_name: "folder", has_multiple_files: true, files: [file] }),
      ),
    ).toEqual({
      name: "Game.dat",
      url: "/api/roms/17/content/Game.dat?file_ids=4",
    });
  });
  it("names multi-file downloads as a ZIP package", () => {
    expect(
      aramContentRequest(rom({ fs_name: "bundle", has_multiple_files: true }))
        .name,
    ).toBe("bundle.zip");
  });
  it("rejects unrecognized and firmware formats", () => {
    expect(() => aramContentRequest(rom({ fs_name: "firmware.bin" }))).toThrow(
      AramContentError,
    );
  });
  it("downloads without redirecting credentials and copies the body", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    const data = await downloadAramContent(
      "/api/roms/17/content/Game.jar",
      signal,
    );
    expect([...new Uint8Array(data)]).toEqual([1, 2, 3]);
    expect(fetcher).toHaveBeenCalledWith("/api/roms/17/content/Game.jar", {
      credentials: "same-origin",
      redirect: "error",
      signal,
    });
  });
  it.each([401, 403, 404, 500])("rejects HTTP %i", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("error", { status })),
    );
    await expect(
      downloadAramContent("/content", new AbortController().signal),
    ).rejects.toMatchObject({ reason: "download" });
  });
  it("rejects an empty package", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(new Uint8Array())),
    );
    await expect(
      downloadAramContent("/content", new AbortController().signal),
    ).rejects.toMatchObject({ reason: "download" });
  });
  it("rejects an oversized declared body before reading", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          headers: { "Content-Length": String(ARAM_MAX_ROM_BYTES + 1) },
        }),
      ),
    );
    await expect(
      downloadAramContent("/content", new AbortController().signal),
    ).rejects.toMatchObject({ reason: "size" });
    expect(cancel).toHaveBeenCalled();
  });
  it("enforces the streaming size limit without Content-Length", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(ARAM_MAX_ROM_BYTES + 1));
      },
      cancel,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    await expect(
      downloadAramContent("/content", new AbortController().signal),
    ).rejects.toMatchObject({ reason: "size" });
    expect(cancel).toHaveBeenCalled();
  });
});

describe("ARAM bridge validation", () => {
  const packet = () => ({
    channel: ARAM_CHANNEL,
    type: "launch",
    name: "game.jar",
    data: new ArrayBuffer(4),
    userId: 1,
    theme: "dark",
    language: "ko_KR",
    touch: false,
  });
  it("accepts a bounded, user-scoped launch", () =>
    expect(isAramLaunch(packet())).toBe(true));
  it.each([
    { data: new ArrayBuffer(0) },
    { data: "not bytes" },
    { userId: 0 },
    { userId: -1 },
    { userId: 1.5 },
    { userId: "1" },
    { channel: "other" },
    { type: "eval" },
    { name: "" },
    { name: "x".repeat(1025) },
    { theme: "invalid" },
    { touch: "true" },
  ])("rejects malformed launch %#", (invalid) =>
    expect(isAramLaunch({ ...packet(), ...invalid })).toBe(false),
  );
  it("rejects oversized messages", () =>
    expect(
      isAramLaunch({
        ...packet(),
        data: new ArrayBuffer(ARAM_MAX_ROM_BYTES + 1),
      }),
    ).toBe(false));
  it("accepts only known lifecycle events", () => {
    expect(isAramHostEvent({ channel: ARAM_CHANNEL, type: "ready" })).toBe(
      true,
    );
    expect(isAramHostEvent({ channel: ARAM_CHANNEL, type: "started" })).toBe(
      true,
    );
    expect(isAramHostEvent({ channel: ARAM_CHANNEL, type: "error" })).toBe(
      true,
    );
    expect(isAramHostEvent({ channel: "other", type: "started" })).toBe(false);
    expect(isAramHostEvent({ channel: ARAM_CHANNEL, type: "navigate" })).toBe(
      false,
    );
    expect(isAramHostEvent(null)).toBe(false);
  });
});

describe("ARAM user storage", () => {
  beforeEach(() => localStorage.clear());
  it("isolates users and preserves unrelated RomM and standalone ARAM storage", () => {
    localStorage.setItem("romm.preference", "keep");
    localStorage.setItem("aram.savedata.game", "standalone");
    const one = createAramStorage(localStorage, 1);
    const two = createAramStorage(localStorage, 2);
    one.setItem("aram.savedata.game", "first");
    two.setItem("aram.savedata.game", "second");
    expect(one.getItem("aram.savedata.game")).toBe("first");
    expect(two.getItem("aram.savedata.game")).toBe("second");
    expect(one.length).toBe(1);
    expect(one.key(0)).toBe("aram.savedata.game");
    expect(one.key(1)).toBeNull();
    one.clear();
    expect(one.length).toBe(0);
    expect(two.getItem("aram.savedata.game")).toBe("second");
    expect(localStorage.getItem("romm.preference")).toBe("keep");
    expect(localStorage.getItem("aram.savedata.game")).toBe("standalone");
  });
  it("restores the same user's saved data on another launch", () => {
    createAramStorage(localStorage, 3).setItem("aram.savedata.hash", "saved");
    expect(
      createAramStorage(localStorage, 3).getItem("aram.savedata.hash"),
    ).toBe("saved");
  });
  it("disables analytics without overwriting game saves or controller settings", () => {
    const storage = createAramStorage(localStorage, 1);
    storage.setItem("aram.savedata.hash", "saved");
    storage.setItem(
      "aram.settings",
      JSON.stringify({
        volume: 80,
        show_virtual_keypad: false,
        analytics_enabled: true,
      }),
    );
    prepareAramSettings(storage, {
      theme: "light",
      language: "ko_KR",
      touch: true,
    });
    expect(JSON.parse(storage.getItem("aram.settings")!)).toEqual({
      volume: 80,
      show_virtual_keypad: false,
      analytics_enabled: false,
      theme_mode: "light",
      language: "ko",
    });
    expect(storage.getItem("aram.savedata.hash")).toBe("saved");
  });
  it("enables the keypad on first launch on touch devices", () => {
    const storage = createAramStorage(localStorage, 1);
    prepareAramSettings(storage, {
      theme: "dark",
      language: "en_US",
      touch: true,
    });
    expect(
      JSON.parse(storage.getItem("aram.settings")!).show_virtual_keypad,
    ).toBe(true);
  });
  it("does not overwrite malformed settings", () => {
    const storage = createAramStorage(localStorage, 1);
    storage.setItem("aram.settings", "broken");
    expect(() =>
      prepareAramSettings(storage, {
        theme: "dark",
        language: "en",
        touch: false,
      }),
    ).toThrow();
    expect(storage.getItem("aram.settings")).toBe("broken");
  });
  it.each([0, -1, 1.5, NaN])("rejects invalid user %s", (id) =>
    expect(() => createAramStorage(localStorage, id)).toThrow(),
  );
});

describe("ARAM runtime availability", () => {
  beforeEach(() => setActivePinia(createPinia()));
  it("requires the pinned runtime version and digest", () => {
    expect(isAramRuntimeManifest(runtimeLock)).toBe(true);
    expect(isAramRuntimeManifest({ ...runtimeLock, version: "next" })).toBe(
      false,
    );
    expect(
      isAramRuntimeManifest({ ...runtimeLock, archiveSha256: "wrong" }),
    ).toBe(false);
  });
  it("deduplicates checks and enables an installed runtime", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(runtimeLock)));
    vi.stubGlobal("fetch", fetcher);
    const store = useAramStore();
    await Promise.all([store.checkRuntime(), store.checkRuntime()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(`${ARAM_RUNTIME_PATH}/runtime.json`);
    expect(store.available).toBe(true);
    expect(store.checked).toBe(true);
  });
  it.each([
    new Response("missing", { status: 404 }),
    new Response("<html>SPA fallback</html>"),
  ])("keeps an absent runtime disabled", async (response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const store = useAramStore();
    await store.checkRuntime();
    expect(store.available).toBe(false);
    expect(store.checked).toBe(true);
  });
  it("handles network failures without affecting other players", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await useAramStore().checkRuntime();
    expect(useAramStore().available).toBe(false);
  });
});
