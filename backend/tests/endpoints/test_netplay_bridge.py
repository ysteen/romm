from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException
from tests.endpoints.test_netplay import _auth, _hide, _override_emulation_read
from tests.factories import make_platform, make_rom

from endpoints.responses.netplay_bridge import BridgeNativeResponse
from handler import netplay_bridge_handler as bridge
from handler import netplay_launch_handler as launch
from handler.netplay_handler import get_link_cartridge
from models.permission import PermEntity
from utils.context import ctx_aiohttp_session


@pytest.fixture
def relay(mocker, rom):
    mocker.patch.object(bridge, "NETPLAY_BRIDGE_URL", "http://relay:8082")
    mocker.patch.object(bridge, "NETPLAY_BRIDGE_PUBLIC_URL", "https://relay.example")
    mocker.patch.object(bridge, "NETPLAY_BRIDGE_PUBLIC_HOST", "pc.example")
    mocker.patch.object(bridge, "NETPLAY_BRIDGE_TOKEN", "admin-secret")
    mocker.patch(
        "endpoints.netplay.bridge_system",
        return_value="gb",
    )
    return mocker.patch("endpoints.netplay.bridge_request", new_callable=AsyncMock)


def create_body(rom_id: int) -> dict[str, Any]:
    return {
        "rom_id": rom_id,
        "system": "gb",
        "coreName": "SameBoy",
        "coreVersion": "1.0",
        "contentCrc": 15,
        "stateSize": 1024,
        "players": 2,
        "nativeAllowed": True,
    }


def snes_body(rom_id: int) -> dict[str, Any]:
    return create_body(rom_id) | {
        "system": "snes",
        "coreName": "Snes9x",
        "coreVersion": "1.632d4cce69",
        "stateSize": 823407,
        "maxPrediction": 12,
    }


@pytest.fixture
def snes_relay(relay, mocker):
    mocker.patch("endpoints.netplay.bridge_system", side_effect=bridge.bridge_system)
    return relay


@pytest.fixture
def snes_rom():
    return make_rom(make_platform("snes"), "two-pad.sfc")


def gateway_room(rom_id: int, owner: str = "owner") -> dict[str, Any]:
    return {
        "id": "room-1",
        "romId": rom_id,
        "owner": owner,
        "players": 2,
        "current": 1,
        "started": False,
        "nativeAllowed": True,
        "coreName": "SameBoy",
        "coreVersion": "1.0",
        "stateSize": 1024,
        "contentCrc": 15,
        "hasPassword": True,
    }


def connection() -> dict[str, Any]:
    return {
        "id": "room-1",
        "hostPath": "/v1/rooms/room-1/host?token=single-use",
        "tcpPort": 55435,
        "password": "room-password",
        "players": 2,
    }


def test_bridge_is_opt_in(client, viewer_user, mocker):
    mocker.patch.object(bridge, "NETPLAY_BRIDGE_TOKEN", "")
    response = client.get("/api/netplay/bridge/config", headers=_auth(viewer_user))
    assert response.status_code == 200
    assert response.json()["enabled"] is False


def test_bridge_routes_require_authentication(client):
    assert client.get("/api/netplay/bridge/config").status_code == 401
    assert (
        client.post("/api/netplay/bridge/rooms", json=create_body(1)).status_code == 401
    )
    assert (
        client.delete("/api/netplay/bridge/rooms/room-1/membership").status_code == 401
    )


def test_bridge_leave_uses_only_the_authenticated_owner(client, viewer_user, mocker):
    mocker.patch(
        "endpoints.netplay.bridge_room", AsyncMock(return_value={"id": "room-1"})
    )
    gateway = mocker.patch("endpoints.netplay.bridge_request", new_callable=AsyncMock)
    response = client.request(
        "DELETE",
        "/api/netplay/bridge/rooms/room-1/membership",
        json={"owner": "another-account"},
        headers=_auth(viewer_user),
    )
    assert response.status_code == 204
    gateway.assert_awaited_once_with(
        "POST", "/room-1/leave", {"owner": str(viewer_user.id)}
    )


def test_bridge_leave_is_idempotent_for_an_expired_room(client, viewer_user, mocker):
    mocker.patch(
        "endpoints.netplay.bridge_room",
        AsyncMock(side_effect=HTTPException(status_code=404)),
    )
    gateway = mocker.patch("endpoints.netplay.bridge_request", new_callable=AsyncMock)
    response = client.delete(
        "/api/netplay/bridge/rooms/room-1/membership", headers=_auth(viewer_user)
    )
    assert response.status_code == 204
    gateway.assert_not_awaited()


