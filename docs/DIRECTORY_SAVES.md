# Directory saves as ZIP archives

Normal in-game saves from PPSSPP, Azahar and DOSBox Pure are exported to RomM
and downloaded from the EmulatorJS toolbar as `.zip` with `application/zip`.
Save states still use `.state`; ordinary SRAM saves keep their existing format.

| Core | ZIP entries |
| --- | --- |
| PPSSPP | The game's SAVEDATA directories, for example `ULUS12345DATA/PARAM.SFO` and `ULUS12345DATA/DATA.BIN` |
| Azahar | `data/00000001/...`, `data/00000001.metadata`, and optional `extdata/...` |
| DOSBox Pure | `DOSBox-pure/<game>.pure.zip` plus related `.srm` and disk-difference `.sav` files |

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
keeps all siblings in an outer ZIP. It is not a PSP/3DS folder archive. A desktop
RetroArch restore should extract its contents into the matching save directory;
the outer ZIP alone does not establish automatic Argosy DOS save support.

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
