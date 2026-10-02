# Optional RomForge worker

RomPatcher.js remains the default patch engine. Select **RomForge** in the ROM's
patcher tab to queue a server-side patch and save its result directly to the
library. Patching does not transfer the original ROM or result through the browser.
The patch itself may be uploaded or selected from the ROM's library files.
Uncategorized top-level files use the same game-file default as the ROM details
API, including for automatic 3DS scan normalization.

The worker executes one job at a time. Its Compose defaults cap CPU at 0.5 cores,
memory at 2 GiB, and disable extra swap. A lock on the shared resources volume
prevents two worker containers from processing concurrently. Hashing, patching,
copying, and registration all happen in the worker. These limits do not eliminate
disk I/O or guarantee latency for other services on a shared disk.
The native patch process also has an output file size limit of twice
`ROMFORGE_MAX_FILE_SIZE` (1 GiB by default), including sparse files.

## Job status

Administrators can open **System > RomForge** in the v2 UI (`/romforge`) to see
worker availability, running and queued jobs, pending automatic conversions,
and the latest 50 results retained for up to seven days. The page refreshes every
five seconds while visible. It shows the current processing stage, result links
and errors, including jobs submitted by other users. This overview requires
the `tasks.run` scope and does not start, retry or cancel jobs.

## Enable

The deployment script keeps existing credentials, paths and RomForge preferences:

```sh
./scripts/deploy-dosbox-pure.sh --romforge
./scripts/deploy-dosbox-pure.sh --no-romforge --no-build
```

`--romforge` enables the worker and defaults scan normalization to true only if
that setting is absent. An explicit false is preserved. With no mode flag, the
script retains `ROMFORGE_ENABLED` (false for a new deployment). `--env-file PATH`
selects another deployment env file; the default is `deploy/.env`. `--no-build`
uses existing images. The script builds the app before the worker, then gracefully
stops the worker and recreates its shared network connection after updating the
app. It creates the key directory under the resolved configuration mount.

Build the updated RomM application image first. The standard `docker/Dockerfile`
and the custom `docker/Dockerfile.custom-dosbox-pure` both include the backend.
The worker must use the same application revision, DB, configuration, library,
resources volume, and Redis database as the API.

For this repository's `compose.dosbox-pure.yml` deployment, use the same env file
and `ROMM_DATA_DIR` as the existing deployment:

```sh
docker compose --env-file .env -f compose.dosbox-pure.yml -f compose.romforge.yml \
  --profile romforge build romm
docker compose --env-file .env -f compose.dosbox-pure.yml -f compose.romforge.yml \
  --profile romforge build romforge
docker compose --env-file .env -f compose.dosbox-pure.yml -f compose.romforge.yml \
  --profile romforge up -d romm romforge
```

The overlay defaults `ROMFORGE_ENABLED=true`. The worker shares RomM's network
namespace to reach its embedded Redis on localhost; it exposes no new ports.
Recreate the worker when recreating the RomM container. For deployments using
external Redis, provide the same `REDIS_HOST`, `REDIS_PORT`, `REDIS_DB`, username,
password and TLS settings to both services and adapt the network configuration.

The worker image includes the regular RomM Python dependencies, a self-contained
.NET CLI and Linux xdelta3. It does not start Nginx, the web API, scheduled jobs or
another Redis server. No WebAssembly build is used.

The worker runs as UID/GID 1000 by default. Set `ROMFORGE_UID` and `ROMFORGE_GID`
to the owner of your shared library and resources directories if they differ.

## Disable or pause

```sh
docker compose --env-file .env -f compose.dosbox-pure.yml -f compose.romforge.yml \
  --profile romforge stop romforge
```

Stopping is graceful: the active job can finish before the worker exits. Pending
jobs remain in Redis for up to seven days and resume when the worker returns.
The API rejects new jobs once the worker heartbeat expires (at most two minutes).
The UI refreshes availability every 15 seconds. RomPatcher.js remains usable.

To disable new RomForge requests immediately, set `ROMFORGE_ENABLED=false` and
recreate the API container. This does not cancel already accepted jobs. Do not
remove the shared library or resources volumes when stopping the worker.

## Limits and supported inputs

