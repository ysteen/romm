"""Run the optional, single-consumer RomForge queue."""

import fcntl
import os

from rq import Worker
from rq.serializers import JSONSerializer

from config import ROMFORGE_WORK_PATH
from handler import database  # noqa: F401 - initialize ORM handlers before decorators
from handler.patch_jobs import HEARTBEAT_KEY, cleanup_staging, patch_queue
from handler.redis_handler import redis_client


class PatchWorker(Worker):
    def heartbeat(self, *args, **kwargs):
        result = super().heartbeat(*args, **kwargs)
        redis_client.set(HEARTBEAT_KEY, "1", ex=120)
        from handler.romforge_scan import pump_pending

        pump_pending()
        from handler.romforge_install import cleanup_exports

        cleanup_exports()
        return result


def main():
    os.nice(10)
    ROMFORGE_WORK_PATH.mkdir(parents=True, exist_ok=True)
    # A shared-volume lock prevents accidental replicas from running concurrently.
    with (ROMFORGE_WORK_PATH / "worker.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        cleanup_staging()
        try:
            PatchWorker(
                [patch_queue],
                connection=redis_client,
                serializer=JSONSerializer,
                worker_ttl=90,
                job_monitoring_interval=15,
            ).work()
        finally:
            redis_client.delete(HEARTBEAT_KEY)


if __name__ == "__main__":
    main()
