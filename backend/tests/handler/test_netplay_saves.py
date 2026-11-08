import hashlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fakeredis import FakeRedis
from fastapi import HTTPException

from handler import netplay_launch_handler as launch
from handler import netplay_save_handler as saves
from handler.auth.constants import Scope


@pytest.fixture
def save_store(mocker):
    redis = FakeRedis()
    mocker.patch.object(saves, "redis_client", redis)
    mocker.patch.object(launch, "redis_client", redis)
    mocker.patch.object(redis, "lock")
    user = SimpleNamespace(id=3, oauth_scopes=[Scope.ASSETS_WRITE])
    mocker.patch.object(saves.db_user_handler, "get_user", return_value=user)
    mocker.patch.object(
        launch.db_rom_handler,
        "get_rom",
        return_value=SimpleNamespace(
            id=12,
            fs_name_no_ext="Pokemon Emerald",
            platform=SimpleNamespace(fs_slug="gba"),
        ),
    )
    existing = mocker.patch.object(
        launch.db_save_handler, "get_save_by_filename", return_value=None
    )
    mocker.patch.object(
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
    reserve = mocker.patch.object(
        launch,
        "reserve_version_name",
        AsyncMock(return_value="Pokemon Emerald [2026-11-07_23-00-00].srm"),
    )
    content_hash = hashlib.md5(b"\x01\x02\x03", usedforsecurity=False).hexdigest()
    mocker.patch.object(
        launch,
        "scan_save",
        AsyncMock(
            return_value=SimpleNamespace(file_size_bytes=3, content_hash=content_hash)
        ),
    )
    entry = saves.BrokerSave(
        id="a" * 64,
        revision="b" * 32,
        roomId="closed-room",
        player=1,
        owner="3",
        romId=12,
        coreName="mGBA Splitscreen",
        generation=2,
        frame=60,
        battery="AQID",
    )
    saves.register_owner(
        entry.roomId, entry.player, entry.owner, entry.romId, "mgba_splitscreen"
    )
    return SimpleNamespace(
        redis=redis,
        user=user,
        existing=existing,
        write=write,
        entry=entry,
        content_hash=content_hash,
        reserve=reserve,
    )


async def test_closed_room_save_keeps_original_account_and_idempotent_order(save_store):
    store = save_store
    assert (await saves.consume(store.entry))["saved"]
    store.write.assert_awaited_once_with(
        b"\x01\x02\x03", "account-3/rom-12", "Pokemon Emerald [2026-11-07_23-00-00].srm"
    )
    saves.register_owner("closed-room", 1, "other-account", 12, "mgba_splitscreen")
    saves.register_owner("closed-room", 1, "3", 12, "mgba_splitscreen")
    assert (await saves.consume(store.entry))["saved"] is False
    assert (
        await saves.consume(
            store.entry.model_copy(update={"frame": 59, "battery": "BAUG"})
        )
    )["saved"] is False
    assert (
        await saves.consume(
            store.entry.model_copy(
                update={"generation": 1, "frame": 999, "battery": "BAUG"}
            )
        )
    )["saved"] is False
    store.write.assert_awaited_once()
    store.reserve.assert_awaited_once()
    key = saves._key("closed-room", 1, "3", 12)
    assert store.redis.ttl(key) == -1
    assert json.loads(store.redis.get(key))["frame"] == 60


@pytest.mark.parametrize(
    "change", [{"owner": "4"}, {"romId": 13}, {"player": 0}, {"coreName": "SameBoy"}]
)
async def test_server_save_rejects_an_unregistered_account_cartridge_or_player(
    save_store, change
):
    with pytest.raises(HTTPException):
        await saves.consume(save_store.entry.model_copy(update=change))
    save_store.write.assert_not_awaited()


async def test_revoked_permission_and_outside_edits_do_not_overwrite_saves(save_store):
    store = save_store
    store.user.oauth_scopes = []
    with pytest.raises(HTTPException) as error:
        await saves.consume(store.entry)
    assert error.value.status_code == 403
    store.user.oauth_scopes = [Scope.ASSETS_WRITE]
    store.existing.return_value = SimpleNamespace(
        id=55, content_hash="edited-elsewhere"
    )
    with pytest.raises(HTTPException) as error:
        await saves.consume(store.entry)
    assert "outside" in error.value.detail
    store.write.assert_not_awaited()


async def test_retry_after_database_commit_recovers_the_receipt_without_rewriting(
    save_store,
):
    store = save_store
    store.existing.return_value = SimpleNamespace(
        id=55, content_hash=store.content_hash
    )
    assert (await saves.consume(store.entry))["saved"] is False
    store.write.assert_not_awaited()
    key = saves._key("closed-room", 1, "3", 12)
    assert json.loads(store.redis.get(key))["content_hash"] == store.content_hash


async def test_rooms_reserve_separate_readable_versions_for_the_same_cartridge(
    save_store,
):
    store = save_store
    names = [
        "Pokemon Emerald [2026-11-07_23-00-00].srm",
        "Pokemon Emerald [2026-11-07_23-00-01].srm",
    ]
    store.reserve.side_effect = names
    await saves.consume(store.entry)
    second = store.entry.model_copy(update={"roomId": "another-room"})
    saves.register_owner(
        second.roomId, second.player, second.owner, second.romId, "mgba_splitscreen"
    )
    await saves.consume(second)
    assert [call.args[2] for call in store.write.await_args_list] == names


async def test_failed_write_reuses_the_reserved_name_on_retry(save_store):
    store = save_store
    store.write.side_effect = [OSError("Disk full"), None]
    with pytest.raises(OSError):
        await saves.consume(store.entry)
    await saves.consume(store.entry)
    store.reserve.assert_awaited_once()
    assert (
        store.write.await_args_list[0].args[2] == store.write.await_args_list[1].args[2]
    )


async def test_consumer_keeps_failed_jobs_and_drains_other_accounts(mocker, save_store):
    first = save_store.entry.model_dump()
    second = first | {"id": "c" * 64, "owner": "4"}
    values = [first, second]
    acknowledgements = []

    async def request(method, path, body=None, **kwargs):
        if method == "GET":
            return values.copy()
        acknowledgements.append(body)
        if not body["error"]:
            values[:] = [value for value in values if not path.endswith(value["id"])]
        return {"acknowledged": True}

    mocker.patch.object(saves, "bridge_enabled", return_value=True)
    mocker.patch.object(saves, "bridge_request", side_effect=request)
    mocker.patch.object(
        saves,
        "consume",
        AsyncMock(side_effect=[HTTPException(409, "Save conflict"), {"saved": True}]),
    )
    assert await saves.sync_pending() == {"saved": 1, "pending": 1}
    assert acknowledgements == [
        {"revision": first["revision"], "error": "Save conflict"},
        {"revision": second["revision"], "error": None},
    ]
    assert values == [first]
