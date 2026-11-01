import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { detailedRomFixture } from "../frontend/src/utils/rom.fixtures.ts";
import { withHeadlessBrowser } from "./headless-browser.mjs";

// Run after the bounded production frontend build. All HTTP requests are
// intercepted: this exercises the actual v2 application without touching a
// user's RomM account, saves, or deployment. The SNES toolbar case boots the
// original two-pad fixture in the real qualified Snes9x WASM package.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "frontend/dist");
const emulator = resolve(root, "custom-emulatorjs");
const output = resolve(
  process.env.NETPLAY_LAUNCHER_OUTPUT ??
    resolve(root, "../result/netplay-interop/romm-bridge-launcher"),
);
const origin = "http://127.0.0.1:8081";
const romId = 2147483589;
const playerPath = "/assets/emulatorjs/input-netplay/bridge.html";
const report = {
  application: "Production v2 frontend with isolated API fixtures",
  embedded:
    "Inline player initialization recorder; real room UI is tested separately",
  gamepad: "Injected standard Gamepad API polled by actual useGamepad",
  screenWakeLock: "Optional OS capability disabled in headless Chrome",
  scenarios: [],
};
const contentTypes = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
};
const user = {
  id: romId,
  username: "bridge-launcher-fixture",
  role: "admin",
  enabled: true,
  oauth_scopes: [
    "roms.read",
    "roms.user.write",
    "me.read",
    "me.write",
    "assets.read",
    "assets.write",
  ],
  avatar_path: "",
  ui_settings: { uiVersion: "v2", locale: "en_US" },
};
const config = {
  PLATFORMS_VERSIONS: {},
  PLATFORMS_BINDING: {},
  EJS_SETTINGS: {},
  EJS_CONTROLS: {},
  EJS_NETPLAY_ENABLED: false,
  EJS_NETPLAY_ICE_SERVERS: [],
  EJS_CACHE_LIMIT: null,
  EJS_DISABLE_AUTO_UNLOAD: true,
  EJS_DISABLE_BATCH_BOOTUP: false,
  EJS_ENABLE_AUTO_SAVE_SYNC: true,
  SCAN_METADATA_PRIORITY: [],
  SCAN_ARTWORK_PRIORITY: [],
  SCAN_REGION_PRIORITY: [],
  SCAN_LANGUAGE_PRIORITY: [],
};
const heartbeat = {
  SYSTEM: { VERSION: "5.2.0", SHOW_SETUP_WIZARD: false },
  FRONTEND: { DISABLE_USERPASS_LOGIN: false, DISABLE_LOGS_VIEWER: false },
  EMULATION: { DISABLE_EMULATOR_JS: false, DISABLE_RUFFLE_RS: false },
  METADATA_SOURCES: {},
  FILESYSTEM: { FS_PLATFORMS: ["gb", "gbc", "gba", "snes", "psp"] },
  OIDC: {},
  TASKS: {},
};
const playerDocument = `<!doctype html><title>Embedded bridge fixture</title><body>Room loading<script>
window.bridgePlayer = {
  async initialize(options) {
    const {onExit,...data}=options;
    window.handshake={...data,receivedAt:Date.now()};
    window.returnToConfig=onExit;
    document.body.textContent="Room initialized";
  },
  async save() {}, destroy() {},
};
</script></body>`;

