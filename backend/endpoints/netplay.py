from typing import NotRequired, TypedDict

from decorators.auth import protected_route
from exceptions.endpoint_exceptions import RomNotFoundInDatabaseException
from fastapi import HTTPException, Request
from handler.auth.constants import Scope
from handler.auth.dependencies import assert_rom_visible, can_access, get_permissions
from handler.database import db_rom_handler
from handler.netplay_handler import NetplayRoom, get_link_cartridge, netplay_handler
from models.permission import PermAction, PermEntity
from utils.router import APIRouter

router = APIRouter(
    prefix="/netplay",
    tags=["netplay"],
)


DEFAULT_MAX_PLAYERS = 4


def _get_owner_player_name(room: NetplayRoom) -> str:
    owner_sid = room.get("owner")
    if not owner_sid:
        return "Unknown"

    return next(
        (
            p["player_name"]
            for p in room["players"].values()
            if p["socketId"] == owner_sid
        ),
        "Unknown",
    )


def _link_roms(game_id: str) -> tuple[int, int] | None:
    parts = str(game_id).split(":")
    if len(parts) != 3 or parts[0] != "link":
        return None
    if not all(
        len(part) <= 20 and part.isascii() and part.isdecimal() for part in parts[1:]
    ):
        return None
    first, second = int(parts[1]), int(parts[2])
    return (first, second) if first > 0 and second > 0 else None


def _is_room_open(
    room: NetplayRoom,
    game_id: str,
    include_link: bool = False,
    system: str | None = None,
) -> bool:
    if room.get("link_started") or len(room["players"]) >= room["max_players"]:
        return False
    if str(room["game_id"]) == str(game_id):
        return True
    cartridge = room.get("link_cartridge")
    if include_link and cartridge:
        return cartridge["system"] == system
    linked = _link_roms(room["game_id"]) if include_link else None
    return linked is not None and str(linked[1]) == str(game_id)


class RoomsResponse(TypedDict):
    room_name: str
    current: int
    max: int
    player_name: str
    hasPassword: bool
    link_roms: NotRequired[tuple[int, int]]
    link_host_rom: NotRequired[int]
    link_game_name: NotRequired[str]
    link_manual_start: NotRequired[bool]


@protected_route(router.get, "/list", [Scope.ROMS_READ])
async def get_rooms(
    request: Request, game_id: str, include_link: bool = False
) -> dict[str, RoomsResponse]:
    linked = _link_roms(game_id)
    rom_ids: tuple[int, ...]
    if linked:
        rom_ids = linked
    elif game_id.isascii() and game_id.isdecimal() and len(game_id) <= 16:
        rom_ids = (int(game_id),)
    else:
        raise HTTPException(status_code=422, detail="Invalid game id")
    for rom_id in rom_ids:
        rom = db_rom_handler.get_rom_visibility(rom_id)
        if not rom:
            raise RomNotFoundInDatabaseException(rom_id)
        assert_rom_visible(request, rom)
    if not can_access(get_permissions(request), PermEntity.EMULATION, PermAction.READ):
        return {}

    netplay_rooms = await netplay_handler.get_all()
    cartridge = (
        get_link_cartridge(int(game_id))
        if include_link
        and len(game_id) <= 16
        and game_id.isascii()
        and game_id.isdecimal()
        else None
    )

    open_rooms: dict[str, RoomsResponse] = {
        session_id: RoomsResponse(
            room_name=room["room_name"],
            current=len(room["players"]),
            max=room["max_players"],
            player_name=_get_owner_player_name(room),
            hasPassword=bool(room["password"]),
        )
        for session_id, room in netplay_rooms.items()
        if _is_room_open(
            room, game_id, include_link, cartridge["system"] if cartridge else None
        )
    }

    if include_link:
        for session_id, response in open_rooms.items():
            if host := netplay_rooms[session_id].get("link_cartridge"):
                response["link_host_rom"] = host["id"]
                response["link_game_name"] = host["name"]
                response["link_manual_start"] = host["system"] == "gba"
            if linked := _link_roms(netplay_rooms[session_id]["game_id"]):
                response["link_roms"] = linked

    return open_rooms
