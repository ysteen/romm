from typing import Any, NotRequired, TypedDict

from endpoints.netplay import DEFAULT_MAX_PLAYERS
from handler.netplay_handler import (
    NetplayPlayerInfo,
    NetplayRoom,
    get_link_cartridge,
    netplay_handler,
)
from handler.socket_handler import netplay_socket_handler


class RoomDataExtra(TypedDict):
    sessionid: str | None
    userid: str | None
    playerId: str | None
    room_name: NotRequired[str]
    game_id: NotRequired[str]
    domain: NotRequired[str]
    player_name: NotRequired[str]
    room_password: NotRequired[str]
    cartridge_id: NotRequired[int]


class RoomData(TypedDict):
    extra: RoomDataExtra
    maxPlayers: NotRequired[int]


@netplay_socket_handler.socket_server.on("open-room")
async def open_room(sid: str, data: RoomData):
    extra_data = data["extra"]

    session_id = extra_data.get("sessionid")
    player_id = extra_data.get("userid") or extra_data.get("playerId")

    if not session_id or not player_id:
        return "Invalid data: sessionId and playerId required"

    async with netplay_handler.lock(session_id):
        if await netplay_handler.get(session_id):
            return "Room already exists"

        cartridge = get_link_cartridge(extra_data.get("cartridge_id"))
        if "cartridge_id" in extra_data and not cartridge:
            return "Unsupported link cartridge"
        if (
            str(extra_data.get("game_id", "")).startswith("link:auto:")
            and not cartridge
        ):
            return "Link cartridge required"
        capacity = data.get("maxPlayers", 2)
        if cartridge and (
            type(capacity) is not int
            or not 2 <= capacity <= (4 if cartridge["system"] == "gba" else 2)
        ):
            return "Unsupported link player count"

        new_room = NetplayRoom(
            owner=sid,
            players={
                player_id: NetplayPlayerInfo(
                    socketId=sid,
                    player_name=extra_data.get("player_name") or f"Player {player_id}",
                    userid=extra_data.get("userid"),
                    playerId=extra_data.get("playerId"),
                )
            },
            peers=[],
            room_name=extra_data.get("room_name") or f"Room {session_id}",
            game_id=extra_data.get("game_id") or "default",
            domain=extra_data.get("domain", None),
            password=extra_data.get("room_password", None),
            max_players=data.get("maxPlayers") or DEFAULT_MAX_PLAYERS,
        )
        if cartridge:
            new_room["link_cartridge"] = cartridge
            new_room["max_players"] = capacity
            new_room["link_started"] = False
            new_room["game_id"] = f"link:auto:{cartridge['id']}"
            new_room["players"][player_id]["cartridge"] = cartridge
            new_room["players"][player_id]["link_ready"] = False
            new_room["players"][player_id]["is_host"] = True
        await netplay_handler.set(session_id, new_room)

        await netplay_socket_handler.socket_server.enter_room(sid, session_id)
        await netplay_socket_handler.socket_server.save_session(
            sid,
            {
                "session_id": session_id,
                "player_id": player_id,
            },
        )
        await netplay_socket_handler.socket_server.emit(
            "users-updated", new_room["players"], room=session_id
        )


@netplay_socket_handler.socket_server.on("join-room")
async def join_room(sid: str, data: RoomData):
    extra_data = data["extra"]

    session_id = extra_data.get("sessionid")
    player_id = extra_data.get("userid") or extra_data.get("playerId")

    if not session_id or not player_id:
        return "Invalid data: sessionId and playerId required"

    async with netplay_handler.lock(session_id):
        current_room = await netplay_handler.get(session_id)
        if not current_room:
            return "Room not found"
        if current_room.get("link_started"):
            return "This link game has already started"
        if player_id in current_room["players"]:
            return "Player already joined"

        if current_room["password"] and current_room["password"] != extra_data.get(
            "room_password"
        ):
            return "Incorrect password"

        if len(current_room["players"].keys()) >= current_room["max_players"]:
            return "Room is full"

        host_cartridge = current_room.get("link_cartridge")
        cartridge = get_link_cartridge(extra_data.get("cartridge_id"))
        if host_cartridge and (
            not cartridge or cartridge["system"] != host_cartridge["system"]
        ):
            return "Incompatible link cartridge"

        current_room["players"][player_id] = NetplayPlayerInfo(
            socketId=sid,
            player_name=extra_data.get("player_name") or f"Player {player_id}",
            userid=extra_data.get("userid"),
            playerId=extra_data.get("playerId"),
        )
        if host_cartridge and cartridge:
            current_room["players"][player_id]["cartridge"] = cartridge
            current_room["players"][player_id]["link_ready"] = False
            current_room["players"][player_id]["is_host"] = False
        await netplay_handler.set(session_id, current_room)

        await netplay_socket_handler.socket_server.enter_room(sid, session_id)
        await netplay_socket_handler.socket_server.save_session(
            sid,
            {
                "session_id": session_id,
                "player_id": player_id,
            },
        )
        await netplay_socket_handler.socket_server.emit(
            "users-updated", current_room["players"], room=session_id
        )

        return None, current_room["players"]


