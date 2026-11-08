#!/usr/bin/env python3
"""Export running netplay images and allowlisted code mounts into a portable installer."""

import argparse
import gzip
import hashlib
import json
import shutil
import subprocess  # nosec B404
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def docker(*args):
    return subprocess.check_output(  # nosec B603 B607: fixed Docker command, no shell
        ["docker", *args], text=True
    )


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--romm-container", required=True)
    parser.add_argument("--bridge-container", required=True)
    parser.add_argument("--database-image", default="mariadb:11.4")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--without-images",
        action="store_true",
        help="Require images to be supplied separately on the destination",
    )
    parser.add_argument(
        "--allow-image-env",
        action="append",
        default=[],
        help="Explicitly retain a reviewed built-in image environment key (never a container deployment secret)",
    )
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    containers = {
        "romm": json.loads(docker("inspect", args.romm_container))[0],
        "netplay-bridge": json.loads(docker("inspect", args.bridge_container))[0],
    }
    images = {name: value["Image"] for name, value in containers.items()}
    images["database"] = json.loads(docker("image", "inspect", args.database_image))[0][
        "Id"
    ]
    for image in images.values():
        metadata = json.loads(docker("image", "inspect", image))[0]
        if metadata["Os"] != "linux" or metadata["Architecture"] != "amd64":
            raise ValueError("This installer currently requires Linux amd64 images")
        for entry in metadata["Config"].get("Env") or []:
            key, _, value = entry.partition("=")
            if (
                value
                and any(word in key.upper() for word in ("PASSWORD", "SECRET", "TOKEN"))
                and key not in args.allow_image_env
            ):
                raise ValueError(
                    f"Image contains a populated secret-like environment key: {key}"
                )
    mounts = {}
    for service, container in containers.items():
        allowed = (
            ("/backend/", "/var/www/html/", "/etc/nginx/templates/")
            if service == "romm"
            else ("/app/",)
        )
        mounts[service] = []
        for mount in container["Mounts"]:
            target = mount["Destination"]
            if mount["Type"] != "bind" or mount["RW"] or not target.startswith(allowed):
                continue
            source = Path(mount["Source"])
            for entry in ([source] if source.is_file() else source.rglob("*")):
                if (
                    entry.is_symlink()
                    or entry.name == ".env"
                    or entry.suffix in (".pem", ".key")
                ):
                    raise ValueError(
                        f"Unexpected secret-like file or symlink in code mount: {target}"
                    )
            relative = Path("runtime") / service / target.lstrip("/")
            destination = output / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir():
                shutil.copytree(source, destination)
            else:
                shutil.copy2(source, destination)
            mounts[service].append(f"./{relative.as_posix()}:{target}:ro")
    template = ROOT / "deploy/netplay"
    for source in template.iterdir():
        if source.is_file():
            shutil.copy2(source, output / source.name)
    services = json.loads((output / "compose.json").read_text())
    for name, image in images.items():
        services["services"][name]["image"] = image
    services["services"]["save-init"]["image"] = images["netplay-bridge"]
    for name, bindings in mounts.items():
        services["services"][name]["volumes"].extend(bindings)
    (output / "compose.json").write_text(json.dumps(services, indent=2) + "\n")
    for name, source in {
        "README.md": ROOT / "docs/NETPLAY_INSTALL.md",
        "LICENSE": ROOT / "LICENSE",
    }.items():
        shutil.copy2(source, output / name)
    shutil.copy2(ROOT / "deploy/config.yml", output / "config.example.yml")
    shutil.copy2(ROOT / "docs/ROLLBACK_ROOMS.md", output / "PLAYER_GUIDE.md")
    shutil.copy2(ROOT / "docs/NETPLAY_BRIDGE.md", output / "NETPLAY_BRIDGE.md")
    shutil.copy2(ROOT / "docs/NETPLAY_INSTALL.md", output / "NETPLAY_INSTALL.md")
    shutil.copy2(ROOT / "docs/ROLLBACK_ROOMS.md", output / "ROLLBACK_ROOMS.md")
    shutil.copy2(ROOT / "docs/PRIVATE_GHCR.md", output / "PRIVATE_GHCR.md")
    shutil.copytree(ROOT / "docs/history", output / "history")
    if not args.without_images:
        with (output / "images.tar.gz").open("wb") as destination:
            process = (
                subprocess.Popen(  # nosec B603 B607: fixed Docker command, no shell
                    ["docker", "image", "save", *dict.fromkeys(images.values())],
                    stdout=subprocess.PIPE,
                )
            )
            try:
                with gzip.GzipFile(
                    fileobj=destination, mode="wb", compresslevel=1, mtime=0
                ) as compressed:
                    shutil.copyfileobj(process.stdout, compressed, 1024 * 1024)
            finally:
                process.stdout.close()
            if process.wait() != 0:
                raise RuntimeError(
                    "Image export failed; do not distribute this directory"
                )
    manifest = {
        "schemaVersion": 1,
        "platform": "linux/amd64",
        "images": images,
        "reviewedImageEnvironmentKeys": args.allow_image_env,
        "containsImages": not args.without_images,
        "sha256": {
            p.relative_to(output).as_posix(): digest(p)
            for p in sorted(output.rglob("*"))
            if p.is_file()
        },
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(
        f'Installer exported: {output} ({len(manifest["sha256"])} files). No container writable layers or data volumes were exported.'
    )


if __name__ == "__main__":
    main()
