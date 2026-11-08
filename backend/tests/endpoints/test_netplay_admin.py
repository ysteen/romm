from unittest.mock import AsyncMock

import pytest
from fakeredis import FakeRedis
from pydantic import ValidationError
from tests.endpoints.test_netplay import _auth

from endpoints.responses.netplay_bridge import BridgeNetworkSettings
from handler import netplay_admin_handler as admin
from handler import netplay_bridge_handler as bridge
from handler import netplay_settings_handler as settings
from handler.auth.constants import FULL_SCOPES

RUNTIME = {"roomsEnabled": True, "maxRooms": 4, "saveIntervalSeconds": 20}
NETWORK = {"public_url": "https://play.example/bridge", "native_host": "native.example"}


@pytest.fixture
def admin_relay(mocker):
    mocker.patch.object(settings, "redis_client", FakeRedis())
    mocker.patch.object(
        bridge, "NETPLAY_BRIDGE_PUBLIC_URL", "https://default.example/bridge"
    )
    mocker.patch.object(bridge, "NETPLAY_BRIDGE_PUBLIC_HOST", "default.example")
    mocker.patch.object(bridge, "NETPLAY_BRIDGE_URL", "http://bridge:8080")
    mocker.patch.object(
        admin, "NETPLAY_BRIDGE_PUBLIC_URL", "https://default.example/bridge"
    )
    mocker.patch.object(admin, "NETPLAY_BRIDGE_PUBLIC_HOST", "default.example")
    mocker.patch.object(admin, "NETPLAY_BRIDGE_URL", "http://bridge:8080")
    return mocker.patch.object(
        bridge, "bridge_request", AsyncMock(return_value={"settings": RUNTIME})
    )


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("GET", "", None),
        ("GET", "/logs", None),
        ("GET", "/context", None),
        ("GET", "/ui/", None),
        ("GET", "/ui/admin.js", None),
        ("PUT", "/settings", RUNTIME),
        ("PUT", "/network", NETWORK),
        ("POST", "/saves/sync", None),
    ],
)
def test_management_requires_an_admin_role_not_only_requested_scopes(
    client, viewer_user, admin_relay, method, path, body
):
    url = "/api/netplay/bridge/admin" + path
    assert client.request(method, url, json=body).status_code == 401
    assert (
        client.request(method, url, json=body, headers=_auth(viewer_user)).status_code
        == 403
    )
    assert (
        client.request(
            method, url, json=body, headers=_auth(viewer_user, FULL_SCOPES)
        ).status_code
        == 403
    )
    admin_relay.assert_not_called()
    assert settings.network_settings() == BridgeNetworkSettings()


@pytest.mark.parametrize(
    "asset,media_type",
    [
        ("", "text/html"),
        ("index.html", "text/html"),
        ("admin.js", "text/javascript"),
        ("admin.css", "text/css"),
    ],
)
def test_admin_ui_is_fetched_from_the_configured_bridge(
    client, admin_user, admin_relay, asset, media_type
):
    content = b"bridge-owned-ui"
    admin_relay.return_value = content
    result = client.get(
        "/api/netplay/bridge/admin/ui/" + asset, headers=_auth(admin_user)
    )
    assert result.status_code == 200
    assert result.content == content
    assert result.headers["content-type"].startswith(media_type)
    assert result.headers["cache-control"] == "no-store"
    assert result.headers["x-content-type-options"] == "nosniff"
    assert "script-src 'self'" in result.headers["content-security-policy"]
    admin_relay.assert_awaited_once_with(
        "GET",
        "/admin/ui/" + (asset or "index.html"),
        response_limit=256 * 1024,
        raw_response=True,
    )


@pytest.mark.parametrize("asset", ["server.mjs", "nested/admin.js", "settings.json"])
def test_admin_ui_cannot_proxy_arbitrary_bridge_paths(
    client, admin_user, admin_relay, asset
):
    response = client.get(
        "/api/netplay/bridge/admin/ui/" + asset, headers=_auth(admin_user)
    )
    assert response.status_code == 404
    admin_relay.assert_not_called()


def test_admin_context_contains_only_application_integration_metadata(
    client, admin_user, admin_relay
):
    result = client.get("/api/netplay/bridge/admin/context", headers=_auth(admin_user))
    assert result.status_code == 200
    assert result.headers["cache-control"] == "no-store"
    assert result.json() == {
        "application_name": "RomM",
        "application_url": "/",
        "csrf_cookie": "romm_csrftoken",
        "csrf_header": "x-csrftoken",
    }
    admin_relay.assert_not_called()


def test_admin_reads_status_logs_and_updates_the_actual_runtime(
    client, admin_user, admin_relay
):
    headers = _auth(admin_user)
    result = client.get("/api/netplay/bridge/admin", headers=headers)
    assert result.status_code == 200
    assert result.headers["cache-control"] == "no-store"
    assert result.json()["public_url"] == "https://default.example/bridge"
    assert "token" not in result.text.lower()
    assert (
        client.get(
            "/api/netplay/bridge/admin/logs?after=3", headers=headers
        ).status_code
        == 200
    )
    assert admin_relay.call_args.args == ("GET", "/admin/logs?after=3")
    assert (
        client.put(
            "/api/netplay/bridge/admin/settings", json=RUNTIME, headers=headers
        ).status_code
        == 200
    )
    assert admin_relay.call_args.args == ("PUT", "/admin/settings", RUNTIME)
    assert (
        client.put(
            "/api/netplay/bridge/admin/settings",
            json=RUNTIME | {"maxRooms": 100},
            headers=headers,
        ).status_code
        == 422
    )


def test_public_addresses_persist_apply_to_new_connections_and_can_reset(
    client, admin_user, admin_relay
):
    headers = _auth(admin_user)
    assert (
        client.put(
            "/api/netplay/bridge/admin/network", json=NETWORK, headers=headers
        ).status_code
        == 200
    )
    connection = bridge.bridge_connection(
        {
            "id": "room",
            "hostPath": "/v1/rooms/room/host?token=room-token",
            "tcpPort": 55435,
            "players": 2,
        }
    )
    assert connection.websocket_url.startswith("wss://play.example/bridge/")
    assert connection.native_host == "native.example"
    assert settings.redis_client.ttl(settings.SETTINGS_KEY) == -1
    assert (
        client.put(
            "/api/netplay/bridge/admin/network", json={}, headers=headers
        ).status_code
        == 200
    )
    assert settings.public_addresses("https://fallback", "host") == (
        "https://fallback",
        "host",
    )


@pytest.mark.parametrize(
    "value",
    [
        {"public_url": "https://name:secret@example.org"},
        {"public_url": "javascript:alert(1)"},
        {"public_url": "https://example.org/?token=secret"},
        {"public_url": "https://example.org:invalid"},
        {"native_host": "host:55435"},
        {"native_host": "host/another"},
        {"native_host": "host\n"},
    ],
)
def test_connection_settings_reject_credentials_and_invalid_addresses(value):
    with pytest.raises(ValidationError):
        BridgeNetworkSettings(**value)


def test_admin_can_retry_pending_saves(client, admin_user, admin_relay, mocker):
    sync = mocker.patch(
        "endpoints.netplay.server_saves.sync_pending",
        AsyncMock(return_value={"saved": 2, "pending": 0}),
    )
    response = client.post(
        "/api/netplay/bridge/admin/saves/sync", headers=_auth(admin_user)
    )
    assert response.status_code == 200
    assert response.json() == {"saved": 2, "pending": 0}
    sync.assert_awaited_once_with()
