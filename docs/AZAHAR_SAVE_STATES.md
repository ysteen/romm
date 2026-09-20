# Azahar manual save states

The v2 EmulatorJS player exposes **Save state**, a saved-state selector, and
**Load state** above an Azahar game. Leave emulator fullscreen (Esc) to access
these controls. Existing in-game saving and Save & Quit continue to handle game
save files separately; Save & Quit does not silently create a 3DS state.

Each manual capture is uploaded to the current RomM user's state storage with
`emulator=azahar` and a unique filename. Existing states are not overwritten. A
preview is optional: screenshot failure does not discard a valid state. Load
requires confirmation because it replaces the running game's progress. Selecting
a state on the pre-launch page restores it once after the core starts.

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

Ship the rebuilt `azahar-thread-wasm.data`, matching core report, patched loader,
`emulator.js`, `GameManager.js`, and `azahar-system-data.js` together. The Docker
overlay copies the new system-data helper. The three frontend entries and static
GameManager import share runtime revision `20260921.2` to invalidate old scripts.

The managed controls require the new `_load_state_sync` native export. They stay
disabled with older cores. The runtime checks a completed 1/0 return instead of
the upstream queued load API, which cannot report whether restoration succeeded.

Related: [Mii system-data preparation and import](AZAHAR_SYSTEM_DATA.md).

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
