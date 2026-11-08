# Install RomM multiplayer on another server

This guide is the operator entry point for the portable netplay installer. It
installs the exported, tested RomM application and standalone bridge without
access to the development server, source repositories, GitHub packages or a
compiler. The complete bundle includes Docker images and the read-only code
overlays used by that release. A source checkout alone is not this bundle.

The destination needs Linux **amd64**, Docker Engine with Compose v2, Python
**3.11+**, enough disk space for the exported images plus the library, and an
HTTPS reverse proxy. Image loading needs free space for both the compressed
archive and unpacked image layers. Windows and Android are player devices, not
installation targets for this package. No emulator runs on the server.

## 1. Obtain the complete installation directory

The release operator exports it using the procedure at the end of this guide.
Copy the entire resulting directory to the destination, for example
`/srv/romm-netplay`. It contains:

- `install.py`, `compose.json` and `Caddyfile.example`;
- `images.tar.gz`, with the exact application, bridge and database images;
- `runtime/`, with the release's code and core overlays;
- `manifest.json`, with SHA-256 hashes and immutable image IDs;
- default configuration and license information.

It contains no running database, accounts, ROMs, user saves, Redis contents,
container writable layers, TLS private keys or development `.env` files. Treat
this as a private release: image layers and built-in image settings are retained,
including any explicitly reviewed metadata-provider configuration. This is not
a public redistribution or a claim that image layers were scrubbed of secrets.
No container deployment environment is copied. Treat
the bundle as executable software: obtain it from the release operator and
compare its externally supplied manifest checksum. The manifest detects damage;
it is not a digital signature.

## 2. Set the addresses and initialize

Create DNS for `romm.example.com` pointing at the destination. Use a direct DNS
record for the native TCP host. An HTTP-only CDN proxy does not relay RetroArch
TCP traffic. Install Caddy or use an existing HTTPS proxy on the host.

```sh
cd /srv/romm-netplay
python3 install.py init --origin https://romm.example.com --native-host romm.example.com
```

The command creates a mode-600 `.env` with new database, application and bridge
secrets, and empty persistent directories under `data/`. Re-running `init`
refuses to overwrite existing credentials. No credentials from the source server
are reused. `ROMM_ORIGIN` must be the exact browser origin, including a custom
HTTPS port if used. The native host has no scheme, path or port.

The default URLs are:

| Purpose                                         | Address                                                 |
| ----------------------------------------------- | ------------------------------------------------------- |
| RomM, login, assets, rooms and Windows launcher | `https://romm.example.com`                              |
| Browser bridge transport                        | `https://romm.example.com/netplay`                      |
| Native RetroArch                                | `romm.example.com`, room port in TCP 55435-55442        |
| Administrator page                              | `https://romm.example.com/api/netplay/bridge/admin/ui/` |

Edit `.env` if ports 8080 or 8082 are already occupied. They bind to loopback and
are only reverse-proxy upstreams. Database ports are not published. The native
range binds to all interfaces by default. Configure host firewall/NAT to allow
TCP 443 and 55435-55442 from the intended clients. Caddy's public certificate
issuance may also require TCP 80. An outgoing Internet connection is needed for
public certificate issuance and metadata/portable RetroArch downloads, even
though application images can be loaded offline.

## 3. Configure HTTPS

Adapt `Caddyfile.example` and install it in the host's Caddy configuration. Set
the hostname to the same origin used above. Keep `handle_path /netplay/*` so
Caddy strips the prefix before forwarding to the bridge. WebSocket upgrades
are handled by Caddy. Point the fallback route to RomM on loopback port 8080.
If changing upstream ports, update both `.env` and Caddy.

For another proxy, preserve the original Host and forwarded HTTPS scheme and
support WebSocket upgrades. Route `/netplay/*` to port 8082 with the prefix
removed; route all other paths to port 8080. Do not replace RomM's cross-origin
isolation headers. Native TCP bypasses this HTTP proxy.

Publicly trusted HTTPS needs no certificate installation on player PCs. A
private LAN CA must be trusted by both the browser and Windows PowerShell.
Browser certificate exceptions do not establish Windows launcher trust. This
bundle does not reuse the development CA or automatically distribute a new CA.
For LAN-only certificates, install your CA on each player device or provision
publicly trusted DNS-based certificates through your normal proxy procedure.

