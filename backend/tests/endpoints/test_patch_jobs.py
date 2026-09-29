import shutil
import subprocess
import sys
import threading
import zlib
from pathlib import Path

import fakeredis
import pytest
from rq import Queue, SimpleWorker
from rq.serializers import JSONSerializer
from sqlalchemy import select

from endpoints.roms import patch_jobs as routes
from handler import patch_jobs as jobs
from handler.database import db_rom_handler, db_user_handler
from handler.database.base_handler import sync_session
from handler.filesystem import fs_rom_handler
from models.permission import HiddenEntity, PermEntity
from models.rom import RomFile, RomFileCategory


@pytest.fixture
def inputs(tmp_path, monkeypatch, rom, platform, admin_user):
    library = tmp_path / "library"
    folder = library / platform.fs_slug / "roms"
    folder.mkdir(parents=True)
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.setattr(fs_rom_handler, "base_path", str(library))
    monkeypatch.setattr(
        fs_rom_handler, "get_roms_fs_structure", lambda slug: f"{slug}/roms"
    )
    monkeypatch.setattr(jobs, "ROMFORGE_WORK_PATH", work)
    monkeypatch.setattr(routes, "ROMFORGE_WORK_PATH", work)
    monkeypatch.setattr(routes, "ROMFORGE_ENABLED", True)
    connection = fakeredis.FakeRedis()
    # Fakeredis without its optional Lua extra cannot release redis-py's lock.
    # These in-process tests exercise the queue; production uses the Redis lock.
    monkeypatch.setattr(connection, "lock", lambda *args, **kwargs: threading.Lock())
    queue = Queue(jobs.QUEUE_NAME, connection=connection, serializer=JSONSerializer)
    monkeypatch.setattr(jobs, "redis_client", connection)
    monkeypatch.setattr(routes, "redis_client", connection)
    monkeypatch.setattr(jobs, "patch_queue", queue)
    connection.set(jobs.HEARTBEAT_KEY, "1")
    source = folder / "source.bin"
    patch = folder / "translate.ips"
    source.write_bytes(b"original")
    patch.write_bytes(b"PATCH\x00\x00\x00\x00\x03NEWEOF")
    files = []
    for path, category in [
        (source, RomFileCategory.GAME),
        (patch, RomFileCategory.PATCH),
    ]:
        files.append(
            db_rom_handler.add_rom_file(
                RomFile(
                    rom_id=rom.id,
                    file_name=path.name,
                    file_path=f"{platform.fs_slug}/roms",
                    file_size_bytes=path.stat().st_size,
                    category=category,
                )
            )
        )
    payload = {
        "owner_id": admin_user.id,
        "file_id": files[0].id,
        "patch_file_id": files[1].id,
        "source_fingerprint": jobs.fingerprint(source),
        "patch_fingerprint": jobs.fingerprint(patch),
    }
    return {
        "source": source,
        "patch": patch,
        "files": files,
        "payload": payload,
        "work": work,
        "queue": queue,
        "redis": connection,
    }


