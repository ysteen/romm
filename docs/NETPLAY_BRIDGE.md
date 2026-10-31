# Rollback multiplayer: install and connect

This adapter runs with [ysteen/retroarch-netplay-bridge](https://github.com/ysteen/retroarch-netplay-bridge), a separate private repository. The RomM integration is on [`ysteen/romm`, branch `custom/netplay-retroarch-bridge`](https://github.com/ysteen/romm/tree/custom/netplay-retroarch-bridge). It is not part of an upstream RomM release.

Every player runs a local core. The bridge exchanges inputs and synchronization messages. RomM handles browser login, game access and saves. The current host is a **browser player** and must keep the room open. Native-only hosting, late joining and host migration are not implemented.

## Supported clients

| System | Matching core                              | Room                                                      |
| ------ | ------------------------------------------ | --------------------------------------------------------- |
| GB/GBC | SameBoy `1.0.4c87d256-rollback2`           | Two linked consoles                                       |
| GBA    | mGBA Splitscreen `0.1.0-f1d5975-rollback1` | Two to four linked consoles; two-player live UI qualified |
| SNES   | Snes9x `1.632d4cce69`                      | One console, two joypads                                  |

The room provides the matching **Linux x86_64** native core. SameBoy and mGBA need these patched builds. RetroArch itself requires no modification; qualification used RetroArch 1.22.2. Windows and Android cores are not provided or qualified. SNES currently accepts standard NTSC LoROM/HiROM up to 4 MiB, including a single-ROM ZIP or a 512-byte copier header. PAL and extended/interleaved images are rejected.

## Install the source and image

Clone the two repositories beside each other. The bridge repository requires GitHub access granted to your account.

```sh
git clone --branch custom/netplay-retroarch-bridge https://github.com/ysteen/romm.git romm
git clone https://github.com/ysteen/retroarch-netplay-bridge.git retroarch-netplay-bridge
cd romm
```

`NETPLAY_BRIDGE_SOURCE` can instead point to another bridge checkout.

The custom application image must be built from this branch. An older `5.4.1` image does not acquire these changes when you edit environment variables. The existing private image workflow can publish this source revision:

```sh
gh workflow run publish-custom.yml --repo ysteen/romm-image-builds \
  -f source_ref=custom/netplay-retroarch-bridge
```

After that workflow succeeds, use its `sha-<12-character-commit>` app tag or digest in `ROMM_IMAGE`. See [private image installation](PRIVATE_GHCR.md) for registry login, the workflow's validation and matching worker versions. Pushing source does not publish an image automatically. The bridge currently builds from its source checkout with Compose.

For an existing installation using this repository's Compose files, retain its existing `deploy/.env`, data directory and project name. Add the settings below to that env file. For a fresh installation, follow [the installation guide](PRIVATE_GHCR.md) first to create the database/auth settings and mount directories.

```dotenv
NETPLAY_BRIDGE_TOKEN=<same randomly generated token on RomM and bridge, at least 24 characters>
NETPLAY_BRIDGE_ORIGINS=https://romm.example.com
NETPLAY_BRIDGE_PUBLIC_URL=https://netplay.example.com
NETPLAY_BRIDGE_PUBLIC_HOST=netplay.example.com
NETPLAY_BRIDGE_HTTP_BIND=127.0.0.1
NETPLAY_BRIDGE_TCP_BIND=0.0.0.0
```

Generate a token with `openssl rand -hex 32`. The service token stays on the server; it is different from a room password. `NETPLAY_BRIDGE_ORIGINS` is the exact RomM browser origin, including a nonstandard port if used; multiple origins are comma-separated. The token is named `NETPLAY_BRIDGE_TOKEN` in RomM/Compose and mapped to `NETPLAY_BRIDGE_ADMIN_TOKEN` inside the bridge.

The root `compose.netplay.yml` connects both services through their shared Docker network and supplies RomM's internal URL as `http://netplay-bridge:8080`. After setting `ROMM_IMAGE` to the new published image:

```sh
docker compose --env-file deploy/.env \
  -f compose.dosbox-pure.yml -f compose.netplay.yml build netplay-bridge
docker compose --env-file deploy/.env \
  -f compose.dosbox-pure.yml -f compose.netplay.yml \
  up -d --no-build database romm netplay-bridge
```

Include your existing `-p` project name and any worker/other override files in every command when applicable. Recreate a RomForge worker with the matching app revision using the existing deployment procedure. Keep `compose.netplay.yml` in subsequent updates so the bridge settings remain attached to RomM.

To build the app locally instead of publishing, use all three files and build sequentially:

```sh
export ROMM_CUSTOM_REVISION="$(git rev-parse HEAD)"
docker compose --env-file deploy/.env -f compose.dosbox-pure.yml \
  -f compose.custom-dosbox-pure.yml -f compose.netplay.yml build romm
docker compose --env-file deploy/.env -f compose.dosbox-pure.yml \
  -f compose.custom-dosbox-pure.yml -f compose.netplay.yml build netplay-bridge
docker compose --env-file deploy/.env -f compose.dosbox-pure.yml \
  -f compose.custom-dosbox-pure.yml -f compose.netplay.yml \
  up -d --no-build database romm netplay-bridge
```

For a different RomM deployment, set these four variables on its backend container and put the bridge on a reachable network:

```dotenv
NETPLAY_BRIDGE_URL=http://netplay-bridge:8080
NETPLAY_BRIDGE_TOKEN=<the same service token>
NETPLAY_BRIDGE_PUBLIC_URL=https://netplay.example.com
NETPLAY_BRIDGE_PUBLIC_HOST=netplay.example.com
```

`docker/compose.netplay-bridge.yml` can run the bridge alone. Its relative build context assumes that file is the primary Compose file. Its default bindings are loopback-only.

## Network and reverse proxy

| Connection                 | Destination                                 | Required setup                                |
| -------------------------- | ------------------------------------------- | --------------------------------------------- |
| RomM backend to bridge     | `netplay-bridge:8080`                       | Shared Docker network; service token          |
| Browser to bridge          | `wss://netplay.example.com/v1/rooms/...`    | HTTPS proxy with WebSocket upgrades           |
| Native RetroArch to bridge | `netplay.example.com:55435` through `55442` | Direct TCP port forwarding/firewall allowance |

The public bridge URL is a base URL, without `/v1/rooms` or `/ws`. Prefer a dedicated hostname. For Nginx on the Docker host, inside an existing TLS-enabled `server` block for `netplay.example.com`:

```nginx
location / {
    proxy_pass http://127.0.0.1:8082;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

A proxy running in Docker should join the bridge's network and target `http://netplay-bridge:8080` instead of container-local `127.0.0.1`. The native hostname must resolve directly to a server that exposes the room TCP ports. An HTTPS-only tunnel or HTTP CDN proxy cannot carry the native connection. Use a separate DNS-only native hostname in `NETPLAY_BRIDGE_PUBLIC_HOST` if necessary. Browser-only rooms do not require public native TCP ports.

Check bridge startup with `curl -fsS http://127.0.0.1:8082/health`. While signed in to RomM, open `/api/netplay/bridge/config`; it should return `enabled: true`. This configuration response does not check bridge reachability. Both services must be recreated after changing their environment.

## Create and join a web room

1. Sign in to RomM with game access and emulation permission. Use the **v2 UI** and open a supported game's player page.
2. Select **Relay server** (the label is translated). Allow the popup. The ordinary SNES player's in-game **Netplay** button also opens this flow when configured.
3. Select the player count. Enable **Allow desktop RetroArch clients** if a native player will join. Select **Create room**.
4. Copy the room invitation and send its displayed room password separately. Keep the host window open. The game waits for all selected player slots to connect.
5. A web guest signs in to the same RomM server and opens the invitation, enters the password and selects **Join room**. Alternatively, open that game's player page, select **Relay server**, and choose the room under **Open rooms**. Use a separate browser profile or device for a second account.
6. Each player uses their own keyboard, touch controls or gamepad. Use **Save progress** or **Save and close** to save to the signed-in account. Automatic room saves run every 15 seconds. **Download save** provides a local battery-save copy.

The invitation contains the ROM/room identifiers, not the room password or service token. An invitation does not bypass the guest's RomM game permissions. The current password is shared by the room, including native guests; per-player native passwords and native RomM login are not implemented.

## Connect desktop RetroArch

1. Have a browser host create a room with native clients allowed. Ask for the displayed hostname, room port, room password and matching core download.
2. Install the provided `.so` using RetroArch's **Load Core → Install or Restore a Core**, or select the downloaded core with `-L`. Use the same unmodified ROM bytes and the room's core options. A stock core with the same general name is insufficient.
3. For SameBoy/mGBA, load the same cartridge into every linked console slot through the core's subsystem content loader. SNES loads one cartridge. Set SameBoy audio output to **48000 Hz**.
4. Connect as a Netplay client to the displayed address and exact room port, then enter the room password when prompted. Do not start another native host or rely on the public RetroArch lobby. The bridge waits for all room slots before play starts.

For two-player rooms, these commands use the subsystem identifiers exercised by the Linux qualification harness. Replace paths, host and port with the room details. Enter its password through RetroArch's prompt.

```sh
# GB/GBC, two copies of the same cartridge
retroarch -L /path/to/sameboy_libretro.so --subsystem gb_link_2p \
  /path/to/game.gbc /path/to/game.gbc --connect=netplay.example.com --port=55435

# GBA, two copies of the same cartridge
retroarch -L /path/to/mgba_splitscreen_libretro.so --subsystem gba_link_2p \
  /path/to/game.gba /path/to/game.gba --connect=netplay.example.com --port=55435

# SNES, one cartridge
retroarch -L /path/to/snes9x_libretro.so /path/to/game.sfc \
  --connect=netplay.example.com --port=55435
```

The port is allocated per room and may differ from `55435`. Native guests start from the host's synchronized machine state. Importing a native guest's separate personal battery save into a handheld link seat is not implemented.

## Save behavior and troubleshooting

Web GB/GBC and GBA participants import their own account's battery save into their assigned console. GBA selects the newest compatible `mgba`/`mgba_splitscreen` save and writes back to the room's core/slot. SNES starts from the host's save and shares one console; each web participant can store that shared progress in their own account. A running single-player session must finish uploading its save before the room starts. Save states are separate from this battery-save flow.

| Symptom                                 | Check                                                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| No multiplayer button                   | v2 UI, GB/GBC/GBA/SNES platform slug, updated image, four backend variables, `/api/netplay/bridge/config` |
| Room window does not open               | Browser popup permission and page error message                                                           |
| Room creation fails                     | Bridge health, shared network, identical service tokens, RomM permissions                                 |
| WebSocket fails                         | TLS, upgrade headers, exact allowed RomM origin, browser-reachable public URL                             |
| Native connection times out             | Native-enabled room, correct allocated port, DNS-only hostname, TCP bindings/NAT/firewall                 |
| Waiting for players                     | All chosen slots must join; an extra slot cannot remain empty                                             |
| Core/cartridge mismatch                 | Room-provided core, identical ROM bytes, player count and options                                         |
| SNES is rejected                        | NTSC LoROM/HiROM restriction; supported single-ROM archive/header layout                                  |
| Expected personal native save is absent | Native guests inherit host state; separate native guest SRAM import is unsupported                        |
| Disconnect or host closes               | Create a new room; late joining/reconnection and host migration are unsupported                           |

For qualification details, see [rollback room behavior and browser verification](ROLLBACK_ROOMS.md) and the [standalone core qualification report](https://github.com/ysteen/retroarch-netplay-bridge/blob/main/docs/core-qualification.md). The checks use original diagnostic games; they do not establish compatibility for every commercial title. SameBoy's attempted long soak is not recorded as a pass.

## Maintain the adapter

Qualified WASM packages, Linux cores, licenses, source revisions and hashes are in `custom-emulatorjs/data/cores/compat/rollback/`. The custom image copies those packages and the `bridge-*.js` client modules; `bridge-cores.json` selects the matching profile.

Reusable browser modules are owned by the standalone repository. From its checkout, run `node scripts/sync-romm-client.mjs ../romm`, then run `node scripts/check-netplay-client.mjs` in RomM. RomM-specific profiles, UI and API remain here. Adapter CI checks vendored hashes and tests; the standalone CI builds/tests the bridge container and does not publish an image.
