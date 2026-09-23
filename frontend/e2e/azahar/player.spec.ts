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
  options: Record<string, string>;
}

declare global {
  interface Window {
    __azaharFixture: FixtureState;
    __fixtureEmulator: { prototype: object };
    __fixtureManager: { prototype: object };
  }
}

function installMockRuntime() {
  const fixture = window.__azaharFixture;
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = "/assets/emulatorjs/data/emulator.css";
  document.head.appendChild(stylesheet);
  const states = new Map<string, Uint8Array>();
  const runtime = Object.assign(
    Object.create(window.__fixtureEmulator.prototype),
    {
      started: false,
      paused: false,
      config: { defaultOptions: window.EJS_defaultOptions },
      settings: {},
      allSettings: {},
      controls: {},
      cheats: [],
      volume: 1,
      muted: false,
      settingsLoaded: false,
      functions: {},
      listeners: [],
      videoRotation: 0,
      capture: {
        photo: { source: "canvas", format: "png", upscale: 1 },
        video: {
          fps: 60,
          format: "webm",
          upscale: 1,
          videoBitrate: 2621440,
          audioBitrate: 196608,
        },
      },
      getCore: () => "azahar",
      getCores: () => ({ azahar: ["azahar"] }),
      requiresThreads: () => true,
      requiresWebGL2: () => true,
      getLocalStorageKey: () => "azahar-browser-fixture-settings",
      getBaseFileName: () => "synthetic",
      saveInBrowserSupported: () => true,
      storage: {
        states: {
          async put(key: string, data: Uint8Array) {
            states.set(key, data);
          },
          async get(key: string) {
            return states.get(key);
          },
        },
      },
      localization: (text: string) => text,
      handleSpecialOptions() {},
      toggleFullscreen() {},
      displayMessage(text: string) {
        const message = document.querySelector("#game .ejs_message");
        if (message) message.textContent = text;
      },
      play() {
        this.paused = false;
        fixture.resumes++;
      },
      pause() {
        this.paused = true;
        fixture.pauses++;
      },
      gameManager: Object.assign(
        Object.create(window.__fixtureManager.prototype),
        {
          FS: {},
          getSaveFilePath: () => "/synthetic.srm",
          getSaveFile: () => new Uint8Array([80, 75, 1, 2]),
          saveSaveFiles() {},
          getCoreOptions: () =>
            [
              `citra_graphics_api|${fixture.options.citra_graphics_api}; auto|OpenGL|Software|Vulkan`,
              `citra_use_hw_shaders|${fixture.options.citra_use_hw_shaders}; enabled|disabled`,
              `citra_use_webgl_hw_draw|${fixture.options.citra_use_webgl_hw_draw}; disabled|enabled`,
            ].join("\n"),
          getControllerPortInfo: () => "",
          setVariable(key: string, value: string) {
            fixture.options[key] = value;
          },
          supportsStates: () => true,
          async getState() {
            fixture.captures++;
            return fixture.emptyCapture
              ? new Uint8Array()
              : new Uint8Array([82, 65, 1, 2]);
          },
          async loadState(data: Uint8Array) {
            fixture.restores++;
            if (fixture.failLoad)
              throw new Error("Synthetic incompatible state");
            fixture.loadedBytes = Array.from(data);
          },
          async screenshot() {
            if (fixture.previewFails)
              throw new Error("Synthetic screenshot failure");
            return new Uint8Array([137, 80, 78, 71]);
          },
        },
      ),
    },
  );
  runtime.gameManager.EJS = runtime;
  runtime.on(
    "saveState",
    (data: Parameters<typeof window.EJS_onSaveState>[0]) =>
      window.EJS_onSaveState(data),
  );
  runtime.on("loadState", () => window.EJS_onLoadState());
  runtime.on("exit", () => {
    runtime.started = false;
  });
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
    const message = document.createElement("div");
    message.className = "ejs_message";
    message.setAttribute("role", "status");
    host.appendChild(message);
    const toolbar = document.createElement("div");
    toolbar.className = "ejs_menu_bar";
    toolbar.style.opacity = "1";
    toolbar.style.transform = "none";
    host.appendChild(toolbar);
    for (const [label, action] of [
      ["Pause", () => runtime.pause()],
      ["Play", () => runtime.play()],
      ["Save State", () => runtime.saveState()],
      ["Load State", () => runtime.loadState()],
      [
        "Settings",
        () => {
          runtime.settingsMenu.style.display =
            runtime.settingsMenu.style.display === "none" ? "" : "none";
        },
      ],
    ] as const) {
      const button = document.createElement("button");
      button.className = "ejs_menu_button";
      button.type = "button";
      button.setAttribute("aria-label", label);
      button.textContent = label;
      button.addEventListener("click", action);
      toolbar.appendChild(button);
    }
    runtime.settingParent = document.createElement("div");
    host.appendChild(runtime.settingParent);
    runtime.elements = { parent: host };
    runtime.setupSettingsMenu();
    const saved = JSON.parse(
      localStorage.getItem(runtime.getLocalStorageKey()) ?? "null",
    );
    for (const [key, value] of Object.entries(saved?.settings ?? {}))
      runtime.changeSettingOption(key, value);
    runtime.settingsLoaded = true;
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

function makeState(id: number, filename = `existing-${id}.state`) {
  return {
    id,
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
    download_path: `/api/states/${id}/content`,
    missing_from_fs: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    screenshot: null,
  };
}

async function setup(
  page: Page,
  options: {
    theme?: "dark" | "light";
    uploadFailure?: boolean;
    noFirmware?: boolean;
    storedFirmwareId?: number;
    existingState?: boolean;
    restoreInitially?: boolean;
    downloadFailure?: boolean;
    saveFailure?: boolean;
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
  const serverStates = options.existingState ? [makeState(90)] : [];
  const runtimeSources = await Promise.all(
    ["emulator.js", "GameManager.js"].map(async (name) =>
      (await readFile(resolve("../custom-emulatorjs/data/src", name), "utf8"))
        .replace(/^import .*;\r?$/gm, "")
        .replace(/^export default .*;\r?$/gm, "")
        .replace(/export\s*\{[^}]*\}\s*;?/g, ""),
    ),
  );
  const runtimeScript = `${runtimeSources.join("\n")}\nwindow.__fixtureEmulator = EmulatorJS; window.__fixtureManager = EJS_GameManager; (${installMockRuntime.toString()})();`;
  page.on("pageerror", (error) => evidence.pageErrors.push(error.message));
  await page.addInitScript(
    ({ theme, romId, storedFirmwareId }) => {
      // Exercise player navigation without unrelated view-transition animations.
      Object.defineProperty(document, "startViewTransition", {
        value: undefined,
      });
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
        options: {
          citra_graphics_api: "auto",
          citra_use_hw_shaders: "enabled",
          citra_use_webgl_hw_draw: "disabled",
        },
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
        body: runtimeScript,
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
          const state = makeState(stateId, filename);
          serverStates.unshift(state);
          return route.fulfill({
            json: state,
          });
        }
        if (request.method() === "POST" && url.pathname === "/api/saves")
          return route.fulfill(
            options.saveFailure
              ? { status: 500, json: { detail: "Synthetic save failure" } }
              : {
                  json: {
                    ...makeState(70, "synthetic.zip"),
                    file_extension: "zip",
                  },
                },
          );
        return route.fulfill({
          json: url.pathname.startsWith("/api/users") ? user : {},
        });
      }
      if (/^\/api\/states\/\d+\/content$/.test(url.pathname)) {
        evidence.stateDownloads.push(url.pathname);
        if (options.downloadFailure)
          return route.fulfill({
            status: 500,
            json: { detail: "Synthetic download failure" },
          });
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
        return route.fulfill({ json: { ...rom, user_states: serverStates } });
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
    page.locator(".r-azahar-system, .r-v2-azahar-states"),
  ).toHaveCount(0);
  if (options.existingState && !options.restoreInitially)
    await page.locator(".r-asset-preview__clear").click();
  return evidence;
}

async function launch(page: Page) {
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByLabel("Synthetic Azahar canvas")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save State", exact: true }),
  ).toBeVisible();
}

