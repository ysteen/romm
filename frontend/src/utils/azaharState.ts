export const MAX_AZAHAR_STATE_BYTES = 256 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

export interface AzaharStateRuntime {
  started: boolean;
  paused: boolean;
  getCore(): string;
  play(): void;
  pause(): void;
  gameManager: {
    supportsStates(): boolean;
    getState(): Uint8Array | Promise<Uint8Array>;
    loadState(data: Uint8Array): void | Promise<void>;
    screenshot?(): Uint8Array | Promise<Uint8Array>;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStateRuntime(value: unknown): value is AzaharStateRuntime {
  if (!isRecord(value) || !isRecord(value.gameManager)) return false;
  return (
    typeof value.started === "boolean" &&
    typeof value.paused === "boolean" &&
    typeof value.getCore === "function" &&
    typeof value.play === "function" &&
    typeof value.pause === "function" &&
    typeof value.gameManager.supportsStates === "function" &&
    typeof value.gameManager.getState === "function" &&
    typeof value.gameManager.loadState === "function" &&
    (value.gameManager.screenshot === undefined ||
      typeof value.gameManager.screenshot === "function")
  );
}

export function getAzaharStateRuntime(
  value: unknown,
): AzaharStateRuntime | null {
  if (!isStateRuntime(value) || !value.started) return null;
  try {
    return value.getCore() === "azahar" && value.gameManager.supportsStates()
      ? value
      : null;
  } catch {
    // Readiness can disappear while EmulatorJS is tearing down its core.
    return null;
  }
}

export function assertStateOperationActive(
  signal: AbortSignal,
  isCurrent: () => boolean,
) {
  signal.throwIfAborted();
  if (!isCurrent()) throw new DOMException("Session changed", "AbortError");
}

async function withRunningCore<T>(
  runtime: AzaharStateRuntime,
  signal: AbortSignal,
  isCurrent: () => boolean,
  action: () => Promise<T>,
): Promise<T> {
  assertStateOperationActive(signal, isCurrent);
  const wasPaused = runtime.paused;
  try {
    // Azahar queues serialization on a frame boundary.
    if (wasPaused) runtime.play();
    return await action();
  } finally {
    if (wasPaused && !signal.aborted && isCurrent() && runtime.started) {
      runtime.pause();
    }
  }
}

function copyStateBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength === 0 ||
    value.byteLength > MAX_AZAHAR_STATE_BYTES
  ) {
    throw new Error("Invalid Azahar state size");
  }
  return new Uint8Array(value);
}

async function optionalScreenshot(
  runtime: AzaharStateRuntime,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (!runtime.gameManager.screenshot) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const data = await Promise.race([
      runtime.gameManager.screenshot(),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), 2000);
      }),
    ]);
    if (
      data instanceof Uint8Array &&
      data.byteLength > 0 &&
      data.byteLength <= MAX_SCREENSHOT_BYTES
    ) {
      return new Uint8Array(data);
    }
  } catch {
    // A missing preview must not discard a successfully captured state.
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function captureAzaharState(
  runtime: AzaharStateRuntime,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<{
  data: Uint8Array<ArrayBuffer>;
  screenshot?: Uint8Array<ArrayBuffer>;
}> {
  return withRunningCore(runtime, signal, isCurrent, async () => {
    const data = copyStateBytes(await runtime.gameManager.getState());
    assertStateOperationActive(signal, isCurrent);
    const screenshot = await optionalScreenshot(runtime);
    assertStateOperationActive(signal, isCurrent);
    return { data, screenshot };
  });
}

export async function restoreAzaharState(
  runtime: AzaharStateRuntime,
  data: Uint8Array,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<void> {
  if (data.byteLength === 0 || data.byteLength > MAX_AZAHAR_STATE_BYTES) {
    throw new Error("Invalid Azahar state size");
  }
  await withRunningCore(runtime, signal, isCurrent, async () => {
    await runtime.gameManager.loadState(data);
    assertStateOperationActive(signal, isCurrent);
  });
}

export function azaharStateFilename(romId: number): string {
  // getRandomValues is also available on LAN HTTP; randomUUID requires HTTPS.
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `azahar-${romId}-${new Date().toISOString().replace(/[:.]/g, "-")}-${nonce}.state`;
}

export async function downloadAzaharState(
  path: string,
  signal: AbortSignal,
  origin = window.location.origin,
): Promise<Uint8Array<ArrayBuffer>> {
  const url = new URL(path, origin);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    !/^https?:$/.test(url.protocol)
  ) {
    throw new Error("State download must use the RomM origin");
  }
  signal.throwIfAborted();
  const response = await fetch(url.href, {
    credentials: "same-origin",
    redirect: "error",
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error("State download failed");
  }
  const declaredSize = Number(response.headers.get("content-length"));
  if (declaredSize > MAX_AZAHAR_STATE_BYTES) {
    await response.body.cancel();
    throw new Error("State download exceeds the size limit");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_AZAHAR_STATE_BYTES) {
        throw new Error("State download exceeds the size limit");
      }
      chunks.push(value);
    }
    if (!size) throw new Error("State download is empty");
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return data;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
