"""Prepare scoped native launches and persist host-confirmed cartridge saves."""

import base64
import binascii
import hashlib
import io
import json
import re
import secrets
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urljoin, urlsplit

from cryptography import x509
from cryptography.exceptions import InvalidSignature, UnsupportedAlgorithm
from cryptography.hazmat.primitives.serialization import Encoding
from fastapi import HTTPException, Request

from config import (
    NETPLAY_BRIDGE_CA_CERT_PATH,
    NETPLAY_BRIDGE_PUBLIC_HOST,
    NETPLAY_BRIDGE_PUBLIC_URL,
)
from endpoints.responses.netplay_bridge import (
    BridgeNativeRequest,
    BridgeNativeResponse,
    BridgeNativeSaveRequest,
    BridgeNativeTicketResponse,
    BridgeNativeTicketStatus,
)
from handler.asset_store import reserve_version_name
from handler.auth.dependencies import can_access
from handler.auth.permissions import resolve_permissions
from handler.database import db_rom_handler, db_save_handler, db_user_handler
from handler.filesystem import fs_asset_handler, fs_rom_handler
from handler.filesystem.assets_handler import hash_save_content
from handler.netplay_bridge_handler import ROOM_ID, bridge_request
from handler.netplay_settings_handler import public_addresses
from handler.redis_handler import redis_client
from handler.scan_handler import scan_save
from models.permission import PermAction, PermEntity
from utils.uploads import sanitize_asset_filename
from utils.zip_cache import ensure_zipfile_writable

CORE_IDS = {
    "SameBoy": "sameboy",
    "mGBA Splitscreen": "mgba_splitscreen",
    "Snes9x": "snes9x",
}
LAUNCH_LIFETIME = 15 * 60
TICKET_LIFETIME = 3 * 60
SAVE_GRANT_LIFETIME = 24 * 60 * 60
EJS_ROOTS = (
    Path("/var/www/html/assets/emulatorjs"),
    Path(__file__).resolve().parents[2] / "custom-emulatorjs",
)


def _root() -> Path:
    for root in EJS_ROOTS:
        if (root / "input-netplay/bridge-cores.json").is_file():
            return root
    raise HTTPException(status_code=503, detail="Native core catalog is unavailable")


def _launch_key(credential: str) -> str:
    return "netplay-native:" + hashlib.sha256(credential.encode()).hexdigest()


def _grant_key(room_id: str, player: int) -> str:
    return f"netplay-native-save:{room_id}:{player}"


