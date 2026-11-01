import json
import re
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import aiohttp
from fastapi import HTTPException

from config import (
    NETPLAY_BRIDGE_PUBLIC_HOST,
    NETPLAY_BRIDGE_PUBLIC_URL,
    NETPLAY_BRIDGE_TOKEN,
    NETPLAY_BRIDGE_URL,
)
from endpoints.responses.netplay_bridge import (
    BRIDGE_CORE_NAMES,
    BridgeConnectionResponse,
)
from handler.database import db_rom_handler
from utils.context import ctx_aiohttp_session

ROOM_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def bridge_system(rom_id: int) -> str | None:
    rom = db_rom_handler.get_rom(rom_id)
    if not rom:
        return None
    system = "gb" if rom.platform_slug == "gbc" else rom.platform_slug
    return system if system in BRIDGE_CORE_NAMES else None


def bridge_enabled() -> bool:
    if not NETPLAY_BRIDGE_TOKEN:
        return False
    for value in (NETPLAY_BRIDGE_URL, NETPLAY_BRIDGE_PUBLIC_URL):
        try:
            url = urlsplit(value)
            if (
                url.scheme not in ("http", "https")
                or not url.hostname
                or url.username
                or url.password
                or url.query
                or url.fragment
            ):
                return False
            _ = url.port
        except ValueError:
            return False
    return True


async def bridge_request(
    method: str, path: str, payload: dict[str, Any] | None = None
) -> Any:
    if not bridge_enabled():
        raise HTTPException(status_code=404, detail="Netplay relay is not configured")
    try:
        # Only the administrator-configured service receives this credential.
        async with ctx_aiohttp_session.get().request(
            method,
            f"{NETPLAY_BRIDGE_URL.rstrip('/')}/v1/rooms{path}",
            json=payload,
            headers={"Authorization": f"Bearer {NETPLAY_BRIDGE_TOKEN}"},
            timeout=aiohttp.ClientTimeout(total=10),
            allow_redirects=False,
        ) as response:
            if response.status in (403, 404, 409, 429):
                detail = {
                    403: "Incorrect room password. Enter the room password shown by the host.",
                    404: "The room has closed. Refresh the room list and join a new room.",
                    409: "The room is full or has already started. Refresh the room list.",
                    429: "Too many room requests. Please try again shortly.",
                }[response.status]
                if response.status == 409:
                    try:
                        error = json.loads(await response.content.read(4096)).get(
                            "error"
                        )
                    except (ValueError, TypeError, AttributeError):
                        error = None
                    detail = {
                        "Owner already hosts a room": "You already host a room. Leave or close that room first.",
                        "No native ports available": "No RetroArch room ports are available. Try a web-only room.",
                        "Room capacity reached": "The relay has no free rooms. Please try again later.",
                    }.get(error if isinstance(error, str) else "", detail)
                raise HTTPException(
                    status_code=response.status,
                    detail=detail,
                )
            if response.status < 200 or response.status >= 300:
                raise HTTPException(
                    status_code=502, detail="Netplay relay rejected the request"
                )
            if response.status == 204:
                return None
            body = bytearray()
            async for chunk in response.content.iter_chunked(64 * 1024):
                body.extend(chunk)
                if len(body) > 256 * 1024:
                    raise ValueError("Oversized relay response")
            return json.loads(body)
    except (TimeoutError, aiohttp.ClientError, ValueError) as error:
        raise HTTPException(
            status_code=502, detail="Netplay relay is unavailable"
        ) from error


async def bridge_rooms() -> list[dict[str, Any]]:
    value = await bridge_request("GET", "")
    if not isinstance(value, list) or not all(isinstance(room, dict) for room in value):
        raise HTTPException(status_code=502, detail="Invalid netplay room response")
    return value


async def bridge_room(room_id: str) -> dict[str, Any]:
    if not ROOM_ID.fullmatch(room_id):
        raise HTTPException(status_code=404, detail="Netplay room not found")
    for room in await bridge_rooms():
        if room.get("id") == room_id:
            return room
    raise HTTPException(status_code=404, detail="Netplay room not found")


def bridge_connection(value: Any, *, player: int = 0) -> BridgeConnectionResponse:
    try:
        if not isinstance(value, dict):
            raise TypeError("Invalid room connection")
        room_id = value["id"]
        path = value.get("hostPath") or value["peerPath"]
        if not isinstance(path, str):
            raise TypeError("Invalid room path")
        path_url = urlsplit(path)
        if (
            not isinstance(room_id, str)
            or not ROOM_ID.fullmatch(room_id)
            or path_url.scheme
            or path_url.netloc
            or path_url.fragment
            or path_url.path
            not in (
                f"/v1/rooms/{room_id}/host",
                f"/v1/rooms/{room_id}/peer",
            )
        ):
            raise ValueError("Invalid room path")
        public = urlsplit(NETPLAY_BRIDGE_PUBLIC_URL.rstrip("/"))
        websocket_url = urlunsplit(
            (
                "wss" if public.scheme == "https" else "ws",
                public.netloc,
                public.path + path_url.path,
                path_url.query,
                "",
            )
        )
        return BridgeConnectionResponse(
            id=room_id,
            websocket_url=websocket_url,
            native_host=NETPLAY_BRIDGE_PUBLIC_HOST or public.hostname or "",
            native_port=value["tcpPort"],
            password=value.get("password", ""),
            players=value["players"],
            player=value.get("player", player),
        )
    except (KeyError, TypeError, ValueError) as error:
        raise HTTPException(
            status_code=502, detail="Invalid netplay connection response"
        ) from error
