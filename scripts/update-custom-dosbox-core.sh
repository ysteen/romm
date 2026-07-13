#!/usr/bin/env bash
set -euo pipefail

ROMM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_ROOT="$(cd "$ROMM_ROOT/.." && pwd)"
DEST="$ROMM_ROOT/custom-emulatorjs/data"
SOURCE="$WORKSPACE_ROOT/browser-test/data"

mkdir -p "$DEST/cores" "$DEST/compression" "$DEST/localization" "$DEST/src"
cp -a "$SOURCE/compression/." "$DEST/compression/"
cp -a "$SOURCE/localization/." "$DEST/localization/"
cp -a "$SOURCE/src/." "$DEST/src/"
install -m 0644 "$SOURCE/loader.js" "$DEST/loader.js"
install -m 0644 "$SOURCE/emulator.css" "$DEST/emulator.css"
install -m 0644 "$SOURCE/version.json" "$DEST/version.json"
install -m 0644 \
  "$SOURCE/cores/dosbox_pure-thread-wasm.data" \
  "$DEST/cores/dosbox_pure-thread-wasm.data"
install -m 0644 \
  "$SOURCE/cores/dosbox_pure-thread-legacy-wasm.data" \
  "$DEST/cores/dosbox_pure-thread-legacy-wasm.data"

sha256sum "$DEST/cores/"dosbox_pure-thread*-wasm.data
echo "RomM EmulatorJS 4.3 frontend and DOSBox Pure cores updated under: $DEST"
