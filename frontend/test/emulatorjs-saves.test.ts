import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaveSchema } from "@/__generated__";
import saveApi from "@/services/api/save";
import type { DetailedRom } from "@/stores/roms";
import { saveSave } from "@/views/Player/EmulatorJS/utils";

vi.mock("@/services/api/save", () => ({
  default: { uploadSaves: vi.fn(), updateSave: vi.fn() },
}));

const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]).buffer;
const rawBytes = new Uint8Array([1, 2, 3]).buffer;
const makeSave = (file_name: string, id = 1) =>
  ({ id, file_name, rom_id: 7, screenshot: null }) as SaveSchema;
let rom: DetailedRom;

beforeEach(() => {
  vi.clearAllMocks();
  rom = {
    id: 7,
    fs_name_no_ext: "Example",
    user_saves: [],
  } as DetailedRom;
  vi.mocked(saveApi.uploadSaves).mockImplementation(
    async ({ savesToUpload }) => [
      {
        status: "fulfilled",
        value: makeSave(savesToUpload[0].saveFile.name, 2),
      },
    ],
  );
  vi.mocked(saveApi.updateSave).mockImplementation(
    async ({ save }) =>
      ({ data: save }) as Awaited<ReturnType<typeof saveApi.updateSave>>,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EmulatorJS save filenames", () => {
  it("preserves a runtime Uint8Array view without including adjacent bytes", async () => {
    window.EJS_core = "azahar";
    const bytes = new Uint8Array([9, ...new Uint8Array(zipBytes), 8]);
    await saveSave({
      rom,
      save: null,
      saveFile: bytes.subarray(1, -1),
    });
    const { saveFile } = vi.mocked(saveApi.uploadSaves).mock.calls[0][0]
      .savesToUpload[0];
    expect(saveFile.type).toBe("application/zip");
    expect(new Uint8Array(await saveFile.arrayBuffer())).toEqual(
      new Uint8Array(zipBytes),
    );
  });

  it.each(["ppsspp", "azahar", "dos", "dosbox_pure"])(
    "%s uploads directory bundles as application/zip",
    async (core) => {
      window.EJS_core = core;
      const saved = await saveSave({ rom, save: null, saveFile: zipBytes });
      const { saveFile } = vi.mocked(saveApi.uploadSaves).mock.calls[0][0]
        .savesToUpload[0];
      expect(saveFile.name).toMatch(/^Example \[.*\]\.zip$/);
      expect(saveFile.type).toBe("application/zip");
      expect(new Uint8Array(await saveFile.arrayBuffer())).toEqual(
        new Uint8Array(zipBytes),
      );
      expect(rom.user_saves).toEqual([saved]);
    },
  );

  it("preserves a legacy .srm backup and updates the returned ZIP on subsequent writes", async () => {
    window.EJS_core = "ppsspp";
    const legacy = makeSave("Example.srm");
    rom.user_saves.push(legacy);
    const saved = await saveSave({
      rom,
      save: legacy,
      saveFile: zipBytes,
      deviceId: "browser-device",
    });
    expect(saved?.file_name).toMatch(/\.zip$/);
    expect(saveApi.updateSave).not.toHaveBeenCalled();
    expect(rom.user_saves).toEqual([saved, legacy]);
    expect(saveApi.uploadSaves).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: "browser-device" }),
    );

    await saveSave({ rom, save: saved, saveFile: zipBytes });
    expect(saveApi.uploadSaves).toHaveBeenCalledTimes(1);
    expect(saveApi.updateSave).toHaveBeenCalledWith(
      expect.objectContaining({
        save: saved,
        saveFile: expect.objectContaining({
          name: saved?.file_name,
          type: "application/zip",
        }),
      }),
    );
  });

  it.each(["snes9x", "dosbox_pure"])(
    "%s keeps actual single-file saves as .srm",
    async (core) => {
      window.EJS_core = core;
      await saveSave({ rom, save: null, saveFile: rawBytes });
      const { saveFile } = vi.mocked(saveApi.uploadSaves).mock.calls[0][0]
        .savesToUpload[0];
      expect(saveFile.name).toMatch(/\.srm$/);
      expect(saveFile.type).toBe("application/octet-stream");
    },
  );

  it("preserves the filename of an existing single-file save", async () => {
    window.EJS_core = "snes9x";
    const save = makeSave("Example.sav");
    rom.user_saves.push(save);
    await saveSave({ rom, save, saveFile: rawBytes });
    expect(saveApi.updateSave).toHaveBeenCalledWith(
      expect.objectContaining({
        saveFile: expect.objectContaining({ name: "Example.sav" }),
      }),
    );
    expect(saveApi.uploadSaves).not.toHaveBeenCalled();
  });

  it("does not upload an empty save", async () => {
    window.EJS_core = "azahar";
    expect(
      await saveSave({ rom, save: null, saveFile: new ArrayBuffer(0) }),
    ).toBeNull();
    expect(saveApi.uploadSaves).not.toHaveBeenCalled();
    expect(saveApi.updateSave).not.toHaveBeenCalled();
  });

  it("keeps the original save when ZIP migration fails", async () => {
    window.EJS_core = "azahar";
    const legacy = makeSave("Example.srm");
    rom.user_saves.push(legacy);
    vi.mocked(saveApi.uploadSaves).mockResolvedValue([
      { status: "rejected", reason: Error("upload failed") },
    ]);
    expect(
      await saveSave({ rom, save: legacy, saveFile: zipBytes }),
    ).toBeNull();
    expect(rom.user_saves).toEqual([legacy]);
    expect(saveApi.updateSave).not.toHaveBeenCalled();
  });
});
