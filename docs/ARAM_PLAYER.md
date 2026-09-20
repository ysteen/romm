# Optional ARAM web player

ARAM is a separate player, alongside EmulatorJS and Ruffle, in the **v2 UI**.
It uses the official Go/WebAssembly release without changing the emulator.
The frozen v1 UI does not expose this new player.

## Install

Review the [ARAM license](https://github.com/mirusu400/aram-emu/blob/v0.3.0/LICENSE.md)
before installation. ARAM 0.3.0 uses PolyForm Noncommercial 1.0.0, not RomM's
AGPL license. Commercial use requires separate permission from its author.
Installing an adapter does not change either project's license. Review both
licenses before redistributing an image that includes the optional runtime.

From `frontend/`, with Node 24 and `unzip` installed:

```sh
npm run install:aram -- --accept-noncommercial
npm run build
```

The installer verifies the archive, WebAssembly, Go loader, and license against
`src/players/aram/runtime-lock.json`. It preserves the required notice and build
provenance, refuses modified existing files, and publishes the availability
manifest last. For offline installation, add `--archive /path/aram-web.zip`
and `--license-file /path/LICENSE.md`. These files still require matching hashes.

Generated assets live in `frontend/public/assets/aram/0.3.0/` and are ignored by
Git. Both existing Docker build paths copy them through the frontend build. Run
the installer **before** building the image. There is no automatic external CDN
fallback or automatic runtime download when a user opens a game.

Alternatively, mount the generated `0.3.0` directory read-only at
`/var/www/html/assets/aram/0.3.0` in a RomM image containing this adapter. The
runtime manifest enables the player on the next page load. An installation
without the manifest leaves other players unchanged and hides ARAM play actions.

## Library setup

Use platform folders named `wipi`, `skvm`, `raptor`, or `aram`, for example:

```text
library/roms/wipi/My Game.dat
library/roms/skvm/My Game.jar
library/roms/raptor/My Game.zip
```

Existing custom platform names can use RomM's `platforms.versions` mapping to one
of those slugs. The player deliberately does not claim every Java/mobile platform
or every `.jar` file is compatible. No ROMs or firmware are included.

Scan the library, switch to v2, and select Play on a supported platform. The
platform badge identifies ARAM. Direct player URLs are `/rom/<id>/aram`.
The authenticated RomM content endpoint supplies the bytes, including ZIP bundles
for multi-file entries. ARAM's initial-package bridge limits inputs to 32 MiB.
Only `.dat`, `.jar`, and `.zip` application packages are accepted. Whole-phone
firmware booting is not part of this integration.

## Controls and persistence

ARAM owns keyboard, gamepad, sound, and its touch keypad while running. RomM's
global shortcuts and gamepad-to-menu translation are disabled for the session.
The player toolbar offers fullscreen and return to game details. Destroying the
iframe terminates the Go runtime and audio rather than leaving a background game.

Save data is **browser-local**, namespaced by RomM user, then by ARAM's content
hash. Clearing this site's browser data removes it. It does not synchronize to
RomM's server, and RomM save-state upload/download is not wired up.

**Before leaving, use ARAM's Emulation > Stop to flush in-game saves.** The stock
web build does not expose a host API for flushing saves. RomM warns before leaving
an active player; it does not pretend that closing an iframe saves a running game.
ARAM's own save-state features are subject to the web build's capabilities.

The adapter disables ARAM analytics and blocks external requests with the iframe's
Content Security Policy. Game files never go to the public ARAM website. Guest
features needing external network services can consequently be unavailable.
The same-origin iframe runs trusted, pinned emulator code, not untrusted site
content; its storage wrapper separates users' saves, not browser security origins.
The ARAM document alone permits `unsafe-eval` because the pinned Ebitengine text
input bootstrap evaluates bundled JavaScript. Inline scripts and external script
sources remain blocked; the main RomM document's policy is unchanged.

## Verification boundary

Automated checks cover registration, content transfer and limits, message
validation, user storage isolation, and runtime availability. Browser checks use
synthetic input when no authorized game is available. A booted ARAM canvas is not
evidence that a particular commercial title is playable; compatibility requires
testing the user's own game and profile.

After installing the runtime and building the frontend, `npm run test:aram`
runs isolated browser checks against the 8081 origin. API calls use synthetic
fixtures and never register a game, log in, or write to the running RomM server.
Screenshots and failures are written outside the repository under `/tmp`.

For an existing debug Chrome, run the suite from a Node environment that can
reach its CDP endpoint. Windows Chrome normally requires Windows Node rather
than WSL's loopback interface. For example, in PowerShell:

```powershell
$env:ARAM_BROWSER_TEST = "1"
$env:ARAM_CDP_ENDPOINT = "http://127.0.0.1:9222"
$env:ARAM_RUNTIME_FROM_SERVER = "1"
$env:ARAM_TEST_OUTPUT = "$env:TEMP\romm-aram-browser-results"
npx playwright test --config playwright.aram.config.ts
```

With `ARAM_RUNTIME_FROM_SERVER=1`, first serve the installed runtime directory
from `romm-test` at `/assets/aram/0.3.0/`. This avoids transporting the large
WebAssembly binary through CDP. Frontend code still comes from the local build,
so the test does not overwrite the running instance's UI. Each check uses a new
isolated browser context; existing tabs and their settings remain untouched.
The gamepad checks simulate RomM's navigation events, not a physical controller.
