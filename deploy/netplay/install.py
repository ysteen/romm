#!/usr/bin/env python3
"""Initialize, verify and run a portable RomM netplay installation."""

import argparse
import hashlib
import json
import os
import secrets
import shutil
import subprocess  # nosec B404
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent


def verify():
    manifest = json.loads((ROOT / "manifest.json").read_text())
    for name, expected in manifest["sha256"].items():
        path = (ROOT / name).resolve()
        if not path.is_relative_to(ROOT) or not path.is_file():
            raise ValueError(f"Missing or unsafe package path: {name}")
        with path.open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != expected:
                raise ValueError(f"Package checksum mismatch: {name}")
    return manifest


def compose(*args):
    subprocess.run(  # nosec B603 B607: fixed commands with argument vectors, no shell
        [
            "docker",
            "compose",
            "--project-name",
            "romm-netplay",
            "--env-file",
            str(ROOT / ".env"),
            "-f",
            str(ROOT / "compose.json"),
            *args,
        ],
        cwd=ROOT,
        check=True,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "action", choices=["init", "check", "up", "status", "logs", "stop"]
    )
    parser.add_argument("--origin", help="Public RomM HTTPS origin, without a path")
    parser.add_argument(
        "--native-host",
        help="Native TCP DNS name or IPv4 address, without scheme or port",
    )
    args = parser.parse_args()
    if args.action == "init":
        origin = urlsplit(args.origin or "")
        host = args.native_host or origin.hostname or ""
        if (
            origin.scheme != "https"
            or not origin.hostname
            or origin.username
            or origin.password
            or origin.query
            or origin.fragment
            or origin.path not in ("", "/")
        ):
            parser.error(
                "init requires --origin https://romm.example.com (an origin without a path)"
            )
        if not host or any(
            c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-"
            for c in host
        ):
            parser.error("--native-host requires a DNS name or IPv4 address")
        origin_text = args.origin.rstrip("/")
        if "$" in origin_text or any(c in origin_text for c in '\n\r"'):
            parser.error("Unsupported origin characters")
        verify()
        path = ROOT / ".env"
        if path.exists():
            raise ValueError(
                ".env already exists; edit its public addresses to move servers. Existing secrets were preserved."
            )
        values = {
            "DB_ROOT_PASSWORD": secrets.token_hex(24),
            "DB_PASSWORD": secrets.token_hex(24),
            "ROMM_AUTH_SECRET_KEY": secrets.token_hex(32),
            "NETPLAY_BRIDGE_TOKEN": secrets.token_hex(32),
            "ROMM_ORIGIN": origin_text,
            "NETPLAY_BRIDGE_PUBLIC_URL": origin_text + "/netplay",
            "NETPLAY_BRIDGE_PUBLIC_HOST": host,
            "ROMM_PORT": "8080",
            "BRIDGE_PORT": "8082",
            "ROMM_DATA_DIR": "./data",
            "NETPLAY_BRIDGE_TCP_BIND": "0.0.0.0",  # nosec B104: native clients need the published TCP listener
            "TZ": "Asia/Seoul",
        }
        with open(
            path, "x", opener=lambda p, flags: os.open(p, flags, 0o600)
        ) as destination:
            destination.write(
                "".join(f"{key}={value}\n" for key, value in values.items())
            )
        for directory in (
            "mysql",
            "library/roms",
            "library/bios",
            "assets",
            "resources",
            "config",
            "redis-data",
        ):
            (ROOT / "data" / directory).mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / "config.example.yml", ROOT / "data/config/config.yml")
        print(
            "Created .env and empty data directories. Configure HTTPS using Caddyfile.example, then run: python3 install.py up"
        )
    elif args.action in ("check", "up"):
        manifest = verify()
        if args.action == "up":
            missing = [
                image
                for image in manifest["images"].values()
                if subprocess.run(  # nosec B603 B607: fixed commands with argument vectors, no shell
                    ["docker", "image", "inspect", image],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                ).returncode
            ]
            if missing:
                if not manifest["containsImages"]:
                    raise ValueError(
                        "Required images are missing. Load the matching images or use a bundle containing images."
                    )
                subprocess.run(  # nosec B603 B607: fixed commands with argument vectors, no shell
                    ["docker", "image", "load", "-i", str(ROOT / "images.tar.gz")],
                    check=True,
                )
        compose("config", "--quiet")
        if args.action == "up":
            compose(
                "up",
                "-d",
                "--no-build",
                "--pull",
                "never",
                "--wait",
                "--wait-timeout",
                "360",
            )
        else:
            print(
                "Package hashes and Compose configuration passed. No service was started."
            )
    elif args.action == "status":
        compose("ps")
    elif args.action == "logs":
        compose("logs", "--tail", "100", "-f", "romm", "netplay-bridge")
    else:
        compose("stop")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error)) from None
