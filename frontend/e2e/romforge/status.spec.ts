import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { expect, test as baseTest, type Page } from "@playwright/test";
import type {
  RomForgeJobSchema,
  RomForgeStatus,
} from "../../src/__generated__";

const endpoint = process.env.ROMFORGE_CDP_ENDPOINT;
const test = baseTest.extend({
  browser: async ({ playwright }, use) => {
    if (!endpoint)
      throw new Error(
        "Set ROMFORGE_CDP_ENDPOINT to the existing debug Chrome endpoint.",
      );
    const browser = await playwright.chromium.connectOverCDP(endpoint, {
      noDefaults: true,
    });
    try {
      await use(browser);
    } finally {
      await browser.close();
    }
  },
});

test.skip(
  !endpoint,
  "Uses the project's existing Windows debug Chrome; no browser download is needed.",
);

function job(overrides: Partial<RomForgeJobSchema> = {}): RomForgeJobSchema {
  return {
    id: "running",
    status: "running",
    stage: "patching",
    operation: "3ds-normalize",
    file_id: 41,
    rom_id: 17,
    source_name: "Mario & Luigi - Dream Team.3ds",
    created_at: "2026-10-03T00:00:00Z",
    started_at: "2026-10-03T00:01:00Z",
    ended_at: null,
    ...overrides,
  };
}

function snapshot(): RomForgeStatus {
  return {
    worker: {
      enabled: true,
      available: true,
      extensions: [".ips"],
      max_file_size: 536870912,
      max_patch_size: 134217728,
      max_3ds_size: 8589934592,
      max_expanded_size: 2147483648,
      keys_ready: true,
      cia_ready: true,
      normalize_on_scan: true,
    },
    active: [
      job(),
      job({
        id: "queued",
        status: "queued",
        stage: "queued",
        source_name: "Animal Crossing - New Leaf.3ds",
      }),
    ],
    history: [
      job({
        id: "completed",
        status: "completed",
        stage: "completed",
        operation: "patch",
        source_name: "Example game.gba",
        output_rom_id: 18,
        output_file_name: "Example game (translated).gba",
        ended_at: "2026-10-03T00:02:00Z",
      }),
      job({
        id: "failed",
        status: "failed",
        stage: "failed",
        source_name: "Example archive.zip",
        error: "Source changed since scan",
        ended_at: "2026-10-03T00:01:00Z",
      }),
    ],
    pending_normalizations: 12,
    scan_running: false,
    history_limit: 50,
    retention_days: 7,
  };
}

async function setup(
  page: Page,
  options: {
    theme?: "dark" | "light";
    locale?: string;
    admin?: boolean;
    data?: RomForgeStatus;
    fail?: boolean;
  } = {},
) {
  const admin = options.admin ?? true;
  const locale = options.locale ?? "en_US";
  const state = {
    data: options.data ?? snapshot(),
    fail: options.fail ?? false,
    requests: 0,
    errors: [] as string[],
    writes: [] as string[],
  };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.addInitScript(
    ({ theme, locale }) => {
      Object.defineProperty(document, "startViewTransition", {
        value: undefined,
      });
      localStorage.setItem("settings.uiVersion", "v2");
      localStorage.setItem("settings.locale", locale);
      localStorage.setItem("settings.theme", theme);
    },
    { theme: options.theme ?? "dark", locale },
  );
  const origin = "http://127.0.0.1:8081";
  const dist = resolve("dist");
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith("/api/")) {
      if (request.method() !== "GET") {
        state.writes.push(`${request.method()} ${url.pathname}`);
        return route.fulfill({ json: {} });
      }
      if (url.pathname === "/api/roms/patcher/status") {
        state.requests++;
        return route.fulfill({
          status: state.fail ? 500 : 200,
          json: state.fail ? { detail: "Synthetic failure" } : state.data,
        });
      }
      if (url.pathname === "/api/heartbeat")
        return route.fulfill({
          json: {
            SYSTEM: { VERSION: "5.3.1", SHOW_SETUP_WIZARD: false },
            FRONTEND: {
              DISABLE_USERPASS_LOGIN: false,
              DISABLE_LOGS_VIEWER: false,
            },
            EMULATION: {},
            METADATA_SOURCES: {},
            FILESYSTEM: { FS_PLATFORMS: [] },
            OIDC: {},
            TASKS: {},
          },
        });
      if (url.pathname === "/api/users/me")
        return route.fulfill({
          json: {
            id: 99991,
            username: "romforge-ui-check",
            role: admin ? "admin" : "viewer",
            enabled: true,
            avatar_path: "",
            oauth_scopes: [
              "roms.read",
              "me.read",
              "me.write",
              ...(admin ? ["tasks.run", "users.write", "logs.read"] : []),
            ],
            ui_settings: { uiVersion: "v2", locale },
          },
        });
      if (url.pathname === "/api/permissions/me")
        return route.fulfill({
          json: {
            is_admin: admin,
            grants: [],
            hidden: { platforms: [], roms: [] },
          },
        });
      if (url.pathname === "/api/config")
        return route.fulfill({
          json: {
            PLATFORMS_VERSIONS: {},
            PLATFORMS_BINDING: {},
            EJS_SETTINGS: {},
            EJS_CONTROLS: {},
            SCAN_METADATA_PRIORITY: [],
            SCAN_ARTWORK_PRIORITY: [],
            SCAN_REGION_PRIORITY: [],
            SCAN_LANGUAGE_PRIORITY: [],
          },
        });
      if (url.pathname === "/api/streaming/config")
        return route.fulfill({ json: { enabled: false, containers: [] } });
      if (url.pathname === "/api/roms")
        return route.fulfill({
          json: { items: [], total: 0, limit: 72, offset: 0 },
        });
      if (
        url.pathname.startsWith("/api/platforms") ||
        url.pathname.startsWith("/api/collections")
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
        woff2: "font/woff2",
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
  await page.goto("/romforge");
  await page.bringToFront();
  return state;
}

test("system navigation, live status, links and refresh recovery", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1080 });
  const state = await setup(page);
  await expect(
    page.getByRole("heading", { name: "RomForge", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".romforge__metric dd")).toHaveText([
    "1",
    "1",
    "12",
  ]);
  await expect(
    page
      .locator(".r-v2-settings-sidebar")
      .getByRole("link", { name: "RomForge", exact: true }),
  ).toHaveAttribute("href", "/romforge");
  await expect(page.locator('[data-job-id="running"] a')).toHaveAttribute(
    "href",
    "/rom/17",
  );
  await expect(
    page.getByRole("link", { name: "Example game (translated).gba" }),
  ).toHaveAttribute("href", "/rom/18");
  await page.screenshot({
    path: "/tmp/romforge-status-dark.png",
    fullPage: true,
  });
  state.fail = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByText("Could not refresh job status.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Mario & Luigi - Dream Team.3ds", { exact: true }),
  ).toBeVisible();
  state.fail = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByText("Could not refresh job status.", { exact: false }),
  ).toHaveCount(0);
  const before = state.requests;
  await expect
    .poll(() => state.requests, { timeout: 8000 })
    .toBeGreaterThan(before);
  expect(state.errors).toEqual([]);
  expect(state.writes.filter((write) => write.includes("patch-jobs"))).toEqual(
    [],
  );
});

