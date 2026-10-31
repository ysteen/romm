# Directory saves as ZIP archives

Normal in-game saves from PPSSPP, Azahar and DOSBox Pure are exported to RomM
and downloaded from the EmulatorJS toolbar as `.zip` with `application/zip`.
Save states still use `.state`; ordinary SRAM saves keep their existing format.

| Core        | ZIP entries                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------- |
| PPSSPP      | The game's SAVEDATA directories, for example `ULUS12345DATA/PARAM.SFO` and `ULUS12345DATA/DATA.BIN` |
| Azahar      | `data/00000001/...`, `data/00000001.metadata`, and optional `extdata/...`                           |
| DOSBox Pure | `DOSBox-pure/<game>.pure.zip` plus related `.srm` and disk-difference `.sav` files                  |

The PPSSPP and Azahar layouts follow Argosy's
[folder handlers](https://github.com/rommapp/argosy-launcher/blob/main/app/src/main/kotlin/com/nendo/argosy/data/sync/platform/PlatformSaveHandlerRegistry.kt)
and [ZIP archiver](https://github.com/rommapp/argosy-launcher/blob/main/app/src/main/kotlin/com/nendo/argosy/data/sync/SaveArchiver.kt).
PPSSPP's `PPSSPP/PSP/SAVEDATA` runtime prefix and Azahar's console-specific SD
directory prefix are not included in these portable archives. Azahar exports
only the selected title's save components, excluding installed content, NAND,
system data and other titles. This is archive-layout compatibility; actual
cross-device gameplay still depends on the same game/region and emulator support.

Azahar uses the loaded NCCH executable's program ID (also inside NCSD/CCI/3DS
cartridges) to locate a portable archive before starting the core. Decrypted
ExHeader storage information supplies the extdata ID; without it, the common
title-ID mapping used by Argosy is used. Homebrew without an NCCH title ID keeps
the legacy runtime-path ZIP layout. A portable import with no identifiable
destination fails instead of guessing a title. Argosy versions and titles with
nonstandard extdata mappings may require manual placement on the other device.

DOSBox Pure already stores modified ZIP content in a native `.pure.zip`, as
documented by [Libretro](https://docs.libretro.com/library/dosbox_pure/#store-modifications-in-separate-save-files).
Its additional disk-difference files must travel with it, so the RomM archive
keeps all siblings in an outer ZIP. The custom RomM 5.4.1 Cloud Sync adapter
exposes those siblings individually to native RetroArch. The browser continues
to download and restore the outer ZIP.

## DOSBox Pure and RetroArch Cloud Sync

Configure RetroArch 1.22 or newer with WebDAV Cloud Sync, the server URL
`https://<romm-host>/api/sync/retroarch`, and the RomM account credentials.
Enable save-file synchronization and **Sort Saves into Folders by Core Name**.
Leave sorting by content directory disabled. Native files then use
`saves/DOSBox-pure/<game>...`, matching the manifest. Unsorted uploads are
rejected because advertising them under a different directory would not sync
the files the core actually loads.

RetroArch versions that send a WebDAV `COPY` before overwriting a file keep
the previous bytes under the user's `deleted/` backup path. These backups are
downloadable but excluded from the active sync manifest. A failed upload after
the backup leaves the current save intact.

The adapter synchronizes the newest `autosave` bundle for each game and user.
An existing unslotted ZIP, including a legacy ZIP named `.srm`, is used when
there is no autosave. Named slots remain separate. Each native file upload
creates a new ZIP autosave version containing that file and the other current
members. The existing per-slot retention limit still applies. Concurrent native
uploads for one game are serialized across server workers.

| Browser ZIP member              | RetroArch Cloud Sync path             |
| ------------------------------- | ------------------------------------- |
| `DOSBox-pure/Game.pure.zip`     | `saves/DOSBox-pure/Game.pure.zip`     |
| `DOSBox-pure/Game-CDRIVE.sav`   | `saves/DOSBox-pure/Game-CDRIVE.sav`   |
| `DOSBox-pure/Game-1234ABCD.sav` | `saves/DOSBox-pure/Game-1234ABCD.sav` |
| `DOSBox-pure/Game-DDRIVE.sav`   | `saves/DOSBox-pure/Game-DDRIVE.sav`   |

The inner `.pure.zip` is transferred byte for byte. Manifest hashes cover each
native file's bytes. SaveDiff works even when only `.sav` files exist, with no
`.pure.zip`. Keep the same ROM basename, OS base image and DOSBox Pure options
on both devices. Cloud Sync moves the differences; it does not supply the OS
image or make different base images compatible.

Deleting a native file creates a bundle version without that member. An empty
bundle records deletion of the last file, so earlier versions cannot reappear
on the next sync. Browser restores remove obsolete files belonging to that
game after validating the complete bundle. Other games are retained.

ZIP reads, rewrites and downloads use bounded chunks and temporary files.
The adapter allows up to 128 members, 512 MiB per member and 4 GiB total,
subject to the server's upload limit. This avoids PSP's 64 MiB bundle ceiling.

In stock Argosy Launcher 2.27.3, the DOSBox Pure save layout recognizes only
`{stem}.pure.zip`; its own save synchronization does not include SaveDiff
sidecars. This server change does not alter that client layout. Configure Cloud
Sync in the external RetroArch application, let it finish before launching the
game from Argosy, and close content and let sync finish before changing devices.
Avoid running Argosy's separate save synchronization against the same files.

Cloud Sync merges uploads per file; it has no transaction for an entire game
bundle. Let a sync finish before opening the save in the browser or on another
device. Failed transfers should be retried before continuing play.

Existing runtime-path ZIP bundles remain loadable even when named `.srm`.
The first save after loading one uploads a new `.zip` and keeps the original
as a backup. Subsequent writes in that session update the new save. RomM's PUT
endpoint preserves stored filenames, so simply sending a different upload name
would not migrate an old record.

A downloaded `.srm` that is already a valid ZIP can be renamed to `.zip`
without changing its contents. Renaming an old PPSSPP or Azahar bundle does not
convert its runtime paths to the portable layout; load it and save again with
the updated player to convert it. DOSBox Pure's archive layout is unchanged.
Do not rename stored RomM asset files directly, since the database still refers
to their original paths. Ordinary SRAM `.srm` files are not ZIP archives.

Both server preloads and manual imports use the same path mapping. Preloads
run after the ROM is selected, after mounting persistent storage, and before
the core starts. Import/download/persistence failures prevent startup with an
unrestored selected save. Unsafe, duplicate and conflicting paths are rejected
before any archive entry is written.

Run the archive and runtime checks with:

```sh
node --test custom-emulatorjs/tests/*.test.cjs
cd frontend
npm run test -- test/emulatorjs-saves.test.ts test/emulatorjs-upgrade.test.ts
```

The archive tests also use Python 3's standard `zipfile` reader to verify the
ZIP structure, CRCs and compressed import fixtures independently of the writer.
