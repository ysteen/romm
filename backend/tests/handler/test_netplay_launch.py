import base64
import hashlib
import io
import json
import time
import zipfile
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
)
from fastapi import HTTPException
from tests.utils.test_tls import _issue

from endpoints.responses.netplay_bridge import (
    BridgeNativeRequest,
    BridgeNativeSaveRequest,
)
from handler import netplay_bridge_handler as bridge
from handler import netplay_launch_handler as launch
from handler import netplay_save_handler as server_saves
from handler import netplay_settings_handler as settings
from utils.context import ctx_aiohttp_session


@pytest.fixture(autouse=True)
def isolated_server_save_grants(mocker):
    from fakeredis import FakeRedis

    mocker.patch.object(server_saves, "redis_client", FakeRedis())
    mocker.patch.object(settings, "redis_client", FakeRedis())


@pytest.mark.parametrize("players", [2, 4])
async def test_native_reservation_accepts_full_size_cartridge_saves(mocker, players):
    mocker.patch.object(bridge, "bridge_enabled", return_value=True)
    mocker.patch.object(bridge, "NETPLAY_BRIDGE_URL", "http://relay:8082")
    value = {
        "nativeAuthority": True,
        "pending": True,
        "initialBatteries": [
            base64.b64encode(bytes([player + 1]) * 131072).decode()
            for player in range(players)
        ],
    }
    data = json.dumps(value).encode()
    assert len(data) > 256 * 1024

    async def chunks(size):
        for offset in range(0, len(data), size):
            yield data[offset : offset + size]

    response = Mock(status=200)
    response.content.iter_chunked = chunks
    context = AsyncMock()
    context.__aenter__.return_value = response
    token = ctx_aiohttp_session.set(Mock(request=Mock(return_value=context)))
    try:
        assert await launch.reservation("room-1", "a" * 32) == value
    finally:
        ctx_aiohttp_session.reset(token)


async def test_native_reservation_still_bounds_response_size(mocker):
    mocker.patch.object(bridge, "bridge_enabled", return_value=True)
    response = Mock(status=200)

    async def chunks(_size):
        for _ in range(17):
            yield b" " * (64 * 1024)
        pytest.fail("Oversized native response was not stopped")

    response.content.iter_chunked = chunks
    context = AsyncMock()
    context.__aenter__.return_value = response
    token = ctx_aiohttp_session.set(Mock(request=Mock(return_value=context)))
    try:
        with pytest.raises(HTTPException) as error:
            await launch.reservation("room-1", "a" * 32)
        assert error.value.status_code == 502
    finally:
        ctx_aiohttp_session.reset(token)


@pytest.fixture
def launcher_ticket(mocker):
    from fakeredis import FakeRedis

    mocker.patch.object(launch, "redis_client", FakeRedis())
    request = SimpleNamespace(
        base_url="https://romm.example/", user=SimpleNamespace(id=3)
    )
    room = {
        "id": "room-1",
        "host": 0,
        "nativeAllowed": True,
        "nativeAuth": True,
        "coreName": "mGBA Splitscreen",
        "coreVersion": "0.1.0-f1d5975-rollback2",
        "members": [
            {"player": 0, "owner": "4", "kind": "web", "romId": 11},
            {"player": 1, "owner": "3", "kind": "web", "romId": 12},
        ],
    }
    body = BridgeNativeRequest(rom_id=12, platform="windows-x86_64")
    return request, room, body


