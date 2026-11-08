from typing import Any, NotRequired, TypedDict

from fastapi import Header, HTTPException, Query, Request, Response
from starlette.responses import FileResponse

from decorators.auth import protected_route
from endpoints.responses.netplay_bridge import (
    BridgeAdminContextResponse,
    BridgeAdminResponse,
    BridgeConfigResponse,
    BridgeConnectionResponse,
    BridgeControlRequest,
    BridgeJoinRequest,
    BridgeNativeRequest,
    BridgeNativeResponse,
    BridgeNativeSaveRequest,
    BridgeNativeSeatRequest,
    BridgeNativeTicketResponse,
    BridgeNativeTicketStatus,
    BridgeNetworkSettings,
    BridgeRoomRequest,
    BridgeRoomResponse,
    BridgeRuntimeSettings,
)
from exceptions.endpoint_exceptions import RomNotFoundInDatabaseException
from handler import netplay_admin_handler as bridge_admin
from handler import netplay_launch_handler as native_launch
from handler import netplay_save_handler as server_saves
from handler.auth.constants import Scope
from handler.auth.dependencies import assert_rom_visible, can_access, get_permissions
from handler.auth.permissions import resolve_permissions
from handler.database import db_rom_handler, db_user_handler
from handler.netplay_bridge_handler import (
    bridge_connection,
    bridge_enabled,
    bridge_request,
    bridge_room,
    bridge_rooms,
    bridge_system,
)
from handler.netplay_handler import NetplayRoom, get_link_cartridge, netplay_handler
from models.permission import PermAction, PermEntity
from models.user import Role
from utils.router import APIRouter

router = APIRouter(
    prefix="/netplay",
    tags=["netplay"],
)


DEFAULT_MAX_PLAYERS = 4


def _assert_bridge_admin(request: Request, response: Response) -> None:
    if request.user.role != Role.ADMIN:
        raise HTTPException(
            status_code=403, detail="Only RomM administrators can manage the relay"
        )
    response.headers["Cache-Control"] = "no-store"


@protected_route(
    router.get,
    "/bridge/admin/ui/{asset:path}",
    [Scope.LOGS_READ],
    response_class=Response,
    include_in_schema=False,
)
async def get_bridge_admin_ui(
    request: Request, response: Response, asset: str
) -> Response:
    _assert_bridge_admin(request, response)
    content, media_type = await bridge_admin.ui_asset(asset or "index.html")
    return Response(
        content=content,
        media_type=media_type,
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": (
                "default-src 'none'; script-src 'self'; style-src 'self'; "
                "connect-src 'self'; base-uri 'none'; frame-ancestors 'self'; "
                "form-action 'self'"
            ),
        },
    )


@protected_route(router.get, "/bridge/admin/context", [Scope.LOGS_READ])
async def get_bridge_admin_context(
    request: Request, response: Response
) -> BridgeAdminContextResponse:
    _assert_bridge_admin(request, response)
    return BridgeAdminContextResponse(
        application_name="RomM",
        application_url="/",
        csrf_cookie="romm_csrftoken",
        csrf_header="x-csrftoken",
    )


@protected_route(router.get, "/bridge/admin", [Scope.LOGS_READ])
async def get_bridge_admin(request: Request, response: Response) -> BridgeAdminResponse:
    _assert_bridge_admin(request, response)
    return await bridge_admin.overview(request.user.username)


@protected_route(router.put, "/bridge/admin/settings", [Scope.USERS_WRITE])
async def update_bridge_settings(
    request: Request, response: Response, body: BridgeRuntimeSettings
) -> dict[str, Any]:
    _assert_bridge_admin(request, response)
    return await bridge_admin.update_runtime(body)


@protected_route(router.put, "/bridge/admin/network", [Scope.USERS_WRITE])
async def update_bridge_network(
    request: Request, response: Response, body: BridgeNetworkSettings
) -> BridgeNetworkSettings:
    _assert_bridge_admin(request, response)
    return bridge_admin.update_network(body)


@protected_route(router.get, "/bridge/admin/logs", [Scope.LOGS_READ])
async def get_bridge_logs(
    request: Request, response: Response, after: int = Query(default=0, ge=0)
) -> dict[str, Any]:
    _assert_bridge_admin(request, response)
    return await bridge_admin.logs(after)


