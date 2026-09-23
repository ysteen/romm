# Azahar save states in RomM

Azahar uses the standard EmulatorJS toolbar and RomM state storage. There is no
separate Azahar save panel. The same controls are available in fullscreen.

## Save and restore

- **Save State** captures the running game and uploads it to the signed-in RomM
  user's state library. A successful upload also updates the local latest-state
  cache. Each capture has a unique filename; existing server states are retained.
- **Load State** opens RomM's normal state picker. Choose a compatible state to
  replace the running session. Missing files and states from other cores are not
  offered. A failed download or rejected native restore shows a failure message.
- **Load Latest State** restores the newest available Azahar state from the
  current RomM game record, with the browser cache as a fallback when no server
  state is available.
- **Save & Quit** saves ordinary in-game data and captures a state when the core
  supports it. An upload or capture failure leaves the player open so you can
  retry. Successfully uploaded data remains on the server.
- The player launch page's **States** tab restores the selected state once after
  boot. States also remain available in the game's normal saved-data listing.
- Azahar's configured save/load-state hotkeys and gamepad bindings use the same
  toolbar actions, including the RomM upload and selection dialog.

State capture and restore preserve a paused runtime where applicable. The state
picker resumes play when it closes, following RomM's normal behavior. A missing
preview never discards a valid capture. Concurrent toolbar captures are ignored
until the current upload finishes, and leaving the player cancels pending state
restoration.

## Experimental compatibility

- Keep in-game saves as the durable backup. These are full emulator snapshots,
  not portable game saves. Rewind remains disabled.
- Use the same game, patched Azahar core build, graphics/audio settings, and
  system files. Mii system data is not embedded in a state or the game-save ZIP.
- The core checks the title and upstream core revision before restoration.
  This does not distinguish all local patches made against the same revision;
  keep the exact core artifact when archiving important states.
- Large games may pause briefly during capture/restore. This implementation
  limits frontend state transfers to 256 MiB and native decompression to 512 MiB.
- Invalid/truncated inputs are rejected. A corrupt archive that fails during
  deserialization can still partially change the emulator; restart the game
  before continuing if a restore fails or the screen behaves unexpectedly.
- GPU surface restoration is game-dependent. A successful native return alone
  is not proof that every screen, depth buffer, or game is restored perfectly.
- GPU restoration rebuilds renderer shader caches and can stall or fail. In a
  Mario & Luigi: Dream Team title-screen test, capture took about 0.9 seconds
  and native restoration about 0.7 seconds, but subsequent five-second windows
  measured about 25, 10, and 43 FPS instead of the pre-capture 60 FPS. Both screen
  backgrounds and character colors survived the final PACK-state fix. Keep
  ordinary in-game saves; uninterrupted 60 FPS after restoration is not verified.

## Runtime deployment

The September 22 native fix also handles drivers with zero program binary
formats. The previous shader-cache query passed an empty buffer to Emscripten,
leaving a pending GL error that caused the first state capture to report
`WebGL depth/stencil readback failed` / `Error writing data`. In-game save
uploads could still succeed while state capture failed. The rebuilt core fixes
the invalid query; the frontend continues to report real capture failures and
keep the player open. This fix does not remove shader-compilation stalls when
entering a new map.

Ship the rebuilt `azahar-thread-wasm.data`, matching core report, patched loader,
`emulator.js`, `GameManager.js`, and `azahar-system-data.js` together. The Docker
overlay copies the new system-data helper. The frontend entries and static
GameManager import share runtime revision `20260922.1` to invalidate old scripts.

State controls require the `_load_state_sync` native export. They stay
disabled with older cores. The runtime checks a completed 1/0 return instead of
the upstream queued load API, which cannot report whether restoration succeeded.

Related: [GPU settings and player guide](AZAHAR_PLAYER.md),
[Mii system-data preparation and import](AZAHAR_SYSTEM_DATA.md).

## Checks

```sh
node custom-emulatorjs/tests/azahar-runtime.test.cjs
node custom-emulatorjs/tests/azahar-system-data.test.cjs
cd frontend
npm run test -- --maxWorkers=2
```

Native patches and focused C++/Wasm tests live in the sibling `build` repository;
see its `AZAHAR_SAVESTATES.md`. Browser UI mocks and real-game tests have different
purposes: mocked transfers exercise UI errors/permissions without writing user
states, while an isolated real-core round trip checks emulation compatibility.