def test_bridge_creation_preserves_admin_secret(client, viewer_user, rom, relay):
    relay.return_value = connection()
    response = client.post(
        "/api/netplay/bridge/rooms",
        json=create_body(rom.id),
        headers=_auth(viewer_user),
    )
    assert response.status_code == 200
    assert (
        response.json()["websocket_url"]
        == "wss://relay.example/v1/rooms/room-1/host?token=single-use"
    )
    assert response.json()["native_host"] == "pc.example"
    assert response.json()["native_port"] == 55435
    assert "admin-secret" not in response.text
    assert "http://relay:8082" not in response.text
    payload = relay.call_args.args[2]
    assert payload["owner"] == str(viewer_user.id)
    assert payload["romId"] == rom.id
    assert "rom_id" not in payload
    assert payload["password"] == ""
    assert payload["manualStart"] is True
    assert payload["nickname"] == viewer_user.username
    assert payload["maxPrediction"] == 0


def test_rollback_profile_is_forwarded(client, viewer_user, rom, relay):
    relay.return_value = connection()
    response = client.post(
        "/api/netplay/bridge/rooms",
        json=create_body(rom.id)
        | {"coreVersion": "1.0.4c87d256-rollback2", "maxPrediction": 12},
        headers=_auth(viewer_user),
    )
    assert response.status_code == 200
    assert relay.call_args.args[2]["maxPrediction"] == 12


def test_account_bound_rollback_rooms_enable_native_authority(
    client, viewer_user, rom, relay
):
    relay.return_value = connection()
    cartridge = {"romId": rom.id, "size": 32768, "sha256": "a" * 64, "crc32": 15}
    response = client.post(
        "/api/netplay/bridge/rooms",
        json=create_body(rom.id)
        | {
            "coreVersion": "1.0.4c87d256-rollback2",
            "maxPrediction": 12,
            "cartridges": [cartridge, cartridge],
        },
        headers=_auth(viewer_user),
    )
    assert response.status_code == 200
    payload = relay.call_args.args[2]
    assert payload["nativeAuthority"] is True
    assert payload["nativeAuth"] is True
    assert payload["manualStart"] is True


@pytest.mark.parametrize("password", ["", "friends-only"])
def test_room_password_is_explicit_and_lobby_waits_for_host(
    client, viewer_user, rom, relay, password
):
    relay.return_value = connection()
    response = client.post(
        "/api/netplay/bridge/rooms",
        json=create_body(rom.id) | {"password": password},
        headers=_auth(viewer_user),
    )
    assert response.status_code == 200
    assert relay.call_args.args[2]["password"] == password
    assert relay.call_args.args[2]["manualStart"] is True


@pytest.mark.parametrize(
    ("slug", "expected"),
    [("gb", "gb"), ("gbc", "gb"), ("gba", "gba"), ("snes", "snes"), ("nes", None)],
)
def test_bridge_system_resolves_supported_platforms(slug, expected):
    cartridge = make_rom(make_platform(slug), "cartridge.zip")
    assert bridge.bridge_system(cartridge.id) == expected
    if slug == "snes":
        assert get_link_cartridge(cartridge.id) is None


@pytest.mark.parametrize("filename", ["two-pad.sfc", "two-pad.smc", "two-pad.zip"])
def test_snes_creation_preserves_authenticated_owner_and_profile(
    client, viewer_user, snes_relay, filename
):
    cartridge = make_rom(make_platform("snes"), filename)
    snes_relay.return_value = connection()
    response = client.post(
        "/api/netplay/bridge/rooms",
        json=snes_body(cartridge.id) | {"password": "snes-room-password"},
        headers=_auth(viewer_user),
    )
    assert response.status_code == 200
    payload = snes_relay.call_args.args[2]
    assert payload["system"] == "snes"
    assert payload["coreName"] == "Snes9x"
    assert payload["coreVersion"] == "1.632d4cce69"
    assert payload["players"] == 2
    assert payload["maxPrediction"] == 12
    assert payload["owner"] == str(viewer_user.id)
    assert payload["romId"] == cartridge.id
    assert payload["password"] == "snes-room-password"


