#!/usr/bin/env bash
# Build the versioned SameBoy rollback core and native/WASM state probes.
set -euo pipefail
export EMCC_CORES=2 BINARYEN_CORES=2
COMPAT_REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TASK_ROOT="$(cd -- "$COMPAT_REPO/.." && pwd)"
COMPAT_WORK="${COMPAT_WORK:-$TASK_ROOT/result/netplay-interop/sameboy-rollback-build}"
COMPAT_EMSDK="${COMPAT_EMSDK:-$TASK_ROOT/build/emsdk}"
COMPAT_ARCHIVE="${COMPAT_ARCHIVE:-$TASK_ROOT/result/netplay-interop/stock-core/downloads/SameBoy-c87d256.tar.gz}"
COMPAT_BOOTROMS="${COMPAT_BOOTROMS:-$TASK_ROOT/result/netplay-interop/stock-core/SameBoy-c87d256/build/bin/BootROMs}"
COMPAT_FRONTEND="${COMPAT_FRONTEND:-$TASK_ROOT/build/compile/retroarch-netplay}"
COMPAT_PATCH="$COMPAT_REPO/patches/sameboy-rollback-state.patch"
COMPAT_CABLE_PATCH="$COMPAT_REPO/patches/sameboy-cable.patch"
COMPAT_PROBE="$COMPAT_REPO/test/libretro-probe.c"
COMPAT_VERSION=c87d256-cable1
if [[ -e $COMPAT_WORK ]]; then
	printf 'Refusing to reuse existing work directory: %s\n' "$COMPAT_WORK" >&2
	exit 1
fi
test -x "$COMPAT_EMSDK/upstream/emscripten/emcc"
printf '%s  %s\n' 67a65d1f13e8a132bff3955bdf98ad67c5049552721f9417c9f597ae0039b6a6 "$COMPAT_ARCHIVE" | sha256sum --check --status
python3 - "$COMPAT_BOOTROMS" <<'PY'
import hashlib, sys
from pathlib import Path
root = Path(sys.argv[1])
expected = {
    'agb': '648fd2ade35a77ce93fb4ceac754b0f0465f1eaf0db0cbef1bed55bfd8a71794',
    'cgb0': '2c297b6cb762cd0a50253449fd026ae30c76f0cc30b919e2ff498bca7682eacc',
    'cgb': 'f767b8e7e510a255f81328c89dba6e0c996b370e1bc86aebb8584a7da47a5bba',
    'dmg': '6f64da4cecd7e54e2f928eb3e3ba7810a7a567d0d247cc71737d1771e073a916',
    'mgb': '12eb4b96f8c2c19cd51c209af1f0a5aa19e01f886114ae848258a592f408ef4e',
    'sgb2': '8a65465a9da7ec657726a671da9a85963cf19d2c975e499aea6b97eb37e0b6ea',
    'sgb': 'b60d493a7944ccf74c81f1e7b6bf38c2c7029e296648ea0e74cb22b10dd1fcb8',
}
for model, digest in expected.items():
    path = root / f'{model}_boot.bin'
    if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
        raise SystemExit(f'Boot ROM mismatch: {path}')
PY
mkdir -p -- "$COMPAT_WORK/native-source" "$COMPAT_WORK/wasm-source"
for kind in native wasm; do
	tar -xzf "$COMPAT_ARCHIVE" --strip-components=1 -C "$COMPAT_WORK/$kind-source"
	patch -d "$COMPAT_WORK/$kind-source" -p1 --input "$COMPAT_PATCH"
	patch -d "$COMPAT_WORK/$kind-source" -p1 --input "$COMPAT_CABLE_PATCH"
done
make -C "$COMPAT_WORK/native-source/libretro" -j2 GIT_VERSION="$COMPAT_VERSION" BOOTROMS_DIR="$COMPAT_BOOTROMS"
export EM_CONFIG="$COMPAT_EMSDK/.emscripten"
export PATH="$COMPAT_EMSDK/upstream/emscripten:$COMPAT_EMSDK/upstream/bin:$PATH"
make -C "$COMPAT_WORK/wasm-source/libretro" -j2 platform=emscripten STATIC_LINKING=1 \
	GIT_VERSION="$COMPAT_VERSION" CC=emcc AR=emar BOOTROMS_DIR="$COMPAT_BOOTROMS"
