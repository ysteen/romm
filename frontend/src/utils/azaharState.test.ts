import { afterEach, describe, expect, it, vi } from "vitest";
import {
  azaharStateFilename,
  captureAzaharState,
  downloadAzaharState,
  getAzaharStateRuntime,
  MAX_AZAHAR_STATE_BYTES,
  restoreAzaharState,
  type AzaharStateRuntime,
} from "@/utils/azaharState";

function runtime(paused = false): AzaharStateRuntime {
  return {
    started: true,
    paused,
    getCore: vi.fn(() => "azahar"),
    play: vi.fn(),
    pause: vi.fn(),
    gameManager: {
      supportsStates: vi.fn(() => true),
      getState: vi.fn(() => new Uint8Array([1, 2, 3])),
      loadState: vi.fn(async () => undefined),
      screenshot: vi.fn(async () => new Uint8Array([4])),
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Azahar runtime state operations", () => {
  it("requires the started Azahar core and complete state API", () => {
    const core = runtime();
    expect(getAzaharStateRuntime(core)).toBe(core);
    expect(getAzaharStateRuntime(null)).toBeNull();
    expect(getAzaharStateRuntime({ ...core, started: false })).toBeNull();
    expect(
      getAzaharStateRuntime({ ...core, getCore: () => "citra" }),
    ).toBeNull();
    expect(
      getAzaharStateRuntime({
        ...core,
        gameManager: { supportsStates: () => true },
      }),
    ).toBeNull();
    core.gameManager.supportsStates = () => false;
    expect(getAzaharStateRuntime(core)).toBeNull();
    core.gameManager.supportsStates = () => {
      throw new Error("Closing");
    };
    expect(getAzaharStateRuntime(core)).toBeNull();
  });

  it("copies core-owned bytes and restores an originally paused session", async () => {
    const core = runtime(true);
    const state = new Uint8Array([1, 2]);
    core.gameManager.getState = vi.fn(async () => state);
    const captured = await captureAzaharState(
      core,
      new AbortController().signal,
      () => true,
    );
    state[0] = 9;
    expect(captured.data).toEqual(new Uint8Array([1, 2]));
    expect(captured.screenshot).toEqual(new Uint8Array([4]));
    expect(core.play).toHaveBeenCalledOnce();
    expect(core.pause).toHaveBeenCalledOnce();
  });

  it("never pauses or resumes an originally running session", async () => {
    const core = runtime();
    await captureAzaharState(core, new AbortController().signal, () => true);
    expect(core.play).not.toHaveBeenCalled();
    expect(core.pause).not.toHaveBeenCalled();
  });

  it("rejects empty captures and still restores pause", async () => {
    const core = runtime(true);
    core.gameManager.getState = () => new Uint8Array();
    await expect(
      captureAzaharState(core, new AbortController().signal, () => true),
    ).rejects.toThrow("size");
    expect(core.pause).toHaveBeenCalledOnce();
    expect(core.gameManager.screenshot).not.toHaveBeenCalled();
  });

  it("keeps a captured state when its optional screenshot fails", async () => {
    const core = runtime();
    core.gameManager.screenshot = async () => {
      throw new Error("No canvas");
    };
    const captured = await captureAzaharState(
      core,
      new AbortController().signal,
      () => true,
    );
    expect(captured.data.byteLength).toBe(3);
    expect(captured.screenshot).toBeUndefined();
  });

  it("does not hang forever waiting for a preview", async () => {
    vi.useFakeTimers();
    const core = runtime();
    core.gameManager.screenshot = () => new Promise(() => undefined);
    const pending = captureAzaharState(
      core,
      new AbortController().signal,
      () => true,
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect((await pending).screenshot).toBeUndefined();
  });

  it("does not pause a stale runtime after an interrupted capture", async () => {
    const core = runtime(true);
    const abort = new AbortController();
    core.gameManager.getState = async () => {
      abort.abort();
      return new Uint8Array([1]);
    };
    await expect(
      captureAzaharState(core, abort.signal, () => true),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(core.play).toHaveBeenCalledOnce();
    expect(core.pause).not.toHaveBeenCalled();
  });

  it("does not touch a runtime that was replaced before capture", async () => {
    const core = runtime(true);
    await expect(
      captureAzaharState(core, new AbortController().signal, () => false),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(core.play).not.toHaveBeenCalled();
    expect(core.pause).not.toHaveBeenCalled();
    expect(core.gameManager.getState).not.toHaveBeenCalled();
  });

  it("awaits restore and propagates core rejection while restoring pause", async () => {
    const core = runtime(true);
    const failure = new Error("Different core");
    core.gameManager.loadState = vi.fn(async () => {
      throw failure;
    });
    await expect(
      restoreAzaharState(
        core,
        new Uint8Array([1]),
        new AbortController().signal,
        () => true,
      ),
    ).rejects.toBe(failure);
    expect(core.play).toHaveBeenCalledOnce();
    expect(core.pause).toHaveBeenCalledOnce();
  });

  it("rejects empty restores before resuming the core", async () => {
    const core = runtime(true);
    await expect(
      restoreAzaharState(
        core,
        new Uint8Array(),
        new AbortController().signal,
        () => true,
      ),
    ).rejects.toThrow("size");
    expect(core.play).not.toHaveBeenCalled();
    expect(core.gameManager.loadState).not.toHaveBeenCalled();
  });

  it("generates unique filenames even for captures in the same millisecond", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T08:00:00Z"));
    const first = azaharStateFilename(7);
    expect(first).toMatch(/^azahar-7-2026-09-21T08-00-00-000Z-.+\.state$/);
    expect(azaharStateFilename(7)).not.toBe(first);
  });
});

describe("bounded authenticated Azahar state downloads", () => {
  const origin = "https://romm.example";
  const path = "/api/states/9/content";

  it("downloads same-origin bytes with authentication and no redirects", async () => {
    const fetchMock = vi.fn(
      async () => new Response(new Uint8Array([1, 2, 3])),
    );
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;
    expect(await downloadAzaharState(path, signal, origin)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(fetchMock).toHaveBeenCalledWith(`${origin}${path}`, {
      credentials: "same-origin",
      redirect: "error",
      signal,
    });
  });

  it.each([
    "https://evil.example/state",
    "//evil.example/state",
    "data:text/plain,state",
    "https://user:password@romm.example/state",
  ])("rejects unsafe path %s", async (url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      downloadAzaharState(url, new AbortController().signal, origin),
    ).rejects.toThrow("origin");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects HTTP failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Forbidden", { status: 403 })),
    );
    await expect(
      downloadAzaharState(path, new AbortController().signal, origin),
    ).rejects.toThrow("failed");
  });

  it("rejects empty bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array())),
    );
    await expect(
      downloadAzaharState(path, new AbortController().signal, origin),
    ).rejects.toThrow("empty");
  });

  it("cancels oversized advertised bodies without reading them", async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream({ cancel: cancelled });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(body, {
            headers: { "content-length": String(MAX_AZAHAR_STATE_BYTES + 1) },
          }),
      ),
    );
    await expect(
      downloadAzaharState(path, new AbortController().signal, origin),
    ).rejects.toThrow("size limit");
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("rejects and cancels a stream that exceeds the limit without a header", async () => {
    const cancelled = vi.fn();
    const chunk = new Uint8Array(MAX_AZAHAR_STATE_BYTES / 2);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.enqueue(chunk);
      },
      cancel: cancelled,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body)),
    );
    await expect(
      downloadAzaharState(path, new AbortController().signal, origin),
    ).rejects.toThrow("size limit");
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("never begins a download after its view was unmounted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const abort = new AbortController();
    abort.abort();
    await expect(
      downloadAzaharState(path, abort.signal, origin),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