@pytest.mark.parametrize(
    "changes",
    [
        {"players": 3},
        {"players": 4},
        {"coreName": "SameBoy"},
        {"coreName": "mGBA Splitscreen"},
        {"system": "gb", "coreName": "SameBoy"},
        {"nativeCalibration": "sameboy-v1"},
    ],
)
def test_snes_rejects_incompatible_profiles(
    client, viewer_user, snes_rom, snes_relay, changes
):
    response = client.post(
        "/api/netplay/bridge/rooms",
        json=snes_body(snes_rom.id) | changes,
        headers=_auth(viewer_user),
    )
    assert response.status_code == 422
    snes_relay.assert_not_awaited()


def test_snes_listing_and_password_join_use_the_existing_romm_identity(
    client, viewer_user, snes_rom, snes_relay, mocker
):
    room = gateway_room(snes_rom.id) | {
        "system": "snes",
        "coreName": "Snes9x",
        "coreVersion": "1.632d4cce69",
        "maxPrediction": 12,
    }
    mocker.patch("endpoints.netplay.bridge_rooms", AsyncMock(return_value=[room]))
    mocker.patch("endpoints.netplay.bridge_room", AsyncMock(return_value=room))
    listed = client.get(
        "/api/netplay/bridge/rooms",
        params={"rom_id": snes_rom.id},
        headers=_auth(viewer_user),
    )
    assert listed.status_code == 200
    assert listed.json()[0]["core_name"] == "Snes9x"
    assert listed.json()[0]["max_prediction"] == 12
    result = connection()
    result["peerPath"] = result.pop("hostPath").replace("/host?", "/peer?")
    result["player"] = 1
    snes_relay.return_value = result
    joined = client.post(
        "/api/netplay/bridge/rooms/room-1/join",
        json={"rom_id": snes_rom.id, "password": "snes-room-password"},
        headers=_auth(viewer_user),
    )
    assert joined.status_code == 200
    assert joined.json()["player"] == 1
    assert snes_relay.call_args.args[2] == {
        "owner": str(viewer_user.id),
        "nickname": viewer_user.username,
        "password": "snes-room-password",
        "romId": snes_rom.id,
    }


@pytest.mark.parametrize("restriction", ["hidden", "emulation"])
def test_snes_rooms_preserve_visibility_and_emulation_permissions(
    client, viewer_user, snes_rom, snes_relay, restriction
):
    if restriction == "hidden":
        _hide(PermEntity.ROMS, snes_rom.id, viewer_user.id)
        expected = 404
    else:
        _override_emulation_read(viewer_user)
        expected = 403
    headers = _auth(viewer_user)
    assert (
        client.post(
            "/api/netplay/bridge/rooms", json=snes_body(snes_rom.id), headers=headers
        ).status_code
        == expected
    )
    assert (
        client.get(
            "/api/netplay/bridge/rooms", params={"rom_id": snes_rom.id}, headers=headers
        ).status_code
        == expected
    )
    assert (
        client.post(
            "/api/netplay/bridge/rooms/room-1/join",
            json={"rom_id": snes_rom.id, "password": "snes-room-password"},
            headers=headers,
        ).status_code
        == expected
    )
    snes_relay.assert_not_awaited()


def test_hidden_rom_cannot_create_bridge_room(client, viewer_user, rom, relay):
    _hide(PermEntity.ROMS, rom.id, viewer_user.id)
    response = client.post(
        "/api/netplay/bridge/rooms",
        json=create_body(rom.id),
        headers=_auth(viewer_user),
    )
    assert response.status_code == 404
    relay.assert_not_awaited()


def test_native_calibration_is_forwarded_for_the_compatible_profile(
    client, viewer_user, rom, relay
):
    relay.return_value = connection()
    response = client.post(
        "/api/netplay/bridge/rooms",
        json=create_body(rom.id)
        | {"coreVersion": "1.0.4 c87d256", "nativeCalibration": "sameboy-v1"},
        headers=_auth(viewer_user),
    )
    assert response.status_code == 200
    assert relay.call_args.args[2]["nativeCalibration"] == "sameboy-v1"


def test_emulation_permission_required(client, viewer_user, rom, relay):
    _override_emulation_read(viewer_user)
    response = client.post(
        "/api/netplay/bridge/rooms",
        json=create_body(rom.id),
        headers=_auth(viewer_user),
    )
    assert response.status_code == 403
    relay.assert_not_awaited()