## 4. Verify and start

```sh
python3 install.py check
python3 install.py up
python3 install.py status
```

`check` verifies package hashes and resolves Compose without starting services.
`up` verifies hashes, loads missing bundled images, and starts the database,
bridge and RomM with health checks. It uses no image build or registry pull.
A small one-shot initialization service gives the fresh save volume to the
unprivileged bridge user before the bridge starts. It uses the bundled bridge
image, has no network and exits after setting directory ownership.
Initial database setup can take several minutes. On failure, read:

```sh
python3 install.py logs
docker compose -p romm-netplay --env-file .env -f compose.json logs --tail 100 database
```

Open the public HTTPS address and complete RomM's first-user setup. Create an
administrator account, configure the library, add your own ROMs to
`data/library/roms`, add required BIOS to `data/library/bios`, and run a scan.
Select the v2 interface. The bundle supplies no games or existing users.

Sign in as administrator and open the administrator URL above. Check access,
deployment addresses, room capacity, logs and pending saves. Ordinary RomM
accounts cannot use the dashboard or administration APIs. The dashboard is served from the bridge through the authenticated RomM adapter, so install a matched bridge release containing `admin-ui/`. The old `/assets/emulatorjs/input-netplay/admin.html` address redirects to the dashboard. Port 8083 was a development
shortcut; it is not required or provided by this installer.

## 5. Connect players

For the current core versions and complete player flow, read
[NETPLAY_BRIDGE.md](NETPLAY_BRIDGE.md) in the source repository, or the bundled
`PLAYER_GUIDE.md`. On a fresh installation:

1. Sign in to RomM. Open a GB/GBC, GBA or supported SNES game, choose its save or
   fresh start, and open Relay server. Create a room; allow native clients when
   needed. A blank room password is allowed.
2. Invite another authorized RomM account. Each GB/GBC or GBA player brings the
   cartridge selected on their game page. Cartridge titles appear in the room.
3. Choose unique player numbers. Each participant selects Web browser or
   Windows RetroArch, then Join game. The host selects Start game when ready.
4. Windows users download the launcher once, extract it to a retained folder,
   and run `Register Launcher.cmd`. Return to the room and Join game using
   Windows RetroArch. Accept the browser's external-application prompt.

The launcher reuses a matching RetroArch installation or downloads a portable
copy. It automatically downloads and verifies the matched DLL, `.info`, ordered
cartridges and chosen saves. Manual core installation is unnecessary. Windows
ARM64 needs a matching installed application or a selected x64 runtime. SameBoy
and mGBA show only the assigned screen/audio when started through the launcher.
Keep the room page open while using Windows. Closing RetroArch retains room
membership; closing/leaving the room disconnects the client and its link cable.

Launcher script updates require downloading the new launcher and running
`Register Launcher.cmd` once again. Subsequent core updates are fetched by hash.
Android automatic launch/admission is not implemented; available Android core
binaries do not imply a supported end-to-end Android room workflow.

## Updates, moves and recovery

Keep the deployment directory stable: the installer always uses Compose project
`romm-netplay`. Do not run two copies on the same Docker host. For an existing
unrelated RomM project, follow the source integration guide instead of pointing
this fresh installer at its database. Database major versions and schema
migrations must remain compatible.

Before updating, let active rooms end, back up `.env`, `data/` and the named
volume `romm-netplay_netplay-saves`. Stop services for a consistent file backup:

```sh
python3 install.py stop
tar -czf ../romm-data-backup.tar.gz .env data
docker run --rm --user 0:0 -v romm-netplay_netplay-saves:/source:ro -v "$PWD/..:/backup" \
  --entrypoint sh "$(python3 -c 'import json; print(json.load(open("manifest.json"))["images"]["netplay-bridge"])')" \
  -c 'tar -czf /backup/romm-netplay-saves-backup.tar.gz -C /source .'
```

Keep backups private. Extract the next software bundle over the same installation
directory while retaining `.env` and `data/`, then run `check` and `up`. The
named save volume remains attached. Keep the previous software bundle and
matching data backup together; application rollback may need a database restore
if migrations ran. Never use `docker compose down -v` during an update.

