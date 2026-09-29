"""Synthetic 3DS fixtures contain no game data, retail keys or certificates."""

import hashlib
import struct
import zipfile
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from rq import SimpleWorker
from rq.serializers import JSONSerializer

from handler import patch_jobs as jobs
from handler import romforge_install as install
from handler import romforge_scan as scan
from handler.database import db_rom_handler
from handler.database.base_handler import sync_session
from models.rom import RomFile, RomFileCategory
from tests.endpoints.test_patch_jobs import auth
from tests.endpoints.test_patch_jobs import inputs as patch_inputs

inputs = patch_inputs

native = pytest.mark.skipif(
    not Path("/opt/romforge/RomForge.Cli").exists(), reason="Requires RomForge worker"
)


@pytest.fixture(autouse=True)
def zip_writer_compatibility(monkeypatch):
    # The app's streaming ZIP hook accepts one argument; stdlib writers pass two.
    compressor = zipfile._get_compressor
    monkeypatch.setattr(
        zipfile, "_get_compressor", lambda kind, level=None: compressor(kind)
    )


def make_cci(path, encrypted=False):
    exefs = bytearray(1024)
    exefs[:4] = b"icon"
    struct.pack_into("<II", exefs, 8, 0, 8)
    exefs[512:520] = b"original"
    exefs[0x1E0:0x200] = hashlib.sha256(b"original").digest()
    ncch = bytearray(512)
    ncch[0x100:0x104] = b"NCCH"
    struct.pack_into("<I", ncch, 0x104, 3)
    struct.pack_into("<Q", ncch, 0x108, 0x0004000000000100)
    struct.pack_into("<H", ncch, 0x112, 2)
    struct.pack_into("<Q", ncch, 0x118, 0x0004000000000100)
    ncch[0x18F] = 1 if encrypted else 4
    struct.pack_into("<III", ncch, 0x1A0, 1, 2, 1)
    ncch[0x1C0:0x1E0] = hashlib.sha256(exefs[:512]).digest()
    if encrypted:
        ctr = (0x0004000000000100).to_bytes(8, "big") + b"\x02" + bytes(7)
        encryptor = Cipher(algorithms.AES(bytes(16)), modes.CTR(ctr)).encryptor()
        exefs = encryptor.update(exefs) + encryptor.finalize()
    header = bytearray(0x4000)
    header[0x100:0x104] = b"NCSD"
    struct.pack_into("<I", header, 0x104, 35)
    struct.pack_into("<II", header, 0x120, 32, 3)
    path.write_bytes(header + ncch + exefs)


def set_source(inputs, rom, extension=".3ds", encrypted=False):
    source = inputs["source"].with_suffix(extension)
    inputs["source"].unlink()
    make_cci(source, encrypted)
    db_rom_handler.update_rom(rom.id, {"fs_name": source.name})
    db_rom_handler.update_rom_file(
        inputs["files"][0].id,
        {"file_name": source.name, "file_size_bytes": source.stat().st_size},
    )
    return source


@native
@pytest.mark.parametrize("encrypted", [False, True])
def test_cci_conversion_checks_decrypted_output(tmp_path, encrypted):
    source = tmp_path / "source.3ds"
    make_cci(source, encrypted)
    output = tmp_path / "output.cci"
    before = source.read_bytes()
    jobs._run_engine(source, None, output, "3ds-convert", "cci")
    assert scan.requires_valid_cci(output)
    assert b"original" in output.read_bytes()
    assert source.read_bytes() == before


@native
def test_layered_zip_and_binary_zip(tmp_path):
    source = tmp_path / "source.3ds"
    make_cci(source)
    patch = tmp_path / "patch.zip"
    output = tmp_path / "output.cci"
    with zipfile.ZipFile(patch, "w") as z:
        z.writestr("wrapper/exefs/icon.bin", b"patched!")
    jobs._run_engine(source, patch, output, "3ds-repack", "cci")
    assert b"patched!" in output.read_bytes()
    source.write_bytes(b"original")
    with zipfile.ZipFile(patch, "w") as z:
        z.writestr("translation.ips", b"PATCH\x00\x00\x00\x00\x03NEWEOF")
    jobs._run_engine(source, patch, output)
    assert output.read_bytes() == b"NEWginal"


