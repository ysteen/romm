import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { expect, test as baseTest, type Page } from "@playwright/test";

const endpoint = process.env.AZAHAR_CDP_ENDPOINT;
const test = endpoint
  ? baseTest.extend({
      browser: async ({ playwright }, use) => {
        const browser = await playwright.chromium.connectOverCDP(endpoint, {
          noDefaults: true,
        });
        try {
          await use(browser);
        } finally {
          // Disconnect from Chrome without closing its existing user contexts.
          await browser.close();
        }
      },
    })
  : baseTest;

test.skip(
  !process.env.AZAHAR_BROWSER_TEST,
  "Run with playwright.azahar.config.ts and AZAHAR_BROWSER_TEST=1",
);

interface FixtureState {
  captures: number;
  restores: number;
  pauses: number;
  resumes: number;
  emptyCapture: boolean;
  failLoad: boolean;
  previewFails: boolean;
  importedSystemUrl: string | null;
  loadedBytes: number[];
}

declare global {
  interface Window {
    __azaharFixture: FixtureState;
  }
}

function installMockRuntime() {
  const fixture = window.__azaharFixture;
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = "/assets/emulatorjs/data/emulator.css";
  document.head.appendChild(stylesheet);
  const runtime = {
    started: false,
    paused: false,
    config: { defaultOptions: window.EJS_defaultOptions },
    settings: {},
    getCore: () => "azahar",
    getLocalStorageKey: () => "azahar-browser-fixture-settings",
    preGetSetting: (_setting: string): unknown => null,
    play() {
      this.paused = false;
      fixture.resumes++;
    },
    pause() {
      this.paused = true;
      fixture.pauses++;
    },
    callEvent(_name: string) {},
    gameManager: {
      FS: {},
      getSaveFilePath: () => "/synthetic.srm",
      supportsStates: () => true,
      async getState() {
        fixture.captures++;
        return fixture.emptyCapture
          ? new Uint8Array()
          : new Uint8Array([82, 65, 1, 2]);
      },
      async loadState(data: Uint8Array) {
        fixture.restores++;
        if (fixture.failLoad) throw new Error("Synthetic incompatible state");
        fixture.loadedBytes = Array.from(data);
      },
      async screenshot() {
        if (fixture.previewFails)
          throw new Error("Synthetic screenshot failure");
        return new Uint8Array([137, 80, 78, 71]);
      },
    },
  };
  window.EJS_emulator = runtime;
  const ready = window.setInterval(() => {
    const host = document.getElementById("game");
    if (
      !host ||
      !stylesheet.sheet ||
      typeof window.EJS_onGameStart !== "function"
    )
      return;
    window.clearInterval(ready);
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 480;
    canvas.className = "ejs_canvas";
    canvas.setAttribute("aria-label", "Synthetic Azahar canvas");
    host.classList.add("ejs_parent");
    const canvasParent = document.createElement("div");
    canvasParent.className = "ejs_canvas_parent";
    canvasParent.appendChild(canvas);
    host.appendChild(canvasParent);
    fixture.importedSystemUrl = window.EJS_biosUrl || null;
    runtime.started = true;
    void window.EJS_onGameStart();
  }, 20);
}

const origin = "http://127.0.0.1:8081";
const dist = resolve("dist");
const romId = 2147483590;
const firmware = [
  {
    id: 901,
    platform_id: romId,
    file_name: "other-system-data.zip",
    file_path: "bios/3ds",
    missing_from_fs: false,
  },
  {
    id: 902,
    platform_id: romId,
    file_name: "azahar-mii-system-data.zip",
    file_path: "bios/3ds",
    missing_from_fs: false,
  },
];
const rom = {
  id: romId,
  name: "Azahar synthetic UI fixture",
  fs_name: "synthetic.3ds",
  fs_name_no_ext: "synthetic",
  fs_name_no_tags: "synthetic.3ds",
  fs_extension: "3ds",
  fs_size_bytes: 4,
  platform_id: romId,
  platform_slug: "3ds",
  platform_fs_slug: "3ds",
  platform_custom_name: null,
  platform_display_name: "Nintendo 3DS",
  is_identified: false,
  is_unidentified: true,
  has_multiple_files: false,
  has_simple_single_file: true,
  has_nested_single_file: false,
  has_manual: false,
  has_soundtrack: false,
  files: [],
  sibling_roms: [],
  user_saves: [],
  user_states: [],
  user_screenshots: [],
  all_user_saves: [],
  all_user_states: [],
  all_user_screenshots: [],
  all_user_notes: [],
  user_collections: [],
  merged_screenshots: [],
  alternative_names: [],
  regions: [],
  languages: [],
  tags: [],
  metadatum: { companies: [], genres: [], franchises: [], collections: [] },
  rom_user: {
    is_main_sibling: false,
    is_favorite: false,
    now_playing: false,
    backlogged: false,
    hidden: false,
    status: null,
  },
};
const user = {
  id: romId,
  username: "azahar-browser-fixture",
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
  FILESYSTEM: { FS_PLATFORMS: ["3ds"] },
  OIDC: {},
  TASKS: {},
};

