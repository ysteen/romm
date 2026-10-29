# Private images without server builds

The custom application and optional RomForge worker are published as private GHCR
packages for `linux/amd64`:

- `ghcr.io/ysteen/romm-custom-private:5.4.1`
- `ghcr.io/ysteen/romm-romforge-private:5.4.1`

The version tags advance only after both images pass the pull-and-boot check.
Each build also has a `sha-<12-character-commit>` tag and an immutable digest.
Use matching revisions for the app and worker. ARM64 is not published by this
workflow.

## Authenticate the installation server

Create a GitHub personal access token (classic) with `read:packages`, owned by an
account allowed to read these private packages. Authenticate under the same OS
user that runs Docker Compose:

```sh
docker login ghcr.io -u ysteen
```

Paste the token at Docker's password prompt. Keep it out of Git, Compose files,
images, shell arguments and chat. Login must be repeated when the token expires
or is revoked. GitHub Actions publishes with its own `GITHUB_TOKEN`; it does not
need this installation token.

## Install and update

Download the `romm-deployment-sha-*` artifact from a successful
**Publish Private Custom Images** run, unzip the artifact and extract its
`romm-deployment.tar.gz` into an installation directory. The bundle contains only
Compose files, default configuration, the deployment script, this guide and the
license. It contains no credentials, ROMs, firmware, database or saves.

With Docker Compose, Bash and Python 3 available:

```sh
./scripts/deploy-dosbox-pure.sh
```

The script creates `deploy/.env` with random secrets on first use. It pulls
published images and starts the database and app. Existing secrets, data paths
and RomForge preferences are preserved. All image downloads finish before
running services are stopped. An authentication or download failure leaves the
running services alone.

Repeat the same command to update. Enable the optional worker with
`--romforge`, or disable it with `--no-romforge`. The worker is recreated after
the app because they share a network namespace. Back up the database and
persistent data before upgrading across application versions.

The default address is `http://localhost:8080`. Set `ROMM_PORT`, `ROMM_DATA_DIR`
and `TZ` in `deploy/.env` as needed. Threaded browser cores require localhost or
HTTPS. To reuse a different deployment env file, pass `--env-file /path/to/.env`.

For an exact version, set both `ROMM_IMAGE` and `ROMFORGE_IMAGE` in `deploy/.env`
to matching commit tags or the digests listed in the workflow summary. Empty
values use the defaults in Compose. Legacy generated local image names migrate
to those published defaults; explicit registry references are preserved.

## Publish updates

Source code stays public in `ysteen/romm`, branch `custom/retroarch-dosbox-5.4.1`.
The private `ysteen/romm-image-builds` repository contains only the publishing
workflow. It checks out that public branch and publishes packages linked to the
private build repository. Its reviewed workflow template is also public at
`docker/publish-private-images.yml`.

After pushing source updates, start publication with:

```sh
gh workflow run publish-custom.yml --repo ysteen/romm-image-builds
```

The workflow rejects an existing package unless its visibility is private and
verifies privacy again after publishing. Never change these packages to public.

The workflow uses `contents: read` and `packages: write`, builds the app and a
worker based on that exact image digest, and tests installation from the
registry. It advances the version tags only after validation. Failed runs can
be rerun from GitHub Actions. The installation server performs no image build.

## Local development builds

A complete source checkout is required for local builds:

```sh
./scripts/deploy-dosbox-pure.sh --build
./scripts/deploy-dosbox-pure.sh --build --romforge
```

This adds `compose.custom-dosbox-pure.yml`, builds locally tagged images, and
does not push them. `--no-build` selects the default pull behavior. Runtime
Compose files have no `build` sections.
