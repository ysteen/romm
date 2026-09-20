# Azahar Mii face and shared-font data

Tomodachi Life uses the 3DS Mii face-data system archive. The bundled Azahar core
already provides Mii selection and an open-source system-archive fallback, but
that fallback is not a complete replacement for the original face assets. A
missing or placeholder face is different from having no Mii in the Mii database.

Place your own narrowly scoped system-data ZIP in the server's 3DS firmware
folder and scan the platform. The v2 Azahar player imports the selected package
before game launch through RomM's existing authenticated firmware API. This
uses the existing core and does not require a core rebuild or backend changes.
The package contains system resources, not game saves or save states.

## Install the package on the server

1. Export your own files and build the ZIP using the instructions below. Name
   the package `azahar-mii-system-data.zip`.
2. Copy it to the platform's firmware directory inside the RomM library. With
   the default firmware folder and library layout, the full relative path is
   `library/bios/3ds/azahar-mii-system-data.zip`.
3. Run a normal scan of the 3DS platform to register the ZIP as firmware.
4. Launch the game with the Azahar player. On a fresh browser or device, the
   canonical package is selected automatically even when other firmware files
   exist. An available saved BIOS selection or configured BIOS choice takes
   priority. Use the existing firmware picker if you need to change that choice.

Use the platform's actual `platform_fs_slug` directory if it is not `3ds`.
`bios` is the default value of `filesystem.firmware_folder` in `config.yml`;
substitute the configured folder name if different. The path also depends on
the library layout:

```text
Structure A: library/<firmware_folder>/<platform_fs_slug>/azahar-mii-system-data.zip
Structure B: library/<platform_fs_slug>/<firmware_folder>/azahar-mii-system-data.zip
```

The existing workspace test environment uses:

```text
/home/david/dosbox_test/romm/test-instance/library/bios/3ds/azahar-mii-system-data.zip
```

Keep the ZIP on the server. The player validates and imports it into this
browser's IndexedDB-backed emulator storage before boot. Clearing browser
storage removes that browser's imported copy, but the server package is still
available and is imported again on the next launch when selected. Other devices
obtain their own browser copy through the same authenticated firmware API.
RomM game-save bundles do not include this NAND system data.

A package with a different filename can still be selected manually. The
canonical name makes automatic selection predictable when multiple firmware
files are present; it does not override explicit saved or configured choices.
To update the data, stop the game, replace the server ZIP, rescan the platform,
and launch again. Do not replace running system titles in the browser or
hot-swap a package during gameplay.

## Obtain your own files

