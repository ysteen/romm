from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from endpoints.sockets.netplay import (
    RoomData,
    join_room,
    link_ready,
    link_seat,
    link_start,
    open_room,
)
from handler.netplay_handler import LinkCartridge, NetplayRoom, get_link_cartridge


@pytest.mark.parametrize("rom_id", [None, True, "22", -1, 0, 2**53])
def test_invalid_cartridge_ids_do_not_query_the_library(rom_id: object):
    with patch("handler.netplay_handler.db_rom_handler.get_rom") as get_rom:
        assert get_link_cartridge(rom_id) is None
        get_rom.assert_not_called()


@pytest.mark.parametrize(
    ("platform", "filename", "system"),
    [
        ("gb", "Gold.gbc", "gb"),
        ("gbc", "Silver.GBC", "gb"),
        ("gba", "Ruby.gba", "gba"),
        ("gba", "Ruby.zip", "gba"),
        ("gba", "Game folder", "gba"),
        ("gbc", "Game folder", "gb"),
        ("snes", "Game.gba", None),
        ("gbc", "Silver.ZIP", "gb"),
        ("gba", "Ruby.7z", "gba"),
        ("nds", "Game.zip", None),
        ("nds", "Game.nds", None),
        ("gb", "Game.gba", "gb"),
    ],
)
def test_cartridge_validation_uses_library_metadata(
    platform: str, filename: str, system: str | None
):
    with patch(
        "handler.netplay_handler.db_rom_handler.get_rom",
        return_value=SimpleNamespace(
            id=22,
            platform_slug=platform,
            fs_name=filename,
            name="Game",
        ),
    ):
        cartridge = get_link_cartridge(22)
    assert (cartridge["system"] if cartridge else None) == system


def room_data(player: str, rom_id: int, password: str = "secret") -> RoomData:
    return {
        "extra": {
            "sessionid": "link-room",
            "userid": player,
            "playerId": None,
            "cartridge_id": rom_id,
            "game_id": f"link:auto:{rom_id}",
            "room_password": password,
        },
        "maxPlayers": 4,
    }


@pytest.mark.parametrize("count", [2, 3, 4])
async def test_room_discovers_cartridges_and_waits_for_host(count: int):
    rooms: dict[str, NetplayRoom] = {}
    sessions: dict[str, dict[str, str]] = {}
    cartridges = {
        22: LinkCartridge(id=22, system="gba", name="Test 1"),
        21: LinkCartridge(id=21, system="gba", name="Test 2"),
        19: LinkCartridge(id=19, system="gb", name="Gold"),
    }

    async def set_room(key: str, value: NetplayRoom):
        rooms[key] = value

    async def save_session(sid: str, value: dict[str, str]):
        sessions[sid] = value

    with (
        patch(
            "endpoints.sockets.netplay.get_link_cartridge", side_effect=cartridges.get
        ),
        patch(
            "endpoints.sockets.netplay.netplay_handler.get",
            AsyncMock(side_effect=rooms.get),
        ),
        patch(
            "endpoints.sockets.netplay.netplay_handler.set",
            AsyncMock(side_effect=set_room),
        ),
        patch(
            "endpoints.sockets.netplay.netplay_socket_handler.socket_server.enter_room",
            AsyncMock(),
        ),
        patch(
            "endpoints.sockets.netplay.netplay_socket_handler.socket_server.save_session",
            AsyncMock(side_effect=save_session),
        ),
        patch(
            "endpoints.sockets.netplay.netplay_socket_handler.socket_server.get_session",
            AsyncMock(side_effect=sessions.get),
        ),
        patch(
            "endpoints.sockets.netplay.netplay_socket_handler.socket_server.emit",
            AsyncMock(),
        ) as emit,
    ):
        assert await open_room("host-socket", room_data("host", 22)) is None
        assert rooms["link-room"]["max_players"] == 4
        assert await link_start("host-socket") == "At least two players are required"
        assert (
            await join_room("guest-socket", room_data("guest", 21, "wrong"))
            == "Incorrect password"
        )
        assert (
            await join_room("guest-socket", room_data("guest", 19))
            == "Incompatible link cartridge"
        )
        assert list(rooms["link-room"]["players"]) == ["host"]
        result = await join_room("guest-socket", room_data("guest", 21))
        assert isinstance(result, tuple) and result[0] is None
        players = rooms["link-room"]["players"]
        assert [player["cartridge"]["id"] for player in players.values()] == [22, 21]
        assert not any(player["link_ready"] for player in players.values())
        assert await link_ready("guest-socket") == "Link room not found"
        assert await link_start("guest-socket") == "Only the host can start the game"
        for slot in range(2, count):
            result = await join_room(f"guest-{slot}", room_data(f"guest-{slot}", 21))
            assert isinstance(result, tuple)
        if count == 4:
            assert await join_room("fifth", room_data("fifth", 21)) == "Room is full"
        assert not rooms["link-room"]["link_started"]
        assert all("link_slot" not in p for p in players.values())
        assert (
            await link_start("host-socket")
            == "Choose player slots starting from 1P without gaps"
        )
        assert await link_seat("guest-socket", {"slot": 0}) is None
        assert (
            await link_seat("guest-socket", {"slot": 1, "player_id": "host"})
            == "Only the host can change another player's slot"
        )
        assert (
            await link_seat("host-socket", {"slot": 0})
            == "This player slot is already taken"
        )
        for invalid in [True, -1, 4, "1"]:
            assert (
                await link_seat("host-socket", {"slot": invalid})
                == "Invalid player slot"
            )
        assert await link_seat("host-socket", {"slot": 3}) is None
        assert await link_seat("host-socket", {"slot": 3, "player_id": "guest"}) is None
        assert players["guest"]["link_slot"] == 3
        assert players["host"]["link_slot"] == 0
        assert await link_seat("host-socket", {"slot": 0, "player_id": "guest"}) is None
        assert players["guest"]["link_slot"] == 0
        assert players["host"]["link_slot"] == 3
        assert (
            await link_seat("host-socket", {"slot": None, "player_id": "guest"}) is None
        )
        assert "link_slot" not in players["guest"]
        assert await link_seat("host-socket", {"slot": 0, "player_id": "guest"}) is None
        assert (
            await link_seat("host-socket", {"slot": 1, "player_id": "absent"})
            == "Player not found"
        )
        if count < 4:
            assert (
                await link_start("host-socket")
                == "Choose player slots starting from 1P without gaps"
            )
        assert await link_seat("host-socket", {"slot": None}) is None
        assert "link_slot" not in players["host"]
        assert await link_seat("host-socket", {"slot": 0, "player_id": "host"}) is None
        assert "link_slot" not in players["guest"]
        assert await link_seat("host-socket", {"slot": 0, "player_id": "guest"}) is None
        assert "link_slot" not in players["host"]
        assert await link_seat("host-socket", {"slot": count - 1}) is None
        for slot in range(2, count):
            assert await link_seat(f"guest-{slot}", {"slot": slot - 1}) is None
        assert await link_start("host-socket") is None
        players = rooms["link-room"]["players"]
        assert players["host"]["is_host"] and players["host"]["link_slot"] == count - 1
        assert next(iter(players)) == "guest"
        assert (
            await link_seat("guest-socket", {"slot": None})
            == "This link game has already started"
        )
        assert [p["link_slot"] for p in players.values()] == list(range(count))
        emit.assert_awaited_with("link-started", players, room="link-room")
        assert await link_start("host-socket") == "This link game has already started"
        assert (
            await join_room("late", room_data("late", 21))
            == "This link game has already started"
        )
        await link_ready("guest-socket")
        assert players["guest"]["link_ready"] and not players["host"]["link_ready"]
        await link_ready("host-socket")
        for slot in range(2, count):
            await link_ready(f"guest-{slot}")
        assert all(player["link_ready"] for player in players.values())