@pytest.mark.parametrize(
    "changes",
    [
        {"system": "gba"},
        {"coreName": "mGBA Splitscreen"},
        {"players": 3},
        {"rom_id": True},
        {"coreVersion": "한" * 11},
        {"nickname": "한" * 11},
        {"password": "한" * 41},
        {"password": "null\u0000password"},
        {"nativeCalibration": "sameboy-v1"},
        {"maxPrediction": -1},
        {"maxPrediction": 31},
        {"maxPrediction": True},
        {"maxPrediction": "12"},
        {"maxPrediction": 1.5},
        {
            "nativeCalibration": "sameboy-v1",
            "coreVersion": "1.0.4 c87d256",
            "maxPrediction": 12,
        },
        {
            "nativeCalibration": "sameboy-v1",
            "coreVersion": "1.0.4 c87d256",
            "nativeAllowed": False,
        },
    ],
)
def test_incompatible_manifest_is_rejected(client, viewer_user, rom, relay, changes):
    response = client.post(
        "/api/netplay/bridge/rooms",
        json=create_body(rom.id) | changes,
        headers=_auth(viewer_user),
    )
    assert response.status_code == 422
    relay.assert_not_awaited()


def test_listing_scopes_rooms_and_hides_credentials(
    client, viewer_user, rom, relay, mocker
):
    mocker.patch(
        "endpoints.netplay.bridge_rooms",
        AsyncMock(return_value=[gateway_room(rom.id), gateway_room(rom.id + 1)]),
    )
    response = client.get(
        "/api/netplay/bridge/rooms",
        params={"rom_id": rom.id},
        headers=_auth(viewer_user),
    )
    assert response.status_code == 200
    assert len(response.json()) == 1
    assert response.json()[0]["has_password"] is True
    assert response.json()[0]["core_version"] == "1.0"
    assert response.json()[0]["state_size"] == 1024
    assert response.json()[0]["content_crc"] == 15
    assert response.json()[0]["max_prediction"] == 0
    assert "owner" not in response.text
    assert "token" not in response.text


def test_listing_exposes_negotiated_rollback_window(
    client, viewer_user, rom, relay, mocker
):
    mocker.patch(
        "endpoints.netplay.bridge_rooms",
        AsyncMock(return_value=[gateway_room(rom.id) | {"maxPrediction": 12}]),
    )
    response = client.get(
        "/api/netplay/bridge/rooms",
        params={"rom_id": rom.id},
        headers=_auth(viewer_user),
    )
    assert response.status_code == 200
    assert response.json()[0]["max_prediction"] == 12


def test_join_requires_the_rooms_rom(client, viewer_user, rom, relay, mocker):
    mocker.patch(
        "endpoints.netplay.bridge_room",
        AsyncMock(return_value=gateway_room(rom.id + 1)),
    )
    response = client.post(
        "/api/netplay/bridge/rooms/room-1/join",
        json={"rom_id": rom.id},
        headers=_auth(viewer_user),
    )
    assert response.status_code == 404
    relay.assert_not_awaited()


def test_malformed_room_metadata_is_reported_as_gateway_error(
    client, viewer_user, rom, relay, mocker
):
    malformed = gateway_room(rom.id)
    del malformed["coreVersion"]
    mocker.patch("endpoints.netplay.bridge_rooms", AsyncMock(return_value=[malformed]))
    response = client.get(
        "/api/netplay/bridge/rooms",
        params={"rom_id": rom.id},
        headers=_auth(viewer_user),
    )
    assert response.status_code == 502


def test_join_returns_only_the_assigned_connection(
    client, viewer_user, rom, relay, mocker
):
    mocker.patch(
        "endpoints.netplay.bridge_room", AsyncMock(return_value=gateway_room(rom.id))
    )
    result = connection()
    result["peerPath"] = result.pop("hostPath").replace("/host?", "/peer?")
    result["player"] = 1
    relay.return_value = result
    response = client.post(
        "/api/netplay/bridge/rooms/room-1/join",
        json={"rom_id": rom.id, "password": "room-password"},
        headers=_auth(viewer_user),
    )
    assert response.status_code == 200
    assert response.json()["player"] == 1
    assert "/peer?" in response.json()["websocket_url"]


