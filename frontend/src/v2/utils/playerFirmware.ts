import type { FirmwareSchema } from "@/__generated__";

export const AZAHAR_SYSTEM_FIRMWARE_NAME = "azahar-mii-system-data.zip";

export function resolvePlayerFirmware(
  options: FirmwareSchema[],
  core: string | null,
  storedId: string | null,
  configuredName: unknown,
): FirmwareSchema | null {
  const available = options.filter((firmware) => !firmware.missing_from_fs);
  if (storedId !== null && /^\d+$/.test(storedId)) {
    const id = Number(storedId);
    if (Number.isSafeInteger(id)) {
      const stored = available.find((firmware) => firmware.id === id);
      if (stored) return stored;
    }
  }

  if (typeof configuredName === "string") {
    const configured = available.find(
      (firmware) => firmware.file_name === configuredName,
    );
    if (configured) return configured;
  }

  if (core === "azahar") {
    const canonical = available.filter(
      (firmware) =>
        firmware.file_name.toLowerCase() === AZAHAR_SYSTEM_FIRMWARE_NAME,
    );
    if (canonical.length === 1) return canonical[0];
  }

  return available.length === 1 ? available[0] : null;
}