async function setup(
  page: Page,
  options: {
    theme?: "dark" | "light";
    uploadFailure?: boolean;
    noFirmware?: boolean;
    storedFirmwareId?: number;
  } = {},
) {
  if (endpoint)
    expect(page.context()).not.toBe(page.context().browser()?.contexts()[0]);
  const evidence = {
    stateUploads: [] as string[],
    stateDownloads: [] as string[],
    writes: [] as string[],
    external: [] as string[],
    pageErrors: [] as string[],
  };
  page.on("pageerror", (error) => evidence.pageErrors.push(error.message));
  await page.addInitScript(
    ({ theme, romId, storedFirmwareId }) => {
      localStorage.setItem("settings.uiVersion", "v2");
      localStorage.setItem("settings.locale", "en_US");
      localStorage.setItem("settings.theme", theme);
      localStorage.setItem("emulation.fullScreenOnPlay", "false");
      localStorage.setItem(`player:${romId}:core`, "azahar");
      if (storedFirmwareId !== undefined)
        localStorage.setItem("player:3ds:bios_id", String(storedFirmwareId));
      window.__azaharFixture = {
        captures: 0,
        restores: 0,
        pauses: 0,
        resumes: 0,
        emptyCapture: false,
        failLoad: false,
        previewFails: false,
        importedSystemUrl: null,
        loadedBytes: [],
      };
    },
    {
      theme: options.theme ?? "dark",
      romId,
      storedFirmwareId: options.storedFirmwareId,
    },
  );
  await page.routeWebSocket(/.*/, (socket) => socket.close());
  // Never fall through to RomM or a CDN, including unexpected API writes.
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      url.href === "https://api.github.com/repos/rommapp/romm/releases/latest"
    )
      return route.fulfill({ json: { tag_name: "5.2.0" } });
    if (url.origin !== origin) {
      evidence.external.push(url.origin);
      return route.abort();
    }
    if (url.pathname === "/assets/emulatorjs/data/loader.js")
      return route.fulfill({
        contentType: "text/javascript",
        body: `(${installMockRuntime.toString()})();`,
      });
    if (url.pathname === "/assets/emulatorjs/data/emulator.css")
      return route.fulfill({
        contentType: "text/css",
        body: await readFile(resolve("../custom-emulatorjs/data/emulator.css")),
      });
    if (url.pathname.startsWith("/api/")) {
      if (request.method() !== "GET") {
        evidence.writes.push(`${request.method()} ${url.pathname}`);
        if (request.method() === "POST" && url.pathname === "/api/states") {
          const multipart = request.postDataBuffer()?.toString("latin1") ?? "";
          const filename =
            /name="stateFile"; filename="([^"]+)"/.exec(multipart)?.[1] ??
            "missing.state";
          evidence.stateUploads.push(filename);
          expect(url.searchParams.get("emulator")).toBe("azahar");
          expect(url.searchParams.get("rom_id")).toBe(String(romId));
          if (options.uploadFailure)
            return route.fulfill({
              status: 500,
              json: { detail: "Synthetic upload failure" },
            });
          const stateId = evidence.stateUploads.length;
          return route.fulfill({
            json: {
              id: stateId,
              rom_id: romId,
              user_id: romId,
              emulator: "azahar",
              file_name: filename,
              file_name_no_tags: filename,
              file_name_no_ext: filename.replace(/\.state$/, ""),
              file_extension: "state",
              file_path: `states/${filename}`,
              full_path: `/states/${filename}`,
              file_size_bytes: 4,
              download_path: `/api/states/${stateId}/content`,
              missing_from_fs: false,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              screenshot: null,
            },
          });
        }
        return route.fulfill({
          json: url.pathname.startsWith("/api/users") ? user : {},
        });
      }
      if (/^\/api\/states\/\d+\/content$/.test(url.pathname)) {
        evidence.stateDownloads.push(url.pathname);
        return route.fulfill({
          contentType: "application/octet-stream",
          body: Buffer.from([82, 65, 1, 2]),
        });
      }
      if (url.pathname === "/api/heartbeat")
        return route.fulfill({ json: heartbeat });
      if (url.pathname === "/api/users/me")
        return route.fulfill({ json: user });
      if (url.pathname === "/api/config")
        return route.fulfill({ json: config });
      if (url.pathname === "/api/permissions/me")
        return route.fulfill({
          json: {
            is_admin: true,
            grants: [],
            hidden: { platforms: [], roms: [] },
          },
        });
      if (url.pathname === "/api/streaming/config")
        return route.fulfill({ json: { enabled: false, containers: [] } });
      if (url.pathname === `/api/roms/${romId}`)
        return route.fulfill({ json: rom });
      if (url.pathname === "/api/roms")
        return route.fulfill({
          json: { items: [rom], total: 1, limit: 72, offset: 0 },
        });
      if (url.pathname === "/api/firmware")
        return route.fulfill({ json: options.noFirmware ? [] : firmware });
      if (
        url.pathname.startsWith("/api/collections") ||
        url.pathname.startsWith("/api/platforms")
      )
        return route.fulfill({ json: [] });
      return route.fulfill({ json: {} });
    }
    if (url.pathname.startsWith("/ws")) return route.fulfill({ status: 204 });
    const path = url.pathname.startsWith("/assets/")
      ? resolve(dist, `.${url.pathname}`)
      : resolve(dist, "index.html");
    if (!path.startsWith(dist + sep)) return route.abort();
    try {
      const body = await readFile(path);
      const types: Record<string, string> = {
        js: "text/javascript",
        css: "text/css",
        html: "text/html",
        json: "application/json",
        svg: "image/svg+xml",
      };
      return route.fulfill({
        body,
        contentType:
          types[path.split(".").at(-1) ?? ""] ?? "application/octet-stream",
      });
    } catch {
      return route.fulfill({ status: 404 });
    }
  });
  await page.goto(`/rom/${romId}/ejs`);
  await expect(page.getByRole("heading", { name: rom.name })).toBeVisible();
  await expect(
    page.getByText("Mii system data", { exact: true }),
  ).toBeVisible();
  return evidence;
}

