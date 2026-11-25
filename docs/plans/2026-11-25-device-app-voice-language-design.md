# Harness Device: Voice language in the menu

Status: approved (PM, 2026-11-25): all five decisions; the row is absent with no dial, while updating, or with an older firmware. Branch `feat/device-app-voice-language`.

## What and why

Diego: add **Voice language** to the Harness Device menu. People who use the dial without the Harness desktop app
have no way to change the language they speak to it: today the choice exists only in Desktop's Devices pane ("Voice
language", `voiceLang` in the dial's settings, `desktop/lib/devices/device_settings.dart`). This puts the same choice
in the Harness Device menu, on macOS, Windows and Linux.

Done when:

- The Harness Device menu shows a **Voice language** submenu: English, Tiếng Việt, Español, Français, 日本語, Italiano,
  each in its own language, and the one the dial holds is checked.
- Choosing one saves it on the dial, where Desktop saves it. The next utterance is transcribed in that language, with
  no replug.
- The check follows what the dial reports, including a change made from Desktop.

## Scope

- Only `voiceLang`, and only the six codes the backend transcribes: `en`, `vi`, `es`, `fr`, `ja`, `it`. That is
  `VOICE_LANGS` in `backend/src/lib/deepgram.ts`, and the same six Desktop offers.
- No new firmware frame, no new daemon request, nothing in the core. The dial's `settings.set` / `settings.state` and
  the devices service's `harness_device_settings` request already exist. Desktop uses them, and the menu's Sound
  item already uses them through `harness hardware watch`.

## Where it is saved

On the dial itself (its NVS, `settings.voiceLang`), exactly where Desktop's row saves it:

- Desktop sends `harness_device_settings {id, patch: {voiceLang}}` (`cli/src/lib/harnessDevices.ts`
  `deviceSettingsPatchSchema`).
- The devices service sends `settings.set` to the dial.
- The dial states its language on every capture, and the voice router uses it
  (`cli/src/cable/cableSession.ts`, `lang: str('lang') ?? this.host.voiceLang()`). So the next utterance uses the new
  language at once.

Nothing is stored on the computer.

## The menu

| Row | Shown |
|---|---|
| **Voice language** (submenu) | the six languages, the one the dial holds checked; only while Harness runs and the dial is attached, not updating, and reports its settings |

- **Placement:** after Notifications, before the app's update row.
- **Shape:** one native submenu of check items, the menu's shape for a choice among named options
  (`desktop/design/desktop-design-system.md`, as Notifications).
- **Labels:** each language's own name, as Desktop shows them.
- **Absent, not greyed, without a dial.** Covers no dial, a firmware update in progress, a firmware or CLI or daemon
  too old to say. The language lives on the dial, so with no dial there is nowhere to save a choice: the daemon
  answers `DEVICE_OFFLINE`, as Desktop's row is read-only then. The rule "an empty state shows nothing extra" decided
  Sound's row the same way, and the dial line above already says why ("No dial", "Updating device…").
- **A code outside the six** (an older or hand-set value): the submenu shows the six with none checked. Choosing one
  sets it.
- **The check is what the dial reports, never what the app last sent.** A click sends the change, and the check moves
  when the dial's next status says so. A refused or lost change leaves the check where the dial is, and is logged.
- **Copy:** "Voice language", Desktop's row title.

The menu, top to bottom, with a dial attached:

```text
  Device ready
  Signed in
✓ Sound
  Notifications ▸
  Voice language ▸
──────────
  Open Harness
  Export logs
  About
  Quit
```

## Data flow

```
dial ──settings.state──▶ devices ──dial_status──▶ harness hardware watch --json ──{"voiceLang":"vi",…}──▶ app menu
app click ──stdin {"voiceLang":"vi"}──▶ watch ──harness_device_settings {id, patch:{voiceLang}}──▶ devices ──▶ dial
```

### CLI: `harness hardware watch --json` (`cli/src/devices/client.ts`)

- **Out.** `dialWatchLine` adds `"voiceLang": "<code>"` under the same condition as `muted`: the status carries an
  `id` string and a `settings` object whose `voiceLang` is a string. The value must also match the patch schema's
  pattern (`^[a-z]{2}(?:-[A-Z]{2})?$`), so nothing else of the dial's text reaches the app. A change of `voiceLang`
  now prints a line (the dedupe on the whole line stays).
- **In.** A stdin line `{"voiceLang":"<code>"}` does the same as a Sound line, given:
  - exactly that one key;
  - a code from the six.

  It sends `harness_device_settings` with `{ id: <the last status's id>, patch: { voiceLang } }` on the watch's own
  socket. No id or no connection: nothing is sent, and one stderr line says so (`voice: NO_DIAL`,
  `voice: NOT_CONNECTED`). An error reply prints `voice: <code>`.
