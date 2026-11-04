#!/usr/bin/env bash
# Build identical mGBA Splitscreen rollback state support for native and WASM.
# Uses the prepared Emscripten/RetroArch workspace; never changes packaged cores.
set -euo pipefail
export EMCC_CORES=2 BINARYEN_CORES=2
COMPAT_REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TASK_ROOT="$(cd -- "$COMPAT_REPO/.." && pwd)"
COMPAT_WORK="${COMPAT_WORK:-$TASK_ROOT/result/netplay-interop/mgba-rollback-build}"
COMPAT_EMSDK="${COMPAT_EMSDK:-$TASK_ROOT/build/emsdk}"
COMPAT_ARCHIVE="${COMPAT_ARCHIVE:-$TASK_ROOT/result/netplay-interop/stock-core/downloads/mgba-splitscreen-f1d5975.tar.gz}"
COMPAT_FRONTEND="${COMPAT_FRONTEND:-$TASK_ROOT/build/compile/retroarch-netplay}"
COMPAT_PATCH="$COMPAT_REPO/patches/mgba-rollback-state.patch"
COMPAT_STARTUP_PATCH="$COMPAT_REPO/patches/mgba-native-startup.patch"
COMPAT_MULTI_ROM_PATCH="$COMPAT_REPO/patches/mgba-multi-rom.patch"
COMPAT_PROBE="$COMPAT_REPO/test/mgba-core-probe.c"
if [[ -e $COMPAT_WORK ]]; then
	printf 'Refusing to reuse existing work directory: %s\n' "$COMPAT_WORK" >&2
	exit 1
fi
test -x "$COMPAT_EMSDK/upstream/emscripten/emcc"
printf '%s  %s\n' 8374542f8a042a1ad661a5e886083f3cfcf84fe79c1e471dae5eb6c432b88958 "$COMPAT_ARCHIVE" | sha256sum --check --status
mkdir -p -- "$COMPAT_WORK/native-source" "$COMPAT_WORK/wasm-source"
for kind in native wasm; do
	tar -xzf "$COMPAT_ARCHIVE" --strip-components=1 -C "$COMPAT_WORK/$kind-source"
	patch -d "$COMPAT_WORK/$kind-source" -p1 --input "$COMPAT_PATCH"
	patch -d "$COMPAT_WORK/$kind-source" -p1 --input "$COMPAT_MULTI_ROM_PATCH"
done
patch -d "$COMPAT_WORK/native-source" -p1 --input "$COMPAT_STARTUP_PATCH"
python3 - "$COMPAT_WORK/wasm-source/CMakeLists.txt" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
old = 'add_library(mgba_splitscreen_libretro SHARED ${CORE_SRC} ${SP_SRC} ${SP_SIO_SRC} ${CORE_VFS_SRC})'
assert s.count(old) == 1
p.write_text(s.replace(old, 'add_library(mgba_splitscreen_libretro STATIC ${CORE_SRC} ${SP_SRC} ${SP_SIO_SRC} ${CORE_VFS_SRC})'))
PY
COMPAT_CMAKE_FLAGS=(
	-DCMAKE_BUILD_TYPE=Release -DLIBMGBA_ONLY=ON -DBUILD_LIBRETRO_SPLITSCREEN=ON
	-DBUILD_SHARED=OFF -DBUILD_STATIC=OFF -DENABLE_DEBUGGERS=OFF -DENABLE_SCRIPTING=OFF
	-DUSE_ELF=OFF -DUSE_LIBZIP=OFF -DUSE_LZMA=OFF -DUSE_MINIZIP=OFF
	-DUSE_PNG=OFF -DUSE_SQLITE3=OFF -DUSE_ZLIB=OFF
)
cmake -S "$COMPAT_WORK/native-source" -B "$COMPAT_WORK/native" "${COMPAT_CMAKE_FLAGS[@]}"
cmake --build "$COMPAT_WORK/native" --target mgba_splitscreen_libretro -j2
cc -O2 -fPIC -shared "$COMPAT_PROBE" "$COMPAT_WORK/native/mgba_splitscreen_libretro.so" \
	-I "$COMPAT_WORK/native-source/src/platform/libretro" -o "$COMPAT_WORK/native-probe.so" \
	"-Wl,-rpath,$COMPAT_WORK/native"
export EM_CONFIG="$COMPAT_EMSDK/.emscripten"
export PATH="$COMPAT_EMSDK/upstream/emscripten:$COMPAT_EMSDK/upstream/bin:$PATH"
emcmake cmake -S "$COMPAT_WORK/wasm-source" -B "$COMPAT_WORK/wasm" \
	"${COMPAT_CMAKE_FLAGS[@]}" -DCMAKE_C_FLAGS=-D_GNU_SOURCE
cmake --build "$COMPAT_WORK/wasm" --target mgba_splitscreen_libretro -j2
emcc "$COMPAT_PROBE" "$COMPAT_WORK/wasm/mgba_splitscreen_libretro.a" \
	-I "$COMPAT_WORK/wasm-source/src/platform/libretro" -O2 -sMODULARIZE=1 -sEXPORT_ES6=1 \
	-sENVIRONMENT=node,web -sALLOW_MEMORY_GROWTH=1 \
	-sEXPORTED_FUNCTIONS='["_malloc","_free","_probe_init","_probe_init_pair","_probe_step","_probe_size","_probe_save","_probe_load","_probe_close","_probe_memory","_probe_memory_size"]' \
	-o "$COMPAT_WORK/core-probe.mjs"
