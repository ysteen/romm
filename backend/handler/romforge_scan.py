"""Normalize scanned 3DS games on the optional worker, preserving ROM identity."""

import os
import shutil
import struct
from pathlib import Path
from uuid import uuid4

from sqlalchemy import or_, select

from config import ROMFORGE_NORMALIZE_3DS_ON_SCAN, ROMFORGE_WORK_PATH, ROMM_BASE_PATH
from decorators.database import begin_session
from handler import patch_jobs
from handler.database import db_rom_handler
from handler.filesystem import fs_rom_handler
from handler.redis_handler import redis_client
from handler.scan_jobs import get_running_scan_job
from logger.logger import log
from models.platform import Platform
from models.rom import Rom, RomFile, RomFileCategory

PENDING_KEY = "romforge:normalize:pending"


def keys_ready() -> bool:
    return (Path(ROMM_BASE_PATH) / "config/romforge/keys/aes_keys.txt").is_file()


@begin_session
def schedule_scan(platform_ids: list[int], rom_ids: list[int], session=None) -> None:
    if not ROMFORGE_NORMALIZE_3DS_ON_SCAN:
        return
    query = (
        select(RomFile, Rom)
        .join(Rom, RomFile.rom_id == Rom.id)
        .join(Platform, Rom.platform_id == Platform.id)
        .where(
            Platform.slug.in_(
                ["3ds", "nintendo3ds", "nintendo-3ds", "new-nintendo-3ds"]
            ),
            or_(
                RomFile.category == RomFileCategory.GAME,
                RomFile.category.is_(None),
            ),
        )
    )
    if rom_ids:
        query = query.where(Rom.id.in_(rom_ids))
    else:
        query = query.where(Platform.id.in_(platform_ids))
    ids = [
        file.id
        for file, rom in session.execute(query)
        if patch_jobs.is_game_file(file, rom)
    ]
    if ids:
        redis_client.sadd(PENDING_KEY, *ids)


def requires_conversion(path: Path) -> bool:
    suffix = path.suffix.lower()
    if suffix in {".zip", ".7z", ".rar", ".cia", ".3ds"}:
        return True
    if suffix != ".cci":
        return False
    with path.open("rb") as source:
        header = source.read(0x200)
        if header[0x100:0x104] != b"NCSD":
            return False
        for i in range(8):
            offset, size = struct.unpack_from("<II", header, 0x120 + i * 8)
            if not size:
                continue
            source.seek(offset * 512 + 0x18F)
            flags = source.read(1)
            if flags and not flags[0] & 4:
                return True
    return False


def pump_pending() -> None:
    if not ROMFORGE_NORMALIZE_3DS_ON_SCAN or not keys_ready():
        return
    # Wait for metadata reconciliation before changing filenames.
    if get_running_scan_job():
        return
    if patch_jobs.patch_queue.count >= patch_jobs.ROMFORGE_MAX_PENDING:
        return
    raw = redis_client.spop(PENDING_KEY)
    if raw is None:
        return
    file_id = int(raw)
    try:
        file = db_rom_handler.get_rom_file_by_id(file_id)
        if not file:
            return
        path = fs_rom_handler.validate_path(file.full_path)
        if not path.is_file() or not requires_conversion(path):
            return
        fingerprint = patch_jobs.fingerprint(path)
        state_key = f"romforge:normalize:{file_id}"
        previous = redis_client.get(state_key)
        if previous:
            try:
                job = patch_jobs.fetch_job(previous.decode())
                if job.get_status() in {"queued", "started"}:
                    return
            except Exception:
                pass
        job = patch_jobs.enqueue_patch(
            {
                "owner_id": 0,
                "file_id": file_id,
                "operation": "3ds-normalize",
                "source_fingerprint": fingerprint,
                "patch_file_id": None,
            }
        )
        redis_client.set(state_key, job.id, ex=patch_jobs.JOB_TTL)
    except Exception:
        redis_client.sadd(PENDING_KEY, file_id)
        log.exception("Could not queue 3DS normalization for file %s", file_id)