def test_only_owner_can_close_room(client, viewer_user, rom, relay, mocker):
    mocker.patch(
        "endpoints.netplay.bridge_room", AsyncMock(return_value=gateway_room(rom.id))
    )
    response = client.delete(
        "/api/netplay/bridge/rooms/room-1",
        params={"rom_id": rom.id},
        headers=_auth(viewer_user),
    )
    assert response.status_code == 403
    relay.assert_not_awaited()


@pytest.mark.asyncio
async def test_gateway_request_does_not_follow_redirects(mocker):
    mocker.patch.object(bridge, "bridge_enabled", return_value=True)
    mocker.patch.object(bridge, "NETPLAY_BRIDGE_URL", "http://relay:8082")
    mocker.patch.object(bridge, "NETPLAY_BRIDGE_TOKEN", "admin-secret")
    response = AsyncMock()
    response.status = 302
    context = AsyncMock()
    context.__aenter__.return_value = response
    session = Mock(request=Mock(return_value=context))
    token = ctx_aiohttp_session.set(session)
    try:
        with pytest.raises(HTTPException) as error:
            await bridge.bridge_request("POST", "", {"players": 2})
        assert error.value.status_code == 502
        assert session.request.call_args.kwargs["allow_redirects"] is False
    finally:
        ctx_aiohttp_session.reset(token)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "body", "message"),
    [
        (403, b'{"error":"Incorrect room password"}', "Incorrect room password"),
        (404, b"{}", "room has closed"),
        (
            404,
            b'{"error":"Native preparation expired"}',
            "preparation is no longer available",
        ),
        (404, b'{"error":{"secret":"must-not-leak"}}', "room has closed"),
        (409, b'{"error":"Owner already hosts a room"}', "already host a room"),
        (409, b'{"error":"Room is full"}', "room is full"),
        (409, b'{"error":{"secret":"must-not-leak"}}', "room is full"),
        (429, b"{}", "Too many room requests"),
    ],
)
async def test_gateway_errors_explain_join_failures(mocker, status, body, message):
    mocker.patch.object(bridge, "bridge_enabled", return_value=True)
    response = Mock(status=status)
    response.content.read = AsyncMock(return_value=body)
    context = AsyncMock()
    context.__aenter__.return_value = response
    token = ctx_aiohttp_session.set(Mock(request=Mock(return_value=context)))
    try:
        with pytest.raises(HTTPException) as error:
            await bridge.bridge_request("POST", "/room-1/join", {"password": ""})
        assert error.value.status_code == status
        assert message in error.value.detail
        assert "must-not-leak" not in error.value.detail
    finally:
        ctx_aiohttp_session.reset(token)


def test_connection_cannot_redirect_browser_to_another_service(relay):
    value = connection()
    value["hostPath"] = "https://other.example/host?token=single-use"
    with pytest.raises(HTTPException) as error:
        bridge.bridge_connection(value)
    assert error.value.status_code == 502


def test_web_only_room_has_no_native_port(relay):
    value = connection()
    value["tcpPort"] = None
    assert bridge.bridge_connection(value).native_port is None


@pytest.mark.asyncio
@pytest.mark.parametrize("oversized", [False, True])
async def test_gateway_response_reads_all_chunks_with_a_size_limit(mocker, oversized):
    mocker.patch.object(bridge, "bridge_enabled", return_value=True)
    mocker.patch.object(bridge, "NETPLAY_BRIDGE_URL", "http://relay:8082")

    async def chunks(_size):
        yield b'[{"id":'
        yield b'"room-1"}]' if not oversized else b" " * (256 * 1024)

    response = Mock(status=200)
    response.content.iter_chunked = chunks
    context = AsyncMock()
    context.__aenter__.return_value = response
    token = ctx_aiohttp_session.set(Mock(request=Mock(return_value=context)))
    try:
        if oversized:
            with pytest.raises(HTTPException) as error:
                await bridge.bridge_request("GET", "")
            assert error.value.status_code == 502
        else:
            assert await bridge.bridge_request("GET", "") == [{"id": "room-1"}]
    finally:
        ctx_aiohttp_session.reset(token)