def test_launcher_ticket_is_short_lived_single_use_and_owner_bound(launcher_ticket):
    request, room, body = launcher_ticket
    created = launch.create_ticket(request, room, body)
    assert created.launch_url.startswith(
        "romm-netplay://launch/?server=https%3A%2F%2Fromm.example&room=room-1&ticket="
    )
    assert (
        0
        < launch.redis_client.ttl(launch._ticket_key(created.ticket))
        <= launch.TICKET_LIFETIME
    )
    assert launch.ticket_status(request, room["id"], created.ticket).status == "waiting"
    with pytest.raises(HTTPException):
        launch.ticket_status(
            SimpleNamespace(user=SimpleNamespace(id=4)), room["id"], created.ticket
        )
    with pytest.raises(HTTPException):
        launch.claim_ticket("another-room", created.ticket)
    metadata = launch.claim_ticket(room["id"], created.ticket)
    assert metadata["owner"] == 3
    assert metadata["player"] == 1
    assert metadata["body"]["rom_id"] == 12
    with pytest.raises(HTTPException) as error:
        launch.claim_ticket(room["id"], created.ticket)
    assert error.value.status_code == 410


def test_retry_invalidates_previous_launcher_link(launcher_ticket):
    request, room, body = launcher_ticket
    previous = launch.create_ticket(request, room, body)
    current = launch.create_ticket(request, room, body)
    with pytest.raises(HTTPException):
        launch.claim_ticket(room["id"], previous.ticket)
    assert launch.claim_ticket(room["id"], current.ticket)["owner"] == 3


@pytest.mark.parametrize(
    "kind", ["absent", "native", "sole_host", "different_cartridge"]
)
def test_launcher_requires_current_web_member_and_remaining_host(launcher_ticket, kind):
    request, room, body = launcher_ticket
    if kind == "absent":
        room["members"].pop()
    elif kind == "native":
        room["members"][1]["kind"] = "native"
    elif kind == "sole_host":
        room["members"].pop(0)
        room["host"] = 1
    else:
        room["members"][1]["romId"] = 99
    with pytest.raises(HTTPException) as error:
        launch.create_ticket(request, room, body)
    assert error.value.status_code == 409


def test_reusable_launcher_has_no_room_credentials_or_expiry(mocker):
    mocker.patch.object(launch, "NETPLAY_BRIDGE_CA_CERT_PATH", "")
    data = launch.launcher_package(SimpleNamespace(base_url="https://romm.example/"))
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        assert json.loads(archive.read("launcher.json")) == {
            "schemaVersion": 1,
            "origin": "https://romm.example",
        }
        assert "session.json" not in archive.namelist()
        assert b"-RegisterLauncher" in archive.read("Register Launcher.cmd")
        assert b"-UnregisterLauncher" in archive.read("Unregister Launcher.cmd")


def test_last_web_member_can_switch_when_native_authority_is_enabled(launcher_ticket):
    request, room, body = launcher_ticket
    room["members"].pop(0)
    room.update(host=1, nativeAuthority=True)
    ticket = launch.create_ticket(request, room, body)
    assert launch.claim_ticket(room["id"], ticket.ticket)["player"] == 1


@pytest.fixture
def native_session(mocker):
    mocker.patch.object(launch, "NETPLAY_BRIDGE_CA_CERT_PATH", "")
    value = {
        "owner": "3",
        "connected": False,
        "expiresAt": int(time.time() * 1000) + 60000,
        "coreName": "mGBA Splitscreen",
        "coreVersion": "0.1.0-f1d5975-rollback2",
        "players": 2,
        "tcpPort": 55435,
        "nativePassword": "b" * 32,
        "nickname": "Player",
        "cartridges": [
            {
                "romId": index + 11,
                "sha256": str(index + 1) * 64,
                "size": 32768,
                "crc32": index,
            }
            for index in range(2)
        ],
    }
    mocker.patch.object(launch, "reservation", AsyncMock(return_value=value))
    mocker.patch.object(
        launch.redis_client,
        "get",
        return_value=json.dumps(
            {"room_id": "room-1", "owner": "3", "platform": "windows-x86_64"}
        ),
    )
    return value