Export the required **decrypted NCCH** titles from your own 3DS. Merely installing
system files in desktop Azahar is not sufficient: the
[Azahar Artic Setup Tool](https://github.com/azahar-emu/ArticSetupTool) configures
desktop Azahar, whose installed files can be console-bound or compressed. Those
wrapped files are not accepted by this web importer. Renaming them, setting a
header flag, or removing a filename extension does not decrypt them.

### Export with GodMode9 on your own console

These steps assume your console already has a working GodMode9 setup. Use the
[GodMode9 usage guide](https://3ds.hacks.guide/godmode9-usage.html) for updating and
launching it. With a typical Luma3DS setup, hold Start while powering on and
choose GodMode9 if a payload menu appears. Keep console backups. This procedure
only reads NAND and writes copies to the SD card; do not unlock NAND writes.

1. Open `1: SYSNAND CTRNAND`, then `title/0004009b/00010202/content`.
2. Note the `.app` file's original eight-digit hexadecimal filename. Select it
   with A, open its NCCH image submenu, and choose decryption **to the SD output
   directory**, not in-place decryption. If GodMode9 identifies the file as
   already decrypted, copy it to that output directory instead.
3. From the same source directory, copy the matching `.tmd` to the SD output
   directory. Use the A-button copy action, or Y to copy and then paste in the
   destination. Do not copy tickets, saves, or keys.
4. Power off and copy the two exported files from `gm9/out` on the SD card to
   your computer. Preserve the original `.app` content-ID filename. If a tool
   changed its filename, rename only the exported copy back to that original
   name, not to an arbitrary content ID.
5. Put this pair in the ZIP directory tree below. Do not simply ZIP the contents
   of `gm9/out`; the NAND/title directories are required.

GodMode9 documents CTRNAND browsing, copying, and NCCH decryption to its output
directory in its [official README](https://github.com/d0k3/GodMode9#what-you-can-do-with-godmode9).
Its [menu implementation](https://github.com/d0k3/GodMode9/blob/master/arm9/source/godmode.c)
provides a separate output-directory decryption action when browsing CTRNAND.
The path and ZIP mapping above combine those documented operations with the
title IDs and user-directory layout used by this core; they have not been
hardware-tested in this workspace. If a directory or matching pair is missing,
stop and check your own console rather than substituting downloaded files.

For optional regional fonts, repeat the export for the corresponding title in
the table below. Keep each pair in its own content directory to avoid `.app` or
`.tmd` filename collisions. The web importer does not need a CIA installer or
desktop console keys, and no offline key-based conversion tool is included.

No Nintendo files, keys, firmware downloads, or third-party "face fix" packages
are included or downloaded by RomM. This feature cannot supply original Mii faces
without the required user-provided data. The authenticity of imported files is
not established by the structural checks described below.

## ZIP layout

Keep the `nand` directory and the selected title's matching `.app` and `.tmd`
files. For example, a Mii archive can have this layout:

```text
azahar-mii-system-data.zip
└── nand/
    └── 00000000000000000000000000000000/
        └── title/
            └── 0004009b/
                └── 00010202/
                    └── content/
                        ├── 00000003.app
                        └── 00000000.tmd
```

The `.app` filename is only an example. Preserve the content ID recorded in your
own TMD. Include exactly one TMD and its one content file per title, not several
old title versions. A nonzero TMD filename is accepted and normalized on import.
The original console's 32-hex-digit NAND directory is accepted and mapped to the
emulated console ID. Optional `user/`, `Azahar/`, or `Azahar/Azahar/` wrappers
before `nand/` are accepted; unrelated wrapper directories are not.

Only these title IDs are supported:

| Title ID | Resource |
| --- | --- |
| `0004009b00010202` | Mii face data |
| `0004009b00014002` | Japanese, European, and US shared font |
| `0004009b00014102` | Chinese shared font |
| `0004009b00014202` | Korean shared font |
| `0004009b00014302` | Taiwanese shared font |

For an English/US Tomodachi Life face issue, start with the Mii face-data title.
The regional font titles are optional and address missing glyphs, not face
rendering. The core's fallback explicitly warns that Chinese, Korean, and
Taiwanese text may not display correctly without their corresponding font data.

Do not include complete NAND dumps, `sdmc`, game saves, console keys, tickets,
Mii Maker, CIA installers, or standalone `CFL_DB.dat`/`CFL_Res.dat` files. The Mii
database (`CFL_DB.dat`) stores characters, not the shared face models and textures,
and importing it is not necessary for this issue. Other files cause the complete
import to fail before any system-data file is written.

## Import behavior

The importer validates relative paths, allowed title IDs, decrypted NCCH headers,
non-executable RomFS content, matching TMD content IDs and sizes, and duplicate
destinations. It allows at most 128 archive entries, 64 MiB per expanded file,
and 128 MiB of expanded content. The `assertZip` preflight also bounds the
compressed archive to 128 MiB and checks ZIP central/local headers and declared
expansion sizes before decompression. It rejects encrypted ZIPs, ZIP64, links,
overlapping entries, alternate path encodings, and unsupported compression.
`extractZip` then checks actual expansion sizes while streaming raw-deflate data
and validates each extracted file's CRC32. If the browser does not support
`DecompressionStream("deflate-raw")`, use a current browser or a ZIP with stored
(uncompressed) entries. Downloads must also be bounded by the caller.

The destination is the current web core's actual user directory:

```text
/data/saves/Azahar/Azahar/nand/00000000000000000000000000000000/title/
```

The repeated `Azahar` is intentional: RetroArch adds the core save directory and
the core then appends its own user-directory name. The TMD is installed as
`00000000.tmd` because the core picks the lowest TMD filename. The `.app` filename
continues to match the content ID inside that TMD. Game-save directories are not
part of the import, and the system-data package is not a save-state backup.

Files must be present before game boot. Restart the game through the normal
player launch flow after selecting a new package; do not hot-swap system titles
during gameplay. Actual face rendering still needs a gameplay check with the
user's valid files. Synthetic tests validate parsing and paths, not Nintendo
assets or compatibility with every title.

## Implementation references

- `custom-emulatorjs/data/src/azahar-system-data.js`: pure validation and mapping.
- Run helper tests with
  `node --test custom-emulatorjs/tests/azahar-system-data.test.cjs`.
- [Azahar NCCH archive loading](https://github.com/azahar-emu/azahar/blob/master/src/core/file_sys/archive_ncch.cpp): original title lookup and built-in archive fallback.
- [Azahar title metadata and content paths](https://github.com/azahar-emu/azahar/blob/master/src/core/hle/service/am/am.cpp): TMD-based content lookup.
- [Azahar NCCH container](https://github.com/azahar-emu/azahar/blob/master/src/core/file_sys/ncch_container.cpp): encrypted-content rejection and RomFS loading.
