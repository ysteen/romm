"""Expiring CIA exports and narrowly scoped download links for handhelds."""

import hashlib
import json
import secrets
import time
from pathlib import Path

from config import ROMFORGE_INSTALL_CACHE_SIZE, ROMFORGE_INSTALL_TTL, ROMFORGE_WORK_PATH
from handler.auth.permissions import resolve_permissions
from handler.database import db_user_handler
from handler.redis_handler import redis_client


def export_path(key: str) -> Path:
    if len(key) != 64 or any(c not in "0123456789abcdef" for c in key):
        raise ValueError("Invalid export key")
    return ROMFORGE_WORK_PATH / "installs" / f"{key}.cia"


def describe_export(key: str) -> dict:
    return {
        "download_ready": True,
        "export_key": key,
        "output_file_name": "install.cia",
        "reused": False,
    }


def issue_link(job, file_id: int) -> dict:
    result = job.return_value()
    if job.get_status() != "finished" or not result or not result.get("export_key"):
        raise ValueError("CIA export is not ready")
    path = export_path(result["export_key"])
    if not path.is_file():
        raise ValueError("CIA export expired; request it again")
    expires = int(time.time()) + ROMFORGE_INSTALL_TTL
    token = secrets.token_urlsafe(32)
    record = {
        "file_id": file_id,
        "owner_id": job.meta["owner_id"],
        "key": result["export_key"],
        "source_fingerprint": job.args[0]["source_fingerprint"],
    }
    redis_client.set(
        "romforge:download:" + hashlib.sha256(token.encode()).hexdigest(),
        json.dumps(record),
        ex=ROMFORGE_INSTALL_TTL,
    )
    redis_client.set(
        "romforge:lease:" + result["export_key"], "1", ex=ROMFORGE_INSTALL_TTL
    )
    return {
        "path": f"/api/roms/install-download/{token}/install.cia",
        "expires_at": expires,
    }


def resolve_link(token: str) -> Path:
    from handler import patch_jobs

    raw = redis_client.get(
        "romforge:download:" + hashlib.sha256(token.encode()).hexdigest()
    )
    if not raw:
        raise ValueError("Download link expired")
    record = json.loads(raw)
    user = db_user_handler.get_user(record["owner_id"])
    if not user or not user.enabled:
        raise ValueError("Download unavailable")
    perms = resolve_permissions(user)
    from handler.auth.constants import Scope
    from handler.auth.permissions import compute_oauth_scopes

    if Scope.ROMS_READ not in compute_oauth_scopes(user):
        raise ValueError("Download permission revoked")
    _, source = patch_jobs.visible_input(record["file_id"], perms)
    if patch_jobs.fingerprint(source) != record["source_fingerprint"]:
        raise ValueError("Source changed")
    path = export_path(record["key"])
    if not path.is_file():
        raise ValueError("Download expired")
    # Range retries on slow handheld connections retain the same cached file.
    redis_client.set("romforge:lease:" + record["key"], "1", ex=ROMFORGE_INSTALL_TTL)
    return path


def cleanup_exports() -> None:
    now = time.time()
    for path in (ROMFORGE_WORK_PATH / "installs").glob("*.cia"):
        if (
            now - path.stat().st_mtime > ROMFORGE_INSTALL_TTL
            and not redis_client.exists("romforge:lease:" + path.stem)
        ):
            path.unlink(missing_ok=True)


def reserve_export(size: int) -> None:
    cleanup_exports()
    used = sum(
        p.stat().st_size for p in (ROMFORGE_WORK_PATH / "installs").glob("*.cia")
    )
    if used + size > ROMFORGE_INSTALL_CACHE_SIZE:
        raise ValueError(
            "Temporary CIA cache is full; wait for existing links to expire"
        )