def test_native_launch_requires_account_and_rom_access(
    client, viewer_user, rom, relay, mocker
):
    room = gateway_room(rom.id)
    mocker.patch("endpoints.netplay.bridge_room", AsyncMock(return_value=room))
    prepare = mocker.patch(
        "endpoints.netplay.native_launch.prepare", new_callable=AsyncMock
    )
    body = {"rom_id": rom.id, "platform": "windows-x86_64"}
    assert (
        client.post("/api/netplay/bridge/rooms/room-1/native", json=body).status_code
        == 401
    )
    _hide(PermEntity.ROMS, rom.id, viewer_user.id)
    assert client.post(
        "/api/netplay/bridge/rooms/room-1/native", json=body, headers=_auth(viewer_user)
    ).status_code in (403, 404)
    prepare.assert_not_awaited()


def test_native_seat_is_owned_by_the_authenticated_account(client, viewer_user, mocker):
    mocker.patch(
        "endpoints.netplay.native_launch.reservation",
        AsyncMock(return_value={"owner": "someone-else"}),
    )
    gateway = mocker.patch("endpoints.netplay.bridge_request", new_callable=AsyncMock)
    response = client.patch(
        "/api/netplay/bridge/rooms/room-1/native/seat",
        json={"seat": 1},
        headers=_auth(viewer_user) | {"X-Netplay-Launch": "a" * 32},
    )
    assert response.status_code == 403
    gateway.assert_not_awaited()


def test_native_save_rejects_a_non_host(client, viewer_user, rom, mocker):
    mocker.patch(
        "endpoints.netplay.bridge_room",
        AsyncMock(return_value=gateway_room(rom.id, "another-host")),
    )
    save = mocker.patch(
        "endpoints.netplay.native_launch.save_progress", new_callable=AsyncMock
    )
    response = client.post(
        "/api/netplay/bridge/rooms/room-1/native/saves",
        json={
            "player": 1,
            "owner": "target",
            "generation": 1,
            "frame": 60,
            "battery": "AQID",
        },
        headers=_auth(viewer_user),
    )
    assert response.status_code == 403
    save.assert_not_awaited()


@pytest.mark.parametrize("action", ["start", "assign", "kick"])
def test_native_room_controls_use_the_authenticated_member(
    client, viewer_user, rom, relay, mocker, action
):
    room = gateway_room(rom.id) | {
        "nativeAuthority": True,
        "members": [
            {
                "player": 1,
                "owner": str(viewer_user.id),
                "kind": "native",
                "romId": rom.id,
            }
        ],
    }
    mocker.patch("endpoints.netplay.bridge_room", AsyncMock(return_value=room))
    relay.return_value = {"host": 1}
    path = "/api/netplay/bridge/rooms/room-1/control"
    assert client.post(path, json={"action": action}).status_code == 401
    response = client.post(
        path,
        json={"action": action, "player": 0, "seat": 1, "owner": "someone-else"},
        headers=_auth(viewer_user),
    )
    assert response.status_code == 200
    relay.assert_awaited_once_with(
        "POST",
        "/room-1/control",
        {
            "owner": str(viewer_user.id),
            "t": "start-request" if action == "start" else action,
            "player": 0,
            "seat": 1,
        },
    )
    room["members"] = []
    response = client.post(path, json={"action": action}, headers=_auth(viewer_user))
    assert response.status_code == 403
    assert relay.await_count == 1


def test_native_host_room_exposes_start_controls_and_web_save_source(
    client, viewer_user, rom, relay, mocker
):
    mocker.patch(
        "endpoints.netplay.bridge_rooms",
        AsyncMock(
            return_value=[
                gateway_room(rom.id)
                | {"nativeAuthority": True, "canStart": True, "host": 1, "saveHost": 0}
            ]
        ),
    )
    response = client.get(
        "/api/netplay/bridge/rooms",
        params={"rom_id": rom.id},
        headers=_auth(viewer_user),
    )
    assert response.status_code == 200
    assert response.json()[0]["can_start"] is True
    assert response.json()[0]["native_authority"] is True
    assert response.json()[0]["save_host"] == 0


def test_web_witness_can_sync_saves_while_retroarch_hosts(
    client, editor_user, rom, mocker
):
    room = gateway_room(rom.id, "native-owner") | {
        "saveHost": 0,
        "members": [{"player": 0, "owner": str(editor_user.id), "kind": "web"}],
    }
    mocker.patch("endpoints.netplay.bridge_room", AsyncMock(return_value=room))
    save = mocker.patch(
        "endpoints.netplay.native_launch.save_progress",
        AsyncMock(return_value={"saved": True}),
    )
    response = client.post(
        "/api/netplay/bridge/rooms/room-1/native/saves",
        json={
            "player": 1,
            "owner": "native-owner",
            "generation": 1,
            "frame": 60,
            "battery": "AQID",
        },
        headers=_auth(editor_user),
    )
    assert response.status_code == 200
    save.assert_awaited_once()


