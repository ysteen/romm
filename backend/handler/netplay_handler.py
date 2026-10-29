import json
from typing import Literal, NotRequired, TypedDict

from handler.database import db_rom_handler
from handler.redis_handler import async_cache


class LinkCartridge(TypedDict):
    id: int
    system: Literal["gb", "gba"]
    name: str


def get_link_cartridge(rom_id: object) -> LinkCartridge | None:
    if type(rom_id) is not int or not 0 < rom_id <= 2**53 - 1:
        return None
    rom = db_rom_handler.get_rom(rom_id)
    if not rom:
        return None
    system: Literal["gb", "gba"]
    if rom.platform_slug == "gba":
        system = "gba"
    elif rom.platform_slug in ("gb", "gbc"):
        system = "gb"
    else:
        return None
    return LinkCartridge(id=rom.id, system=system, name=rom.name or rom.fs_name)


class NetplayPlayerInfo(TypedDict):
    socketId: str
    player_name: str
    userid: str | None
    playerId: str | None
    cartridge: NotRequired[LinkCartridge]
    link_ready: NotRequired[bool]
    link_slot: NotRequired[int]
    is_host: NotRequired[bool]


class NetplayRoom(TypedDict):
    owner: str
    players: dict[str, NetplayPlayerInfo]
    peers: list[str]
    room_name: str
    game_id: str
    domain: str | None
    password: str | None
    max_players: int
    link_cartridge: NotRequired[LinkCartridge]
    link_started: NotRequired[bool]


class NetplayHandler:
    """A class to handle netplay rooms in Redis."""

    def __init__(self):
        self.hash_name = "netplay:rooms"

    def lock(self, room_id: str):
        return async_cache.lock(
            f"{self.hash_name}:lock:{room_id}", timeout=15, blocking_timeout=10
        )

    async def get(self, room_id: str) -> NetplayRoom | None:
        """Get a room from Redis."""
        room = await async_cache.hget(self.hash_name, room_id)
        return json.loads(room) if room else None

    async def set(self, room_id: str, room_data: NetplayRoom):
        """Set a room in Redis."""
        return await async_cache.hset(self.hash_name, room_id, json.dumps(room_data))

    async def delete(self, room_ids: list[str]):
        """Delete a room from Redis."""
        return await async_cache.hdel(self.hash_name, *room_ids)

    async def get_all(self) -> dict[str, NetplayRoom]:
        """Get all rooms from Redis."""
        rooms = await async_cache.hgetall(self.hash_name)
        return {room_id: json.loads(room_data) for room_id, room_data in rooms.items()}


netplay_handler = NetplayHandler()
