import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve, extname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withHeadlessBrowser } from "./headless-browser.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(root, "frontend/package.json"));
const { zipSync } = require("fflate");
const source = resolve(
  process.env.NETPLAY_BRIDGE_SOURCE ??
    resolve(root, "../retroarch-netplay-bridge"),
);
const { createBridge } = await import(
  pathToFileURL(resolve(source, "server.mjs"))
);
const output = resolve(
  process.env.NETPLAY_UI_OUTPUT ??
    resolve(root, "../result/netplay-interop/romm-rollback-rooms"),
);
await mkdir(output, { recursive: true });
const admin = randomBytes(24).toString("hex");
const broker = await createBridge({
  adminToken: admin,
  host: "127.0.0.1",
  port: 0,
  nativeHost: "127.0.0.1",
  portStart: 0,
  portEnd: 0,
});
const gateway = `http://127.0.0.1:${broker.address.port}`;
const origin = "http://127.0.0.1:8081";
const results = [];
const fixtures = {
  gb: [
    resolve(root, "../result/netplay-interop/fixture-variants/link-battery.gb"),
    "sameboy",
    32768,
  ],
  gba: [
    resolve(root, "custom-emulatorjs/input-netplay/fixtures/gba-link-1.gba"),
    "mgba_splitscreen",
    131072,
  ],
  snes: [
    resolve(root, "../result/netplay-interop/snes-rollback/two-pad.sfc"),
    "snes9x",
    2048,
  ],
};
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".txt": "text/plain",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function gatewayRequest(path, options = {}) {
  return fetch(gateway + "/v1/rooms" + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${admin}`,
      "Content-Type": "application/json",
    },
  });
}
try {
  await withHeadlessBrowser(
    async (browser) => {
      for (const system of (
        process.env.NETPLAY_UI_SYSTEMS ?? "gb,gba,snes"
      ).split(",")) {
        const [fixture, core, batterySize] = fixtures[system];
        const cartridge = await readFile(fixture);
        const content =
          system === "snes"
            ? Buffer.from(zipSync({ "original/two-pad.smc": cartridge }))
            : cartridge;
        const errors = [],
          uploads = [],
          apiCalls = [],
          pages = [];
        const context = await browser.newContext({
          viewport: { width: 1100, height: 850 },
          colorScheme: "dark",
          hasTouch: true,
        });
        // Real WebSockets, with delayed remote input deliveries to exercise rollback.
        await context.addInitScript(() => {
          const original = WebSocket.prototype.addEventListener;
          WebSocket.prototype.addEventListener = function (
            type,
            listener,
            ...args
          ) {
            if (type !== "message")
              return original.call(this, type, listener, ...args);
            return original.call(
              this,
              type,
              (event) => {
                let input = false;
                try {
                  input =
                    typeof event.data === "string" &&
                    JSON.parse(event.data).t === "input";
                } catch {}
                if (input) setTimeout(() => listener.call(this, event), 40);
                else listener.call(this, event);
              },
              ...args,
            );
          };
        });
        const rom = {
          id: 99000001,
          name: `${system.toUpperCase()} rollback room`,
          platform_slug: system,
          fs_name:
            system === "snes" ? "two-pad.zip" : fixture.split("/").at(-1),
          fs_name_no_ext: "room-fixture",
          files: [],
          has_nested_single_file: false,
        };
        const batteries = [0, 1].map((player) => {
          const bytes = Buffer.alloc(batterySize);
          for (let i = 0; i < 256; i++)
            bytes[0x100 + i] = (49 + player * 64 + i * 7) & 255;
          return bytes;
        });
        await context.route(origin + "/assets/emulatorjs/**", async (route) => {
          const relative = decodeURIComponent(
            new URL(route.request().url()).pathname,
          ).slice("/assets/emulatorjs/".length);
          const path = resolve(root, "custom-emulatorjs", relative);
          if (!path.startsWith(resolve(root, "custom-emulatorjs") + sep))
            return route.fulfill({ status: 403 });
          try {
            await route.fulfill({
              body: await readFile(path),
              contentType: types[extname(path)] ?? "application/octet-stream",
            });
          } catch {
            await route.fulfill({ status: 404, body: "Missing test asset" });
          }
        });
        await context.route(origin + "/api/**", async (route) => {
          const request = route.request(),
            url = new URL(request.url()),
            path = url.pathname;
          const actor = pages.indexOf(request.frame().page());
          const json = (data, status = 200) =>
            route.fulfill({
              status,
              contentType: "application/json",
              body: JSON.stringify(data),
            });
          if (path === `/api/roms/${rom.id}`)
            return json({
              ...rom,
              user_saves: [
                {
                  id: 100 + actor,
                  file_name: "old.srm",
                  emulator: core,
                  slot: "default",
                  updated_at: "2026-10-30T00:00:00Z",
                  download_path: "/api/test/battery",
                },
              ],
            });
          if (path === "/api/test/battery")
            return route.fulfill({ body: batteries[actor] });
          if (path.includes("/content/"))
            return route.fulfill({ body: content });
          if (path === "/api/netplay/bridge/config")
            return json({ enabled: true });
          if (path.startsWith("/api/saves")) {
            const data = request.postDataBuffer();
            const start = data.indexOf(Buffer.from("\r\n\r\n")) + 4;
            const boundary = /boundary=([^;]+)/.exec(
              request.headers()["content-type"],
            )[1];
            const end = data.indexOf(Buffer.from(`\r\n--${boundary}`), start);
            uploads.push({
              actor,
              data: data.subarray(start, end),
              slot: url.searchParams.get("slot"),
              method: request.method(),
            });
            return json({
              id: 200 + actor,
              file_name: "room-fixture.srm",
              slot: system === "snes" ? "netplay" : "link",
            });
          }
          if (path.startsWith("/api/netplay/bridge/rooms")) {
            const suffix = path.slice("/api/netplay/bridge/rooms".length);
            let body = request.postDataJSON();
            if (request.method() === "POST" && !suffix) {
              const { rom_id, ...manifest } = body;
              body = {
                ...manifest,
                romId: rom_id,
                owner: String(actor + 1),
                nickname: "Browser host",
                manualStart: true,
              };
              apiCalls.push({ create: { ...manifest } });
            }
            if (request.method() === "POST" && suffix.endsWith("/join"))
              body = { ...body, owner: String(actor + 1) };
            const response = await gatewayRequest(suffix, {
              method: request.method(),
              body: body ? JSON.stringify(body) : undefined,
            });
            const value = await response.json();
            if (!response.ok)
              return json({ detail: value.error }, response.status);
            if (request.method() === "GET")
              return json(
                value
                  .filter((item) => !item.started)
                  .map((item) => ({
                    id: item.id,
                    rom_id: item.romId,
                    players: item.players,
                    nickname: item.nickname,
                    current: item.current,
                    native_allowed: item.nativeAllowed,
                    core_name: item.coreName,
                    core_version: item.coreVersion,
                    state_size: item.stateSize,
                    content_crc: item.contentCrc,
                    max_prediction: item.maxPrediction,
                    has_password: item.hasPassword,
                  })),
              );
            return json({
              id: value.id,
              player: value.player ?? 0,
              players: value.players,
              websocket_url:
                gateway.replace("http:", "ws:") +
                (value.hostPath ?? value.peerPath),
              native_host: "127.0.0.1",
              native_port: value.tcpPort,
              password: value.password,
            });
          }
          return json({ detail: "Unmocked API" }, 404);
        });
        try {
          const host = await context.newPage();
          pages.push(host);
          host.on("pageerror", (error) => errors.push(error.message));
          await host.goto(
            origin +
              `/assets/emulatorjs/input-netplay/bridge.html?romId=${rom.id}`,
          );
          await host.waitForFunction(
            () => !document.querySelector("#create").disabled,
          );
          await host.locator("#native").check();
          await host.locator("#create").focus();
          await host.keyboard.press("Enter");
          await Promise.race([
            host.waitForFunction(() => window.bridgeConnection, null, {
              timeout: 60000,
            }),
            host
              .waitForFunction(
                () =>
                  document.querySelector("#status").classList.contains("error"),
                null,
                { timeout: 60000 },
              )
              .then(async () => {
                throw new Error(await host.locator("#status").textContent());
              }),
          ]);
          const room = [...broker.rooms.values()].at(-1);
          const invite = await host.locator("#room-link").getAttribute("href");
          assert.equal(new URL(invite).searchParams.get("room"), room.id);
          assert.equal(room.password, "");
          assert(!new URL(invite).searchParams.has("password"));
          assert(
            (await host.locator("#core-download").textContent()).includes(
              "Linux x86_64",
            ),
          );
          const docs = await host.evaluate(async () =>
            (await fetch(document.querySelector("#core-build").href)).text(),
          );
          assert(docs.includes("Linux"));
          const guest = await context.newPage();
          pages.push(guest);
          guest.on("pageerror", (error) => errors.push(error.message));
          await guest.goto(invite);
          await guest.waitForFunction(
            () => document.querySelector("#rooms").value.length > 0,
          );
          assert(await guest.locator("#join-password-label").isHidden());
          await guest.locator("#join").tap();
          await guest
            .locator('#participants select[data-player="1"]')
            .waitFor();
          assert.equal(
            await host
              .locator('#participants select[data-player="0"]')
              .inputValue(),
            "",
          );
          assert.equal(
            await guest
              .locator('#participants select[data-player="1"]')
              .inputValue(),
            "",
          );
          assert(
            await guest
              .locator('#participants select[data-player="0"]')
              .isDisabled(),
          );
          assert(await guest.locator("#start").isHidden());
          await guest
            .locator('#participants select[data-player="1"]')
            .selectOption("0");
          await host
            .locator('#participants select[data-player="0"]')
            .selectOption("1");
          await host.waitForFunction(
            () => !document.querySelector("#start").disabled,
          );
          assert.equal(
            await host.evaluate(() => window.bridgeConnection.started),
            false,
          );
          await host.locator("#start").focus();
          await host.keyboard.press("Enter");
          await Promise.all(
            pages.map((page) =>
              page.waitForFunction(
                () => window.bridgeConnection?.session?.frame >= 180,
                null,
                { timeout: 60000 },
              ),
            ),
          );
          const controls = [];
          for (const [player, page] of pages.entries()) {
            await page.bringToFront();
            await page
              .frameLocator("iframe")
              .locator('[aria-label^="Game controls"]')
              .click();
            await page.keyboard.down("x");
            await page.waitForFunction(
              () =>
                (document.querySelector("iframe").contentWindow.localButtons &
                  256) !==
                0,
            );
            const target = await page.evaluate(
              () => window.bridgeConnection.session.frame + 24,
            );
            await page.waitForFunction(
              (target) => window.bridgeConnection.session.frame >= target,
              target,
            );
            await page.keyboard.up("x");
            await page.waitForFunction(
              () =>
                document.querySelector("iframe").contentWindow.localButtons ===
                0,
            );
            controls.push({ player, keyboard: true });
          }
          await guest.evaluate(() => {
            const win = document.querySelector("iframe").contentWindow;
            win.testPad = {
              id: "Room test pad",
              index: 0,
              connected: true,
              mapping: "standard",
              axes: [0, 0, 0, 0],
              buttons: Array.from({ length: 16 }, () => ({
                pressed: false,
                value: 0,
              })),
            };
            Object.defineProperty(win.navigator, "getGamepads", {
              value: () => [
                {
                  ...win.testPad,
                  buttons: win.testPad.buttons.map((button) => ({ ...button })),
                },
              ],
            });
          });
          await guest.waitForFunction(
            () =>
              document.querySelector("iframe").contentWindow.EJS_emulator
                .gamepad.gamepads.length === 1,
          );
          await guest.evaluate(() => {
            document.querySelector("iframe").contentWindow.testPad.buttons[0] =
              { pressed: true, value: 1 };
          });
          await guest.waitForFunction(
            () =>
              document.querySelector("iframe").contentWindow.localButtons !== 0,
          );
          await guest.evaluate(() => {
            document.querySelector("iframe").contentWindow.testPad.buttons[0] =
              { pressed: false, value: 0 };
          });
          await guest.waitForFunction(
            () =>
              document.querySelector("iframe").contentWindow.localButtons === 0,
          );
          controls[1].gamepad = true;
          await guest.setViewportSize({ width: 390, height: 850 });
          await guest.evaluate(() =>
            document
              .querySelector("iframe")
              .contentWindow.EJS_emulator.toggleVirtualGamepad(true),
          );
          const touchButton = guest
            .frameLocator("iframe")
            .locator(".ejs_virtualGamepad_button")
            .filter({ hasText: /^A$/ })
            .first();
          await touchButton.scrollIntoViewIfNeeded();
          const box = await touchButton.boundingBox();
          assert(box, "Missing touch A button");
          const cdp = await context.newCDPSession(guest);
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [
              { x: box.x + box.width / 2, y: box.y + box.height / 2 },
            ],
          });
          await guest.waitForFunction(
            () =>
              document.querySelector("iframe").contentWindow.localButtons !== 0,
          );
          const touchTarget = await guest.evaluate(
            () => window.bridgeConnection.session.frame + 12,
          );
          await guest.waitForFunction(
            (target) => window.bridgeConnection.session.frame >= target,
            touchTarget,
          );
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchEnd",
            touchPoints: [],
          });
          await guest.waitForFunction(
            () =>
              document.querySelector("iframe").contentWindow.localButtons === 0,
          );
          await cdp.detach();
          controls[1].touch = true;
          const render = await Promise.all(
            pages.map((page) =>
              page.evaluate(() => {
                const win = document.querySelector("iframe").contentWindow;
                return {
                  width: win.EJS_emulator.canvas.width,
                  height: win.EJS_emulator.canvas.height,
                  audio: win.audioOutput.outputs,
                };
              }),
            ),
          );
          assert(render.every((item) => item.width > 0 && item.height > 0));
          assert(
            render.some((item) =>
              item.audio.some((audio) => audio.state === "running"),
            ),
          );

          await Promise.all(
            pages.map((page) =>
              page.waitForFunction(
                () => window.bridgeConnection.session.frame >= 600,
              ),
            ),
          );
          await host.locator("#pause").tap();
          await Promise.all(
            pages.map((page) =>
              page.waitForFunction(
                () => window.bridgeConnection.session.paused,
              ),
            ),
          );
          const stats = await Promise.all(
            pages.map((page) =>
              page.evaluate(() => ({
                frame: window.bridgeConnection.session.frame,
                confirmed: window.bridgeConnection.session.confirmed,
                ...window.bridgeConnection.session.stats,
              })),
            ),
          );
          const common = Math.min(...stats.map((item) => item.confirmed));
          const states = await Promise.all(
            pages.map((page) =>
              page.evaluate(
                (frame) =>
                  Array.from(window.bridgeConnection.session.stateAt(frame)),
                common,
              ),
            ),
          );
          assert(
            Buffer.from(states[0]).equals(Buffer.from(states[1])),
            `${system}: confirmed state mismatch`,
          );
          assert(
            stats.some((item) => item.rollbacks > 0),
            "No delayed input rollback observed",
          );
          for (const [player, page] of pages.entries()) {
            await page.locator("#save").click();
            await page.waitForFunction(() =>
              document
                .querySelector("#save-status")
                .textContent.includes("saved"),
            );
            const upload = uploads
              .filter((item) => item.actor === player)
              .at(-1);
            assert.equal(upload.data.length, batterySize);
            assert(
              upload.data
                .subarray(0x100, 0x200)
                .equals(
                  batteries[system === "snes" ? 0 : player].subarray(
                    0x100,
                    0x200,
                  ),
                ),
              `${system}: wrong account SRAM seed`,
            );
            assert.equal(upload.slot, system === "snes" ? "netplay" : "link");
          }
          await host.locator("#volume").fill("0.2");
          await host.locator("#volume").dispatchEvent("input");
          assert.equal(
            await host.evaluate(
              () =>
                document.querySelector("iframe").contentWindow.audioOutput
                  .volume,
            ),
            0.2,
          );
          const responsive = [];
          for (const theme of ["dark", "light"]) {
            await host.emulateMedia({ colorScheme: theme });
            for (const width of [320, 768, 1100, 3840]) {
              await host.setViewportSize({ width, height: 850 });
              const overflow = await host.evaluate(
                () => document.documentElement.scrollWidth > innerWidth,
              );
              assert(
                !overflow,
                `${system}/${theme}/${width}: horizontal overflow`,
              );
              responsive.push({ theme, width, fits: !overflow });
            }
            await host.setViewportSize({ width: 1100, height: 850 });
            await host.screenshot({
              path: resolve(output, `${system}-${theme}.png`),
            });
          }
          assert.deepEqual(errors, []);
          results.push({
            system,
            core,
            archive: system === "snes",
            render,
            commonConfirmedFrame: common,
            stateSha256: hash(Buffer.from(states[0])),
            stats,
            controls,
            responsive,
            saves: uploads.map(({ actor, data, slot, method }) => ({
              actor,
              bytes: data.length,
              sha256: hash(data),
              slot,
              method,
            })),
            apiCalls,
            errors,
          });
          console.log(JSON.stringify({ system, pass: true, common, stats }));
        } catch (error) {
          const diagnostics = await Promise.all(
            pages.map((page) =>
              page
                .evaluate(() => ({
                  status: document.querySelector("#status")?.textContent,
                  frame: window.bridgeConnection?.session?.frame,
                  stopped: window.bridgeConnection?.session?.stopped,
                }))
                .catch(() => null),
            ),
          );
          console.error(
            JSON.stringify({
              system,
              error: error.message,
              diagnostics,
              errors,
            }),
          );
          throw error;
        } finally {
          await context.close();
        }
      }
    },
    {
      args: [
        "--disable-features=LocalNetworkAccessChecks",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
      ],
    },
  );
} finally {
  await broker.close();
  await writeFile(
    resolve(output, "result.json"),
    JSON.stringify({ results }, null, 2) + "\n",
  );
}
