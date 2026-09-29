"""Durable, opt-in patch jobs consumed only by the RomForge worker."""

import hashlib
import json
import os
import shutil
import signal
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from uuid import uuid4

from rq import Queue, get_current_job
from rq.exceptions import NoSuchJobError
from rq.job import Job
from rq.serializers import JSONSerializer
from sqlalchemy import select

from config import (
    ROMFORGE_COMMAND,
    ROMFORGE_MAX_3DS_SIZE,
    ROMFORGE_MAX_EXPANDED_SIZE,
    ROMFORGE_MAX_FILE_SIZE,
    ROMFORGE_MAX_PATCH_SIZE,
    ROMFORGE_MAX_PENDING,
    ROMFORGE_TIMEOUT,
    ROMFORGE_WORK_PATH,
)
from decorators.database import begin_session
from endpoints.responses.patch_job import PatchJobSchema
from handler.auth.permissions import resolve_permissions
from handler.database import db_rom_handler, db_user_handler
from handler.filesystem import fs_rom_handler
from handler.redis_handler import redis_client
from logger.logger import log
from models.permission import HiddenEntity, PermAction, PermEntity
from models.rom import Rom, RomFile, RomFileCategory

QUEUE_NAME = "romforge"
ENGINE_VERSION = "romforge-1.7.6-cli-2"
JOB_TTL = 7 * 86400
HEARTBEAT_KEY = "romforge:heartbeat"
BINARY_EXTENSIONS = frozenset(
    {".ips", ".bps", ".ups", ".aps", ".ppf", ".xdelta", ".vcdiff"}
)
ARCHIVE_EXTENSIONS = frozenset({".zip", ".7z", ".rar"})
EXTENSIONS = BINARY_EXTENSIONS | ARCHIVE_EXTENSIONS
THREEDS_EXTENSIONS = frozenset({".3ds", ".cci", ".cia"})
CONTAINERS = frozenset(
    {
        ".zip",
        ".7z",
        ".rar",
        ".chd",
        ".rvz",
        ".wia",
        ".gcz",
        ".cue",
        ".gdi",
        ".ccd",
        ".m3u",
    }
)
patch_queue = Queue(QUEUE_NAME, connection=redis_client, serializer=JSONSerializer)


class PatchJobError(Exception):
    pass


def fingerprint(path: Path) -> list[int]:
    stat = path.stat()
    if not path.is_file():
        raise PatchJobError("Input is not a regular file")
    return [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns]


def file_digest(path: Path) -> str:
    """Reuse hashes only while the filesystem identity and timestamps match."""
    before = fingerprint(path)
    identity = json.dumps([str(path.resolve()), before])
    with sqlite3.connect(ROMFORGE_WORK_PATH / "hashes.sqlite3") as cache:
        cache.execute(
            "CREATE TABLE IF NOT EXISTS hashes (identity TEXT PRIMARY KEY, digest TEXT)"
        )
        row = cache.execute(
            "SELECT digest FROM hashes WHERE identity = ?", (identity,)
        ).fetchone()
        if row:
            return row[0]
        digest = hashlib.sha256()
        with path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
        if fingerprint(path) != before:
            raise PatchJobError("Input changed during hashing")
        value = digest.hexdigest()
        cache.execute("INSERT OR REPLACE INTO hashes VALUES (?, ?)", (identity, value))
        return value


def visible_input(file_id: int, perms) -> tuple[RomFile, Path]:
    file = db_rom_handler.get_rom_file_by_id(file_id)
    rom = db_rom_handler.get_rom(file.rom_id) if file else None
    if not file or not rom or not perms.can_see_rom(rom.id, rom.platform_id):
        raise PatchJobError("File not found")
    path = fs_rom_handler.validate_path(file.full_path)
    if file.missing_from_fs or not path.is_file():
        raise PatchJobError("File not found")
    return file, path


def is_game_file(file: RomFile, rom: Rom | None = None) -> bool:
    if file.category is not None:
        return file.category == RomFileCategory.GAME
    # Match the API schema's default category for uncategorized top-level files.
    rom = rom or db_rom_handler.get_rom(file.rom_id)
    return bool(
        rom and rom.full_path == (file.file_path if file.is_nested else file.full_path)
    )


