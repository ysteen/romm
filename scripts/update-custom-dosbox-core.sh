#!/usr/bin/env bash
set -euo pipefail

ROMM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_ROOT="$(cd "$ROMM_ROOT/.." && pwd)"
DEST="$ROMM_ROOT/custom-emulatorjs/data"
SOURCE="$WORKSPACE_ROOT/build/output"
REPORT_SOURCE="$SOURCE/reports/dosbox_pure.json"
REPORT_DEST="$DEST/cores/reports/dosbox_pure.json"

mkdir -p "$DEST/cores"
install -m 0644 \
  "$SOURCE/dosbox_pure-thread-wasm.data" \
  "$DEST/cores/dosbox_pure-thread-wasm.data"
install -m 0644 \
  "$SOURCE/dosbox_pure-thread-legacy-wasm.data" \
  "$DEST/cores/dosbox_pure-thread-legacy-wasm.data"
install -D -m 0644 "$REPORT_SOURCE" "$REPORT_DEST"

sha256sum "$DEST/cores/"dosbox_pure-thread*-wasm.data
echo "Custom DOSBox Pure cores updated under: $DEST/cores"
echo "DOSBox Pure cache report updated at: $REPORT_DEST"
echo "The pinned EmulatorJS nightly frontend and RomM integration files were left unchanged."