async function fixture(
  browser,
  { platform, enabled, theme = "dark", configDelayMs = 0 },
) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    hasTouch: true,
    colorScheme: theme,
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const evidence = {
    platform,
    enabled,
    theme,
    pageErrors: [],
    missingAssets: [],
    unexpectedRequests: [],
    saveUploads: [],
    configResponses: [],
  };
  page.on("pageerror", (error) => evidence.pageErrors.push(error.message));
  const rom = detailedRomFixture({
    id: romId,
    name: `${platform.toUpperCase()} launcher fixture`,
    fs_name: platform === "snes" ? "two-pad.sfc" : `launcher.${platform}`,
    fs_name_no_tags: "launcher",
    fs_name_no_ext: "launcher",
    fs_extension: platform === "snes" ? "sfc" : platform,
    platform_id: romId,
    platform_slug: platform,
    platform_fs_slug: platform,
    platform_display_name: platform.toUpperCase(),
    has_simple_single_file: true,
    has_file_on_disk: true,
    fs_size_bytes: 32768,
  });
  await context.addInitScript(
    ({ theme, romId, platform }) => {
      Object.defineProperty(document, "startViewTransition", {
        value: undefined,
      });
      // Headless Chrome cannot keep a physical display awake. Model a
      // browser without this optional API while exercising the actual core.
      delete Navigator.prototype.wakeLock;
      localStorage.setItem("settings.uiVersion", "v2");
      localStorage.setItem("settings.locale", "en_US");
      localStorage.setItem("settings.theme", theme);
      localStorage.setItem("emulation.fullScreenOnPlay", "false");
      if (platform === "snes")
        localStorage.setItem(`player:${romId}:core`, "snes9x");
      window.testPad = {
        id: "Bridge launcher standard fixture",
        index: 0,
        mapping: "standard",
        connected: false,
        timestamp: 0,
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, () => ({
          pressed: false,
          touched: false,
          value: 0,
        })),
      };
      Object.defineProperty(navigator, "getGamepads", {
        value: () => (window.testPad.connected ? [window.testPad] : []),
      });
    },
    { theme, romId, platform },
  );
  await context.routeWebSocket(/.*/, (socket) => socket.close());
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (
      url.href === "https://api.github.com/repos/rommapp/romm/releases/latest"
    )
      return route.fulfill({ json: { tag_name: "5.2.0" } });
    if (url.href === "https://cdn.emulatorjs.org/stable/data/version.json")
      return route.fulfill({
        contentType: "application/json",
        body: await readFile(resolve(emulator, "data/version.json")),
      });
    if (url.origin !== origin) {
      evidence.unexpectedRequests.push(url.origin + path);
      return route.abort();
    }
    if (path === playerPath)
      return route.fulfill({ contentType: "text/html", body: playerDocument });
    if (path.startsWith("/api/")) {
      if (path.includes("/content/"))
        return route.fulfill({
          body: await readFile(
            resolve(
              root,
              "../result/netplay-interop/snes-rollback/two-pad.sfc",
            ),
          ),
        });
      if (request.method() === "POST" && path === "/api/saves") {
        const upload = { startedAt: Date.now(), finishedAt: null };
        evidence.saveUploads.push(upload);
        // Make the save-before-room ordering observable across the handshake.
        await new Promise((resolve) => setTimeout(resolve, 150));
        upload.finishedAt = Date.now();
        return route.fulfill({
          json: {
            id: evidence.saveUploads.length,
            rom_id: romId,
            user_id: romId,
            emulator: "snes9x",
            file_name: "launcher.srm",
            file_extension: "srm",
            file_size_bytes: 2048,
            download_path: "/api/fixture/save",
            slot: "default",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        });
      }
      if (path === "/api/netplay/bridge/config") {
        if (configDelayMs)
          await new Promise((resolve) => setTimeout(resolve, configDelayMs));
        evidence.configResponses.push(Date.now());
        return route.fulfill({ json: { enabled } });
      }
      if (path === "/api/heartbeat") return route.fulfill({ json: heartbeat });
      if (path === "/api/users/me") return route.fulfill({ json: user });
      if (path === "/api/config") return route.fulfill({ json: config });
      if (path === "/api/permissions/me")
        return route.fulfill({
          json: {
            is_admin: true,
            grants: [],
            hidden: { platforms: [], roms: [] },
          },
        });
      if (path === "/api/streaming/config")
        return route.fulfill({ json: { enabled: false, containers: [] } });
      if (path === `/api/roms/${romId}`) return route.fulfill({ json: rom });
      if (path === "/api/roms")
        return route.fulfill({
          json: { items: [rom], total: 1, limit: 72, offset: 0 },
        });
      if (/^\/api\/(firmware|collections|platforms)/.test(path))
        return route.fulfill({ json: [] });
      return route.fulfill({ json: {} });
    }
    if (path.startsWith("/ws")) return route.fulfill({ status: 204 });
    let file;
    let directory;
    if (path.startsWith("/assets/emulatorjs/")) {
      directory = emulator;
      const relative = decodeURIComponent(
        path.slice("/assets/emulatorjs/".length),
      );
      // The normal frontend selects snes9x. Supply the exact qualified build
      // used by room play, without altering any production asset on disk.
      const qualified = "data/cores/compat/rollback/snes9x-2d4cce69/";
      file = resolve(
        directory,
        relative === "data/cores/snes9x-wasm.data"
          ? qualified + "snes9x-wasm.data"
          : relative === "data/cores/reports/snes9x.json"
            ? qualified + "snes9x.json"
            : relative,
      );
    } else {
      directory = dist;
      file = path.startsWith("/assets/")
        ? resolve(dist, "." + decodeURIComponent(path))
        : resolve(dist, "index.html");
    }
    if (!file.startsWith(directory + sep)) return route.abort();
    try {
      let body;
      try {
        body = await readFile(file);
      } catch (error) {
        // RomM serves these static images beside the Vite build in its image.
        if (directory !== dist || !path.startsWith("/assets/")) throw error;
        const staticRoot = resolve(root, "frontend/assets");
        const staticFile = resolve(
          staticRoot,
          decodeURIComponent(path.slice("/assets/".length)),
        );
        if (!staticFile.startsWith(staticRoot + sep)) throw error;
        body = await readFile(staticFile);
      }
      return route.fulfill({
        body,
        contentType: contentTypes[extname(file)] ?? "application/octet-stream",
      });
    } catch {
      evidence.missingAssets.push(path);
      return route.fulfill({ status: 404 });
    }
  });
  await page.goto(`${origin}/rom/${romId}/ejs`);
  await page.getByRole("heading", { name: rom.name }).waitFor();
  await page.locator(".r-v2-ejs__play:not([disabled])").waitFor();
  assert.equal(
    await page.evaluate(() =>
      document.documentElement.classList.contains("r-v2-light"),
    ),
    theme === "light",
  );
  return { page, context, evidence, rom };
}

