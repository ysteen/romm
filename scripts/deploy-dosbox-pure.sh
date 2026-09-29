#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/deploy/.env"
COMPOSE_FILE="$ROOT/compose.dosbox-pure.yml"
ROMFORGE_MODE="keep"
BUILD_IMAGES=true

usage() {
  cat <<'HELP'
Usage: deploy-dosbox-pure.sh [--romforge | --no-romforge] [--no-build] [--env-file PATH]

  --romforge       Enable the optional worker and automatic 3DS scan conversion.
  --no-romforge    Disable RomForge and gracefully stop its worker.
  --no-build       Use existing application and worker images.
  --env-file PATH  Use an existing or newly generated deployment env file.

Without a mode flag, preserve ROMFORGE_ENABLED from the env file (default false).
Existing limits and normalization preferences are preserved. Keys are never generated.
HELP
}
while (($#)); do
  case "$1" in
    --romforge) ROMFORGE_MODE=enable ;;
    --no-romforge) ROMFORGE_MODE=disable ;;
    --no-build) BUILD_IMAGES=false ;;
    --env-file)
      [[ $# -ge 2 && -n "$2" ]] || { echo "--env-file requires a path" >&2; exit 2; }
      ENV_FILE="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
ENV_FILE="$(realpath -m "$ENV_FILE")"
cd "$ROOT"

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

umask 077
mkdir -p "$(dirname "$ENV_FILE")"
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
ROMM_IMAGE=romm-custom-dosbox-pure:5.3.1
HASHEOUS_API_ENABLED=true
TZ=Asia/Seoul
ROMFORGE_ENABLED=false
DISABLE_JSDOS=true
EOF
  chmod 600 "$ENV_FILE"
  echo "Generated deploy/.env with random secrets."
fi

# Compose parses the env file; never execute it as shell code.
set_env() {
  local name="$1" value="$2" temporary
  temporary="$(mktemp "${ENV_FILE}.XXXXXX")"
  awk -v name="$name" -v value="$value" '
    $0 ~ "^[[:space:]]*" name "=" { if (!written++) print name "=" value; next }
    { print }
    END { if (!written) print name "=" value }
  ' "$ENV_FILE" > "$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$ENV_FILE"
}
if [[ "$ROMFORGE_MODE" == enable ]]; then
  set_env ROMFORGE_ENABLED true
  if ! grep -Eq '^[[:space:]]*ROMFORGE_NORMALIZE_3DS_ON_SCAN=' "$ENV_FILE"; then
    set_env ROMFORGE_NORMALIZE_3DS_ON_SCAN true
  fi
elif [[ "$ROMFORGE_MODE" == disable ]]; then
  set_env ROMFORGE_ENABLED false
fi
if ! grep -Eq '^[[:space:]]*ROMFORGE_ENABLED=' "$ENV_FILE"; then
  set_env ROMFORGE_ENABLED false
fi

COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE"
  -f "$ROOT/compose.romforge.yml" --profile romforge)
# Read only non-secret resolved fields, without exposing the full Compose configuration.
readarray -t SETTINGS < <("${COMPOSE[@]}" config --format json | python3 -c '
import json, sys
c = json.load(sys.stdin)["services"]["romm"]
print(str(c["environment"]["ROMFORGE_ENABLED"]).lower())
for target in ("/romm/config", "/romm/library", "/romm/resources"):
    print(next(v["source"] for v in c["volumes"] if v["target"] == target))
print(c["ports"][0]["published"])
')
[[ ${#SETTINGS[@]} == 5 ]] || { echo "Could not resolve deployment configuration" >&2; exit 1; }
ENABLED="${SETTINGS[0]}"
CONFIG_DIR="${SETTINGS[1]}"
LIBRARY_DIR="${SETTINGS[2]}"
RESOURCES_DIR="${SETTINGS[3]}"
PORT="${SETTINGS[4]}"
mkdir -p "$CONFIG_DIR" "$LIBRARY_DIR" "$RESOURCES_DIR"
if [[ ! -f "$CONFIG_DIR/config.yml" ]]; then
  cp "$ROOT/deploy/config.yml" "$CONFIG_DIR/config.yml"
fi
if [[ "$ENABLED" == true ]]; then
  mkdir -p "$CONFIG_DIR/romforge/keys"
  chmod 750 "$CONFIG_DIR/romforge/keys"
fi

# Build the application first: the worker's base image must include this revision.
if $BUILD_IMAGES; then
  "${COMPOSE[@]}" build romm
  if [[ "$ENABLED" == true ]]; then
    "${COMPOSE[@]}" build romforge
  fi
fi
# The worker shares the application's network namespace and must be recreated with it.
"${COMPOSE[@]}" stop romforge
"${COMPOSE[@]}" up -d --no-build database romm
if [[ "$ENABLED" == true ]]; then
  "${COMPOSE[@]}" up -d --no-build --no-deps --force-recreate romforge
fi
"${COMPOSE[@]}" ps

echo "RomM is starting at http://localhost:$PORT"
echo "ROM directory: $LIBRARY_DIR/roms"
echo "BIOS directory: $LIBRARY_DIR/bios"
if [[ "$ENABLED" == true ]]; then
  echo "RomForge keys: $CONFIG_DIR/romforge/keys (aes_keys.txt, seeddb.bin, certs.bin)"
  echo "The worker handles one job at a time; missing keys leave 3DS conversions pending."
else
  echo "RomForge is disabled. Enable it with --romforge; RomPatcher.js remains available."
fi
