"""Expose DOSBox Pure directory-save bundles as native Cloud Sync files."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import zipfile
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from functools import partial
from tempfile import TemporaryFile
from typing import IO, BinaryIO

from fastapi import UploadFile
from handler.asset_store import reserve_version_name
from handler.database import db_rom_handler, db_save_handler
from handler.filesystem import fs_asset_handler
from handler.filesystem.assets_handler import MAX_DECOMPRESSED_ENTRY_BYTES
from handler.redis_handler import async_cache
from handler.sync.retroarch import sync_handler
from handler.sync.retroarch.emulator_names import (
    retroarch_aliases,
    to_retroarch_dir_name,
)
from logger.logger import log
from models.assets import AUTOSAVE_SLOT, Save, SaveLineage
from models.rom import Rom
from models.user import User
from utils.filesystem import check_filename_length, sanitize_filename
from utils.zip_cache import ensure_zipfile_writable

EMULATOR = "dosbox_pure"
SAVE_DIRECTORY = to_retroarch_dir_name(EMULATOR)
EMULATOR_ALIASES = retroarch_aliases(EMULATOR)
_PLATFORMS = frozenset({"dos", "win", "pc"})
_MEMBER_SUFFIX = re.compile(
    r"^(?P<stem>.+?)(?:\.(?:pure\.zip|sav\.zip|sav|srm)|-(?:[A-Z]DRIVE|[0-9A-F]{8})\.sav)$",
    re.IGNORECASE,
)
_MAX_MEMBERS = 128
_MAX_BUNDLE_BYTES = 4 * 1024**3
_CHUNK_BYTES = 1024 * 1024


class DosboxBundleInvalid(ValueError):
    """A bundle cannot be read or safely merged."""


@dataclass(frozen=True)
class DosboxFilePath:
    game_name: str
    file_name: str


def resolve_dosbox_path(file_path: str) -> DosboxFilePath | None:
    parts = sync_handler.split_segments(file_path)
    if parts is None or len(parts) != 3 or parts[0] != "saves":
        return None
    if parts[1] not in EMULATOR_ALIASES:
        return None
    name = parts[-1]
    if "\\" in name or sanitize_filename(name) != name:
        return None
    match = _MEMBER_SUFFIX.fullmatch(name)
    if match is None:
        return None
    return DosboxFilePath(match["stem"], name)


def _resolve_rom(game_name: str, can_see: Callable[[Rom], bool]) -> Rom | None:
    candidates = db_rom_handler.get_roms_by_fs_names_no_ext({game_name})
    visible = [r for r in candidates if r.platform_slug in _PLATFORMS and can_see(r)]
    return next(
        (r for r in visible if r.fs_name_no_ext == game_name), next(iter(visible), None)
    )


def is_dosbox_bundle(save: Save) -> bool:
    return (
        save.emulator in (*EMULATOR_ALIASES, None)
        and save.rom.platform_slug in _PLATFORMS
        and save.file_extension.lower() in ("zip", "srm")
        and not save.file_name.lower().endswith((".pure.zip", ".sav.zip"))
    )


def _latest_bundles(
    user: User, can_see: Callable[[Rom], bool], rom_id: int | None = None
) -> list[Save]:
    saves = db_save_handler.get_saves(
        user_id=user.id,
        rom_ids=[rom_id] if rom_id is not None else None,
        slot=AUTOSAVE_SLOT,
        with_unslotted=True,
        lineages=[
            SaveLineage(core, ext)
            for core in (*EMULATOR_ALIASES, None)
            for ext in ("zip", "srm")
        ],
    )
    latest: dict[int, Save] = {}
    for save in saves:
        if not is_dosbox_bundle(save) or not can_see(save.rom):
            continue
        current = latest.get(save.rom_id)
        key = (save.slot == AUTOSAVE_SLOT, *sync_handler.recency_key(save))
        if current is None or key > (
            current.slot == AUTOSAVE_SLOT,
            *sync_handler.recency_key(current),
        ):
            latest[save.rom_id] = save
    return list(latest.values())


def _find_bundle(user: User, rom: Rom) -> Save | None:
    return next(iter(_latest_bundles(user, lambda _: True, rom.id)), None)


def _members(archive: zipfile.ZipFile, stem: str) -> dict[str, zipfile.ZipInfo]:
    result: dict[str, zipfile.ZipInfo] = {}
    total = 0
    for entry in archive.infolist():
        if entry.is_dir():
            continue
        name = entry.filename
        if name.startswith(f"{SAVE_DIRECTORY}/"):
            name = name[len(SAVE_DIRECTORY) + 1 :]
        parsed = resolve_dosbox_path(f"saves/{SAVE_DIRECTORY}/{name}")
        if (
            parsed is None
            or parsed.game_name.casefold() != stem.casefold()
            or name in result
            or "/" in name
            or entry.external_attr >> 16 & 0o170000 == 0o120000
            or entry.flag_bits & 1
        ):
            raise DosboxBundleInvalid(
                f"Invalid DOSBox Pure bundle member: {entry.filename}"
            )
        total += entry.file_size
        if entry.file_size > MAX_DECOMPRESSED_ENTRY_BYTES or total > _MAX_BUNDLE_BYTES:
            raise DosboxBundleInvalid("DOSBox Pure bundle exceeds the size limit")
        result[name] = entry
        if len(result) > _MAX_MEMBERS:
            raise DosboxBundleInvalid("Too many DOSBox Pure bundle members")
    return result


@contextmanager
def _open_bundle(
    bundle: Save | None, stem: str
) -> Iterator[tuple[zipfile.ZipFile | None, dict[str, zipfile.ZipInfo]]]:
    if bundle is None:
        yield None, {}
        return
    try:
        with zipfile.ZipFile(
            fs_asset_handler.validate_path(bundle.full_path)
        ) as archive:
            yield archive, _members(archive, stem)
    except (OSError, zipfile.BadZipFile, RuntimeError) as exc:
        raise DosboxBundleInvalid(f"Unreadable DOSBox Pure bundle {bundle.id}") from exc


def _copy_member(
    source: IO[bytes], destination: IO[bytes] | None = None
) -> tuple[int, str]:
    digest = hashlib.md5(usedforsecurity=False)
    size = 0
    while chunk := source.read(_CHUNK_BYTES):
        size += len(chunk)
        if size > MAX_DECOMPRESSED_ENTRY_BYTES:
            raise DosboxBundleInvalid("DOSBox Pure member exceeds the size limit")
        digest.update(chunk)
        if destination is not None:
            destination.write(chunk)
    return size, digest.hexdigest()


def _merge_bundle(
    bundle: Save | None, info: DosboxFilePath, body: BinaryIO | None
) -> tuple[BinaryIO, str, int]:
    ensure_zipfile_writable()
    output = TemporaryFile()
    try:
        digests: dict[str, str] = {}
        total = 0
        with (
            _open_bundle(bundle, info.game_name) as (source, members),
            zipfile.ZipFile(output, "w", zipfile.ZIP_STORED) as target,
        ):
            names = set(members) | ({info.file_name} if body is not None else set())
            if body is None:
                names.discard(info.file_name)
            if len(names) > _MAX_MEMBERS:
                raise DosboxBundleInvalid("Too many DOSBox Pure bundle members")
            for name in sorted(names):
                destination_name = f"{SAVE_DIRECTORY}/{name}"
                with target.open(
                    destination_name, "w", force_zip64=True
                ) as destination:
                    if name == info.file_name and body is not None:
                        body.seek(0)
                        size, digest = _copy_member(body, destination)
                    else:
                        assert source is not None
                        with source.open(members[name]) as member:
                            size, digest = _copy_member(member, destination)
                total += size
                if total > _MAX_BUNDLE_BYTES:
                    raise DosboxBundleInvalid(
                        "DOSBox Pure bundle exceeds the size limit"
                    )
                digests[destination_name] = digest
        size = output.tell()
        output.seek(0)
        combined = "\n".join(
            f"{name}:{digest}" for name, digest in sorted(digests.items())
        )
        return (
            output,
            hashlib.md5(combined.encode(), usedforsecurity=False).hexdigest(),
            size,
        )
    except BaseException:
        output.close()
        raise


async def _store_member(
    user: User,
    info: DosboxFilePath,
    body: UploadFile | None,
    can_see: Callable[[Rom], bool],
) -> bool:
    rom = await asyncio.to_thread(_resolve_rom, info.game_name, can_see)
    if rom is None:
        raise DosboxBundleInvalid("No visible DOSBox Pure ROM matches this file")
    # Multiple workers may receive a drive-file burst for the same game.
    async with async_cache.lock(
        f"retroarch:dosbox:{user.id}:{rom.id}", timeout=600, blocking_timeout=30
    ):
        bundle = await asyncio.to_thread(_find_bundle, user, rom)
        if body is None and bundle is None:
            return False
        output, content_hash, size = await asyncio.to_thread(
            _merge_bundle, bundle, info, body.file if body else None
        )
        try:
            if bundle and bundle.content_hash == content_hash:
                return False
            path = sync_handler.build_asset_file_path(user, rom, "saves", EMULATOR)
            name = await reserve_version_name(
                user.id, rom.id, path, f"{rom.fs_name_no_ext}.zip"
            )
            check_filename_length(name)
            await fs_asset_handler.write_file(
                file=UploadFile(output), path=path, filename=name, overwrite=False
            )
            saved = Save(
                file_name=name,
                file_path=path,
                file_size_bytes=size,
                content_hash=content_hash,
            )
            # An empty version hides older members after the last native file is deleted.
            await sync_handler.add_autosave_version(
                user, rom, saved, EMULATOR, SaveLineage(EMULATOR, "zip")
            )
            return True
        finally:
            output.close()


async def put_dosbox_file(
    user: User, info: DosboxFilePath, body: UploadFile, can_see: Callable[[Rom], bool]
) -> bool:
    return await _store_member(user, info, body, can_see)


async def delete_dosbox_file(
    user: User, info: DosboxFilePath, can_see: Callable[[Rom], bool]
) -> None:
    await _store_member(user, info, None, can_see)


def _extract_member(bundle: Save, info: DosboxFilePath) -> BinaryIO | None:
    with _open_bundle(bundle, info.game_name) as (archive, members):
        member = members.get(info.file_name)
        if member is None or archive is None:
            return None
        output = TemporaryFile()
        try:
            with archive.open(member) as source:
                _copy_member(source, output)
            output.seek(0)
            return output
        except BaseException:
            output.close()
            raise


async def get_dosbox_file(
    user: User, info: DosboxFilePath, can_see: Callable[[Rom], bool]
) -> BinaryIO | None:
    rom = await asyncio.to_thread(_resolve_rom, info.game_name, can_see)
    bundle = await asyncio.to_thread(_find_bundle, user, rom) if rom else None
    return await asyncio.to_thread(_extract_member, bundle, info) if bundle else None


def _bundle_index(bundle: Save, hashes: bool) -> dict[str, str]:
    with _open_bundle(bundle, bundle.rom.fs_name_no_ext) as (archive, members):
        if not hashes:
            return dict.fromkeys(members, "")
        assert archive is not None
        result = {}
        for name, entry in members.items():
            with archive.open(entry) as member:
                result[name] = _copy_member(member)[1]
        return result


async def _index_json(bundle: Save) -> str | None:
    try:
        return json.dumps(await asyncio.to_thread(_bundle_index, bundle, True))
    except DosboxBundleInvalid as exc:
        log.warning(str(exc))
        return None


async def manifest_entries(
    user: User, can_see: Callable[[Rom], bool], *, hashes: bool = True
) -> list[dict[str, str]]:
    bundles = await asyncio.to_thread(_latest_bundles, user, can_see)
    entries: list[dict[str, str]] = []
    for bundle in bundles:
        owner = await asyncio.to_thread(
            _resolve_rom, bundle.rom.fs_name_no_ext, can_see
        )
        if owner is None or owner.id != bundle.rom_id or bundle.missing_from_fs:
            continue
        if hashes:
            key = f"romm:retroarch_sync:dosbox:{bundle.id}:{bundle.content_hash}:{bundle.file_size_bytes}:{bundle.updated_at.timestamp()}"
            index = (
                await sync_handler.cached_hashes([(key, partial(_index_json, bundle))])
            )[0]
            members = json.loads(index) if index is not None else {}
        else:
            try:
                members = await asyncio.to_thread(_bundle_index, bundle, False)
            except DosboxBundleInvalid as exc:
                log.warning(str(exc))
                continue
        entries.extend(
            {"path": f"saves/{SAVE_DIRECTORY}/{name}", "hash": digest}
            for name, digest in members.items()
        )
    return entries
