"""Reject publication to a GHCR package that is not private."""

import argparse
import json
import os
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen


def check_package(owner: str, package: str, *, allow_missing: bool = False) -> None:
    token = os.environ.get("GH_TOKEN")
    if not token:
        raise RuntimeError("GH_TOKEN is required to verify package visibility")
    request = Request(
        "https://api.github.com/users/"
        f"{quote(owner, safe='')}/packages/container/{quote(package, safe='')}",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urlopen(request, timeout=30) as response:
            metadata = json.load(response)
    except HTTPError as error:
        if error.code == 404 and allow_missing:
            print(f"{owner}/{package}: new packages default to private")
            return
        raise RuntimeError(
            f"Cannot verify {owner}/{package}: HTTP {error.code}"
        ) from error
    if metadata.get("visibility") != "private":
        raise RuntimeError(f"Refusing non-private package: {owner}/{package}")
    print(f"{owner}/{package}: private")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("owner")
    parser.add_argument("package")
    parser.add_argument("--allow-missing", action="store_true")
    args = parser.parse_args()
    check_package(args.owner, args.package, allow_missing=args.allow_missing)
