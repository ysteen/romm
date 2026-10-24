import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

interface Emulator {
  elements: { bottomBar: { exit: HTMLButtonElement[] } };
  menu: { close: () => void };
}
const source = readFileSync(
  resolve(process.cwd(), "../custom-emulatorjs/input-netplay/menu.js"),
  "utf8",
);
const installPlayerExit = runInNewContext(
  source.replaceAll("export function", "function") + "; installPlayerExit;",
) as (emulator: Emulator, label: string, leave: () => Promise<void>) => void;

it("lets the account save finish before the core can shut down", async () => {
  const coreExit = vi.fn();
  const button = document.createElement("button");
  button.innerHTML = '<span class="ejs_menu_text">Core exit</span>';
  button.style.display = "none";
  button.addEventListener("click", coreExit);
  const emulator: Emulator = {
    elements: { bottomBar: { exit: [button] } },
    menu: { close: vi.fn() },
  };
  const saved = Promise.withResolvers<void>();
  const leave = vi.fn(() => saved.promise);
  installPlayerExit(emulator, "Quit", leave);

  button.click();

  expect(button.style.display).toBe("");
  expect(button.textContent).toBe("Quit");
  expect(button.getAttribute("aria-label")).toBe("Quit");
  expect(leave).toHaveBeenCalledOnce();
  expect(emulator.menu.close).toHaveBeenCalledOnce();
  expect(coreExit).not.toHaveBeenCalled();
  saved.resolve();
  await saved.promise;
  expect(coreExit).not.toHaveBeenCalled();
});

interface PlaybackEmulator {
  elements: {
    bottomBar: {
      playPause: HTMLButtonElement[];
      restart: HTMLButtonElement[];
      settings: HTMLButtonElement[][];
      gamepad: HTMLButtonElement[];
      netplay: HTMLButtonElement[];
      exit: HTMLButtonElement[];
      saveState: HTMLButtonElement[];
      loadState: HTMLButtonElement[];
      quickLoad: HTMLButtonElement[];
      saveQuit: HTMLButtonElement[];
      cheat: HTMLButtonElement[];
      contextMenu: HTMLButtonElement[];
      cacheManager: HTMLButtonElement[];
    };
  };
  gameManager: { restart(): void };
  togglePlaying(): void;
  settingsMenu: HTMLDivElement;
  config: { disableRestart: boolean; buttonOpts?: { rightClick?: boolean } };
  paused: boolean;
}
const installPlayerMenu = runInNewContext(
  source.replaceAll("export function", "function") + "; installPlayerMenu;",
) as (
  emulator: PlaybackEmulator,
  link: { status: string },
) => (status: string) => void;

it("keeps local controls available and restores playback menus only after disconnection", () => {
  const button = () => document.createElement("button");
  const pause = button(),
    play = button(),
    restart = button(),
    settings = button();
  const togglePlaying = vi.fn(),
    restartCore = vi.fn();
  const emulator: PlaybackEmulator = {
    elements: {
      bottomBar: {
        playPause: [pause, play],
        restart: [restart],
        settings: [[settings]],
        saveState: [button()],
        loadState: [button()],
        quickLoad: [button()],
        saveQuit: [button()],
        cheat: [button()],
        contextMenu: [button()],
        cacheManager: [button()],
        gamepad: [button()],
        netplay: [button()],
        exit: [button()],
      },
    },
    gameManager: { restart: restartCore },
    togglePlaying,
    settingsMenu: document.createElement("div"),
    config: { disableRestart: true },
    paused: false,
  };
  pause.addEventListener("click", () => emulator.togglePlaying());
  restart.addEventListener("click", () => emulator.gameManager.restart());
  const link = { status: "waiting" };
  const update = installPlayerMenu(emulator, link);
  const restored = [
    "saveState",
    "loadState",
    "quickLoad",
    "saveQuit",
    "cheat",
    "contextMenu",
    "cacheManager",
  ] as const;
  for (const status of ["waiting", "connecting", "connected"]) {
    link.status = status;
    update(status);
    for (const control of [pause, play, restart, settings]) {
      expect(control.disabled).toBe(true);
      expect(control.classList.contains("romm-link-disabled")).toBe(true);
      control.click();
    }
    emulator.togglePlaying();
    emulator.gameManager.restart();
    for (const name of restored) {
      expect(emulator.elements.bottomBar[name][0].disabled).toBe(true);
      expect(
        emulator.elements.bottomBar[name][0].classList.contains(
          "romm-link-disabled",
        ),
      ).toBe(true);
    }
    expect(emulator.config.buttonOpts?.rightClick).toBe(false);
    for (const name of ["gamepad", "netplay", "exit"] as const) {
      expect(emulator.elements.bottomBar[name][0].disabled).toBe(false);
    }
  }
  expect(togglePlaying).not.toHaveBeenCalled();
  expect(restartCore).not.toHaveBeenCalled();

  link.status = "solo";
  update(link.status);
  for (const control of [pause, play, restart, settings]) {
    expect(control.disabled).toBe(false);
    expect(control.classList.contains("romm-link-disabled")).toBe(false);
  }
  expect(emulator.config.disableRestart).toBe(false);
  for (const name of restored) {
    expect(emulator.elements.bottomBar[name][0].disabled).toBe(false);
    expect(
      emulator.elements.bottomBar[name][0].classList.contains(
        "romm-link-disabled",
      ),
    ).toBe(false);
  }
  expect(emulator.config.buttonOpts?.rightClick).toBeUndefined();
  pause.click();
  restart.click();
  expect(togglePlaying).toHaveBeenCalledOnce();
  expect(restartCore).toHaveBeenCalledOnce();

  emulator.paused = true;
  link.status = "waiting";
  update(link.status);
  expect(emulator.paused).toBe(false);
  expect(emulator.config.disableRestart).toBe(true);
  expect(settings.disabled).toBe(true);
  emulator.gameManager.restart();
  expect(restartCore).toHaveBeenCalledOnce();
});