def auth(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.parametrize(
    ("category", "top_level", "expected"),
    [(None, True, 202), (None, False, 400), (RomFileCategory.PATCH, True, 400)],
)
def test_source_category_matches_api_default(
    client, access_token, inputs, rom, category, top_level, expected
):
    file_id = inputs["files"][0].id
    if top_level:
        db_rom_handler.update_rom(rom.id, {"fs_name": inputs["source"].name})
    db_rom_handler.update_rom_file(file_id, {"category": category})
    response = client.post(
        f"/api/roms/{file_id}/patch-jobs",
        headers=auth(access_token),
        data={"patch_file_id": inputs["files"][1].id},
    )
    assert response.status_code == expected, response.text


def test_worker_disconnected_preserves_existing_patcher(client, access_token, inputs):
    inputs["redis"].delete(jobs.HEARTBEAT_KEY)
    caps = client.get("/api/roms/patcher/capabilities", headers=auth(access_token))
    assert caps.status_code == 200
    assert not caps.json()["available"]
    response = client.post(
        f"/api/roms/{inputs['files'][0].id}/patch-jobs",
        headers=auth(access_token),
        data={"patch_file_id": inputs["files"][1].id},
    )
    assert response.status_code == 503
    # The old route still exists and independently validates its own request.
    old = client.post(
        f"/api/roms/{inputs['files'][0].id}/patch", headers=auth(access_token)
    )
    assert old.status_code == 400


def test_viewer_cannot_submit(client, viewer_access_token, inputs):
    response = client.post(
        f"/api/roms/{inputs['files'][0].id}/patch-jobs",
        headers=auth(viewer_access_token),
        data={"patch_file_id": inputs["files"][1].id},
    )
    assert response.status_code == 403


def test_hidden_source_is_masked(client, editor_access_token, editor_user, inputs, rom):
    with sync_session.begin() as session:
        session.add(
            HiddenEntity(
                entity=PermEntity.ROMS, entity_id=rom.id, user_id=editor_user.id
            )
        )
    response = client.post(
        f"/api/roms/{inputs['files'][0].id}/patch-jobs",
        headers=auth(editor_access_token),
        data={"patch_file_id": inputs["files"][1].id},
    )
    assert response.status_code == 404


def test_job_is_owned_and_survives_request(
    client, access_token, editor_access_token, inputs
):
    file_id = inputs["files"][0].id
    response = client.post(
        f"/api/roms/{file_id}/patch-jobs",
        headers=auth(access_token),
        files={"patch_file": ("translation.ips", inputs["patch"].read_bytes())},
    )
    assert response.status_code == 202, response.text
    job_id = response.json()["id"]
    assert inputs["queue"].count == 1
    assert list((inputs["work"] / "uploads").glob("*/patch.ips"))
    history = client.get(f"/api/roms/{file_id}/patch-jobs", headers=auth(access_token))
    assert history.json()[0]["id"] == job_id
    denied = client.get(
        f"/api/roms/{file_id}/patch-jobs/{job_id}", headers=auth(editor_access_token)
    )
    assert denied.status_code == 404


def test_upload_size_failure_cleans_staging(client, access_token, inputs, monkeypatch):
    monkeypatch.setattr(routes, "ROMFORGE_MAX_PATCH_SIZE", 4)
    response = client.post(
        f"/api/roms/{inputs['files'][0].id}/patch-jobs",
        headers=auth(access_token),
        files={"patch_file": ("patch.ips", b"too large")},
    )
    assert response.status_code == 413
    assert not list((inputs["work"] / "uploads").glob("*"))


def test_queue_limit(client, access_token, inputs, monkeypatch):
    monkeypatch.setattr(jobs, "ROMFORGE_MAX_PENDING", 1)
    jobs.enqueue_patch(inputs["payload"])
    response = client.post(
        f"/api/roms/{inputs['files'][0].id}/patch-jobs",
        headers=auth(access_token),
        files={"patch_file": ("patch.ips", inputs["patch"].read_bytes())},
    )
    assert response.status_code == 400
    assert not list((inputs["work"] / "uploads").glob("*"))


def test_changed_source_is_rejected_before_engine(inputs, monkeypatch):
    engine = []
    monkeypatch.setattr(jobs, "_run_engine", lambda *args: engine.append(args))
    inputs["source"].write_bytes(b"changed!")
    with pytest.raises(jobs.PatchJobError, match="Source changed"):
        jobs.execute_patch(inputs["payload"])
    assert not engine


def test_revoked_user_rejected(inputs, admin_user):
    db_user_handler.update_user(admin_user.id, {"enabled": False})
    with pytest.raises(jobs.PatchJobError, match="no longer enabled"):
        jobs.execute_patch(inputs["payload"])


def test_hash_cache_invalidates_same_size_edit(inputs):
    before = jobs.file_digest(inputs["source"])
    inputs["source"].write_bytes(b"modified")
    assert jobs.file_digest(inputs["source"]) != before


def test_result_reuse_and_visibility(inputs, rom, viewer_user, monkeypatch):
    calls = []

    def engine(source, patch, output):
        calls.append(1)
        output.write_bytes(b"NEWginal")

    monkeypatch.setattr(jobs, "_run_engine", engine)
    with sync_session.begin() as session:
        session.add(
            HiddenEntity(
                entity=PermEntity.ROMS, entity_id=rom.id, user_id=viewer_user.id
            )
        )
    first = jobs.execute_patch(inputs["payload"])
    second = jobs.execute_patch(inputs["payload"])
    assert not first["reused"] and second["reused"]
    assert first["output_file_id"] == second["output_file_id"]
    assert len(calls) == 1
    assert inputs["source"].read_bytes() == b"original"
    with sync_session() as session:
        hidden = session.scalar(
            select(HiddenEntity).where(
                HiddenEntity.entity_id == first["output_rom_id"],
                HiddenEntity.user_id == viewer_user.id,
                HiddenEntity.entity == PermEntity.ROMS,
            )
        )
        assert hidden is not None


def test_deleted_result_can_be_regenerated(inputs, monkeypatch):
    monkeypatch.setattr(
        jobs, "_run_engine", lambda src, patch, out: out.write_bytes(b"patched")
    )
    first = jobs.execute_patch(inputs["payload"])
    file = db_rom_handler.get_rom_file_by_id(first["output_file_id"])
    fs_rom_handler.validate_path(file.full_path).unlink()
    # The scanner/user normally removes the stale row too.
    db_rom_handler.delete_rom(first["output_rom_id"])
    second = jobs.execute_patch(inputs["payload"])
    assert not second["reused"]


def test_failed_engine_does_not_publish(inputs, monkeypatch):
    def engine(source, patch, output):
        output.write_bytes(b"partial")
        raise jobs.PatchJobError("broken patch")

    monkeypatch.setattr(jobs, "_run_engine", engine)
    with pytest.raises(jobs.PatchJobError):
        jobs.execute_patch(inputs["payload"])
    assert not list(inputs["source"].parent.glob("*RomForge*"))
    assert not list(inputs["work"].glob("*.partial"))


def test_worker_imports_in_a_fresh_process():
    subprocess.run(
        [sys.executable, "-c", "import patch_worker"], check=True, timeout=30
    )


def test_changed_source_during_patch_is_not_published(inputs, monkeypatch):
    def engine(source, patch, output):
        output.write_bytes(b"patched")
        source.write_bytes(b"replaced")

    monkeypatch.setattr(jobs, "_run_engine", engine)
    with pytest.raises(jobs.PatchJobError, match="Source changed"):
        jobs.execute_patch(inputs["payload"])
    assert not list(inputs["source"].parent.glob("*RomForge*"))


def test_patch_output_is_size_limited(inputs, monkeypatch):
    command = inputs["work"] / "oversized.py"
    command.write_text(
        f"#!{sys.executable}\nimport sys\nwith open(sys.argv[3], 'wb') as f:\n f.write(b'x' * 4096)\n"
    )
    command.chmod(0o755)
    monkeypatch.setattr(jobs, "ROMFORGE_COMMAND", str(command))
    monkeypatch.setattr(jobs, "ROMFORGE_MAX_FILE_SIZE", 8)
    with pytest.raises(jobs.PatchJobError):
        jobs.execute_patch(inputs["payload"])
    assert not list(inputs["source"].parent.glob("*RomForge*"))


@pytest.mark.skipif(
    not Path("/opt/romforge/RomForge.Cli").exists(),
    reason="Requires the RomForge worker image",
)
def test_real_ips_queue_to_library(client, access_token, inputs):
    file_id = inputs["files"][0].id
    response = client.post(
        f"/api/roms/{file_id}/patch-jobs",
        headers=auth(access_token),
        data={"patch_file_id": inputs["files"][1].id},
    )
    assert response.status_code == 202, response.text
    worker = SimpleWorker(
        [inputs["queue"]], connection=inputs["redis"], serializer=JSONSerializer
    )
    worker.work(burst=True)
    result = client.get(
        f"/api/roms/{file_id}/patch-jobs/{response.json()['id']}",
        headers=auth(access_token),
    ).json()
    assert result["status"] == "completed", result
    file = db_rom_handler.get_rom_file_by_id(result["output_file_id"])
    assert fs_rom_handler.validate_path(file.full_path).read_bytes() == b"NEWginal"


@pytest.mark.skipif(
    not Path("/opt/romforge/RomForge.Cli").exists() or not shutil.which("xdelta3"),
    reason="Requires the RomForge worker image",
)
def test_real_xdelta_and_invalid_patch(inputs):
    target = inputs["source"].with_name("target.bin")
    target.write_bytes(b"real xdelta output" * 20)
    patch = inputs["patch"].with_suffix(".xdelta")
    subprocess.run(
        ["xdelta3", "-e", "-s", str(inputs["source"]), str(target), str(patch)],
        check=True,
    )
    output = inputs["work"] / "output.bin"
    jobs._run_engine(inputs["source"], patch, output)
    assert output.read_bytes() == target.read_bytes()
    output.unlink()
    patch.write_bytes(b"not a valid patch")
    with pytest.raises(jobs.PatchJobError):
        jobs._run_engine(inputs["source"], patch, output)
    assert not output.exists()


@pytest.mark.skipif(
    not Path("/opt/romforge/RomForge.Cli").exists(),
    reason="Requires the RomForge worker image",
)
def test_real_ips32_and_bps_crc_validation(inputs):
    output = inputs["work"] / "output.bin"
    patch = inputs["patch"]
    patch.write_bytes(b"IPS32\x00\x00\x00\x00\x00\x03NEWEEOF")
    jobs._run_engine(inputs["source"], patch, output)
    assert output.read_bytes() == b"NEWginal"
    output.unlink()

    target = b"translated"
    # All varints in this TargetRead-only fixture fit in a single byte.
    data = (
        b"BPS1"
        + bytes([8 | 128, len(target) | 128, 128, ((len(target) - 1) * 4 + 1) | 128])
        + target
    )
    data += zlib.crc32(b"original").to_bytes(4, "little") + zlib.crc32(target).to_bytes(
        4, "little"
    )
    data += zlib.crc32(data).to_bytes(4, "little")
    patch.write_bytes(data)
    jobs._run_engine(inputs["source"], patch, output)
    assert output.read_bytes() == target
    output.unlink()
    inputs["source"].write_bytes(b"mismatch")
    with pytest.raises(jobs.PatchJobError):
        jobs._run_engine(inputs["source"], patch, output)
    assert not output.exists()
