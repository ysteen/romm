# Custom DOSBox Pure and shared Windows 95

This workspace overlays the locally built DOSBox Pure core and its matching
EmulatorJS 4.3 frontend on RomM 4.9.2. The core declares a minimum EmulatorJS
version of 4.3.0, so RomM's bundled 4.2.3 frontend cannot run it. It also
supports keeping one Windows 95 disk in RomM's DOS firmware and keeping each
game as a separate ROM.

## One-command server deployment

On a Linux server with Docker and the Compose plugin installed:

```bash
git clone <your-repository-url> romm-dosbox-pure
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

The overlay replaces the EmulatorJS frontend as a complete 4.3 set along with
both threaded DOSBox Pure core variants. Do not copy only `loader.js` or
`GameManager.js` over the 4.2.3 assets: 4.3 uses ES modules and all frontend
modules must remain on the same API generation. The included GameManager
flushes IDBFS, and the core setting below asks EmulatorJS to save every five
seconds so C:/D: image differences survive browser reloads.

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

The EmulatorJS download cache is disabled for DOSBox Pure because RomM 4.9.2
does not provide the 4.3 cache configuration and the default 4 GB IndexedDB
cache can stall during core lookup after a Save & Quit reload. This does not
disable the separate save/state databases or the `/data/saves` IDBFS mount.

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