@pytest.mark.parametrize(
    "system,capacity",
    [("gb", 3), ("gb", 4), ("gba", 1), ("gba", 5), ("gba", True), ("gba", "4")],
)
async def test_rejects_invalid_link_capacity(system, capacity):
    data = room_data("host", 22)
    data["maxPlayers"] = capacity
    with (
        patch(
            "endpoints.sockets.netplay.get_link_cartridge",
            return_value=LinkCartridge(id=22, system=system, name="Test"),
        ),
        patch(
            "endpoints.sockets.netplay.netplay_handler.get",
            AsyncMock(return_value=None),
        ),
        patch("endpoints.sockets.netplay.netplay_handler.set", AsyncMock()) as store,
    ):
        assert await open_room("host", data) == "Unsupported link player count"
        store.assert_not_awaited()


@pytest.mark.parametrize("system", ["gb", "gba"])
async def test_concurrent_joins_and_slot_claims_are_serialized(system):
    import asyncio

    from handler.netplay_handler import netplay_handler

    sessions = {}

    async def save_session(sid, value):
        sessions[sid] = value

    await netplay_handler.delete(["link-room"])
    host = room_data("host", 22)
    host["maxPlayers"] = 2
    with (
        patch(
            "endpoints.sockets.netplay.get_link_cartridge",
            return_value=LinkCartridge(id=22, system=system, name="Test"),
        ),
        patch(
            "endpoints.sockets.netplay.netplay_socket_handler.socket_server.enter_room",
            AsyncMock(),
        ),
        patch(
            "endpoints.sockets.netplay.netplay_socket_handler.socket_server.emit",
            AsyncMock(),
        ),
        patch(
            "endpoints.sockets.netplay.netplay_socket_handler.socket_server.save_session",
            AsyncMock(side_effect=save_session),
        ),
        patch(
            "endpoints.sockets.netplay.netplay_socket_handler.socket_server.get_session",
            AsyncMock(side_effect=sessions.get),
        ),
    ):
        assert await open_room("host", host) is None
        results = await asyncio.gather(
            *(join_room(name, room_data(name, 22)) for name in ["guest-a", "guest-b"])
        )
        assert results.count("Room is full") == 1
        stored = await netplay_handler.get("link-room")
        assert stored is not None and len(stored["players"]) == 2
        if system == "gba":
            import asyncio

            ids = list(stored["players"])
            claims = await asyncio.gather(
                *(link_seat(name, {"slot": 0}) for name in ids)
            )
            assert claims.count("This player slot is already taken") == 1
            stored = await netplay_handler.get("link-room")
            assert stored is not None
            for name in ids:
                if "link_slot" not in stored["players"][name]:
                    assert await link_seat(name, {"slot": 1}) is None
            assert await link_start("host") is None
        assert await link_ready("host") is None
        stored = await netplay_handler.get("link-room")
        assert stored is not None and stored["players"]["host"]["link_ready"]
    await netplay_handler.delete(["link-room"])
