import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  detectNativeTarget,
  nativeTarget,
  versionedDownload,
} from "../input-netplay/native-downloads.js";

test("native downloads invalidate cached binaries without changing their filenames", () => {
  const path = "../data/cores/example_libretro.dll";
  assert.notEqual(
    versionedDownload({ path, sha256: "old" }),
    versionedDownload({ path, sha256: "new" }),
  );
  assert.equal(
    versionedDownload({ path, sha256: "new" }),
    `${path}?sha256=new`,
  );
  assert.equal(versionedDownload({ path }), path);
});

const cases = [
  [
    "Windows Chrome",
    { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    "windows-x86_64",
  ],
  [
    "Windows ARM",
    { platform: "Windows", architecture: "arm", bitness: "64" },
    "windows-arm64",
  ],
  [
    "Windows 32-bit",
    { platform: "Windows", architecture: "x86", bitness: "32" },
    "windows-x86",
  ],
  [
    "WOW64",
    { platform: "Windows", architecture: "x86", bitness: "32", wow64: true },
    "windows-x86_64",
  ],
  [
    "Samsung Android",
    { userAgent: "Mozilla/5.0 (Linux; Android 10; K) SamsungBrowser/28.0" },
    "android-arm64-v8a",
  ],
  [
    "Android ARM32",
    { platform: "Android", architecture: "arm", bitness: "32" },
    "android-armeabi-v7a",
  ],
  [
    "Android emulator",
    { platform: "Android", architecture: "x86", bitness: "64" },
    "android-x86_64",
  ],
  ["Android x86", { userAgent: "Linux; Android 9; i686" }, "android-x86"],
  ["Linux desktop", { platform: "Linux x86_64" }, "linux-x86_64"],
  ["Linux ARM", { platform: "Linux aarch64" }, null],
  ["iPad desktop mode", { platform: "MacIntel", maxTouchPoints: 5 }, null],
  ["Mac", { platform: "MacIntel" }, null],
  ["unknown", {}, null],
];
for (const [name, browser, expected] of cases) {
  test(name, () => assert.equal(nativeTarget(browser), expected));
}
test("client hints distinguish Windows ARM from the compatibility user agent", async () => {
  assert.equal(
    await detectNativeTarget({
      userAgent: "Windows NT 10.0; Win64; x64",
      platform: "Win32",
      userAgentData: {
        platform: "Windows",
        getHighEntropyValues: async () => ({
          architecture: "arm",
          bitness: "64",
        }),
      },
    }),
    "windows-arm64",
  );
});
test("blocked client hints fall back to the user agent", async () => {
  assert.equal(
    await detectNativeTarget({
      userAgent: "Linux; Android 10; K",
      userAgentData: {
        platform: "Android",
        getHighEntropyValues: async () => {
          throw new Error("Denied");
        },
      },
    }),
    "android-arm64-v8a",
  );
});

test("mGBA ships matching core info for GBA filtering and subsystem discovery", async () => {
  const base = new URL("../input-netplay/", import.meta.url);
  const catalog = JSON.parse(
    await readFile(new URL("bridge-cores.json", base), "utf8"),
  );
  const profile = catalog.mgba_splitscreen.native;
  assert(profile.coreInfo, "The custom core needs its own info download");
  const url = new URL(profile.coreInfo.path, base);
  assert.equal(
    url.pathname.split("/").at(-1),
    "mgba_splitscreen_libretro.info",
  );
  const bytes = await readFile(url);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    profile.coreInfo.sha256,
  );
  const fields = Object.fromEntries(
    [...bytes.toString().matchAll(/^(\w+)\s*=\s*"([^"]*)"/gm)].map(
      ([, key, value]) => [key, value],
    ),
  );
  assert.equal(fields.supported_extensions, "gba");
  assert.equal(fields.corename, profile.coreName);
  assert.equal(fields.display_version, profile.coreVersion);
  assert.equal(fields.load_subsystem, "true");
});

test("all catalog downloads exist and match their core versions and checksums", async () => {
  const base = new URL("../input-netplay/", import.meta.url);
  const catalog = JSON.parse(
    await readFile(new URL("bridge-cores.json", base), "utf8"),
  );
  const targets = [
    "linux-x86_64",
    "windows-x86_64",
    "windows-x86",
    "windows-arm64",
    "android-arm64-v8a",
    "android-armeabi-v7a",
    "android-x86_64",
    "android-x86",
  ];
  for (const core of ["sameboy", "mgba_splitscreen", "snes9x"]) {
    const profile = catalog[core];
    assert.deepEqual(
      Object.keys(profile.downloads).sort(),
      targets
        .filter(
          (target) =>
            core !== "mgba_splitscreen" || !target.startsWith("android-"),
        )
        .sort(),
    );
    for (const [target, build] of Object.entries(profile.downloads)) {
      const url = new URL(build.path, base);
      const bytes = await readFile(url);
      assert(bytes.length > 0, `${core}/${target} is empty`);
      if (target === "linux-x86_64") continue;
      const manifest = JSON.parse(
        await readFile(new URL("manifest.json", url), "utf8"),
      );
      const digest = createHash("sha256").update(bytes).digest("hex");
      assert.equal(digest, build.sha256, `${core}/${target} catalog checksum`);
      assert.equal(digest, manifest.sha256[url.pathname.split("/").at(-1)]);
      assert.equal(manifest.version, profile.native.coreVersion);
      assert.equal(manifest.target, target);
      if (core === "mgba_splitscreen") {
        const patch = await readFile(
          new URL(
            "../data/cores/compat/rollback/mgba-spst4/mgba-native-startup.patch",
            base,
          ),
        );
        assert.equal(manifest.nativeStartup, "configured-players-v1");
        assert.equal(
          manifest.startupPatchSha256,
          createHash("sha256").update(patch).digest("hex"),
        );
      }
    }
  }
});