async function selectState(page: Page, keyboard = false) {
  await page.getByRole("button", { name: "Load State", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const state = dialog.locator('[data-asset-type="state"]').first();
  if (keyboard) {
    await state.focus();
    await page.keyboard.press("Enter");
  } else {
    await state.click();
  }
  await expect(dialog).toHaveCount(0);
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: ordinary player controls, automatic firmware and responsive layout`, async ({
    page,
  }, testInfo) => {
    const evidence = await setup(page, { theme });
    await expect(page.locator("html")).toHaveClass(new RegExp(`r-v2-${theme}`));
    await expect(
      page.getByText("Mii system data", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("How to prepare Mii data", { exact: true }),
    ).toHaveCount(0);
    for (const width of [320, 600, 960, 1440, 3840]) {
      await page.setViewportSize({ width, height: width > 1920 ? 2160 : 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await launch(page);
    expect(
      await page.evaluate(() => window.__azaharFixture.importedSystemUrl),
    ).toMatch(/\/api\/firmware\/902\/content\/azahar-mii-system-data.zip$/);
    await page.getByRole("button", { name: "Save State", exact: true }).click();
    await expect(
      page.getByText("State synced with server", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Load State", exact: true }).click();
    await expect(
      page.getByRole("dialog").locator('[data-asset-type="state"]'),
    ).toHaveCount(1);
    await page.screenshot({
      path: testInfo.outputPath(`${theme}-romm-state-picker.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(evidence.stateUploads).toHaveLength(1);
    expect(evidence.external).toEqual([]);
    expect(evidence.pageErrors).toEqual([]);
  });
}