| Setting | Default | Meaning |
| --- | --- | --- |
| `ROMFORGE_CPUS` | `0.5` | Worker CPU quota |
| `ROMFORGE_MEMORY` | `2g` | Container RAM and RAM-plus-swap limit |
| `ROMFORGE_MAX_FILE_SIZE` | `536870912` | Maximum source bytes (512 MiB) |
| `ROMFORGE_MAX_PATCH_SIZE` | `134217728` | Maximum patch bytes (128 MiB) |
| `ROMFORGE_MAX_PENDING` | `16` | Maximum queued jobs |
| `ROMFORGE_TIMEOUT` | `1800` | Patch subprocess timeout in seconds |

Keep byte limits and timeout identical in the API and worker. A format may use
multiple full-sized arrays, so raising the input limit also requires measuring
and increasing the memory allowance. Oversized or expanding patches can still
exhaust the worker's memory; they must not be treated as successful jobs.

Supported: IPS, IPS32 (in `.ips` files), BPS, UPS, APS (`APS1` signature), PPF and
Xdelta/VCDIFF. IPS32 and general managed formats use the pinned RomForge 1.7.6
implementation. Xdelta uses Linux xdelta3 3.1.0 rather than RomForge's Windows
native wrapper; external decompression/recompression is disabled. The CLI checks
BPS source, patch and output CRCs in addition to the upstream decoder's checks.
UPS checksum mismatches fail. Formats without source checksums cannot establish
that the user selected the correct source.

ZIP, 7z and RAR patch bundles are supported. A binary-patch bundle must contain
exactly one supported patch; multiple candidates are rejected. Archive entry
counts and expanded bytes are bounded; traversal, duplicate paths, links and
encrypted archives are rejected. Disc-set rebuilding, CHD/RVZ creation, Switch,
Wii U and Vita repacking remain unsupported. RomPatcher.js retains its additional
RUP, BDF, PMSR and APS variants.

## 3DS storage and installation

The canonical library file is a decrypted CCI. 3DS LayeredFS patch bundles may
contain `romfs/`, `exefs/`, root `code.ips`, `code.bin`, or `exheader.bin`. A single
wrapper directory is allowed. RomFS file patches use exact relative paths such
as `romfs/path/file.bin.xdelta`; unknown RomFS targets fail instead of producing
an unchanged ROM. Input files are streamed; binary patches to individual files
can still require considerable memory. Repacking creates a new CCI, preserving
the base game. CCI and CIA conversion handles `.3ds`, `.cci`, `.cia`, or a ZIP/7z/
RAR containing exactly one of those files and optional documentation/images.
Multi-game archives and archives with extra payloads require manual extraction.

Set `ROMFORGE_NORMALIZE_3DS_ON_SCAN=true` on the API and worker to normalize after
successful library scans, including existing games in the selected scan scope.
The scan queues file IDs; the worker reads/extracts/decrypts one file at a time.
A decrypted `.cci` already inside its game folder is skipped. Conversion
preserves ROM and file IDs, metadata, permissions and saves. After output validation and a successful DB update, the
old file/archive is removed. If conversion or registration fails, the original
is retained/restored. Folder ROMs are normalized file by file, preserving the
folder name and all variants, including original and translated editions.
Standalone games are stored as `<game>/<filename stem>.cci`, including
already-decrypted CCI files. DLC and update CIA files remain unchanged. If a
CCI name is occupied, the source extension is appended, for example
`game (cia).cci`; further collisions preserve the source and fail the job.
Interrupted publication can leave `.romm_tmp_*` recovery files;
do not remove them without checking the job and database state.
Queued normalization waits while a library scan is running. A missing key file
leaves candidates pending. A scan observed before conversion or publication
defers the conversion and returns the file to the pending set.
Errors remain in the worker job logs; the patcher tab
shows the latest normalization job. Rescanning retries failed files.

Place your own keys in the shared configuration directory:

```text
config/romforge/keys/aes_keys.txt
config/romforge/keys/seeddb.bin     # seed-encrypted titles
config/romforge/keys/certs.bin     # CIA creation
config/romforge/keys/boot9.bin     # optional upstream key material
```

`aes_keys.txt` must contain the required slots and CIA common keys; file presence
alone cannot prove a complete keyset. The CLI reads keys for each job, so adding
them does not require rebuilding an image. The worker mounts configuration read
only. No retail keys or certificates are shipped. The adapter also avoids
requesting encryption keys for NCCH explicitly marked as unencrypted.

