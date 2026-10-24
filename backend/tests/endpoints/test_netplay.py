from unittest.mock import AsyncMock, patch

import pytest

from endpoints.netplay import _is_room_open, _link_roms
from handler.netplay_handler import LinkCartridge, NetplayPlayerInfo, NetplayRoom


def room(game_id: str, *, full: bool = False) -> NetplayRoom:
    players: dict[str, NetplayPlayerInfo] = {
        "host": {
            "socketId": "host-socket",
            "player_name": "Host",
            "userid": "host",
            "playerId": None,
        }
    }
    return NetplayRoom(
        owner="host-socket",
        players=players,
        peers=[],
        room_name="Trade",
        game_id=game_id,
        domain=None,
        password="test-password",
        max_players=1 if full else 2,
    )


@pytest.mark.parametrize(
    "game_id",
    ["19", "link:19", "link:0:20", "link:19:-1", "link:19:20:21", "link:１９:20"],
)
def test_invalid_link_room_ids(game_id: str):
    assert _link_roms(game_id) is None


def test_room_list_discovers_a_link_room_from_the_guest_game(client, access_token: str):
    rooms = {
        "stream": room("20"),
        "link": room("link:19:20"),
        "other_guest": room("link:20:19"),
        "full": room("link:19:20", full=True),
    }
    headers = {"Authorization": f"Bearer {access_token}"}
    with patch(
        "endpoints.netplay.netplay_handler.get_all", AsyncMock(return_value=rooms)
    ):
        legacy = client.get(
            "/api/netplay/list", params={"game_id": "20"}, headers=headers
        )
        assert legacy.status_code == 200
        assert set(legacy.json()) == {"stream"}
        assert "link_roms" not in legacy.json()["stream"]

        linked = client.get(
            "/api/netplay/list",
            params={"game_id": "20", "include_link": True},
            headers=headers,
        )
        assert linked.status_code == 200
        assert set(linked.json()) == {"stream", "link"}
        assert linked.json()["link"]["link_roms"] == [19, 20]
        assert linked.json()["link"]["hasPassword"] is True
        assert "test-password" not in linked.text

        exact = client.get(
            "/api/netplay/list", params={"game_id": "link:19:20"}, headers=headers
        )
        assert set(exact.json()) == {"link"}


def test_room_list_requires_authentication(client):
    assert (
        client.get(
            "/api/netplay/list", params={"game_id": "20", "include_link": True}
        ).status_code
        == 401
    )


def test_automatic_rooms_accept_another_game_on_the_same_link_system(
    client, access_token: str
):
    gold = LinkCartridge(id=19, system="gb", name="Gold")
    ruby = LinkCartridge(id=22, system="gba", name="Ruby")
    gb_room = room("link:auto:19")
    gb_room["link_cartridge"] = gold
    gba_room = room("link:auto:22")
    gba_room["link_cartridge"] = ruby
    headers = {"Authorization": f"Bearer {access_token}"}
    with (
        patch(
            "endpoints.netplay.netplay_handler.get_all",
            AsyncMock(return_value={"gb": gb_room, "gba": gba_room}),
        ),
        patch("endpoints.netplay.get_link_cartridge", return_value=gold),
    ):
        response = client.get(
            "/api/netplay/list",
            params={"game_id": "20", "include_link": True},
            headers=headers,
        )
    assert response.status_code == 200
    assert set(response.json()) == {"gb"}
    assert response.json()["gb"]["link_host_rom"] == 19
    assert response.json()["gb"]["link_game_name"] == "Gold"


def test_started_link_room_is_hidden_even_below_capacity():
    started = room("link:auto:22")
    started["max_players"] = 4
    started["link_started"] = True
    assert not _is_room_open(started, "link:auto:22")
