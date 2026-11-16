# Harness Device: Sound on/off in the menu — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use diegodev phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Harness Device menu shows one **Sound** check item, checked while the dial's sound is on; a click turns the sound off or on, and the check follows what the dial reports.

**Architecture:**
- **`harness hardware watch --json`** carries both ways. Out: its status line gains `"muted"`. In: a `{"muted":…}` line on its stdin becomes the existing `harness_device_settings` request on the watch's own local tool socket, one in flight, the latest waiting.
- **Harness Device** reads `muted` from the line and draws the row from it (`model.rs`). A click becomes `Effect::SetSound`, which the runner writes on the watch's stdin as fixed text (`Watch::sound`), and the menu is drawn again as it was. The check moves only when the dial's next status line says so.
- **The daemon does not change.** No new request, frame or firmware message. Nothing under `cli/src/core`, `cli/src/services` or `cli/src/cable`.

**Tech Stack:** TypeScript CLI (Node, vitest, `cli/`); Rust and Tauri 2 (`device-app/src-tauri`, `tauri::menu::CheckMenuItem`).

**Spec:** [docs/plans/2026-11-16-device-app-sound-design.md](2026-11-16-device-app-sound-design.md).

## Base

- Branch `feat/device-app-sound`, from `main` at `8fcfa7de5c`.
- Before the first task: `cd cli && npm ci` and `cd device-app/ui && npm ci && npm run build` (neither `node_modules` nor `ui/dist` is in this worktree today; the binary embeds `ui/dist`).
- Tauri's dependencies take minutes to compile: one `CARGO_TARGET_DIR` outside the repository compiles them once (`device-app/AGENTS.md`).
- Tasks name code by name, never by line. If a name below is gone, stop and report.

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/devices/client.ts` | The CLI: `harness hardware watch`, a process Harness Device starts. Not the daemon | `client.spec.ts` (PR CI `cli-tests`) |
| `cli/e2e/hardwareWatch.e2e.ts` | Test: the real daemon, a fake dial, the real watch | By hand on a Mac; the nightly CLI end to end |
| `device-app/src-tauri/src/types.rs`, `model.rs`, `app.rs`, `watch.rs`, `runner.rs`, `cli.rs`, `main.rs` | Harness Device, a process of its own | `cargo test --locked`: PR CI on Linux, macOS by hand |
| `docs/plans/2026-11-13-device-menubar-design.md`, `desktop/design/desktop-design-system.md` | Repo files, no process | none |

No file under `cli/src/core/` changes, and `cli/src/architecture.coreFiles.txt` gains no line (`cli/AGENTS.md`, Protect the core, rule 7).

## Global Constraints

- **Only `muted`.** The dial's `quiet` ("Still companion") is out of scope.
- **The row.** Label `Sound`. One native check item, enabled, checked when `muted` is false. After the Claude Code rows, before the separator. Menu ids `sound_on` and `sound_off`: the item carries the action its click does, `SoundOff` while checked, `SoundOn` while not.
- **Absent, never greyed,** when there is nothing to change: no dial, an update in progress, no `muted` on the watch's line.
- **The check shows what the dial reports,** never what the app last sent.
- **Lines.**
  - Watch stdout: the status line with `"muted":<bool>` last, when the status has an `id` and a `settings` object whose `muted` is a boolean. Otherwise the line is as today. The dedupe on the whole line stays.
  - Watch stdin: `{"muted":true}` or `{"muted":false}`: exactly that key, a boolean.
  - Watch → daemon, on the watch's own socket: `{ type: 'harness_device_settings', payload: { id, patch: { muted }, requestId } }`. The answer is `harness_device_settings_result` under the same `requestId`.
- **One change in flight.** A line read meanwhile replaces the one waiting (latest wins). No answer in 12 s frees the slot.
- **stderr of the watch:** `sound: <CODE>`, one line a failure, never the payload. `CODE` is 1 to 32 characters of `A-Z`, `0-9`, `_`, starting with a letter.
- **Logs.** The app's `menu:` line reads `Sound ✓` or `Sound`. The stdin line is never logged. No log line holds a device id or a payload.
- **`device-app/AGENTS.md`:** thin over the CLI; fixed text built in Rust, nothing from the webview; the watch's stdin is private; one log, redacted; no other component's path in a Rust string (name `cli/…` only in comments).
- **Repo rules.** Tests never touch the developer's daemon (18473), `~/.harness` or dial. No fixed sleeps. Comments say why.
- **Platforms.** Harness Device: macOS, and Linux in CI. The watch: macOS and Linux. Windows: Harness Device is not built there. Desktop is unchanged.

## Review Focus

1. **A second click before the dial has answered.** The check stays where the dial is; one request is in flight and at most one waits; the dial ends at the last click's value. Task 2 (`while one is in flight the latest line waits`), Task 4 (the same click twice gives the same effects twice).
2. **A click as the dial goes away, starts an update, or another dial becomes the primary.** Nothing changes on any other dial, and one log line says why. Task 2 (`a waiting change keeps the dial it was read for`, `with no dial nothing is sent`), Task 3 (no watch running: nothing is written), Task 5 (the absent states).
3. **An error from the daemon that is not a code** (free text, a path, a newline, 200 characters). None of it reaches stderr or the app's log. Task 2 (`a reply that is not ok and names no code prints FAILED`), Task 6 (`logged_stderr`'s refused lines).
4. **A daemon that never answers** (the devices process hung). After 12 s the slot is free, the log says so, and the next click works; a watch that ends meanwhile leaves no timer. Task 2 (`no answer in 12 s`, `stdin closing with a change in flight`).
5. **A CLI older than the app, or a firmware with no settings.** No `muted` on the line: no Sound row, and every other row is as before. Task 5 (`the_sound_row_is_absent_when_there_is_nothing_to_change`; `the_whole_menu` passes unchanged).

## Decided (PM, 2026-11-16)

Not reopened: only `muted`; the row is absent, not greyed; one check item named Sound, not "X: On" with "Turn off"; no new frame or request and nothing in the core; the watch sends `harness_device_settings` on its own tool socket from a stdin line.

## Decided here, where the spec was silent

1. **`Runner` writes the line, not `main.rs`.** The spec says `main.rs` writes to the watch's stdin. The watch is held by `Runner` (`runner.rs`), which runs every effect but `Menu`, `Show` and `Quit`. So `Effect::SetSound` is run there; `main.rs` only draws the check item.
2. **The id is the one of the last status when the line is read,** and a waiting change keeps it. A dial that became the primary meanwhile is never changed by a click made for another.
3. **An empty `id` is no id:** the daemon's request refuses one (`lib/harnessDevices.ts`, `id: z.string().min(1)`).
4. **A reply that is not `ok: true` is a failure,** with or without an `error` string. It prints one `sound:` line.
5. **A status line whose `muted` is not a boolean is no status,** as for `fw` today (`a_status_line_needs_attached`). The watch prints only a boolean.

## Open questions

Answered (PM, 3-minute timeout, 2026-11-16): 1-3 as recommended. 4 waits for Diego; it holds no task, only Verification check 4.

The draft holds the recommended answer to each, so work can start; an answer changes only the named task.

1. **The `sound: <code>` line in the app's log.** The spec's failure table puts it there. Today the app's log carries exactly one line of the watch's stderr (`tabs stream replaced`, `cli.rs` `LOGGED_STDERR`); every other line is outside text and stays out. Task 6 lets one more shape through: `sound: ` and a code of 1 to 32 of `A-Z 0-9 _`. Recommended: yes. Otherwise a refused change is seen nowhere.
2. **The watch's own codes.** The spec gives no words for three lines. Draft: `sound: NOT_CONNECTED` (the daemon has not answered yet), `sound: NO_DIAL` (no id yet), `sound: NO_ANSWER` (12 s), and `sound: FAILED` when the daemon's error is not a code. Recommended: these. Other words change Task 2's table only.
3. **A CLI end-to-end case.** The spec lists unit tests and the check by hand. `cli/AGENTS.md` rule 5 asks an end-to-end test for every user-facing flow. Task 2 adds one case to `cli/e2e/hardwareWatch.e2e.ts` (the real daemon, a fake dial, the real watch); the nightly run then keeps it. Recommended: keep. Dropping it removes Task 2's last test step and Verification check 2's new case.
4. **The check on a dial (Verification 4) cannot be isolated.** It needs the everyday daemon, which is signed in: the dial's port is that daemon's alone on macOS, Desktop reaches no other daemon, and a chime needs a real agent's alert. A Sound change also reaches the owner's other apps through the relay, as Desktop's switch does today. Is this check Diego's own, on his Mac and dial? Recommended: yes, with the orchestrator's grant for the dial; until then it is reported as not verified.

---

### Task 1: The watch's line says `muted`

**Layer:** the CLI's watch. **Depends on:** none. **Effort:** `medium`.

**Red test:** `cli/src/devices/client.spec.ts`, in `describe('harness hardware watch')`.

**Files:**
- Modify: `cli/src/devices/client.ts`
- Test: `cli/src/devices/client.spec.ts`

**Interfaces:**
- Produces: `dialWatchLine(payload: unknown): string`, same signature. The line gains `"muted":<bool>` as its last key when `payload.id` is a non-empty string and `payload.settings` is an object whose `muted` is a boolean. Only the flat (primary) fields are read, never `devices`.

- [ ] **Step 1: Write the failing tests** (statuses sent with the file's `dial(run.socket, …)`):
  - `a status with an id and a boolean muted prints muted last`: `{ attached: true, id: 'usb-1', fw: '0.0.95', settings: { muted: false, brightness: 80 } }` prints `{"attached":true,"fw":"0.0.95","muted":false}`.
  - `only a change of muted prints again`: the same with `brightness: 20` prints nothing; with `muted: true` prints `{"attached":true,"fw":"0.0.95","muted":true}`.
  - `without an id, settings or a boolean muted the line is as before`: no `id`; `id: ''`; no `settings`; `settings: null`; `settings: { muted: 'no' }`; `settings: { brightness: 80 }`; and `devices: [{ id: 'usb-2', settings: { muted: true } }]` beside flat fields with no `settings`. All seven print `{"attached":true,"fw":"0.0.95"}` once in total.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/client.spec.ts -t muted`. Expected: FAIL (the line has no `muted`).