For a physical console, choose **Prepare CIA for installation** in the patcher
or open the ROM's QR dialog. This queues an on-demand CIA export without creating
another library ROM. The QR contains a random, expiring capability URL; no RomM
login is needed on the handheld. Each request rechecks the requesting account,
ROM visibility and source identity. URLs support HEAD and byte ranges. Anyone
holding a valid link can download that file until expiry. Use a server hostname
reachable from the 3DS; localhost on the handheld is not the RomM server.

CIA output follows RomForge's CFW installation format. This is packaging, not
retail signing or encrypted `.3ds` creation. It encrypts the ticket title key;
content remains decrypted. Update/DLC CIA building is not supported upstream.
The CCI remains the sole permanent library copy. Identical CIA requests reuse
one temporary export, deleted after expiry when no download lease remains.
The default TTL is 24 hours and the cache cap is 16 GiB. Active download requests
renew a lease so slow or resumable downloads can finish. Cleanup runs on worker
heartbeats and before jobs; stopping the worker postpones cleanup.

| Additional setting | Default |
| --- | --- |
| `ROMFORGE_MAX_3DS_SIZE` | 8 GiB (input and total expanded ROM archive) |
| `ROMFORGE_MAX_EXPANDED_SIZE` | 2 GiB (expanded patch archive) |
| `ROMFORGE_INSTALL_TTL` | 86400 seconds |
| `ROMFORGE_INSTALL_CACHE_SIZE` | 16 GiB |
| `ROMFORGE_NORMALIZE_3DS_ON_SCAN` | false |

Plain CCI conversion streams decrypted partitions directly without rebuilding
RomFS. Set `ROMFORGE_MEMORY=4g` in the existing deployment env file to increase
the worker memory limit. The Compose files already support this override.
The worker needs temporary disk space for archive extraction and publication
even though only one permanent CCI is kept. The nginx configuration denies direct public access to its work
folder; CIA downloads pass through the scoped API route.
## Storage, reuse and permissions

- Patching saves a new ROM on the source platform with a content-derived suffix,
  preserving the original. Scan normalization instead replaces the original as
  described above. Registration does not trigger a library-wide
  metadata scan. Run the normal identification flow if metadata is wanted.
- Results are reused by engine version, source ROM identity and SHA-256 hashes
  of both inputs. File hashes are memoized against filesystem identity, size,
  modification time and change time. Changed or deleted results are not reused.
- The resources volume stores result manifests and hash metadata under
  `romforge/`. ROM outputs themselves live only in the library; they are not
  duplicated in a permanent result cache.
- Uploaded patches are removed after success or handled failure. Abandoned
  uploads expire after the queue retention period plus the job timeout and a
  grace period. Cleanup runs at worker startup and before each job. A forced kill
  can leave temporary files; restarting the worker clears its scratch files.
- Job history retains the latest 20 requests per user/source for up to seven
  days. Refreshing or leaving the page does not stop accepted jobs.
- Submission requires ROM write permission. Both inputs are visibility checked;
  the worker checks current user permissions and file identities before patching
  and before publishing. Only the submitting user can inspect a job. Results
  inherit the source ROM's explicit user/group visibility restrictions.

## Sources and verification

Upstream: `sinjunyoung/RomForge` tag `v1.7.6`, commit
`8718a4599bc9c902f382f257a2c9ea51cc313a20`, GPL-2.0-or-later. The downloaded archive
is SHA-256 verified in `docker/Dockerfile.romforge`. The exact upstream archive,
license and CLI adapter are preserved in the image under `/opt/romforge/source`.
If distributing the image, provide its corresponding source, including this
adapter and Dockerfile, and the sources/notices for packaged dependencies.

The worker image enables the real-engine integration tests:

```sh
cd backend
pytest tests/endpoints/test_patch_jobs.py tests/endpoints/test_romforge_3ds.py
```

Tests require the repository's normal isolated test database and test dependencies.
Real-engine cases are skipped outside an image containing `/opt/romforge/RomForge.Cli`.
They check actual IPS/IPS32/BPS/Xdelta output bytes, synthetic encrypted NCCH
decryption, CCI/CIA round trips, ZIP inputs, LayeredFS ExeFS/RomFS changes,
normalization rollback and scoped Range downloads as well as permissions, queue capacity,
input mutation, failure cleanup, source preservation, and result reuse.
