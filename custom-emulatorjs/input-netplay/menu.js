export function installPlayerExit(emulator, label, leave) {
  const button = emulator.elements.bottomBar.exit[0];
  button.querySelector(".ejs_menu_text").textContent = label;
  button.setAttribute("aria-label", label);
  button.style.display = "";
  // Upload the confirmed battery RAM before the core's shutdown handler runs.
  button.addEventListener(
    "click",
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      emulator.menu.close();
      void leave();
    },
    true,
  );
}

export function installPlayerMenu(emulator, link) {
  const bar = emulator.elements.bottomBar;
  const settings = bar.settings[0][0];
  const rightClick = emulator.config.buttonOpts?.rightClick;
  const soloButtons = [
    ...[
      "playPause",
      "restart",
      "saveState",
      "loadState",
      "cheat",
      "saveSavFiles",
      "loadSavFiles",
      "contextMenu",
      "cacheManager",
      "quickLoad",
      "saveQuit",
    ].flatMap((key) => bar[key] ?? []),
    settings,
  ];
  // This runtime must keep the paired core, cropped view and audio route.
  for (const option of [
    "retroarch_core",
    "ejs_threads",
    ...Object.keys(link.profile?.options ?? {}),
    "splitscreen_focus_player",
    "videoRotation",
  ]) {
    emulator.settingsMenu
      .querySelector(`[data-ejs-option="${option}"]`)
      ?.classList.add("romm-link-disabled");
  }
  for (const [target, method] of [
    [emulator, "togglePlaying"],
    [emulator, "saveState"],
    [emulator, "loadState"],
    [emulator.gameManager, "restart"],
    [emulator.gameManager, "loadState"],
    [emulator.gameManager, "quickLoad"],
    [emulator.gameManager, "quickSave"],
  ]) {
    const original = target[method];
    target[method] = function (...args) {
      if (link.status === "solo") return original?.apply(this, args);
    };
  }
  function update(status) {
    const solo = status === "solo";
    emulator.config.buttonOpts ??= {};
    emulator.config.buttonOpts.rightClick = solo ? rightClick : false;
    for (const button of soloButtons) {
      button.classList.toggle("romm-link-disabled", !solo);
      button.disabled = !solo;
    }
    emulator.config.disableRestart = !solo;
    if (!solo) {
      emulator.settingsMenu.style.display = "none";
      emulator.paused = false;
      bar.playPause[0].style.display = "";
      bar.playPause[1].style.display = "none";
    }
  }
  update(link.status);
  return update;
}

export function installPlayerActions(emulator, integration) {
  const bar = emulator.elements.bottomBar;
  const add = (source, key, label, action, before) => {
    const button = source.cloneNode(true);
    button.style.display = "";
    button.querySelector(".ejs_menu_text").textContent = label;
    button.setAttribute("aria-label", label);
    button.addEventListener("click", () => {
      if (!button.disabled) void action();
    });
    source.parentNode.insertBefore(button, before ?? null);
    bar[key] = [button];
  };
  add(
    bar.loadState[0],
    "quickLoad",
    integration.labels.quickLoad,
    integration.onQuickLoad,
    bar.loadState[0],
  );
  add(bar.exit[0], "saveQuit", integration.labels.saveQuit, async () => {
    await emulator.saveState();
    if (integration.canExit()) await integration.onExit();
  });
  bar.contextMenu[0].querySelector(".ejs_menu_text").textContent =
    integration.labels.contextMenu;
}