@protected_route(router.post, "/bridge/admin/saves/sync", [Scope.TASKS_RUN])
async def sync_bridge_saves(request: Request, response: Response) -> dict[str, int]:
    _assert_bridge_admin(request, response)
    return await server_saves.sync_pending()


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


def _assert_bridge_rom(request: Request, rom_id: int) -> str:
    rom = db_rom_handler.get_rom_visibility(rom_id)
    if not rom:
        raise RomNotFoundInDatabaseException(rom_id)
    assert_rom_visible(request, rom)
    if not can_access(get_permissions(request), PermEntity.EMULATION, PermAction.READ):
        raise HTTPException(status_code=403, detail="Emulation permission required")
    system = bridge_system(rom_id)
    if not system:
        raise HTTPException(
            status_code=422, detail="Netplay relay supports GB, GBC, GBA and SNES"
        )
    return system


def _room_roms(room: dict[str, Any]) -> list[int]:
    return list(
        {
            room["romId"],
            *[rom["romId"] for rom in room.get("cartridges") or []],
            *[
                member["romId"]
                for member in room.get("members", [])
                if member.get("romId")
            ],
        }
    )


def _assert_room_access(request: Request, room: dict[str, Any], rom_id: int) -> None:
    collecting = room.get("collectCartridges")
    if (collecting and _assert_bridge_rom(request, rom_id) != room["system"]) or (
        not collecting and rom_id not in _room_roms(room)
    ):
        raise HTTPException(status_code=404, detail="Netplay room not found")
    for member_rom in set(_room_roms(room)):
        _assert_bridge_rom(request, member_rom)


def _assert_selected_cartridge(
    request: Request, room: dict[str, Any], body: BridgeJoinRequest
) -> None:
    if not room.get("collectCartridges"):
        return
    if body.cartridge is None:
        raise HTTPException(
            status_code=422, detail="The selected cartridge is required"
        )
    selected = db_rom_handler.get_rom_visibility(body.rom_id)
    owners = {
        room.get("owner"),
        *[member.get("owner") for member in room.get("members", [])],
    }
    for owner in owners - {None, "", str(request.user.id)}:
        user = db_user_handler.get_user(int(owner))
        if (
            not user
            or not selected
            or not resolve_permissions(user).can_see_rom(selected)
        ):
            raise HTTPException(
                status_code=409,
                detail="This cartridge is not available to everyone in the room",
            )


def _room_visible(request: Request, room: dict[str, Any], rom_id: int) -> bool:
    try:
        _assert_room_access(request, room, rom_id)
    except (HTTPException, RomNotFoundInDatabaseException):
        return False
    return True


@protected_route(router.get, "/bridge/config", [Scope.ROMS_READ])
async def get_bridge_config(request: Request) -> BridgeConfigResponse:
    return BridgeConfigResponse(
        enabled=bridge_enabled()
        and can_access(get_permissions(request), PermEntity.EMULATION, PermAction.READ)
    )


@protected_route(router.get, "/bridge/rooms", [Scope.ROMS_READ])
async def get_bridge_rooms(
    request: Request, rom_id: int = Query(gt=0)
) -> list[BridgeRoomResponse]:
    _assert_bridge_rom(request, rom_id)
    try:
        return [
            BridgeRoomResponse(
                id=room["id"],
                rom_id=rom_id,
                players=room["players"],
                current=room["current"],
                started=room["started"],
                native_allowed=room["nativeAllowed"],
                core_name=room["coreName"],
                core_version=room["coreVersion"],
                state_size=room["stateSize"],
                content_crc=room["contentCrc"],
                has_password=room["hasPassword"],
                native_calibration=room.get("nativeCalibration"),
                max_prediction=room.get("maxPrediction", 0),
                cartridges=room.get("cartridges"),
                native_auth=room.get("nativeAuth", False),
                collect_cartridges=room.get("collectCartridges", False),
                content_prepared=room.get("contentPrepared", True),
                members=room.get("members", []),
                seats=room.get("seats", []),
                generation=room.get("generation", 0),
                host=room.get("host", 0),
                running=room.get("running", False),
                starting=room.get("starting", False),
                can_start=room.get("canStart", False),
                native_authority=room.get("nativeAuthority", False),
                disconnect_policy=room.get("disconnectPolicy", "continue"),
                waiting_for_players=room.get("waitingForPlayers", []),
                save_host=room.get("saveHost"),
                requires_new_game=room.get("requiresNewGame", False),
                saves=room.get("saves", {}),
            )
            for room in await bridge_rooms()
            if _room_visible(request, room, rom_id)
        ]
    except (KeyError, TypeError, ValueError) as error:
        raise HTTPException(
            status_code=502, detail="Invalid netplay room response"
        ) from error