cp -- "$COMPAT_WORK/wasm-source/libretro/sameboy_libretro_emscripten.bc" "$COMPAT_WORK/sameboy_libretro.a"
cc -O2 -fPIC -shared "$COMPAT_PROBE" "$COMPAT_WORK/native-source/sameboy_libretro.so" \
	-I "$COMPAT_WORK/native-source/libretro" -o "$COMPAT_WORK/native-probe.so" \
	"-Wl,-rpath,$COMPAT_WORK/native-source"
emcc "$COMPAT_PROBE" "$COMPAT_WORK/sameboy_libretro.a" \
	-I "$COMPAT_WORK/wasm-source/libretro" -O2 -sMODULARIZE=1 -sEXPORT_ES6=1 \
	-sENVIRONMENT=node,web -sALLOW_MEMORY_GROWTH=1 \
	-sEXPORTED_FUNCTIONS='["_malloc","_free","_probe_init","_probe_step","_probe_size","_probe_save","_probe_load","_probe_close","_retro_get_memory_data","_retro_get_memory_size"]' \
	-o "$COMPAT_WORK/core-probe.mjs"
if [[ ${COMPAT_BUILD_WEB:-0} == 1 ]]; then
	python3 - "$COMPAT_FRONTEND" "$COMPAT_WORK/frontend" <<'PY'
import shutil, sys
shutil.copytree(sys.argv[1], sys.argv[2], ignore=shutil.ignore_patterns('.git'))
PY
	cp -- "$COMPAT_WORK/sameboy_libretro.a" "$COMPAT_WORK/frontend/libretro_emscripten.a"
	emmake make -C "$COMPAT_WORK/frontend" -f Makefile.emulatorjs -j2 \
		TARGET=sameboy_libretro.js HAVE_THREADS=0 HAVE_OPENGLES3=1 HAVE_CHD=0 \
		HAVE_7ZIP=1 HAVE_AL=0 HAVE_RWEBAUDIO=1 ASYNC=0
	mkdir -p -- "$COMPAT_WORK/web"
	cp -- "$COMPAT_WORK/frontend/sameboy_libretro.js" "$COMPAT_WORK/frontend/sameboy_libretro.wasm" "$COMPAT_WORK/web/"
	cp -- "$COMPAT_WORK/native-source/LICENSE" "$COMPAT_WORK/web/license.txt"
	python3 - "$COMPAT_WORK/web" <<'PY'
import json, sys
from pathlib import Path
out = Path(sys.argv[1])
core = {'name': 'sameboy', 'extensions': ['gb', 'gbc'], 'options': {}, 'save': 'srm',
        'repo': 'https://github.com/libretro/SameBoy',
        'retroarchOpts': [{'name': 'audio_out_rate', 'title': 'Audio sample rate',
                          'options': ['48000'], 'default': '48000', 'isString': False}]}
build = {'minimumEJSVersion': '4.3.0', 'version': 'sameboy-c87d256-cable1',
         'sameboy': 'c87d256', 'stateProfile': 'SBR3', 'stockCore': False}
for name, value in [('core.json', core), ('build.json', build)]:
    (out / name).write_text(json.dumps(value) + '\n')
PY
	(
		cd -- "$COMPAT_WORK/web"
		7z a -t7z -mx=7 sameboy-wasm.data sameboy_libretro.js sameboy_libretro.wasm core.json build.json license.txt
	)
fi
python3 - "$COMPAT_WORK" "$COMPAT_PATCH" <<'PY'
from pathlib import Path
import hashlib, json, sys
root, patch = map(Path, sys.argv[1:])
paths = ['native-source/sameboy_libretro.so', 'native-probe.so', 'sameboy_libretro.a', 'core-probe.mjs', 'core-probe.wasm']
paths += [str(p.relative_to(root)) for p in (root / 'web').glob('*')] if (root / 'web').exists() else []
manifest = {'core': 'SameBoy', 'version': '1.0.4c87d256-cable1', 'stateProfile': 'SBR3',
            'patchSha256': hashlib.sha256(patch.read_bytes()).hexdigest(),
            'sha256': {p: hashlib.sha256((root / p).read_bytes()).hexdigest() for p in paths}}
manifest['inputProfile'] = 'link-cable-r3-v1'
manifest['cablePatchSha256'] = hashlib.sha256((patch.parent / 'sameboy-cable.patch').read_bytes()).hexdigest()
(root / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
PY
printf 'Native core: %s\nWASM probe: %s\n' "$COMPAT_WORK/native-source/sameboy_libretro.so" "$COMPAT_WORK/core-probe.mjs"