- [ ] **Step 3: Implement.** The comment above `dialWatchLine` now says that a change of any setting but `muted` prints nothing.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/devices/client.spec.ts && npm run typecheck`. Expected: PASS; `prints one line each time the status changes` passes unchanged.
- [ ] **Step 5: Commit** `Harness Device: the watch's line says the dial's sound`.

### Task 2: A `muted` line on stdin changes the dial's sound

**Layer:** the CLI's watch. **Depends on:** Task 1 (the end-to-end case reads `muted` on the watch's line). **Effort:** `xhigh`.

**Red test:** `cli/src/devices/client.spec.ts`, a new `describe('harness hardware watch: Sound')`; and `cli/e2e/hardwareWatch.e2e.ts`, a new `describe`.

**Files:**
- Modify: `cli/src/devices/client.ts`
- Test: `cli/src/devices/client.spec.ts`, `cli/e2e/hardwareWatch.e2e.ts`

**Interfaces:**
- Consumes: Task 1's line (the end-to-end case only).
- Produces, inside `runDialWatch`, nothing exported and no new member of `DialWatchDeps`:
  - A stdin line is a Sound line when it parses to an object with the one key `muted` and a boolean value. It is read before the `front` and `tab` branches; any other line falls through to them as today.
  - The request: `socket.send(JSON.stringify({ type: 'harness_device_settings', payload: { id, patch: { muted }, requestId } }))`, `requestId` from `randomUUID()`. `id` is the `id` of the last `dial_status` when the line is read, when it is a non-empty string.
  - `const SOUND_ANSWER_MS = 12_000` and `const SOUND_CODE = /^[A-Z][A-Z0-9_]{0,31}$/`.
  - Every line below goes through `deps.printError`. Nothing of a reply is ever printed on stdout.

    | When | stderr line | Sent |
    |---|---|---|
    | The line is read before `connected` | `sound: NOT_CONNECTED` | nothing; the line is dropped |
    | The last status has no id | `sound: NO_DIAL` | nothing; the line is dropped |
    | The reply has `ok: true` | none | the waiting change, if any |
    | Any other reply, `error` passes `SOUND_CODE` | `sound: <error>` | the waiting change, if any |
    | Any other reply, `error` missing or not a code | `sound: FAILED` | the waiting change, if any |
    | No reply in `SOUND_ANSWER_MS` | `sound: NO_ANSWER` | the waiting change, if any |
  - A reply under another `requestId`, or after its slot was freed, is ignored.
  - `finish` clears the answer's timer with the others.
  - The comment on `DialWatchDeps.stdin` names the third line.

- [ ] **Step 1: Write the failing unit tests.** Fake timers as the file's other blocks (`vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })`). Helpers: `USB = { attached: true, id: 'usb-1', fw: '0.0.95', settings: { muted: false } }`; `attached()` gives a watch opened, `connected(…, ['dial-watch'])` and sent `USB`; `sound(run, value)` emits `JSON.stringify({ muted: value }) + '\n'` on stdin; `sounds(run)` is the parsed `harness_device_settings` frames of `run.socket.send`; `answer(run, request, reply)` emits `harness_device_settings_result` with that request's `requestId` and `reply`.
  - `a muted line sends one request for the last status's dial`: `sound(run, true)` gives `sounds(run)` equal to `[{ type: 'harness_device_settings', payload: { id: 'usb-1', patch: { muted: true }, requestId: expect.any(String) } }]`. After `answer(…, { ok: true, revision: 3, status: USB })`, a status with `id: 'usb-2'` and `sound(run, false)`: the second names `usb-2` and `{ muted: false }`. `run.errors` is `[]`, and `run.printed` is `['{"attached":true,"fw":"0.0.95","muted":false}']`.
  - `lines that are not exactly one boolean muted send nothing`: `{"muted":"true"}`, `{"muted":1}`, `{"muted":null}`, `{"muted":true,"quiet":true}`, `{"muted":true,"id":"usb-9"}`, `{"patch":{"muted":true}}`, `[{"muted":true}]`, `"muted"`, `{"muted":true`. `sounds(run)` and `run.errors` stay `[]`; the next good line sends one.
  - `while one is in flight the latest line waits, and is sent when the first answers`: `true` (sent), then `false`, `true`, `false`: one request. Answer it: a second, `{ muted: false }`. Answer that: still two.
  - `a waiting change keeps the dial it was read for`: `true` sent; `false` read; a status with `id: 'usb-2'`; answer the first: the second request names `usb-1`.
  - `an error reply is one stderr line with its code, and nothing of the payload`: for each of `DEVICE_OFFLINE`, `DEVICE_UPDATING`, `DEVICE_NOT_READY`, `DEVICE_WRITE_FAILED`, `SERVICE_UNAVAILABLE`, `BAD_DEVICE_SETTINGS`, `OWNER_REQUIRED`, in a watch of its own: a reply `{ error: code, service: 'devices', status: USB }` gives `run.errors` equal to `['sound: ' + code]`, and `run.printed` unchanged.
  - `a reply that is not ok and names no code prints FAILED`: `{ error: 'The device at /dev/cu.usbmodem1 said no\nsound: OK' }`, `{ error: 'x'.repeat(200) }`, `{ error: 'device_offline' }`, `{ error: 5 }`, `{}`, each in a watch of its own, gives `['sound: FAILED']`.
  - `a reply under another request id is not the answer`: it frees nothing (a line read after it still waits: one request) and prints nothing.
  - `before the daemon has answered, or with no dial, nothing is sent and stderr says so`: a line before `connected` gives `['sound: NOT_CONNECTED']`; after `connected` with no status, `sound: NO_DIAL` is added; after `{ attached: false }`, another. `sounds(run)` is `[]`.
  - `no answer in 12 s frees the slot, says so, and sends what waited`: `true` sent, `false` waits; after 11 999 ms `run.errors` is `[]`; 1 ms later it is `['sound: NO_ANSWER']` and the second request is sent. The first's late reply `{ error: 'DEVICE_OFFLINE' }` adds no line.
  - `stdin closing with a change in flight exits 0 and leaves no timer`: `run.done` is `0` and `vi.getTimerCount()` is `0`. The same after `socket.emit('close', 1006, '')`, with exit `3`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/client.spec.ts -t Sound`. Expected: FAIL (no `harness_device_settings` is sent).
- [ ] **Step 3: Write the failing end-to-end case** (open question 3), in `hardwareWatch.e2e.ts`: `describe('harness hardware watch with a dial: Sound')`. The file's `watch` helper also keeps stderr's lines (`errors`). The daemon is `IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })` with a `Desk` on `HARNESSD_TEST_DIAL_PORT`, as `dialAppFilter.e2e.ts`'s `fresh` makes it. One test, `a muted line reaches the dial, and the check's line follows only what the dial says`:
  1. `desk.plug('E2E-A', 'e2:e0:00:00:00:0a')`, start the watch, and wait until its last line's JSON has `muted === false`.
  2. Write `{"muted":true}\n` on the watch's stdin. The dial hears `settings.set` whose keys are `muted` and `t` only, with `muted: true`. The watch's last line still has `muted: false`.
  3. `dial.send({ t: 'settings.state', ok: true, settings: { ...SETTINGS, muted: true } })`. The watch's last line has `muted === true`.
  4. A window as Desktop: `LocalClient.connect(d)`, `request('harness_device_settings', { id: 'E2E-A', patch: { muted: false } })` answers `{ ok: true }`; the dial hears a second `settings.set`, with `muted: false`, and answers `settings.state` with `muted: false`; the watch's last line has `muted === false`.
  5. `desk.unplug('E2E-A')`: the watch's last line is `{"attached":false}`. `{"muted":true}\n` then adds `sound: NO_DIAL` to `errors`, and the dial hears nothing more.

  Each wait is on the last line's value, never on a count of lines: the fake dial greets again every 15 s with the settings it was plugged in with (`muted: false`), which can print a line of its own.
