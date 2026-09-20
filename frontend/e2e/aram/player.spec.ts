import { readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { expect, test as baseTest, type Page } from "@playwright/test";

const endpoint = process.env.ARAM_CDP_ENDPOINT;
const test = endpoint
  ? baseTest.extend({
      browser: async ({ playwright }, use) => {
        const browser = await playwright.chromium.connectOverCDP(endpoint, {
          noDefaults: true,
        });
        try {
          await use(browser);
        } finally {
          // A CDP connection closes our contexts and disconnects, not Chrome.
          await browser.close();
        }
      },
    })
  : baseTest;

// Every API call is intercepted. No game, account, save, or setting is created.
test.skip(
  !process.env.ARAM_BROWSER_TEST,
  "Run with playwright.aram.config.ts and ARAM_BROWSER_TEST=1",
);

const base = "http://127.0.0.1:8081";
const dist = resolve("dist");
const rom = {
  id: 2147483600,
  name: "ARAM synthetic package",
  fs_name: "synthetic.dat",
  fs_name_no_ext: "synthetic",
  fs_name_no_tags: "synthetic.dat",
  fs_extension: "dat",
  fs_size_bytes: 4,
  platform_id: 2147483600,
  platform_slug: "wipi",
  platform_fs_slug: "wipi",
  platform_custom_name: null,
  platform_display_name: "WIPI",
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
  id: 2147483600,
  username: "aram-browser-fixture",
  role: "admin",
  enabled: true,
  oauth_scopes: ["roms.read", "roms.user.write", "me.read", "me.write"],
  avatar_path: "",
  ui_settings: { uiVersion: "v2", locale: "en_US" },
};
const config = {
  PLATFORMS_VERSIONS: {},
  PLATFORMS_BINDING: {},
  EJS_SETTINGS: {},
  EJS_CONTROLS: {},
  EJS_NETPLAY_ENABLED: false,
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
  FILESYSTEM: { FS_PLATFORMS: ["wipi"] },
  OIDC: {},
  TASKS: {},
};

async function setup(
  page: Page,
  options: {
    theme?: "dark" | "light";
    missing?: boolean;
    allowed?: boolean;
    contentStatus?: number;
    delayContent?: boolean;
    huge?: boolean;
  } = {},
) {
  if (endpoint)
    expect(page.context()).not.toBe(page.context().browser()?.contexts()[0]);
  const contentRequests: string[] = [];
  const externalRequests: string[] = [];
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const writes: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.addInitScript(
    ({ theme }) => {
      if (window.parent !== window) return;
      localStorage.setItem("settings.uiVersion", "v2");
      localStorage.setItem("settings.locale", "en_US");
      localStorage.setItem("settings.theme", theme);
      localStorage.setItem("aram-test-unrelated", "preserved");
    },
    { theme: options.theme ?? "dark" },
  );
  await page.routeWebSocket(/.*/, (socket) => socket.close());
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      request.frame() === page.mainFrame() &&
      request.url() ===
        "https://api.github.com/repos/rommapp/romm/releases/latest"
    ) {
      return route.fulfill({ json: { tag_name: "5.2.0" } });
    }
    if (url.origin !== base) {
      externalRequests.push(url.origin);
      return route.abort();
    }
    if (url.pathname.startsWith("/api/")) {
      if (request.method() !== "GET") {
        writes.push(url.pathname);
        return route.fulfill({
          json: url.pathname.startsWith("/api/users") ? user : {},
        });
      }
      if (url.pathname.includes("/content/")) {
        contentRequests.push(url.pathname);
        if (options.delayContent) return;
        return route.fulfill({
          status: options.contentStatus ?? 200,
          contentType: "application/octet-stream",
          body: Buffer.from([0, 0, 0, 0]),
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
            is_admin: options.allowed !== false,
            grants: [],
            hidden: { platforms: [], roms: [] },
          },
        });
      if (url.pathname === "/api/streaming/config")
        return route.fulfill({ json: { enabled: false, containers: [] } });
      if (url.pathname === `/api/roms/${rom.id}`)
        return route.fulfill({
          json: {
            ...rom,
            fs_size_bytes: options.huge ? 32 * 1024 * 1024 + 1 : 4,
          },
        });
      if (url.pathname === "/api/roms")
        return route.fulfill({
          json: { items: [rom], total: 1, limit: 72, offset: 0 },
        });
      if (url.pathname.startsWith("/api/collections"))
        return route.fulfill({ json: [] });
      if (url.pathname.startsWith("/api/platforms"))
        return route.fulfill({ json: [] });
      return route.fulfill({ json: {} });
    }
    if (options.missing && url.pathname.endsWith("/runtime.json"))
      return route.fulfill({ status: 404 });
    if (
      process.env.ARAM_RUNTIME_FROM_SERVER === "1" &&
      url.pathname.startsWith("/assets/aram/0.3.0/")
    )
      return route.continue();
    if (url.pathname.startsWith("/ws")) return route.fulfill({ status: 204 });
    const path =
      url.pathname.startsWith("/assets/") || url.pathname === "/aram.html"
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
        wasm: "application/wasm",
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
  await page.goto(`/rom/${rom.id}/aram`);
  await expect(page.getByRole("heading", { name: "ARAM 0.3.0" })).toBeVisible();
  return {
    contentRequests,
    externalRequests,
    pageErrors,
    consoleErrors,
    writes,
  };
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: configuration, responsive layout, keyboard and simulated gamepad navigation`, async ({
    page,
  }, testInfo) => {
    const evidence = await setup(page, { theme });
    const play = page.getByRole("button", { name: "Play", exact: true });
    await expect(play).toBeEnabled();
    await expect(page.locator("html")).toHaveClass(new RegExp(`r-v2-${theme}`));
    for (const width of [320, 600, 960, 1440, 3840]) {
      await page.setViewportSize({ width, height: width > 1920 ? 2160 : 900 });
      await expect(play).toBeInViewport();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await play.focus();
    await page.keyboard.press("ArrowDown");
    await expect(
      page.getByRole("button", { name: "Back to game details", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(play).toBeFocused();
    await play.dispatchEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    await expect(
      page.getByRole("button", { name: "Back to game details", exact: true }),
    ).toBeFocused();
    await page.screenshot({
      path: testInfo.outputPath(`${theme}-configuration.png`),
    });
    expect(evidence.contentRequests).toHaveLength(0);
    expect(evidence.externalRequests).toEqual([]);
    expect(evidence.pageErrors).toEqual([]);
  });
}

test("actual pinned WASM boots with synthetic input, blocks forged events and terminates on exit", async ({
  page,
}, testInfo) => {
  const evidence = await setup(page);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  const frameLocator = page.frameLocator("iframe.r-v2-aram__frame");
  try {
    await expect(frameLocator.locator("canvas")).toBeVisible({
      timeout: 30000,
    });
  } catch (error) {
    const path = testInfo.outputPath("runtime-diagnostics.json");
    await writeFile(path, JSON.stringify(evidence, null, 2));
    await testInfo.attach("runtime-diagnostics", {
      path,
      contentType: "application/json",
    });
    throw error;
  }
  await expect(page.locator(".r-v2-aram__loading")).toHaveCount(0);
  expect(evidence.contentRequests).toHaveLength(1);
  await page.evaluate(() =>
    window.postMessage(
      { channel: "romm:aram:1", type: "error" },
      location.origin,
    ),
  );
  await expect(frameLocator.locator("canvas")).toBeVisible();
  const settings = await page.evaluate(() => {
    const raw = localStorage.getItem("romm:aram:user:2147483600:aram.settings");
    return {
      analyticsDisabled: raw
        ? JSON.parse(raw).analytics_enabled === false
        : false,
      unrelatedPreserved:
        localStorage.getItem("aram-test-unrelated") === "preserved",
    };
  });
  expect(settings).toEqual({
    analyticsDisabled: true,
    unrelatedPreserved: true,
  });
  await page.screenshot({ path: testInfo.outputPath("aram-wasm-canvas.png") });
  const child = page.frames().find((f) => f.url().endsWith("/aram.html"));
  await page.getByRole("button", { name: "Quit", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(frameLocator.locator("canvas")).toBeVisible();
  await page.getByRole("button", { name: "Quit", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Quit", exact: true })
    .click();
  await expect(page.locator("iframe.r-v2-aram__frame")).toHaveCount(0);
  expect(child?.isDetached()).toBe(true);
  expect(evidence.externalRequests).toEqual([]);
  expect(evidence.pageErrors).toEqual([]);
});

test("missing runtime and denied play permission stay disabled", async ({
  page,
}) => {
  await setup(page, { missing: true });
  await expect(
    page.getByText("The optional ARAM web runtime is not installed."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeDisabled();
});

test("no permission prevents a direct player launch", async ({ page }) => {
  const evidence = await setup(page, { allowed: false });
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeDisabled();
  expect(evidence.contentRequests).toHaveLength(0);
});

test("download errors recover without starting the emulator", async ({
  page,
}) => {
  const evidence = await setup(page, { contentStatus: 403 });
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(
    page.locator(".r-v2-aram__config").getByText(/ARAM could not start/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeEnabled();
  await expect(page.locator("iframe.r-v2-aram__frame")).toHaveCount(0);
  expect(evidence.pageErrors).toEqual([]);
});

test("oversized metadata prevents the download", async ({ page }) => {
  const evidence = await setup(page, { huge: true });
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(
    page
      .locator(".r-v2-aram__config")
      .getByText("ARAM accepts games up to 32 MiB."),
  ).toBeVisible();
  expect(evidence.contentRequests).toHaveLength(0);
});

test("touch can start and cancel an in-flight launch", async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: base,
    hasTouch: true,
    viewport: { width: 390, height: 844 },
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  try {
    await setup(page, { delayContent: true });
    await page.getByRole("button", { name: "Play", exact: true }).tap();
    await expect(page.locator(".r-v2-aram__loading")).toBeVisible();
    await page.getByRole("button", { name: "Quit", exact: true }).tap();
    await expect(page).toHaveURL(`/rom/${rom.id}`);
    await expect(page.locator("iframe.r-v2-aram__frame")).toHaveCount(0);
  } finally {
    await context.close();
  }
});
