import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../custom-emulatorjs/data/src",
);
const metadata = JSON.parse(
  await readFile(resolve(source, "bridge-vendor.json"), "utf8"),
);
assert.equal(metadata.project, "retroarch-netplay-bridge");
assert.equal(metadata.protocol, 1);
for (const name of [
  "bridge-session.js",
  "bridge-calibration.js",
  "link-core.js",
]) {
  const hash = createHash("sha256")
    .update(await readFile(resolve(source, name)))
    .digest("hex");
  assert.equal(
    hash,
    metadata.sha256[name],
    `Vendored module changed: ${name}; sync from the bridge repository`,
  );
}
console.log("Netplay client vendor hashes verified");