- **One way to do it.** Sound's in-flight logic (one change in flight, latest wins, a 12 s bound) becomes one helper
  keyed by setting, which Sound and Voice language both use. Each setting has its own slot, so a Sound click never
  waits behind a language change. Its stderr word stays `sound:`.
- `DialWatchDeps.stdin`'s comment lists the new line.

### App (`device-app/src-tauri/`)

- **`types.rs`:**
  - `DialStatus` gains `voice_lang`, which tells three cases apart:
    - absent when the line has no `voiceLang`: no submenu;
    - one of the six: that one checked;
    - present but outside the six: the submenu with none checked.

    It is read leniently, as `notify` is: a value of the wrong type is treated as absent, never as a broken status
    line, which the keep-alive would read as a silent watch.
  - A `VoiceLang` enum of the six, with its code and its own name.
  - `MenuAction` gains `Voice(VoiceLang)`, menu ids `voice_en` … `voice_it`.
- **`model.rs`:** the submenu as above, under `settable` (as Sound and Notifications).
- **`app.rs`:** the menu action becomes `Effect::SetVoice(VoiceLang)`, and the menu is sent again at once, so the
  native check that flipped itself goes back to the dial's.
- **`runner.rs`:** writes the line to the running watch.
- **`watch.rs`:** `Watch::voice` writes one of six fixed lines built in Rust. Nothing from the webview becomes a line
  ("Fixed arguments", `device-app/AGENTS.md`).
- **`main.rs`:** `menu_id` and `menu_action` gain the six ids.
- **Log:** `menu:` lines include `Voice language: Tiếng Việt`, as `Notifications: All`.

## Failure cases

| Case | Seen as |
|---|---|
| No dial, update in progress, firmware without settings, old CLI or daemon | no Voice language row; the dial line says why |
| Dial refuses or the write fails (`DEVICE_OFFLINE`, `DEVICE_UPDATING`, `DEVICE_NOT_READY`, `DEVICE_WRITE_FAILED`) | check stays at the dial's language; watch stderr line `voice: <code>` in the app log |
| Devices service down | `SERVICE_UNAVAILABLE` logged the same way |
| An older CLI | prints no `voiceLang` (no row), and ignores the stdin line |
| Two clicks quickly | latest wins, one request in flight |
| Two dials on one computer | the watch reports the primary status (unchanged); the choice changes that dial, by its id, as Sound |

## Security and data

- No new data is stored or synced. Nothing personal is involved: a language code is not personal content.
- The patch is one of six fixed codes, built in Rust and checked again by the watch before sending.
- The request travels on the existing local, owner-only tool socket.
- No log line carries an id or a payload.

## Tests (red first)

- **CLI** `cli/src/devices/client.spec.ts`:
  - `dialWatchLine` with and without `id` / `settings` / `voiceLang`, and a value off the pattern.
  - A stdin `{"voiceLang":"vi"}` sends exactly one `harness_device_settings` with the last id and `{voiceLang:'vi'}`.
  - `"de"`, a non-string, or a second key sends nothing.
  - Latest wins while one is in flight.
  - Sound and Voice language in flight at once each send theirs.
  - An error reply prints `voice: <code>`.
  - Sound's existing tests still pass on the shared helper.
- **App** `cargo test --lib`:
  - `DialStatus` parses `voiceLang`; an unknown code still parses as a status.
  - `model.rs` shows the submenu for each code with its check, none checked for an unknown code, and no submenu with
    no dial, while updating, or without `voiceLang`.
  - `app.rs`: the menu action yields `SetVoice` and the menu again.
  - `watch.rs`: `voice` writes the fixed line.
  - `main.rs`: the ids round-trip.
- **End to end:** none new. The fake CLI's watch lines carry no `voiceLang`, so the existing e2e menus are unchanged.
  The rule lives in the reducer and the watch, and is tested there.
- **By hand, with a dial (Verification; Ken's machines or Diego's dial, the PM decides):**
  - Choose Tiếng Việt from the menu, speak, and see a Vietnamese transcript.
  - Desktop's row follows, and the reverse.

## Platforms

- **macOS, Windows, Linux:** the menu is built from the shared `model.rs`. Native submenus already draw on all three
  (Notifications).
- **CLI:** the watch change runs wherever the watch runs.
- **Desktop:** unchanged.

## Docs in the same PR

- `docs/plans/2026-11-13-device-menubar-design.md` menu table: the Voice language row.
- `desktop/design/desktop-design-system.md`, Harness Device section: the menu sketch gains `Voice language ▸`. The
  gallery shows only the window's screens, so it does not change.
