import type { SimpleRomSchema } from "@/__generated__";

export function supportsBridge(
  rom: Pick<SimpleRomSchema, "platform_slug">,
): boolean {
  return ["gb", "gbc", "gba", "snes"].includes(rom.platform_slug);
}

// Resolve the server setting at launch time: a fast Play click can precede
// the initial capability request, and the emulator captures this callback once.
export async function resolveBridgeNetplay(
  platform: string | undefined,
  check: () => Promise<boolean | undefined>,
  launch: () => void,
): Promise<(() => void) | undefined> {
  return platform &&
    supportsBridge({ platform_slug: platform }) &&
    (await check())
    ? launch
    : undefined;
}

export const BRIDGE_PLAYER_PATH =
  "/assets/emulatorjs/input-netplay/bridge.html";

export interface BridgeLaunch {
  romId: number;
  resume: {
    saveId: number | null;
    stateId: number | null;
    battery?: Uint8Array<ArrayBuffer>;
  };
}

export function bridgeLaunchFor(
  romId: number,
  selection: { save: { id: number } | null; state: { id: number } | null },
  battery?: Uint8Array<ArrayBuffer>,
): BridgeLaunch {
  return {
    romId,
    resume: {
      saveId: selection.save?.id ?? null,
      stateId: battery ? null : (selection.state?.id ?? null),
      ...(battery ? { battery: battery.slice() } : {}),
    },
  };
}