@native
@pytest.mark.parametrize("entry", ["../escape.ips", "/absolute.ips", "C:/escape.ips"])
def test_archive_paths_rejected(tmp_path, entry):
    source = tmp_path / "source"
    source.write_bytes(b"original")
    patch = tmp_path / "patch.zip"
    with zipfile.ZipFile(patch, "w") as z:
        z.writestr(entry, b"PATCHEOF")
    with pytest.raises(jobs.PatchJobError):
        jobs._run_engine(source, patch, tmp_path / "out")


@native
def test_rom_zip_single_game_and_ambiguity(tmp_path):
    src = tmp_path / "source.3ds"
    make_cci(src, True)
    archive = tmp_path / "game.zip"
    output = tmp_path / "out.cci"
    with zipfile.ZipFile(archive, "w") as z:
        z.write(src, "nested/game.3ds")
    jobs._run_engine(archive, None, output, "3ds-convert", "cci")
    assert scan.requires_valid_cci(output)
    with zipfile.ZipFile(archive, "a") as z:
        z.write(src, "other.3ds")
    with pytest.raises(jobs.PatchJobError):
        jobs._run_engine(archive, None, output, "3ds-convert", "cci")


@native
def test_scan_replaces_file_preserves_identity(inputs, rom, monkeypatch):
    source = set_source(inputs, rom, encrypted=True)
    with sync_session.begin() as session:
        session.delete(session.get(RomFile, inputs["files"][1].id))
    monkeypatch.setattr(scan, "ROMFORGE_WORK_PATH", inputs["work"])
    monkeypatch.setattr(scan, "ROMFORGE_NORMALIZE_3DS_ON_SCAN", True)
    payload = {
        "file_id": inputs["files"][0].id,
        "source_fingerprint": jobs.fingerprint(source),
    }
    result = scan.normalize(payload)
    assert result["output_rom_id"] == rom.id
    assert result["output_file_id"] == payload["file_id"]
    assert not source.exists()
    assert scan.requires_valid_cci(source.with_suffix(".cci"))
    assert db_rom_handler.get_rom(rom.id).fs_name == source.with_suffix(".cci").name


@native
def test_scan_db_failure_restores_source(inputs, rom, monkeypatch):
    source = set_source(inputs, rom, extension=".cci", encrypted=True)
    before = source.read_bytes()
    with sync_session.begin() as session:
        session.delete(session.get(RomFile, inputs["files"][1].id))
    monkeypatch.setattr(scan, "ROMFORGE_WORK_PATH", inputs["work"])
    monkeypatch.setattr(scan, "ROMFORGE_NORMALIZE_3DS_ON_SCAN", True)

    def fail(*args):
        raise RuntimeError("DB unavailable")

    monkeypatch.setattr(scan, "_replace_record", fail)
    with pytest.raises(RuntimeError):
        scan.normalize(
            {
                "file_id": inputs["files"][0].id,
                "source_fingerprint": jobs.fingerprint(source),
            }
        )
    assert source.read_bytes() == before