def test_native_package_requires_a_scoped_credential(client, mocker):
    gateway = mocker.patch(
        "handler.netplay_launch_handler.bridge_request", new_callable=AsyncMock
    )
    response = client.get("/api/netplay/bridge/rooms/room-1/native/package")
    assert response.status_code == 404
    gateway.assert_not_awaited()


def test_native_manifest_requires_capability_and_is_not_cached(client, mocker):
    response = client.get("/api/netplay/bridge/rooms/room-1/native/manifest")
    assert response.status_code == 404
    manifest = mocker.patch(
        "endpoints.netplay.native_launch.session_manifest",
        AsyncMock(return_value={"pending": True}),
    )
    response = client.get(
        "/api/netplay/bridge/rooms/room-1/native/manifest",
        headers={"X-Netplay-Launch": "a" * 32},
    )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert manifest.call_args.args[1:] == ("room-1", "a" * 32)


@pytest.mark.parametrize("lost_access", [False, True])
def test_launcher_switches_only_after_claim_and_rechecks_access(
    client, editor_user, viewer_user, rom, relay, mocker, lost_access
):
    from fakeredis import FakeRedis

    mocker.patch.object(launch, "redis_client", FakeRedis())
    room = gateway_room(rom.id, str(viewer_user.id)) | {
        "coreVersion": "1.0.4c87d256-rollback2",
        "host": 0,
        "members": [
            {"player": 0, "owner": str(viewer_user.id), "kind": "web", "romId": rom.id},
            {"player": 1, "owner": str(editor_user.id), "kind": "web", "romId": rom.id},
        ],
    }
    mocker.patch("endpoints.netplay.bridge_room", AsyncMock(return_value=room))
    prepared = BridgeNativeResponse(
        id=room["id"],
        player=1,
        credential="a" * 32,
        native_password="b" * 32,
        native_host="pc.example",
        native_port=55435,
        expires_at=9999999999999,
        package_url="/unused",
    )
    prepare = mocker.patch.object(launch, "prepare", AsyncMock(return_value=prepared))
    manifest = mocker.patch.object(
        launch, "session_manifest", AsyncMock(return_value={"pending": True})
    )
    mocker.patch.object(launch, "NETPLAY_BRIDGE_CA_CERT_PATH", "")
    downloaded = client.get(
        "/api/netplay/bridge/native/launcher", headers=_auth(editor_user)
    )
    assert downloaded.status_code == 200
    prepare.assert_not_awaited()
    path = f"/api/netplay/bridge/rooms/{room['id']}/native"
    issued = client.post(
        path + "/ticket",
        json={"rom_id": rom.id, "platform": "windows-x86_64"},
        headers=_auth(editor_user),
    )
    assert issued.status_code == 200
    assert issued.headers["cache-control"] == "no-store"
    prepare.assert_not_awaited()
    header = {"X-Netplay-Launch": issued.json()["ticket"]}
    status = client.get(path + "/ticket", headers=header | _auth(editor_user))
    assert status.json() == {"status": "waiting", "session": None}
    assert (
        client.get(path + "/ticket", headers=header | _auth(viewer_user)).status_code
        == 410
    )
    if lost_access:
        _hide(PermEntity.ROMS, rom.id, editor_user.id)
    claimed = client.post(path + "/claim", headers=header)
    if lost_access:
        assert claimed.status_code == 404
        prepare.assert_not_awaited()
        manifest.assert_not_awaited()
        return
    assert claimed.status_code == 200
    assert prepare.call_args.args[0].user.id == editor_user.id
    assert prepare.call_args.args[2].rom_id == rom.id
    assert claimed.headers["cache-control"] == "no-store"
    assert client.post(path + "/claim", headers=header).status_code == 410
    status = client.get(path + "/ticket", headers=header | _auth(editor_user))
    assert status.json()["session"]["player"] == 1