@protected_route(router.post, "/bridge/rooms", [Scope.ROMS_READ])
async def create_bridge_room(
    request: Request, body: BridgeRoomRequest
) -> BridgeConnectionResponse:
    system = _assert_bridge_rom(request, body.rom_id)
    if body.system != system:
        raise HTTPException(
            status_code=422, detail="Core does not match the selected ROM"
        )
    for cartridge in body.cartridges or []:
        if _assert_bridge_rom(request, cartridge.romId) != system:
            raise HTTPException(
                status_code=422, detail="All cartridges must use the room's system"
            )
    payload = body.model_dump(exclude={"rom_id"}, exclude_none=True)
    payload.update(
        romId=body.rom_id,
        owner=str(request.user.id),
        nickname=body.nickname or request.user.username,
        password=body.password or "",
        manualStart=True,
        nativeAuth=body.nativeAllowed and body.cartridges is not None,
        nativeAuthority=body.nativeAllowed
        and body.cartridges is not None
        and body.maxPrediction > 0,
        saveAllowed=Scope.ASSETS_WRITE in request.auth.scopes,
    )
    value = await bridge_request("POST", "", payload)
    if payload["saveAllowed"]:
        server_saves.register_owner(
            value["id"],
            0,
            str(request.user.id),
            body.rom_id,
            native_launch.CORE_IDS[body.coreName],
        )
    return bridge_connection(value)


@protected_route(router.post, "/bridge/rooms/{room_id}/join", [Scope.ROMS_READ])
async def join_bridge_room(
    request: Request, room_id: str, body: BridgeJoinRequest
) -> BridgeConnectionResponse:
    _assert_bridge_rom(request, body.rom_id)
    room = await bridge_room(room_id)
    _assert_room_access(request, room, body.rom_id)
    _assert_selected_cartridge(request, room, body)
    value = await bridge_request(
        "POST",
        f"/{room_id}/join",
        {
            "owner": str(request.user.id),
            "nickname": body.nickname or request.user.username,
            "password": body.password,
            "romId": body.rom_id,
            "saveAllowed": Scope.ASSETS_WRITE in request.auth.scopes,
            **({"cartridge": body.cartridge.model_dump()} if body.cartridge else {}),
        },
    )
    if Scope.ASSETS_WRITE in request.auth.scopes:
        server_saves.register_owner(
            room_id,
            value["player"],
            str(request.user.id),
            body.rom_id,
            native_launch.CORE_IDS[room["coreName"]],
        )
    return bridge_connection(value)


@protected_route(
    router.post, "/bridge/rooms/{room_id}/saves/sync", [Scope.ASSETS_WRITE]
)
async def sync_room_saves(request: Request, room_id: str) -> dict[str, int]:
    room = await bridge_room(room_id)
    if not any(
        member.get("owner") == str(request.user.id)
        for member in room.get("members", [])
    ):
        raise HTTPException(
            status_code=403, detail="Join the room before synchronizing saves"
        )
    return await server_saves.sync_pending(room_id)


@protected_route(
    router.post, "/bridge/rooms/{room_id}/native", [Scope.ROMS_READ, Scope.ASSETS_WRITE]
)
async def prepare_native_room(
    request: Request, room_id: str, body: BridgeNativeRequest
) -> BridgeNativeResponse:
    room = await bridge_room(room_id)
    _assert_room_access(request, room, body.rom_id)
    _assert_selected_cartridge(request, room, body)
    return await native_launch.prepare(request, room, body)


