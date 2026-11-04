import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { withHeadlessBrowser } from "../../scripts/headless-browser.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(
  process.env.ROOM_UI_OUTPUT ?? "../result/netplay-interop/mgba-multi-rom/ui",
);
await mkdir(output, { recursive: true });
const roms = [11, 12].map((id, i) => ({
  id,
  name: `Fixture ${i + 1}`,
  fs_name: `fixture-${id}.gba`,
  platform_slug: "gba",
  platform_id: 1,
  user_saves:
    id === 12
      ? [
          {
            id: 51,
            emulator: "mgba",
            file_name: "chosen.srm",
            updated_at: "2026-10-01",
            download_path: "/fixture-save/51",
          },
          {
            id: 52,
            emulator: "mgba_splitscreen",
            slot: "link",
            file_name: "newest.srm",
            updated_at: "2026-11-01",
            download_path: "/fixture-save/52",
          },
        ]
      : [],
}));
const cartridges = roms.map((r) => ({
  romId: r.id,
  sha256: "a".repeat(64),
  size: 32768,
  crc32: 1,
}));
let room,
  ticketClaimed,
  ticketRequests,
  requestedBattery,
  controlRequests,
  nativeSaveError = false,
  nativeSaveRequests = 0,
  membershipLeaves = 0;
