# Custom DOSBox Pure and shared Windows 95

This workspace pins EmulatorJS 4.3 nightly commit
`cf622ec831e1c68dbbbce9dc49923a82b4b0e2a6` on RomM 5.4.1. Nightly core files are
downloaded during the image build, then the checked-in DOSBox Pure, PPSSPP,
Azahar, melonDS, SameBoy and mGBA splitscreen binaries replace their corresponding
cores. DOSBox Pure declares a minimum
EmulatorJS version of 4.3.0, so RomM's bundled 4.2.3 frontend cannot run it. It
also supports keeping one Windows 95 disk in RomM's DOS firmware and keeping
each game as a separate ROM.

## Server deployment from private images

GitHub Actions builds the application and optional RomForge worker and publishes
them privately to GHCR. Installation servers only download the images. Follow
[Private GHCR deployment](docs/PRIVATE_GHCR.md) to authenticate Docker and download
the small installation bundle. On Linux with Python 3, Bash, Docker and a recent
Compose plugin, run from the extracted bundle:

```bash
./scripts/deploy-dosbox-pure.sh
```

The script creates `deploy/.env` with random database/authentication secrets,
initializes bind-mounted data directories under `deploy-data`, pulls the
published image, and starts RomM plus MariaDB. The default URL is
`http://localhost:8080`. Edit `deploy/.env` to change the port or timezone,
then run the script again.

