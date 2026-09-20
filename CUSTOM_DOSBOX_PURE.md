# Custom DOSBox Pure and shared Windows 95

This workspace pins EmulatorJS 4.3 nightly commit
`cf622ec831e1c68dbbbce9dc49923a82b4b0e2a6` on RomM 5.2.0. Nightly core files are
downloaded during the image build, then local DOSBox Pure, PPSSPP and Azahar
binaries replace their corresponding cores. DOSBox Pure declares a minimum
EmulatorJS version of 4.3.0, so RomM's bundled 4.2.3 frontend cannot run it. It
also supports keeping one Windows 95 disk in RomM's DOS firmware and keeping
each game as a separate ROM.

## One-command server deployment

On a Linux server with Docker and the Compose plugin installed:

```bash
git clone -b custom/dosbox-pure-emulatorjs-4.3 \
  https://github.com/ysteen/romm.git romm-dosbox-pure
cd romm-dosbox-pure
./scripts/deploy-dosbox-pure.sh
```

The script creates `deploy/.env` with random database/authentication secrets,
initializes bind-mounted data directories under `deploy-data`, builds the
custom image, and starts RomM plus MariaDB. The default URL is
`http://localhost:8080`. Edit `deploy/.env` to change the port or timezone,
then run the script again.

Windows and game images are intentionally excluded from Git and the Docker
image. Copy firmware to `deploy-data/library/bios/dos/` and game packages to
`deploy-data/library/roms/dos/`, then scan the DOS platform in RomM. Persistent
RomM assets, saves, configuration, Redis data, and MariaDB data all remain
under `deploy-data` for backup.

The equivalent direct Compose command is:

```bash
docker compose --env-file deploy/.env -f compose.dosbox-pure.yml up -d --build
```

## Refresh and build the custom RomM image

Run this whenever the DOSBox Pure Emscripten core is rebuilt:

```bash
./scripts/update-custom-dosbox-core.sh
docker compose -f <your-compose.yml> -f compose.custom-dosbox-pure.yml build romm
docker compose -f <your-compose.yml> -f compose.custom-dosbox-pure.yml up -d romm
```

The image installs the pinned nightly frontend and downloads the nightly core
set from the EmulatorJS CDN, then overlays the RomM integration files and custom
cores. The frontend revision is pinned, but the downloaded nightly cores can
change between builds and require CDN availability.
Netplay also uses this local snapshot instead of silently switching every game
to the mutable CDN nightly. The included GameManager flushes IDBFS every five
seconds only for DOSBox Pure; other cores retain upstream save timing and
shutdown behavior.

## RomM 5.2 upgrade and Azahar core

This branch includes the official RomM `5.2.0` release and retains the custom
DOSBox Pure, PPSSPP and Azahar save-bundle integration. At startup, an emulator
state takes precedence over an ordinary SRAM save. Directory-backed save bundles
are still extracted before the core starts and are not loaded a second time.

The included Azahar core contains the WebAssembly interpreter, streaming-buffer
and color-order fixes, plus signed GLSL jump dispatch for ANGLE/D3D11. In the
tested Mario & Luigi: Dream Team gameplay scene, warmed hardware draws reached
about 60 core FPS with no new audio underruns in two one-minute captures. Cold
shader compilation can still cause long pauses. Hardware draws remain opt-in via
`citra_use_webgl_hw_draw`; this release does not enable them for every game or GPU.
The matching source patches, tests and measurement notes are in the
[`ysteen/build` custom branch](https://github.com/ysteen/build/tree/custom/dosbox-pure-persistence).

For an existing installation, back up the database and persistent directories
before upgrading. Change `ROMM_IMAGE` in `deploy/.env` to
`romm-custom-dosbox-pure:5.2.0` if it still names an older image, then run the
deployment command above. The deployment script preserves existing credentials
and configuration. Updating this Git checkout alone does not restart containers
or migrate the running database.

### Upgrade verification (2026-09-21)

- Frontend typecheck passed with a 4 GiB Node heap; the default 2 GiB heap ran
  out of memory in this environment.
- All 762 frontend tests across 67 files passed with `--maxWorkers=1`.
- Production frontend build, locale completeness/sorting, runtime JavaScript
  syntax and Git whitespace checks passed.
- The new regression tests execute the real startup save/state branch without
  mounting a ROM. They also cover local module cache revisions and external URLs.
- The touched-file ESLint run still reports two existing errors in the legacy
  console player (unused `FirmwareSchema` and a non-focusable button role).
  Both reproduce on the pre-upgrade commit; the new regression test is lint-clean.
- Full Docker image verification remains incomplete: a nightly CDN core download
  stalled after the frontend stage succeeded, so that build was stopped. No
  running container, database or saved game was replaced for this upgrade.

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

The EmulatorJS download cache is disabled for DOSBox Pure because RomM does
not provide the 4.3 cache configuration and the default 4 GB IndexedDB
cache can stall during core lookup after a Save & Quit reload. This does not
disable the separate save/state databases or the `/data/saves` IDBFS mount.
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
