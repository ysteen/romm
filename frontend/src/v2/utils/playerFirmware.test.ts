import { describe, expect, it } from "vitest";
import type { FirmwareSchema } from "@/__generated__";
import { resolvePlayerFirmware } from "@/v2/utils/playerFirmware";

function firmware(
  id: number,
  fileName: string,
  missing = false,
): FirmwareSchema {
  return {
    id,
    file_name: fileName,
    file_name_no_tags: fileName,
    file_name_no_ext: fileName.replace(/\.[^.]+$/, ""),
    file_extension: fileName.split(".").at(-1) ?? "",
    file_path: `firmware/3ds/${fileName}`,
    full_path: `/firmware/3ds/${fileName}`,
    file_size_bytes: 1,
    missing_from_fs: missing,
    is_verified: false,
    crc_hash: "",
    md5_hash: "",
    sha1_hash: "",
    created_at: "2026-09-21T00:00:00Z",
    updated_at: "2026-09-21T00:00:00Z",
  };
}

describe("resolvePlayerFirmware", () => {
  const canonical = firmware(3, "azahar-mii-system-data.zip");
  const alternative = firmware(2, "custom-system-data.zip");
  const bios = firmware(1, "boot9.bin");
  const options = [bios, alternative, canonical];

  it("automatically selects the canonical Azahar package in a fresh browser", () => {
    expect(resolvePlayerFirmware(options, "azahar", null, undefined)).toBe(
      canonical,
    );
  });

  it("matches the canonical filename without case sensitivity", () => {
    const upper = firmware(4, "AZAHAR-MII-SYSTEM-DATA.ZIP");
    expect(
      resolvePlayerFirmware([bios, upper], "azahar", null, undefined),
    ).toBe(upper);
  });

  it("prioritizes a valid stored selection over configured and canonical files", () => {
    expect(
      resolvePlayerFirmware(options, "azahar", "1", alternative.file_name),
    ).toBe(bios);
  });

  it("prioritizes an exact configured filename over the canonical package", () => {
    expect(
      resolvePlayerFirmware(options, "azahar", null, alternative.file_name),
    ).toBe(alternative);
  });

  it.each([null, true, false, 2, { file_name: "custom-system-data.zip" }])(
    "ignores non-string configuration %j",
    (configuredName) => {
      expect(
        resolvePlayerFirmware(options, "azahar", null, configuredName),
      ).toBe(canonical);
    },
  );

  it("uses exact matching for noncanonical configured filenames", () => {
    expect(
      resolvePlayerFirmware(options, "azahar", null, "CUSTOM-SYSTEM-DATA.ZIP"),
    ).toBe(canonical);
  });

  it.each(["999", "1junk", "", " ", "1.0", "0x1", "-1", "9007199254740992"])(
    "ignores invalid or stale stored selection %j",
    (storedId) => {
      expect(
        resolvePlayerFirmware(
          options,
          "azahar",
          storedId,
          alternative.file_name,
        ),
      ).toBe(alternative);
    },
  );

  it("does not choose an arbitrary ZIP when no canonical file is present", () => {
    expect(
      resolvePlayerFirmware([bios, alternative], "azahar", null, undefined),
    ).toBeNull();
  });

  it("does not accept a similarly named archive as the canonical package", () => {
    expect(
      resolvePlayerFirmware(
        [bios, firmware(4, "azahar-mii-system-data-backup.zip")],
        "azahar",
        null,
        undefined,
      ),
    ).toBeNull();
  });

  it("leaves ambiguous case-variant canonical files unselected", () => {
    expect(
      resolvePlayerFirmware(
        [canonical, firmware(4, "AZAHAR-MII-SYSTEM-DATA.ZIP")],
        "azahar",
        null,
        undefined,
      ),
    ).toBeNull();
  });

  it("honors explicit selection even when canonical names are ambiguous", () => {
    const duplicate = firmware(4, "AZAHAR-MII-SYSTEM-DATA.ZIP");
    expect(
      resolvePlayerFirmware([canonical, duplicate], "azahar", "4", undefined),
    ).toBe(duplicate);
    expect(
      resolvePlayerFirmware(
        [canonical, duplicate],
        "azahar",
        null,
        canonical.file_name,
      ),
    ).toBe(canonical);
  });

  it.each([null, "melonds", "ppsspp", "citra"])(
    "does not enable Azahar-specific selection for core %j",
    (core) => {
      expect(resolvePlayerFirmware(options, core, null, undefined)).toBeNull();
    },
  );

  it("preserves configured and stored selection for other cores", () => {
    expect(
      resolvePlayerFirmware(
        [bios, alternative],
        "melonds",
        "2",
        bios.file_name,
      ),
    ).toBe(alternative);
    expect(
      resolvePlayerFirmware(
        [bios, alternative],
        "melonds",
        null,
        bios.file_name,
      ),
    ).toBe(bios);
  });

  it.each([null, "azahar", "melonds"])(
    "preserves the single-file fallback for core %j",
    (core) => {
      expect(resolvePlayerFirmware([bios], core, null, undefined)).toBe(bios);
    },
  );

  it("does not select missing files from storage, configuration or canonical fallback", () => {
    const missing = firmware(3, canonical.file_name, true);
    expect(
      resolvePlayerFirmware(
        [bios, alternative, missing],
        "azahar",
        "3",
        missing.file_name,
      ),
    ).toBeNull();
    expect(
      resolvePlayerFirmware([missing], "azahar", "3", missing.file_name),
    ).toBeNull();
  });

  it("counts only available files when resolving the single-file fallback", () => {
    expect(
      resolvePlayerFirmware(
        [bios, firmware(4, canonical.file_name, true)],
        "azahar",
        null,
        undefined,
      ),
    ).toBe(bios);
  });

  it("returns null when no files are available", () => {
    expect(resolvePlayerFirmware([], "azahar", null, undefined)).toBeNull();
  });

  it("does not mutate the supplied firmware list", () => {
    const supplied = [...options];
    resolvePlayerFirmware(supplied, "azahar", null, undefined);
    expect(supplied).toEqual(options);
  });
});
