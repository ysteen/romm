from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class PatchWorkerCapabilities(BaseModel):
    enabled: bool
    available: bool
    extensions: list[str]
    max_file_size: int
    max_patch_size: int
    max_3ds_size: int
    max_expanded_size: int
    keys_ready: bool
    cia_ready: bool
    normalize_on_scan: bool


class PatchJobSchema(BaseModel):
    id: str
    status: Literal["queued", "running", "completed", "failed"]
    stage: str
    reused: bool = False
    download_ready: bool = False
    output_rom_id: int | None = None
    output_file_id: int | None = None
    output_file_name: str | None = None
    error: str | None = None


class PatchDownloadLink(BaseModel):
    path: str
    expires_at: int


class RomForgeJobSchema(PatchJobSchema):
    operation: str
    file_id: int
    rom_id: int | None
    source_name: str | None
    created_at: datetime
    started_at: datetime | None
    ended_at: datetime | None


class RomForgeStatus(BaseModel):
    worker: PatchWorkerCapabilities
    active: list[RomForgeJobSchema]
    history: list[RomForgeJobSchema]
    pending_normalizations: int
    scan_running: bool
    history_limit: int
    retention_days: int
