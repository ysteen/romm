#!/usr/bin/env bash
set -euo pipefail

ROMM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_ROOT="$(cd "$ROMM_ROOT/.." && pwd)"
SOURCE="$WORKSPACE_ROOT/build/output"
DEST="$ROMM_ROOT/custom-emulatorjs/data/cores"

for variant in wasm legacy-wasm thread-wasm thread-legacy-wasm; do
    install -m 0644 "$SOURCE/melonds-$variant.data" "$DEST/melonds-$variant.data"
    sha256sum "$DEST/melonds-$variant.data"
done
install -D -m 0644 "$SOURCE/reports/melonds.json" "$DEST/reports/melonds.json"
echo "Patched melonDS cores and cache report updated at: $DEST"