if [[ ${COMPAT_BUILD_WEB:-0} == 1 ]]; then
	python3 - "$COMPAT_FRONTEND" "$COMPAT_WORK/frontend" <<'PY'
from pathlib import Path
import shutil, sys
source, target = map(Path, sys.argv[1:])
shutil.copytree(source, target, ignore=shutil.ignore_patterns('.git'))
shim = target / 'ejs-input-netplay.inc'
s = shim.read_text()
assert 'ejs_sync_buttons[2]' in s
s = s.replace('ejs_sync_buttons[2]', 'ejs_sync_buttons[4]').replace('port >= 2', 'port >= 4')
s = s.replace('EMSCRIPTEN_KEEPALIVE int ejs_sync_step(unsigned p1, unsigned p2, int present)',
              'EMSCRIPTEN_KEEPALIVE int ejs_sync_step_multi(unsigned p1, unsigned p2, unsigned p3, unsigned p4, int present)')
s = s.replace('   ejs_sync_buttons[1] = p2;\n', '   ejs_sync_buttons[1] = p2;\n   ejs_sync_buttons[2] = p3;\n   ejs_sync_buttons[3] = p4;\n')
s = s.replace('EMSCRIPTEN_KEEPALIVE size_t ejs_sync_state_size(void)',
              'EMSCRIPTEN_KEEPALIVE int ejs_sync_step(unsigned p1, unsigned p2, int present)\n{\n   return ejs_sync_step_multi(p1, p2, 0, 0, present);\n}\n\nEMSCRIPTEN_KEEPALIVE size_t ejs_sync_state_size(void)')
shim.write_text(s)
(target / 'retroarch.c').touch()
PY
	cp -- "$COMPAT_WORK/wasm/mgba_splitscreen_libretro.a" "$COMPAT_WORK/frontend/libretro_emscripten.a"
	emmake make -C "$COMPAT_WORK/frontend" -f Makefile.emulatorjs -j2 \
		TARGET=mgba_link_libretro.js HAVE_THREADS=0 HAVE_OPENGLES3=1 HAVE_CHD=0 \
		HAVE_7ZIP=1 HAVE_AL=0 HAVE_RWEBAUDIO=1 ASYNC=0
	mkdir -p -- "$COMPAT_WORK/web"
	cp -- "$COMPAT_WORK/frontend/mgba_link_libretro.js" "$COMPAT_WORK/frontend/mgba_link_libretro.wasm" "$COMPAT_WORK/web/"
	cp -- "$COMPAT_WORK/native-source/LICENSE" "$COMPAT_WORK/web/license.txt"
	python3 - "$COMPAT_WORK/web" <<'PY'
import json, sys
from pathlib import Path
out = Path(sys.argv[1])
core = {'name': 'mgba_splitscreen', 'extensions': ['gba'], 'options': {}, 'save': 'srm', 'repo': 'https://github.com/Spuds0588/mgba-splitscreen'}
build = {'minimumEJSVersion': '4.3.0', 'version': 'mgba-f1d5975-rollback2', 'stateProfile': 'SPST4', 'stockCore': False, 'frontendInputs': 4, 'orderedCartridges': True}
for name, value in [('core.json', core), ('build.json', build)]:
    (out / name).write_text(json.dumps(value) + '\n')
PY
	(
		cd -- "$COMPAT_WORK/web"
		7z a -t7z -mx=7 mgba_splitscreen-wasm.data mgba_link_libretro.js mgba_link_libretro.wasm core.json build.json license.txt
	)
fi
python3 - "$COMPAT_WORK" "$COMPAT_PATCH" "$COMPAT_STARTUP_PATCH" "$COMPAT_MULTI_ROM_PATCH" <<'PY'
from pathlib import Path
import hashlib, json, sys
root, patch, startup_patch, multi_rom_patch = map(Path, sys.argv[1:])
paths = ['native/mgba_splitscreen_libretro.so', 'native-probe.so', 'wasm/mgba_splitscreen_libretro.a', 'core-probe.mjs', 'core-probe.wasm']
paths += [str(p.relative_to(root)) for p in (root / 'web').glob('*')] if (root / 'web').exists() else []
manifest = {'core': 'mGBA Splitscreen', 'version': '0.1.0-f1d5975-rollback2', 'stateProfile': 'SPST4',
            'sourceRevision': 'f1d5975d77285f77affbfe64b7050ebd5c4b6a77',
            'patchSha256': hashlib.sha256(patch.read_bytes()).hexdigest(),
            'startupPatchSha256': hashlib.sha256(startup_patch.read_bytes()).hexdigest(),
            'multiRomPatchSha256': hashlib.sha256(multi_rom_patch.read_bytes()).hexdigest(),
            'orderedCartridges': True,
            'nativeStartup': 'configured-players-v1',
            'sha256': {p: hashlib.sha256((root / p).read_bytes()).hexdigest() for p in paths}}
(root / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
PY
printf 'Native core: %s\nWASM probe: %s\n' "$COMPAT_WORK/native/mgba_splitscreen_libretro.so" "$COMPAT_WORK/core-probe.mjs"
