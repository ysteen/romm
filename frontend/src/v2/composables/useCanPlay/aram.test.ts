import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAramStore } from "@/stores/aram";
import storeConfig from "@/stores/config";
import type { SimpleRom } from "@/stores/roms";
import { useCanPlay } from "@/v2/composables/useCanPlay";
import {
  usePlatformPlayable,
  usePlatformPlayableChecker,
} from "@/v2/composables/usePlatformPlayable";

vi.mock("@/utils", () => ({
  isEJSEmulationSupported: () => false,
  isRuffleEmulationSupported: (slug: string) => slug === "flash",
  getSupportedEJSCores: () => [],
}));

beforeEach(() => setActivePinia(createPinia()));

describe("ARAM play actions and platform indicators", () => {
  it("updates every marker when the optional runtime becomes available", () => {
    const rom = { platform_slug: "wipi" } as SimpleRom;
    const action = useCanPlay(() => rom);
    const platform = usePlatformPlayable(() => rom.platform_slug);
    const batch = usePlatformPlayableChecker();
    expect(action.canPlay.value).toBe(false);
    expect(platform.emulator.value).toBeNull();
    expect(batch.isPlayable.value("wipi")).toBe(false);
    useAramStore().available = true;
    expect(action.canPlay.value).toBe(true);
    expect(action.canPlayAram.value).toBe(true);
    expect(platform.playableAram.value).toBe(true);
    expect(platform.emulator.value).toBe("aram");
    expect(batch.getEmulator.value("wipi")).toBe("aram");
    expect(batch.isPlayable.value("wipi")).toBe(true);
    useAramStore().available = false;
    expect(action.canPlay.value).toBe(false);
    expect(platform.playable.value).toBe(false);
    expect(batch.getEmulator.value("wipi")).toBeNull();
  });

  it("uses platform aliases consistently", () => {
    useAramStore().available = true;
    storeConfig().config.PLATFORMS_VERSIONS = { ktf: "wipi" };
    expect(
      useCanPlay(() => ({ platform_slug: "ktf" }) as SimpleRom).canPlayAram
        .value,
    ).toBe(true);
    expect(usePlatformPlayableChecker().getEmulator.value("ktf")).toBe("aram");
  });

  it("does not replace Ruffle or claim unknown platforms", () => {
    useAramStore().available = true;
    expect(usePlatformPlayable(() => "flash").emulator.value).toBe("ruffle");
    expect(usePlatformPlayable(() => "java").emulator.value).toBeNull();
    expect(useCanPlay(() => null).canPlay.value).toBe(false);
  });
});
