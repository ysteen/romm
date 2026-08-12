#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/deploy/.env"
COMPOSE_FILE="$ROOT/compose.dosbox-pure.yml"

random_hex() {
  local bytes="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  else
    od -An -N "$bytes" -tx1 /dev/urandom | tr -d ' \n'
  fi
}

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker with the Compose plugin is required." >&2
  exit 1
fi

mkdir -p "$ROOT/deploy" "$ROOT/deploy-data"/{mysql,library,assets,config,resources,redis-data}

if [[ ! -f "$ENV_FILE" ]]; then
  DB_ROOT_PASSWORD="$(random_hex 24)"
  DB_PASSWORD="$(random_hex 24)"
  ROMM_AUTH_SECRET_KEY="$(random_hex 32)"
  cat >"$ENV_FILE" <<EOF
DB_ROOT_PASSWORD=$DB_ROOT_PASSWORD
DB_PASSWORD=$DB_PASSWORD
ROMM_AUTH_SECRET_KEY=$ROMM_AUTH_SECRET_KEY
ROMM_PORT=8080
ROMM_DATA_DIR=./deploy-data
ROMM_IMAGE=romm-custom-dosbox-pure:5.1.0
HASHEOUS_API_ENABLED=true
TZ=Asia/Seoul
EOF
  chmod 600 "$ENV_FILE"
  echo "Generated deploy/.env with random secrets."
fi

if [[ ! -f "$ROOT/deploy-data/config/config.yml" ]]; then
  cp "$ROOT/deploy/config.yml" "$ROOT/deploy-data/config/config.yml"
fi

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --build
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps

PORT="$(sed -n 's/^ROMM_PORT=//p' "$ENV_FILE" | tail -n 1)"
echo "RomM is starting at http://localhost:${PORT:-8080}"
echo "ROM directory: $ROOT/deploy-data/library/roms"
echo "BIOS directory: $ROOT/deploy-data/library/bios"