@native
def test_cia_export_is_temporary_and_link_is_scoped(
    client, access_token, viewer_access_token, inputs, rom, monkeypatch
):
    source = set_source(inputs, rom)
    monkeypatch.setattr(install, "ROMFORGE_WORK_PATH", inputs["work"])
    monkeypatch.setattr(install, "redis_client", inputs["redis"])
    keys = Path("/romm/config/romforge/keys")
    keys.mkdir(parents=True, exist_ok=True)
    (keys / "aes_keys.txt").write_text("common0=" + "00" * 16 + "\n")
    (keys / "certs.bin").write_bytes(bytes(0xA00))
    try:
        url = f"/api/roms/{inputs['files'][0].id}/patch-jobs"
        queued = client.post(
            url,
            headers=auth(access_token),
            data={"operation": "3ds-convert", "output_format": "cia"},
        )
        assert queued.status_code == 202, queued.text
        SimpleWorker(
            [inputs["queue"]], connection=inputs["redis"], serializer=JSONSerializer
        ).work(burst=True)
        job_id = queued.json()["id"]
        details = client.get(url + "/" + job_id, headers=auth(access_token)).json()
        assert details["download_ready"], details
        assert details["output_rom_id"] is None
        assert "export_key" not in details
        link_url = url + "/" + job_id + "/download-link"
        assert (
            client.post(link_url, headers=auth(viewer_access_token)).status_code == 404
        )
        link = client.post(link_url, headers=auth(access_token)).json()["path"]
        download = client.get(link, headers={"Range": "bytes=0-15"})
        assert download.status_code == 206
        assert len(download.content) == 16
        assert source.exists()
        source.write_bytes(b"changed")
        assert client.get(link).status_code == 404
    finally:
        (keys / "aes_keys.txt").unlink()
        (keys / "certs.bin").unlink()


