#!/usr/bin/env bash
set -euo pipefail

ROMM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_ROOT="$(cd "$ROMM_ROOT/.." && pwd)"
SOURCE="${1:-$WORKSPACE_ROOT/ED5WINK_Win95.zip}"
OUTPUT="${2:-$ROMM_ROOT/custom-emulatorjs/roms/ED5WINK.zip}"
AUTOBOOT="$ROMM_ROOT/custom-emulatorjs/autoboot/AUTOBOOT.DBP"

mkdir -p "$(dirname "$OUTPUT")"
cp "$SOURCE" "$OUTPUT"
zip -d "$OUTPUT" 'Win95.img' 'BOOT95.BAT' 'DOS.YML'
# DOSBox Pure's native installed-OS auto-start format. The O* prefix selects
# an OS image by its filename without the .img suffix from the system folder.
zip -j "$OUTPUT" "$AUTOBOOT"
unzip -t "$OUTPUT"
echo "RomM game package created with Windows95 installed-OS auto-start: $OUTPUT"
