#!/usr/bin/env bash
set -euo pipefail

ROMM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_ROOT="$(cd "$ROMM_ROOT/.." && pwd)"
SOURCE="$WORKSPACE_ROOT/build/output/azahar-thread-wasm.data"
DEST="$ROMM_ROOT/custom-emulatorjs/data/cores/azahar-thread-wasm.data"
REPORT_SOURCE="$WORKSPACE_ROOT/build/output/reports/azahar.json"
REPORT_DEST="$ROMM_ROOT/custom-emulatorjs/data/cores/reports/azahar.json"

install -m 0644 "$SOURCE" "$DEST"
install -D -m 0644 "$REPORT_SOURCE" "$REPORT_DEST"

sha256sum "$DEST"
echo "Patched Azahar core updated at: $DEST"
echo "Azahar cache report updated at: $REPORT_DEST"