async function launch(page: Page) {
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save state", exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel("Synthetic Azahar canvas")).toBeVisible();
}

async function confirmLoad(page: Page) {
  await page.getByRole("button", { name: "Load state", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Load state", exact: true }).click();
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: server Mii firmware auto-selection, guidance and responsive layout`, async ({
    page,
  }, testInfo) => {
    const evidence = await setup(page, { theme });
    await expect(page.locator("html")).toHaveClass(new RegExp(`r-v2-${theme}`));
    await expect(
      page.locator('.r-azahar-system input[type="file"]'),
    ).toHaveCount(0);
    await expect(
      page.getByText(/Selected server firmware: azahar-mii-system-data.zip/),
    ).toBeVisible();
    await expect(
      page.getByText("bios/3ds/azahar-mii-system-data.zip", { exact: true }),
    ).toBeVisible();
    await page.getByText("How to prepare Mii data", { exact: true }).click();
    await expect(
      page.getByText(/This does not generate Mii faces/),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Official GodMode9 guide" }),
    ).toHaveAttribute("href", "https://github.com/d0k3/GodMode9#readme");
    for (const width of [320, 600, 960, 1440, 3840]) {
      await page.setViewportSize({ width, height: width > 1920 ? 2160 : 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: testInfo.outputPath(`${theme}-mii-configuration.png`),
      fullPage: true,
    });
    expect(evidence.stateUploads).toEqual([]);
    expect(evidence.external).toEqual([]);
    expect(evidence.pageErrors).toEqual([]);
    await page.reload();
    await expect(
      page.getByText(/Selected server firmware: azahar-mii-system-data.zip/),
    ).toBeVisible();
    await launch(page);
    expect(
      await page.evaluate(() => window.__azaharFixture.importedSystemUrl),
    ).toMatch(/\/api\/firmware\/902\/content\/azahar-mii-system-data.zip$/);
  });
}

test("missing Mii firmware shows the server folder without requiring an upload", async ({
  page,
}) => {
  const evidence = await setup(page, { noFirmware: true });
  await expect(
    page.getByText(/No system-data firmware selected/),
  ).toBeVisible();
  await expect(
    page.getByText("bios/3ds/azahar-mii-system-data.zip", { exact: true }),
  ).toBeVisible();
  await launch(page);
  expect(
    await page.evaluate(() => window.__azaharFixture.importedSystemUrl),
  ).toBeNull();
  expect(evidence.pageErrors).toEqual([]);
});

test("an explicit firmware choice takes precedence over automatic Mii selection", async ({
  page,
}) => {
  const evidence = await setup(page, { storedFirmwareId: 901 });
  await expect(
    page.getByText(/Selected server firmware: other-system-data.zip/),
  ).toBeVisible();
  await launch(page);
  expect(
    await page.evaluate(() => window.__azaharFixture.importedSystemUrl),
  ).toMatch(/\/api\/firmware\/901\/content\/other-system-data.zip$/);
  expect(evidence.pageErrors).toEqual([]);
});

test("manual state upload, independent preview failure, confirmation, restore and paused-session preservation", async ({
  page,
}, testInfo) => {
  const evidence = await setup(page);
  await launch(page);
  await page.evaluate(() => {
    window.__azaharFixture.previewFails = true;
    window.EJS_emulator.paused = true;
  });
  const save = page.getByRole("button", { name: "Save state", exact: true });
  await save.click();
  await expect(
    page.getByText("State saved to RomM.", { exact: true }),
  ).toBeVisible();
  expect(evidence.stateUploads[0]).toMatch(/^azahar-2147483590-.+\.state$/);
  await save.click();
  await expect.poll(() => evidence.stateUploads.length).toBe(2);
  expect(new Set(evidence.stateUploads).size).toBe(2);
  await page.getByRole("button", { name: "Load state", exact: true }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(evidence.stateDownloads).toHaveLength(0);
  await confirmLoad(page);
  await expect(page.getByText("State loaded.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__azaharFixture.loadedBytes)).toEqual(
    [82, 65, 1, 2],
  );
  expect(await page.evaluate(() => window.EJS_emulator.paused)).toBe(true);
  expect(await page.evaluate(() => window.EJS_emulator.rewindEnabled)).toBe(
    false,
  );
  await save.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.locator('.r-v2-azahar-states button[aria-haspopup="listbox"]'),
  ).toBeFocused();
  await page
    .locator('.r-v2-azahar-states button[aria-haspopup="listbox"]')
    .dispatchEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
  await expect(
    page.getByRole("button", { name: "Load state", exact: true }),
  ).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath("manual-state-controls.png"),
  });
  expect(
    evidence.writes.some((entry) => entry.startsWith("PUT /api/states")),
  ).toBe(false);
  expect(evidence.external).toEqual([]);
  expect(evidence.pageErrors).toEqual([]);
});

test("failed core restore and empty capture never report success or upload another state", async ({
  page,
}) => {
  const evidence = await setup(page);
  await launch(page);
  await page.getByRole("button", { name: "Save state", exact: true }).click();
  await expect(
    page.getByText("State saved to RomM.", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.__azaharFixture.failLoad = true;
  });
  await confirmLoad(page);
  await expect(page.getByText(/Could not load the state/)).toBeVisible();
  await expect(page.getByText("State loaded.", { exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    window.__azaharFixture.emptyCapture = true;
  });
  await page.getByRole("button", { name: "Save state", exact: true }).click();
  await expect(page.getByText(/Could not save the state/)).toBeVisible();
  expect(evidence.stateUploads).toHaveLength(1);
  expect(evidence.pageErrors).toEqual([]);
});

test("rejected state upload leaves the state picker empty and recovers controls", async ({
  page,
}) => {
  const evidence = await setup(page, { uploadFailure: true });
  await launch(page);
  const save = page.getByRole("button", { name: "Save state", exact: true });
  await save.click();
  await expect(page.getByText(/Could not save the state/)).toBeVisible();
  await expect(
    page.getByText("State saved to RomM.", { exact: true }),
  ).toHaveCount(0);
  await expect(save).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Load state", exact: true }),
  ).toBeDisabled();
  expect(evidence.stateUploads).toHaveLength(1);
  expect(evidence.pageErrors).toEqual([]);
});

test("touch automatically loads server system data and saves from a narrow viewport", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({
    baseURL: origin,
    hasTouch: true,
    viewport: { width: 390, height: 844 },
    serviceWorkers: "block",
    reducedMotion: "reduce",
  });
  try {
    const page = await context.newPage();
    const evidence = await setup(page, { theme: "light" });
    await page.getByRole("button", { name: "Play", exact: true }).tap();
    const save = page.getByRole("button", { name: "Save state", exact: true });
    await expect(save).toBeEnabled();
    // A translucent light-theme panel over the black canvas hides its text.
    await expect(page.locator(".r-v2-azahar-states")).toHaveCSS(
      "background-color",
      "rgb(245, 245, 250)",
    );
    expect(
      await page.evaluate(() => window.__azaharFixture.importedSystemUrl),
    ).toMatch(/\/api\/firmware\/902\/content\/azahar-mii-system-data.zip$/);
    await save.tap();
    await expect(
      page.getByText("State saved to RomM.", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("touch-state-controls.png"),
      fullPage: true,
    });
    expect(evidence.stateUploads).toHaveLength(1);
    expect(evidence.external).toEqual([]);
    expect(evidence.pageErrors).toEqual([]);
  } finally {
    await context.close();
  }
});