- [ ] **Step 4: Run** `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/hardwareWatch.e2e.ts`. Expected: the new case FAILS at step 2 (no `settings.set`); the three old cases pass.
- [ ] **Step 5: Implement.**
- [ ] **Step 6: Run** steps 2 and 4's commands, then `cd cli && npx vitest run src/devices/client.spec.ts src/architecture.spec.ts && npm run typecheck`. Expected: PASS; `nothing of the app in front goes on the core's socket` and `nothing of a tab goes on the core's socket` pass unchanged.
- [ ] **Step 7: Commit** `Harness Device: a Sound line on the watch's stdin changes the dial`.

### Task 3: `Effect::SetSound` and `Watch::sound`

**Layer:** Harness Device. **Depends on:** none. **Effort:** `high`.

**Red test:** `watch.rs` `a_sound_line_reaches_the_watch`; `runner.rs` `a_sound_change_is_written_to_the_watch`.

**Files:**
- Modify: `device-app/src-tauri/src/types.rs`, `device-app/src-tauri/src/watch.rs`, `device-app/src-tauri/src/runner.rs` (their tests are in the same files)

**Interfaces:**
- Produces:
  - `types.rs`: `Effect::SetSound(bool)`: `true` turns the dial's sound on.
  - `watch.rs`: `pub fn sound(&self, on: bool)`, beside `front` and `tab`, through the same `write`. It writes `{"muted":false}` for `on`, `{"muted":true}` for off: two fixed strings.
  - `runner.rs`, in `Runner::run`: `Effect::SetSound(on)` calls `sound(on)` on the watch running now, on the caller's thread, holding `shared.watch`. With no watch it does nothing. It returns `None` and sends no `Event`.

