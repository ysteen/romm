#!/usr/bin/env bash
set -euo pipefail

ROMM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_ROOT="$(cd "$ROMM_ROOT/.." && pwd)"
SOURCE="${1:-$WORKSPACE_ROOT/ED5WINK_Win95.zip}"
OUTPUT="${2:-$ROMM_ROOT/custom-emulatorjs/firmware/win95-system.zip}"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

SYSTEM_DIR="$TEMP_DIR/home/web_user/retroarch/userdata/system"
mkdir -p "$SYSTEM_DIR" "$(dirname "$OUTPUT")"
unzip -j "$SOURCE" 'Win95.img' -d "$SYSTEM_DIR"
mv "$SYSTEM_DIR/Win95.img" "$SYSTEM_DIR/Windows95.img"

OUTPUT="$(realpath -m "$OUTPUT")"
(
  cd "$TEMP_DIR"
  zip -9 "$OUTPUT" home/web_user/retroarch/userdata/system/Windows95.img
)

unzip -t "$OUTPUT"
echo "RomM firmware package created: $OUTPUT"