function reset() {
  ticketClaimed = false;
  ticketRequests = 0;
  requestedBattery = null;
  controlRequests = [];
  nativeSaveError = false;
  nativeSaveRequests = 0;
  room = {
    id: "test-room",
    rom_id: 11,
    players: 2,
    current: 1,
    native_allowed: true,
    native_auth: true,
    collect_cartridges: true,
    content_prepared: false,
    cartridges,
    members: [
      {
        player: 0,
        nickname: "Alice",
        kind: "web",
        owner: "1",
        romId: 11,
        ready: true,
        playing: false,
        ping: 8,
      },
    ],
    seats: [0, null],
    host: 0,
    running: false,
    starting: false,
    started: false,
    has_password: false,
    core_name: "mGBA Splitscreen",
    core_version: "0.1.0-f1d5975-rollback2",
    state_size: 1450144,
    content_crc: 1,
  };
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/room-shell-unisolated") {
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    }
    if (url.pathname.startsWith("/room-shell")) {
      res
        .writeHead(200, { "Content-Type": "text/html" })
        .end(
          '<iframe allow="autoplay; gamepad; fullscreen" style="width:100vw;height:100vh" src="/assets/emulatorjs/input-netplay/bridge.html"></iframe>',
        );
      return;
    }
    let data;
    if (url.pathname === "/api/netplay/bridge/config") data = { enabled: true };
    else if (/^\/api\/roms\/\d+$/.test(url.pathname))
      data = roms.find((r) => String(r.id) === url.pathname.split("/").at(-1));
    else if (/^\/api\/roms\/\d+\/content\//.test(url.pathname)) {
      res
        .writeHead(200)
        .end(Buffer.alloc(32768, Number(url.pathname.split("/")[3])));
      return;
    } else if (url.pathname.startsWith("/fixture-save/")) {
      res
        .writeHead(200)
        .end(Buffer.from([Number(url.pathname.split("/").at(-1))]));
      return;
    } else if (url.pathname === "/api/netplay/bridge/rooms") {
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const created = JSON.parse(body);
        assert.equal(created.collectCartridges, true);
        assert(created.cartridges.every((rom) => rom.romId === 11));
        room.cartridges = created.cartridges;
        data = {
          id: room.id,
          player: 0,
          players: 2,
          websocket_url: "ws://fixture",
          native_port: 55435,
          native_host: "localhost",
        };
      } else data = [room];
    } else if (url.pathname.endsWith("/join")) {
      room.members.push({
        player: 1,
        nickname: "Bob",
        owner: "2",
        romId: 12,
        kind: "web",
        ready: true,
        playing: false,
        ping: 12,
      });
      room.current = 2;
      data = {
        id: room.id,
        player: 1,
        players: 2,
        websocket_url: "ws://fixture",
        native_host: "localhost",
        native_port: 55435,
      };
    } else if (
      url.pathname.endsWith("/membership") &&
      req.method === "DELETE"
    ) {
      membershipLeaves++;
      res.writeHead(204).end();
      return;
    } else if (url.pathname.endsWith("/native/ticket")) {
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const preparation = JSON.parse(body);
        assert.equal(preparation.rom_id, 12);
        assert.equal(preparation.cartridge.romId, 12);
        requestedBattery = preparation.battery;
        ticketRequests++;
        data = {
          ticket: "t".repeat(32),
          launch_url:
            "romm-netplay://launch/?server=https%3A%2F%2Fromm.example&room=test-room&ticket=" +
            "t".repeat(32),
          expires_at: Date.now() + 180000,
        };
      } else {
        data = ticketClaimed
          ? {
              status: "preparing",
              session: {
                id: room.id,
                player: 1,
                credential: "a".repeat(32),
                native_password: "b".repeat(32),
                native_host: "localhost",
                native_port: 55435,
                expires_at: Date.now() + 900000,
                package_url: "/unused",
              },
            }
          : { status: "waiting", session: null };
      }
    } else if (url.pathname.endsWith("/native/saves")) {
      nativeSaveRequests++;
      res
        .writeHead(nativeSaveError ? 409 : 200, {
          "Content-Type": "application/json",
        })
        .end(
          JSON.stringify(
            nativeSaveError
              ? { detail: "The room save was modified outside this session" }
              : { saved: true },
          ),
        );
      return;
    } else if (url.pathname === "/api/saves") {
      data = { id: 55, file_name: "fixture.srm" };
    } else if (url.pathname.endsWith("/control")) {
      let text = "";
      for await (const chunk of req) text += chunk;
      const action = JSON.parse(text);
      controlRequests.push(action);
      if (action.action === "assign") room.seats[action.player] = action.seat;
      else if (action.action === "start") {
        room.running = true;
        room.can_start = false;
        room.members.forEach((member) => (member.playing = true));
      } else if (action.action === "kick")
        room.members = room.members.filter(
          (member) => member.player !== action.player,
        );
      data = {};
    } else if (url.pathname.endsWith("/native/seat")) {
      let text = "";
      for await (const chunk of req) text += chunk;
      room.seats[1] = JSON.parse(text).seat;
      data = {};
    } else if (url.pathname.endsWith("/native/launcher")) {
      res
        .writeHead(200, { "Content-Type": "application/zip" })
        .end(Buffer.from("PK"));
      return;
    } else if (url.pathname.endsWith("/native")) {
      if (req.method === "DELETE") {
        room.members = room.members.filter((m) => m.player !== 1);
        room.current = 1;
        res.writeHead(204).end();
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const preparation = JSON.parse(body);
      assert.equal(preparation.rom_id, 12);
      assert.equal(preparation.cartridge.romId, 12);
      room.current = 2;
      room.members.push({
        player: 1,
        nickname: "Bob",
        owner: "2",
        romId: 12,
        kind: "preparing",
        clientPlatform: "windows-x86_64",
        ready: false,
        playing: false,
        ping: null,
      });
      data = {
        id: room.id,
        player: 1,
        credential: "a".repeat(32),
        native_password: "b".repeat(32),
        native_host: "127.0.0.1",
        native_port: 55435,
        expires_at: Date.now() + 900000,
        package_url: "/api/netplay/bridge/rooms/test-room/native/package",
      };
    }
    if (url.pathname.endsWith("/input-netplay/player.html")) {
      res.writeHead(200, { "Content-Type": "text/html" }).end(`
        <!doctype html><style>
          html, body, #game { margin: 0; width: 100%; height: 100%; }
          .ejs_menu_bar { position: absolute; bottom: 0; background: #445; z-index: 30; }
        </style><div id="game" tabindex="0"></div><script>
          window.audioOutput = { flush() {}, destroy() {}, setActive() {} };
          window.boot = (contents, options, integration) => new Promise(resolve => {
            window.finishBoot = () => {
              const parent = document.querySelector('#game');
              const canvas = document.createElement('canvas');
              const touchControls = document.createElement('div');
              touchControls.className = 'ejs_virtualGamepad_parent';
              touchControls.textContent = 'Touch controls';
              const menu = document.createElement('div');
              menu.className = 'ejs_menu_bar';
              const button = () => {
                const node = document.createElement('button');
                node.innerHTML = '<span class="ejs_menu_text">Control</span>';
                menu.append(node);
                return node;
              };
              const bar = { netplay: [button()], saveSavFiles: [button()], playPause: [button(), button()], exit: [button()] };
              parent.append(canvas, menu, touchControls);
              window.audioSelection = [];
              window.messages = [];
              window.EJS_emulator = {
                elements: { parent, menu, bottomBar: bar }, canvas,
                config: { defaultOptions: options }, fileName: 'test.gba',
                gameManager: { FS: { readFile: () => contents[0] }, setVariable: (...args) => window.audioSelection.push(args) },
                settingsMenu: document.createElement('div'), menu: { close() {} }, displayMessage(message) { window.messages.push(message); },
              };
              bar.netplay[0].onclick = () => window.EJS_emulator.config.netplayLaunch();
              resolve({ profile: integration.profile, size: 128, save: () => new Uint8Array(128), memory: () => new Uint8Array() });
            };
          });
        </script>`);
      return;
    }
    if (data !== undefined) {
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(data));
      return;
    }
    const path = resolve(
      root,
      "." + url.pathname.replace("/assets/emulatorjs", ""),
    );
    if (!path.startsWith(root)) {
      res.writeHead(404).end();
      return;
    }
    const type =
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
      }[extname(path)] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": type }).end(await readFile(path));
  } catch {
    res.writeHead(404).end();
  }
});
async function mockRoomSocket(context, player) {
  await context.addInitScript((player) => {
    window.sentRoomMessages = [];
    window.launchLinks = [];
    document.addEventListener(
      "click",
      (event) => {
        const link = event.target.closest?.('a[href^="romm-netplay:"]');
        if (link) {
          event.preventDefault();
          window.launchLinks.push(link.href);
        }
      },
      true,
    );
    window.WebSocket = class extends EventTarget {
      readyState = 1;
      bufferedAmount = 0;
      constructor() {
        super();
        this.members = [
          {
            player: 0,
            nickname: "Alice",
            kind: "web",
            romId: 11,
            ready: true,
            ping: 8,
          },
          {
            player: 1,
            nickname: "Bob",
            kind: "web",
            romId: 12,
            ready: true,
            ping: 12,
          },
        ];
        setTimeout(() => {
          this.message({
            t: "joined",
            manualStart: true,
            player,
            players: 2,
            host: 0,
          });
          this.lobby();
        });
      }
      message(data) {
        this.dispatchEvent(
          new MessageEvent("message", { data: JSON.stringify(data) }),
        );
      }
      lobby(overrides = {}) {
        this.message({
          t: "lobby",
          host: 0,
          players: 2,
          seats: this.seats ?? [null, null],
          contentPrepared: false,
          members: this.members,
          ...overrides,
        });
      }
      send(data) {
        if (typeof data !== "string") return;
        const packet = JSON.parse(data);
        window.sentRoomMessages.push(packet);
        if (packet.t === "assign") {
          this.seats ??= [null, null];
          this.seats[packet.player] = packet.seat;
          this.lobby();
        }
        if (packet.t === "game-open") {
          this.members.find((member) => member.player === player).ready = true;
          this.lobby();
        }
        if (packet.t === "game-close") {
          this.members.find((member) => member.player === player).ready = false;
          this.lobby();
        }
        if (packet.t === "kick") {
          this.members = this.members.filter(
            (member) => member.player !== packet.player,
          );
          this.lobby();
        }
      }
      close() {
        this.readyState = 3;
      }
    };
  }, player);
}
await new Promise((r) => server.listen(0, "127.0.0.1", r));
try {
  await withHeadlessBrowser(async (browser) => {
    for (const theme of ["light", "dark"]) {
      reset();
      const context = await browser.newContext({
        viewport: { width: 1100, height: 850 },
        hasTouch: true,
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/134.0.0.0",
      });
      const page = await context.newPage(),
        errors = [];
      await mockRoomSocket(context, 1);
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(
        `http://127.0.0.1:${server.address().port}/assets/emulatorjs/input-netplay/bridge.html`,
      );
      await page.waitForFunction(() => window.bridgePlayer);
      await page.evaluate(
        (theme) =>
          window.bridgePlayer.initialize({
            romId: 12,
            theme,
            resume: { saveId: theme === "light" ? 51 : null },
          }),
        theme,
      );
      assert.equal(await page.locator("#save-choice").count(), 0);
      assert.equal(
        await page.locator("#save-status").innerText(),
        theme === "light"
          ? "Starting from: chosen.srm"
          : "Starting without a save.",
      );
      assert(await page.locator("#native-launcher").isHidden());
      await page.screenshot({
        path: resolve(output, `${theme}-room-entry.png`),
      });
      for (const width of [320, 768, 3840]) {
        await page.setViewportSize({ width, height: 850 });
        assert(
          await page
            .locator("#room-panel")
            .evaluate((panel) => panel.scrollWidth <= panel.clientWidth),
          `Room entry overflows at ${width}px`,
        );
      }
      await page.setViewportSize({ width: 1100, height: 850 });
      await page.selectOption("#rooms", "test-room");
      assert.equal(
        await page.locator("#join-cartridge, #cartridge-selection").count(),
        0,
      );
      assert.match(
        await page.locator("#selected-cartridge").innerText(),
        /Fixture 2/,
      );
      const setup = page.locator("#native-details > summary");
      if (theme === "dark") await setup.tap();
      else {
        await setup.focus();
        await page.keyboard.press("Enter");
      }
      await page.selectOption("#native-platform", "windows-x86_64");
      const download = page.waitForEvent("download");
      await page.locator("#native-launcher").click();
      await download;
      await setup.click();
      assert.equal(room.members.length, 1);
      assert.equal(ticketRequests, 0);
      assert(await page.locator("#join-game").isDisabled());
      await page.locator("#join").click();
      await page.waitForFunction(() => window.bridgeConnection);
      assert.deepEqual(
        await page.evaluate(() => Array.from(window.bridgeConnection.battery)),
        theme === "light" ? [51] : [],
        "Room entry changed the save selected before joining",
      );
      await page.evaluate((cartridges) => {
        window.bridgeConnection.socket.message({
          t: "content",
          cartridges,
          contentCrc: 1,
          coreVersion: "0.1.0-f1d5975-rollback2",
        });
      }, cartridges);
      await page.locator('[data-player="1"]').selectOption("1");
      assert.equal(await page.locator("#screen iframe").count(), 0);
      assert(await page.locator("#join-game").isDisabled());
      await page.selectOption("#play-client", "windows");
      assert.equal(await page.locator("#screen iframe").count(), 0);
      assert.equal(
        await page.evaluate(
          () =>
            window.sentRoomMessages.filter((p) => p.t === "game-open").length,
        ),
        0,
      );
      room.seats = [0, 1];
      await page.locator("#join-game").focus();
      if (theme === "dark") await page.locator("#join-game").tap();
      else await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.launchLinks.length === 1);
      assert.equal(
        requestedBattery,
        Buffer.from(theme === "light" ? [51] : []).toString("base64"),
      );
      assert.equal(await page.locator("#screen iframe").count(), 0);
      await page.locator("#join-game").click();
      assert.equal(
        ticketRequests,
        1,
        "Retrying the launcher must retain the same ticket",
      );
      assert.equal(await page.evaluate(() => window.launchLinks.length), 2);
      assert.equal(room.members[1].kind, "web");
      assert(await page.evaluate(() => !window.bridgeConnection.closed));
      assert(await page.locator("#native-session").isHidden());
      ticketClaimed = true;
      room.members[1].kind = "preparing";
      room.members[1].clientPlatform = "windows-x86_64";
      room.members[1].ready = false;
      await page.evaluate(() => {
        window.originalRoomConnection = window.bridgeConnection;
        window.bridgeConnection.socket.message({
          t: "handoff",
          retainRoom: true,
        });
      });
      await page.waitForFunction(() =>
        document
          .querySelector("#participants")
          .textContent.includes("Windows · Preparing"),
      );
      assert.equal(await page.locator("#participants > *").count(), 2);
      await page.waitForFunction(() =>
        document
          .querySelector("#participants")
          .textContent.includes("Cartridge: Fixture 2"),
      );
      assert.equal(
        await page.getByRole("button", { name: /^Remove / }).count(),
        0,
      );
      assert(
        await page
          .locator("#participants")
          .innerText()
          .then((t) => t.includes("Bob")),
      );
      const selects = page.locator("#participants select");
      assert(await selects.nth(0).isDisabled());
      assert(await selects.nth(1).isEnabled());
      await selects.nth(1).click();
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      room.members[1].kind = "native";
      room.members[1].ready = true;
      room.members[1].ping = 14;
      await page.waitForFunction(() =>
        document
          .querySelector("#participants")
          .textContent.includes("Windows · RetroArch"),
      );
      assert(
        await page.locator("#room-panel").isVisible(),
        "Windows handoff hid the room",
      );
      assert.equal(context.pages().length, 1);
      assert.equal(await page.locator("#screen iframe").count(), 0);
      assert.equal(
        await page.locator('[data-ping-player="1"]').innerText(),
        "14 ms",
      );
      assert.equal(await page.locator("#participants > *").count(), 2);
      room.members[0].kind = "native";
      room.members[0].ready = true;
      room.members[0].clientPlatform = "windows-x86_64";
      room.host = 1;
      room.can_start = true;
      room.native_authority = true;
      room.save_host = null;
      await page.waitForFunction(
        () => !document.querySelector("#start").hidden,
      );
      assert(await page.locator("#start").isEnabled());
      assert.equal(
        await page.getByRole("button", { name: /^Remove / }).count(),
        1,
      );
      await page.locator('[data-player="0"]').selectOption("");
      await page.waitForFunction(
        () => document.querySelector('[data-player="0"]').value === "",
      );
      await page.locator('[data-player="0"]').selectOption("0");
      await page.locator("#start").focus();
      if (theme === "dark") await page.locator("#start").tap();
      else await page.keyboard.press("Enter");
      await page.waitForFunction(() =>
        document
          .querySelector("#native-status")
          .textContent.startsWith("Playing in Windows"),
      );
      assert(
        controlRequests.some(
          (action) => action.action === "assign" && action.player === 0,
        ),
      );
      assert(controlRequests.some((action) => action.action === "start"));
      assert.match(
        await page.locator("#native-status").innerText(),
        /save uploads require a playing web participant/,
      );
      assert(await page.locator("#native-status").isVisible());
      assert(await page.locator("#native-credentials").isHidden());
      assert.equal(
        await page.locator("#screen iframe").count(),
        0,
        "Native-only start must not boot a web emulator",
      );
      await page.screenshot({
        path: resolve(output, `${theme}-windows-room.png`),
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: resolve(output, `${theme}-mobile-room.png`),
      });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "Room overflows touch viewport",
      );
      await page
        .getByRole("button", { name: "Remove Alice from room" })
        .click();
      await page.waitForFunction(
        () => document.querySelectorAll("#participants > *").length === 1,
      );
      assert(
        controlRequests.some(
          (action) => action.action === "kick" && action.player === 0,
        ),
      );
      const nativeLeaves = membershipLeaves;
      room.members[0].kind = "web";
      delete room.members[0].clientPlatform;
      room.members[0].playing = room.members[0].ready = false;
      room.running = false;
      await page.evaluate((room) => {
        const socket = window.bridgeConnection.socket;
        socket.members = room.members;
        socket.seats = room.seats;
        socket.message({ t: "returned", generation: 2 });
        socket.lobby({ host: 1, generation: 2 });
      }, room);
      assert(await page.locator("#room-panel").isVisible());
      assert(await page.locator("#setup").isHidden());
      assert(await page.locator("#native-session").isHidden());
      assert(await page.locator("#play-choice").isVisible());
      assert.equal(await page.locator("#screen iframe").count(), 0);
      assert.equal(membershipLeaves, nativeLeaves);
      assert(
        await page.evaluate(
          () =>
            window.bridgeConnection === window.originalRoomConnection &&
            !window.bridgeConnection.closed,
        ),
      );
      assert.equal(await page.locator('[data-player="1"]').inputValue(), "1");
      await page.selectOption("#play-client", "web");
      assert(await page.locator("#join-game").isEnabled());
      await page.screenshot({
        path: resolve(output, `${theme}-windows-returned-to-room.png`),
      });
      assert.deepEqual(errors, []);
      await context.close();

      reset();
      const hostContext = await browser.newContext({
        viewport: { width: 1100, height: 850 },
        hasTouch: true,
      });
      await mockRoomSocket(hostContext, 0);
      const host = await hostContext.newPage();
      host.on("pageerror", (e) => errors.push(e.message));
      await host.goto(
        `http://127.0.0.1:${server.address().port}/assets/emulatorjs/input-netplay/bridge.html`,
      );
      await host.waitForFunction(() => window.bridgePlayer);
      await host.evaluate(
        (theme) => window.bridgePlayer.initialize({ romId: 11, theme }),
        theme,
      );
      await host.locator("#create").click();
      await host.waitForFunction(() =>
        document
          .querySelector("#participants")
          .textContent.includes("Cartridge: Fixture 2"),
      );
      assert.equal(
        await host.locator("#participants select:enabled").count(),
        2,
      );
      assert.equal(
        await host.getByRole("button", { name: /^Remove / }).count(),
        1,
      );
      await host.screenshot({
        path: resolve(output, `${theme}-host-cartridges.png`),
      });
      const remove = host.getByRole("button", {
        name: "Remove Bob from room",
        exact: true,
      });
      if (theme === "dark") await remove.tap();
      else {
        await remove.focus();
        await host.keyboard.press("Enter");
      }
      assert.equal(await host.locator("#participants > *").count(), 1);
      assert(
        await host.evaluate(() =>
          window.sentRoomMessages.some(
            (packet) => packet.t === "kick" && packet.player === 1,
          ),
        ),
      );
      await host.locator('[data-player="0"]').selectOption("0");
      await host.selectOption("#play-client", "web");
      assert.equal(await host.locator("#screen iframe").count(), 0);
      await host.locator("#join-game").click();
      await host.evaluate((cartridges) => {
        const socket = window.bridgeConnection.socket;
        socket.message({
          t: "content",
          cartridges,
          contentCrc: cartridges[0].crc32,
          coreVersion: "0.1.0-f1d5975-rollback2",
        });
      }, room.cartridges);
      await host.waitForFunction(
        () =>
          document.querySelector("#screen iframe")?.contentWindow.finishBoot,
      );
      const game = host
        .frames()
        .find((frame) => frame.url().includes("player.html"));
      assert.equal(
        hostContext.pages().length,
        1,
        "Playing opened a separate window",
      );
      await host.evaluate(() => {
        const socket = window.bridgeConnection.socket;
        socket.seats = [0, 1];
        socket.lobby();
      });
      assert(
        await host.evaluate(() => window.bridgeConnection?.closed === false),
        `Room disconnected during core startup: ${await host.locator("#status").textContent()}`,
      );
      await game.evaluate(() => {
        window.EJS_emulator = {};
      });
      await host.evaluate(() => window.bridgeConnection.socket.lobby());
      await game.evaluate(() => window.finishBoot());
      await host.waitForFunction(() =>
        window.sentRoomMessages.some((packet) => packet.t === "content-ready"),
      );
      const controls = game.locator(".ejs_menu_bar");
      assert(
        await controls.isHidden(),
        "Emulator controls appeared in the waiting room",
      );
      assert(await game.locator(".ejs_virtualGamepad_parent").isHidden());
      assert(await game.locator("#room-panel").isVisible());
      assert.equal(await host.locator("#room-panel").count(), 0);
      const expectedAudio = await host.evaluate(() => {
        const profile = window.bridgeAdapter.profile;
        return [profile.audioOption, profile.audio[0]];
      });
      assert.deepEqual(
        await game.evaluate(() => window.audioSelection.at(-1)),
        expectedAudio,
      );
      await host.screenshot({
        path: resolve(output, `${theme}-waiting-without-controls.png`),
      });
      await host.evaluate(() => {
        window.gameInputs = [];
        window.originalConnection = window.bridgeConnection;
        window.bridgeConnection.started = true;
        window.bridgeConnection.session = {
          tick: (buttons) => {
            window.gameInputs.push(buttons);
            return false;
          },
          memory: () => new Uint8Array(),
        };
        window.bridgeConnection.onStatus("connected");
      });
      assert(
        await controls.isVisible(),
        "Emulator controls stayed hidden after game start",
      );
      assert(await game.locator(".ejs_virtualGamepad_parent").isVisible());
      assert(await game.locator("#room-panel").isHidden());
      await host.evaluate(() => {
        const link = window.bridgeConnection;
        link.socket.members.push({
          player: 1,
          nickname: "Carol",
          kind: "native",
          owner: "2",
          romId: 12,
          ready: true,
          playing: true,
          ping: 12,
        });
        link.started = false;
        link.preparing = true;
        link.onRestart();
        link.onStatus("preparing");
        link.socket.lobby({ host: 1, starting: true });
      });
      assert(
        await game.locator("#room-panel").isHidden(),
        "Native restart opened another player's room panel",
      );
      assert(
        await controls.isVisible(),
        "Restart replaced the existing game view",
      );
      assert(await controls.locator("button").nth(1).isDisabled());
      await host.evaluate(() => {
        const link = window.bridgeConnection;
        link.started = true;
        link.preparing = false;
        link.onStatus("connected");
        link.socket.lobby({ host: 1, running: true });
      });
      assert(
        await game.locator("#room-panel").isHidden(),
        "Room panel stayed open after restart",
      );
      nativeSaveError = true;
      await host.evaluate(() => {
        window.bridgeAdapter.memory = () => Uint8Array.of(7);
        const socket = window.bridgeConnection.socket;
        Object.assign(socket.members[1], {
          kind: "native",
          owner: "2",
          playing: true,
        });
        socket.lobby({ host: 1, saveHost: 0, running: true });
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = host.waitForResponse((response) =>
          response.url().includes("/native/saves"),
        );
        await controls.locator("button").nth(1).click();
        assert.equal((await response).status(), 409);
        await host.waitForFunction(() =>
          document
            .querySelector("#screen iframe")
            .contentDocument.querySelector("#save-status")
            .textContent.includes("outside this session"),
        );
        assert(
          await game.locator("#room-panel").isHidden(),
          "A save retry interrupted the other player's game",
        );
      }
      assert(nativeSaveRequests >= 2);
      assert(
        await game.evaluate(() =>
          window.messages.some((message) =>
            message.includes("Could not sync save"),
          ),
        ),
      );
      nativeSaveError = false;
      await controls.locator("button").nth(1).click();
      await game
        .locator("#save-status")
        .filter({ hasText: "Progress saved." })
        .waitFor({ state: "attached" });
      await host.evaluate(() => {
        window.bridgeAdapter.memory = () => new Uint8Array();
      });
      await game.evaluate(() => {
        window.localButtons = 1;
      });
      await host.waitForFunction(() => window.gameInputs.at(-1) === 1);
      const netplay = controls.locator("button").first();
      if (theme === "dark") await netplay.tap();
      else {
        await netplay.focus();
        await host.keyboard.press("Enter");
      }
      assert(await game.locator("#room-panel").isVisible());
      await host.evaluate(() => window.bridgeConnection.onStatus("connected"));
      assert(
        await game.locator("#room-panel").isVisible(),
        "A resumed game closed the panel opened by its player",
      );
      assert(await controls.isHidden(), "Toolbar covered the open room panel");
      assert(await game.locator(".ejs_virtualGamepad_parent").isHidden());
      await game.evaluate(() => {
        window.localButtons = 1;
      });
      await host.waitForFunction(() => window.gameInputs.at(-1) === 0);
      await host.evaluate(() =>
        window.bridgeConnection.socket.message({
          t: "latency",
          members: [{ player: 0, ping: 17 }],
        }),
      );
      assert.equal(
        await game.locator('[data-ping-player="0"]').innerText(),
        "17 ms",
      );
      assert(
        await host.evaluate(
          () =>
            window.bridgeConnection === window.originalConnection &&
            window.bridgeConnection.started,
        ),
      );
      await host.screenshot({
        path: resolve(output, `${theme}-netplay-room-overlay.png`),
      });
      for (const width of [320, 768, 3840]) {
        await host.setViewportSize({ width, height: 850 });
        await game.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        const layout = await game.evaluate(() => ({
          width: innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          overflow: [...document.querySelectorAll("body *")]
            .filter((node) => node.getBoundingClientRect().right > innerWidth)
            .map((node) => node.id || node.className || node.tagName)
            .slice(0, 12),
        }));
        if (width === 320)
          await host.screenshot({
            path: resolve(output, `${theme}-narrow-room.png`),
          });
        assert(
          layout.scrollWidth <= layout.width,
          `Room actions overflow at ${width}px: ${JSON.stringify(layout)}`,
        );
        assert(await game.locator("#close-game").isVisible());
      }
      await host.setViewportSize({ width: 1100, height: 850 });
      if (theme === "dark") await game.locator("#close-room").tap();
      else await host.keyboard.press("Escape");
      assert(await game.locator("#room-panel").isHidden());
      assert(await controls.isVisible());
      assert(await game.locator(".ejs_virtualGamepad_parent").isVisible());
      assert(
        await game
          .locator("#game")
          .evaluate((node) => node === document.activeElement),
      );
      await netplay.click();
      await game.locator("#close-room").click();
      assert(await game.locator("#room-panel").isHidden());
      await host.screenshot({
        path: resolve(output, `${theme}-embedded-game.png`),
      });
      const priorLeaves = membershipLeaves;
      if (theme === "light")
        await controls
          .getByRole("button", { name: "Save and return to room" })
          .click();
      else {
        await netplay.tap();
        await game.locator("#close-game").tap();
      }
      await host.waitForFunction(
        () => !document.querySelector("#screen iframe"),
      );
      assert(await host.locator("#room-panel").isVisible());
      assert(await host.locator("#setup").isHidden());
      assert.equal(membershipLeaves, priorLeaves);
      assert(
        await host.evaluate(
          () =>
            window.bridgeConnection === window.originalConnection &&
            !window.bridgeConnection.closed &&
            window.bridgeConnection.gameClosed,
        ),
      );
      assert(await host.locator("#join-game").isEnabled());
      await host.screenshot({
        path: resolve(output, `${theme}-web-returned-to-room.png`),
      });
      await host.evaluate(() => {
        const socket = window.bridgeConnection.socket;
        socket.lobby({
          host: 0,
          running: true,
          contentPrepared: true,
          collectCartridges: true,
          cartridges: [{ romId: 11 }, { romId: 12 }],
          canStart: false,
        });
      });
      assert(
        await host.locator("#start").isHidden(),
        "Matching-cartridge rejoin must not request a host restart",
      );
      assert.match(
        await host.locator("#lobby-status").innerText(),
        /Join game/,
      );
      await host.evaluate(() => {
        const socket = window.bridgeConnection.socket;
        socket.members[1].romId = 11;
        socket.lobby({
          host: 0,
          running: true,
          contentPrepared: true,
          collectCartridges: true,
          cartridges: [{ romId: 11 }, { romId: 12 }],
          canStart: true,
        });
      });
      assert.equal(
        await host.locator("#start").innerText(),
        "Prepare new game",
      );
      assert(await host.locator("#start").isEnabled());
      assert.match(
        await host.locator("#lobby-status").innerText(),
        /different cartridge/,
      );
      assert.equal(
        await host.locator("#join-cartridge, #cartridge-selection").count(),
        0,
      );
      await host.screenshot({
        path: resolve(output, `${theme}-next-game-cartridge.png`),
      });
      await host.evaluate(() => {
        const socket = window.bridgeConnection.socket;
        socket.message({ t: "game-reset", generation: 5 });
        socket.lobby({ host: 0, running: false });
      });
      assert(await host.locator("#join-game").isEnabled());
      assert.equal(membershipLeaves, priorLeaves);
      if (theme === "light") {
        await host.locator("#disconnect").click();
        await host.waitForFunction(() => !window.bridgeConnection);
        assert(await host.locator("#room-panel").isVisible());
        assert.equal(await host.locator("#screen iframe").count(), 0);
      } else {
        await host.goto("about:blank");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert(
        membershipLeaves > priorLeaves,
        "Leaving the room did not revoke membership",
      );
      assert.equal(hostContext.pages().length, 1);
      assert.deepEqual(errors, []);
      await hostContext.close();
    }
    for (const theme of ["light", "dark"]) {
      reset();
      roms.forEach((rom, i) => {
        rom.platform_slug = "gbc";
        rom.fs_name = `fixture-${rom.id}.gbc`;
        rom.name = i ? "Silver fixture" : "Gold fixture";
      });
      room.core_name = "SameBoy";
      const context = await browser.newContext({ hasTouch: true });
      await mockRoomSocket(context, 0);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        `http://127.0.0.1:${server.address().port}/assets/emulatorjs/input-netplay/bridge.html`,
      );
      await page.waitForFunction(() => window.bridgePlayer);
      await page.evaluate(
        (theme) => window.bridgePlayer.initialize({ romId: 11, theme }),
        theme,
      );
      await page.locator("#create").click();
      await page.waitForFunction(() =>
        document
          .querySelector("#participants")
          .textContent.includes("Cartridge: Silver fixture"),
      );
      await page.locator('[data-player="0"]').selectOption("0");
      await page.locator('[data-player="1"]').selectOption("1");
      assert.equal(await page.locator('[data-player="1"]').inputValue(), "1");
      assert.equal(await page.locator("#screen iframe").count(), 0);
      await page.screenshot({
        path: resolve(output, `${theme}-gbc-different-cartridges.png`),
      });
      if (theme === "light") {
        await page
          .getByRole("button", { name: "Remove Bob from room" })
          .focus();
        await page.keyboard.press("Enter");
      } else
        await page.getByRole("button", { name: "Remove Bob from room" }).tap();
      assert.equal(await page.locator("#participants > *").count(), 1);
      assert.deepEqual(errors, []);
      await context.close();
    }
    roms.forEach((rom, i) => {
      rom.platform_slug = "gba";
      rom.fs_name = `fixture-${rom.id}.gba`;
      rom.name = `Fixture ${i + 1}`;
    });
    for (const isolated of [true, false]) {
      reset();
      const embeddedContext = await browser.newContext();
      await mockRoomSocket(embeddedContext, 0);
      try {
        const shell = await embeddedContext.newPage();
        const errors = [];
        shell.on("pageerror", (error) => errors.push(error.message));
        await shell.goto(
          `http://127.0.0.1:${server.address().port}/room-shell${isolated ? "" : "-unisolated"}`,
        );
        assert.equal(await shell.evaluate(() => crossOriginIsolated), isolated);
        const roomFrame = shell
          .frames()
          .find((frame) => frame.url().includes("bridge.html"));
        await roomFrame.waitForFunction(() => window.bridgePlayer);
        await roomFrame.evaluate(() =>
          window.bridgePlayer.initialize({
            romId: 11,
            theme: "dark",
            resume: { saveId: null, battery: [9, 8] },
          }),
        );
        await roomFrame.locator("#create").click();
        await roomFrame.waitForFunction(
          () => window.bridgeConnection?.manualStart,
        );
        assert.deepEqual(
          await roomFrame.evaluate(() =>
            Array.from(window.bridgeConnection.battery),
          ),
          [9, 8],
          "Room entry lost current in-game progress",
        );
        await roomFrame.locator('[data-player="0"]').selectOption("0");
        await roomFrame.selectOption("#play-client", "web");
        await roomFrame.locator("#join-game").click();
        await roomFrame.evaluate((cartridges) => {
          window.open = () => {
            throw new Error("Room play must not open a popup");
          };
          window.bridgeConnection.socket.message({
            t: "content",
            cartridges,
            contentCrc: cartridges[0].crc32,
            coreVersion: "0.1.0-f1d5975-rollback2",
          });
        }, room.cartridges);
        await roomFrame.waitForFunction(
          () =>
            document.querySelector("#screen iframe")?.contentWindow.finishBoot,
        );
        const game = shell
          .frames()
          .find((frame) => frame.url().includes("player.html"));
        assert.equal(await game.evaluate(() => crossOriginIsolated), isolated);
        await game.evaluate(() => window.finishBoot());
        await roomFrame.waitForFunction(() =>
          window.sentRoomMessages.some(
            (packet) => packet.t === "content-ready",
          ),
        );
        assert(
          await roomFrame.evaluate(
            () =>
              !window.bridgeConnection.closed &&
              !window.bridgeConnection.gameClosed,
          ),
        );
        assert.equal(embeddedContext.pages().length, 1);
        await roomFrame.evaluate(() => {
          window.bridgeConnection.started = true;
          window.bridgeConnection.session = { tick: () => false };
          window.bridgeConnection.onStatus("connected");
        });
        await game.locator(".ejs_menu_bar button").first().click();
        assert(await game.locator("#room-panel").isVisible());
        assert(
          await game
            .locator("#room-panel")
            .evaluate((panel) =>
              document.querySelector("#game").contains(panel),
            ),
        );
        await roomFrame.evaluate(() => window.bridgePlayer.destroy());
        assert.equal(await roomFrame.locator("#screen iframe").count(), 0);
        assert.deepEqual(errors, []);
      } finally {
        await embeddedContext.close();
      }
    }
  });
  console.log(
    "Room UI passed: both themes, keyboard, mouse and touch, responsive entry and lobby, preselected save/fresh start/current progress retained, Windows lobby retained, embedded Netplay room with live ping, return to game without disconnect, neutral input while room is open, room exit revokes membership, isolated and ordinary SPA documents; no emulator launched",
  );
} finally {
  await new Promise((r) => server.close(r));
}