- [ ] **Step 1: Write the failing tests:**
  - `watch.rs` `a_sound_line_reaches_the_watch`: the script is `{"attached":true}`, `@record`. `watch.sound(false)`, `watch.sound(true)`, `watch.stop()`: `fake.stdin()` is `[r#"{"muted":true}"#, r#"{"muted":false}"#]`. A `sound` after the end adds nothing, and the log is `["harness hardware watch --json: exit 0"]`.
  - `runner.rs` `a_sound_change_is_written_to_the_watch`: `world()`, the `RECORDING` script, `SpawnWatch`. `run(Effect::SetSound(false))` and `run(Effect::SetSound(true))` both give `None`. After `StopWatch`, `w.fake.stdin()` is the same two lines. A `SetSound` with no watch running gives `None` and adds no line. No log line contains `muted`, and `w.rest()` is `[]`.
  - `runner.rs` `the_binary_gets_its_three_effects_back`: `others` gains `Effect::SetSound(true)`.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --locked --lib sound`. Expected: FAIL (no variant `SetSound`, no method `sound`).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd device-app/src-tauri && cargo test --locked`. Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device: a sound change is one fixed line on the watch's stdin`.

### Task 4: A Sound click

**Layer:** Harness Device. **Depends on:** Task 3 (`Effect::SetSound`). **Effort:** `medium`.

