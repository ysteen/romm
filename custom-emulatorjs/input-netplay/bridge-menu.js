import { installPlayerExit } from "./menu.js?v=20261102";

export function installBridgeMenu(
  emulator,
  {
    panel,
    showRoom,
    pause,
    save,
    closeGame,
    exitLabel = "Save and return to room",
  },
) {
  const bar = emulator.elements.bottomBar;
  emulator.elements.parent.append(panel);
  emulator.config.netplayLaunch = () => showRoom(true);
  bar.netplay[0].style.display = "";
  for (const key of [
    "restart",
    "saveState",
    "loadState",
    "cheat",
    "loadSavFiles",
    "contextMenu",
    "cacheManager",
  ]) {
    for (const button of bar[key] ?? []) {
      button.classList.add("romm-link-disabled");
      button.disabled = true;
    }
  }
  for (const option of [
    "retroarch_core",
    "ejs_threads",
    "videoRotation",
    "splitscreen_focus_player",
    ...Object.keys(emulator.config.defaultOptions ?? {}),
  ])
    emulator.settingsMenu
      .querySelector(`[data-ejs-option="${option}"]`)
      ?.classList.add("romm-link-disabled");
  for (const [target, name] of [
    [emulator, "saveState"],
    [emulator, "loadState"],
    [emulator.gameManager, "restart"],
    [emulator.gameManager, "loadState"],
    [emulator.gameManager, "quickLoad"],
    [emulator.gameManager, "quickSave"],
  ])
    target[name] = () => {};
  emulator.pause = () => pause(true);
  emulator.play = () => pause(false);
  emulator.togglePlaying = () => pause(!emulator.paused);
  const saveButton = bar.saveSavFiles[0];
  saveButton.style.display = "";
  saveButton.addEventListener(
    "click",
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      void save();
    },
    true,
  );
  installPlayerExit(emulator, exitLabel, closeGame);
  return (paused, started, roomOpen, ready = started) => {
    emulator.elements.parent.classList.toggle(
      "romm-room-open",
      !started || roomOpen,
    );
    emulator.elements.menu.hidden = !started || roomOpen;
    if (emulator.elements.menu.hidden)
      emulator.elements.menu.style.setProperty("display", "none", "important");
    else emulator.elements.menu.style.removeProperty("display");
    emulator.paused = paused;
    bar.playPause[0].style.display = paused ? "none" : "";
    bar.playPause[1].style.display = paused ? "" : "none";
    for (const button of [...bar.playPause, saveButton])
      button.disabled = !ready;
  };
}
