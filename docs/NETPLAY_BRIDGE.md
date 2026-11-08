# RomM netplay documentation

Start with [Install on another server](NETPLAY_INSTALL.md) for the complete,
portable installer. It includes exact images, core assets, runtime overlays,
HTTPS configuration, first-user setup, verification, updates, backup and recovery.
The installation server needs no development-server access or source checkout.

Read [Player guide](ROLLBACK_ROOMS.md) for room invitations, Windows launcher
setup, player numbers, saves, leaving and rejoining. Administration is at
`/api/netplay/bridge/admin/ui/` on your RomM HTTPS origin and
requires the current RomM administrator role. The bridge image owns the dashboard HTML, JavaScript and styles. RomM authenticates each request and proxies the fixed UI assets; it holds no dashboard bundle. Port 8083 is a development shortcut. See the bridge's [administration contract](https://github.com/ysteen/retroarch-netplay-bridge/blob/main/docs/administration.md).

## Current compatibility

| System | Matched version                                | Topology                                                     |
| ------ | ---------------------------------------------- | ------------------------------------------------------------ |
| GB/GBC | SameBoy `1.0.4c87d256-cable1`, SBR3            | Two ordered cartridges, including different compatible games |
| GBA    | mGBA Splitscreen `0.1.0-f1d5975-cable1`, SPST5 | Two to four ordered cartridges                               |
| SNES   | Snes9x `1.632d4cce69`                          | One cartridge, two joypads                                   |

All replicas load the same ordered complete set for that game. Different GB/GBC
or GBA cartridges may be selected by different participants before game setup.
A stock core with the same general name is insufficient. SBR2/SPST4 machine
states are incompatible with the cable profile. Battery save formats are retained.
SNES accepts standard NTSC LoROM/HiROM up to 4 MiB, including a single-ROM ZIP or
512-byte copier header; PAL and extended/interleaved images are rejected.

The bridge relays input and snapshots; each client runs the emulation. RomM owns
login, game access, room permissions and save storage. A playing RetroArch has
host priority, followed by a playing browser. Two native players need no web
emulator, but retain their browser room pages. No separate OIDC server is needed.

## Source integration (maintainers)

The adapter is in `ysteen/romm`, branch `custom/netplay-retroarch-bridge`, and the
standalone service is in private `ysteen/retroarch-netplay-bridge`. Repository
access is required to clone them. Source HEAD, a running local patch and a
published image can differ; use a matched release rather than assuming a mutable
image tag contains local changes. Standard DOSBox work uses its separate branch.

Configure the custom RomM backend with:

```dotenv
NETPLAY_BRIDGE_URL=http://netplay-bridge:8080
NETPLAY_BRIDGE_TOKEN=<random shared server token, at least 24 characters>
NETPLAY_BRIDGE_PUBLIC_URL=https://romm.example.com/netplay
NETPLAY_BRIDGE_PUBLIC_HOST=romm.example.com
```

On the bridge set `NETPLAY_BRIDGE_ADMIN_TOKEN` to that same token,
`NETPLAY_BRIDGE_ORIGINS=https://romm.example.com`, and
`NETPLAY_BRIDGE_SAVE_DIR=/data/saves`. Keep the save directory on a persistent
volume. `NETPLAY_BRIDGE_PUBLIC_URL` is the browser-reachable HTTP(S) base;
`NETPLAY_BRIDGE_PUBLIC_HOST` is a direct DNS hostname or address for native TCP.
Never expose the shared service token to players. Personal native admission
credentials are distinct from room invitation passwords.

The existing `compose.netplay.yml` source overlay joins RomM and the bridge on a
shared Docker network. It builds the bridge from `NETPLAY_BRIDGE_SOURCE` and
requires a matching custom RomM image; environment variables do not upgrade an
old application image. The portable installer avoids this source/build dependency.
For image publication and registry authentication, see [private images](PRIVATE_GHCR.md).
The portable bundle does not need a GHCR login on the destination.

Serve the core catalog and its complete matching packages from
`custom-emulatorjs/`. The Windows launcher downloads DLL and `.info` together,
verifies hashes, and sets isolated core, info, save and options directories.
Do not install unrelated stock `.info` metadata for these patched cores.

The standalone repository owns reusable browser modules and the Windows launcher.
From its checkout, synchronize and verify:

```sh
node scripts/sync-romm-client.mjs /path/to/romm
node scripts/sync-romm-client.mjs /path/to/romm --check
```

From RomM, run `node scripts/check-netplay-client.mjs`. Pinned core build and
qualification tooling lives in the bridge's `docs/native-builds.md` and
`docs/core-qualification.md`. Application/bridge image builds belong on CI.
Native emulator integration must not run in the development WSL workspace.

SameBoy Windows sessions require RetroArch **1.22.2 or later**. An older installed
version stops with update instructions. The launcher downloads a portable runtime
only when no matching installation exists. After a launcher update, download its
ZIP and run **Register Launcher.cmd** once on each Windows computer.

## Evidence and limits

Windows x64 RetroArch 1.22.2 has short initial-connection and state-check coverage
for SameBoy, including separate Gold/Silver cartridges and assigned screen/audio.
mGBA has bounded native/native and web/native continuation and cable lifecycle
coverage. These checks do not establish every game's trade/battle behavior or
long-session stability. Windows x86/ARM64 and Android binaries have artifact
inspection coverage; Android automatic room admission and device qualification
remain deferred. See the standalone lifecycle/build reports for exact test scope.

The bridge's durable queue synchronizes original participants' SRAM to RomM,
including native-only rooms. Keep both the save volume and RomM Redis grants.
Full replica state contains every console; account save ownership is an admission
and write policy, not per-client memory isolation.

[Historical implementation notes](history/NETPLAY_BRIDGE_2026-11-07.md) retain
older decisions and verification records. Use current guides for installation.
