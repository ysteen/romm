import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withHeadlessBrowser } from "./headless-browser.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "../result/dosbox-web-input");
const origin = "http://127.0.0.1:8081";
const require = createRequire(
  process.env.DOSBOX_PACKAGE_JSON ?? resolve(root, "frontend/package.json"),
);
const { zipSync } = require("fflate");
await mkdir(output, { recursive: true });
if (process.platform !== "win32") {
  execFileSync("as", [
    "--32",
    "-o",
    `${output}/mouse.o`,
    `${root}/custom-emulatorjs/tests/fixtures/dosbox-input.s`,
  ]);
  execFileSync("ld", [
    "-m",
    "elf_i386",
    "-Ttext",
    "0x100",
    "--oformat",
    "binary",
    "-o",
    `${output}/mouse.com`,
    `${output}/mouse.o`,
  ]);
  require("esbuild").buildSync({
    entryPoints: [
      resolve(root, "frontend/src/services/emulatorjs/directory-saves.ts"),
    ],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "SaveAdapters",
    outfile: resolve(output, "save-adapter.js"),
  });
}
await writeFile(
  `${output}/mouse.zip`,
  zipSync({
    "MOUSE.COM": await readFile(`${output}/mouse.com`),
    "AUTOBOOT.DBP": new TextEncoder().encode("MOUSE.COM"),
  }),
);
if (process.env.DOSBOX_BASELINE_REF && process.platform !== "win32") {
  for (const name of ["src/emulator.js", "emulator.css"]) {
    const target = resolve(output, "baseline-source", name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      execFileSync(
        "git",
        [
          "show",
          `${process.env.DOSBOX_BASELINE_REF}:custom-emulatorjs/data/${name}`,
        ],
        { cwd: root, maxBuffer: 4 * 1024 * 1024 },
      ),
    );
  }
}
if (process.env.DOSBOX_PREPARE_ONLY === "1") process.exit(0);
const baseline = process.env.DOSBOX_BASELINE === "1";
const report = { baseline, scenarios: [] };
const types = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
};
const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}#game{width:100vw;height:100vh}</style><div id="game"></div><script>
EJS_player="#game"; EJS_core="dos"; EJS_gameUrl="/mouse.zip"; EJS_pathtodata="/data/";
EJS_threads=true; EJS_startOnLoaded=false; EJS_language="en-US"; EJS_disableAutoLang=true;
EJS_disableLocalStorage=true; EJS_disableDatabases=true; EJS_dontExtractRom=true;
EJS_disableBatchBootup=true; EJS_disableRestart=true; EJS_DEBUG_XX=true;
EJS_browserMode=1; EJS_cacheConfig={enabled:false}; EJS_gameName="mouse";
EJS_defaultOptions={webgl2Enabled:"enabled"};
</script><script src="/save-adapter.js"></script><script src="/data/loader.js"></script>`;

async function withTestBrowser(action, options) {
  if (!process.env.DOSBOX_CDP) return withHeadlessBrowser(action, options);
  const endpoint = new URL(process.env.DOSBOX_CDP);
  const version = await (
    await fetch(new URL("/json/version", endpoint))
  ).json();
  const ws = new URL(version.webSocketDebuggerUrl);
  ws.hostname = endpoint.hostname;
  ws.port = endpoint.port;
  const browser = await require("playwright").chromium.connectOverCDP(ws.href);
  report.browser = version.Browser;
  try {
    return await action(browser);
  } finally {
    if (!process.env.DOSBOX_KEEP_BROWSER) {
      const session = await browser.newBrowserCDPSession();
      await session.send("Browser.close").catch(() => {});
    }
    await browser.close();
  }
}

await withTestBrowser(
  async (browser) => {
    const context = await browser.newContext({
      viewport: { width: 800, height: 600 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const errors = [];
    const logs = [];
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (e) => logs.push(e.text()));
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin)
        return route.fulfill({
          body: '{"version":"4.3.0"}',
          contentType: "application/json",
        });
      if (url.pathname === "/")
        return route.fulfill({ body: html, contentType: "text/html", headers });
      const file = ["/mouse.zip", "/save-adapter.js"].includes(url.pathname)
        ? resolve(output, url.pathname.slice(1))
        : resolve(root, "custom-emulatorjs", url.pathname.slice(1));
      try {
        let body = await readFile(file);
        if (
          baseline &&
          ["/data/src/emulator.js", "/data/emulator.css"].includes(url.pathname)
        ) {
          body = await readFile(
            resolve(output, "baseline-source", url.pathname.slice(6)),
          );
        }
        await route.fulfill({
          body,
          contentType: types[extname(file)] ?? "application/octet-stream",
          headers: {
            ...headers,
            "Content-Disposition": `attachment; filename="${file.replaceAll("\\", "/").split("/").pop()}"`,
          },
        });
      } catch {
        await route.fulfill({
          status: 404,
          body: "Missing fixture asset",
          headers,
        });
      }
    });
    try {
      await page.goto(origin);
      await page.locator(".ejs_start_button").tap();
      await page.waitForFunction(() => window.EJS_emulator?.started, null, {
        timeout: 60_000,
      });
      await page.waitForTimeout(1200);
      const boot = await page.evaluate(() => {
        const e = window.EJS_emulator;
        const heap = e.gameManager.Module.HEAPU8;
        const marker = new TextEncoder().encode("ROMM-DOS-MOUSE-STATE!");
        const matches = [];
        for (let i = 0; i < heap.length - marker.length - 14; i++) {
          if (heap[i] !== marker[0]) continue;
          if (marker.every((v, j) => heap[i + j] === v)) {
            const offset = i + marker.length;
            const view = new DataView(heap.buffer);
            if (view.getUint16(offset, true) > 0) matches.push(offset);
          }
        }
        window.mouseStateOffset = matches[0];
        window.mouseState = () => {
          const h = e.gameManager.Module.HEAPU8;
          const v = new DataView(h.buffer);
          return Object.fromEntries(
            ["ticks", "x", "y", "buttons", "left", "right", "keys"].map(
              (k, i) => [k, v.getUint16(window.mouseStateOffset + 2 * i, true)],
            ),
          );
        };
        const r = e.canvas.getBoundingClientRect();
        return {
          matches,
          state: window.mouseState(),
          options: e
            .getBackendCoreOptions()
            .filter((o) => o.key.includes("mouse_input")),
          canvas: {
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            pointerEvents: getComputedStyle(e.canvas).pointerEvents,
          },
          target: document.elementFromPoint(400, 150)?.className,
        };
      });
      report.boot = boot;
      assert.equal(
        boot.matches.length,
        1,
        "The DOS program must be running in guest memory",
      );
      const cdp = await context.newCDPSession(page);
      const touch = (type, points) =>
        cdp.send("Input.dispatchTouchEvent", {
          type,
          touchPoints: points.map(([x, y, id = 0]) => ({
            x,
            y,
            id,
            radiusX: 2,
            radiusY: 2,
            force: 1,
          })),
        });
      const state = () => page.evaluate(() => window.mouseState());
      const start = await state();
      await touch("touchStart", [[350, 150]]);
      await page.waitForTimeout(100);
      await touch("touchMove", [[385, 170]]);
      await page.waitForTimeout(100);
      await touch("touchEnd", []);
      await page.waitForTimeout(200);
      const moved = await state();
      report.scenarios.push({
        name: "touch move",
        before: start,
        after: moved,
      });
      if (!baseline) assert.notEqual(moved.x, start.x);
      await touch("touchStart", [[350, 150]]);
      await page.waitForTimeout(90);
      await touch("touchEnd", []);
      await page.waitForTimeout(200);
      const tapped = await state();
      report.scenarios.push({ name: "tap", after: tapped });
      if (!baseline) assert.equal(tapped.left, moved.left + 1);
      await touch("touchStart", [
        [350, 150],
        [400, 150, 1],
      ]);
      await page.waitForTimeout(100);
      await touch("touchEnd", [[350, 150]]);
      await page.waitForTimeout(30);
      await touch("touchEnd", []);
      await page.waitForTimeout(200);
      const right = await state();
      report.scenarios.push({ name: "two finger tap", after: right });
      if (!baseline) assert.equal(right.right, tapped.right + 1);
      if (baseline) {
        assert.equal(boot.canvas.pointerEvents, "none");
        assert.equal(moved.x, start.x);
        assert.equal(tapped.left, 0);
        assert.equal(right.right, 0);
      } else {
        const beforeQuickRight = await state();
        await touch("touchStart", [
          [350, 150],
          [400, 150, 1],
        ]);
        await page.waitForTimeout(100);
        await touch("touchEnd", []);
        await page.waitForTimeout(200);
        const quickRight = await state();
        report.scenarios.push({
          name: "simultaneous two finger release",
          before: beforeQuickRight,
          after: quickRight,
          rightClick: quickRight.right > beforeQuickRight.right,
        });
        await touch("touchStart", [
          [350, 150],
          [400, 150, 1],
        ]);
        await page.waitForTimeout(650);
        const rightHeld = await state();
        assert.equal(rightHeld.buttons & 2, 2);
        await touch("touchEnd", []);
        await page.waitForTimeout(200);
        assert.equal((await state()).buttons, 0);
        report.scenarios.push({
          name: "two finger hold right click",
          held: rightHeld,
        });
        await touch("touchStart", [[350, 150]]);
        await page.waitForTimeout(650);
        const held = await state();
        assert.equal(held.buttons & 1, 1);
        await touch("touchMove", [[330, 140]]);
        await page.waitForTimeout(150);
        const dragged = await state();
        assert.notEqual(dragged.x, held.x);
        assert.equal(dragged.buttons & 1, 1);
        await touch("touchEnd", []);
        await page.waitForTimeout(150);
        assert.equal((await state()).buttons, 0);
        report.scenarios.push({ name: "hold and drag", held, dragged });
        await touch("touchStart", [[350, 150]]);
        await page.waitForTimeout(650);
        await touch("touchCancel", []);
        await page.waitForTimeout(200);
        assert.equal((await state()).buttons, 0);
        report.scenarios.push({ name: "touch cancellation releases buttons" });

        const beforeMouse = await state();
        await page.mouse.move(370, 150);
        await page.mouse.move(390, 170, { steps: 4 });
        await page.mouse.click(390, 170, { delay: 80 });
        await page.waitForTimeout(200);
        const afterMouse = await state();
        assert.notEqual(afterMouse.x, beforeMouse.x);
        assert.ok(afterMouse.left > beforeMouse.left);
        assert.equal(
          await page.evaluate(() => EJS_emulator.dosBoxMouseInput),
          "true",
        );
        report.scenarios.push({
          name: "physical mouse after touch",
          beforeMouse,
          afterMouse,
        });
        await page.keyboard.press("KeyA", { delay: 80 });
        await page.waitForTimeout(150);
        assert.ok((await state()).keys > afterMouse.keys);
        report.scenarios.push({ name: "keyboard" });

        const pad = page.locator(".ejs_virtualGamepad_button.b_a");
        const padBox = await pad.boundingBox();
        assert.ok(padBox);
        const beforePad = await state();
        await touch("touchStart", [
          [padBox.x + padBox.width / 2, padBox.y + padBox.height / 2],
        ]);
        await page.waitForTimeout(100);
        assert.ok(
          await pad.evaluate((el) =>
            el.classList.contains("ejs_virtualGamepad_button_down"),
          ),
        );
        await touch("touchEnd", []);
        await page.waitForTimeout(200);
        assert.equal((await state()).left, beforePad.left);
        report.scenarios.push({
          name: "virtual pad button does not click mouse",
        });

        await page.setViewportSize({ width: 600, height: 800 });
        await page.waitForTimeout(200);
        const beforeRotate = await state();
        await touch("touchStart", [[280, 150]]);
        await page.waitForTimeout(80);
        await touch("touchMove", [[295, 160]]);
        await page.waitForTimeout(100);
        await touch("touchEnd", []);
        await page.waitForTimeout(200);
        assert.notEqual((await state()).x, beforeRotate.x);
        report.scenarios.push({ name: "portrait resize" });

        report.performance = await page.evaluate(async () => {
          const e = EJS_emulator;
          e.pause();
          const gm = e.gameManager;
          const adapter = SaveAdapters.createDirectorySaveAdapter(gm);
          const path = gm.getSaveFilePath().replace(/\.srm$/, "-CDRIVE.sav");
          const results = [];
          try {
            for (const mib of [4, 16, 64]) {
              gm.writeFile(path, new Uint8Array(mib * 1024 * 1024).fill(0x5a));
              await new Promise((resolve, reject) =>
                gm.FS.syncfs(false, (err) => (err ? reject(err) : resolve())),
              );
              const oldRead = () =>
                adapter.createZipSaveBundle(adapter.getDosBoxPureSaveFiles());
              oldRead();
              const snapshot = adapter.read();
              const before = [],
                after = [];
              for (let i = 0; i < 7; i++) {
                let t = performance.now();
                oldRead();
                before.push(performance.now() - t);
                t = performance.now();
                if (adapter.read() !== snapshot)
                  throw new Error("Unchanged save was repacked");
                after.push(performance.now() - t);
              }
              const median = (times) => [...times].sort((a, b) => a - b)[3];
              results.push({
                mib,
                beforeMs: median(before),
                afterMs: median(after),
                before,
                after,
              });
            }
            return {
              scope:
                "Unchanged DOS disk-difference bundle checks in the real WASM filesystem, emulator paused",
              results,
            };
          } finally {
            gm.FS.unlink(path);
            e.play();
          }
        });
      }
      report.errors = errors;
      assert.deepEqual(errors, []);
      await page.screenshot({
        path: `${output}/${baseline ? "baseline" : "fixed"}.png`,
      });
    } finally {
      await writeFile(
        `${output}/${baseline ? "baseline" : "fixed"}.json`,
        JSON.stringify(report, null, 2),
      );
      await writeFile(
        `${output}/${baseline ? "baseline" : "fixed"}.log`,
        logs.join("\n"),
      );
      await context.close();
    }
  },
  {
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  },
);
console.log(JSON.stringify(report, null, 2));
