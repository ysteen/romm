from unittest.mock import AsyncMock

import pytest
from tests.endpoints.test_netplay import _auth, _hide, _override_emulation_read
from tests.factories import make_platform, make_rom

from endpoints.responses.wfc import WfcProfileResponse, WfcSessionResponse
from models.permission import PermEntity


@pytest.fixture
def ds_rom():
    return make_rom(make_platform("nds"), "wfc-test.nds")


@pytest.fixture
def session(mocker):
    return mocker.patch(
        "handler.wfc_handler.create_session",
        new_callable=AsyncMock,
        return_value=WfcSessionResponse(
            websocket_url="wss://relay.example/wfc",
            profile=WfcProfileResponse(mac="0209bf112233", firmware=""),
        ),
    )


def test_wfc_uses_authenticated_account(client, viewer_user, ds_rom, session):
    response = client.post(
        "/api/netplay/wfc/sessions",
        json={"rom_id": ds_rom.id},
        headers=_auth(viewer_user),
    )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    session.assert_awaited_once_with(viewer_user.id)


def test_wfc_cannot_open_hidden_game(client, viewer_user, ds_rom, session):
    _hide(PermEntity.ROMS, ds_rom.id, viewer_user.id)
    response = client.post(
        "/api/netplay/wfc/sessions",
        json={"rom_id": ds_rom.id},
        headers=_auth(viewer_user),
    )
    assert response.status_code == 404
    session.assert_not_awaited()


def test_wfc_requires_login(client, ds_rom, session):
    response = client.post("/api/netplay/wfc/sessions", json={"rom_id": ds_rom.id})
    assert response.status_code == 401
    session.assert_not_awaited()


def test_wfc_rejects_other_platform(client, viewer_user, rom, session):
    response = client.post(
        "/api/netplay/wfc/sessions", json={"rom_id": rom.id}, headers=_auth(viewer_user)
    )
    assert response.status_code == 422
    session.assert_not_awaited()


def test_wfc_respects_emulation_permission(client, viewer_user, ds_rom, session):
    _override_emulation_read(viewer_user)
    response = client.post(
        "/api/netplay/wfc/sessions",
        json={"rom_id": ds_rom.id},
        headers=_auth(viewer_user),
    )
    assert response.status_code == 403
    session.assert_not_awaited()
