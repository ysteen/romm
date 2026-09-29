import shutil
from pathlib import Path
from typing import Annotated, Literal
from uuid import uuid4

from anyio import to_thread
from fastapi import File, Form, HTTPException
from fastapi import Path as PathVar
from fastapi import Request, UploadFile
from rq.exceptions import NoSuchJobError
from starlette.responses import FileResponse

from config import (
    ROMFORGE_ENABLED,
    ROMFORGE_MAX_3DS_SIZE,
    ROMFORGE_MAX_EXPANDED_SIZE,
    ROMFORGE_MAX_FILE_SIZE,
    ROMFORGE_MAX_PATCH_SIZE,
    ROMFORGE_NORMALIZE_3DS_ON_SCAN,
    ROMFORGE_WORK_PATH,
    ROMM_BASE_PATH,
)
from decorators.auth import protected_route
from endpoints.responses.patch_job import (
    PatchDownloadLink,
    PatchJobSchema,
    PatchWorkerCapabilities,
)
from handler import patch_jobs
from handler.auth.constants import Scope
from handler.auth.dependencies import assert_can, get_permissions
from handler.redis_handler import redis_client
from models.permission import PermAction, PermEntity
from utils.router import APIRouter

router = APIRouter()


@protected_route(router.get, "/patcher/capabilities", [Scope.ROMS_READ])
def patcher_capabilities(request: Request) -> PatchWorkerCapabilities:
    return PatchWorkerCapabilities(
        enabled=ROMFORGE_ENABLED,
        available=ROMFORGE_ENABLED
        and bool(redis_client.exists(patch_jobs.HEARTBEAT_KEY)),
        extensions=sorted(patch_jobs.EXTENSIONS),
        max_file_size=ROMFORGE_MAX_FILE_SIZE,
        max_patch_size=ROMFORGE_MAX_PATCH_SIZE,
        max_3ds_size=ROMFORGE_MAX_3DS_SIZE,
        max_expanded_size=ROMFORGE_MAX_EXPANDED_SIZE,
        keys_ready=(
            Path(ROMM_BASE_PATH) / "config/romforge/keys/aes_keys.txt"
        ).is_file(),
        cia_ready=(Path(ROMM_BASE_PATH) / "config/romforge/keys/certs.bin").is_file(),
        normalize_on_scan=ROMFORGE_NORMALIZE_3DS_ON_SCAN,
    )


def _input(request: Request, file_id: int):
    try:
        return patch_jobs.visible_input(file_id, get_permissions(request))
    except (patch_jobs.PatchJobError, ValueError, OSError) as exc:
        raise HTTPException(404, "File not found") from exc


@protected_route(router.post, "/{id}/patch-jobs", [Scope.ROMS_WRITE], status_code=202)
async def create_patch_job(
    request: Request,
    id: Annotated[int, PathVar(ge=1)],
    operation: Annotated[
        Literal["patch", "3ds-repack", "3ds-convert"], Form()
    ] = "patch",
    output_format: Annotated[Literal["cci", "cia"], Form()] = "cci",
    patch_file_id: Annotated[int | None, Form(ge=1)] = None,
    patch_file: Annotated[UploadFile | None, File()] = None,
) -> PatchJobSchema:
    assert_can(get_permissions(request), PermEntity.ROMS, PermAction.WRITE)
    if not ROMFORGE_ENABLED or not redis_client.exists(patch_jobs.HEARTBEAT_KEY):
        raise HTTPException(503, "RomForge worker is disconnected")
    if operation == "3ds-repack" and output_format == "cia":
        raise HTTPException(
            400, "Save patches as CCI, then request a temporary CIA export"
        )
    if operation == "3ds-convert":
        if patch_file_id is not None or patch_file is not None:
            raise HTTPException(400, "Conversion does not accept a patch")
    elif (patch_file_id is None) == (patch_file is None):
        raise HTTPException(400, "Provide exactly one patch file")
    file, source = _input(request, id)
    upload_dir = None
    accepted = False
    try:
        patch_jobs.check_source(file, source, operation)
        payload = {
            "owner_id": request.user.id,
            "operation": operation,
            "output_format": output_format,
            "file_id": id,
            "source_fingerprint": patch_jobs.fingerprint(source),
            "patch_file_id": patch_file_id,
        }
        if operation == "3ds-convert":
            job = await to_thread.run_sync(patch_jobs.enqueue_patch, payload)
            accepted = True
            return patch_jobs.describe_job(job)
        if patch_file_id is not None:
            _, patch = _input(request, patch_file_id)
        else:
            assert patch_file is not None
            extension = Path(patch_file.filename or "").suffix.lower()
            if extension not in patch_jobs.EXTENSIONS:
                raise HTTPException(400, "Unsupported RomForge patch format")
            upload_id = uuid4().hex
            upload_dir = ROMFORGE_WORK_PATH / "uploads" / upload_id
            upload_dir.mkdir(parents=True)
            patch = upload_dir / f"patch{extension}"
            size = 0
            with patch.open("wb") as output:
                while chunk := await patch_file.read(1024 * 1024):
                    size += len(chunk)
                    if size > ROMFORGE_MAX_PATCH_SIZE:
                        raise HTTPException(
                            413, "Patch exceeds the RomForge input limit"
                        )
                    await to_thread.run_sync(output.write, chunk)
            payload.update(upload_id=upload_id, patch_name=patch.name)
        patch_jobs.check_patch(patch)
        if (
            operation == "3ds-repack"
            and patch.suffix.lower() not in patch_jobs.ARCHIVE_EXTENSIONS
        ):
            raise HTTPException(
                400, "3DS repacking requires a ZIP/7z/RAR patch archive"
            )
        payload["patch_fingerprint"] = patch_jobs.fingerprint(patch)
        job = await to_thread.run_sync(patch_jobs.enqueue_patch, payload)
        accepted = True
        return patch_jobs.describe_job(job)
    except patch_jobs.PatchJobError as exc:
        raise HTTPException(400, str(exc)) from exc
    finally:
        if upload_dir is not None and not accepted:
            shutil.rmtree(upload_dir, ignore_errors=True)