On a destination with images loaded, restore while services are stopped:

```sh
tar -xzf ../romm-data-backup.tar.gz
docker volume create romm-netplay_netplay-saves
docker run --rm --user 0:0 -v romm-netplay_netplay-saves:/restore -v "$PWD/..:/backup:ro" \
  --entrypoint sh "$(python3 -c 'import json; print(json.load(open("manifest.json"))["images"]["netplay-bridge"])')" \
  -c 'tar -xzf /backup/romm-netplay-saves-backup.tar.gz -C /restore'
python3 install.py check
python3 install.py up
```

Restore into an empty data directory and empty save volume. Keep file ownership
from the backup. If needed, load the bundled images first with
`docker image load -i images.tar.gz`; this starts no containers.

To move to another server, restore the software bundle, `.env`, persistent data
and named save volume, then adjust public addresses and DNS. A pending save queue
and RomM Redis grants must move together. Administrator address overrides can
take precedence over `.env`; use **Use deployment settings** after changing
addresses. Do not restore the development server's accounts by accident.

## Troubleshooting

| Symptom                       | Action                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package hash failure          | Recopy the complete release. Do not edit runtime files or bypass validation. `.env` is intentionally editable.                                       |
| Missing images                | Use a bundle with `images.tar.gz`, or load the exact IDs listed in `manifest.json`.                                                                  |
| Relay unavailable             | Check bridge health, service token consistency, Docker logs and admin settings.                                                                      |
| Browser cannot join           | Check HTTPS trust, exact origin, WebSocket routing and prefix stripping.                                                                             |
| Windows TLS/download error    | Trust the issuing CA in Windows; check the public hostname and new launcher registration.                                                            |
| Core does not support netplay | Use Join game through the current launcher; it stages the matched `.info` with deterministic state metadata. Avoid a stock core or stale info cache. |
| Windows TCP timeout           | Check direct DNS, native host, allocated room port and TCP firewall/NAT.                                                                             |
| Download 404                  | Retain the room page, cancel expired preparation and Join game again.                                                                                |
| Wrong save                    | Select the save before entering the room. Live rejoin restores running game state, not a new starting save.                                          |
| Black waiting screen          | Choose a number, Join game and wait for host Start. Check room readiness and logs if it stays black after Start.                                     |
| Save sync pending             | Keep Redis and save volume persistent, check task-worker logs, then retry from the admin page.                                                       |

Save synchronization covers web and native-only rooms. It stores each original
account's cartridge save separately and preserves the selected source save.
Abruptly closing every client retains only the last snapshot received by the
server. Emulator replicas contain all loaded cartridges' state; the account
policy is not memory isolation between clients. RTT in the room is network
round-trip time, not a measurement of complete input-to-screen latency.

## Export a release (release operator only)

From a prepared RomM checkout, identify the tested application and bridge
containers. Export while their image versions and code mounts remain unchanged:

```sh
python3 scripts/export-netplay-install.py \
  --romm-container YOUR_ROMM_CONTAINER \
  --bridge-container YOUR_BRIDGE_CONTAINER \
  --database-image mariadb:11.4 \
  --allow-image-env SCREENSCRAPER_DEV_PASSWORD \
  --output /path/to/new/romm-netplay-install
sha256sum /path/to/new/romm-netplay-install/manifest.json
```

The output directory must not exist. The tool copies only read-only code mounts
under approved runtime paths and exports the underlying immutable images.
It excludes all data volumes and container environment settings, checks image
platforms, and rejects images with populated secret-like environment keys unless
the operator explicitly reviews and names each with `--allow-image-env`. The
example key is RomM's image-bundled metadata-provider setting, not a generated
deployment password. Do not allowlist account, database or bridge credentials.
The full export may be large. It builds no images and does not restart services.
`--without-images` is for package/config validation or separately supplied images;
that output is not a complete independent installation on an empty Docker host.

Supply the manifest checksum over a trusted separate channel. This export is
an exact tested snapshot, including uncommitted runtime overlays; it does not
claim that the same revision is already pushed or published in GHCR. For later
CI releases, use matching RomM and bridge images plus their matching assets.
The installer does not build emulator cores. Keep all upstream licenses in
images/core packages, and retain source revisions and patches when distributing.
