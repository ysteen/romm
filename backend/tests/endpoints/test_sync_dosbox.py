import hashlib
import io
import zipfile
from concurrent.futures import ThreadPoolExecutor

import pytest
from handler.database import db_save_handler
from handler.filesystem import fs_asset_handler
from handler.filesystem.assets_handler import hash_save_file
from handler.sync.retroarch import dosbox
from models.assets import AUTOSAVE_SLOT
from tests.factories import make_platform, make_rom, make_save
from utils.zip_cache import ensure_zipfile_writable

AUTH = ("test_admin", "test_admin_password")
ROOT = "/api/sync/retroarch/"


def archive_bytes(entries):
    ensure_zipfile_writable()
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
    return output.getvalue()


@pytest.fixture(autouse=True)
def isolated_assets(_isolated_assets_dir):
    return _isolated_assets_dir


@pytest.fixture
def dos_rom():
    return make_rom(make_platform("dos"), "Example")


@pytest.fixture
def bundle(admin_user, dos_rom):
    def create(
        entries,
        *,
        slot=AUTOSAVE_SLOT,
        emulator="dosbox_pure",
        filename="Example [2026-01-01_01-01-01.123456].zip",
    ):
        path = fs_asset_handler.build_saves_file_path(
            user=admin_user,
            platform_fs_slug="dos",
            rom_id=dos_rom.id,
            emulator=emulator,
        )
        full = fs_asset_handler.validate_path(f"{path}/{filename}")
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_bytes(archive_bytes(entries))
        return make_save(
            dos_rom,
            admin_user,
            filename,
            file_path=path,
            slot=slot,
            emulator=emulator,
            content_hash=hash_save_file(full),
            file_size_bytes=full.stat().st_size,
        )

    return create


def manifest(client, auth=AUTH):
    response = client.get(ROOT + "manifest.server", auth=auth)
    assert response.status_code == 200
    return {entry["path"]: entry["hash"] for entry in response.json()}


def native(name):
    return ROOT + "saves/DOSBox-pure/Example" + name


def head_entries(user, rom):
    head = dosbox._find_bundle(user, rom)
    assert head is not None and head.slot == AUTOSAVE_SLOT
    path = fs_asset_handler.validate_path(head.full_path)
    assert head.file_size_bytes == path.stat().st_size
    assert head.content_hash == hash_save_file(path)
    with zipfile.ZipFile(path) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def test_browser_bundle_exposes_native_bytes_and_raw_member_hashes(client, bundle):
    nested = archive_bytes({"GAME/SAVE.DAT": b"progress"})
    entries = {
        "DOSBox-pure/Example.pure.zip": nested,
        "DOSBox-pure/Example-CDRIVE.sav": b"drive c",
        "DOSBox-pure/Example-1234ABCD.sav": b"drive d",
    }
    bundle(entries)
    expected = {
        "saves/" + name: hashlib.md5(data, usedforsecurity=False).hexdigest()
        for name, data in entries.items()
    }
    assert manifest(client) == expected
    for name, data in entries.items():
        url = ROOT + "saves/" + name
        response = client.get(url, auth=AUTH)
        assert response.status_code == 200 and response.content == data
        response = client.head(url, auth=AUTH)
        assert response.content == b"" and response.headers["content-length"] == str(
            len(data)
        )
    listing = client.request(
        "PROPFIND", ROOT + "saves/DOSBox-pure/", auth=AUTH, headers={"Depth": "1"}
    )
    assert listing.status_code == 207 and "Example-CDRIVE.sav" in listing.text
    assert "Example%20%5B" not in listing.text


def test_native_updates_preserve_siblings_and_browser_history(
    client, bundle, admin_user, dos_rom
):
    original = bundle(
        {
            "DOSBox-pure/Example-CDRIVE.sav": b"old c",
            "DOSBox-pure/Example-DDRIVE.sav": b"old d",
        }
    )
    manual = bundle(
        {"DOSBox-pure/Example-CDRIVE.sav": b"manual"},
        slot="manual",
        filename="manual.zip",
    )
    assert (
        client.put(native("-CDRIVE.sav"), content=b"new c", auth=AUTH).status_code
        == 201
    )
    assert head_entries(admin_user, dos_rom) == {
        "DOSBox-pure/Example-CDRIVE.sav": b"new c",
        "DOSBox-pure/Example-DDRIVE.sav": b"old d",
    }
    assert (
        client.put(native("-CDRIVE.sav"), content=b"new c", auth=AUTH).status_code
        == 204
    )
    assert db_save_handler.get_save(admin_user.id, original.id) is not None
    stored_manual = db_save_handler.get_save(admin_user.id, manual.id)
    assert (
        stored_manual is not None and stored_manual.content_hash == manual.content_hash
    )
    current = manifest(client)
    assert (
        current["saves/DOSBox-pure/Example-CDRIVE.sav"]
        == hashlib.md5(b"new c", usedforsecurity=False).hexdigest()
    )


def test_savediff_upload_without_pure_zip_and_concurrent_files(
    client, admin_user, dos_rom
):
    payloads = {
        "-CDRIVE.sav": b"system",
        "-19BF6B94.sav": b"content",
        "-DDRIVE.sav": b"drive d",
    }
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(
            pool.map(
                lambda item: client.put(
                    native(item[0]), content=item[1], auth=AUTH
                ).status_code,
                payloads.items(),
            )
        )
    assert results == [201, 201, 201]
    assert head_entries(admin_user, dos_rom) == {
        "DOSBox-pure/Example" + suffix: data for suffix, data in payloads.items()
    }
    assert len(manifest(client)) == 3