The server does not need a source checkout, Emscripten or Node.js. The published
image includes the frontend, backend and custom emulator assets from the same
commit. The matching link-core build sources are published at
[`ysteen/build@4966f1a`](https://github.com/ysteen/build/commit/4966f1a).

The script waits for the database and application heartbeat before reporting
success. The image's `org.opencontainers.image.revision` label records the Git
commit used by GitHub Actions.

For browser access from another computer, use `https://your-server-name` through
your reverse proxy. The threaded cores require a secure browser context;
`http://server-ip:8080` does not provide the localhost exception. Forward
WebSockets and retain the player's `Cross-Origin-Opener-Policy` and
`Cross-Origin-Embedder-Policy` response headers. Link play between separate
networks may also need a reachable TURN server configured in RomM.

To update an existing installation, repeat:

```bash
./scripts/deploy-dosbox-pure.sh
```

Back up the existing database and data directories first. To move an existing
installation, transfer its `deploy/.env` and persistent data together; use
`--env-file /absolute/path/to/.env` and set `ROMM_DATA_DIR` there if the data live
outside this checkout. The script preserves existing credentials and config.

Windows and game images are intentionally excluded from Git and the Docker
image. Copy firmware to `deploy-data/library/bios/dos/` and game packages to
`deploy-data/library/roms/dos/`, then scan the DOS platform in RomM. Persistent
RomM assets, saves, configuration, Redis data, and MariaDB data all remain
under `deploy-data` for backup.

The equivalent direct Compose command is:

```bash
docker compose --env-file deploy/.env -f compose.dosbox-pure.yml pull
docker compose --env-file deploy/.env -f compose.dosbox-pure.yml up -d --no-build --wait
```

## Refresh and build the custom RomM image

For development, use a full checkout of `custom/retroarch-dosbox-5.4.1` and allow
at least 8 GiB of available memory. Run this when the DOSBox Pure Emscripten core
is rebuilt:

```bash
./scripts/update-custom-dosbox-core.sh
./scripts/deploy-dosbox-pure.sh --build
```

The image installs the pinned nightly frontend and downloads the nightly core
set from the EmulatorJS CDN, then overlays the RomM integration files and custom
cores. The frontend revision is pinned, but the downloaded nightly cores can
change between builds and require CDN availability.
Netplay also uses this local snapshot instead of silently switching every game
to the mutable CDN nightly. The included GameManager flushes IDBFS every five
seconds only for DOSBox Pure; other cores retain upstream save timing and
also finish their normal shutdown when browser storage is disabled.

## Save archive ownership

RomM's `frontend/src/services/emulatorjs/directory-saves.ts` owns save-file
selection, archive paths and ZIP import/export for DOSBox Pure, PPSSPP and
Azahar. It uses `fflate` and retains existing portable and runtime-path saves.
The custom runtime receives this adapter through `EJS_saveFileAdapter`; it
handles core execution and filesystem persistence without implementing a ZIP
writer or interpreting save archives. Pre-boot restoration runs after ROM
selection and before core startup.

## RomM 5.4.1 upgrade and Azahar core

This branch includes the official RomM `5.4.1` release and retains the custom
DOSBox Pure, PPSSPP and Azahar save-bundle integration. At startup, an emulator
state takes precedence over an ordinary SRAM save. Directory-backed save bundles
are still extracted before the core starts and are not loaded a second time.

The integration supports save slots and the offline save/state queue.
RomForge uses the new scan-job handler, and the application and worker images
retain the official base version after copying the custom backend.
DOSBox Pure directory saves also synchronize through RetroArch Cloud Sync,
including savediff sidecars, while the browser keeps its portable ZIP format.

The included Azahar core contains the WebAssembly interpreter, streaming-buffer
and color-order fixes, plus signed GLSL jump dispatch for ANGLE/D3D11. In the
tested Mario & Luigi: Dream Team gameplay scene, warmed hardware draws reached
about 60 core FPS with no new audio underruns in two one-minute captures. Cold
shader compilation can still cause long pauses. Hardware draws remain opt-in via
`citra_use_webgl_hw_draw`; this release does not enable them for every game or GPU.
The matching source patches, tests and measurement notes are in the
[`ysteen/build` custom branch](https://github.com/ysteen/build/tree/custom/dosbox-pure-persistence).

For an existing installation, back up the database and persistent directories
before upgrading, authenticate Docker to GHCR, then run the deployment command
above. Legacy generated local image references migrate to the published default.
The deployment script preserves existing credentials
and configuration. Updating this Git checkout alone does not restart containers
or migrate the running database.

### Integrated server verification (2026-10-25)

- A fresh GitHub clone at `6f6085398` built through the deployment script and
  initialized an empty MariaDB database. Both services reached healthy status.
- The running image matched all 46 custom runtime and core files from Git.
- All 2,363 frontend tests and 163 custom runtime tests passed. The affected
  backend save, filesystem and room tests passed, including concurrent room
  changes with the declared Lua test dependency.
- Frontend and script typechecks, generated API types, touched-file ESLint,
  repository Ruff rules, Black, isort, mypy, and locale completeness/sorting
  checks passed.
- Chrome 155 launched DOSBox Pure, melonDS, mGBA and Azahar from that image.
  Azahar produced a 193,920-byte RomM ZIP save; two explicit version uploads had
  distinct filenames and matched byte for byte after download and filesystem
  restoration. Temporary test saves were removed afterward.
- SameBoy's two WebRTC peers matched the offline reference for 360 frames with
  80/140 ms injected delay. The four-player GBA core replayed 180 frames exactly
  after restoring a snapshot and exposed separate 128 KiB battery saves.
- Real IndexedDB checks covered a 51 MiB core, cache reuse, missing-chunk
  recovery and connection cleanup. Failed CDN downloads were also verified to
  stop the image build without replacing complete core files.
- The room dialog rendered at 1440px in dark mode and 320px in light mode.
  Mouse and keyboard capacity selection kept the form open until submission.

Browser checks used the isolated port 8081 test instance. The temporary port
8080 deployment was stopped after installation verification. External-server
TLS, reverse-proxy and TURN routing still depend on that server's configuration.

## GB/GBC link cable in the v2 player

The SameBoy libretro core runs both cartridges on each peer. RomM's existing
netplay room list, passwords and Socket.IO signaling establish an ordered WebRTC
data channel. Startup exchanges each player's battery save and one initial
state; gameplay exchanges inputs and state hashes. Ordinary netplay keeps its
existing streaming path and numeric game IDs. Automatic rooms use
`link:auto:<host-rom>`; fixed-pair `link:<rom1>:<rom2>` rooms remain supported.

Enable `emulatorjs.netplay.enabled` in `config.yml` and launch a GB/GBC game
normally in v2. Open the game's **Netplay** menu and choose **Create a Room**.
The host keeps playing while waiting. The guest launches their own game and
joins from its existing Netplay room list. RomM validates both cartridges from
the library and advertises rooms for the same link system through
`include_link=true`. The room list and join dialog show the host's game; the
player table shows both games. The same Socket.IO room survives the core switch,
and `link-ready` starts WebRTC only after both cores finish loading.
Each account controls and sees its own game. `.gb`/`.gbc` ROMs, including ZIPs
containing exactly one cartridge, must support linking to each other.
GBA is not supported by this core.

Save inside the game first. Once both players join, communication switches to
dual SameBoy and restarts from each player's current battery RAM without
reloading the page.
Each account uploads only its own cartridge's
confirmed battery RAM every ten seconds. Quit in the existing EmulatorJS menu
waits for the final upload; there is no separate link toolbar or save button.
New sessions create a user-owned `link` slot, preserving the selected import.
The slot does not depend on the player number. The next launch selects its
latest save. Peer battery data is exchanged in memory for synchronization and
is never uploaded to another account.
Closing the page sends a best-effort final upload. Quit through the menu to
wait for server persistence before leaving.

Leaving a room or losing the peer disconnects the emulated cable and resumes
each player's game from its last confirmed frame, without restarting the core
or leaving the player. Solo play continues automatic server saves. The native
menu keeps volume, fullscreen, controls, Netplay and Quit available to both
players during a connection. After disconnection, native offline playback
restores the complete pre-connection button list, including Save State, Load
Latest State, the save/state picker, cheats, cache management and Save and Quit.
State files upload through the existing RomM endpoint and include the core build,
cartridge hashes, player role and a checksum. They are listed under a separate
`sameboy-link` or `mgba_splitscreen-link` emulator ID because they cannot be loaded
by the ordinary single-console core. Restoring a mismatched state is rejected
before touching the core. Options that
change the paired core, screen layout or audio route stay hidden.
Creating or joining another room repeats automatic cartridge discovery and
the save confirmation, including when roles change. Socket creation belongs to
the parent document so replacing a core iframe cannot close the room.
Both ordinary and link netplay use WebSocket transport at `/netplay/socket.io`.
This avoids HTTP polling sessions reaching different backend workers.

Link input packets include an optional frame-advantage estimate. Comparing both
peers' estimates lets the leading peer briefly wait after a late start or clock
drift, while retaining the prediction window for network latency. The existing
input channel and protocol version are unchanged; older packets remain valid.

The native volume slider drives the player iframe's Web Audio output gain on
every input event. Selecting a player unlocks its audio context; switching away
silences that output without changing its remembered volume or mute setting.
Contexts register when constructed, including drivers that wait for an audio
resume before connecting their first buffer.

For TURN, `docker/compose.link-turn.yml` runs coturn with a private configuration:

```bash
TURN_CONFIG=/absolute/path/turnserver.conf \
  docker compose -f docker/compose.link-turn.yml up -d
```

Set authenticated `turn:` URLs in `emulatorjs.netplay.ice_servers`, with one
string `urls` value per entry plus `username` and `credential`. Configure coturn's
reachable listening/relay addresses and firewall ports for the deployment.

Local verification used two visible Chrome profiles with separate RomM accounts,
forced TURN relay, no media tracks, and matching synchronization checkpoints.
Pokémon Gold/Silver traded successfully. Both server saves matched the post-trade
RAM byte for byte and restored identically after reloading both browsers.
Different external networks have not yet been tested.

## GBA link cable in the v2 player

`.gba` cartridges and ZIPs containing one `.gba` use the `mgba_splitscreen`
libretro core. Archives with multiple cartridges or other compression formats
are rejected. All cartridge hashes use the extracted ROM bytes.
The same Netplay menu, room IDs, WebRTC input protocol, TURN configuration,
per-player audio/screen routing and server saves apply. Room discovery keeps
GBA cartridges separate from GB/GBC cartridges. Ordinary GBA play still uses
the single-instance `mgba` core.

The core is pinned to `Spuds0588/mgba-splitscreen` revision
`88e5f1a3cc350b3a76247f2312b78d9f85afd4b4`, with RetroArch revision
`becfa4bad25132b6cb8068a0da463f67eefee44e`. The reproducible patch loads distinct
cartridges through `gba_link_2p`, `gba_link_3p` or `gba_link_4p` and restores
all machines and the cable together.
Rollback includes pending serial events, the write-only send register, scheduler
flags, VRAM contention, PSG phase/frequency/sample state and all battery RAM.
Audio registers restore before channel phase so rollback and confirmed-save
extraction preserve the exact emulated state. Presentation buffers are excluded
from synchronization hashes. The RTC advances from a fixed emulated epoch,
independent of the browser's clock. Game-specific Four Swords assists stay off.
Subsystem loading leaves initial audio-driver setup to RetroArch rather than
sending `SET_SYSTEM_AV_INFO` during `retro_load_game_special`. Sending it at that
point starts the Web Audio driver twice and disables audio on the second attempt.
Later sample-rate changes still update AV timing. Synchronous presentation
recalibrates the Web Audio clock while the normal frontend runloop is paused.

Build from the workspace containing `build/` and `romm/`:

```bash
bash build/tools/prepare-gba-link.sh
cd build
docker compose -f compose.dosbox-pure.yml -f compose.gba-link.yml run --rm builder
```

Outputs under `build/output/gba-link/` include the EmulatorJS archive, its
hash-based report, upstream license and four homebrew cartridges. Copy the archive
to `romm/custom-emulatorjs/data/cores/`, its JSON report to `cores/reports/`, and
the fixtures to `custom-emulatorjs/input-netplay/fixtures/`. The custom Dockerfile
includes these runtime assets.

`build/tools/test-gba-link.py` takes a native build of the patched libretro core
and two to four fixture paths. It checks visible telemetry, distinct ROMs, battery
imports before save-hardware detection, 1,027 exactly replayed frames with an
active square-wave channel, nonzero audio samples, no premature AV update,
audio selection independence, disconnection, reconnection and battery reload.
The fixtures display local key bits, received cable data and saved A presses.
In Chrome, click a game and use arrows and X (A). `PEER DATA` includes the other
cartridge ID in its high nibble and its key bits in the low bits.
Pass `--replay-only` after two local ROM paths to check 3,601 replayed frames
without the fixture-specific assertions. Zelda: A Link to the Past
and Four Swords cartridge passed this native replay check. Link state version 3
requires the matching core build; battery save compatibility is unchanged.

Browser verification on the 8081 test instance used separate visible Chrome
profiles and RomM accounts. Both cartridges exchanged inputs, stayed synchronized
with 80 ms injected input delays, and reconnected with both ICE candidates using
the existing coturn relay. Gameplay packets contained only inputs and hashes.
Server saves restored each cartridge's saved press count after a fresh launch.
Channel closure restored solo playback and its menus in the same core instance.
The existing SameBoy test also matched its offline reference after 360 frames
with 80/140 ms asymmetric delay.

The Zelda ZIP loaded into both visible Chrome profiles through the existing
room menu without reloading the page. Both clients produced nonzero Web Audio
buffers. Actual mouse drags at 10%, 90% and 37% matched the output gain; selecting
the other window silenced the first and selecting it again restored 37%.

During Four Swords co-op, independent frame scheduling preserved a 13-14-frame
lead on the host, despite 0-1 ms WebRTC round trips and matching state hashes.
With frame pacing enabled, a 12-second foreground Chrome capture measured
0-1-frame lead estimates at 59.7 fps on both peers, without stalls or mismatched
checkpoints. The user also reported reduced input lag. Regression tests cover
late starts, clock drift, reordered inputs and symmetric/asymmetric transit
delays; actual external-network latency remains unverified.

Four Swords can hang on its first in-game linking attempt while the room and
input synchronization remain connected. This reproduced with the Korean-patched
`AZLP` cartridge: both emulated ports were in multiplayer mode, but discovery
stayed at `FEFE`/`0088`. On the host, press B (default keyboard Z) to cancel the
in-game attempt, then retry with A/Start. The captured state reached stage
selection after that sequence; the user repeated it in visible Chrome and
reached two-player co-op with both clients passing 218 synchronization checks.
This is a workaround, not a core timing fix. The same retry is reported in
[mGBA issue 3286](https://github.com/mgba-emu/mgba/issues/3286).

The automatic-room and menu update passed a second connection without a page
reload, with matching synchronization hashes. Both accounts restored all 15
pre-connection menu actions after leaving or losing the channel. Server state
uploads, Quick Load and the save/state picker restored the fixture counters.
The room dialog was checked in both themes at 320, 768, 1440 and 3840 pixels,
with mouse, touch, keyboard and simulated gamepad input.

GBA rooms have a maximum of two, three or four players. Players enter without
an assigned slot and choose a free player number inside the existing room menu.
The host starts when every participant has chosen consecutive slots from 1P.
The host can use any slot; room ownership is independent of the emulated port.
The host can also assign any participant from the roster. Selecting an occupied
slot swaps those participants; other players can only choose their own free slot.
A four-player room can start with two or three participants. The server locks
slot changes and the roster at start, rejects unauthorized changes and late joins, and
keeps ordinary netplay on its existing signaling path. Every pair of players
exchanges inputs directly over WebRTC. A disconnect ends the cable session for
all participants and resumes each game in solo mode.

Separate cartridges may each be at most 32 MiB.
Import accepts standard EEPROM/SRAM/flash save sizes; the paired core exposes
128 KiB per cartridge. The ten-second autosave and awaited Quit upload support
this size. Page-unload keepalive cannot send a 128 KiB save, so use Quit when
the latest changes must reach the server before closing the browser.
Native fixture runs passed with two, three and four cartridges, including
1,027 exactly replayed frames, SRAM reload and reconnect. The reconnect patch
restores cartridge slot preferences before attaching drivers, since detaching
renumbers the remaining ports. Four visible Chrome profiles connected with
matching checkpoints and 80/140 ms injected input delays. Captured gameplay
packets contained only inputs and hashes. Each account uploaded one 128 KiB
battery file matching its own port, and downloaded server files matched those
uploads. Leaving restored the offline menus without restarting the game.
The host reassigned other participants through the roster, swapped occupied
slots and started as 4P in four visible Chrome profiles. All peers retained
their own battery data and matching checkpoints after the reordered start.
Mesh setup waits for local introductions before processing queued messages,
and every guest validates the full roster before acknowledging the initial state.
Broader commercial game compatibility, single-cartridge multiplayer and
four-player commercial games remain unverified. The games must support the
chosen link mode and player count.

## Save bundle behavior

DOSBox Pure does not store an installed operating system's disk changes in
RetroArch's nominal `.srm` file. Depending on the boot mode it writes sibling
files such as `<game>-CDRIVE.sav`, `<game>-<hash>.sav`, and `<game>.pure.zip`.
Stock EmulatorJS uploads only the nominal `.srm` (four bytes for this core), so
it silently loses the actual disk changes. This overlay packages all matching
files in `/data/saves` into one ZIP payload for RomM. When a RomM save is
selected, the frontend extracts that payload after mounting IDBFS but before
starting the core, which lets DOSBox Pure attach the restored differencing disk
during Windows boot.

Old four-byte `.srm` uploads contain no disk sectors and cannot be recovered.
Create a new RomM save with this overlay active. A working upload is a ZIP and
will normally be much larger than four bytes.

PPSSPP uses the same directory-bundle adapter. The visible RomM save filename
keeps the `.srm` extension, but its contents are a ZIP containing the title's
changed `PSP/SAVEDATA/<game-id>/` directories. On launch, EmulatorJS mounts
IDBFS first and extracts the selected RomM save under `/data/saves`, which is
the PPSSPP Memory Stick root. This also enables the EmulatorJS Export/Import
Save buttons even though the upstream PPSSPP core declares `save: false`.

DOSBox Pure derives these sibling filenames from the loaded content name.
Renaming or replacing a ROM under a different filename creates a different
save key, so an older browser-only differencing disk will not be selected
automatically after such a rename.

## Split the OS from a game

```bash
./scripts/package-win95-firmware.sh
./scripts/package-game-without-os.sh
```

The outputs are:

- `custom-emulatorjs/firmware/win95-system.zip`: upload in RomM as firmware
  for the `dos` platform.
- `custom-emulatorjs/roms/ED5WINK.zip`: put in the RomM `dos` ROM directory.

The firmware archive deliberately contains
`home/web_user/retroarch/userdata/system/Windows95.img`. EmulatorJS extracts
BIOS archives from its virtual filesystem root, which places this file in
RetroArch's Emscripten system directory where DOSBox Pure scans for installed
OS images.

The game archive contains `AUTOBOOT.DBP` with `O*Windows95`. This is DOSBox
Pure's native saved auto-start representation for an installed OS and avoids
hard-coding Emscripten filesystem paths in a DOS batch file. EmulatorJS 4.3 is
also configured to pass DOS ZIP files to the core without extracting them, so
DOSBox Pure can read that file and the disk images itself. Remove
`AUTOBOOT.DBP` from a game ZIP if the DOSBox Pure start menu should be shown
instead of booting Windows automatically.

With installed-OS boot, DOSBox Pure mounts `Windows95.img` as C: and exposes
the loaded game content as the secondary content drive automatically. The
custom loader keeps the DOS ROM compressed so the core sees the ZIP, and adds
a package revision to RomM's otherwise stable download URL to avoid reusing an
older browser-cached copy.

For games that need both a writable hard disk and a CD, both images may be
kept in that single game ZIP. Put the hard disk in the archive as either
`<game>.zip.img` (for example `test.zip.img`) or `image.img`, and include the
CD's CUE/BIN files in the same archive. When an installed OS is started,
DOSBox Pure mounts the embedded hard disk as the guest's D: drive and reinserts
the first CUE/ISO as the guest's E: CD-ROM. A sibling `<game>.zip.img` outside
the archive remains supported and takes precedence.

The EmulatorJS download cache is enabled for DOSBox Pure. ROMs, BIOS files and
extracted cores persist across launches, with a default 4 GiB limit that can be
overridden by `EJS_CACHE_LIMIT` or `EJS_cacheConfig`. Cache hits skip full-cache
cleanup, and each IndexedDB operation has a five-second timeout. Blocked storage,
quota errors and missing chunks fall back to downloading. Core build timestamps
select the matching cached binary; save bundles and reports bypass this cache.
Download cache connections close after each transaction and use separate storage
from the save/state databases and the `/data/saves` IDBFS mount.
After either RomM Quit action, the DOSBox Pure player clears `/data/saves` from
IDBFS after the final server save upload. This cleanup is limited to DOSBox
Pure so stale differencing disks from another BIOS/content combination cannot
leak into the next launch.

Add the following to RomM's `/romm/config/config.yml` (the firmware filename
must exactly match the name shown in RomM):

```yaml
emulatorjs:
  disable_batch_bootup: true
  settings:
    dosbox_pure:
      bios_file: win95-system.zip
      dosbox_pure_bootos_ramdisk: diff
      dosbox_pure_bootos_dfreespace: "1024"
      save-save-interval: "5"
```

Load the game, choose `[ Run Installed Operating System ]`, then select
`Windows95`. DOSBox Pure boots that shared image as C: and exposes the loaded
game content as D:. Its start menu can save this selection as the game's
automatic start action.

Do not modify `Windows95.img` after using `Save Difference Per Content`.
Existing per-game C: differences are tied to the exact base image.

js-dos is disabled by default (`DISABLE_JSDOS=true`). Set it to `false` explicitly
to enable the optional js-dos player. EmulatorJS and the custom DOSBox Pure core
remain enabled.
