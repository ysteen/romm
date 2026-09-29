// Which firmware (BIOS) the EmulatorJS player boots with. Missing entries are
// never selectable, so a platform whose only BIOS is gone boots with none.

// Only these fields are read, so both `FirmwareSchema` and lighter shapes fit.
interface FirmwareLike {
  id: number;
  file_name: string;
  missing_from_fs: boolean;
}

export const AZAHAR_SYSTEM_FIRMWARE_NAME = "azahar-mii-system-data.zip";

export function resolveInitialFirmware<T extends FirmwareLike>({
  options,
  core,
  storedBiosId,
  configBiosFile,
}: {
  options: readonly T[];
  core?: string | null;
  // The user's last pick for this platform, from localStorage.
  storedBiosId: string | null;
  // `bios_file` from the core's EJS config, typed `string | boolean` because
  // most EJS settings are toggles; only a string names a file.
  configBiosFile: unknown;
}): T | null {
  const usable = options.filter((f) => !f.missing_from_fs);

  const fromStorage =
    storedBiosId !== null &&
    /^\d+$/.test(storedBiosId) &&
    Number.isSafeInteger(Number(storedBiosId))
      ? usable.find((f) => f.id === Number(storedBiosId))
      : undefined;
  const fromConfig =
    typeof configBiosFile === "string"
      ? usable.find((f) => f.file_name === configBiosFile)
      : undefined;
  // Auto-select only when the choice is unambiguous.
  const fromSingleOption = usable.length === 1 ? usable[0] : undefined;

  const canonical =
    core === "azahar"
      ? usable.filter(
          (f) => f.file_name.toLowerCase() === AZAHAR_SYSTEM_FIRMWARE_NAME,
        )
      : [];
  return (
    fromStorage ??
    fromConfig ??
    (canonical.length === 1 ? canonical[0] : null) ??
    fromSingleOption ??
    null
  );
}
