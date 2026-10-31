import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, delimiter, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(repository, "frontend/package.json"));
export const browserCache = resolve(
  process.env.ROMM_BROWSER_CACHE ??
    resolve(repository, "../.cache/romm-headless-browser"),
);
process.env.PLAYWRIGHT_BROWSERS_PATH = browserCache;

const packages = {
  "libnspr4.so": "libnspr4",
  "libnss3.so": "libnss3",
  "libnssutil3.so": "libnss3",
  "libsmime3.so": "libnss3",
  "libatk-1.0.so.0": "libatk1.0-0",
  "libatk-bridge-2.0.so.0": "libatk-bridge2.0-0",
  "libatspi.so.0": "libatspi2.0-0",
  "libXcomposite.so.1": "libxcomposite1",
  "libXdamage.so.1": "libxdamage1",
};

function configuration() {
  const coreRoot = dirname(require.resolve("playwright-core/package.json"));
  const manifest = JSON.parse(
    readFileSync(resolve(coreRoot, "browsers.json"), "utf8"),
  );
  const shell = manifest.browsers.find(
    (browser) => browser.name === "chromium-headless-shell",
  );
  const machine = process.arch === "arm64" ? "aarch64" : "x86_64";
  const libraryPath = [
    resolve(browserCache, `libs/usr/lib/${machine}-linux-gnu`),
    process.env.LD_LIBRARY_PATH,
  ]
    .filter(Boolean)
    .join(delimiter);
  const folder = resolve(
    browserCache,
    `chromium_headless_shell-${shell.revision}`,
  );
  const executablePath = [
    "chrome-headless-shell-linux64",
    "chrome-headless-shell-linux-arm64",
    "chrome-linux",
  ]
    .map((name) => resolve(folder, name, "chrome-headless-shell"))
    .find(existsSync);
  return {
    executablePath,
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: browserCache,
      LD_LIBRARY_PATH: libraryPath,
    },
  };
}

function missingLibraries(config) {
  if (!config.executablePath) return [];
  const result = spawnSync("ldd", [config.executablePath], {
    env: config.env,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return [
    ...new Set(
      [...result.stdout.matchAll(/^\s*(\S+) => not found$/gm)].map(
        (match) => match[1],
      ),
    ),
  ];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status})`);
}

export function checkHeadlessBrowser() {
  const config = configuration();
  const missing = missingLibraries(config);
  return {
    ready: !!config.executablePath && missing.length === 0,
    cache: browserCache,
    executable: config.executablePath ?? null,
    missingLibraries: missing,
  };
}

export async function launchHeadlessBrowser(options = {}) {
  const status = checkHeadlessBrowser();
  if (!status.ready)
    throw new Error(
      `Test browser is unavailable. Run: node ${resolve(repository, "scripts/headless-browser.mjs")} setup`,
    );
  const config = configuration();
  const { chromium } = require("playwright");
  const browser = await chromium.launch({
    ...options,
    headless: true,
    executablePath: config.executablePath,
    env: { ...config.env, ...options.env },
    args: ["--no-sandbox", "--disable-dev-shm-usage", ...(options.args ?? [])],
  });
  const onInterrupt = () => {
    void browser.close().finally(() => process.exit(130));
  };
  const onTerminate = () => {
    void browser.close().finally(() => process.exit(143));
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  browser.once("disconnected", () => {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  });
  return browser;
}

export async function withHeadlessBrowser(action, options = {}) {
  const browser = await launchHeadlessBrowser(options);
  try {
    return await action(browser);
  } finally {
    await browser.close();
  }
}

async function main(command) {
  if (process.platform !== "linux")
    throw new Error("This shared test browser is configured for Linux/WSL");
  if (command === "setup") {
    mkdirSync(browserCache, { recursive: true });
    let config = configuration();
    if (!config.executablePath) {
      run(
        process.execPath,
        [
          resolve(
            dirname(require.resolve("playwright/package.json")),
            "cli.js",
          ),
          "install",
          "chromium-headless-shell",
        ],
        { env: config.env },
      );
      config = configuration();
    }
    if (!config.executablePath)
      throw new Error(
        "Playwright did not install the expected headless executable",
      );
    const missing = missingLibraries(config);
    if (missing.length) {
      const unknown = missing.filter((library) => !packages[library]);
      if (unknown.length)
        throw new Error(
          `Add distro package mappings for: ${unknown.join(", ")}`,
        );
      const downloads = resolve(browserCache, "debs");
      mkdirSync(downloads, { recursive: true });
      run(
        "apt-get",
        [
          "-o",
          "Acquire::Retries=0",
          "-o",
          "Acquire::http::Timeout=15",
          "download",
          ...new Set(missing.map((library) => packages[library])),
        ],
        { cwd: downloads },
      );
      for (const filename of readdirSync(downloads).filter((name) =>
        name.endsWith(".deb"),
      ))
        run("dpkg-deb", [
          "--extract",
          resolve(downloads, filename),
          resolve(browserCache, "libs"),
        ]);
    }
  } else if (command === "smoke") {
    const result = await withHeadlessBrowser(async (browser) => {
      const page = await browser.newPage();
      await page.setContent(
        "<button onclick=\"this.textContent='passed'\">Run</button>",
      );
      await page.locator("button").click();
      if ((await page.locator("button").textContent()) !== "passed")
        throw new Error("Browser interaction failed");
      return {
        browserVersion: browser.version(),
        interaction: "passed",
        webAssembly: await page.evaluate(() => typeof WebAssembly === "object"),
      };
    });
    console.log(JSON.stringify(result));
    return;
  } else if (command !== "check")
    throw new Error(
      "Usage: node scripts/headless-browser.mjs setup|check|smoke",
    );
  const status = checkHeadlessBrowser();
  console.log(JSON.stringify(status));
  if (!status.ready) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main(process.argv[2] ?? "check").catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
