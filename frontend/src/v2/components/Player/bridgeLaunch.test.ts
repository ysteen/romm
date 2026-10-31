import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRIDGE_PLAYER_PATH,
  launchBridgePlayer,
  supportsBridge,
  resolveBridgeNetplay,
} from "@/v2/components/Player/bridgeLaunch";

const rom = {
  id: 7,
  name: "Link game",
  fs_name: "game.gb",
  platform_slug: "gb",
};

describe("relay player launch", () => {
  it("offers qualified handheld and SNES rooms", () => {
    for (const platform_slug of ["gb", "gbc", "gba", "snes"])
      expect(supportsBridge({ platform_slug })).toBe(true);
    expect(supportsBridge({ platform_slug: "nes" })).toBe(false);
  });
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  function popup() {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const child = frame.contentWindow;
    if (!child) throw new Error("Missing test window");
    vi.spyOn(window, "open").mockReturnValue(child);
    vi.spyOn(child, "postMessage").mockImplementation(() => {});
    vi.spyOn(child, "close").mockImplementation(() => {});
    return child;
  }

  it("only initializes the opened same-origin player", () => {
    const child = popup();
    const onError = vi.fn();
    const launch = launchBridgePlayer(rom, onError);
    expect(window.open).toHaveBeenCalledWith(
      BRIDGE_PLAYER_PATH,
      "_blank",
      "popup,width=1100,height=800",
    );
    const ready = (origin: string, source: Window | null = child) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin,
          source,
          data: { type: "romm-bridge-ready" },
        }),
      );
    ready("https://other.example");
    ready(window.location.origin, window);
    expect(child.postMessage).not.toHaveBeenCalled();
    ready(window.location.origin);
    expect(child.postMessage).toHaveBeenCalledExactlyOnceWith(
      {
        type: "romm-bridge-init",
        romId: 7,
        romName: "Link game",
        platform: "gb",
        theme: "dark",
      },
      window.location.origin,
    );
    ready(window.location.origin);
    vi.advanceTimersByTime(30_000);
    expect(child.close).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    launch.dispose();
  });

  it("waits for the active save to upload before initializing the room", async () => {
    const child = popup();
    let flushed!: () => void;
    const pending = new Promise<void>((resolve) => {
      flushed = resolve;
    });
    const before = vi.fn(() => pending);
    launchBridgePlayer(rom, vi.fn(), before);
    const ready = () =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: child,
          data: { type: "romm-bridge-ready" },
        }),
      );
    ready();
    ready();
    await Promise.resolve();
    expect(before).toHaveBeenCalledOnce();
    expect(child.postMessage).not.toHaveBeenCalled();
    flushed();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(child.postMessage).toHaveBeenCalledOnce();
  });

  it("closes the room if the active save cannot be flushed", async () => {
    const child = popup();
    const onError = vi.fn();
    launchBridgePlayer(rom, onError, () =>
      Promise.reject(new Error("upload failed")),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: child,
        data: { type: "romm-bridge-ready" },
      }),
    );
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(child.postMessage).not.toHaveBeenCalled();
    expect(child.close).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("reports blocked popups without leaving a pending handshake", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const onError = vi.fn();
    expect(launchBridgePlayer(rom, onError).popup).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes a player that never becomes ready", () => {
    const child = popup();
    const onError = vi.fn();
    launchBridgePlayer(rom, onError);
    vi.advanceTimersByTime(30_000);
    expect(child.close).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe("SNES netplay capability resolution", () => {
  it("waits for a delayed server response before choosing the toolbar route", async () => {
    let reply!: (enabled: boolean) => void;
    const response = new Promise<boolean>((resolve) => {
      reply = resolve;
    });
    const check = vi.fn(() => response),
      launch = vi.fn();
    let resolved = false;
    const pending = resolveBridgeNetplay("snes", check, launch).then(
      (callback) => {
        resolved = true;
        return callback;
      },
    );
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(check).toHaveBeenCalledOnce();
    reply(true);
    expect(await pending).toBe(launch);
  });
  it("keeps the existing entry when the bridge is disabled or the platform differs", async () => {
    const check = vi.fn().mockResolvedValue(false),
      launch = vi.fn();
    expect(await resolveBridgeNetplay("snes", check, launch)).toBeUndefined();
    check.mockClear();
    expect(await resolveBridgeNetplay("gba", check, launch)).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
  });
});
