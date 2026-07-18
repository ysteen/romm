#!/usr/bin/env bash
set -euo pipefail

ROMM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_ROOT="$(cd "$ROMM_ROOT/.." && pwd)"
SOURCE="$WORKSPACE_ROOT/build/output/ppsspp-thread-wasm.data"
DEST="$ROMM_ROOT/custom-emulatorjs/data/cores/ppsspp-thread-wasm.data"
REPORT_SOURCE="$WORKSPACE_ROOT/build/output/reports/ppsspp.json"
REPORT_DEST="$ROMM_ROOT/custom-emulatorjs/data/cores/reports/ppsspp.json"

install -m 0644 "$SOURCE" "$DEST"
install -D -m 0644 "$REPORT_SOURCE" "$REPORT_DEST"

sha256sum "$DEST"
echo "Patched PPSSPP core updated at: $DEST"
echo "PPSSPP cache report updated at: $REPORT_DEST"