async def test_package_preserves_order_and_scoped_credentials(native_session):
    data = await launch.package(
        SimpleNamespace(base_url="https://romm.example/"), "room-1", "a" * 32
    )
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        session = json.loads(archive.read("session.json"))
        assert set(archive.namelist()) == {
            "session.json",
            "Launch.ps1",
            "Play.cmd",
            "README.txt",
        }
    assert [rom["romId"] for rom in session["cartridges"]] == [11, 12]
    assert session["profile"]["subsystem"] == "gba_link_2p"
    assert session["connection"]["password"] == "b" * 32
    assert session["credential"] == "a" * 32
    assert all(
        "credential" not in rom["url"] and "token" not in rom["url"]
        for rom in session["cartridges"]
    )
    assert session["core"]["url"].startswith("https://romm.example/assets/")


@pytest.mark.parametrize("pending", [False, True])
async def test_private_ca_zip_includes_only_public_certificate_and_offline_installer(
    native_session, mocker, tmp_path, pending
):
    certificate, _ = _issue("RomM test CA", None, is_ca=True)
    path = tmp_path / "root.crt"
    path.write_bytes(certificate.public_bytes(Encoding.PEM))
    mocker.patch.object(launch, "NETPLAY_BRIDGE_CA_CERT_PATH", str(path))
    native_session["pending"] = pending
    data = await launch.package(
        SimpleNamespace(base_url="https://romm.example/"), "room-1", "a" * 32
    )
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        exported = archive.read("RomM-CA.cer")
        assert exported == certificate.public_bytes(Encoding.DER)
        manifest = json.loads(archive.read("session.json"))
        assert manifest["certificate"] == {
            "name": "RomM-CA.cer",
            "sha256": hashlib.sha256(exported).hexdigest(),
        }
        installer = archive.read("Install Certificate.cmd")
        assert b"-InstallCertificate" in installer
        assert b"-Manifest" in installer
        assert b"Current User" in archive.read("Launch.ps1")
        assert b"current Windows user only" in archive.read("README.txt")


@pytest.mark.parametrize(
    "kind",
    [
        "missing",
        "leaf",
        "intermediate",
        "private_key",
        "bundle",
        "invalid",
        "oversized",
    ],
)
async def test_invalid_ca_configuration_is_not_distributed(
    native_session, mocker, tmp_path, kind
):
    root = _issue("Root", None, is_ca=True)
    certificate = (
        _issue("Leaf", root, is_ca=False)[0]
        if kind == "leaf"
        else (
            _issue("Intermediate", root, is_ca=True)[0]
            if kind == "intermediate"
            else root[0]
        )
    )
    raw = certificate.public_bytes(Encoding.PEM)
    if kind == "private_key":
        raw += root[1].private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())
    elif kind == "bundle":
        raw += raw
    elif kind == "invalid":
        raw = b"not a certificate"
    elif kind == "oversized":
        raw += b" " * 65536
    path = tmp_path / "root.crt"
    if kind != "missing":
        path.write_bytes(raw)
    mocker.patch.object(launch, "NETPLAY_BRIDGE_CA_CERT_PATH", str(path))
    with pytest.raises(HTTPException) as error:
        await launch.package(
            SimpleNamespace(base_url="https://romm.example/"), "room-1", "a" * 32
        )
    assert error.value.status_code == 503


async def test_http_zip_does_not_request_certificate_installation(
    native_session, mocker
):
    mocker.patch.object(
        launch, "NETPLAY_BRIDGE_CA_CERT_PATH", "/missing/private-ca.crt"
    )
    data = await launch.package(
        SimpleNamespace(base_url="http://romm.example/"), "room-1", "a" * 32
    )
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        assert "RomM-CA.cer" not in archive.namelist()
        assert "certificate" not in json.loads(archive.read("session.json"))


async def test_expired_and_consumed_downloads_are_rejected(native_session):
    native_session["connected"] = True
    with pytest.raises(HTTPException) as error:
        await launch.package(
            SimpleNamespace(base_url="https://romm.example/"), "room-1", "a" * 32
        )
    assert error.value.status_code == 409
    native_session["expiresAt"] = 0
    with pytest.raises(HTTPException) as error:
        await launch.content_path("room-1", "a" * 32, 0)
    assert error.value.status_code == 410


