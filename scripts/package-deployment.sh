#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="$(realpath -m "${1:?Usage: package-deployment.sh OUTPUT.tar.gz}")"
mkdir -p "$(dirname "$OUTPUT")"
tar -C "$ROOT" -czf "$OUTPUT" \
  compose.dosbox-pure.yml compose.romforge.yml \
  deploy/.env.example deploy/config.yml \
  scripts/deploy-dosbox-pure.sh docs/PRIVATE_GHCR.md LICENSE
echo "Deployment bundle: $OUTPUT"
