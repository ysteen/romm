#!/usr/bin/env bash
set -euo pipefail
SCRIPT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_SOURCE="${NETPLAY_BRIDGE_SOURCE:-${SCRIPT_ROOT}/../../retroarch-netplay-bridge}"
BUILD_SCRIPT="${BRIDGE_SOURCE}/scripts/build-retroarch-rollback-snes9x.sh"
if [[ ! -f ${BUILD_SCRIPT} ]]; then
	printf 'Clone ysteen/retroarch-netplay-bridge beside RomM or set NETPLAY_BRIDGE_SOURCE.\n' >&2
	exit 1
fi
exec bash "${BUILD_SCRIPT}" "$@"
