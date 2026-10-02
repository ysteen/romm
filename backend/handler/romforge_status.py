"""Read the worker queue and retained results without changing job state."""

from rq.exceptions import NoSuchJobError
from sqlalchemy import select

from decorators.database import begin_session
from endpoints.responses.patch_job import (
    PatchWorkerCapabilities,
    RomForgeJobSchema,
    RomForgeStatus,
)
from handler import patch_jobs
from handler.romforge_scan import PENDING_KEY
from handler.scan_jobs import get_running_scan_job
from models.rom import RomFile

HISTORY_LIMIT = 50


@begin_session
def get_status(worker: PatchWorkerCapabilities, session=None) -> RomForgeStatus:
    queue = patch_jobs.patch_queue
    ids = [
        *queue.started_job_registry.get_job_ids(cleanup=False),
        *queue.get_job_ids(),
    ]
    for registry in (
        queue.finished_job_registry,
        queue.failed_job_registry,
        queue.canceled_job_registry,
    ):
        ids.extend(
            registry.get_job_ids(end=HISTORY_LIMIT - 1, desc=True, cleanup=False)
        )

    jobs = []
    for job_id in dict.fromkeys(ids):
        try:
            job = patch_jobs.fetch_job(job_id)
            state = patch_jobs.describe_job(job)
        except NoSuchJobError:
            continue
        jobs.append((job, state))

    file_ids = {job.meta["file_id"] for job, _ in jobs}
    sources = (
        {
            row.id: row
            for row in session.execute(
                select(RomFile.id, RomFile.rom_id, RomFile.file_name).where(
                    RomFile.id.in_(file_ids)
                )
            )
        }
        if file_ids
        else {}
    )

    active: list[RomForgeJobSchema] = []
    history: list[RomForgeJobSchema] = []
    for job, state in jobs:
        file_id = job.meta["file_id"]
        source = sources.get(file_id)
        item = RomForgeJobSchema(
            **state.model_dump(),
            operation=job.args[0].get("operation", "patch"),
            file_id=file_id,
            rom_id=source.rom_id if source else None,
            source_name=source.file_name if source else None,
            created_at=job.created_at,
            started_at=job.started_at,
            ended_at=job.ended_at,
        )
        (active if item.status in {"queued", "running"} else history).append(item)

    active.sort(key=lambda job: (job.status != "running", job.created_at))
    history.sort(key=lambda job: job.ended_at or job.created_at, reverse=True)
    pending = patch_jobs.redis_client.scard(PENDING_KEY)
    return RomForgeStatus(
        worker=worker,
        active=active,
        history=history[:HISTORY_LIMIT],
        pending_normalizations=pending,
        scan_running=bool(pending and get_running_scan_job()),
        history_limit=HISTORY_LIMIT,
        retention_days=patch_jobs.JOB_TTL // 86400,
    )
