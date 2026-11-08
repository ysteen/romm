> Historical implementation notes. Installation instructions and compatibility claims below are superseded by the current guides one directory above.

# Rollback multiplayer: install and connect

This adapter runs with [ysteen/retroarch-netplay-bridge](https://github.com/ysteen/retroarch-netplay-bridge), a separate private repository. The RomM integration is on [`ysteen/romm`, branch `custom/netplay-retroarch-bridge`](https://github.com/ysteen/romm/tree/custom/netplay-retroarch-bridge). It is not part of an upstream RomM release.

Every player runs a local core. The bridge exchanges inputs and synchronization messages. RomM handles browser login, game access and saves. Account-bound rollback rooms prefer **RetroArch** as the state source and timing reference, then a **web player**. Two RetroArch players can start without a web emulator. The chosen host controls starting, player numbers and removal from their retained room page. During play, only a playing participant takes over; a waiting rejoin does not displace the current host.

In the room, choose a player number, select **Web browser** or **Windows RetroArch**, then select **Join game**. Choosing a number alone does not start the web core, including after reconnecting. The host starts once all participants are ready. For the reusable Windows launcher and the Android Argosy plan, see [rollback room operation](ROLLBACK_ROOMS.md).

## Supported clients

| System | Matching core                              | Room                                                      |
| ------ | ------------------------------------------ | --------------------------------------------------------- |
| GB/GBC | SameBoy `1.0.4c87d256-rollback2`           | Two linked consoles                                       |
| GBA    | mGBA Splitscreen `0.1.0-f1d5975-rollback2` | Two to four linked consoles; two-player live UI qualified |
| SNES   | Snes9x `1.632d4cce69`                      | One console, two joypads                                  |

The room provides matching native cores for Linux x86_64; Windows x64, x86 and ARM64; and Android arm64-v8a, armeabi-v7a, x86_64 and x86. SameBoy and mGBA need these patched builds. RetroArch itself requires no modification; Linux qualification used RetroArch 1.22.2. Android builds target API 24 or later and use 16 KiB ELF alignment.

Windows x64 and x86 passed DLL loading and version checks for all three cores. mGBA and Snes9x also passed rollback/replay and produced identical 120-frame states from a Linux snapshot. Android and Windows ARM64 passed binary architecture, exported API and dependency checks; device gameplay is not qualified. SNES currently accepts standard NTSC LoROM/HiROM up to 4 MiB, including a single-ROM ZIP or a 512-byte copier header. PAL and extended/interleaved images are rejected.

Leave/rejoin and host transfer have browser and transport coverage. On 2026-11-04, a Windows runner capped at 1.5 GiB, two CPUs and 60 seconds per case verified automatic mGBA native/native rejoin, web-to-native handoff and native rejoin from a surviving web source. Progress, battery data, later input and subsequent CRC checks passed. This is short two-player diagnostic coverage, not all-game or Android qualification. Native emulator qualification remains prohibited in WSL.

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

The standard branch is `custom/retroarch-dosbox-5.4.1`; multiplayer development stays on `custom/netplay-retroarch-bridge`. Shared DOSBox fixes are backported without the bridge. The same existing image packages use separate mutable tags: `5.4.1` for the standard branch and `5.4.1-netplay` for a checkout containing `compose.netplay.yml`. Immutable commit tags remain available for both. Use the matching channel for the RomForge worker as well.

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

## Administrator dashboard and room list

Open `/assets/emulatorjs/input-netplay/admin.html` on the RomM HTTPS origin. The local LAN entry at port 8083 forwards to that page on port 8443. Use `http://<LAN-address>:8083/?setup=1` to download the local certificate before the first HTTPS visit.

Sign in to RomM as an administrator, then select **Check access**. Every status, settings, log and save-retry API checks both the required scope and the current `admin` role. Ordinary users cannot gain access by requesting wider token scopes. Management uses the existing session and CSRF protection; the bridge service token stays on the backend.

**Settings** shows public/internal addresses, native ports, allowed browser origins, active rooms and pending saves. Public URL and native hostname overrides are stored in RomM's persistent Redis and apply to new connections. Blank fields use the deployment values. **Use deployment settings** removes both overrides, which is useful after a LAN address change. Changing an advertised address does not configure Caddy, firewall rules, TLS or listener ports.

Room creation, room capacity and the snapshot request interval can be changed without ending existing games. These settings live beside pending saves in the bridge's persistent volume. Capacity can be lowered while more rooms are active; additional creation waits until below the limit. **Sync pending saves** immediately retries the server queue without overwriting conflicting files.

**Logs** shows the latest 500 bridge events since its last restart, including RetroArch connections and save failures. It supports live updates, text filtering and a JSONL download. Game/state payloads and credential fields are excluded. Historical container output remains available through the deployment's normal container logs.

Players browse a room list with the host's cartridge title, each participant's cartridge and name, occupancy, password requirement and play status. Select a room, enter its password if required, and choose **Join room**. Full rooms remain visible. Inside the room, cartridge names appear before player names; player-number and client selection remain explicit.

## Server save synchronization

The matching broker and adapter synchronize web and Windows cartridge SRAM through a durable server queue, including Windows-only games. The Compose setup mounts `netplay-saves` at `/data/saves` and sets `NETPLAY_BRIDGE_SAVE_DIR`. Retain this volume during upgrades. Create new rooms after deploying both services.

RomM enables **Sync multiplayer saves** when `NETPLAY_BRIDGE_URL` and `NETPLAY_BRIDGE_TOKEN` are configured. Its existing scheduler and task worker run the consumer every minute. Keep RomM's Redis storage persistent because it holds the original account grants and write receipts. No new callback address or launcher installation is required.

The broker normally collects web progress every 15 seconds or reuses native checkpoints every 600 frames. Web **Sync** and **Save and return to room** additionally flush immediately. The room shows whether progress is stored on the server, synchronized to RomM, or waiting after a failure. A closed room does not delete pending saves. Abruptly closing every client preserves only the last snapshot received by the server.

Each original account receives a separate `room-<id>-p<participant+1>.srm` under its selected ROM and room core/slot. The initial source save is preserved. A later session can select that room save; direct invitations retain their normal latest-compatible-save selection. A replacement account in the same player slot does not receive the previous player's save. SNES shares one console's SRAM across the original participants' accounts.

Permissions are checked again when writing. Outside edits, revoked permission and storage failures retain the queued save for retry and appear in server logs; outside edits are never force-overwritten. Fix the reported condition before retrying. Keep queue files private because they contain game progress. This synchronizes cartridge SRAM only, not emulator save states or separate RTC files. See the broker's `docs/save-sync.md` for pinned layouts and verification limits.

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
2. Choose a save under **Resume from save**, or choose a fresh start, then select **Relay server** (the label is translated). The room opens inside the player. A supported single-player game's **Netplay** toolbar button also opens this flow, carrying its current in-game save.
3. Select the player count. Enable **Allow RetroArch clients** if a native player will join. A room password is optional; leave it blank for a passwordless room. Select **Create room**.
4. Copy the room invitation and, if set, send the displayed room password separately.
5. A web guest signs in to the same RomM server and opens the invitation, enters the room password if required and selects **Join room**. Alternatively, open that game's player page, select **Relay server**, and choose the room under **Open rooms**. Use a separate browser profile or device for a second account.
6. Everyone enters the waiting room with **Not selected** as their player number, including the host. Each guest can choose or clear their own number. The host can change anyone's number, including native guests. A number already selected by another participant is unavailable; clear it first to exchange numbers.
7. Once all selected player slots are connected, ready and assigned a number, the host selects **Start game**. Joining alone does not start play. Numbers are fixed after starting.
8. The room panel closes when play starts. Use the EmulatorJS toolbar for volume, shared pause, **Sync save** and **Save and leave room**. Its **Netplay** button reopens the room panel; **Return to game** or Escape closes it. Automatic room saves run every 15 seconds. Each player uses their own keyboard, touch controls or gamepad.

Web games run in the same page. **Netplay** opens the room panel inside EmulatorJS with each person's ping beside their name. **Return to game** or Escape hides the panel and keeps the game connected. Game input is neutral while the panel is open. Windows RetroArch users keep the browser room page open while playing; native handoff preserves its member list and ping display. The value is that device's round-trip time to the relay, refreshed about every two seconds. It does not measure the complete player-to-player delay or rollback time. **Measuring…** appears until a reply arrives, or if the previous reply is stale.

A compatible web participant can resume in a free console using its existing cartridge and player assignment. It loads the current state and subsequent inputs without restarting other players. Their selected starting saves are not substituted into the running state. A ready Windows client also joins automatically from a live source. Active players briefly synchronize to the current full state without returning to the initial save or requiring a host Restart command. All running replicas closing loses this live source. Different GB/GBC or GBA cartridges may wait in the room for host moderation; they do not alter the running cartridge set. The host can select **Prepare new game**, have everyone select their client and **Join game** again, then select **Start game** to apply their chosen cartridges. Manual room setup has no waiting deadline. Leaving the room, navigating away or closing the room tab disconnects that account, including an active or preparing Windows client. Remaining players continue with neutral input for the empty seat, and host controls move to another playing RetroArch, then a playing browser. The last participant leaving closes the room.

The invitation contains the ROM/room identifiers, not the room password or service token. An invitation does not bypass the guest's RomM game permissions, even in a passwordless room. When set, the password is shared by the room, including native guests; per-player native passwords and native RomM login are not implemented.

## Connect RetroArch on Windows, Android or Linux

1. Have a browser host create a room with native clients allowed. Ask for the displayed hostname, room port and room password. Open its invitation while signed in to RomM.
2. Under **Play in RetroArch**, download the suggested core. This section is available before joining as a web player. Browser OS/CPU information selects a suggested platform; choose the architecture of your installed RetroArch app if it differs, such as a 32-bit app on a 64-bit phone. Unsupported or unknown platforms require a manual selection. Downloading does not reserve a player slot.
3. Install the provided `.dll` (Windows) or `.so` (Android/Linux) using RetroArch's **Load Core → Install or Restore a Core**, or select the downloaded core with `-L`. Use the same unmodified ROM bytes and the room's core options. A stock core with the same general name is insufficient.
4. For mGBA Splitscreen, also select **Download core info (.info)**. Copy `mgba_splitscreen_libretro.info` into **Settings → Directory → Core Info**, without changing its name or adding `.txt`. Close RetroArch, remove `core_info.cache` from that folder if present, and reopen it. Select the installed **mGBA Splitscreen** under **Load Core**, then browse for the cartridge under **Load Content**. See the [RetroArch manual core installation guide](https://docs.libretro.com/guides/download-cores/) for the separate Cores and Core Info directories.
5. For mGBA, load one matching GBA through **Load Content**. Updated native builds boot two linked consoles directly. For three or four players, change **Quick Menu → Core Options → Players per ROM**, then reload before joining. The GBA Link subsystems also accept the same cartridge in every slot. If **How many players** still appears, quit RetroArch completely and replace its installed DLL/SO with the room's current download. The startup patch preserves the state format; these replacement binaries have static ABI checks, with interactive validation pending user testing. SameBoy uses its two-console subsystem and **48000 Hz** audio; SNES loads one cartridge.
6. Connect as a Netplay client to the displayed address and exact room port, then enter the room password when prompted. RetroArch 1.22.2's address prompt accepts `hostname|port` (for example `192.168.3.100|55435`), or set the server address and TCP port separately. Do not enter `hostname:port` in that prompt. Do not start another native host or rely on the public RetroArch lobby. The room host assigns your player number in the waiting room and selects **Start game** once everyone is ready. The native client waits until then.

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

The port is allocated per room and may differ from `55435`. New rooms use account-bound native preparation. Download the reusable launcher once and run **Register Launcher.cmd**. Choose a player number, **Windows RetroArch**, then **Join game**; it stages the matched core/info, complete ordered cartridge set and isolated settings, then authenticates through a temporary loopback relay and starts stock RetroArch. Each GB/GBC or GBA player keeps the cartridge and save selected before opening Relay server. The host starts preparation after everyone chooses a number; the helper waits for this step and downloads the resulting ordered set automatically. The room shows each participant's cartridge name. The host can remove a participant without disconnecting everyone else, and the removed account cannot rejoin that room. The existing member and selected number are reused, so switching clients does not add a participant. Keep each participant's room page open. RetroArch has host priority; a playing web participant is the fallback.

The new mGBA `0.1.0-f1d5975-rollback2` native/WASM loader supports distinct cartridges in each subsystem slot. Every rollback participant loads the same ordered complete set and controls one console. New guests import their selected save through the host before game start. When a web participant is playing, its confirmed native progress is stored in each native participant's RomM account/ROM as a separate room save. Native-only rooms do not yet upload progress automatically. Unexpected disconnects can lose progress since the latest periodic upload.

For manual native connection, obtain the personal password through native preparation. The invitation password alone is insufficient in account-bound rooms. See [Windows instructions, limitations and evidence](ROLLBACK_ROOMS.md) for the local implementation. Android is excluded from this implementation and the old Android mGBA core cannot join the new profile. Changes are deployed to the local LAN test server at `https://192.168.3.112:8443` on the `custom/netplay-retroarch-bridge` fork branch. The Windows helper reuses a matching existing RetroArch before downloading a portable fallback; mGBA shows only the assigned console's screen and audio.

## Save behavior and troubleshooting

Web GB/GBC and GBA participants import their chosen in-game save into their assigned console. An explicit selection is honored even when a newer save exists; choosing a fresh start imports none. A direct invitation uses the newest compatible account save. GBA accepts `mgba`/`mgba_splitscreen` saves and writes back to the room's own core/slot. SNES starts from the host's save and shares one console; each web participant can store that shared progress in their own account.

Switching through a running game's Netplay toolbar copies its current battery data after the server upload succeeds. Selecting a save state directly for a room reports an error: load it in single-player first, then switch through the toolbar to carry its in-game save. This does not transfer the exact machine state from a different single-player core.

Rollback replay suppresses audio output. Short processing stalls can still empty the browser audio queue. Room playback keeps about 60 ms of audio headroom, smooths sample discontinuities, and catches up a bounded number of delayed frames. This adds a small audio delay and reduces short dropouts; sustained low frame rate or long network stalls can still interrupt sound. Already-played predicted audio cannot be undone.

| Symptom                                 | Check                                                                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No multiplayer button                   | v2 UI, GB/GBC/GBA/SNES platform slug, updated image, four backend variables, `/api/netplay/bridge/config`                                                                |
| Room does not open                      | Player error message, game permissions and updated frontend/runtime assets                                                                                               |
| Room creation fails                     | Bridge health, shared network, identical service tokens, RomM permissions                                                                                                |
| Incorrect room password                 | Enter the password set by the host, not your RomM login password; passwordless rooms need no password                                                                    |
| WebSocket fails                         | TLS, upgrade headers, exact allowed RomM origin, browser-reachable public URL                                                                                            |
| Native connection times out             | Native-enabled room, correct allocated port, DNS-only hostname, TCP bindings/NAT/firewall                                                                                |
| Waiting for players                     | All chosen slots must join and have a unique player number, then the host selects Start game                                                                             |
| Core/cartridge mismatch                 | Room-provided core, identical ROM bytes, player count and options                                                                                                        |
| GBA files missing from Load Content     | Install the room's `.info` in Core Info, close RetroArch and remove `core_info.cache`; temporarily disable Settings → File Browser → Filter Unknown Extensions if needed |
| ZIP contents missing or not loading     | Extract the `.gba` first; the core accepts GBA bytes and RetroArch handles archive extraction                                                                            |
| SNES is rejected                        | NTSC LoROM/HiROM restriction; supported single-ROM archive/header layout                                                                                                 |
| Expected personal native save is absent | Native guests inherit host state; separate native guest SRAM import is unsupported                                                                                       |
| Disconnect or host closes               | Remaining players continue; matching-cartridge participants can select Join game to resume from a live replica                                                           |

For qualification details, see [rollback room behavior and browser verification](ROLLBACK_ROOMS.md) and the [standalone core qualification report](https://github.com/ysteen/retroarch-netplay-bridge/blob/main/docs/core-qualification.md). The checks use original diagnostic games; they do not establish compatibility for every commercial title. SameBoy's attempted long soak is not recorded as a pass.

## Maintain the adapter

WASM packages, native cores, licenses, source revisions and hashes are in `custom-emulatorjs/data/cores/compat/rollback/`. Windows/Android builds have per-target manifests in each core's `native/` directory. The custom image copies those packages and the `bridge-*.js` client modules; `bridge-cores.json` selects the matching profile and native downloads. Cross-platform build instructions are in the standalone project's `docs/native-builds.md`.

Reusable browser modules are owned by the standalone repository. From its checkout, run `node scripts/sync-romm-client.mjs ../romm`, then run `node scripts/check-netplay-client.mjs` in RomM. RomM-specific profiles, UI and API remain here. Adapter CI checks vendored hashes and tests; the standalone CI builds/tests the bridge container and does not publish an image.
