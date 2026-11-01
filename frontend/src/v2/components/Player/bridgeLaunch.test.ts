import { describe, expect, it, vi } from "vitest";
import {
  bridgeLaunchFor,
  resolveBridgeNetplay,
  supportsBridge,
} from "./bridgeLaunch";

describe("embedded relay player launch", () => {
  it("offers the supported handheld and SNES rooms", () => {
    for (const platform_slug of ["gb", "gbc", "gba", "snes"])
      expect(supportsBridge({ platform_slug })).toBe(true);
    expect(supportsBridge({ platform_slug: "nes" })).toBe(false);
  });
  it("preserves the selected older save instead of selecting by update time", () => {
    expect(bridgeLaunchFor(7, { save: { id: 12 }, state: null })).toEqual({
      romId: 7,
      resume: { saveId: 12, stateId: null },
    });
  });
  it("preserves a fresh start and explicitly identifies unsupported snapshots", () => {
    expect(bridgeLaunchFor(7, { save: null, state: null }).resume).toEqual({
      saveId: null,
      stateId: null,
    });
    expect(
      bridgeLaunchFor(7, { save: null, state: { id: 9 } }).resume.stateId,
    ).toBe(9);
  });
  it("copies active game progress before replacing the player", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const result = bridgeLaunchFor(7, { save: null, state: { id: 9 } }, bytes);
    bytes.fill(0);
    expect(result.resume.battery).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.resume.stateId).toBeNull();
  });
  it("resolves the bridge setting before routing any supported core's toolbar", async () => {
    const check = vi.fn().mockResolvedValue(true),
      launch = vi.fn();
    for (const platform of ["gb", "gbc", "gba", "snes"])
      expect(await resolveBridgeNetplay(platform, check, launch)).toBe(launch);
    check.mockResolvedValue(false);
    expect(await resolveBridgeNetplay("snes", check, launch)).toBeUndefined();
    check.mockClear();
    expect(await resolveBridgeNetplay("nes", check, launch)).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
  });
});