async def test_download_cannot_select_a_rom_outside_the_room(native_session, mocker):
    lookup = mocker.patch.object(launch.db_rom_handler, "get_rom")
    with pytest.raises(HTTPException) as error:
        await launch.content_path("room-1", "a" * 32, 2)
    assert error.value.status_code == 404
    lookup.assert_not_called()


async def test_pending_package_waits_for_final_order(native_session):
    native_session["pending"] = True
    request = SimpleNamespace(base_url="https://romm.example/")
    data = await launch.package(request, "room-1", "a" * 32)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        session = json.loads(archive.read("session.json"))
    assert session["pending"] is True
    assert (
        session["manifestUrl"]
        == "https://romm.example/api/netplay/bridge/rooms/room-1/native/manifest"
    )
    assert "cartridges" not in session
    assert "connection" not in session
    with pytest.raises(HTTPException) as error:
        await launch.content_path("room-1", "a" * 32, 0)
    assert error.value.status_code == 409
    native_session["pending"] = False
    native_session["cartridges"].reverse()
    prepared = await launch.session_manifest(request, "room-1", "a" * 32)
    assert [rom["romId"] for rom in prepared["cartridges"]] == [12, 11]
    assert prepared["credential"] == session["credential"]


async def test_native_host_manifest_includes_ordered_selected_saves(native_session):
    native_session.update(nativeAuthority=True, initialBatteries=["AQID", "BAUG"])
    request = SimpleNamespace(base_url="https://romm.example/")
    manifest = await launch.session_manifest(request, "room-1", "a" * 32)
    assert manifest["schemaVersion"] == 3
    assert manifest["initialBatteries"] == ["AQID", "BAUG"]
    assert [rom["romId"] for rom in manifest["cartridges"]] == [11, 12]
    native_session["pending"] = True
    pending = await launch.session_manifest(request, "room-1", "a" * 32)
    assert pending["schemaVersion"] == 3
    assert pending["pending"] is True
    assert "initialBatteries" not in pending


@pytest.mark.parametrize("native_authority", [False, True])
async def test_snes_native_authority_keeps_the_selected_shared_save(
    mocker, native_authority
):
    mocker.patch.object(
        launch,
        "_catalog",
        return_value=("snes9x", {"downloads": {"windows-x86_64": {}}}),
    )
    gateway = mocker.patch.object(
        launch,
        "bridge_request",
        AsyncMock(
            return_value={
                "credential": "a" * 32,
                "player": 0,
                "nativePassword": "b" * 32,
                "tcpPort": 55435,
                "expiresAt": 9999999999999,
            }
        ),
    )
    mocker.patch.object(launch.redis_client, "set")
    mocker.patch("handler.netplay_launch_handler.redis_client.get", return_value=None)
    request = SimpleNamespace(user=SimpleNamespace(id=3, username="fixture"))
    body = BridgeNativeRequest(rom_id=11, platform="windows-x86_64", battery="AQID")
    await launch.prepare(
        request, {"id": "room-1", "nativeAuthority": native_authority}, body
    )
    assert gateway.await_args is not None
    assert gateway.await_args.args[2]["battery"] == ("AQID" if native_authority else "")


async def test_collected_content_rechecks_native_owners_visibility(
    native_session, mocker
):
    mocker.patch.object(
        launch.redis_client,
        "get",
        return_value=json.dumps(
            {
                "room_id": "room-1",
                "owner": "3",
                "platform": "windows-x86_64",
                "collect_cartridges": True,
            }
        ),
    )
    mocker.patch.object(
        launch.db_rom_handler, "get_rom", return_value=SimpleNamespace(id=11)
    )
    mocker.patch.object(
        launch.db_user_handler, "get_user", return_value=SimpleNamespace(id=3)
    )
    permissions = mocker.Mock()
    permissions.can_see_rom.return_value = False
    mocker.patch.object(launch, "resolve_permissions", return_value=permissions)
    with pytest.raises(HTTPException) as error:
        await launch.content_path("room-1", "a" * 32, 0)
    assert error.value.status_code == 404


