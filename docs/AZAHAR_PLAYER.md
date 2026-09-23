# Azahar player settings

This guide describes this repository's custom Azahar WebAssembly core in RomM.
The player shows controls and operation results. Setup instructions and technical
compatibility notes are kept in these documents.

## GPU options

Start a 3DS game, open the EmulatorJS settings menu, and select
**Backend Core Options**. The GPU controls are:

| Menu control        | Core option               | Values                | GPU configuration |
| ------------------- | ------------------------- | --------------------- | ----------------- |
| Graphics API        | `citra_graphics_api`      | `auto`, `OpenGL`      | `OpenGL`          |
| Hardware Shaders    | `citra_use_hw_shaders`    | `enabled`, `disabled` | `enabled`         |
| WebGL Hardware Draw | `citra_use_webgl_hw_draw` | `enabled`, `disabled` | `enabled`         |

Changes use the same core-variable and browser-settings persistence mechanisms as
other backend core options. The menu reads the current value from the running
core. Graphics API changes require restarting the game. The web build uses
WebGL 2 and exposes only its supported graphics backends; it has no Vulkan path.
Other backend options, including internal resolution, remain in the same menu.

The core defaults remain Auto, hardware shaders enabled, and WebGL hardware draw
disabled. Enabling hardware draw offloads compatible vertex batches to the GPU
of the device running the browser. The RomM server does not render the game and
does not need a Docker GPU device mapping for this player.

The browser must permit hardware-accelerated graphics. On Chromium-based
browsers, `chrome://gpu` shows the WebGL acceleration status. CPU emulation still
runs on the CPU; this setting cannot move the entire emulator onto the GPU.

WebGL hardware draw is experimental. New shader combinations can cause long
compilation stalls, particularly on the first run, and compatibility varies by
game and graphics driver. Disable it in the same menu if a game renders
incorrectly or slows down. Changing settings never clears saves or browser data.

## Server defaults

To supply defaults for browsers without a saved preference, merge this into the
server's existing `config.yml` rather than replacing its other settings:

```yaml
emulatorjs:
  settings:
    azahar:
      citra_graphics_api: OpenGL
      citra_use_hw_shaders: enabled
      citra_use_webgl_hw_draw: enabled
```

Use the normal RomM configuration reload/restart workflow, then launch the game
again. Previously saved browser choices take precedence over server defaults;
change those choices through Backend Core Options when necessary.

## States and ordinary game saves

Use EmulatorJS **Save State**, **Load State**, **Load Latest State**, and
**Save & Quit**. Captures appear in the normal RomM state library with
`emulator=azahar`. The pre-launch States tab can resume a selected capture.
Ordinary in-game save data continues to use RomM's existing save bundle flow.
See [save-state behavior and compatibility](AZAHAR_SAVE_STATES.md) for details.

Existing Azahar states need no migration: both the previous panel and the
standard toolbar use the same RomM state API and core identifier. Compatibility
still depends on the game, core artifact, settings, and system data. A successful
restore does not guarantee identical rendering in every game; retain ordinary
in-game saves as well.

## Mii and shared-font system data

The existing firmware picker and automatic system-data selection remain in use.
Prepare and register `azahar-mii-system-data.zip` as described in
[Mii system-data setup](AZAHAR_SYSTEM_DATA.md). Installation instructions are not
shown in the player. Firmware packages are separate from game saves and states.

## Deployment and validation

Deploy the rebuilt RomM frontend together with the matching custom `loader.js`,
`src/emulator.js`, and `src/GameManager.js`. Runtime revision `20260922.1` changes
script URLs so old cached UI code cannot continue hiding the standard buttons.
The existing patched Azahar core and `_load_state_sync` export are retained.

Automated browser tests use isolated contexts, synthetic core responses and
intercepted RomM API calls. They check menu values, state upload/download,
failed operations, resume, pause handling, Save & Quit, and layout without
writing to a user's save library. Real-game compatibility depends on the native
core and is distinct from those frontend integration checks.