@pytest.mark.parametrize("system", ["gb", "gba"])
@pytest.mark.parametrize("prepared", [False, True])
def test_link_room_accepts_selected_game_and_preserves_descriptor(
    client, viewer_user, editor_user, rom, second_rom, relay, mocker, system, prepared
):
    mocker.patch("endpoints.netplay.bridge_system", return_value=system)
    room = gateway_room(rom.id, str(editor_user.id)) | {
        "system": system,
        "collectCartridges": True,
        "contentPrepared": prepared,
    }
    mocker.patch("endpoints.netplay.bridge_rooms", AsyncMock(return_value=[room]))
    mocker.patch("endpoints.netplay.bridge_room", AsyncMock(return_value=room))
    relay.return_value = {
        "id": "room-1",
        "peerPath": "/v1/rooms/room-1/peer?token=single-use",
        "tcpPort": 55435,
        "password": "",
        "players": 2,
        "player": 1,
    }
    cartridge = {"romId": second_rom.id, "sha256": "a" * 64, "size": 32768, "crc32": 2}
    listing = client.get(
        f"/api/netplay/bridge/rooms?rom_id={second_rom.id}", headers=_auth(viewer_user)
    )
    assert listing.status_code == 200
    assert listing.json()[0]["collect_cartridges"] is True
    response = client.post(
        "/api/netplay/bridge/rooms/room-1/join",
        json={"rom_id": second_rom.id, "cartridge": cartridge},
        headers=_auth(viewer_user),
    )
    assert response.status_code == 200
    assert relay.call_args.args[2]["cartridge"] == cartridge
    _hide(PermEntity.ROMS, second_rom.id, editor_user.id)
    response = client.post(
        "/api/netplay/bridge/rooms/room-1/join",
        json={"rom_id": second_rom.id, "cartridge": cartridge},
        headers=_auth(viewer_user),
    )
    assert response.status_code == 409
    assert "everyone" in response.json()["detail"]


def test_prepared_link_room_requires_the_guests_selected_descriptor(
    client, viewer_user, rom, second_rom, relay, mocker
):
    room = gateway_room(rom.id) | {
        "system": "gb",
        "collectCartridges": True,
        "contentPrepared": True,
    }
    mocker.patch("endpoints.netplay.bridge_room", AsyncMock(return_value=room))
    response = client.post(
        "/api/netplay/bridge/rooms/room-1/join",
        json={"rom_id": second_rom.id},
        headers=_auth(viewer_user),
    )
    assert response.status_code == 422
    relay.assert_not_awaited()


def test_sameboy_room_collects_distinct_gb_and_gbc_cartridges(
    client, viewer_user, rom, second_rom, relay
):
    relay.return_value = connection()
    cartridges = [
        {"romId": item.id, "sha256": digest * 64, "size": 32768, "crc32": crc}
        for item, digest, crc in [(rom, "a", 15), (second_rom, "b", 16)]
    ]
    response = client.post(
        "/api/netplay/bridge/rooms",
        json=create_body(rom.id)
        | {"cartridges": cartridges, "collectCartridges": True, "maxPrediction": 12},
        headers=_auth(viewer_user),
    )
    assert response.status_code == 200
    payload = relay.call_args.args[2]
    assert payload["collectCartridges"] is True
    assert payload["cartridges"] == cartridges


def test_native_preparation_binds_authenticated_account(
    client, viewer_user, rom, relay, mocker
):
    room = gateway_room(rom.id) | {"coreVersion": "1.0.4c87d256-rollback2"}
    mocker.patch("endpoints.netplay.bridge_room", AsyncMock(return_value=room))
    gateway = mocker.patch(
        "handler.netplay_launch_handler.bridge_request",
        AsyncMock(
            return_value={
                "player": 1,
                "credential": "a" * 32,
                "nativePassword": "b" * 32,
                "tcpPort": 55435,
                "expiresAt": 9999999999999,
            }
        ),
    )
    mocker.patch("handler.netplay_launch_handler.redis_client.set")
    mocker.patch("handler.netplay_launch_handler.redis_client.get", return_value=None)
    response = client.post(
        "/api/netplay/bridge/rooms/room-1/native",
        json={"rom_id": rom.id, "platform": "windows-x86_64", "battery": "AQID"},
        headers=_auth(viewer_user),
    )
    assert response.status_code == 200
    assert response.json()["player"] == 1
    assert gateway.call_args.args[2]["owner"] == str(viewer_user.id)
    assert gateway.call_args.args[2]["battery"] == "AQID"
    assert gateway.call_args.args[2]["clientPlatform"] == "windows-x86_64"
