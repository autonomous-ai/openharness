# Harness Device: Sound on/off in the menu

Status: approved (PM, 3-minute timeout, 2026-11-16): the row is absent, not greyed, when there is nothing to change; one check item. Branch `feat/device-app-sound`.

## What and why

Diego: "đưa setting on/off sound vô app Harness Device". People who use the dial without the Harness desktop app have no
way to silence its chime today: the switch exists only in Desktop's Devices pane ("Sound", `muted` in the dial's
settings). This puts the same switch in the Harness Device menu.

Done when: the Harness Device menu shows a **Sound** item, checked while the dial's sound is on; clicking it turns the
dial's sound off or on; the check follows what the dial reports, including a change made from Desktop or on the dial.

## Scope

- Only `muted`. The dial's `quiet` is a different setting: Desktop calls it **Still companion** ("Stops the artwork
  animating. Nothing else changes.", `desktop/lib/devices/device_settings.dart`). It makes no sound, so it is not part of
  this item.
- No new firmware frame, no new daemon request, nothing in the core. The dial's `settings.set` / `settings.state`
  and the devices service's `harness_device_settings` request already exist and are what Desktop uses.

## The menu

| Row | Shown |
|---|---|
| Dial line | unchanged |
| **Sound** (check item) | only while Harness runs and the dial is attached, not updating, and reports its settings; checked when `muted` is false |

Placed after the Claude Code rows, before the separator. One native check item (Tauri `CheckMenuItem`), the macOS way
to show an on/off menu setting: one row, its state in the check, the label never changes. The existing "Claude Code:
On" + "Turn off" pattern is not reused: a second "Turn off" row would make two identical buttons in one menu.

Absent rather than greyed when there is nothing to change (no dial, an older firmware that reports no settings, an
update in progress, a CLI or daemon too old to say): the product rule "an empty state shows nothing extra", as the
Claude Code rows already do. The dial line above it already says why ("No dial", "Updating to X").

The check shows what the dial **reports**, never what the app last sent: a click sends the change and the check moves
when the dial's next status says so (well under a second on a connected dial). A refused or lost change leaves the
check where the dial is, and is logged.

Copy: "Sound", the same word as Desktop's row (docs/naming-system.md: the hardware is "the dial"; the item needs no
noun).

## Data flow

```
dial ──settings.state──▶ devices service ──dial_status──▶ harness hardware watch --json ──line {"muted":…}──▶ app menu
app click ──stdin {"muted":true}──▶ watch ──harness_device_settings {id, patch:{muted}}──▶ devices ──settings.set──▶ dial
```

### CLI: `harness hardware watch --json` (`cli/src/devices/client.ts`)

- **Out.** `dialWatchLine` adds `"muted": <bool>` when the status carries an `id` string and a `settings` object
  whose `muted` is a boolean. Otherwise the line is as today. A change of `muted` now prints a line (the dedupe on the
  whole line stays); no other setting does.
- **In.** A stdin line `{"muted":true}` or `{"muted":false}` (exactly that key, a boolean) sends
  `harness_device_settings` with `{ id: <the last status's id>, patch: { muted } }` on the watch's own socket, with a
  `requestId`. No id yet, or the socket not connected: nothing is sent, one stderr line says so. The
  `harness_device_settings_result` reply is read: an `error` prints one stderr line (`sound: <error code>`), never the
  payload. The watch does not print a status from the reply; the device's own `settings.state` arrives as the next
  `dial_status`, as it does for Desktop.
- At most one change in flight: a line that arrives while one is in flight replaces the pending value and is sent when
  the first answers (latest wins), so fast clicks never queue up. A reply that does not come in 12 s (the
  `deviceRequest` bound) frees the slot with a stderr line.
- The socket is a local tool connection of this computer's owner, so the devices service's owner check passes as it
  does for `harness hardware set`. No sign-in is needed: the watch already knows this computer's machine id.
- An older app never writes the line; an older daemon without the devices service answers `SERVICE_UNAVAILABLE`,
  logged like any error.

### App (`device-app/src-tauri/`)

- `types.rs`: `DialStatus` gains `muted: Option<bool>`; `MenuAction` gains `SoundOn` and `SoundOff` (ids `sound_on`,
  `sound_off`); `MenuItem` gains `Check(MenuAction, String, bool)`. The Sound item carries the action its click does:
  `SoundOff` while checked, `SoundOn` while not.
- `model.rs`: the Sound row as above.
- `app.rs`: the menu action becomes `Effect::SetSound(on)`; `runner.rs` writes `{"muted":<!on>}` to the running watch's
  stdin (`Watch::sound`, beside `front` and `tab`). Fixed text built in Rust; nothing from the webview.
- `main.rs`: `native_menu` draws `MenuItem::Check` as a `CheckMenuItem`, enabled, with the menu id of its action.
  A native check item flips its own check when clicked; the app redraws the menu from its state right after a Sound
  click (`app.rs` emits the menu again), so the check shows the dial's state until the dial reports the change.
- Log: `menu:` lines include `Sound` / `Sound ✓` so a support log shows the state; the stdin line itself is not logged
  (nothing private in it, but the watch's stdin is not logged by rule).

## Failure cases

| Case | Seen as |
|---|---|
| No dial, update in progress, firmware without settings, old CLI or daemon | no Sound row; the dial line says why |
| Dial refuses or the write fails (`DEVICE_OFFLINE`, `DEVICE_UPDATING`, `DEVICE_NOT_READY`, `DEVICE_WRITE_FAILED`) | check stays at the dial's state; watch stderr line `sound: <code>` in the app log |
| Devices service down | `SERVICE_UNAVAILABLE` logged the same way |
| Watch restarted mid-change | the change is lost; the check shows the dial's state from the new watch's first line |
| Two clicks quickly | latest wins, one request in flight |
| Two dials on one computer | the watch reports the primary status (unchanged); Sound changes that dial, by its id |

## Security and data

No new data stored or synced. The patch is one boolean built in Rust; the watch checks it before sending. The request
travels on the existing local, owner-only tool socket. No log line carries an id or payload.

## Tests (red first)

- CLI `cli/src/devices/*.spec.ts`: `dialWatchLine` with and without `id`/`settings`/`muted`; a stdin `{"muted":…}`
  sends exactly one `harness_device_settings` with the last id; malformed lines send nothing; latest-wins while in
  flight; an error reply prints one stderr line.
- App `cargo test --lib`: `DialStatus` parses `muted`; `model.rs` every Sound state (shown checked, unchecked; absent
  for no dial, updating, no `muted`); `app.rs` the menu action yields `SetSound`; `watch.rs` `sound` writes the line.
- By hand on a Mac with a dial (Verification): toggle from the menu, hear/not hear the chime, see Desktop's switch
  follow, and the reverse.

## Platforms

Harness Device runs on macOS (Linux builds in CI). The CLI change runs wherever the watch runs (macOS, Linux; the app
is not built for Windows). Desktop is unchanged.

## Docs in the same PR

- `docs/plans/2026-11-13-device-menubar-design.md` menu table: the Sound row.
- `desktop/design/desktop-design-system.md`, Harness Device section: the native menu's check item. The gallery shows
  only the window's screens, so it does not change.