test("Backend Core Options exposes all GPU controls and persists their values", async ({
  page,
}, testInfo) => {
  const evidence = await setup(page);
  await launch(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const backend = page.getByRole("button", {
    name: "Backend Core Options",
    exact: true,
  });
  await backend.focus();
  await page.keyboard.press("Enter");
  for (const [key, title, value] of [
    ["citra_graphics_api", "Graphics API", "OpenGL"],
    ["citra_use_hw_shaders", "Hardware Shaders", "enabled"],
    ["citra_use_webgl_hw_draw", "WebGL Hardware Draw", "enabled"],
  ]) {
    const row = page.locator(`[data-ejs-option="${key}"]`);
    await expect(row).toContainText(title);
    await row.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.locator('.ejs_option_row[ejs_value="Vulkan"]'),
    ).toHaveCount(0);
    await page.locator(`.ejs_option_row[ejs_value="${value}"]:visible`).click();
    await expect
      .poll(() =>
        page.evaluate((key) => window.__azaharFixture.options[key], key),
      )
      .toBe(value);
  }
  await page.screenshot({
    path: testInfo.outputPath("backend-gpu-options.png"),
  });
  await page.reload();
  await launch(page);
  expect(
    await page.evaluate(
      () => window.__azaharFixture.options.citra_graphics_api,
    ),
  ).toBe("OpenGL");
  expect(
    await page.evaluate(
      () => window.__azaharFixture.options.citra_use_webgl_hw_draw,
    ),
  ).toBe("enabled");
  expect(evidence.pageErrors).toEqual([]);
});

test("optional previews, unique uploads, native picker and latest server state", async ({
  page,
}) => {
  const evidence = await setup(page);
  await launch(page);
  await page.evaluate(() => {
    window.__azaharFixture.previewFails = true;
    window.EJS_emulator.pause();
  });
  const save = page.getByRole("button", { name: "Save State", exact: true });
  await save.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("State synced with server", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.EJS_emulator.paused)).toBe(true);
  await save.click();
  await expect.poll(() => evidence.stateUploads.length).toBe(2);
  expect(new Set(evidence.stateUploads).size).toBe(2);
  expect(evidence.stateUploads[0]).toMatch(/^azahar-2147483590-.+\.state$/);
  await selectState(page, true);
  await expect(
    page.getByText("State loaded from server", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__azaharFixture.loadedBytes)).toEqual(
    [82, 65, 1, 2],
  );
  await page
    .getByRole("button", { name: "Load Latest State", exact: true })
    .click();
  await expect.poll(() => evidence.stateDownloads.length).toBe(2);
  expect(evidence.stateDownloads[1]).toBe("/api/states/2/content");
  expect(await page.evaluate(() => window.EJS_emulator.rewindEnabled)).toBe(
    false,
  );
  expect(evidence.pageErrors).toEqual([]);
});

test("failed restore and empty capture never report success or upload invalid state", async ({
  page,
}) => {
  const evidence = await setup(page, { existingState: true });
  await launch(page);
  await page.evaluate(() => {
    window.__azaharFixture.failLoad = true;
  });
  await selectState(page);
  await expect(
    page.getByText("FAILED TO LOAD STATE", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.__azaharFixture.emptyCapture = true;
  });
  await page.getByRole("button", { name: "Save State", exact: true }).click();
  await expect(
    page.getByText("FAILED TO SAVE STATE", { exact: true }),
  ).toBeVisible();
  expect(evidence.stateUploads).toHaveLength(0);
  expect(evidence.pageErrors).toEqual([]);
});

