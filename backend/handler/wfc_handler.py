import asyncio
import base64
import binascii
import json
import os
import secrets
import tempfile
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from fastapi import HTTPException

from config import (
    ASSETS_BASE_PATH,
    NETPLAY_BRIDGE_PUBLIC_HOST,
    NETPLAY_BRIDGE_PUBLIC_URL,
)
from endpoints.responses.wfc import WfcProfileResponse, WfcSessionResponse
from handler.netplay_bridge_handler import bridge_request
from handler.netplay_settings_handler import public_addresses


def _profile_path(user_id: int) -> Path:
    directory = Path(ASSETS_BASE_PATH) / "wfc" / str(user_id)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    return directory / "console.json"


def _load_profile(user_id: int) -> WfcProfileResponse:
    path = _profile_path(user_id)
    if not path.exists():
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, delete=False
        ) as file:
            temporary = Path(file.name)
            try:
                json.dump(
                    {"mac": "0209bf" + secrets.token_hex(3), "firmware": ""}, file
                )
                file.flush()
                os.fsync(file.fileno())
                try:
                    os.link(temporary, path)
                except FileExistsError:
                    pass
            finally:
                temporary.unlink(missing_ok=True)
    return WfcProfileResponse.model_validate_json(path.read_text(encoding="utf-8"))


async def profile(user_id: int) -> WfcProfileResponse:
    return await asyncio.to_thread(_load_profile, user_id)


def _save_settings(user_id: int, mac: str, firmware: str) -> None:
    data = _load_profile(user_id)
    if data.mac != mac:
        raise HTTPException(status_code=409, detail="WFC account changed")
    path = _profile_path(user_id)
    data.firmware = firmware
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, delete=False
    ) as file:
        temporary = Path(file.name)
        try:
            file.write(data.model_dump_json())
            file.flush()
            os.fsync(file.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


async def save_settings(user_id: int, mac: str, firmware: str) -> None:
    try:
        decoded = base64.b64decode(firmware, validate=True)
    except (ValueError, binascii.Error) as error:
        raise HTTPException(status_code=422, detail="Invalid WFC settings") from error
    if not 1 <= len(decoded) <= 4096:
        raise HTTPException(status_code=422, detail="Invalid WFC settings size")
    await asyncio.to_thread(_save_settings, user_id, mac, firmware)


async def create_session(user_id: int) -> WfcSessionResponse:
    console = await profile(user_id)
    try:
        session = await bridge_request("POST", "/wfc/sessions", {"owner": str(user_id)})
    except HTTPException as error:
        messages = {
            409: "Close the other WFC game for this account before starting another.",
            429: "The WFC gateway is full. Try again later.",
        }
        raise HTTPException(
            status_code=error.status_code,
            detail=messages.get(error.status_code, "WFC gateway is unavailable"),
        ) from error
    path = urlsplit(session.get("path", ""))
    if (
        path.scheme
        or path.netloc
        or path.fragment
        or path.path != "/v1/rooms/wfc/connect"
    ):
        raise HTTPException(status_code=502, detail="Invalid WFC connection response")
    public, _ = public_addresses(NETPLAY_BRIDGE_PUBLIC_URL, NETPLAY_BRIDGE_PUBLIC_HOST)
    address = urlsplit(public.rstrip("/"))
    return WfcSessionResponse(
        websocket_url=urlunsplit(
            (
                "wss" if address.scheme == "https" else "ws",
                address.netloc,
                address.path + path.path,
                path.query,
                "",
            )
        ),
        profile=console,
    )