def check_source(file: RomFile, path: Path, operation: str = "patch") -> None:
    if not is_game_file(file) or (
        path.suffix.lower() in CONTAINERS
        and not (operation != "patch" and path.suffix.lower() in ARCHIVE_EXTENSIONS)
    ):
        raise PatchJobError("RomForge requires an extracted, single game file")
    if (
        operation != "patch"
        and path.suffix.lower() not in THREEDS_EXTENSIONS | ARCHIVE_EXTENSIONS
    ):
        raise PatchJobError("3DS operations require a .3ds, .cci or .cia source")
    limit = ROMFORGE_MAX_FILE_SIZE if operation == "patch" else ROMFORGE_MAX_3DS_SIZE
    if not 0 < path.stat().st_size <= limit:
        raise PatchJobError("ROM exceeds the RomForge input limit")


def check_patch(path: Path) -> None:
    if path.suffix.lower() not in EXTENSIONS:
        raise PatchJobError("Unsupported RomForge patch format")
    if not 0 < path.stat().st_size <= ROMFORGE_MAX_PATCH_SIZE:
        raise PatchJobError("Patch exceeds the RomForge input limit")


def enqueue_patch(payload: dict) -> Job:
    # The lock bounds the queue across all API processes.
    with redis_client.lock("romforge:enqueue", timeout=15, blocking_timeout=5):
        if patch_queue.count >= ROMFORGE_MAX_PENDING:
            raise PatchJobError("The patch queue is full. Try again later")
        job = patch_queue.create_job(
            "tasks.manual.patch_rom.run_patch_job",
            args=(payload,),
            job_id=uuid4().hex,
            timeout=ROMFORGE_TIMEOUT + 60,
            result_ttl=JOB_TTL,
            failure_ttl=JOB_TTL,
            ttl=JOB_TTL,
            meta={
                "owner_id": payload["owner_id"],
                "file_id": payload["file_id"],
                "stage": "queued",
            },
        )
        history = f"romforge:history:{payload['owner_id']}:{payload['file_id']}"
        with redis_client.pipeline() as pipe:
            patch_queue.enqueue_job(job, pipeline=pipe)
            pipe.lpush(history, job.id).ltrim(history, 0, 19).expire(
                history, JOB_TTL
            ).execute()
        return job


def fetch_job(job_id: str) -> Job:
    job = Job.fetch(job_id, connection=redis_client, serializer=JSONSerializer)
    if job.origin != QUEUE_NAME:
        raise NoSuchJobError(job_id)
    return job


def describe_job(job: Job) -> PatchJobSchema:
    status = job.get_status(refresh=True)
    result = job.return_value() if status == "finished" else None
    if status == "finished" and isinstance(result, dict):
        public = {k: v for k, v in result.items() if k != "export_key"}
        return PatchJobSchema(
            id=job.id, status="completed", stage="completed", **public
        )
    failed = status in {"failed", "stopped", "canceled"}
    return PatchJobSchema(
        id=job.id,
        status="failed" if failed else "running" if status == "started" else "queued",
        stage="failed" if failed else job.meta.get("stage", "queued"),
        error=(
            job.meta.get(
                "error",
                "Patching failed. Check the worker logs or retry with RomPatcher.js.",
            )
            if failed
            else None
        ),
    )


def _stage(name: str) -> None:
    job = get_current_job()
    if job:
        job.meta["stage"] = name
        job.save_meta()


def _authorize(payload: dict):
    user = db_user_handler.get_user(payload["owner_id"])
    if not user or not user.enabled:
        raise PatchJobError("User is no longer enabled")
    perms = resolve_permissions(user)
    if not (
        perms.is_admin or perms.allows(PermEntity.ROMS, PermAction.WRITE, owned=False)
    ):
        raise PatchJobError("Write permission was revoked")
    file, source = visible_input(payload["file_id"], perms)
    check_source(file, source, payload.get("operation", "patch"))
    if fingerprint(source) != payload["source_fingerprint"]:
        raise PatchJobError("Source changed since submission")
    if payload.get("operation") == "3ds-convert":
        return file, source, None, perms
    if payload.get("patch_file_id"):
        _, patch = visible_input(payload["patch_file_id"], perms)
    else:
        patch = (
            ROMFORGE_WORK_PATH
            / "uploads"
            / payload["upload_id"]
            / payload["patch_name"]
        )
        if not patch.resolve().is_relative_to(
            (ROMFORGE_WORK_PATH / "uploads").resolve()
        ):
            raise PatchJobError("Invalid staged patch path")
    check_patch(patch)
    if fingerprint(patch) != payload["patch_fingerprint"]:
        raise PatchJobError("Patch changed since submission")
    return file, source, patch, perms