test("failed download never passes bytes into the core", async ({ page }) => {
  const evidence = await setup(page, {
    existingState: true,
    downloadFailure: true,
  });
  await launch(page);
  await selectState(page);
  await expect(
    page.getByText("FAILED TO LOAD STATE", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__azaharFixture.restores)).toBe(0);
  expect(evidence.pageErrors).toEqual([]);
});

test("rejected upload leaves the RomM picker empty and allows retry", async ({
  page,
}) => {
  const evidence = await setup(page, { uploadFailure: true });
  await launch(page);
  const save = page.getByRole("button", { name: "Save State", exact: true });
  await save.click();
  await expect(
    page.getByText("Error syncing state with server", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Load State", exact: true }).click();
  await expect(
    page.getByRole("dialog").locator('[data-asset-type="state"]'),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await save.click();
  await expect.poll(() => evidence.stateUploads.length).toBe(2);
  expect(evidence.pageErrors).toEqual([]);
});

test("logical gamepad save and load actions use RomM controls", async ({
  page,
}) => {
  const evidence = await setup(page);
  await launch(page);
  await page.evaluate(() => {
    window.EJS_emulator.gameManager.simulateInput(0, 24, 1);
    window.EJS_emulator.gameManager.simulateInput(0, 24, 0);
  });
  await expect(
    page.getByText("State synced with server", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.EJS_emulator.gameManager.simulateInput(0, 25, 1);
    window.EJS_emulator.gameManager.simulateInput(0, 25, 0);
  });
  await expect(
    page.getByRole("dialog").locator('[data-asset-type="state"]'),
  ).toHaveCount(1);
  expect(evidence.stateUploads).toHaveLength(1);
  expect(evidence.pageErrors).toEqual([]);
});

test("Save & Quit uploads the save bundle and state before exiting", async ({
  page,
}) => {
  const evidence = await setup(page);
  await launch(page);
  await page.getByRole("button", { name: "Save & Quit", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/rom/${romId}$`));
  expect(evidence.stateUploads).toHaveLength(1);
  expect(evidence.writes).toContain("POST /api/saves");
  expect(evidence.pageErrors).toEqual([]);
});

for (const failure of ["state", "save"] as const) {
  test(`Save & Quit stays open if the ${failure} upload fails`, async ({
    page,
  }) => {
    const evidence = await setup(page, {
      uploadFailure: failure === "state",
      saveFailure: failure === "save",
    });
    await launch(page);
    await page
      .getByRole("button", { name: "Save & Quit", exact: true })
      .click();
    await expect(
      page.getByText("Error saving game", { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Synthetic Azahar canvas")).toBeVisible();
    expect(
      await page.evaluate(() => window.EJS_emulator.stateActionPending),
    ).toBe(false);
    expect(evidence.stateUploads).toHaveLength(1);
    expect(evidence.writes).toContain("POST /api/saves");
    expect(evidence.pageErrors).toEqual([]);
  });
}

test("a selected existing RomM state is restored once when launching", async ({
  page,
}) => {
  const evidence = await setup(page, {
    existingState: true,
    restoreInitially: true,
  });
  await launch(page);
  await expect(
    page.getByText("State loaded from server", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__azaharFixture.restores)).toBe(1);
  expect(await page.evaluate(() => window.__azaharFixture.loadedBytes)).toEqual(
    [82, 65, 1, 2],
  );
  expect(evidence.stateDownloads).toEqual(["/api/states/90/content"]);
  expect(evidence.pageErrors).toEqual([]);
});

test("explicit firmware selection takes precedence over automatic selection", async ({
  page,
}) => {
  const evidence = await setup(page, { storedFirmwareId: 901 });
  await launch(page);
  expect(
    await page.evaluate(() => window.__azaharFixture.importedSystemUrl),
  ).toMatch(/\/api\/firmware\/901\/content\/other-system-data.zip$/);
  expect(evidence.pageErrors).toEqual([]);
});

test("touch uses the standard toolbar on a narrow viewport without guidance panels", async ({
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
    const evidence = await setup(page, { theme: "light", noFirmware: true });
    await page.getByRole("button", { name: "Play", exact: true }).tap();
    await page.getByRole("button", { name: "Save State", exact: true }).tap();
    await expect(
      page.getByText("State synced with server", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => window.__azaharFixture.importedSystemUrl),
    ).toBeNull();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("touch-player-toolbar.png"),
      fullPage: true,
    });
    expect(evidence.stateUploads).toHaveLength(1);
    expect(evidence.external).toEqual([]);
    expect(evidence.pageErrors).toEqual([]);
  } finally {
    await context.close();
  }
});
