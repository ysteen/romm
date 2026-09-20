import { ARAM_MAX_ROM_BYTES } from "@/players/aram/protocol";
import type { Config } from "@/stores/config";
import type { SimpleRom } from "@/stores/roms";

const PLATFORMS = new Set(["aram", "wipi", "skvm", "raptor"]);

export function isAramEmulationSupported(
  platformSlug: string,
  config?: Pick<Config, "PLATFORMS_VERSIONS">,
): boolean {
  const slug = config?.PLATFORMS_VERSIONS[platformSlug] || platformSlug;
  return PLATFORMS.has(slug.toLowerCase());
}

export class AramContentError extends Error {
  constructor(public readonly reason: "size" | "format" | "download") {
    super(`ARAM content: ${reason}`);
  }
}

export function aramContentRequest(
  rom: Pick<SimpleRom, "id" | "fs_name" | "has_multiple_files" | "files">,
): { name: string; url: string } {
  const file = rom.files.length === 1 ? rom.files[0] : undefined;
  const name =
    file?.file_name ??
    (rom.has_multiple_files ? `${rom.fs_name}.zip` : rom.fs_name);
  if (!/\.(dat|jar|zip)$/i.test(name)) throw new AramContentError("format");
  const contentName = encodeURIComponent(file?.file_name ?? rom.fs_name);
  const query = file ? `?file_ids=${file.id}` : "";
  return { name, url: `/api/roms/${rom.id}/content/${contentName}${query}` };
}

export async function downloadAramContent(
  url: string,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetch(url, {
    credentials: "same-origin",
    redirect: "error",
    signal,
  });
  if (!response.ok || !response.body) throw new AramContentError("download");
  if (Number(response.headers.get("Content-Length")) > ARAM_MAX_ROM_BYTES) {
    await response.body.cancel();
    throw new AramContentError("size");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ARAM_MAX_ROM_BYTES) throw new AramContentError("size");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new AramContentError("download");
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data.buffer;
}