@native
def test_romfs_file_patch_is_repacked(tmp_path):
    source = tmp_path / "source.3ds"
    make_cci(source)
    data = bytearray(source.read_bytes())
    romfs = bytearray(0x2000)
    struct.pack_into("<III", romfs, 0, 0x43465649, 0x10000, 32)
    for i in range(3):
        struct.pack_into("<QQII", romfs, 0x0C + i * 24, 0, 4096, 12, 0)
    struct.pack_into("<I", romfs, 0x54, 0x5C)
    level = 0x1000
    struct.pack_into(
        "<10I", romfs, level, 0x28, 0x28, 12, 0x34, 24, 0x4C, 12, 0x58, 48, 0x90
    )
    struct.pack_into(
        "<6I", romfs, level + 0x34, 0, 0xFFFFFFFF, 0xFFFFFFFF, 0, 0xFFFFFFFF, 0
    )
    name = "data.bin".encode("utf-16le")
    struct.pack_into(
        "<IIQQII", romfs, level + 0x58, 0, 0xFFFFFFFF, 0, 8, 0xFFFFFFFF, len(name)
    )
    romfs[level + 0x78 : level + 0x88] = name
    romfs[level + 0x90 : level + 0x98] = b"original"
    data.extend(bytes(0x5000 - len(data)))
    data.extend(romfs)
    struct.pack_into("<I", data, 0x104, len(data) // 512)
    struct.pack_into("<II", data, 0x120, 32, (len(data) - 0x4000) // 512)
    struct.pack_into("<I", data, 0x4104, (len(data) - 0x4000) // 512)
    struct.pack_into("<III", data, 0x41B0, 8, 16, 1)
    source.write_bytes(data)
    patch = tmp_path / "patch.zip"
    with zipfile.ZipFile(patch, "w") as z:
        z.writestr("romfs/data.bin.ips", b"PATCH\x00\x00\x00\x00\x03NEWEOF")
    output = tmp_path / "patched.cci"
    jobs._run_engine(source, patch, output, "3ds-repack", "cci")
    assert b"NEWginal" in output.read_bytes()
    assert scan.requires_valid_cci(output)


@pytest.mark.parametrize("category", [None, RomFileCategory.GAME])
def test_scan_pending_is_resumed_without_duplicate_job(
    inputs, rom, platform, monkeypatch, category
):
    from handler.database import db_platform_handler

    monkeypatch.setattr(scan, "ROMFORGE_NORMALIZE_3DS_ON_SCAN", True)
    monkeypatch.setattr(scan, "redis_client", inputs["redis"])
    monkeypatch.setattr(scan, "keys_ready", lambda: True)
    monkeypatch.setattr("endpoints.sockets.scan._get_running_scan_job", lambda: None)
    source = set_source(inputs, rom)
    db_rom_handler.update_rom_file(inputs["files"][0].id, {"category": category})
    db_platform_handler.update_platform(platform.id, {"slug": "3ds"})
    scan.schedule_scan([platform.id], [])
    scan.pump_pending()
    assert inputs["queue"].count == 1
    scan.schedule_scan([platform.id], [])
    scan.pump_pending()
    assert inputs["queue"].count == 1
    assert source.exists()


def test_scan_ignores_uncategorized_non_game_files(inputs, rom, platform, monkeypatch):
    from handler.database import db_platform_handler

    monkeypatch.setattr(scan, "ROMFORGE_NORMALIZE_3DS_ON_SCAN", True)
    monkeypatch.setattr(scan, "redis_client", inputs["redis"])
    db_platform_handler.update_platform(platform.id, {"slug": "3ds"})
    for file in inputs["files"]:
        db_rom_handler.update_rom_file(file.id, {"category": None})
    scan.schedule_scan([platform.id], [])
    assert inputs["redis"].scard(scan.PENDING_KEY) == 0


@pytest.mark.parametrize("scan_starts_during_conversion", [False, True])
def test_new_scan_defers_normalization_without_replacing_source(
    inputs, rom, monkeypatch, scan_starts_during_conversion
):
    source = set_source(inputs, rom, encrypted=True)
    before = source.read_bytes()
    with sync_session.begin() as session:
        session.delete(session.get(RomFile, inputs["files"][1].id))
    monkeypatch.setattr(scan, "ROMFORGE_NORMALIZE_3DS_ON_SCAN", True)
    monkeypatch.setattr(scan, "ROMFORGE_WORK_PATH", inputs["work"])
    monkeypatch.setattr(scan, "redis_client", inputs["redis"])
    states = iter([None, object()] if scan_starts_during_conversion else [object()])
    monkeypatch.setattr(
        "endpoints.sockets.scan._get_running_scan_job", lambda: next(states)
    )
    converted = []

    def convert(_source, _patch, output, *_args):
        converted.append(True)
        make_cci(output)

    monkeypatch.setattr(jobs, "_run_engine", convert)
    file_id = inputs["files"][0].id
    with pytest.raises(jobs.PatchJobError, match="deferred"):
        scan.normalize(
            {"file_id": file_id, "source_fingerprint": jobs.fingerprint(source)}
        )
    assert bool(converted) == scan_starts_during_conversion
    assert source.read_bytes() == before
    assert not source.with_suffix(".cci").exists()
    assert db_rom_handler.get_rom(rom.id).fs_name == source.name
    assert inputs["redis"].sismember(scan.PENDING_KEY, file_id)
    assert not list(inputs["work"].glob("*.partial"))


def test_export_cleanup_honors_download_lease(tmp_path, inputs, monkeypatch):
    import os
    import time

    monkeypatch.setattr(install, "ROMFORGE_WORK_PATH", tmp_path)
    monkeypatch.setattr(install, "redis_client", inputs["redis"])
    path = install.export_path("a" * 64)
    path.parent.mkdir()
    path.write_bytes(b"cia")
    old = time.time() - install.ROMFORGE_INSTALL_TTL - 1
    os.utime(path, (old, old))
    inputs["redis"].set("romforge:lease:" + "a" * 64, "1")
    install.cleanup_exports()
    assert path.exists()
    inputs["redis"].delete("romforge:lease:" + "a" * 64)
    install.cleanup_exports()
    assert not path.exists()


@native
def test_7z_patch_and_expansion_limit(tmp_path, monkeypatch):
    import shutil
    import subprocess

    if not shutil.which("7z"):
        pytest.skip("Requires 7z fixture writer")
    source = tmp_path / "source.bin"
    source.write_bytes(b"original")
    patch = tmp_path / "patch.ips"
    patch.write_bytes(b"PATCH\x00\x00\x00\x00\x03NEWEOF")
    archive = tmp_path / "patch.7z"
    subprocess.run(
        ["7z", "a", str(archive), str(patch)], check=True, capture_output=True
    )
    output = tmp_path / "out.bin"
    jobs._run_engine(source, archive, output)
    assert output.read_bytes() == b"NEWginal"
    monkeypatch.setattr(jobs, "ROMFORGE_MAX_EXPANDED_SIZE", 4)
    with pytest.raises(jobs.PatchJobError):
        jobs._run_engine(source, archive, output)
    assert source.read_bytes() == b"original"
