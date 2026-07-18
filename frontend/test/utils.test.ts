import { describe, expect, it } from "vitest";
import {
  getSupportedEJSCores,
  isNintendoDSFile,
  languageToEmoji,
  regionToEmoji,
} from "@/utils";

describe("regionToEmoji", () => {
  it("does not render Public Domain as the Poland flag", () => {
    expect(regionToEmoji("PD")).toBe("PD");
    expect(regionToEmoji("Public Domain")).toBe("Public Domain");
  });
});

describe("languageToEmoji", () => {
  it("keeps the Polish language flag mapping", () => {
    expect(languageToEmoji("PL")).toBe("🇵🇱");
    expect(languageToEmoji("Polish")).toBe("🇵🇱");
  });
});

describe("Nintendo 3DS EmulatorJS support", () => {
  it("exposes Azahar without enabling netplay", () => {
    expect(getSupportedEJSCores("3ds")).toEqual(["azahar"]);
    expect(getSupportedEJSCores("new-nintendo-3ds")).toEqual(["azahar"]);
  });

  it.each(["cia", "3ds", "3dsx", "cci", "cxi", "app", "elf", "axf"])(
    "accepts .%s content",
    (fsExtension) => {
      const rom = { fs_extension: fsExtension } as Parameters<
        typeof isNintendoDSFile
      >[0];
      expect(isNintendoDSFile(rom)).toBe(true);
    },
  );
});
