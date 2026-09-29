import asyncio

from rq import get_current_job

from handler.patch_jobs import PatchJobError, execute_patch
from tasks.tasks import Task, TaskType


class PatchRomTask(Task):
    def __init__(self):
        super().__init__("RomForge", "Apply a queued ROM patch", TaskType.CONVERSION)

    async def run(self, payload: dict) -> dict:
        try:
            return execute_patch(payload)
        except PatchJobError as exc:
            job = get_current_job()
            if job:
                job.meta["error"] = str(exc)
                job.save_meta()
            raise


def run_patch_job(payload: dict) -> dict:
    # RQ owns the process and timeout; no request or browser session is needed.
    return asyncio.run(PatchRomTask().run(payload))
