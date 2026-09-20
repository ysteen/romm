import { enableAutoUnmount, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FirmwareSchema } from "@/__generated__";
import AzaharSystemData from "@/v2/components/Player/AzaharSystemData.vue";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

enableAutoUnmount(afterEach);

const firmware: FirmwareSchema = {
  id: 902,
  file_name: "custom-mii.zip",
  file_name_no_tags: "custom-mii.zip",
  file_name_no_ext: "custom-mii",
  file_extension: "zip",
  file_path: "nintendo-3ds/custom-firmware",
  full_path: "nintendo-3ds/custom-firmware/custom-mii.zip",
  file_size_bytes: 1,
  missing_from_fs: false,
  is_verified: false,
  crc_hash: "",
  md5_hash: "",
  sha1_hash: "",
  created_at: "2026-09-21T00:00:00Z",
  updated_at: "2026-09-21T00:00:00Z",
};

function mountData(
  selectedFirmware: FirmwareSchema | null,
  platformFsSlug: string,
) {
  return mount(AzaharSystemData, {
    props: { firmware: selectedFirmware, platformFsSlug },
    global: {
      stubs: {
        RAlert: { template: "<div><slot /></div>" },
        RBtn: { template: "<a><slot /></a>" },
      },
    },
  });
}

describe("Azahar system-data server paths", () => {
  it.each(["3ds", "nintendo-3ds"])(
    "shows both default library layouts for %s without selected firmware",
    (platformFsSlug) => {
      const wrapper = mountData(null, platformFsSlug);
      expect(
        wrapper
          .findAll(".r-azahar-system__server-path")
          .map((path) => path.text()),
      ).toEqual([
        `bios/${platformFsSlug}/azahar-mii-system-data.zip`,
        `${platformFsSlug}/bios/azahar-mii-system-data.zip`,
      ]);
    },
  );

  it("uses only the selected firmware's actual directory and filename", () => {
    const wrapper = mountData(firmware, "3ds");
    expect(
      wrapper
        .findAll(".r-azahar-system__server-path")
        .map((path) => path.text()),
    ).toEqual(["nintendo-3ds/custom-firmware/custom-mii.zip"]);
  });

  it("updates the paths when the selected firmware is cleared", async () => {
    const wrapper = mountData(firmware, "3ds");
    await wrapper.setProps({ firmware: null });
    expect(
      wrapper
        .findAll(".r-azahar-system__server-path")
        .map((path) => path.text()),
    ).toEqual([
      "bios/3ds/azahar-mii-system-data.zip",
      "3ds/bios/azahar-mii-system-data.zip",
    ]);
  });
});