@pytest.mark.parametrize("changed", [None, "owner", "rom_id", "core"])
async def test_native_reconnect_preserves_only_the_matching_save_grant(
    launcher_ticket, mocker, changed
):
    from fakeredis import FakeRedis

    redis = FakeRedis()
    mocker.patch.object(launch, "redis_client", redis)
    request, room, body = launcher_ticket
    request.user.username = "fixture"
    grant_key = launch._grant_key(room["id"], 1)
    grant = {
        "owner": "3",
        "rom_id": 12,
        "core": "mgba_splitscreen",
        "generation": 1,
        "frame": 120,
        "digest": "old-digest",
        "content_hash": "saved-before-rejoin",
    }
    if changed:
        grant[changed] = 99 if changed == "rom_id" else "another"
    redis.set(grant_key, json.dumps(grant), ex=60)
    mocker.patch.object(
        launch,
        "bridge_request",
        AsyncMock(
            return_value={
                "credential": "a" * 32,
                "player": 1,
                "nativePassword": "b" * 32,
                "tcpPort": 55435,
                "expiresAt": 9999999999999,
            }
        ),
    )
    await launch.prepare(request, room, body)
    stored = redis.get(grant_key)
    assert stored is not None
    renewed = json.loads(stored)
    if changed:
        assert renewed == {
            "owner": "3",
            "rom_id": 12,
            "core": "mgba_splitscreen",
            "generation": -1,
            "frame": -1,
        }
        return
    assert renewed == grant
    assert redis.ttl(grant_key) > 60
    room.update(
        system="gba",
        players=2,
        generation=2,
        seats=[0, 1],
        cartridges=[{"romId": 11}, {"romId": 12}],
        saveOwners=[None, {"player": 1, "owner": "3", "romId": 12}],
    )
    room["members"][1].update(kind="native", playing=True)
    mocker.patch.object(redis, "lock")
    mocker.patch(
        "handler.netplay_launch_handler.db_user_handler.get_user",
        return_value=request.user,
    )
    mocker.patch(
        "handler.netplay_launch_handler.db_rom_handler.get_rom",
        return_value=SimpleNamespace(
            id=12,
            fs_name_no_ext="Pokemon Emerald",
            platform=SimpleNamespace(fs_slug="gba"),
        ),
    )
    existing = SimpleNamespace(id=55, content_hash=grant["content_hash"])
    mocker.patch(
        "handler.netplay_launch_handler.db_save_handler.get_save_by_filename",
        return_value=existing,
    )
    mocker.patch(
        "handler.netplay_launch_handler.db_save_handler.update_save",
        return_value=existing,
    )
    mocker.patch(
        "handler.netplay_launch_handler.fs_asset_handler.build_saves_file_path",
        return_value="fixture",
    )
    write = mocker.patch(
        "handler.netplay_launch_handler.fs_asset_handler.write_file",
        new_callable=AsyncMock,
    )
    mocker.patch.object(
        launch,
        "scan_save",
        AsyncMock(
            return_value=SimpleNamespace(
                file_size_bytes=3, content_hash="updated-content"
            )
        ),
    )
    update = BridgeNativeSaveRequest(
        player=1, owner="3", generation=2, frame=10, battery="AQID"
    )
    assert (await launch.save_progress(room, update))["saved"]
    stored = redis.get(grant_key)
    assert stored is not None
    assert json.loads(stored)["content_hash"] == "updated-content"
    existing.content_hash = "edited-outside-the-room"
    with pytest.raises(HTTPException) as error:
        await launch.save_progress(
            room, update.model_copy(update={"frame": 11, "battery": "BAUG"})
        )
    assert error.value.status_code == 409
    assert "outside this session" in error.value.detail
    write.assert_awaited_once()