for (const theme of ["dark", "light"] as const) {
  test(`${theme} layout from phone to 4K with long names`, async ({ page }) => {
    const data = snapshot();
    data.active[0].source_name = "LongFilename".repeat(25) + ".3ds";
    data.history[0].output_file_name = "TranslatedFilename".repeat(20) + ".cci";
    const state = await setup(page, { theme, locale: "ko_KR", data });
    await expect(page.locator(".romforge__metric dd")).toHaveText([
      "1",
      "1",
      "12",
    ]);
    for (const width of [320, 390, 768, 1024, 1920, 3840]) {
      await page.setViewportSize({ width, height: 1080 });
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        )
        .toBe(true);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.bringToFront();
    await expect(
      page.getByRole("button", { name: "새로고침", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "새로고침", exact: true }).tap();
    await page.screenshot({
      path: `/tmp/romforge-status-${theme}-mobile.png`,
      fullPage: true,
    });
    await page.locator("[data-user-menu-trigger]").click();
    await expect(
      page.getByRole("menuitem", { name: "RomForge", exact: true }),
    ).toBeVisible();
    expect(state.errors).toEqual([]);
  });
}

test("empty, disabled and disconnected worker states", async ({ page }) => {
  const data = snapshot();
  data.active = [];
  data.history = [];
  data.pending_normalizations = 0;
  data.worker.enabled = false;
  data.worker.available = false;
  const state = await setup(page, { data });
  await expect(page.getByText("No jobs are running or queued.")).toBeVisible();
  await expect(page.getByText("No recent results.")).toBeVisible();
  await expect(
    page.getByText("RomForge is disabled on this server.", { exact: false }),
  ).toBeVisible();
  state.data.worker.enabled = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByText("The worker is not responding.", { exact: false }),
  ).toBeVisible();
  expect(state.errors).toEqual([]);
});

test("keyboard and gamepad activate refresh", async ({ page }) => {
  const state = await setup(page);
  const refresh = page.getByRole("button", { name: "Refresh", exact: true });
  await expect(page.locator(".romforge__metric dd")).toHaveText([
    "1",
    "1",
    "12",
  ]);
  await refresh.focus();
  const beforeKey = state.requests;
  await page.keyboard.press("Enter");
  await expect.poll(() => state.requests).toBeGreaterThan(beforeKey);
  await expect(refresh).toBeEnabled();
  await refresh.focus();
  const beforePad = state.requests;
  await page.evaluate(async () => {
    let pressed = false;
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: () => [
        {
          id: "RomForge test controller",
          index: 0,
          connected: true,
          mapping: "standard",
          axes: [0, 0],
          buttons: Array.from({ length: 17 }, (_, index) => ({
            pressed: index === 0 && pressed,
            touched: false,
            value: index === 0 && pressed ? 1 : 0,
          })),
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    pressed = true;
    await new Promise((resolve) => setTimeout(resolve, 150));
    pressed = false;
  });
  await expect.poll(() => state.requests).toBeGreaterThan(beforePad);
  await expect(page.locator("html")).toHaveAttribute("data-input", "pad");
  expect(state.errors).toEqual([]);
});

test("viewers cannot open the status page or its menu entry", async ({
  page,
}) => {
  const state = await setup(page, { admin: false });
  await expect(page).not.toHaveURL(/\/romforge$/);
  await page.locator("[data-user-menu-trigger]").click();
  await expect(
    page.getByRole("menuitem", { name: "RomForge", exact: true }),
  ).toHaveCount(0);
  expect(state.requests).toBe(0);
});
