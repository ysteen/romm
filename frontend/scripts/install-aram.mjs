import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "accept-noncommercial": { type: "boolean", default: false },
    archive: { type: "string" },
    "license-file": { type: "string" },
  },
});

if (!values["accept-noncommercial"]) {
  throw new Error(
    "Review ARAM's PolyForm Noncommercial 1.0.0 license, then pass --accept-noncommercial. Commercial use requires separate permission.",
  );
}

const lock = JSON.parse(
  await readFile(
    new URL("../src/players/aram/runtime-lock.json", import.meta.url),
    "utf8",
  ),
);
const destination = fileURLToPath(
  new URL(`../public/assets/aram/${lock.version}/`, import.meta.url),
);
const temporary = await mkdtemp(join(tmpdir(), "romm-aram-install-"));

function verify(data, expected, label) {
  if (createHash("sha256").update(data).digest("hex") !== expected) {
    throw new Error(`${label}: SHA-256 mismatch; nothing will be installed`);
  }
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function installFile(name, data) {
  const path = join(destination, name);
  try {
    const existing = await readFile(path);
    if (!existing.equals(data))
      throw new Error(`Refusing to overwrite modified runtime file: ${path}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeFile(path, data, { flag: "wx" });
  }
}

try {
  const archive = values.archive
    ? await readFile(values.archive)
    : await download(
        `https://github.com/mirusu400/aram-emu/releases/download/v${lock.version}/aram-web.zip`,
      );
  verify(archive, lock.archiveSha256, "ARAM archive");
  const archivePath = join(temporary, "aram-web.zip");
  await writeFile(archivePath, archive);
  const files = [
    ["aram.wasm", lock.wasmSha256],
    ["wasm_exec.js", lock.loaderSha256],
  ].map(([name, hash]) => {
    const data = execFileSync("unzip", ["-p", archivePath, name], {
      maxBuffer: 80 * 1024 * 1024,
    });
    verify(data, hash, name);
    return [name, data];
  });
  const license = values["license-file"]
    ? await readFile(values["license-file"])
    : await download(
        `https://raw.githubusercontent.com/mirusu400/aram-emu/${lock.revision}/LICENSE.md`,
      );
  verify(license, lock.licenseSha256, "ARAM license");
  files.push(["LICENSE.txt", license]);
  files.push([
    "BUILD-INFO.txt",
    execFileSync("unzip", ["-p", archivePath, "BUILD-INFO.txt"]),
  ]);
  await mkdir(destination, { recursive: true });
  for (const [name, data] of files) await installFile(name, data);
  // Publish availability only after the complete, verified runtime is present.
  await installFile(
    "runtime.json",
    Buffer.from(
      JSON.stringify(
        {
          version: lock.version,
          archiveSha256: lock.archiveSha256,
        },
        null,
        2,
      ) + "\n",
    ),
  );
  console.info(`Installed ARAM ${lock.version} in ${destination}`);
  console.info(
    "The runtime is optional and separately licensed; its generated files are not committed to Git.",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
