"""Consume durable broker saves using account grants registered by RomM."""

import json
from typing import Any

from fastapi import HTTPException
from pydantic import Field

from endpoints.responses.netplay_bridge import BridgeNativeSaveRequest
from handler.auth.constants import Scope
from handler.database import db_user_handler
from handler.netplay_bridge_handler import ROOM_ID, bridge_enabled, bridge_request
from handler.netplay_launch_handler import CORE_IDS, persist_progress
from handler.redis_handler import redis_client
from logger.logger import log


class BrokerSave(BridgeNativeSaveRequest):
    id: str = Field(pattern=r"^[a-f0-9]{64}$")
    revision: str = Field(pattern=r"^[a-f0-9]{32}$")
    roomId: str = Field(pattern=ROOM_ID.pattern)
    romId: int = Field(gt=0, strict=True)
    coreName: str


def _key(room_id: str, player: int, owner: str, rom_id: int) -> str:
    return f"netplay-account-save:{room_id}:{player}:{owner}:{rom_id}"


def register_owner(
    room_id: str, player: int, owner: str, rom_id: int, core: str
) -> None:
    key = _key(room_id, player, owner, rom_id)
    redis_client.set(
        key,
        json.dumps(
            {
                "owner": owner,
                "rom_id": rom_id,
                "core": core,
                "frame": -1,
                "generation": -1,
            }
        ),
        nx=True,
    )


async def consume(entry: BrokerSave) -> dict[str, Any]:
    key = _key(entry.roomId, entry.player, entry.owner, entry.romId)
    lock = redis_client.lock(key + ":lock", timeout=60, blocking=False)
    if not lock.acquire():
        raise HTTPException(
            status_code=409, detail="Another room save is being written"
        )
    try:
        stored = redis_client.get(key)
        if not stored:
            raise HTTPException(
                status_code=409,
                detail="The original account's save permission is unavailable",
            )
        grant = json.loads(stored)
        if (
            grant["owner"] != entry.owner
            or grant["rom_id"] != entry.romId
            or grant["core"] != CORE_IDS.get(entry.coreName)
        ):
            raise HTTPException(
                status_code=409,
                detail="The snapshot does not match its original account and cartridge",
            )
        user = db_user_handler.get_user(int(entry.owner))
        if not user or Scope.ASSETS_WRITE not in user.oauth_scopes:
            raise HTTPException(
                status_code=403, detail="The original account cannot write saves"
            )
        if (entry.generation, entry.frame) < (grant["generation"], grant["frame"]):
            return {"saved": False}
        return await persist_progress(entry.roomId, entry, key, grant, lifetime=None)
    finally:
        lock.release()


async def sync_pending(room_id: str | None = None) -> dict[str, int]:
    if not bridge_enabled():
        return {"saved": 0, "pending": 0}
    path = "/save-queue" + (f"?room={room_id}" if room_id else "")
    saved = pending = 0
    seen: set[tuple[str, str]] = set()
    for _ in range(8):
        entries = await bridge_request("GET", path, response_limit=2 * 1024 * 1024)
        fresh = False
        for raw in entries:
            entry = BrokerSave.model_validate(raw)
            identity = (entry.id, entry.revision)
            if identity in seen:
                continue
            seen.add(identity)
            fresh = True
            error = None
            try:
                await consume(entry)
                saved += 1
            except HTTPException as exc:
                error = str(exc.detail)
            except Exception:
                log.exception("Could not persist a queued netplay save")
                error = "RomM could not write the save. The server will retry."
            if error:
                pending += 1
                if raw.get("error") != error:
                    log.warning(
                        f"Netplay save retained for retry: room={entry.roomId}, player={entry.player}, reason={error}"
                    )
            await bridge_request(
                "POST",
                f"/save-queue/{entry.id}",
                {"revision": entry.revision, "error": error},
            )
        if not fresh:
            break
    return {"saved": saved, "pending": pending}
