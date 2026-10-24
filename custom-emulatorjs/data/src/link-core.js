const profiles = {
  sameboy: {
    core: "sameboy",
    extension: "gb",
    subsystem: "gb_link_2p",
    minRomSize: 0x150,
    maxRomSize: 8 * 1024 * 1024,
    memoryIds: [256, 768],
    maxPlayers: 2,
    width: 160,
    height: 144,
    linkOption: "sameboy_link",
    audioOption: "sameboy_audio_output",
    audio: ["Game Boy #1", "Game Boy #2"],
    options: {
      sameboy_link: "enabled",
      sameboy_rtc: "accurate",
      sameboy_model_1: "Auto",
      sameboy_model_2: "Auto",
      sameboy_screen_layout: "left-right",
      sameboy_audio_output: "Game Boy #1",
      video_rotation: "0",
    },
  },
  mgba_splitscreen: {
    core: "mgba_splitscreen",
    extension: "gba",
    subsystem: "gba_link_2p",
    minRomSize: 0xc0,
    maxRomSize: 32 * 1024 * 1024,
    memoryIds: [0, 256, 257, 258],
    maxPlayers: 4,
    width: 240,
    height: 160,
    linkOption: "splitscreen_link",
    audioOption: "splitscreen_audio",
    audio: ["player 1", "player 2", "player 3", "player 4"],
    options: {
      splitscreen_players: "2",
      splitscreen_layout: "2x1",
      splitscreen_link: "enabled",
      splitscreen_audio: "player 1",
      splitscreen_audio_low_pass: "off",
      splitscreen_audio_limiter: "off",
      splitscreen_fs_assist: "off",
      splitscreen_overlays: "off",
      video_rotation: "0",
    },
  },
};

export function linkCore(core = "sameboy", players = 2) {
  if (!Object.hasOwn(profiles, core))
    throw new Error("This core does not support link play");
  const profile = profiles[core];
  if (!Number.isInteger(players) || players < 2 || players > profile.maxPlayers)
    throw new Error("Unsupported number of linked players");
  return {
    ...profile,
    players,
    columns: 2,
    rows: Math.ceil(players / 2),
    memoryIds: profile.memoryIds.slice(0, players),
    subsystem:
      core === "mgba_splitscreen" ? `gba_link_${players}p` : profile.subsystem,
    options: {
      ...profile.options,
      ...(core === "mgba_splitscreen"
        ? {
            splitscreen_players: String(players),
            splitscreen_layout: players > 2 ? "2x2" : "2x1",
          }
        : {}),
    },
  };
}

export function selectLinkCartridge(files, profile) {
  const extension = profile.extension === "gba" ? /\.gba$/i : /\.(gb|gbc)$/i;
  const candidates = files.filter(
    ({ filename }) =>
      extension.test(filename) &&
      !filename
        .split("/")
        .some((part) => part === "__MACOSX" || part.startsWith("._")),
  );
  if (candidates.length !== 1)
    throw new Error(
      "Link play requires exactly one compatible cartridge in each ZIP.",
    );
  const file = candidates[0];
  if (
    file.bytes.length < profile.minRomSize ||
    file.bytes.length > profile.maxRomSize
  )
    throw new Error(
      "The link cartridge exceeds this system's supported ROM size.",
    );
  return file;
}

export async function unpackLinkCartridge(bytes, profile, compression) {
  const format = compression.isCompressed(bytes);
  if (format && format !== "zip")
    throw new Error(
      "Link play supports raw cartridges and single-game ZIP files.",
    );
  const files = format
    ? Object.entries(await compression.decompress(bytes, () => {})).map(
        ([filename, bytes]) => ({ filename, bytes }),
      )
    : [{ filename: `cartridge.${profile.extension}`, bytes }];
  return selectLinkCartridge(files, profile).bytes;
}

export function importBattery(adapter, profile, player, bytes) {
  const id = profile.memoryIds[player];
  const size = adapter.memory(id).length;
  if (profile.core === "sameboy" && bytes.length === size + 4)
    bytes = bytes.slice(0, size);
  if (
    profile.core === "mgba_splitscreen" &&
    [512, 8192, 32768, 65536, 131072].includes(bytes.length) &&
    bytes.length < size
  ) {
    const padded = new Uint8Array(size).fill(255);
    padded.set(bytes);
    bytes = padded;
  }
  adapter.loadMemory(id, bytes);
}