@begin_session
def register_output(
    source_rom_id: int, output: Path, relative_dir: str, session=None
) -> dict:
    """Register one new ROM and inherit source visibility in the same transaction."""
    original = session.get(Rom, source_rom_id)
    if original is None:
        raise PatchJobError("Source ROM was deleted")
    existing = session.scalar(
        select(Rom).where(
            Rom.platform_id == original.platform_id, Rom.fs_name == output.name
        )
    )
    if existing:
        raise PatchJobError("Output is already registered")
    stat = output.stat()
    rom = Rom(
        platform_id=original.platform_id,
        fs_name=output.name,
        fs_path=relative_dir,
        fs_size_bytes=stat.st_size,
        name=output.stem,
    )
    session.add(rom)
    session.flush()
    file = RomFile(
        rom_id=rom.id,
        file_name=output.name,
        file_path=relative_dir,
        file_size_bytes=stat.st_size,
        last_modified=stat.st_mtime,
        category=RomFileCategory.GAME,
    )
    session.add(file)
    hidden = session.scalars(
        select(HiddenEntity).where(
            HiddenEntity.entity == PermEntity.ROMS,
            HiddenEntity.entity_id == source_rom_id,
        )
    )
    for row in hidden:
        session.add(
            HiddenEntity(
                entity=PermEntity.ROMS,
                entity_id=rom.id,
                user_id=row.user_id,
                group_id=row.group_id,
            )
        )
    session.flush()
    return {
        "output_rom_id": rom.id,
        "output_file_id": file.id,
        "output_file_name": output.name,
    }


