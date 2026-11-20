# Add netplay and DS WFC to an existing RomM deployment

Use `compose.netplay.pull.yml` with the existing Compose file and project name.
The overlay replaces the `romm` image and adds the bridge and its save volume.
It defines no database, RomM mounts or RomM ports. Keep the existing environment,
external database and Redis settings, authentication secret, library, assets,
resources, and configuration mounts. If the existing RomM service has a
different Compose name, change the overlay service key from `romm` to that name.

Back up your database and persistent files before updating. DS console profiles
are under the existing RomM assets path at `wfc/`. Keep an existing bridge queue
and the corresponding RomM Redis data together. The current release uses RomM
5.4.1 and publishes Linux amd64 images. Check version and database migration
compatibility before replacing an existing image.

## Obtain the paired image references

Copy the two image refs from a successful
[private DS WFC image publication](https://github.com/ysteen/relaycade/actions/workflows/publish-wfc-images.yml).
The paired publication requires the Relaycade repository to be private. Existing
tagged images keep their package paths and access settings.
Use the pair from the same run. Authenticate Docker with a GitHub account that
has access to both private packages and a token with `read:packages`:

```sh
docker login ghcr.io -u YOUR_GITHUB_USER
```

Add these settings to the same Compose environment file that the existing
deployment already uses:

```dotenv
ROMM_NETPLAY_IMAGE=<published RomM reference>
NETPLAY_BRIDGE_IMAGE=<published bridge reference>
ROMM_ORIGIN=https://romm.example.com
NETPLAY_BRIDGE_PUBLIC_URL=https://bridge.example.com
NETPLAY_BRIDGE_PUBLIC_HOST=bridge.example.com
NETPLAY_BRIDGE_TOKEN=<new random token of at least 24 characters>
# Bind to a reachable host address if Windows clients will connect directly.
NETPLAY_BRIDGE_TCP_BIND=0.0.0.0
```

If a bridge is already deployed, retain its shared token and map its saved
queue to the overlay's `netplay-saves` volume. The TCP listener defaults to
loopback when `NETPLAY_BRIDGE_TCP_BIND` is omitted. Allow TCP 55435–55442 from
the intended Windows clients if exposing the listener.

## Route RomM and the bridge

Keep the existing RomM host and proxy, including its forwarded Host,
HTTPS scheme, and cross-origin isolation headers. To use a separate bridge
hostname, route WebSocket upgrades from that hostname to the bridge HTTP
listener. Example for Caddy running directly on the Docker host:

```caddyfile
bridge.example.com {
    @relay {
        path /v1/rooms/*
        header Upgrade websocket
    }
    handle @relay {
        reverse_proxy 127.0.0.1:8082
    }
    handle {
        respond 404
    }
}
```

A proxy container can use `netplay-bridge:8080` on the shared Docker network.
`ROMM_ORIGIN` is the origin of the page running the player. Keep it pointed at
RomM when the bridge has a separate hostname. The player receives the gateway
URL from RomM. The bridge validates the origin and the ticket before opening a
session. Native RetroArch TCP uses the direct DNS host with the room port.
The bridge needs outbound TCP and UDP for Nintendo DS WFC.

Open `https://romm.example.com/api/netplay/bridge/admin/ui/` as a RomM
administrator. Relaycade also supports an independent administrator login at
its own HTTPS origin. Set `NETPLAY_BRIDGE_LOCAL_ADMIN_PASSWORD` and
`NETPLAY_BRIDGE_LOCAL_ADMIN_ORIGIN` in Compose, then follow the
[standalone HTTPS setup](https://github.com/ysteen/relaycade/blob/main/docs/administration.md).
Players sign in to RomM to access games and saves.

## Pull and start

Run from the existing deployment directory. Compose must use the same
`.env`, project name and base file set as the currently running server:

```sh
docker compose -f compose.yml -f compose.netplay.pull.yml config --quiet
docker compose -f compose.yml -f compose.netplay.pull.yml pull romm netplay-bridge
docker compose -f compose.yml -f compose.netplay.pull.yml up -d --no-build romm netplay-bridge
```

Keep the overlay in later Compose commands. If the deployment uses an existing
RomForge worker, confirm its paired image before changing it. After starting,
check your existing account and library, the administrator dashboard, a WebSocket
connection and a Nintendo DS game resumed with melonDS DS. If a previous RomM
administrator override advertises the old bridge host, select **Use deployment
settings** in the dashboard.
