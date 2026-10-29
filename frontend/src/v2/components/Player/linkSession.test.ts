import { AxiosHeaders } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomsResponse } from "@/__generated__";
import api from "@/services/api";
import {
  installLinkRoomMenu,
  isLinkPair,
  isLinkRoms,
  linkCoreFor,
  linkPlatforms,
  supportsLink,
  type NetplayMenu,
} from "./linkSession";

vi.mock("@/services/api", () => ({ default: { get: vi.fn() } }));

const room = (overrides: Partial<RoomsResponse> = {}): RoomsResponse => ({
  room_name: "Trade",
  current: 1,
  max: 2,
  player_name: "Host",
  hasPassword: true,
  ...overrides,
});

describe("existing player netplay menu", () => {
  beforeEach(() => vi.clearAllMocks());

  it("finds the host's pair from the guest's own game and retains ordinary room joins", async () => {
    const data: Record<string, RoomsResponse> = {
      link: room({ link_roms: [19, 20] }),
      stream: room(),
      automatic: room({ link_host_rom: 19, link_game_name: "Gold" }),
    };
    vi.mocked(api.get).mockResolvedValue({
      data,
      status: 200,
      statusText: "OK",
      headers: {},
      config: { headers: new AxiosHeaders() },
    });
    const menu: NetplayMenu = {
      getOpenRooms: vi.fn<NetplayMenu["getOpenRooms"]>().mockResolvedValue({}),
      showOpenRoomDialog: vi.fn(),
      joinRoom: vi.fn(),
    };
    const originalJoin = menu.joinRoom;
    const create = vi.fn(),
      join = vi.fn();
    const restore = installLinkRoomMenu(menu, 20, create, join);
    expect(await menu.getOpenRooms()).toEqual(data);
    menu.showOpenRoomDialog();
    expect(create).toHaveBeenCalledOnce();
    menu.joinRoom("link", "Trade", 2, "secret");
    expect(join).toHaveBeenCalledWith({
      roms: [19, 20],
      player: 1,
      roomId: "link",
      roomName: "Trade",
      password: "secret",
    });
    expect(originalJoin).not.toHaveBeenCalled();
    menu.joinRoom("automatic", "Trade", 2, null);
    expect(join).toHaveBeenLastCalledWith({
      roms: [19, 20],
      automatic: true,
      maxPlayers: 2,
      manualStart: false,
      hostGame: "Gold",
      player: 1,
      roomId: "automatic",
      roomName: "Trade",
      password: "",
    });
    menu.joinRoom("stream", "Ordinary", 4, null);
    expect(originalJoin).toHaveBeenCalledWith("stream", "Ordinary", 4, null);
    restore();
    expect(menu.joinRoom).toBe(originalJoin);
  });

  it("does not join a link room as the wrong cartridge or through the streaming protocol", async () => {
    const data = {
      reversed: room({ link_roms: [20, 19] }),
      invalid: room({ link_roms: [19] }),
    };
    vi.mocked(api.get).mockResolvedValue({
      data,
      status: 200,
      statusText: "OK",
      headers: {},
      config: { headers: new AxiosHeaders() },
    });
    const originalJoin = vi.fn();
    const menu: NetplayMenu = {
      getOpenRooms: vi.fn<NetplayMenu["getOpenRooms"]>().mockResolvedValue({}),
      showOpenRoomDialog: vi.fn(),
      joinRoom: originalJoin,
    };
    const join = vi.fn();
    installLinkRoomMenu(menu, 20, vi.fn(), join);
    await menu.getOpenRooms();
    menu.joinRoom("reversed", "Trade", 2, "secret");
    menu.joinRoom("invalid", "Trade", 2, "secret");
    expect(join).not.toHaveBeenCalled();
    expect(originalJoin).not.toHaveBeenCalled();
  });
});

it.each([
  { platform: "gba", supported: true },
  { platform: "gb", supported: true },
  { platform: "gbc", supported: true },
  { platform: "snes", supported: false },
  { platform: "nds", supported: false },
])("selects the link room menu by platform: $platform", (scenario) => {
  for (const fs_name of [
    "Game folder",
    "game.gba",
    "game.zip",
    "game.7z",
    "",
  ]) {
    const rom = { platform_slug: scenario.platform, fs_name };
    expect(supportsLink(rom)).toBe(scenario.supported);
  }
});

it("selects the linked core and compatible platforms", () => {
  expect(linkCoreFor("gba")).toBe("mgba_splitscreen");
  expect(linkCoreFor("gbc")).toBe("sameboy");
  expect(linkPlatforms("gba")).toEqual(["gba"]);
  expect(linkPlatforms("gbc")).toEqual(["gb", "gbc"]);
  expect(isLinkPair([19, 20])).toBe(true);
  for (const pair of [[19], [19, 20, 21], [19, -1], [19, "20"], null])
    expect(isLinkPair(pair)).toBe(false);
});

it("validates GBA room cartridge lists for two to four players", () => {
  for (const ids of [
    [19, 20],
    [19, 20, 21],
    [19, 20, 21, 22],
  ])
    expect(isLinkRoms(ids)).toBe(true);
  for (const ids of [
    [19],
    [19, 20, 21, 22, 23],
    [19, null],
    [19, "20"],
    [19, -1],
  ])
    expect(isLinkRoms(ids)).toBe(false);
});