@pytest.mark.parametrize("method", ["DELETE", "MOVE"])
def test_deleted_members_never_reappear_from_older_versions(
    client, bundle, admin_user, dos_rom, method
):
    bundle(
        {"DOSBox-pure/Example-CDRIVE.sav": b"c", "DOSBox-pure/Example-DDRIVE.sav": b"d"}
    )
    assert client.request(method, native("-CDRIVE.sav"), auth=AUTH).status_code == 204
    assert client.get(native("-CDRIVE.sav"), auth=AUTH).status_code == 404
    assert head_entries(admin_user, dos_rom) == {"DOSBox-pure/Example-DDRIVE.sav": b"d"}
    assert client.request(method, native("-DDRIVE.sav"), auth=AUTH).status_code == 204
    assert manifest(client) == {}
    assert head_entries(admin_user, dos_rom) == {}


@pytest.mark.parametrize(
    "emulator,filename", [("dos", "Example.srm"), (None, "Example.zip")]
)
def test_legacy_unslotted_bundles_are_migrated_on_native_write(
    client, bundle, admin_user, dos_rom, emulator, filename
):
    bundle(
        {"Example-CDRIVE.sav": b"legacy"},
        slot=None,
        emulator=emulator,
        filename=filename,
    )
    assert client.get(native("-CDRIVE.sav"), auth=AUTH).content == b"legacy"
    assert (
        client.put(native("-DDRIVE.sav"), content=b"new", auth=AUTH).status_code == 201
    )
    assert len(head_entries(admin_user, dos_rom)) == 2
    assert len(manifest(client)) == 2


def test_named_slot_and_other_users_are_not_exposed(client, bundle, editor_user):
    bundle(
        {"DOSBox-pure/Example-CDRIVE.sav": b"named"},
        slot="playthrough",
        filename="named.zip",
    )
    assert manifest(client) == {}
    bundle({"DOSBox-pure/Example-CDRIVE.sav": b"private"})
    assert manifest(client, ("test_editor", "test_editor_password")) == {}
    assert (
        client.get(
            native("-CDRIVE.sav"), auth=("test_editor", "test_editor_password")
        ).status_code
        == 404
    )
    assert client.put(native("-CDRIVE.sav"), content=b"unauthorized").status_code == 401


@pytest.mark.parametrize(
    "bad_name",
    [
        "../Example-CDRIVE.sav",
        "DOSBox-pure/Other-CDRIVE.sav",
        "DOSBox-pure/sub/Example-CDRIVE.sav",
    ],
)
def test_invalid_existing_archive_is_not_partially_overwritten(
    client, bundle, bad_name
):
    original = bundle({"DOSBox-pure/Example-CDRIVE.sav": b"safe", bad_name: b"bad"})
    before = fs_asset_handler.validate_path(original.full_path).read_bytes()
    assert (
        client.put(native("-DDRIVE.sav"), content=b"new", auth=AUTH).status_code == 409
    )
    assert fs_asset_handler.validate_path(original.full_path).read_bytes() == before
    assert manifest(client) == {}


def test_unmatched_rom_is_not_stored(client, admin_user):
    assert (
        client.put(native(".pure.zip"), content=b"data", auth=AUTH).status_code == 409
    )


def test_unsorted_native_upload_is_rejected_instead_of_changing_its_sync_path(
    client, bundle
):
    bundle({"DOSBox-pure/Example-CDRIVE.sav": b"c"})
    assert (
        client.put(
            ROOT + "saves/Example-CDRIVE.sav", content=b"new", auth=AUTH
        ).status_code
        == 409
    )
    assert client.get(native("-CDRIVE.sav"), auth=AUTH).content == b"c"


def test_rom_visibility_applies_to_every_bundle_operation(client, bundle, mocker):
    bundle({"DOSBox-pure/Example-CDRIVE.sav": b"private"})
    mocker.patch(
        "endpoints.sync.retroarch._rom_visibility", return_value=lambda _: False
    )
    assert manifest(client) == {}
    assert client.get(native("-CDRIVE.sav"), auth=AUTH).status_code == 404
    assert (
        client.put(native("-CDRIVE.sav"), content=b"new", auth=AUTH).status_code == 409
    )
    assert client.delete(native("-CDRIVE.sav"), auth=AUTH).status_code == 409


def test_large_drive_is_copied_in_bounded_chunks():
    class Drive(io.BytesIO):
        remaining = 65 * 1024 * 1024

        def read(self, size: int | None = -1, /) -> bytes:
            assert size is not None
            assert 0 < size <= 1024 * 1024
            count = min(size, self.remaining)
            self.remaining -= count
            return bytes(count)

    assert dosbox._copy_member(Drive())[0] == 65 * 1024 * 1024


@pytest.mark.parametrize(
    "suffix",
    [
        ".pure.zip",
        ".sav.zip",
        ".sav",
        ".srm",
        "-CDRIVE.sav",
        "-DDRIVE.sav",
        "-1234ABCD.sav",
    ],
)
def test_native_name_resolves_to_the_content_stem(suffix):
    assert dosbox.resolve_dosbox_path(
        "saves/DOSBox-pure/Example" + suffix
    ) == dosbox.DosboxFilePath("Example", "Example" + suffix)
