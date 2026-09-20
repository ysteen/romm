import runtimeLock from "@/players/aram/runtime-lock.json";

export const ARAM_CHANNEL = "romm:aram:1";
export const ARAM_VERSION = runtimeLock.version;
export const ARAM_RUNTIME_PATH = `/assets/aram/${ARAM_VERSION}`;
export const ARAM_MAX_ROM_BYTES = 32 * 1024 * 1024;

export interface AramLaunch {
  channel: typeof ARAM_CHANNEL;
  type: "launch";
  name: string;
  data: ArrayBuffer;
  userId: number;
  theme: "light" | "dark";
  language: string;
  touch: boolean;
}

export type AramHostEvent = {
  channel: typeof ARAM_CHANNEL;
  type: "ready" | "started" | "error";
};

export function isAramLaunch(value: unknown): value is AramLaunch {
  if (!value || typeof value !== "object") return false;
  const packet = value as Partial<AramLaunch>;
  return (
    packet.channel === ARAM_CHANNEL &&
    packet.type === "launch" &&
    typeof packet.name === "string" &&
    packet.name.length > 0 &&
    packet.name.length <= 1024 &&
    packet.data instanceof ArrayBuffer &&
    packet.data.byteLength > 0 &&
    packet.data.byteLength <= ARAM_MAX_ROM_BYTES &&
    typeof packet.userId === "number" &&
    Number.isSafeInteger(packet.userId) &&
    packet.userId > 0 &&
    (packet.theme === "light" || packet.theme === "dark") &&
    typeof packet.language === "string" &&
    packet.language.length <= 32 &&
    typeof packet.touch === "boolean"
  );
}

export function isAramHostEvent(value: unknown): value is AramHostEvent {
  if (!value || typeof value !== "object") return false;
  const packet = value as Partial<AramHostEvent>;
  return (
    packet.channel === ARAM_CHANNEL &&
    ["ready", "started", "error"].includes(packet.type ?? "")
  );
}

export function isAramRuntimeManifest(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Record<string, unknown>;
  return (
    manifest.version === ARAM_VERSION &&
    manifest.archiveSha256 === runtimeLock.archiveSha256
  );
}
