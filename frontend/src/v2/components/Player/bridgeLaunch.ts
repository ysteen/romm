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
  return platform === "snes" && (await check()) ? launch : undefined;
}

export const BRIDGE_PLAYER_PATH =
  "/assets/emulatorjs/input-netplay/bridge.html";

export function launchBridgePlayer(
  rom: Pick<SimpleRomSchema, "id" | "name" | "fs_name" | "platform_slug">,
  onError: (error?: unknown) => void,
  beforeInitialize?: () => Promise<void>,
): { popup: Window | null; dispose: () => void } {
  const origin = window.location.origin;
  const popup = window.open(
    BRIDGE_PLAYER_PATH,
    "_blank",
    "popup,width=1100,height=800",
  );
  if (!popup) {
    onError();
    return { popup: null, dispose: () => {} };
  }
  let disposed = false;
  let initializing = false;
  const dispose = () => {
    disposed = true;
    clearTimeout(timer);
    window.removeEventListener("message", ready);
  };
  const ready = (event: MessageEvent) => {
    if (
      disposed ||
      initializing ||
      event.origin !== origin ||
      event.source !== popup ||
      event.data?.type !== "romm-bridge-ready"
    )
      return;
    initializing = true;
    const initialize = () => {
      if (disposed) return;
      popup.postMessage(
        {
          type: "romm-bridge-init",
          romId: rom.id,
          romName: rom.name || rom.fs_name,
          platform: rom.platform_slug,
          theme: document.documentElement.classList.contains("r-v2-light")
            ? "light"
            : "dark",
        },
        origin,
      );
      dispose();
    };
    if (beforeInitialize) {
      Promise.resolve()
        .then(beforeInitialize)
        .then(initialize)
        .catch((error: unknown) => {
          if (disposed) return;
          dispose();
          popup.close();
          onError(error);
        });
    } else initialize();
  };
  window.addEventListener("message", ready);
  const timer = setTimeout(() => {
    dispose();
    popup.close();
    onError();
  }, 30_000);
  return { popup, dispose };
}