async def test_confirmed_save_uses_native_account_and_rejects_stale_updates(mocker):
    room = {
        "id": "room-1",
        "system": "gba",
        "players": 2,
        "generation": 2,
        "seats": [0, 1],
        "members": [{"player": 1, "owner": "3", "kind": "native", "playing": True}],
        "cartridges": [{"romId": 11}, {"romId": 12}],
        "saveOwners": [None, {"player": 1, "owner": "3", "romId": 12}],
    }
    grant = {
        "owner": "3",
        "rom_id": 12,
        "core": "mgba_splitscreen",
        "generation": 1,
        "frame": 99,
    }
    mocker.patch.object(
        launch.redis_client, "get", side_effect=lambda _: json.dumps(grant)
    )
    mocker.patch.object(
        launch.redis_client,
        "set",
        side_effect=lambda _, value, **kw: grant.update(json.loads(value)),
    )
    mocker.patch.object(launch.redis_client, "lock")
    user = SimpleNamespace(id=3)
    rom = SimpleNamespace(
        id=12, fs_name_no_ext="Pokemon Emerald", platform=SimpleNamespace(fs_slug="gba")
    )
    mocker.patch.object(launch.db_user_handler, "get_user", return_value=user)
    mocker.patch.object(launch.db_rom_handler, "get_rom", return_value=rom)
    mocker.patch.object(
        launch.db_save_handler, "get_save_by_filename", return_value=None
    )
    add = mocker.patch.object(
        launch.db_save_handler, "add_save", return_value=SimpleNamespace(id=55)
    )
    mocker.patch.object(
        launch.fs_asset_handler,
        "build_saves_file_path",
        return_value="account-3/rom-12",
    )
    write = mocker.patch.object(
        launch.fs_asset_handler, "write_file", new_callable=AsyncMock
    )
    mocker.patch.object(
        launch,
        "reserve_version_name",
        AsyncMock(return_value="Pokemon Emerald [2026-11-07_23-00-00].srm"),
    )
    scanned = SimpleNamespace(file_size_bytes=3, content_hash="hash")
    mocker.patch.object(launch, "scan_save", AsyncMock(return_value=scanned))
    body = BridgeNativeSaveRequest(
        player=1, owner="3", generation=2, frame=60, battery="AQID"
    )
    assert (await launch.save_progress(room, body))["saved"]
    assert write.call_args.args == (
        b"\x01\x02\x03",
        "account-3/rom-12",
        "Pokemon Emerald [2026-11-07_23-00-00].srm",
    )
    assert add.call_args.args[0].user_id == 3
    assert add.call_args.args[0].rom_id == 12
    assert (await launch.save_progress(room, body))["saved"] is False
    with pytest.raises(HTTPException) as error:
        await launch.save_progress(room, body.model_copy(update={"frame": 59}))
    assert error.value.status_code == 409
    write.assert_awaited_once()


@pytest.mark.parametrize(
    "original",
    [
        None,
        {"player": 1, "owner": "old-owner", "romId": 12},
        {"player": 0, "owner": "3", "romId": 12},
        {"player": 1, "owner": "3", "romId": 99},
    ],
)
async def test_confirmed_save_rejects_reassigned_slot_ownership(mocker, original):
    room = {
        "id": "room-1",
        "system": "gba",
        "players": 2,
        "generation": 2,
        "seats": [0, 1],
        "members": [{"player": 1, "owner": "3", "kind": "native", "playing": True}],
        "cartridges": [{"romId": 11}, {"romId": 12}],
        "saveOwners": [None, original],
    }
    grant = {
        "owner": "3",
        "rom_id": 12,
        "core": "mgba_splitscreen",
        "generation": 1,
        "frame": 0,
    }
    mocker.patch.object(launch.redis_client, "get", return_value=json.dumps(grant))
    mocker.patch.object(launch.redis_client, "lock")
    write = mocker.patch.object(
        launch.fs_asset_handler, "write_file", new_callable=AsyncMock
    )
    body = BridgeNativeSaveRequest(
        player=1, owner="3", generation=2, frame=60, battery="AQID"
    )
    with pytest.raises(HTTPException) as error:
        await launch.save_progress(room, body)
    assert error.value.status_code == 409
    assert "original player" in error.value.detail
    write.assert_not_awaited()
