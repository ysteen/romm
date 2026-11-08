# Multiplayer player guide

Server operators should use [the independent installation guide](NETPLAY_INSTALL.md).
Core versions and supported configurations are listed in [NETPLAY_BRIDGE.md](NETPLAY_BRIDGE.md).

## Create and join a room

1. Sign in to RomM and use the v2 interface. Open your game and choose the save
   to continue, or fresh start, before opening Relay server.
2. Create a room, allow native clients if needed, and optionally set a room
   password. Share the room invitation separately from that password. Each
   participant needs their own authorized RomM account.
3. Guests select a room from the list. For GB/GBC and GBA they bring the cartridge
   chosen on their game page. The room displays the host and every player's
   cartridge title; it has no second cartridge picker.
4. Everyone initially has no number. Guests can select only their own number;
   the host can assign any participant. Numbers must be unique.
5. Select Web browser or Windows RetroArch, then Join game. Choosing a number
   does not start a game. Once everyone is assigned and ready, the host selects
   Start game.

A blank room password is supported. The invitation does not contain that password
or the server service token and does not bypass RomM permissions. Hosts can remove
participants; removed accounts cannot rejoin that room.

## Windows first-time setup

Download the launcher from Windows launcher & core setup in the room. Extract
it to a folder you will keep, then run `Register Launcher.cmd` once. No
administrator rights are required. In the room select Windows RetroArch and
Join game, and allow the browser to open the registered application.

The launcher finds a matching installed RetroArch or downloads a portable copy.
It automatically sets up the correct DLL and `.info`, ordered cartridges,
selected saves and isolated settings. Manual core installation is optional.
The existing application and its normal settings are preserved. Match the
platform selector to the installed application's architecture; Windows ARM64
requires a matching application or a selected x64 runtime.

SameBoy and mGBA show only your assigned screen and audio. A blank screen with
silence while waiting for host Start is normal. Keep the room page open while
playing: the server associates its membership with your native client.

Launcher script updates require downloading the replacement and running
`Register Launcher.cmd` again once. Core updates are downloaded automatically
by checksum on later launches. A publicly trusted server certificate needs no
extra installation; a private CA must also be trusted by Windows PowerShell.
A browser certificate exception alone is insufficient.

Do not manually connect using the invitation password. Account-bound native
rooms issue personal credentials through the launcher. The public RetroArch
lobby is not involved. Available Android core downloads are not an implemented
Android launcher/admission workflow.

## During play, leaving and rejoining

For web play, EmulatorJS's Netplay button opens the room panel in the game page.
The panel shows player numbers and live RTT beside names. Return to game or
Escape resumes the game display; input stays neutral while the room is open.
Windows players see the same room information in their retained browser page.
RTT is network round-trip time, not total input-to-screen latency.

Save and return to room closes only the web game. Closing RetroArch also retains
room membership. Choose a client and Join game again to resume. A compatible
client can load current state from a surviving playing replica; the host need
not restart. Rejoin restores current game progress, not the newly selected
starting save. If every running replica has closed, a live resume source may
no longer exist; use room preparation to start another game.

Leaving the room, navigating away or closing its page disconnects that
participant and their emulated link cable. Others continue. Host controls prefer
another playing RetroArch, then a playing browser. An idle newcomer does not
replace the active state source. Explicit compatible rejoin reconnects the cable
after synchronization. Another account cannot inherit a previous participant's
live console simply by choosing that number.

Different GB/GBC or GBA cartridges may wait in a room for host moderation. They
are applied when the host prepares a new game, not inserted into an active
replica. The host chooses Prepare new game, participants select clients and
Join game again, and the host selects Start game.

## Saves and sound

The selected in-game save is imported into its assigned console during initial
setup. A fresh start imports none. SNES shares one console and starts with the
host's save. Save states from a different single-player core are not directly
portable; load one in single-player first, then carry its battery save.

The server periodically records progress and synchronizes each original
account's cartridge save, including native-only rooms. The original source save
is retained; room saves appear separately for later selection. Web Sync or Save
and return to room requests an immediate flush. Abruptly closing every client
can lose changes since the last received snapshot. Administrators can retry
pending saves after resolving storage or permission errors.

Every rollback replica holds the complete ordered cartridge set and its state.
Account ownership limits admission and save distribution; it does not hide one
console's emulated memory from other running replicas.

Rollback replay suppresses duplicate audio output. Short prediction corrections,
low FPS and network stalls can still cause audio artifacts; already played audio
cannot be undone. Report whether the problem occurs in web, Windows or both,
with the room time and visible RTT so server diagnostics can be correlated.

## Common problems

| Problem                          | Next step                                                                                                             |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Core does not support netplay    | Download/register the latest launcher and use Join game. It supplies matching DLL and deterministic `.info`.          |
| Windows ROM download failed      | Check certificate trust, public address and whether room preparation expired. Cancel preparation and Join game again. |
| Windows waits on black           | Ensure everyone has a unique number and has selected Join game, then host Start.                                      |
| Two screens on Windows           | Use the room launcher and its current core. Manual launches retain normal composite options.                          |
| Wrong cartridge                  | Check the room's cartridge labels; prepare a new game to apply changes.                                               |
| Connection ends when page closes | Keep the room page open for Windows; page closure intentionally leaves membership.                                    |
| Measuring RTT indefinitely       | Check client connection and proxy/network logs; this is not a successful latency measurement.                         |
| Game/save mismatch on rejoin     | A live rejoin preserves the running state. Choose a new starting save before a new game.                              |

Older plans and exact historical test records remain in
[the archived room notes](history/ROLLBACK_ROOMS_2026-11-07.md).