async function tabTo(page, locator) {
  for (let i = 0; i < 40; i++) {
    if (await locator.evaluate((element) => element === document.activeElement))
      return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Relay launcher is not reachable with Tab");
}

async function openAndInspect(page, activate, expected, returnToConfig = true) {
  const beforePages = page.context().pages().length;
  await activate();
  const frame = page.frameLocator(".bridge-stage iframe");
  await frame.locator("body").filter({ hasText: "Room initialized" }).waitFor();
  const handshake = await frame
    .locator("body")
    .evaluate(() => window.handshake);
  assert.equal(handshake.romId, romId);
  assert.equal(handshake.theme, expected.evidence.theme);
  assert.equal(handshake.resume.saveId, null);
  assert.equal(handshake.resume.stateId, null);
  assert.equal(
    page.context().pages().length,
    beforePages,
    "Relay opened a popup",
  );
  if (returnToConfig) {
    await page.evaluate(() => {
      setTimeout(
        () =>
          document
            .querySelector(".bridge-stage iframe")
            .contentWindow.returnToConfig(),
        0,
      );
    });
    await page.locator(".r-v2-ejs__play").waitFor();
  }
  return handshake;
}

async function checkSnesToolbar(item, label) {
  const { page, evidence } = item;
  await page.locator(".r-v2-ejs__play").click();
  await page.waitForFunction(
    () => window.EJS_emulator?.started && window.EJS_emulator.gameManager,
    null,
    { timeout: 90_000 },
  );
  const runtime = await page.evaluate(() => ({
    callback: typeof window.EJS_emulator.config.netplayLaunch,
    legacyStreaming: !!window.EJS_emulator.netplay,
    core: window.EJS_emulator.getCore(),
  }));
  assert.deepEqual(runtime, {
    callback: "function",
    legacyStreaming: false,
    core: "snes9x",
  });
  await page.evaluate(() => window.EJS_emulator.menu.open(true));
  const menuButton = page
    .locator(".ejs_menu_bar button")
    .filter({ hasText: /^Netplay$/ });
  await menuButton.waitFor();
  await page.screenshot({
    path: resolve(output, `snes-toolbar-${label}.png`),
  });
  const handshake = await openAndInspect(
    page,
    () => menuButton.click(),
    item,
    false,
  );
  assert(await page.evaluate(() => window.EJS_emulator.paused));
  assert.equal(Object.keys(handshake.resume.battery).length, 2048);
  assert(
    evidence.saveUploads.length > 0,
    "SNES SRAM was not flushed before relay launch",
  );
  assert(
    evidence.saveUploads.every(
      (save) =>
        save.finishedAt !== null && save.finishedAt <= handshake.receivedAt,
    ),
    "Room initialized before SRAM upload completed",
  );
  evidence.snesToolbar = {
    realCore: true,
    ...runtime,
    pausedBeforeRoom: true,
    savesBeforeHandshake: evidence.saveUploads.length,
  };
}

function assertClean(evidence) {
  assert.deepEqual(evidence.pageErrors, []);
  assert.deepEqual(evidence.missingAssets, []);
  assert.deepEqual(evidence.unexpectedRequests, []);
}

await mkdir(output, { recursive: true });
await readFile(resolve(dist, "index.html"));
try {
  await withHeadlessBrowser(async (browser) => {
    for (const options of [
      { platform: "gba", enabled: false },
      { platform: "snes", enabled: false },
      { platform: "psp", enabled: true },
    ]) {
      const item = await fixture(browser, options);
      try {
        assert.equal(
          await item.page
            .getByRole("button", { name: "Relay server", exact: true })
            .count(),
          0,
        );
        assertClean(item.evidence);
        report.scenarios.push({ ...item.evidence, hidden: true });
      } finally {
        await item.context.close();
      }
    }
    for (const theme of ["dark", "light"]) {
      for (const platform of ["gb", "gbc", "gba", "snes"]) {
        const item = await fixture(browser, { platform, enabled: true, theme });
        const { page, context, evidence } = item;
        try {
          const button = page.getByRole("button", {
            name: "Relay server",
            exact: true,
          });
          await button.waitFor();
          assert.equal(await button.isEnabled(), true);
          const inputs = [];
          if (platform === "snes") {
            await openAndInspect(page, () => button.click(), item);
            inputs.push("mouse");
            await tabTo(page, button);
            await openAndInspect(
              page,
              () => page.keyboard.press("Enter"),
              item,
            );
            inputs.push("keyboard-tab-enter");
            await page.setViewportSize({ width: 390, height: 844 });
            await openAndInspect(page, () => button.tap(), item);
            inputs.push("trusted-touch");
            await page.setViewportSize({ width: 1280, height: 900 });
            await tabTo(page, button);
            await openAndInspect(
              page,
              async () => {
                await page.evaluate(() => {
                  window.testPad.connected = true;
                  window.dispatchEvent(new Event("gamepadconnected"));
                  window.testPad.buttons[0] = {
                    pressed: true,
                    touched: true,
                    value: 1,
                  };
                });
              },
              item,
            );
            await page.evaluate(() => {
              window.testPad.connected = false;
            });
            inputs.push("standard-gamepad-a");
            const responsive = [];
            for (const width of [320, 768, 1280, 1920]) {
              await page.setViewportSize({ width, height: 900 });
              const fits = await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              );
              assert(fits, `${theme}/${width}: horizontal overflow`);
              assert(await button.isVisible());
              responsive.push({ width, fits });
            }
            evidence.responsive = responsive;
            await page.setViewportSize({ width: 1280, height: 900 });
            await page.screenshot({
              path: resolve(output, `launcher-${theme}.png`),
            });
            if (theme === "dark") await checkSnesToolbar(item, theme);
          }
          assertClean(evidence);
          report.scenarios.push({ ...evidence, visible: true, inputs });
          console.log(JSON.stringify({ theme, platform, inputs, pass: true }));
        } catch (error) {
          report.failure = {
            message: error.stack,
            evidence,
            url: page.url(),
            text: (await page.locator("body").innerText()).slice(-4000),
          };
          await page
            .screenshot({ path: resolve(output, "failure.png") })
            .catch(() => {});
          throw error;
        } finally {
          await context.close();
        }
      }
    }
    // Click Play while the broker configuration is still in flight. A late
    // enabled response must install the relay callback before the core boots.
    const delayed = await fixture(browser, {
      platform: "snes",
      enabled: true,
      configDelayMs: 3000,
    });
    try {
      assert.equal(delayed.evidence.configResponses.length, 0);
      await checkSnesToolbar(delayed, "delayed-config");
      assertClean(delayed.evidence);
      report.scenarios.push({ ...delayed.evidence, delayedConfigMs: 3000 });
      console.log(JSON.stringify({ delayedConfigMs: 3000, pass: true }));
    } catch (error) {
      report.failure = { message: error.stack, evidence: delayed.evidence };
      throw error;
    } finally {
      await delayed.context.close();
    }
  });
  report.pass = true;
} finally {
  await writeFile(
    resolve(output, "result.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
}
console.log(
  JSON.stringify({ pass: true, scenarios: report.scenarios.length, output }),
);
