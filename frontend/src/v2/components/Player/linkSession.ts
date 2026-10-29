import type { RoomsResponse, SimpleRomSchema } from "@/__generated__";
import type { Socket } from "socket.io-client";
import api from "@/services/api";

export interface LinkRoom {
  roms: (number | null)[];
  player: number;
  maxPlayers?: number;
  manualStart?: boolean;
  automatic?: boolean;
  hostGame?: string | undefined;
  roomId?: string;
  roomName: string;
  password: string;
}

export interface LinkLaunch extends LinkRoom {
  roms: number[];
  save: Uint8Array<ArrayBuffer> | null;
  connection?: LinkConnection | undefined;
}

export interface LinkConnection {
  socket: Socket;
  owner: boolean;
  playerID: string;
  extra: Record<string, string>;
  players: Record<string, unknown>;
  maxPlayers?: number;
}

export interface NetplayMenu {
  getOpenRooms(): Promise<Record<string, RoomsResponse>>;
  showOpenRoomDialog(): void;
  joinRoom(
    id: string,
    name: string,
    max: number,
    password: string | null,
  ): void;
  startLinkLobby?(options: {
    romId: number;
    room: LinkRoom;
    startLabel: string;
    seatLabel: string;
    chooseSeatLabel: string;
    seatHint: string;
    onReady: (roms: number[], player: number) => Promise<void>;
    onError: (cause: unknown) => void;
  }): void;
  detachRoom?(): LinkConnection;
  leaveRoom?(): void;
}

export function supportsLink(
  rom: Pick<SimpleRomSchema, "platform_slug">,
): boolean {
  return ["gb", "gbc", "gba"].includes(rom.platform_slug);
}

export function linkCoreFor(platform: string): "sameboy" | "mgba_splitscreen" {
  return platform === "gba" ? "mgba_splitscreen" : "sameboy";
}

export function linkPlatforms(platform: string): string[] {
  return platform === "gba" ? ["gba"] : ["gb", "gbc"];
}

export function isLinkPair(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((id) => Number.isSafeInteger(id) && id > 0)
  );
}

export const LINK_SAVE_SLOT = "link";

export function isLinkRoms(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.length <= 4 &&
    value.every((id) => Number.isSafeInteger(id) && id > 0)
  );
}

export function installLinkRoomMenu(
  menu: NetplayMenu,
  romId: number,
  create: () => void,
  join: (room: LinkRoom) => void,
): () => void {
  /* eslint-disable @typescript-eslint/unbound-method -- Restored to menu or invoked with .call(menu). */
  const original = {
    rooms: menu.getOpenRooms,
    create: menu.showOpenRoomDialog,
    join: menu.joinRoom,
  };
  /* eslint-enable @typescript-eslint/unbound-method */
  let rooms: Record<string, RoomsResponse> = {};
  menu.getOpenRooms = async () => {
    const { data } = await api.get<Record<string, RoomsResponse>>(
      "/netplay/list",
      {
        params: { game_id: romId, include_link: true },
      },
    );
    rooms = data;
    return data;
  };
  menu.showOpenRoomDialog = create;
  menu.joinRoom = (id, name, max, password) => {
    const selected = rooms[id];
    const pair = selected?.link_roms;
    if (selected?.link_host_rom) {
      join({
        roms: [selected.link_host_rom, romId],
        automatic: true,
        maxPlayers: selected.max,
        manualStart: !!selected.link_manual_start,
        hostGame: selected.link_game_name,
        player: 1,
        roomId: id,
        roomName: name,
        password: password ?? "",
      });
    } else if (isLinkPair(pair) && pair[1] === romId) {
      join({
        roms: pair,
        player: 1,
        roomId: id,
        roomName: name,
        password: password ?? "",
      });
    } else if (!pair) original.join.call(menu, id, name, max, password);
  };
  return () => {
    menu.getOpenRooms = original.rooms;
    menu.showOpenRoomDialog = original.create;
    menu.joinRoom = original.join;
  };
}