@netplay_socket_handler.socket_server.on("link-ready")
async def link_ready(sid: str):
    stored_session = await netplay_socket_handler.socket_server.get_session(sid)
    session_id = stored_session.get("session_id")
    player_id = stored_session.get("player_id")
    if not session_id:
        return "Link room not found"
    async with netplay_handler.lock(session_id):
        room = await netplay_handler.get(session_id) if session_id else None
        player = room["players"].get(player_id) if room and player_id else None
        if (
            not room
            or not room.get("link_cartridge")
            or not player
            or player["socketId"] != sid
            or (
                room["link_cartridge"]["system"] == "gba"
                and not room.get("link_started")
            )
        ):
            return "Link room not found"
        player["link_ready"] = True
        await netplay_handler.set(session_id, room)
        await netplay_socket_handler.socket_server.emit(
            "users-updated", room["players"], room=session_id
        )


class LinkSeatData(TypedDict):
    slot: int | None
    player_id: NotRequired[str]


@netplay_socket_handler.socket_server.on("link-seat")
async def link_seat(sid: str, data: LinkSeatData):
    stored_session = await netplay_socket_handler.socket_server.get_session(sid)
    session_id = stored_session.get("session_id")
    player_id = stored_session.get("player_id")
    if not session_id:
        return "Link room not found"
    async with netplay_handler.lock(session_id):
        room = await netplay_handler.get(session_id)
        player = room["players"].get(player_id) if room and player_id else None
        if (
            not room
            or not room.get("link_cartridge")
            or not player
            or player["socketId"] != sid
        ):
            return "Link room not found"
        if room.get("link_started"):
            return "This link game has already started"
        if room["link_cartridge"]["system"] != "gba":
            return "This room does not support choosing a player slot"
        target_id = data.get("player_id", player_id)
        if not isinstance(target_id, str):
            return "Player not found"
        if target_id != player_id and room["owner"] != sid:
            return "Only the host can change another player's slot"
        target = room["players"].get(target_id)
        if not target:
            return "Player not found"
        can_swap = room["owner"] == sid and "player_id" in data
        slot = data.get("slot")
        if slot is not None:
            if type(slot) is not int or not 0 <= slot < room["max_players"]:
                return "Invalid player slot"
            occupant = next(
                (
                    p
                    for p in room["players"].values()
                    if p is not target and p.get("link_slot") == slot
                ),
                None,
            )
            if occupant:
                if not can_swap:
                    return "This player slot is already taken"
                previous = target.get("link_slot")
                if previous is None:
                    occupant.pop("link_slot", None)
                else:
                    occupant["link_slot"] = previous
            target["link_slot"] = slot
        else:
            target.pop("link_slot", None)
        await netplay_handler.set(session_id, room)
        await netplay_socket_handler.socket_server.emit(
            "users-updated", room["players"], room=session_id
        )