**Red test:** `app.rs` `a_sound_click_asks_the_dial_and_draws_the_menu_again`; `main.rs` `every_menu_action_has_its_own_id`.

**Files:**
- Modify: `device-app/src-tauri/src/types.rs`, `device-app/src-tauri/src/app.rs`, `device-app/src-tauri/src/main.rs` (their tests are in the same files)

**Interfaces:**
- Consumes: `Effect::SetSound(bool)` (Task 3).
- Produces:
  - `types.rs`: `MenuAction::SoundOn`, `MenuAction::SoundOff`.
  - `main.rs`: `menu_id` gives `"sound_on"` and `"sound_off"`; `menu_action` finds both.
  - `app.rs`: `Event::Menu(MenuAction::SoundOn)` gives exactly `[Effect::SetSound(true), Effect::Menu(<the last menu sent>)]`, and `SoundOff` the same with `false`. No `menu:` log line, nothing remembered. A native check item flips its own check when clicked: the menu drawn again puts it back to the dial's state.

- [ ] **Step 1: Write the failing tests:**
  - `app.rs`, with a new test helper `menu_of(effects) -> Vec<MenuItem>` (the last `Effect::Menu`'s items): `found()`, a status line with the dial attached, `menu = menu_of(…)`. Then, twice over, for `(SoundOff, false)` and `(SoundOn, true)`: `app.handle(Event::Menu(action))` equals `[Effect::SetSound(on), Effect::Menu(menu.clone())]`.
  - `main.rs`: for each of the eight actions, `menu_action(menu_id(action)) == Some(action)`; the eight ids are distinct; `menu_action("sound")` is `None`.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --locked -- sound_click every_menu_action`. Expected: FAIL (no variant `SoundOn`).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd device-app/src-tauri && cargo test --locked`. Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device: a Sound click asks the dial and leaves the check to it`.

### Task 5: The Sound row

**Layer:** Harness Device. **Depends on:** Task 4 (`MenuAction::SoundOn`, `SoundOff`, and `app.rs`'s click). **Effort:** `high`.

**Red test:** `types.rs` `a_status_line_carries_muted`; `model.rs` `the_sound_row`, `the_sound_row_is_absent_when_there_is_nothing_to_change`, `the_menu_as_a_log_line`; `app.rs` `the_check_follows_the_dial_not_the_click`.

**Files:**
- Modify: `device-app/src-tauri/src/types.rs`, `device-app/src-tauri/src/model.rs`, `device-app/src-tauri/src/main.rs`
- Test only: `device-app/src-tauri/src/app.rs`, `device-app/src-tauri/src/runner.rs`, `device-app/src-tauri/src/watch.rs` (every `DialStatus { … }` there gains `muted: None`; `app.rs`'s `rows` helper reads a check item's label)

**Interfaces:**
- Consumes: `MenuAction::SoundOn`, `SoundOff` (Task 4).
- Produces:
  - `types.rs`: `DialStatus.muted: Option<bool>`; `MenuItem::Check(MenuAction, String, bool)`: the action a click does, the label, whether it is checked.
  - `model.rs` `menu`: after the Claude Code rows and before the separator, when `cli` is `Found`, `daemon` is `Up`, and the dial is attached, has no `updating` and has a `muted`: `Check(SoundOff, "Sound", true)` for `muted == false`, `Check(SoundOn, "Sound", false)` for `muted == true`.
  - `model.rs` `menu_log`: a check item is `Sound ✓` when checked, `Sound` when not.
  - `main.rs` `native_menu`: `CheckMenuItem::with_id(handle, menu_id(*action), text, true, *checked, None::<&str>)`.

- [ ] **Step 1: Write the failing tests:**
  - `types.rs`: `{"attached":true,"muted":true}` parses with `muted: Some(true)`; without the key, `None`; `{"attached":true,"muted":"yes"}` is no status.
  - `model.rs` `the_sound_row`, with `sound(muted) = DialStatus { muted, ..dial(true, Some("0.0.95")) }`: with `Some(false)` the whole menu is `Dial connected · 0.0.95`, `Signed in`, `Claude Code: On`, `Turn off`, `Check(SoundOff, "Sound", true)`, the separator, `Open Harness`, `Quit`. With `Some(true)` the fifth row is `Check(SoundOn, "Sound", false)`. With `signed_in: None` and `claude: None` the check item is the second row.
  - `model.rs` `the_sound_row_is_absent_when_there_is_nothing_to_change`: no item is a `Check` for `dial: None`; `sound(None)`; `attached: false` with `muted: Some(false)`; `updating: Some("0.0.96")` with `muted: Some(false)`; `daemon` `Starting`, `Stopped`, `Updating` with `sound(Some(false))`; `cli` `Removed`, `Installing`, `InstallFailed` with `sound(Some(false))`.
  - `model.rs` `the_menu_as_a_log_line` also gives `Dial connected · 0.0.95 | Signed in | Claude Code: On | Turn off | Sound ✓ | Open Harness | Quit` for `Some(false)`, and the same with `Sound` for `Some(true)`.
  - `app.rs` `the_check_follows_the_dial_not_the_click`: `found()`; a line with `fw: "0.0.95"` and `muted: Some(false)` gives a menu holding `Check(SoundOff, "Sound", true)` and the log `menu: Dial connected · 0.0.95 | Sound ✓ | Quit`. `Event::Menu(SoundOff)` gives a menu that still holds it, and no `menu:` line. A line with `muted: Some(true)` gives `Check(SoundOn, "Sound", false)` and `menu: Dial connected · 0.0.95 | Sound | Quit`. `Event::WatchExit(Some(3))` gives a menu with no `Check`.
  - `watch.rs` `a_line_each_time_the_dial_changes`: the attached line gains `"muted":true`, and its event has `muted: Some(true)`.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --locked --lib`. Expected: FAIL (no field `muted`, no variant `Check`).
- [ ] **Step 3: Implement.** `model.rs`'s `the_whole_menu` passes unchanged: its dial has no `muted`.
- [ ] **Step 4: Run** `cd device-app/src-tauri && cargo test --locked`. Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device: the Sound row, checked while the dial's sound is on`.

### Task 6: A `sound:` line of the watch reaches the log

**Layer:** Harness Device. **Depends on:** none. **Effort:** `xhigh`. Open question 1.

**Red test:** `cli.rs` `only_two_shapes_of_stderr_are_logged_as_they_come`, `a_watch_logs_a_sound_code_as_it_comes_and_no_other_stderr`.

**Files:**
- Modify: `device-app/src-tauri/src/cli.rs` (its tests are in the same file)

**Interfaces:**
- Produces, private to `cli.rs`:
  - `const SOUND_STDERR: &str = "sound: "` and `const SOUND_CODE_MAX: usize = 32`.
  - `fn logged_stderr(line: &[u8]) -> bool`: true for `tabs stream replaced` exactly, and for `sound: ` followed by a code as Task 2 prints it: 1 to 32 bytes, the first `A-Z`, the rest `A-Z`, `0-9` or `_`. Nothing else.
  - `fn tail(stream, done, logged: impl Fn(&str) + Send + 'static) -> Tail`: `logged` is handed each whole line that passes `logged_stderr`. The line so far is held to one byte past the longest such line (40 bytes), as today.
  - `Child::start` logs `"{name}: {line}"`. `run` passes a `logged` that does nothing, as today.
  - The comment on `LOGGED_STDERR` names both shapes and says every other line stays out of the log.

- [ ] **Step 1: Write the failing tests:**
  - `only_two_shapes_of_stderr_are_logged_as_they_come`. True: `tabs stream replaced`, `sound: DEVICE_OFFLINE`, `sound: NO_DIAL`, `sound: A`, `sound: E2E_9`, `sound: ` and 32 `A`s. False: an empty line, `sound: `, `sound:NO_DIAL`, ` sound: NO_DIAL`, `sound: NO_DIAL ` (a trailing space), `sound: device_offline`, `sound: DEVICE OFFLINE`, `sound: 9A`, `sound: _A`, `sound: /Users/person`, `sound: person@example.com`, `sound: ` and 33 `A`s, `tabs stream replaced!`, and the bytes `sound: \xff`.
  - `a_watch_logs_a_sound_code_as_it_comes_and_no_other_stderr`: the fake prints `@err sound: DEVICE_OFFLINE`, `@err sound: /Users/person/x`, `@err sound: no dial`, `started`, `@hang`. After a kill the log is `["harness hardware watch --json: sound: DEVICE_OFFLINE", "harness hardware watch --json: killed by a signal"]`.
  - `the_replaced_line_is_found_across_reads_and_only_whole`: the callback sends its line; the chunks `sound: DEVICE_` then `OFFLINE\n` say `sound: DEVICE_OFFLINE` once.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --locked --lib stderr`. Expected: FAIL (no function `logged_stderr`).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd device-app/src-tauri && cargo test --locked --lib cli::`. Expected: PASS; `a_watch_logs_its_replaced_stream_as_it_comes_and_no_other_stderr` passes unchanged.
- [ ] **Step 5: Commit** `Harness Device: the log carries the watch's sound: code, and no other stderr`.

### Task 7: The docs

**Layer:** repo files. **Depends on:** none. **Effort:** `medium`.

**Red test:** none: no behavior.

**Files:**
- Modify: `docs/plans/2026-11-13-device-menubar-design.md`, `desktop/design/desktop-design-system.md`

- [ ] **Step 1:** In the menubar design's `### Menu` table, between the `Claude Code` row and the `separator` row, add:
  `| **Sound** (check item) | only while the dial is attached, not updating, and reports its settings; checked when the dial's sound is on ([design](2026-11-16-device-app-sound-design.md)) |`
- [ ] **Step 2:** In the design system's `## Harness Device` section, add one bullet after the menu-bar icon's:
  `- An on/off setting in the menu is one native check item: one row, its state in the check, a label that never changes. Sound is the first.`
  The gallery does not change: it shows only the window's screens.
- [ ] **Step 3: Commit** `Harness Device: the Sound row in the menu's design`.

## Verification

**Platforms the pull request names:** Harness Device on macOS (tested: the suites and check 3 on this Mac; check 4 on a dial) and Linux (PR CI compiles and tests it). The watch on macOS and Linux (PR CI's unit suites on Linux; check 2 on this Mac and on Linux runners). Windows: Harness Device is not built there, and no workflow runs these specs there: reported as not run. Desktop: no code changes.

**Temporary workflow:** none. No check here is long: the suites take minutes, the one end-to-end file about a minute, and checks 3 and 4 need a Mac session or a dial.

**Workflows:** none changes. The new end-to-end case is in a file the nightly CLI end to end run already takes.

**Turns.** The tester asks the orchestrator before the one hand-started GitHub run (check 2). Check 4 waits for the orchestrator's grant of the dial and for open question 4.

**The pull request also says:** nothing under `cli/src/core`, `cli/src/services` or `cli/src/cable` changes; the app's log lets through one more shape of the watch's stderr (Task 6); screenshots of the menu with Sound checked and unchecked (check 3).

**Local gates,** recorded in the pull request (PR CI does not run them):
- `(cd device-app/ui && npm ci && npm run build) && cd device-app/src-tauri && cargo test --locked`, on a Mac. PR CI's `device-app-checks` runs the same command on Linux only, where the macOS code is not compiled (`docs/validation-and-release.md`, "Harness Device on macOS").
- `cd cli && npm ci && npm run typecheck && npx vitest run src/devices/client.spec.ts src/architecture.spec.ts`. PR CI runs both too (`cli-typecheck`, `cli-tests`).
- `git diff --stat 8fcfa7de5c -- cli/src/core cli/src/services cli/src/harnessd cli/src/architecture.coreFiles.txt` prints nothing. So `npm run test:core` and `npm run test:harnessd` are not needed. If it prints a line, the branch broke its own rule: stop and report.
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit. `--list` names no check for this plan's paths today (`{}`); paste what it prints.
- Not needed: the serial and PTY specs, `make desktop-test`, `make device-test`. `desktop-tests` runs in PR CI by itself, as one doc under `desktop/` changes.

**1. In PR CI, nothing started by hand:** `cli-typecheck` and `cli-tests` run Tasks 1 and 2's unit tests on Linux; `device-app-checks` compiles Harness Device and runs Tasks 3 to 6's tests on Linux.

**2. The real daemon, a fake dial, the real watch**
- Run, on this Mac, at the final head: `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/hardwareWatch.e2e.ts e2e/dialAppFilter.e2e.ts e2e/dialPaneFollow.e2e.ts e2e/dialClaudeAppFollow.e2e.ts e2e/dialTerminalFollow.e2e.ts`. The first holds the new case; the other four start the same watch.
- Isolation (`cli/AGENTS.md` rule 6): the suite's own `IsolatedDaemon` (`e2e/harness/daemon.ts`). A throwaway home, data folder, auth folder and computer id, its own port and tmux server, fake engines, no hook outside its root, signed out, the backend at `127.0.0.1:9`, no firmware push. The dial is a fake on a pseudo-terminal (`HARNESSD_TEST_DIAL_PORT`). The everyday daemon (18473), `~/.harness`, a real dial, Desktop and production are not touched.
- A person sees: every test passes. In the new case the fake dial is sent `settings.set` with `muted` alone, the watch's line changes only after the dial's `settings.state`, a window's change reaches the watch's line too, and `sound: NO_DIAL` is on stderr after the unplug.
- On GitHub, by hand, once at the final head: Actions → CLI end to end → Run workflow, branch `feat/device-app-sound` (`.github/workflows/cli-e2e.yml`). Eight Linux shards; every shard passes. Report the run link.

**3. The real app against the fake CLI: the native check item**
- Why by hand: the native menu needs a Mac session. Nothing here reaches a daemon or a dial.
- Build, at the final head: `(cd device-app/ui && npm ci && npm run build) && (cd device-app/src-tauri && cargo build --locked)`. The app is the unbundled debug binary, `device-app/src-tauri/target/debug/harness-device`: never installed, no login item.
- Isolation: the recipe of `docs/plans/2026-11-13-device-menubar-plan.md` (Verification, "Isolation"), unchanged: a throwaway `$T` with its own home (`HOME` and `CFFIXED_USER_HOME`), a `PATH` of stubs (`open` and `curl` only record), `FAKE_HARNESS="$T/fake"`. `state.json` there has every flag true, so the app asks macOS for no login item and opens no window. The released Harness Device, if it runs, is left alone: this one talks to no daemon.
- Scripts in `$T/fake`: `auth_status_--json` holds `{"loggedIn":true}`; no Claude Code script; `hardware_watch_--json` holds, a line each:
  `{"attached":true,"fw":"0.0.95","muted":false}`, `@wait off`, `{"attached":true,"fw":"0.0.95","muted":true}`, `@wait on`, `{"attached":true,"fw":"0.0.95","muted":false}`, `@wait updating`, `{"attached":true,"fw":"0.0.95","updating":"0.0.96","muted":false}`, `@wait old`, `{"attached":true,"fw":"0.0.95"}`, `@wait none`, `{"attached":false}`, `@record`.
- Run, in the isolated shell: `HARNESS_DEVICE_CLI="$PWD/device-app/src-tauri/tests/fake-harness" device-app/src-tauri/target/debug/harness-device &`
- A person does and sees:
  1. The menu reads `Dial connected · 0.0.95`, `Signed in`, `Sound` with a check mark, a separator, `Open Harness` (when Desktop is installed), `Quit`. One Sound row; no "Turn off" beside it. Screenshot.
  2. Click Sound. Open the menu again: still checked. `touch "$T/fake/off"`: within a second it is unchecked, and still reads `Sound`. Screenshot.
  3. Click Sound. Open the menu again: still unchecked. `touch "$T/fake/on"`: checked.
  4. `touch "$T/fake/updating"`: `Updating to 0.0.96`, no Sound row. `touch "$T/fake/old"`: `Dial connected · 0.0.95`, no Sound row. `touch "$T/fake/none"`: `No dial`, no Sound row.
  5. Quit from the menu. `grep muted "$T/fake/stdin.log"` prints `{"muted":true}`, then `{"muted":false}`, and no other line. The log, `$T/home/Library/Logs/ai.autonomous.harness.device/app-*.log`, has `menu:` lines with `Sound ✓` and with `Sound`, and no line with `muted`.
- Afterwards: `rm -rf "$T"` (its `stdin.log` also holds which apps were in front; quote only the `muted` lines).
- Not done, for whatever reason: report it as not verified, never as passed.
- On GitHub: none. It needs a Mac session and a person's eyes on a native menu.

**4. On a dial: the chime, and Desktop's switch** (open question 4)
- When: after the orchestrator grants the dial, at the final head.
- Where: a Mac with the round dial on USB, its everyday Harness daemon running, Harness Desktop open on Devices, and the released Harness Device quit for the check (two would run two watches).
- Why not an isolated daemon, as checks 2 and 3 use:
  - On macOS the dial's port is exclusive (`cli/src/cable/serial.ts`): the everyday daemon holds it, and a second daemon gets no dial unless the first is stopped.
  - Desktop reaches only the everyday daemon's socket, so "Desktop's switch follows" can be seen nowhere else.
  - The chime plays for a real agent's alert, which an isolated, signed-out daemon has none of.
- What is isolated: the daemon and the installed CLI are not replaced, and nothing is installed. The daemon needs no change for this feature. Harness Device is the debug binary from the worktree, with its state and log in a throwaway home. The CLI it runs is this branch's bundle, through a launcher named by `HARNESS_DEVICE_CLI`.
- What is not isolated: the everyday daemon, as a client of its local socket (the watch, `auth status`, `device claude status`); the dial, whose saved sound setting is changed and put back; and the account: the daemon tells the owner's other signed-in apps the dial's new setting through the relay, exactly as when Desktop's switch is flipped. The check itself calls no backend.
- Build:
  ```bash
  T="$(mktemp -d /tmp/hds.XXXXXX)"; mkdir -p "$T/cli" "$T/home/Library/Application Support/ai.autonomous.harness.device"
  (cd cli && npm ci && BUNDLE_OUT_DIR="$T/cli" node build-bundle.mjs)
  (cd device-app/ui && npm ci && npm run build) && (cd device-app/src-tauri && cargo build --locked)
  printf '{"version":1,"cliSeen":true,"askedSignIn":true,"askedClaude":true,"loginItem":true}\n' \
    > "$T/home/Library/Application Support/ai.autonomous.harness.device/state.json"
  # The CLI runs as the person, so the watch finds the everyday daemon; the app's own state and log stay in $T.
  printf '#!/bin/sh\nHOME="%s" exec "%s" "%s/cli/cli.js" "$@"\n' "$HOME" "$(command -v node)" "$T" > "$T/harness"
  chmod +x "$T/harness"
  harness status      # the daemon runs; if not, stop here
  HOME="$T/home" CFFIXED_USER_HOME="$T/home" HARNESS_DEVICE_CLI="$T/harness" device-app/src-tauri/target/debug/harness-device &
  ```
- Keep Harness Desktop running throughout: the app then never starts a daemon itself. If the menu ever reads `Starting Harness` or `Updating Harness`, quit the debug app at once and report. Click nothing in its menu but Sound and Quit. If macOS asks to let it control Terminal, decline.
- An alert, below, is a harness the dial is not showing that finishes a turn or asks a question (the firmware's chime: `cable_client.c`, `audio_notify_done`).
- A person does and sees:
  1. Note Desktop ▸ Devices ▸ Sound for this dial, to put back. The menu's Sound is checked exactly when that switch is on. Turn it on if it is off.
  2. With Sound on, an alert: the chime is heard.
  3. Click Sound in the menu. Within about a second the check clears and Desktop's switch turns off.
  4. Wait 30 s (the dial plays at most one chime in 30 s), then an alert: the dial shows it, with no chime.
  5. Click Sound again: the check and Desktop's switch are back on. After 30 s, an alert: the chime is heard.
  6. The reverse: turn Desktop's switch off, then on. The menu's check follows each time within about a second, with no click in the menu.
  7. Unplug the dial: `No dial`, no Sound row. Plug it in: the row is back, with the dial's state.
- Evidence: the `menu:` lines of `$T/home/Library/Logs/ai.autonomous.harness.device/app-*.log` (`Sound ✓`, `Sound`), with no `sound:` line and no device id; a screenshot of the menu beside Desktop's switch in each state.
- Afterwards: Quit the debug app from its menu; put Sound back as noted; start the released Harness Device again if it ran; `rm -rf "$T"`.
- Not done, for whatever reason: report it as not verified, never as passed.
- On GitHub: none. It needs a dial, its speaker and a person's ears.
