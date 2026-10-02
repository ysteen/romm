from datetime import UTC, datetime, timedelta

import pytest
from rq.executions import Execution
from rq.job import Job, JobStatus
from rq.results import Result

from endpoints.roms import patch_jobs as routes
from handler import patch_jobs, romforge_status
from handler.romforge_scan import PENDING_KEY
from tests.endpoints.test_patch_jobs import auth
from tests.endpoints.test_patch_jobs import inputs as patch_inputs

inputs = patch_inputs
URL = "/api/roms/patcher/status"


def finish_job(inputs, *, failed: bool = False, age: int = 0, result=None) -> Job:
    job = patch_jobs.enqueue_patch(inputs["payload"])
    inputs["queue"].remove(job)
    job.ended_at = datetime.now(UTC) - timedelta(seconds=age)
    job.set_status(JobStatus.FAILED if failed else JobStatus.FINISHED)
    if failed:
        job.meta["error"] = "Source changed since scan"
    job.save()
    if not failed:
        Result.create(
            job, Result.Type.SUCCESSFUL, patch_jobs.JOB_TTL, return_value=result or {}
        )
    registry = (
        inputs["queue"].failed_job_registry
        if failed
        else inputs["queue"].finished_job_registry
    )
    registry.add(job, ttl=patch_jobs.JOB_TTL)
    return job


@pytest.mark.parametrize(
    "token_fixture", ["viewer_access_token", "editor_access_token"]
)
def test_status_requires_admin(client, request, token_fixture, inputs):
    response = client.get(URL, headers=auth(request.getfixturevalue(token_fixture)))
    assert response.status_code == 403


def test_status_requires_authentication(client, inputs):
    assert client.get(URL).status_code == 401


def test_status_includes_queue_stages_and_scan_backlog(
    client, access_token, inputs, rom, monkeypatch
):
    queued = patch_jobs.enqueue_patch(inputs["payload"])
    running = patch_jobs.enqueue_patch(
        {**inputs["payload"], "owner_id": 0, "operation": "3ds-normalize"}
    )
    inputs["queue"].remove(running)
    running.set_status(JobStatus.STARTED)
    running.started_at = datetime.now(UTC)
    running.meta["stage"] = "patching"
    running.save()
    with inputs["redis"].pipeline() as pipe:
        Execution.create(running, ttl=120, pipeline=pipe)
        pipe.execute()
    inputs["redis"].sadd(PENDING_KEY, 101, 102, 103)
    monkeypatch.setattr(romforge_status, "get_running_scan_job", lambda: object())
    response = client.get(URL, headers=auth(access_token))
    assert response.status_code == 200, response.text
    data = response.json()
    assert [job["id"] for job in data["active"]] == [running.id, queued.id]
    assert data["active"][0]["stage"] == "patching"
    assert data["active"][0]["operation"] == "3ds-normalize"
    assert data["active"][0]["rom_id"] == rom.id
    assert data["active"][0]["source_name"] == "source.bin"
    assert data["active"][0]["started_at"].endswith("Z")
    assert data["pending_normalizations"] == 3
    assert data["scan_running"] is True
    assert data["worker"]["available"] is True
    assert inputs["queue"].job_ids == [queued.id]
    assert inputs["redis"].scard(PENDING_KEY) == 3


def test_history_is_global_sorted_and_does_not_expose_export_keys(
    client, access_token, inputs, editor_user
):
    failed = finish_job(inputs, failed=True, age=10)
    inputs["payload"]["owner_id"] = editor_user.id
    completed = finish_job(
        inputs, result={"download_ready": True, "export_key": "private-export-key"}
    )
    response = client.get(URL, headers=auth(access_token))
    data = response.json()
    assert [job["id"] for job in data["history"]] == [completed.id, failed.id]
    assert data["history"][0]["status"] == "completed"
    assert data["history"][0]["download_ready"] is True
    assert data["history"][1]["error"] == "Source changed since scan"
    assert "private-export-key" not in response.text
    assert "source_fingerprint" not in response.text
    assert data["retention_days"] == 7


def test_expired_jobs_are_skipped_without_registry_cleanup(
    client, access_token, inputs
):
    job = finish_job(inputs)
    inputs["redis"].delete(job.key)
    inputs["queue"].failed_job_registry.connection.zadd(
        inputs["queue"].failed_job_registry.key, {"missing-job": 0}
    )
    response = client.get(URL, headers=auth(access_token))
    assert response.status_code == 200, response.text
    assert response.json()["history"] == []
    assert (
        inputs["redis"].zscore(inputs["queue"].failed_job_registry.key, "missing-job")
        == 0
    )


@pytest.mark.parametrize("enabled", [True, False])
def test_offline_worker_keeps_history_visible(
    client, access_token, inputs, monkeypatch, enabled
):
    job = finish_job(inputs)
    inputs["redis"].delete(patch_jobs.HEARTBEAT_KEY)
    monkeypatch.setattr(routes, "ROMFORGE_ENABLED", enabled)
    response = client.get(URL, headers=auth(access_token))
    assert response.status_code == 200, response.text
    assert response.json()["worker"]["enabled"] is enabled
    assert response.json()["worker"]["available"] is False
    assert response.json()["history"][0]["id"] == job.id


def test_history_is_bounded_and_active_jobs_are_not_truncated(
    client, access_token, inputs, monkeypatch
):
    monkeypatch.setattr(romforge_status, "HISTORY_LIMIT", 2)
    finish_job(inputs, age=30)
    recent = finish_job(inputs, failed=True, age=10)
    newest = finish_job(inputs, age=0)
    queued = patch_jobs.enqueue_patch(inputs["payload"])
    data = client.get(URL, headers=auth(access_token)).json()
    assert data["history_limit"] == 2
    assert [job["id"] for job in data["history"]] == [newest.id, recent.id]
    assert [job["id"] for job in data["active"]] == [queued.id]


def test_removed_source_does_not_hide_failure(client, access_token, inputs):
    inputs["payload"]["file_id"] = 999999
    failed = finish_job(inputs, failed=True)
    response = client.get(URL, headers=auth(access_token))
    assert response.status_code == 200, response.text
    item = response.json()["history"][0]
    assert item["id"] == failed.id
    assert item["source_name"] is None
    assert item["rom_id"] is None