@protected_route(router.delete, "/bridge/rooms/{room_id}/membership", [Scope.ROMS_READ])
async def leave_bridge_room(request: Request, room_id: str) -> Response:
    try:
        await bridge_room(room_id)
        await bridge_request(
            "POST", f"/{room_id}/leave", {"owner": str(request.user.id)}
        )
    except HTTPException as error:
        if error.status_code != 404:
            raise
    return Response(status_code=204)


@protected_route(router.get, "/bridge/native/launcher", [Scope.ROMS_READ])
async def download_native_launcher(request: Request) -> Response:
    if not bridge_enabled():
        raise HTTPException(status_code=404, detail="Netplay relay is not configured")
    return Response(
        native_launch.launcher_package(request),
        media_type="application/zip",
        headers={
            "Content-Disposition": 'attachment; filename="RomM-Windows-launcher.zip"',
            "Cache-Control": "no-store",
        },
    )


@protected_route(
    router.post,
    "/bridge/rooms/{room_id}/native/ticket",
    [Scope.ROMS_READ, Scope.ASSETS_WRITE],
)
async def create_native_ticket(
    request: Request, response: Response, room_id: str, body: BridgeNativeRequest
) -> BridgeNativeTicketResponse:
    room = await bridge_room(room_id)
    _assert_room_access(request, room, body.rom_id)
    _assert_selected_cartridge(request, room, body)
    response.headers["Cache-Control"] = "no-store"
    return native_launch.create_ticket(request, room, body)


@protected_route(router.get, "/bridge/rooms/{room_id}/native/ticket", [Scope.ROMS_READ])
async def get_native_ticket(
    request: Request,
    response: Response,
    room_id: str,
    x_netplay_launch: str = Header(default=""),
) -> BridgeNativeTicketStatus:
    response.headers["Cache-Control"] = "no-store"
    return native_launch.ticket_status(request, room_id, x_netplay_launch)


@router.post("/bridge/rooms/{room_id}/native/claim")
async def claim_native_ticket(
    request: Request,
    response: Response,
    room_id: str,
    x_netplay_launch: str = Header(default=""),
) -> dict[str, Any]:
    metadata = native_launch.claim_ticket(room_id, x_netplay_launch)
    try:
        user = db_user_handler.get_user(metadata["owner"])
        if (
            not user
            or not user.enabled
            or not {Scope.ROMS_READ, Scope.ASSETS_WRITE}.issubset(user.oauth_scopes)
        ):
            raise HTTPException(
                status_code=403,
                detail="This account can no longer prepare a Windows session",
            )
        owner_request = Request({**request.scope, "user": user, "state": {}})
        body = BridgeNativeRequest.model_validate(metadata["body"])
        room = await bridge_room(room_id)
        _assert_room_access(owner_request, room, body.rom_id)
        _assert_selected_cartridge(owner_request, room, body)
        if not any(
            member["player"] == metadata["player"]
            and member.get("owner") == str(user.id)
            and member["kind"] == "web"
            for member in room.get("members", [])
        ):
            raise HTTPException(
                status_code=409,
                detail="Your browser has left this room. Join it again before opening RetroArch.",
            )
        session = await native_launch.prepare(owner_request, room, body)
    except Exception as error:
        native_launch.finish_ticket(
            x_netplay_launch,
            metadata,
            error=(
                str(error.detail)
                if isinstance(error, HTTPException)
                else "Could not prepare Windows RetroArch. Try opening it again from the room."
            ),
        )
        raise
    native_launch.finish_ticket(x_netplay_launch, metadata, session=session)
    response.headers["Cache-Control"] = "no-store"
    return await native_launch.session_manifest(request, room_id, session.credential)


@router.get("/bridge/rooms/{room_id}/native/package")
async def native_room_package(
    request: Request, room_id: str, x_netplay_launch: str = Header(default="")
) -> Response:
    content = await native_launch.package(request, room_id, x_netplay_launch)
    return Response(
        content,
        media_type="application/zip",
        headers={
            "Content-Disposition": 'attachment; filename="RomM-Windows-room.zip"',
            "Cache-Control": "no-store",
        },
    )


