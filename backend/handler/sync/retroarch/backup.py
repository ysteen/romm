"""Preserve WebDAV overwrite backups outside the active sync manifest."""

import asyncio
import os
from collections.abc import Callable
from io import BytesIO
from typing import BinaryIO
from urllib.parse import unquote, urlsplit

from fastapi import UploadFile

from handler.filesystem import fs_asset_handler, fs_retroarch_sync_handler
from handler.sync.retroarch import dosbox, psp, sync_handler
from models.rom import Rom
from models.user import User


def destination_path(destination: str, source_url: str, source_path: str) -> str:
    """Validate a same-server destination under the client's deleted/ collection."""
    target = urlsplit(destination)
    source = urlsplit(source_url)
    if (
        not destination
        or target.query
        or target.fragment
        or (target.scheme and target.scheme != source.scheme)
        or (target.netloc and target.netloc != source.netloc)
    ):
        raise ValueError("Invalid backup destination")
    prefix = unquote(source.path).removesuffix(source_path)
    path = unquote(target.path)
    if not path.startswith(prefix):
        raise ValueError("Destination is outside the sync endpoint")
    path = path[len(prefix) :]
    parts = sync_handler.split_segments(path)
    if not parts or len(parts) < 2 or parts[0] != sync_handler.BACKUP_CATEGORY:
        raise ValueError("Destination must be a backup path")
    return "/".join(parts)


async def _open_source(
    user: User, path: str, can_see: Callable[[Rom], bool]
) -> BinaryIO | None:
    blob = sync_handler.parse_retroarch_sync_blob_path(path, include_backups=True)
    if blob:
        full_path = fs_retroarch_sync_handler.validate_path(
            sync_handler.user_blob_path(user, blob)
        )
    elif dosbox_path := dosbox.resolve_dosbox_path(path):
        return await dosbox.get_dosbox_file(user, dosbox_path, can_see)
    elif psp_path := psp.resolve_psp_path(path):
        if psp_path == "ignore":
            return None
        data = await psp.get_psp_file(user, psp_path, can_see)
        return BytesIO(data) if data is not None else None
    else:
        parsed = sync_handler.parse_retroarch_sync_path(path)
        if not parsed:
            return None
        rom = await asyncio.to_thread(
            sync_handler.resolve_rom,
            sync_handler.game_name_from_file_name(parsed.kind, parsed.file_name),
            can_see,
        )
        if not rom:
            return None
        resolver = (
            sync_handler.resolve_save
            if parsed.kind == "saves"
            else (
                sync_handler.resolve_state_screenshot_by_slot
                if parsed.is_state_screenshot
                else sync_handler.resolve_state_by_slot
            )
        )
        asset = await asyncio.to_thread(
            resolver, user, rom, parsed.emulator, parsed.file_name
        )
        if not asset or asset.missing_from_fs:
            return None
        full_path = fs_asset_handler.validate_path(asset.full_path)
    return await asyncio.to_thread(full_path.open, "rb")


async def copy_backup(
    user: User,
    source: str,
    destination: str,
    can_see: Callable[[Rom], bool],
    *,
    overwrite: bool,
) -> bool:
    """Copy a user's current sync file to a backup, returning whether it replaced one."""
    stream = await _open_source(user, source, can_see)
    if stream is None:
        raise FileNotFoundError(source)
    try:
        path = sync_handler.user_blob_path(user, destination)
        existed = await fs_retroarch_sync_handler.file_exists(path)
        await fs_retroarch_sync_handler.write_file(
            UploadFile(stream),
            os.path.dirname(path),
            os.path.basename(path),
            overwrite=overwrite,
        )
        return existed
    finally:
        stream.close()