def _ticket_key(ticket: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{32}", ticket):
        raise HTTPException(status_code=404, detail="Launcher request not found")
    return "netplay-launcher:" + hashlib.sha256(ticket.encode()).hexdigest()


def create_ticket(
    request: Request, room: dict[str, Any], body: BridgeNativeRequest
) -> BridgeNativeTicketResponse:
    _, catalog = _catalog(room)
    if body.platform not in catalog.get("downloads", {}):
        raise HTTPException(
            status_code=422, detail="Windows core architecture unavailable"
        )
    member = next(
        (
            member
            for member in room.get("members", [])
            if member.get("owner") == str(request.user.id)
        ),
        None,
    )
    if not member or member["kind"] != "web":
        raise HTTPException(
            status_code=409,
            detail="Join the room in your browser before opening RetroArch",
        )
    if (
        not room.get("nativeAuthority")
        and member["player"] == room.get("host")
        and not any(
            peer["kind"] == "web" and peer["player"] != member["player"]
            for peer in room["members"]
        )
    ):
        raise HTTPException(
            status_code=409,
            detail="Another browser player must remain connected to host the room before you switch to RetroArch.",
        )
    if member.get("romId") != body.rom_id:
        raise HTTPException(
            status_code=409,
            detail="Keep your selected cartridge when switching clients",
        )
    ticket = secrets.token_urlsafe(24)
    key = _ticket_key(ticket)
    index = f"netplay-launcher-owner:{room['id']}:{request.user.id}"
    previous = redis_client.get(index)
    if previous:
        old = previous.decode() if isinstance(previous, bytes) else previous
        redis_client.delete(old, old + ":status")
    metadata = {
        "owner": request.user.id,
        "room_id": room["id"],
        "player": member["player"],
        "body": body.model_dump(),
    }
    redis_client.set(key, json.dumps(metadata), ex=TICKET_LIFETIME)
    redis_client.set(
        key + ":status",
        json.dumps(
            {"owner": request.user.id, "room_id": room["id"], "status": "waiting"}
        ),
        ex=TICKET_LIFETIME,
    )
    redis_client.set(index, key, ex=TICKET_LIFETIME)
    query = urlencode(
        {
            "server": str(request.base_url).rstrip("/"),
            "room": room["id"],
            "ticket": ticket,
        }
    )
    return BridgeNativeTicketResponse(
        ticket=ticket,
        launch_url=f"romm-netplay://launch/?{query}",
        expires_at=int((time.time() + TICKET_LIFETIME) * 1000),
    )


def claim_ticket(room_id: str, ticket: str) -> dict[str, Any]:
    key = _ticket_key(ticket)
    stored = redis_client.get(key)
    if not stored or json.loads(stored)["room_id"] != room_id:
        raise HTTPException(
            status_code=410,
            detail="This launcher request expired or was already used. Click Open in Windows RetroArch again.",
        )
    claimed = redis_client.getdel(key)
    if not claimed:
        raise HTTPException(
            status_code=409, detail="This launcher request was already used"
        )
    return dict(json.loads(claimed))


def finish_ticket(
    ticket: str,
    metadata: dict[str, Any],
    session: BridgeNativeResponse | None = None,
    error: str | None = None,
) -> None:
    value = {
        "owner": metadata["owner"],
        "room_id": metadata["room_id"],
        "status": "preparing",
        "session": session.model_dump() if session else None,
        "error": error,
    }
    redis_client.set(
        _ticket_key(ticket) + ":status", json.dumps(value), ex=LAUNCH_LIFETIME
    )


def ticket_status(
    request: Request, room_id: str, ticket: str
) -> BridgeNativeTicketStatus:
    stored = redis_client.get(_ticket_key(ticket) + ":status")
    value = json.loads(stored) if stored else None
    if not value or value["owner"] != request.user.id or value["room_id"] != room_id:
        raise HTTPException(
            status_code=410,
            detail="This launcher request expired. Click Open in Windows RetroArch again.",
        )
    if value.get("error"):
        raise HTTPException(status_code=409, detail=value["error"])
    return BridgeNativeTicketStatus.model_validate(value)


def decode_battery(value: str) -> bytes:
    try:
        data = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as error:
        raise HTTPException(status_code=422, detail="Invalid cartridge save") from error
    if len(data) > 131072:
        raise HTTPException(status_code=422, detail="Cartridge save exceeds 128 KiB")
    return data


def _catalog(room: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    core = CORE_IDS.get(room["coreName"])
    catalog = json.loads((_root() / "input-netplay/bridge-cores.json").read_text())
    build = catalog.get(core, {})
    if (
        not core
        or build.get("native", {}).get("coreVersion") != room["coreVersion"]
        or not build.get("launch")
    ):
        raise HTTPException(
            status_code=409,
            detail="This room needs a matching launcher core package. Create a new room.",
        )
    return core, build


async def prepare(
    request: Request, room: dict[str, Any], body: BridgeNativeRequest
) -> BridgeNativeResponse:
    core, catalog = _catalog(room)
    if body.platform not in catalog.get("downloads", {}):
        raise HTTPException(
            status_code=422, detail="This Windows core architecture is unavailable"
        )
    battery = decode_battery(body.battery)
    if core == "snes9x" and not room.get("nativeAuthority"):
        battery = b""
    value = await bridge_request(
        "POST",
        f"/{room['id']}/native",
        {
            "owner": str(request.user.id),
            "nickname": body.nickname or request.user.username,
            "romId": body.rom_id,
            "password": body.password,
            "clientPlatform": body.platform,
            "saveAllowed": True,
            "battery": base64.b64encode(battery).decode(),
            "cartridge": body.cartridge.model_dump() if body.cartridge else None,
        },
    )
    redis_client.set(
        _launch_key(value["credential"]),
        json.dumps(
            {
                "platform": body.platform,
                "room_id": room["id"],
                "owner": str(request.user.id),
                "collect_cartridges": room.get("collectCartridges", False),
            }
        ),
        ex=LAUNCH_LIFETIME,
    )
    grant_key = _grant_key(room["id"], value["player"])
    from handler.netplay_save_handler import register_owner

    register_owner(room["id"], value["player"], str(request.user.id), body.rom_id, core)
    identity = {"owner": str(request.user.id), "rom_id": body.rom_id, "core": core}
    previous = json.loads(redis_client.get(grant_key) or "{}")
    if all(previous.get(key) == value for key, value in identity.items()):
        # Reconnecting must retain the last confirmed save and conflict baseline.
        redis_client.expire(grant_key, SAVE_GRANT_LIFETIME)
    else:
        redis_client.set(
            grant_key,
            json.dumps(identity | {"frame": -1, "generation": -1}),
            ex=SAVE_GRANT_LIFETIME,
        )
    public_url, native_host = public_addresses(
        NETPLAY_BRIDGE_PUBLIC_URL, NETPLAY_BRIDGE_PUBLIC_HOST
    )
    return BridgeNativeResponse(
        id=room["id"],
        player=value["player"],
        credential=value["credential"],
        native_password=value["nativePassword"],
        native_host=native_host or urlsplit(public_url).hostname or "",
        native_port=value["tcpPort"],
        expires_at=value["expiresAt"],
        package_url=f"/api/netplay/bridge/rooms/{room['id']}/native/package",
    )


async def reservation(room_id: str, credential: str) -> dict[str, Any]:
    if not ROOM_ID.fullmatch(room_id) or not re.fullmatch(
        r"[A-Za-z0-9_-]{32}", credential
    ):
        raise HTTPException(status_code=404, detail="Native preparation not found")
    # Four 128 KiB cartridge saves occupy about 700 KiB after base64 encoding.
    value = await bridge_request(
        "GET", f"/{room_id}/native/{credential}", response_limit=1024 * 1024
    )
    return dict(value)


async def _launch(
    room_id: str, credential: str
) -> tuple[dict[str, Any], dict[str, Any]]:
    session = await reservation(room_id, credential)
    stored = redis_client.get(_launch_key(credential))
    if not stored or session["expiresAt"] <= time.time() * 1000:
        raise HTTPException(
            status_code=410,
            detail="Native preparation expired. Prepare the room again.",
        )
    metadata = json.loads(stored)
    if metadata["room_id"] != room_id or metadata["owner"] != session["owner"]:
        raise HTTPException(status_code=404, detail="Native preparation not found")
    return session, metadata


async def content_path(room_id: str, credential: str, slot: int) -> Path:
    session, metadata = await _launch(room_id, credential)
    if session.get("pending"):
        raise HTTPException(
            status_code=409, detail="Waiting for the host to prepare the cartridges"
        )
    cartridges = session["cartridges"]
    if slot < 0 or slot >= len(cartridges):
        raise HTTPException(status_code=404, detail="Cartridge slot not found")
    rom = db_rom_handler.get_rom(cartridges[slot]["romId"])
    if metadata.get("collect_cartridges"):
        user = db_user_handler.get_user(int(metadata["owner"]))
        perms = resolve_permissions(user) if user else None
        if (
            not rom
            or not perms
            or not perms.can_see_rom(rom)
            or not can_access(perms, PermEntity.EMULATION, PermAction.READ)
        ):
            raise HTTPException(status_code=404, detail="Cartridge is unavailable")
    if not rom or not rom.has_file_on_disk or len(rom.files) != 1:
        raise HTTPException(
            status_code=422,
            detail="Native preparation requires a single cartridge file or ZIP",
        )
    path = fs_rom_handler.validate_path(rom.files[0].full_path)
    if not path.is_file() or path.stat().st_size > 64 * 1024 * 1024:
        raise HTTPException(
            status_code=422, detail="Cartridge file is missing or too large"
        )
    return path


async def session_manifest(
    request: Request, room_id: str, credential: str
) -> dict[str, Any]:
    session, metadata = await _launch(room_id, credential)
    if session["connected"]:
        raise HTTPException(
            status_code=409, detail="This launch credential has already been used"
        )
    core, catalog = _catalog(session)
    platform = metadata["platform"]
    origin = str(request.base_url).rstrip("/")
    base = {
        "schemaVersion": 3 if session.get("nativeAuthority") else 1,
        "roomId": room_id,
        "expiresAt": session["expiresAt"],
        "platform": platform,
        "credential": credential,
        "origin": origin,
        "manifestUrl": f"{origin}/api/netplay/bridge/rooms/{room_id}/native/manifest",
    }
    if session.get("pending"):
        return base | {"pending": True}
    asset_base = origin + "/assets/emulatorjs/input-netplay/"
    artifact = catalog["downloads"][platform]
    core_artifact = {
        "name": f"{core}_libretro.dll",
        "url": urljoin(asset_base, artifact["path"]),
        "sha256": artifact["sha256"],
    }
    info = catalog["native"].get("coreInfo")
    profile = dict(catalog["launch"])
    profile["options"] = dict(profile["options"])
    if core == "mgba_splitscreen":
        profile["subsystem"] = f"gba_link_{session['players']}p"
        profile["options"]["splitscreen_players"] = str(session["players"])
        profile["options"]["splitscreen_layout"] = "auto"
    public_url, native_host = public_addresses(
        NETPLAY_BRIDGE_PUBLIC_URL, NETPLAY_BRIDGE_PUBLIC_HOST
    )
    return base | {
        "schemaVersion": 3 if session.get("nativeAuthority") else 1,
        "roomId": room_id,
        "expiresAt": session["expiresAt"],
        "platform": platform,
        "credential": credential,
        "origin": origin,
        "core": core_artifact,
        "coreInfo": (
            {
                "name": f"{core}_libretro.info",
                "url": urljoin(asset_base, info["path"]),
                "sha256": info["sha256"],
            }
            if info
            else None
        ),
        "profile": profile | {"id": core, "version": session["coreVersion"]},
        "cartridges": [
            rom
            | {
                "name": f"player-{slot + 1}.{profile['extension']}",
                "url": f"{origin}/api/netplay/bridge/rooms/{room_id}/native/content/{slot}",
            }
            for slot, rom in enumerate(session["cartridges"])
        ],
        "connection": {
            "host": native_host or urlsplit(public_url).hostname or "",
            "port": session["tcpPort"],
            "password": session["nativePassword"],
            "nickname": session["nickname"],
        },
        "savePolicy": (
            "web-witness-per-account"
            if session.get("nativeAuthority")
            else "host-confirmed-per-account"
        ),
        **(
            {"initialBatteries": session["initialBatteries"]}
            if session.get("nativeAuthority")
            else {}
        ),
    }


def _package_certificate() -> bytes | None:
    if not NETPLAY_BRIDGE_CA_CERT_PATH:
        return None
    try:
        with Path(NETPLAY_BRIDGE_CA_CERT_PATH).open("rb") as source:
            raw = source.read(65537)
        if len(raw) > 65536 or b"PRIVATE KEY" in raw:
            raise ValueError("Expected a public root CA certificate")
        certificates = (
            x509.load_pem_x509_certificates(raw)
            if b"-----BEGIN" in raw
            else [x509.load_der_x509_certificate(raw)]
        )
        if len(certificates) != 1:
            raise ValueError("Expected one root CA certificate")
        certificate = certificates[0]
        if not certificate.extensions.get_extension_for_class(
            x509.BasicConstraints
        ).value.ca:
            raise ValueError("Certificate is not a CA")
        certificate.verify_directly_issued_by(certificate)
        now = datetime.now(timezone.utc)
        if (
            not certificate.not_valid_before_utc
            <= now
            < certificate.not_valid_after_utc
        ):
            raise ValueError("CA certificate is not currently valid")
        return certificate.public_bytes(Encoding.DER)
    except (
        OSError,
        ValueError,
        x509.ExtensionNotFound,
        x509.DuplicateExtension,
        InvalidSignature,
        UnsupportedAlgorithm,
        TypeError,
    ) as error:
        raise HTTPException(
            status_code=503,
            detail="The configured netplay root CA certificate is invalid or unavailable",
        ) from error


async def package(request: Request, room_id: str, credential: str) -> bytes:
    manifest = await session_manifest(request, room_id, credential)
    certificate = (
        _package_certificate()
        if urlsplit(manifest["origin"]).scheme == "https"
        else None
    )
    if certificate:
        manifest["certificate"] = {
            "name": "RomM-CA.cer",
            "sha256": hashlib.sha256(certificate).hexdigest(),
        }
    output = io.BytesIO()
    ensure_zipfile_writable()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("session.json", json.dumps(manifest, indent=2))
        archive.write(_root() / "input-netplay/windows-session.ps1", "Launch.ps1")
        archive.writestr(
            "Play.cmd",
            '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Launch.ps1" -Manifest "%~dp0session.json"\r\npause\r\n',
        )
        if certificate:
            archive.writestr("RomM-CA.cer", certificate)
            archive.writestr(
                "Install Certificate.cmd",
                '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Launch.ps1" -Manifest "%~dp0session.json" -InstallCertificate\r\npause\r\n',
            )
        archive.writestr(
            "README.txt",
            (
                "This server uses a private HTTPS CA. On each Windows computer, open Install Certificate.cmd once, then Play.cmd. The CA is installed for the current Windows user only; no administrator rights are needed.\r\n"
                if certificate
                else ""
            )
            + "Extract this ZIP, then open Play.cmd within 15 minutes.\r\n"
            "The helper checks for an existing RetroArch first. If none is found for this platform, it downloads official portable RetroArch 1.22.2 (about 200 MB, Windows x64/x86). No installation or administrator access is needed.\r\n"
            "SameBoy requires RetroArch 1.22.2 or later. If an older version is installed, update that installation and try again. It will not be replaced automatically.\r\n"
            "To use another location: powershell.exe -NoProfile -ExecutionPolicy Bypass -File Launch.ps1 -Manifest session.json -RetroArch D:\\RetroArch\\retroarch.exe\r\n"
            "Windows ARM64 requires an existing ARM64 RetroArch, or select Windows x64 in the room to use the portable x64 runtime.\r\n"
            "Keep your own room page open. RetroArch has host priority; the host uses Start game in that page.\r\n"
            "mGBA waits on a blank screen until game start, then shows only your assigned screen and audio.\r\n"
            "Selected cartridge saves are staged before launch. Automatic RomM progress uploads require a playing web participant.\r\n",
        )
    return output.getvalue()


def launcher_package(request: Request) -> bytes:
    manifest: dict[str, Any] = {
        "schemaVersion": 1,
        "origin": str(request.base_url).rstrip("/"),
    }
    certificate = (
        _package_certificate()
        if urlsplit(manifest["origin"]).scheme == "https"
        else None
    )
    if certificate:
        manifest["certificate"] = {
            "name": "RomM-CA.cer",
            "sha256": hashlib.sha256(certificate).hexdigest(),
        }
    output = io.BytesIO()
    ensure_zipfile_writable()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("launcher.json", json.dumps(manifest, indent=2))
        archive.write(_root() / "input-netplay/windows-session.ps1", "Launch.ps1")
        for name, mode in [
            ("Register Launcher.cmd", "RegisterLauncher"),
            ("Unregister Launcher.cmd", "UnregisterLauncher"),
        ]:
            archive.writestr(
                name,
                f'@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Launch.ps1" -Manifest "%~dp0launcher.json" -{mode}\r\npause\r\n',
            )
        if certificate:
            archive.writestr("RomM-CA.cer", certificate)
            archive.writestr(
                "Install Certificate.cmd",
                '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Launch.ps1" -Manifest "%~dp0launcher.json" -InstallCertificate\r\npause\r\n',
            )
        archive.writestr(
            "README.txt",
            (
                "Extract this ZIP and open Register Launcher.cmd once. It registers romm-netplay links for the current Windows user. No administrator access is required.\r\n"
                "The helper is copied to %LOCALAPPDATA%\\RomMNetplay\\Launcher. You can delete the downloaded ZIP after registration.\r\n"
                "For each game, join its RomM room and click Open in Windows RetroArch. Allow your browser to open the launcher. No new ZIP is needed.\r\n"
                "Your web seat is retained until the launcher contacts the server; the room displays RetroArch once its connection succeeds. Keep your room page open. RetroArch has host priority.\r\n"
                "The helper reuses an existing RetroArch. It downloads a portable copy only if none is found for this platform. Games, cores and selected saves come from the room.\r\n"
                "SameBoy requires RetroArch 1.22.2 or later. If an older version is installed, update that installation and try again. It will not be replaced automatically.\r\n"
                "Unregister Launcher.cmd removes only this launcher's per-user link registration.\r\n"
            )
            + (
                "For this private HTTPS server, open Install Certificate.cmd once on each Windows computer. It installs only the public CA for the current user.\r\n"
                if certificate
                else ""
            ),
        )
    return output.getvalue()


async def save_progress(
    room: dict[str, Any], body: BridgeNativeSaveRequest
) -> dict[str, Any]:
    lock = redis_client.lock(
        _grant_key(room["id"], body.player) + ":lock", timeout=60, blocking=False
    )
    if not lock.acquire():
        raise HTTPException(
            status_code=409, detail="Another confirmed save is being written"
        )
    try:
        return await _save_progress(room, body)
    finally:
        lock.release()


async def _save_progress(
    room: dict[str, Any], body: BridgeNativeSaveRequest
) -> dict[str, Any]:
    member = next(
        (item for item in room.get("members", []) if item["player"] == body.player),
        None,
    )
    grant_key = _grant_key(room["id"], body.player)
    stored = redis_client.get(grant_key)
    if (
        not stored
        or not member
        or member["kind"] != "native"
        or not member["playing"]
        or member["owner"] != body.owner
    ):
        raise HTTPException(
            status_code=409, detail="Native save owner is no longer connected"
        )
    grant = json.loads(stored)
    if grant["owner"] != body.owner or room.get("generation", 0) != body.generation:
        raise HTTPException(
            status_code=409, detail="Native save belongs to an older session"
        )
    seat = room["seats"][body.player]
    if seat is None or not 0 <= seat < room["players"]:
        raise HTTPException(
            status_code=409, detail="Native participant has no player number"
        )
    cartridge = room["cartridges"][0 if room["system"] == "snes" else seat]
    owners = room.get("saveOwners")
    owner = owners[seat] if isinstance(owners, list) and seat < len(owners) else None
    if (
        not isinstance(owner, dict)
        or owner.get("player") != body.player
        or owner.get("owner") != body.owner
        or owner.get("romId") != grant["rom_id"]
    ):
        raise HTTPException(
            status_code=409,
            detail="Save does not belong to this game's original player",
        )
    if cartridge["romId"] != grant["rom_id"]:
        raise HTTPException(
            status_code=409, detail="Save cartridge does not match the selected player"
        )
    if (body.generation, body.frame) < (grant["generation"], grant["frame"]):
        raise HTTPException(
            status_code=409, detail="A newer confirmed save has already arrived"
        )
    return await persist_progress(room["id"], body, grant_key, grant)


async def persist_progress(
    room_id: str,
    body: BridgeNativeSaveRequest,
    grant_key: str,
    grant: dict[str, Any],
    *,
    lifetime: int | None = SAVE_GRANT_LIFETIME,
) -> dict[str, Any]:
    data = decode_battery(body.battery)
    digest = hashlib.sha256(data).hexdigest()
    if not data or digest == grant.get("digest"):
        grant.update(frame=body.frame, generation=body.generation)
        redis_client.set(grant_key, json.dumps(grant), ex=lifetime)
        return {"saved": False}
    user = db_user_handler.get_user(int(grant["owner"]))
    rom = db_rom_handler.get_rom(grant["rom_id"])
    if not user or not rom:
        raise HTTPException(
            status_code=404, detail="Save owner or cartridge is unavailable"
        )
    emulator = grant["core"]
    slot = "netplay" if emulator == "snes9x" else "link"
    path = fs_asset_handler.build_saves_file_path(
        user, rom.platform.fs_slug, rom.id, emulator
    )
    filename = grant.get("filename")
    if not filename:
        base_name = sanitize_asset_filename(f"{rom.fs_name_no_ext.strip()}.srm", "save")
        filename = sanitize_asset_filename(
            await reserve_version_name(user.id, rom.id, path, base_name),
            "save",
        )
        grant["filename"] = filename
        redis_client.set(grant_key, json.dumps(grant), ex=lifetime)
    existing = db_save_handler.get_save_by_filename(
        user_id=user.id, rom_id=rom.id, file_name=filename, emulator=emulator, slot=slot
    )
    if existing and existing.content_hash != grant.get("content_hash"):
        if existing.content_hash == hash_save_content(io.BytesIO(data)):
            grant.update(
                frame=body.frame,
                generation=body.generation,
                digest=digest,
                content_hash=existing.content_hash,
            )
            redis_client.set(grant_key, json.dumps(grant), ex=lifetime)
            return {"saved": False, "id": existing.id}
        raise HTTPException(
            status_code=409, detail="The room save was modified outside this session"
        )
    await fs_asset_handler.write_file(data, path, filename)
    scanned = await scan_save(filename, user, rom.platform.fs_slug, rom.id, emulator)
    if existing:
        saved = db_save_handler.update_save(
            existing.id,
            {
                "file_size_bytes": scanned.file_size_bytes,
                "content_hash": scanned.content_hash,
            },
        )
    else:
        scanned.user_id, scanned.rom_id, scanned.emulator, scanned.slot = (
            user.id,
            rom.id,
            emulator,
            slot,
        )
        saved = db_save_handler.add_save(scanned)
    grant.update(
        frame=body.frame,
        generation=body.generation,
        digest=digest,
        content_hash=scanned.content_hash,
    )
    redis_client.set(grant_key, json.dumps(grant), ex=lifetime)
    return {"saved": True, "id": saved.id}