@netplay_socket_handler.socket_server.on("link-start")
async def link_start(sid: str):
    stored_session = await netplay_socket_handler.socket_server.get_session(sid)
    session_id = stored_session.get("session_id")
    if not session_id:
        return "Link room not found"
    async with netplay_handler.lock(session_id):
        room = await netplay_handler.get(session_id)
        if not room or not room.get("link_cartridge"):
            return "Link room not found"
        if room["owner"] != sid:
            return "Only the host can start the game"
        if room.get("link_started"):
            return "This link game has already started"
        if not 2 <= len(room["players"]) <= room["max_players"]:
            return "At least two players are required"
        slots = [p.get("link_slot") for p in room["players"].values()]
        if any(type(slot) is not int for slot in slots) or set(slots) != set(
            range(len(slots))
        ):
            return "Choose player slots starting from 1P without gaps"
        room["players"] = dict(
            sorted(room["players"].items(), key=lambda item: item[1]["link_slot"])
        )
        room["link_started"] = True
        for player in room["players"].values():
            player["link_ready"] = False
        await netplay_handler.set(session_id, room)
        await netplay_socket_handler.socket_server.emit(
            "link-started", room["players"], room=session_id
        )


async def _handle_leave(sid: str, session_id: str, player_id: str):
    async with netplay_handler.lock(session_id):
        current_room = await netplay_handler.get(session_id)
        if not current_room:
            return

        current_room["players"].pop(player_id, None)

        if not current_room["players"]:
            await netplay_handler.delete([session_id])
            # Notify clients that the room is now empty
            await netplay_socket_handler.socket_server.emit(
                "users-updated", {}, room=session_id
            )
            return

        if sid == current_room["owner"]:
            # Owner left, assign a new one
            remaining_players = list(current_room["players"].values())
            if remaining_players:
                current_room["owner"] = remaining_players[0]["socketId"]

        if current_room.get("link_cartridge"):
            for player in current_room["players"].values():
                player["is_host"] = player["socketId"] == current_room["owner"]

        await netplay_handler.set(session_id, current_room)
        await netplay_socket_handler.socket_server.emit(
            "users-updated", current_room["players"], room=session_id
        )


@netplay_socket_handler.socket_server.on("leave-room")
async def leave_room(sid: str):
    stored_session = await netplay_socket_handler.socket_server.get_session(sid)
    session_id = stored_session.get("session_id")
    player_id = stored_session.get("player_id")

    if session_id and player_id:
        await _handle_leave(sid, session_id, player_id)
        await netplay_socket_handler.socket_server.leave_room(sid, session_id)


class WebRTCSignalData(TypedDict, total=False):
    target: str
    candidate: Any
    offer: Any
    answer: Any
    requestRenegotiate: bool


@netplay_socket_handler.socket_server.on("webrtc-signal")
async def webrtc_signal(sid: str, data: WebRTCSignalData):
    target = data.get("target")
    request_renegotiate = data.get("requestRenegotiate", False)

    if request_renegotiate:
        if not target:
            return
        await netplay_socket_handler.socket_server.emit(
            "webrtc-signal",
            {"sender": sid, "requestRenegotiate": True},
            to=target,
        )
    else:
        if not target:
            return  # drop message, no recipient
        await netplay_socket_handler.socket_server.emit(
            "webrtc-signal",
            {
                "sender": sid,
                "candidate": data.get("candidate"),
                "offer": data.get("offer"),
                "answer": data.get("answer"),
            },
            to=target,
        )


@netplay_socket_handler.socket_server.on("webrtc-signal-error")
async def webrtc_signal_error(_sid: str, _error: str, _data: Any):
    pass


@netplay_socket_handler.socket_server.on("disconnect")
async def disconnect(sid: str):
    stored_session = await netplay_socket_handler.socket_server.get_session(sid)
    session_id = stored_session.get("session_id")
    player_id = stored_session.get("player_id")

    if session_id and player_id:
        await _handle_leave(sid, session_id, player_id)


async def _broadcast_to_room(sid: str, event: str, data: Any):
    stored_session = await netplay_socket_handler.socket_server.get_session(sid)
    session_id = stored_session.get("session_id")
    if session_id:
        await netplay_socket_handler.socket_server.emit(
            event, data, room=session_id, skip_sid=sid
        )


@netplay_socket_handler.socket_server.on("data-message")
async def data_message(sid: str, data: Any):
    await _broadcast_to_room(sid, "data-message", data)


@netplay_socket_handler.socket_server.on("snapshot")
async def snapshot(sid: str, data: Any):
    await _broadcast_to_room(sid, "snapshot", data)


@netplay_socket_handler.socket_server.on("input")
async def input(sid: str, data: Any):
    await _broadcast_to_room(sid, "input", data)
