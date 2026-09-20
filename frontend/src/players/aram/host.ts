import {
  ARAM_CHANNEL,
  ARAM_RUNTIME_PATH,
  isAramLaunch,
  type AramHostEvent,
  type AramLaunch,
} from "@/players/aram/protocol";
import { createAramStorage, prepareAramSettings } from "@/players/aram/storage";
import "@/players/aram/host.css";

interface GoRuntime {
  importObject: WebAssembly.Imports;
  run: (instance: WebAssembly.Instance) => Promise<void>;
}

declare global {
  interface Window {
    Go?: new () => GoRuntime;
    __aramInitialPackage?: { name: string; data: Uint8Array };
  }
}

function notify(type: AramHostEvent["type"]): void {
  window.parent.postMessage(
    { channel: ARAM_CHANNEL, type },
    window.location.origin,
  );
}

function loadGo(): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${ARAM_RUNTIME_PATH}/wasm_exec.js`;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("ARAM Go loader is unavailable"));
    document.head.appendChild(script);
  });
}

async function launch(packet: AramLaunch): Promise<void> {
  const storage = createAramStorage(window.localStorage, packet.userId);
  prepareAramSettings(storage, packet);
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
  document.documentElement.style.colorScheme = packet.theme;
  window.__aramInitialPackage = {
    name: packet.name,
    data: new Uint8Array(packet.data),
  };
  await loadGo();
  if (!window.Go) throw new Error("ARAM Go runtime is unavailable");
  const go = new window.Go();
  const response = await fetch(`${ARAM_RUNTIME_PATH}/aram.wasm`, {
    redirect: "error",
  });
  if (!response.ok) throw new Error("ARAM WebAssembly is unavailable");
  // Some reverse proxies serve .wasm as application/octet-stream.
  const result =
    response.headers.get("Content-Type")?.split(";")[0] === "application/wasm"
      ? await WebAssembly.instantiateStreaming(response, go.importObject)
      : await WebAssembly.instantiate(
          await response.arrayBuffer(),
          go.importObject,
        );
  let exited = false;
  const running = go.run(result.instance);
  void running
    .finally(() => {
      exited = true;
    })
    .catch(() => undefined);
  function checkCanvas(): void {
    if (exited) return;
    const canvas = document.querySelector("canvas");
    if (canvas && !window.__aramInitialPackage) {
      canvas.tabIndex = 0;
      canvas.focus();
      notify("started");
    } else {
      requestAnimationFrame(checkCanvas);
    }
  }
  requestAnimationFrame(checkCanvas);
  await running;
  throw new Error("ARAM runtime exited");
}

let launched = false;
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (
    event.origin !== window.location.origin ||
    event.source !== window.parent ||
    launched
  )
    return;
  if (!isAramLaunch(event.data)) return;
  launched = true;
  void launch(event.data).catch((error: unknown) => {
    console.error("ARAM player failed", error);
    notify("error");
  });
});

if (window.parent !== window) notify("ready");