def _job(request: Request, id: int, job_id: str):
    _input(request, id)
    try:
        job = patch_jobs.fetch_job(job_id)
    except NoSuchJobError as exc:
        raise HTTPException(404, "Patch job not found") from exc
    normalization = (
        job.meta.get("owner_id") == 0
        and job.args[0].get("operation") == "3ds-normalize"
    )
    if (
        job.meta.get("owner_id") != request.user.id and not normalization
    ) or job.meta.get("file_id") != id:
        raise HTTPException(404, "Patch job not found")
    payload = job.args[0]
    if payload.get("patch_file_id"):
        _input(request, payload["patch_file_id"])
    result = patch_jobs.describe_job(job)
    if result.output_file_id:
        _input(request, result.output_file_id)
    return result


@protected_route(router.get, "/{id}/patch-jobs/{job_id}", [Scope.ROMS_READ])
def get_patch_job(
    request: Request,
    id: Annotated[int, PathVar(ge=1)],
    job_id: Annotated[str, PathVar(pattern=r"^[a-f0-9]{32}$")],
) -> PatchJobSchema:
    return _job(request, id, job_id)


@protected_route(router.get, "/{id}/patch-jobs", [Scope.ROMS_READ])
def list_patch_jobs(
    request: Request, id: Annotated[int, PathVar(ge=1)]
) -> list[PatchJobSchema]:
    _input(request, id)
    ids = redis_client.lrange(f"romforge:history:{request.user.id}:{id}", 0, 19)
    normalization_id = redis_client.get(f"romforge:normalize:{id}")
    if normalization_id:
        ids = [normalization_id, *ids]
    jobs = []
    for job_id in ids:
        try:
            jobs.append(_job(request, id, job_id.decode()))
        except HTTPException as exc:
            if exc.status_code != 404:
                raise
    return jobs


@protected_route(
    router.post, "/{id}/patch-jobs/{job_id}/download-link", [Scope.ROMS_READ]
)
def create_download_link(request: Request, id: int, job_id: str) -> PatchDownloadLink:
    from handler.romforge_install import issue_link

    _job(request, id, job_id)
    try:
        return PatchDownloadLink(**issue_link(patch_jobs.fetch_job(job_id), id))
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.api_route("/install-download/{token}/install.cia", methods=["GET", "HEAD"])
def download_install(token: Annotated[str, PathVar(pattern=r"^[A-Za-z0-9_-]{43}$")]):
    from handler.romforge_install import resolve_link

    try:
        path = resolve_link(token)
    except (ValueError, OSError, patch_jobs.PatchJobError) as exc:
        raise HTTPException(404, "Download unavailable or expired") from exc
    return FileResponse(
        path,
        filename="install.cia",
        media_type="application/octet-stream",
        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"},
    )
