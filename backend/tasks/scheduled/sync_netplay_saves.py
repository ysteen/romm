from handler.netplay_save_handler import sync_pending
from tasks.registry import SYNC_NETPLAY_SAVES_SPEC
from tasks.tasks import PeriodicTask
from utils.context import initialize_context


class SyncNetplaySavesTask(PeriodicTask):
    def __init__(self) -> None:
        super().__init__(SYNC_NETPLAY_SAVES_SPEC)

    @initialize_context()
    async def run(self) -> None:
        if self.spec.enabled:
            await sync_pending()


sync_netplay_saves_task = SyncNetplaySavesTask()
