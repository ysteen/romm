import { linkCore } from "./link-core.js?v=20261101.1";

export function bridgeCore(core, players = 2) {
  if (core !== "snes9x") {
    return {
      ...linkCore(core, players),
      system: core === "sameboy" ? "gb" : "gba",
      frameRate: 59.7275,
      sharedSave: false,
      saveSlot: "link",
    };
  }
  if (players !== 2) throw new Error("SNES rooms require exactly two players");
  return {
    core,
    system: "snes",
    players,
    maxPlayers: 2,
    standardGame: true,
    extension: "sfc",
    minRomSize: 0x8000,
    maxRomSize: 12 * 1024 * 1024,
    memoryIds: [0],
    sharedSave: true,
    saveSlot: "netplay",
    width: 256,
    height: 224,
    columns: 1,
    rows: 1,
    frameRate: 60.09881389744051,
    options: {
      snes9x_region: "auto",
      snes9x_overclock_superfx: "100%",
      snes9x_overclock_cycles: "disabled",
      snes9x_up_down_allowed: "disabled",
      snes9x_audio_interpolation: "gaussian",
      snes9x_blargg: "disabled",
      snes9x_randomize_memory: "disabled",
    },
  };
}

export function bridgeCoreFor(platform) {
  if (platform === "snes") return "snes9x";
  if (platform === "gba") return "mgba_splitscreen";
  if (platform === "gb" || platform === "gbc") return "sameboy";
  throw new Error("Multiplayer rooms support GB, GBC, GBA and SNES");
}

export function bridgeBatteryId(profile, player) {
  return profile.memoryIds[profile.sharedSave ? 0 : player];
}

export function bridgeSeed(profile, player, battery) {
  return profile.sharedSave && player !== 0 ? new Uint8Array() : battery;
}

export function bridgeSaveSelection(profile, saves = [], saveId) {
  // mGBA single-player and the split-screen core use the same raw cartridge
  // battery format. Keep unrelated core formats out of this import path.
  const cores =
    profile.core === "mgba_splitscreen"
      ? ["mgba_splitscreen", "mgba"]
      : [profile.core];
  const compatible = saves
    .filter(
      (save) =>
        !save.missing_from_fs &&
        (!save.emulator || cores.includes(save.emulator)),
    )
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  const selected =
    saveId === undefined
      ? (compatible[0] ?? null)
      : saveId === null
        ? null
        : compatible.find((save) => save.id === saveId);
  if (saveId !== undefined && saveId !== null && !selected)
    throw new Error(
      "The selected save is unavailable or incompatible with this multiplayer core. Choose another save before starting.",
    );
  return {
    selected,
    // Room uploads keep their own core/slot; never overwrite an alias's slot.
    target:
      compatible.find(
        (save) =>
          save.slot === profile.saveSlot &&
          (!save.emulator || save.emulator === profile.core),
      ) ?? null,
  };
}