@router.get("/bridge/rooms/{room_id}/native/content/{slot}")
async def native_room_content(
    room_id: str, slot: int, x_netplay_launch: str = Header(default="")
) -> FileResponse:
    path = await native_launch.content_path(room_id, x_netplay_launch, slot)
    return FileResponse(
        path,
        media_type="application/octet-stream",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/bridge/rooms/{room_id}/native/manifest")
async def native_room_manifest(
    request: Request,
    response: Response,
    room_id: str,
    x_netplay_launch: str = Header(default=""),
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    return await native_launch.session_manifest(request, room_id, x_netplay_launch)


@protected_route(router.post, "/bridge/rooms/{room_id}/control", [Scope.ROMS_READ])
async def control_bridge_room(
    request: Request, room_id: str, body: BridgeControlRequest
) -> dict[str, Any]:
    room = await bridge_room(room_id)
    member = next(
        (
            item
            for item in room.get("members", [])
            if item.get("owner") == str(request.user.id)
        ),
        None,
    )
    if not member:
        raise HTTPException(
            status_code=403, detail="Join the room before controlling it"
        )
    _assert_room_access(request, room, member.get("romId") or room["romId"])
    return dict(
        await bridge_request(
            "POST",
            f"/{room_id}/control",
            {
                "owner": str(request.user.id),
                "t": "start-request" if body.action == "start" else body.action,
                **(
                    {"disconnectPolicy": body.disconnectPolicy}
                    if body.disconnectPolicy is not None
                    else {}
                ),
                "player": body.player,
                "seat": body.seat,
            },
        )
    )


@protected_route(router.patch, "/bridge/rooms/{room_id}/native/seat", [Scope.ROMS_READ])
async def assign_native_seat(
    request: Request,
    room_id: str,
    body: BridgeNativeSeatRequest,
    x_netplay_launch: str = Header(default=""),
) -> dict[str, Any]:
    reservation = await native_launch.reservation(room_id, x_netplay_launch)
    if reservation["owner"] != str(request.user.id):
        raise HTTPException(
            status_code=403, detail="You can only change your own player number"
        )
    return dict(
        await bridge_request(
            "PATCH", f"/{room_id}/native/{x_netplay_launch}", {"seat": body.seat}
        )
    )


@protected_route(router.delete, "/bridge/rooms/{room_id}/native", [Scope.ROMS_READ])
async def cancel_native_preparation(
    request: Request, room_id: str, x_netplay_launch: str = Header(default="")
) -> Response:
    reservation = await native_launch.reservation(room_id, x_netplay_launch)
    if reservation["owner"] != str(request.user.id):
        raise HTTPException(
            status_code=403, detail="This preparation belongs to another account"
        )
    await bridge_request("DELETE", f"/{room_id}/native/{x_netplay_launch}")
    return Response(status_code=204)


@protected_route(
    router.post, "/bridge/rooms/{room_id}/native/saves", [Scope.ASSETS_WRITE]
)
async def sync_native_save(
    request: Request, room_id: str, body: BridgeNativeSaveRequest
) -> dict[str, Any]:
    room = await bridge_room(room_id)
    save_owner = next(
        (
            member.get("owner")
            for member in room.get("members", [])
            if member["player"] == room.get("saveHost")
        ),
        room.get("owner"),
    )
    if save_owner != str(request.user.id):
        raise HTTPException(
            status_code=403,
            detail="Only the room's web save source can synchronize native saves",
        )
    return await native_launch.save_progress(room, body)


@protected_route(router.delete, "/bridge/rooms/{room_id}", [Scope.ROMS_READ])
async def delete_bridge_room(
    request: Request, room_id: str, rom_id: int = Query(gt=0)
) -> Response:
    _assert_bridge_rom(request, rom_id)
    room = await bridge_room(room_id)
    if room.get("romId") != rom_id:
        raise HTTPException(status_code=404, detail="Netplay room not found")
    if room.get("owner") != str(request.user.id):
        raise HTTPException(status_code=403, detail="Only the room owner can close it")
    await bridge_request("DELETE", f"/{room_id}")
    return Response(status_code=204)