@begin_session
def _replace_record(file_id: int, old_name: str, target: Path, session=None) -> dict:
    file = session.get(RomFile, file_id)
    rom = session.get(Rom, file.rom_id) if file else None
    if not rom or file.file_name != old_name or rom.fs_name != old_name:
        raise patch_jobs.PatchJobError("ROM changed during normalization")
    file.file_name = target.name
    file.file_size_bytes = target.stat().st_size
    file.last_modified = target.stat().st_mtime
    file.archive_members = None
    rom.fs_name = target.name
    rom.fs_size_bytes = file.file_size_bytes
    for obj in (file, rom):
        for field in ("crc_hash", "md5_hash", "sha1_hash", "ra_hash"):
            setattr(obj, field, None)
    return {
        "output_rom_id": rom.id,
        "output_file_id": file.id,
        "output_file_name": target.name,
        "reused": False,
    }


def normalize(payload: dict) -> dict:
    if not ROMFORGE_NORMALIZE_3DS_ON_SCAN:
        raise patch_jobs.PatchJobError("Automatic normalization is disabled")
    _defer_during_scan(payload["file_id"])
    file = db_rom_handler.get_rom_file_by_id(payload["file_id"])
    rom = db_rom_handler.get_rom(file.rom_id) if file else None
    if not rom or rom.fs_name != file.file_name or len(rom.files) != 1:
        raise patch_jobs.PatchJobError(
            "Automatic normalization requires a single-file ROM"
        )
    source = fs_rom_handler.validate_path(file.full_path)
    if patch_jobs.fingerprint(source) != payload["source_fingerprint"]:
        raise patch_jobs.PatchJobError("Source changed since scan")
    if source.stat().st_size > patch_jobs.ROMFORGE_MAX_3DS_SIZE:
        raise patch_jobs.PatchJobError("3DS ROM exceeds size limit")
    target = source.with_suffix(".cci")
    if target != source and target.exists():
        raise patch_jobs.PatchJobError("CCI already exists; original preserved")
    ROMFORGE_WORK_PATH.mkdir(parents=True, exist_ok=True)
    output = ROMFORGE_WORK_PATH / f"{uuid4().hex}.partial"
    temporary = source.with_name(f".romm_tmp_{uuid4().hex}")
    backup = source.with_name(f".romm_tmp_{uuid4().hex}")
    committed = False
    published = False
    try:
        patch_jobs._stage("patching")
        patch_jobs._run_engine(source, None, output, "3ds-convert", "cci")
        if not requires_valid_cci(output):
            raise patch_jobs.PatchJobError("Converted CCI failed validation")
        with output.open("rb") as src, temporary.open("xb") as dest:
            shutil.copyfileobj(src, dest, 1024 * 1024)
            dest.flush()
            os.fsync(dest.fileno())
        if patch_jobs.fingerprint(source) != payload["source_fingerprint"]:
            raise patch_jobs.PatchJobError("Source changed during normalization")
        _defer_during_scan(file.id)
        os.link(source, backup)
        if source == target:
            os.replace(temporary, target)
        else:
            os.link(temporary, target)
        published = True
        patch_jobs._stage("saving")
        result = _replace_record(file.id, file.file_name, target)
        committed = True
        if source != target:
            source.unlink()
        db_rom_handler.invalidate_filter_values_cache()
        return result
    finally:
        if published and not committed:
            if source == target:
                os.replace(backup, source)
            else:
                target.unlink(missing_ok=True)
        backup.unlink(missing_ok=True)
        temporary.unlink(missing_ok=True)
        output.unlink(missing_ok=True)
        shutil.rmtree(str(output) + ".work", ignore_errors=True)


def _defer_during_scan(file_id: int) -> None:
    if get_running_scan_job():
        redis_client.sadd(PENDING_KEY, file_id)
        raise patch_jobs.PatchJobError(
            "Normalization deferred until the active library scan finishes"
        )


def requires_valid_cci(path: Path) -> bool:
    with path.open("rb") as source:
        header = source.read(0x200)
        if len(header) != 512 or header[0x100:0x104] != b"NCSD":
            return False
        partitions = 0
        for i in range(8):
            offset, size = struct.unpack_from("<II", header, 0x120 + 8 * i)
            if not size:
                continue
            partitions += 1
            if offset < 32 or (offset + size) * 512 > path.stat().st_size:
                return False
            source.seek(offset * 512)
            ncch = source.read(512)
            if ncch[0x100:0x104] != b"NCCH" or not ncch[0x18F] & 4:
                return False
        return partitions > 0