def _run_engine(
    source: Path,
    patch: Path | None,
    output: Path,
    operation: str = "patch",
    output_format: str = "cci",
) -> None:
    launcher = Path(__file__).parents[1] / "utils/rom_patcher/limit_exec.py"
    with subprocess.Popen(
        [
            sys.executable,
            str(launcher),
            str(
                (
                    ROMFORGE_MAX_FILE_SIZE
                    if operation == "patch"
                    else ROMFORGE_MAX_3DS_SIZE
                )
                * 2
            ),
            ROMFORGE_COMMAND,
            str(source),
            str(patch) if patch else "-",
            str(output),
            *([operation, output_format] if operation != "patch" else []),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
        env={
            **os.environ,
            "ROMFORGE_MAX_EXPANDED_SIZE": str(ROMFORGE_MAX_EXPANDED_SIZE),
            "ROMFORGE_MAX_3DS_SIZE": str(ROMFORGE_MAX_3DS_SIZE),
        },
    ) as process:
        try:
            _, stderr = process.communicate(timeout=ROMFORGE_TIMEOUT)
            if process.returncode:
                log.error(
                    "RomForge failed: %s", stderr.decode(errors="replace")[-4000:]
                )
                details = stderr.decode(errors="replace")
                hints = {
                    "exactly one": "Archive contains multiple or no matching files. Extract and select one game or patch.",
                    "additional payloads": "ROM archive contains additional files. Extract the intended game first.",
                    "limit": "Expanded archive or output exceeds the configured size limit.",
                    "Slot 0x": "Required 3DS key slot is missing. Check aes_keys.txt.",
                    "Common Key": "CIA common key is missing. Check aes_keys.txt.",
                    "certs.bin": "CIA creation requires certs.bin in the configured key folder.",
                    "checksum": "3DS source checksum failed. Check the source and keyset.",
                    "do not match": "Some patch files do not match this ROM.",
                    "No patch files": "No patch files matched this ROM.",
                    "Unsafe": "Archive contains unsafe or duplicate paths.",
                }
                hint = next(
                    (message for marker, message in hints.items() if marker in details),
                    "RomForge could not process this file. Check the worker logs.",
                )
                raise PatchJobError(hint)
            if not output.is_file() or output.stat().st_size == 0:
                raise PatchJobError("RomForge produced no output")
        finally:
            # RQ timeouts must also terminate the native patch subprocess.
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()


def execute_patch(payload: dict) -> dict:
    work = ROMFORGE_WORK_PATH
    work.mkdir(parents=True, exist_ok=True)
    cleanup_staging()
    if payload.get("operation") == "3ds-normalize":
        from handler.romforge_scan import normalize

        return normalize(payload)
    output = None
    published = None
    try:
        file, source, patch, perms = _authorize(payload)
        _stage("hashing")
        key = hashlib.sha256(
            json.dumps(
                [
                    ENGINE_VERSION,
                    file.rom_id,
                    file_digest(source),
                    file_digest(patch) if patch else None,
                    payload.get("operation", "patch"),
                    payload.get("output_format", "cci"),
                ]
            ).encode()
        ).hexdigest()
        cache = work / "results" / f"{key}.json"
        cache.parent.mkdir(exist_ok=True)
        install = (
            payload.get("operation") == "3ds-convert"
            and payload.get("output_format") == "cia"
        )
        if install:
            from handler.romforge_install import describe_export, export_path

            exported = export_path(key)
            if exported.is_file():
                return {**describe_export(key), "reused": True}
        if cache.exists() and not install:
            cached = json.loads(cache.read_text())
            cached_file = db_rom_handler.get_rom_file_by_id(cached["output_file_id"])
            if cached_file:
                cached_rom = db_rom_handler.get_rom(cached_file.rom_id)
                if cached_rom and not perms.can_see_rom(
                    cached_rom.id, cached_rom.platform_id
                ):
                    raise PatchJobError("Result is no longer visible")
                cached_path = fs_rom_handler.validate_path(cached_file.full_path)
            else:
                cached_path = None
            if (
                cached_path
                and cached_path.is_file()
                and fingerprint(cached_path) == cached["fingerprint"]
            ):
                return {**cached["result"], "reused": True}

        original = db_rom_handler.get_rom(file.rom_id)
        if original is None:
            raise PatchJobError("Source ROM was deleted")
        relative_dir = fs_rom_handler.get_roms_fs_structure(original.platform_fs_slug)
        destination = fs_rom_handler.validate_path(relative_dir)
        destination.mkdir(parents=True, exist_ok=True)
        # Keep staging outside the library so the filesystem watcher cannot import it.
        output = work / f"{uuid4().hex}.partial"
        _stage("patching")
        operation = payload.get("operation", "patch")
        output_format = payload.get("output_format", "cci")
        if operation == "patch":
            _run_engine(source, patch, output)
        else:
            _run_engine(source, patch, output, operation, output_format)
        _authorize(payload)
        _stage("saving")
        if install:
            from handler.romforge_install import reserve_export

            reserve_export(output.stat().st_size)
            exported.parent.mkdir(parents=True, exist_ok=True)
            output.replace(exported)
            return describe_export(key)
        suffix = source.suffix if operation == "patch" else f".{output_format}"
        name = f"{source.stem[:120]} (RomForge {key[:16]}){suffix}"
        target = fs_rom_handler.validate_path(f"{relative_dir}/{name}")
        if target.exists():
            name = (
                f"{source.stem[:100]} (RomForge {key[:16]}-{uuid4().hex[:8]}){suffix}"
            )
            target = fs_rom_handler.validate_path(f"{relative_dir}/{name}")
        # Copy on the worker, then publish with a no-clobber hard link on the same filesystem.
        temporary = destination / f".romm_tmp_{uuid4().hex}"
        try:
            with output.open("rb") as src, temporary.open("xb") as dst:
                shutil.copyfileobj(src, dst, 1024 * 1024)
                dst.flush()
                os.fsync(dst.fileno())
            os.link(temporary, target)
            published = target
        finally:
            temporary.unlink(missing_ok=True)
        result = register_output(file.rom_id, target, relative_dir)
        published = None
        data = {
            "output_file_id": result["output_file_id"],
            "fingerprint": fingerprint(target),
            "result": result,
        }
        temp_cache = cache.with_suffix(".tmp")
        try:
            temp_cache.write_text(json.dumps(data))
            temp_cache.replace(cache)
            db_rom_handler.invalidate_filter_values_cache()
        except Exception:
            log.exception("Patch saved, but its cache could not be updated")
        return {**result, "reused": False}
    finally:
        if output:
            output.unlink(missing_ok=True)
            shutil.rmtree(str(output) + ".work", ignore_errors=True)
        if published:
            published.unlink(missing_ok=True)
        if payload.get("upload_id"):
            shutil.rmtree(work / "uploads" / payload["upload_id"], ignore_errors=True)


def cleanup_staging() -> None:
    """Expire abandoned uploads after queued jobs themselves have expired."""
    from handler.romforge_install import cleanup_exports

    cleanup_exports()
    now = time.time()
    for path in (ROMFORGE_WORK_PATH / "uploads").glob("*"):
        if now - path.stat().st_mtime > JOB_TTL + ROMFORGE_TIMEOUT + 3600:
            shutil.rmtree(path, ignore_errors=True)
    for path in ROMFORGE_WORK_PATH.glob("*.partial.work"):
        shutil.rmtree(path, ignore_errors=True)
    for path in ROMFORGE_WORK_PATH.glob("*.partial"):
        path.unlink(missing_ok=True)
