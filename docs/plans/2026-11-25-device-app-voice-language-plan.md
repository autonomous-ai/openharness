# Harness Device: Voice language in the menu — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Harness Device menu shows a **Voice language** submenu of six languages, each in its own name, the one the dial holds checked; a click saves the choice on the dial, and the check follows what the dial reports.

**Architecture:**
- **`harness hardware watch --json`** carries both ways, as it does for Sound. Out: its status line gains `"voiceLang"`. In: a `{"voiceLang":…}` line on its stdin becomes the existing `harness_device_settings` request on the watch's own tool socket. Sound's in-flight logic becomes one helper with a slot per setting, which Sound and Voice language both use.
- **Harness Device** reads `voiceLang` from the line and draws the submenu from it (`model.rs`). A click becomes `Effect::SetVoice`, which the runner writes on the watch's stdin as fixed text (`Watch::voice`), and the menu is drawn again as it was. The check moves only when the dial's next status line says so.
- **The daemon does not change.** No new request, frame or firmware message.

**Tech Stack:** TypeScript CLI (Node, vitest, zod 4, `cli/`); Rust and Tauri 2 (`device-app/src-tauri`, `tauri::menu::{Submenu, CheckMenuItem}`).

**Spec:** [docs/plans/2026-11-25-device-app-voice-language-design.md](2026-11-25-device-app-voice-language-design.md). Precedent, through the same files: [the Sound design](2026-11-16-device-app-sound-design.md) and [its plan](2026-11-16-device-app-sound-plan.md).

## Base

- Branch `feat/device-app-voice-language`, from `main` at `0a4f7cf05a`.
- Before the first task: `cd cli && npm ci`, and `cd device-app/ui && npm ci && npm run build`. Neither `node_modules` nor `ui/dist` is in this worktree. `cargo test --lib` needs no `ui/dist`, but `main.rs`'s tests (`--bin harness-device`) and a full `cargo test` embed it.
- Every cargo command runs with `CARGO_TARGET_DIR=~/.cache/harness-device-target`, so Tauri compiles once (`device-app/AGENTS.md`). Below, `cargo test` means `CARGO_TARGET_DIR=~/.cache/harness-device-target cargo test --locked`.
- Tasks name code by name, never by line. If a name below is gone, stop and report.

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/devices/client.ts` | The CLI: `harness hardware watch`, a process Harness Device starts. Not the daemon | `client.spec.ts` (PR CI `cli-tests`) |
| `cli/e2e/hardwareWatch.e2e.ts` | The real daemon on a throwaway home, a fake dial, the real watch | PR CI `linux-e2e`, because the pull request modifies the file |
| `device-app/src-tauri/src/types.rs`, `model.rs`, `app.rs`, `watch.rs`, `runner.rs`, `cli.rs`, `main.rs`, `parity.rs` | Harness Device, a process of its own | `cargo test`: PR CI on Linux (all) and Windows (`--lib`), macOS by hand |
| `docs/plans/2026-11-13-device-menubar-design.md`, `desktop/design/desktop-design-system.md` | Repo files, no process | none |

No file under `cli/src/core/`, `cli/src/services/`, `cli/src/harnessd/` or `cli/src/cable/` changes, and `cli/src/architecture.coreFiles.txt` gains no line (`cli/AGENTS.md`, Protect the core).

## Global Constraints

- **Only `voiceLang`.** The six codes and their names, in this order: `en` English, `vi` Tiếng Việt, `es` Español, `fr` Français, `ja` 日本語, `it` Italiano.
- **The row.** Label `Voice language`. One native submenu of six check items, all enabled. After Notifications, before the app's update row. Menu ids `voice_en`, `voice_vi`, `voice_es`, `voice_fr`, `voice_ja`, `voice_it`.
- **Absent, never greyed,** when there is nothing to change: no CLI found, Harness not up, no dial, a dial not attached, an update in progress, no `voiceLang` on the watch's line.
- **A code outside the six** on the line: the six, none checked. A click on one sets it.
- **The check shows what the dial reports,** never what the app last sent.
- **Lines.**
  - Watch stdout: `"voiceLang":"<code>"` after `muted` and before `notify`, when the status has a non-empty string `id` and a `settings` object whose `voiceLang` is a string matching the patch schema's `^[a-z]{2}(?:-[A-Z]{2})?$`. Otherwise the line is as today. The dedupe on the whole line stays.
  - Watch stdin: `{"voiceLang":"<code>"}`: exactly that key, a code from the six.
  - Watch → daemon, on the watch's own socket: `{ type: 'harness_device_settings', payload: { id, patch: { voiceLang }, requestId } }`. The answer is `harness_device_settings_result` under the same `requestId`.
- **One change in flight per setting.** Sound and Voice language have a slot each. A line read meanwhile replaces the one waiting in its slot (latest wins). No answer in 12 s frees the slot.
- **stderr of the watch:** `voice: <CODE>` for Voice language, `sound: <CODE>` for Sound as today; one line a failure, never the payload. `CODE` is 1 to 32 characters of `A-Z`, `0-9`, `_`, starting with a letter.
- **Logs.** The app's `menu:` line reads `Voice language: Tiếng Việt` (the checked name). The stdin line is never logged. No log line holds a device id or a payload.
- **`device-app/AGENTS.md`:** thin over the CLI; fixed text built in Rust, nothing from the webview; the watch's stdin is private; one log, redacted; no other component's path in a Rust string (name `cli/…` only in comments).
- **Repo rules.** Tests never touch the developer's daemon (18473), `~/.harness` or dial. No fixed sleeps. Comments say why.
- **Platforms.** macOS, Windows and Linux: Harness Device and the watch. Desktop's code is unchanged.

## Review Focus

1. **A Sound click and a language click within the same second.** Each reaches the dial; neither waits behind the other; each answer frees only its own slot, and each failure is said under its own word. Task 2 (`Sound and Voice language each have their own slot`, `no answer in 12 s frees the voice slot alone`).
2. **The dial holds a language the menu does not offer** (`de`, `en-US`, a hand-set value). The submenu shows six, none checked; the log says `Voice language`; a click sets one. Task 1 (`… a code outside the six that keeps the pattern prints too`), Task 6 (`the_voice_language_submenu` none checked, `the_menu_as_a_log_line`, `the_voice_check_follows_the_dial_not_the_click`).
3. **Dial text that is no language code** (`"EN"`, `7`, `null`, 200 characters, a quote or a newline inside). None of it reaches the app; the status line still parses, so the keep-alive sees a live watch. Task 1 (`… a voiceLang on the pattern …`), Task 6 (`a_status_line_carries_voice_lang`).
4. **A click as the dial goes away, starts an update, or another dial becomes the primary.** No other dial changes; one `voice: NO_DIAL` line; the row goes. Task 2 (`a waiting language keeps the dial it was read for`, `before the daemon has answered, or with no dial …`), Task 6 (`…_is_absent_when_there_is_nothing_to_change`).
5. **A daemon error that is not a code** (free text, a path, a newline). None of it reaches stderr or the app's log. Task 2 (`a reply that is not ok and names no code prints voice: FAILED`), Task 3 (`voice: /Users/person` refused).

## Decided (PM, 2026-11-25)

Not reopened: saved on the dial's NVS through `harness_device_settings` from the watch's stdin, as Sound; the submenu is absent with no dial, while updating, or with a firmware, CLI or daemon that does not report it; the six codes with their own names; after Notifications; a code outside the six shows the submenu with none checked; Sound's in-flight logic becomes one helper keyed by setting, a slot each, stderr words `sound:` and `voice:`.

## Decided (PM, 2026-11-25, on the draft's questions)

1. **What the merge needs:** the menu checked against the fake CLI, and that the same `dial_status` Desktop reads carries the chosen language. The first is the app's tests that drive its fake CLI (PR CI) and a by-hand look at the native menu that does not block the merge (Verification check 3). The second is the CLI end-to-end case below. The real-dial steps (speak Vietnamese and see a Vietnamese transcript; look at the native menu in the real app) are **after release, by Diego (non-blocking)** (check 4). No check touches production or the person's own daemon or dial.
2. **A CLI end-to-end case:** `cli/e2e/hardwareWatch.e2e.ts` gains a Voice language case beside Sound's (Task 2). PR CI's `linux-e2e` runs the file because the pull request modifies it, so the draft's hand-started `linux-e2e` run is dropped.
3. **Local gates:** `cargo test` runs freely. `python3 scripts/local-checks.py --run`, and any local run of an e2e file, waits for the PM's Mac slot.

## Decided here, where the spec was silent

1. **`voiceLang` sits after `muted` and before `notify`** on the watch's line, so `notify` stays last (`an attached dial's line says the mode last`).
2. **The pattern is the patch schema's own:** `deviceSettingsPatchSchema.shape.voiceLang` (already imported; zod 4 keeps `.shape` after `.refine`), with a string check first, as the schema's field is optional. Never a copy of the regex.
3. **The six live in the CLI as `VOICE_LANGS`** in `client.ts`. The CLI has no such list, and the backend's (`VOICE_LANGS`, `backend/src/lib/deepgram.ts`) cannot be imported; a comment names it.
4. **The watch's own codes for Voice language are Sound's words:** `voice: NOT_CONNECTED`, `voice: NO_DIAL`, `voice: NO_ANSWER`, `voice: FAILED`. The spec names the first two; the shared helper gives the other two.
5. **A stdin line that is not exactly one of the six** sends nothing and prints nothing, as Sound's malformed lines.
6. **`cli.rs` lets `voice: <CODE>` into the app's log.** The spec's failure table puts the line there, and without `cli.rs` it never arrives: the app logs only the stderr shapes it lists. `cli.rs` is not in the brief's file list; Task 3 adds it.
7. **`DialStatus.voice_lang: Option<Option<VoiceLang>>`:** `None` with no `voiceLang` (no submenu); `Some(None)` for a code outside the six (none checked); `Some(Some(lang))`.
8. **A submenu with none checked logs its label alone** (`Voice language`), as an unchecked check item logs its label: a support log tells "shown, none checked" from "absent".
9. **`Watch::voice` builds its line from `VoiceLang::code()`,** a `&'static str` of a closed enum: six possible lines, all fixed text, pinned by the test. `main.rs`'s `menu_action` finds the six through `VoiceLang::ALL`.
10. **`parity.rs`'s script gains a Voice click and its status a language,** as it holds Sound's and Notifications': the menu is the same on every OS.

## Open questions

None.

---

### Task 1: The watch's line says `voiceLang`

**Layer:** the CLI's watch. **Depends on:** none. **Effort:** `medium`.

**Red test:** `cli/src/devices/client.spec.ts`, in `describe('harness hardware watch')`.

**Files:**
- Modify: `cli/src/devices/client.ts`
- Test: `cli/src/devices/client.spec.ts`

**Interfaces:**
- Produces: `dialWatchLine(payload: unknown): string`, same signature. The line gains `"voiceLang":"<code>"` after `muted` when `payload.id` is a non-empty string, `payload.settings` is an object, and its `voiceLang` is a string that `deviceSettingsPatchSchema.shape.voiceLang` accepts. Independent of `muted`. Only the flat (primary) fields are read, never `devices`.

- [ ] **Step 1: Write the failing tests** (statuses sent with the file's `dial(run.socket, …)`):
  - `a status with an id and a voiceLang prints it after muted, and the mode stays last`: `{ attached: true, id: 'usb-1', fw: '0.0.95', settings: { muted: false, voiceLang: 'vi' }, notify: 'you' }` prints `{"attached":true,"fw":"0.0.95","muted":false,"voiceLang":"vi","notify":"you"}`.
  - `a voiceLang prints without muted, and a code outside the six that keeps the pattern prints too`: `settings: { voiceLang: 'ja' }`, then `'de'`, then `'en-US'` print `{"attached":true,"fw":"0.0.95","voiceLang":"ja"}`, `…"voiceLang":"de"}`, `…"voiceLang":"en-US"}`.
  - `only a change of voiceLang prints again`: `{ muted: false, voiceLang: 'en', brightness: 80 }`, then `brightness: 20` prints nothing, then `voiceLang: 'fr'` prints `{"attached":true,"fw":"0.0.95","muted":false,"voiceLang":"fr"}`.
  - `without an id, settings or a voiceLang on the pattern the line is as before`: beside `{ attached: true, fw: '0.0.95' }`: `settings: { voiceLang: 'vi' }` with no id; `id: ''`; `id: 'usb-1'` with no settings; `settings: null`; and with `id: 'usb-1'` a `voiceLang` of `7`, `null`, `'EN'`, `'english'`, `'vi\n'`, `'vi"}'`, `''`, `'en-us'`, `'en-USA'`, `'x'.repeat(200)`; and `devices: [{ id: 'usb-2', settings: { voiceLang: 'vi' } }]` with flat fields and no `settings`. All print `{"attached":true,"fw":"0.0.95"}` once in total.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/client.spec.ts -t voiceLang`. Expected: FAIL (the line has no `voiceLang`). Commit the tests: `Harness Device: test that the watch's line says the dial's voice language`.
- [ ] **Step 3: Implement.** The comment above `dialWatchLine` says that a change of any setting but `muted`, `voiceLang` and `notify` prints nothing, and why the value is held to the patch schema's pattern (no other text of the dial reaches the app).
- [ ] **Step 4: Run** `cd cli && npx vitest run src/devices/client.spec.ts && npm run typecheck`. Expected: PASS; `prints one line each time the status changes` and every Sound and Notifications line test pass unchanged.
- [ ] **Step 5: Commit** `Harness Device: the watch's line says the dial's voice language`.

### Task 2: A `voiceLang` line on stdin changes the dial's language; Sound and Voice language share one helper

**Layer:** the CLI's watch, and the real daemon behind it end to end. **Depends on:** Task 1 (the e2e case waits for the line's `voiceLang`; the two also share files). **Effort:** `xhigh` (two slots in flight on one socket).

**Red test:** `cli/src/devices/client.spec.ts`, a new `describe('harness hardware watch: Voice language')`; `cli/e2e/hardwareWatch.e2e.ts`, a new case in `describe('harness hardware watch with a dial: Sound')`.

**Files:**
- Modify: `cli/src/devices/client.ts`
- Test: `cli/src/devices/client.spec.ts`, `cli/e2e/hardwareWatch.e2e.ts`

**Interfaces:**
- Produces, in `client.ts`, nothing exported and no new member of `DialWatchDeps`:
  - `const VOICE_LANGS = ['en', 'vi', 'es', 'fr', 'ja', 'it'] as const`, its comment naming the backend's list and Desktop's.
  - `SOUND_ANSWER_MS` becomes `SETTING_ANSWER_MS = 12_000`, one bound for every slot. `CODE`'s comment names Voice language.
  - Inside `runDialWatch`, one helper replaces `sounding`, `waiting`, `sendSound`, `soundDone` and `sound`:
    `dialSetting(key: 'muted' | 'voiceLang', word: 'sound' | 'voice')` returns `{ change(value): void; answer(reply): boolean; stop(): void }`.
    - `change` reads `answered` and `dialId` as `sound` does today; sends `{ type: 'harness_device_settings', payload: { id, patch: { [key]: value }, requestId } }` with a `randomUUID()`, or, while its own change is in flight, keeps `{ id, value }` as the one waiting.
    - `answer` takes the `harness_device_settings_result` payload. It is true only when the payload's `requestId` is its own change's: that frees the slot, prints the failure if any, and sends what waited.
    - `stop` clears its timer. `finish` calls it for both slots, in place of `clearTimeout(sounding?.timer)`.
  - `const sound = dialSetting('muted', 'sound')`, `const voice = dialSetting('voiceLang', 'voice')`. The result branch hands the payload to `sound.answer`, then `voice.answer`; a payload neither owns is ignored.
  - The stdin branch: a line that parses to an object with the one key `voiceLang` and a value in `VOICE_LANGS` is `voice.change(value)`. It is read after the Sound branch and before Notifications; any other line falls through as today.
  - Every line below goes through `deps.printError`, under the slot's own word. Nothing of a reply is ever printed on stdout.

    | When | stderr line | Sent |
    |---|---|---|
    | The line is read before `connected` | `voice: NOT_CONNECTED` | nothing; the line is dropped |
    | The last status has no id | `voice: NO_DIAL` | nothing; the line is dropped |
    | The reply has `ok: true` | none | the waiting change, if any |
    | Any other reply, `error` passes `CODE` | `voice: <error>` | the waiting change, if any |
    | Any other reply, `error` missing or not a code | `voice: FAILED` | the waiting change, if any |
    | No reply in `SETTING_ANSWER_MS` | `voice: NO_ANSWER` | the waiting change, if any |
  - The comment on `DialWatchDeps.stdin` names the `{"voiceLang":"<code>"}` line.

- [ ] **Step 1: Write the failing tests.** Fake timers as the Sound block (`vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })`), its `USB`, `USB_LINE`, `attached()` and `answer()`. `SoundFrame` becomes `SettingFrame` (`patch: { muted?: boolean; voiceLang?: string }`). `settings(run)` is every `harness_device_settings` frame sent; `sounds(run)` those whose patch has `muted`, `voices(run)` those whose patch has `voiceLang`; `voice(run, value)` emits `JSON.stringify({ voiceLang: value }) + '\n'` on stdin.
  - `a voiceLang line sends one request for the last status's dial`: `voice(run, 'vi')` gives `voices(run)` equal to `[{ type: 'harness_device_settings', payload: { id: 'usb-1', patch: { voiceLang: 'vi' }, requestId: expect.any(String) } }]`. After `answer(…, { ok: true })`, a status with `id: 'usb-2'` and `voice(run, 'ja')`: the second names `usb-2` and `{ voiceLang: 'ja' }`. `run.errors` is `[]`, `run.printed` is `[USB_LINE]`.
  - `lines that are not exactly one of the six languages send nothing`: `{"voiceLang":"de"}`, `{"voiceLang":"EN"}`, `{"voiceLang":"en-US"}`, `{"voiceLang":""}`, `{"voiceLang":1}`, `{"voiceLang":null}`, `{"voiceLang":["vi"]}`, `{"voiceLang":"vi","muted":true}`, `{"voiceLang":"vi","id":"usb-9"}`, `{"patch":{"voiceLang":"vi"}}`, `[{"voiceLang":"vi"}]`, `"voiceLang"`, `{"voiceLang":"vi"`. `settings(run)` and `run.errors` stay `[]`. Then each of the six, each answered `{ ok: true }` before the next: the patches of `voices(run)` are the six in order.
  - `while one is in flight the latest language waits, and is sent when the first answers`: `vi` (sent), `es`, `fr`, `ja`: one request. Answer it: a second, `{ voiceLang: 'ja' }`. Answer that: still two.
  - `a waiting language keeps the dial it was read for`: `vi` sent; `es` read; a status with `id: 'usb-2'`; answer the first: the second names `usb-1`.
  - `Sound and Voice language each have their own slot`: `sound(run, true)` and `voice(run, 'vi')` send one of each at once. `sound(run, false)` and `voice(run, 'fr')` each wait. Answering the voice's `{ ok: true }` sends `fr` and no sound. Answering the sound's `{ error: 'DEVICE_OFFLINE' }` gives `run.errors` `['sound: DEVICE_OFFLINE']` and sends `{ muted: false }`. Answering the second voice's `{ error: 'DEVICE_UPDATING' }` adds `voice: DEVICE_UPDATING`. In the end two sounds and two voices.
  - `an error reply is one voice: line with its code, and nothing of the payload`: for each of `DEVICE_OFFLINE`, `DEVICE_UPDATING`, `DEVICE_NOT_READY`, `DEVICE_WRITE_FAILED`, `SERVICE_UNAVAILABLE`, `BAD_DEVICE_SETTINGS`, `OWNER_REQUIRED`, in a watch of its own: `run.errors` is `['voice: ' + code]`, `run.printed` `[USB_LINE]`.
  - `a reply that is not ok and names no code prints voice: FAILED`: the Sound block's seven replies, each in a watch of its own.
  - `before the daemon has answered, or with no dial, nothing is sent and stderr says so`: as Sound's: `['voice: NOT_CONNECTED', 'voice: NO_DIAL', 'voice: NO_DIAL']`, `settings(run)` `[]`.
  - `no answer in 12 s frees the voice slot alone`: `vi` sent at 0, `es` waits; `sound(run, true)` at 6 000 ms. At 11 999 ms `run.errors` is `[]`; at 12 000 it is `['voice: NO_ANSWER']`, `es` is sent, and the sound has no line. At 18 000 it is `['voice: NO_ANSWER', 'sound: NO_ANSWER']`. The first voice's late reply `{ error: 'DEVICE_OFFLINE' }` adds no line.
  - `stdin closing with both in flight exits 0 and leaves no timer`: `run.done` is `0` and `vi.getTimerCount()` is `0`. The same after `socket.emit('close', 1006, '')`, with exit `3`.
  - **End to end,** `cli/e2e/hardwareWatch.e2e.ts`, `a voiceLang line reaches the dial, and the line and Desktop's dial_status follow only what the dial says`, in the Sound block, on its `fresh()`, with `voiceLangOf(line)` beside `mutedOf`. The fake dial greets with `SETTINGS` (`voiceLang: 'en'`):
    1. `desk.plug('E2E-A', 'e2:e0:00:00:00:0a')`, `watch(d)`, and Desktop's stand-in `LocalClient.connect(d)` (pushed to `windows`) before any change. Wait (60 s) for `voiceLangOf(run.lines.at(-1)) === 'en'`.
    2. Write `{"voiceLang":"vi"}\n` on the watch's stdin: `dial.next((m) => m.t === 'settings.set', 30_000, 'settings.set', since)` equals `{ t: 'settings.set', voiceLang: 'vi' }`, and the last line still says `en` (sent is not done).
    3. `dial.send({ t: 'settings.state', ok: true, settings: { ...SETTINGS, voiceLang: 'vi' } })`: some line since says `vi` (any line since, not the last: the 15 s greeting can turn it back, as the Sound case says), and `window.waitFor((f) => f.type === 'dial_status' && f.payload?.settings?.voiceLang === 'vi', 30_000, …, framesBefore)` resolves: the `dial_status` Desktop reads carries the chosen language.
    4. Desktop's row: `window.request('harness_device_settings', { id: 'E2E-A', patch: { voiceLang: 'en' } })` matches `{ ok: true }`; the dial gets `{ t: 'settings.set', voiceLang: 'en' }`; `dial.send` of `SETTINGS`; the last line says `en` again.
    5. `desk.unplug('E2E-A')`, the last line is `{"attached":false}`, write `{"voiceLang":"vi"}\n`: `run.errors` comes to hold `voice: NO_DIAL`, and its `voice: ` lines are exactly `['voice: NO_DIAL']` (the first change was answered before anything else went out).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/client.spec.ts -t "Voice language"`. Expected: FAIL (no `voiceLang` request is sent). Then, once the PM has given the Mac slot (no e2e runs on the Mac while a dial eval has it): `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/hardwareWatch.e2e.ts -t voiceLang`. Expected: FAIL at step 2, `timed out … waiting for settings.set` (the watch drops the line). With no slot given, the pull request says the e2e's red was not run locally. Commit the tests: `Harness Device: test that a voice language line on the watch's stdin changes the dial`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd cli && npx vitest run src/devices/client.spec.ts src/architecture.spec.ts && npm run typecheck`. Expected: PASS; `describe('harness hardware watch: Sound')` passes on the shared helper with no test changed but `sounds` and `SettingFrame`; `nothing of the app in front goes on the core's socket` and `nothing of a tab goes on the core's socket` pass unchanged. With the Mac slot: `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/hardwareWatch.e2e.ts`. Expected: every case passes, Sound's and Notifications' unchanged. PR CI's `linux-e2e` runs the file either way (Verification check 1).
- [ ] **Step 5: Commit** `Harness Device: a voice language line on the watch's stdin changes the dial; Sound shares its slot logic`.

### Task 3: A `voice:` line of the watch reaches the log

**Layer:** Harness Device. **Depends on:** none. **Effort:** `high` (one file, but it is the line between outside text and the log).

**Red test:** `cli.rs` `only_four_shapes_of_stderr_are_logged_as_they_come`, `a_watch_logs_a_voice_code_as_it_comes_and_no_other_stderr`.

**Files:**
- Modify: `device-app/src-tauri/src/cli.rs` (its tests are in the same file)

**Interfaces:**
- Produces, private to `cli.rs`:
  - `const VOICE_STDERR: &str = "voice: "`.
  - The three coded prefixes are one list, `const CODED_STDERR: [&str; 3] = [SOUND_STDERR, NOTIFY_STDERR, VOICE_STDERR]`, which `logged_stderr` and `tail`'s `longest` both read.
  - The comment on `LOGGED_STDERR` names four shapes; every other line stays out of the log.

- [ ] **Step 1: Write the failing tests:**
  - `only_three_shapes_of_stderr_are_logged_as_they_come` becomes `only_four_shapes_of_stderr_are_logged_as_they_come`. True also for `voice: DEVICE_OFFLINE`, `voice: NO_DIAL`, `voice: NO_ANSWER`, `voice: FAILED`, `voice: A`, `voice: ` and 32 `A`s. False also for `voice: `, `voice:NO_DIAL`, ` voice: NO_DIAL`, `voice: NO_DIAL `, `voice: no dial`, `Voice: NO_DIAL`, `voices: NO_DIAL`, `voice: vi`, `voice: Tiếng Việt`, `voice: /Users/person`, `voice: person@example.com`, `voice: ` and 33 `A`s, and the bytes `voice: \xff`.
  - `a_watch_logs_a_voice_code_as_it_comes_and_no_other_stderr` (`#[cfg(unix)]`, as its Sound twin): the fake prints `@err voice: DEVICE_OFFLINE`, `@err voice: /Users/person/x`, `@err voice: Connect the VPN`, `started`, `@hang`. After a kill the log is `["harness hardware watch --json: voice: DEVICE_OFFLINE", "harness hardware watch --json: killed"]`.
  - `the_replaced_line_is_found_across_reads_and_only_whole`: the chunks `voice: NO_` then `DIAL\n` say `voice: NO_DIAL` once.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --lib stderr`. Expected: FAIL (`voice:` lines are not logged). Commit the tests: `Harness Device: test that the log carries the watch's voice: code`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd device-app/src-tauri && cargo test --lib cli::`. Expected: PASS; the Sound, Notifications and replaced-stream tests pass unchanged.
- [ ] **Step 5: Commit** `Harness Device: the log carries the watch's voice: code, and no other stderr`.

### Task 4: `VoiceLang`, `Effect::SetVoice` and `Watch::voice`

**Layer:** Harness Device. **Depends on:** none. **Effort:** `high`.

**Red test:** `types.rs` `the_six_voice_languages`; `watch.rs` `a_voice_line_reaches_the_watch`; `runner.rs` `a_voice_change_is_written_to_the_watch`.

**Files:**
- Modify: `device-app/src-tauri/src/types.rs`, `device-app/src-tauri/src/watch.rs`, `device-app/src-tauri/src/runner.rs` (their tests are in the same files)

**Interfaces:**
- Produces:
  - `types.rs`: `#[derive(Clone, Copy, Debug, PartialEq, Eq)] pub enum VoiceLang { En, Vi, Es, Fr, Ja, It }`, with
    - `pub const ALL: [VoiceLang; 6]`, in that order (Desktop's);
    - `pub fn code(self) -> &'static str`: `en` … `it`;
    - `pub fn name(self) -> &'static str`: English, Tiếng Việt, Español, Français, 日本語, Italiano;
    - `pub fn from_code(code: &str) -> Option<VoiceLang>`: `None` for any other text.
  - `types.rs`: `Effect::SetVoice(VoiceLang)`.
  - `watch.rs`: `pub fn voice(&self, lang: VoiceLang)`, beside `sound` and `notify`, through the same `write`: `{"voiceLang":"<code>"}` from `lang.code()`.
  - `runner.rs`, in `Runner::run`: `Effect::SetVoice(lang)` calls `voice(lang)` on the watch running now, on the caller's thread, holding `shared.watch`, as `SetSound`. With no watch it does nothing. It returns `None` and sends no `Event`.

- [ ] **Step 1: Write the failing tests:**
  - `types.rs` `the_six_voice_languages`: `ALL`'s codes are `["en", "vi", "es", "fr", "ja", "it"]` and its names `["English", "Tiếng Việt", "Español", "Français", "日本語", "Italiano"]`; `from_code(lang.code()) == Some(lang)` for each; `from_code` is `None` for `de`, `EN`, `en-US`, `en `, `""`.
  - `watch.rs` `a_voice_line_reaches_the_watch`: the script is `{"attached":true}`, `@record`. `watch.voice(lang)` for each of `ALL`, then `watch.stop()`: `fake.stdin()` is `{"voiceLang":"en"}`, `{"voiceLang":"vi"}`, `{"voiceLang":"es"}`, `{"voiceLang":"fr"}`, `{"voiceLang":"ja"}`, `{"voiceLang":"it"}`. A `voice` after the end adds nothing, and the log is `["harness hardware watch --json: exit 0"]`.
  - `runner.rs` `a_voice_change_is_written_to_the_watch`: as `a_sound_change_is_written_to_the_watch`, with `SetVoice(Vi)` and `SetVoice(Ja)`: `w.fake.stdin()` is `[r#"{"voiceLang":"vi"}"#, r#"{"voiceLang":"ja"}"#]`; a `SetVoice` with no watch running adds no line; no log line contains `voiceLang`; `w.rest()` is `[]`.
  - `runner.rs` `the_binary_gets_its_four_effects_back`: `others` gains `Effect::SetVoice(VoiceLang::Vi)`.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --lib voice`. Expected: FAIL to compile (no `VoiceLang`, no `SetVoice`, no method `voice`). Commit the tests: `Harness Device: test that a voice language change is one fixed line on the watch's stdin`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd device-app/src-tauri && cargo test --lib`. Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device: a voice language change is one fixed line on the watch's stdin`.

### Task 5: A Voice language click

**Layer:** Harness Device. **Depends on:** Task 4 (`VoiceLang`, `Effect::SetVoice`). **Effort:** `high`.

**Red test:** `app.rs` `a_voice_click_asks_the_dial_and_draws_the_menu_again`; `main.rs` `every_menu_action_has_its_own_id`.

**Files:**
- Modify: `device-app/src-tauri/src/types.rs`, `device-app/src-tauri/src/app.rs`, `device-app/src-tauri/src/main.rs` (their tests are in the same files)
- Test only: `device-app/src-tauri/src/parity.rs`

**Interfaces:**
- Consumes: `VoiceLang`, `VoiceLang::ALL`, `Effect::SetVoice(VoiceLang)` (Task 4).
- Produces:
  - `types.rs`: `MenuAction::Voice(VoiceLang)`.
  - `main.rs`: `menu_id(MenuAction::Voice(lang))` is `voice_en`, `voice_vi`, `voice_es`, `voice_fr`, `voice_ja`, `voice_it` (six literals); `menu_action` finds the six through `VoiceLang::ALL.map(MenuAction::Voice)` beside its list.
  - `app.rs`: `Event::Menu(MenuAction::Voice(lang))` gives exactly `[Effect::SetVoice(lang), Effect::Menu(<the last menu sent>)]`. No `menu:` log line, nothing remembered: the native check that flipped itself goes back to the dial's.

- [ ] **Step 1: Write the failing tests:**
  - `app.rs` `a_voice_click_asks_the_dial_and_draws_the_menu_again`: `found()`, a status line with the dial attached, `menu = menu_of(…)`. Then, twice over, for each `lang` of `VoiceLang::ALL`: `app.handle(Event::Menu(MenuAction::Voice(lang)))` equals `[Effect::SetVoice(lang), Effect::Menu(menu.clone())]`.
  - `main.rs` `every_menu_action_has_its_own_id`: the eleven actions and the six `Voice(lang)`: `menu_action(menu_id(action)) == Some(action)` for each; the 17 ids are distinct; `menu_id(Voice(VoiceLang::Vi))` is `voice_vi` and `menu_id(Voice(VoiceLang::Ja))` is `voice_ja`; `menu_action("voice")` and `menu_action("voice_de")` are `None`.
  - `parity.rs` `the_one_os_property_of_the_rules_is_install_exits_app`: the script gains `Event::Menu(MenuAction::Voice(VoiceLang::Vi))` after `Event::Menu(MenuAction::NotifyYou)`.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --lib voice_click` and `cargo test --bin harness-device every_menu_action`. Expected: FAIL to compile (no variant `Voice`). Commit the tests: `Harness Device: test that a voice language click asks the dial and leaves the check to it`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd device-app/src-tauri && cargo test`. Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device: a voice language click asks the dial and leaves the check to it`.

### Task 6: The Voice language submenu

**Layer:** Harness Device. **Depends on:** Task 5 (`MenuAction::Voice`). **Effort:** `high`.

**Red test:** `types.rs` `a_status_line_carries_voice_lang`; `model.rs` `the_voice_language_submenu`, `the_voice_language_submenu_is_absent_when_there_is_nothing_to_change`, `the_menu_as_a_log_line`; `app.rs` `the_voice_check_follows_the_dial_not_the_click`.

**Files:**
- Modify: `device-app/src-tauri/src/types.rs`, `device-app/src-tauri/src/model.rs` (their tests are in the same files)
- Test only: `device-app/src-tauri/src/app.rs`, `device-app/src-tauri/src/runner.rs`, `device-app/src-tauri/src/watch.rs`, `device-app/src-tauri/src/parity.rs` (every `DialStatus { … }` written out in full there gains `voice_lang: None`)

**Interfaces:**
- Consumes: `VoiceLang` and its `ALL`, `name`, `from_code` (Task 4); `MenuAction::Voice` (Task 5).
- Produces:
  - `types.rs`: `DialStatus.voice_lang: Option<Option<VoiceLang>>`, with `#[serde(default, rename = "voiceLang", deserialize_with = "voice_lang")]`. The reader is lenient, as `notify_mode`: a string is `Some(VoiceLang::from_code(text))`, anything else `None`, and the line is still a status. Its comment says the three cases.
  - `model.rs` `menu`: after the Notifications submenu and before the update row, when `settable(state)` has a `voice_lang`: `MenuItem::Submenu("Voice language", …)` of six `MenuItem::Check(MenuAction::Voice(lang), lang.name(), <the dial holds lang>)`, in `ALL`'s order. `settable`'s comment names Voice language.
  - `model.rs` `menu_log`: a submenu is `<label>: <checked item's label>`; with none checked, its label alone.

- [ ] **Step 1: Write the failing tests:**
  - `types.rs` `a_status_line_carries_voice_lang`: `{"attached":true,"voiceLang":"vi"}` gives `Some(Some(Vi))`, and each of the six its own; `"de"` and `"en-US"` give `Some(None)`; no key gives `None`; `7`, `null`, `["vi"]` and `{}` give `None`, and each line still parses as a status.
  - `model.rs`, with `voicing(lang: Option<Option<VoiceLang>>) = DialStatus { voice_lang: lang, ..notifying(NotifyMode::Full) }` and `voices(held: Option<VoiceLang>)` the expected submenu, `the_voice_language_submenu`: with `Some(Some(Vi))` the whole menu is `Device ready`, `Signed in`, `Check(SoundOff, "Sound", true)`, `notifications(true, false)`, `voices(Some(Vi))`, the separator, `Open Harness`, `Export logs`, `About`, `Quit`. For each lang of `ALL`, row 4 is `voices(Some(lang))`, that one alone checked. With `Some(None)` row 4 has the six, none checked. With `muted: None` and `notify: None` it is row 2. With `app_update: Installing`, rows 4 to 6 are the submenu, `Updating Harness Device…`, the separator.
  - `model.rs` `the_voice_language_submenu_is_absent_when_there_is_nothing_to_change`: no item is a `Submenu` labelled `Voice language` for `dial: None`; `voicing(None)`; `attached: false` with `Some(Some(En))`; `updating: Some("0.0.96")` with `Some(Some(En))`; `daemon` `Starting`, `Stopped`, `Updating` with `voicing(Some(Some(En)))`; `cli` `Removed`, `Installing`, `InstallFailed` with the same.
  - `model.rs` `states()`: its dials gain `voicing(Some(Some(VoiceLang::Ja)))`, so every-state tests see the submenu.
  - `model.rs` `the_menu_as_a_log_line` also gives `Device ready | Signed in | Sound ✓ | Notifications: All | Voice language: Tiếng Việt | Open Harness | Export logs | About | Quit` for `Some(Some(Vi))`, the same with `Voice language: 日本語` for `Some(Some(Ja))`, and with `Voice language` alone for `Some(None)`.
  - `app.rs` `the_voice_check_follows_the_dial_not_the_click`: `found()`; a line with `fw: "0.0.95"` and `voice_lang: Some(Some(En))` gives a submenu with English checked and the log `menu: Device ready | Voice language: English | Export logs | About | Quit`. `Event::Menu(Voice(Vi))` gives a menu that still checks English, and no `menu:` line. A line with `Some(Some(Vi))` checks Tiếng Việt and logs `menu: Device ready | Voice language: Tiếng Việt | Export logs | About | Quit`. A line with `Some(None)` checks none and logs `menu: Device ready | Voice language | Export logs | About | Quit`. `Event::WatchExit(Some(3))` gives a menu with no submenu.
  - `watch.rs` `a_line_each_time_the_dial_changes`: the attached line gains `"voiceLang":"ja"`, and its event has `voice_lang: Some(Some(VoiceLang::Ja))`.
  - `parity.rs` `status(muted)`: `voice_lang: Some(Some(VoiceLang::En))`.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --lib`. Expected: FAIL to compile (no field `voice_lang`). Commit the tests: `Harness Device: test the Voice language submenu, checked where the dial is`.
- [ ] **Step 3: Implement.** `model.rs`'s `the_whole_menu`, `the_sound_row` and `the_notifications_submenu` pass unchanged: their dials have no `voice_lang`.
- [ ] **Step 4: Run** `cd device-app/src-tauri && cargo test`. Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device: the Voice language submenu, checked where the dial is`.

### Task 7: The docs

**Layer:** repo files. **Depends on:** none. **Effort:** `medium`.

**Red test:** none: no behavior. One commit.

**Files:**
- Modify: `docs/plans/2026-11-13-device-menubar-design.md`, `desktop/design/desktop-design-system.md`

- [ ] **Step 1:** In the menubar design's `### Menu` table, between the `Notifications` row and the `"Updating Harness Device…"` row, add:
  `| **Voice language** (submenu) | English, Tiếng Việt, Español, Français, 日本語 and Italiano, each in its own language, the one the dial holds checked, none for another code; only while Harness runs and the dial is attached, not updating, and reports its settings ([design](2026-11-25-device-app-voice-language-design.md)) |`
- [ ] **Step 2:** In the design system's `## Harness Device` section, the menu sketch gains `  Voice language ▸` on the line after `  Notifications ▸`. The gallery does not change: it shows only the window's screens, and the section says a change to a screen changes it.
- [ ] **Step 3: Commit** `Harness Device: the Voice language submenu in the menu's design`.

## Verification

**What blocks the merge:** checks 1 and 2. Check 3 is a by-hand look that does not block it. Check 4 is **after release, by Diego (non-blocking)**. No check touches production, the developer's daemon (18473), `~/.harness`, or a person's own dial.

**Platforms the pull request names:** Harness Device on macOS (the local gates; check 3 by hand), Linux (PR CI compiles and tests all of it) and Windows (PR CI runs `cargo test --lib`: `types.rs`, `model.rs`, `app.rs`, `cli.rs`'s pure rule; `watch.rs` and `runner.rs` tests are `cfg(unix)`). The watch on all three: its code reads no OS; its unit tests and the e2e case run on Linux in PR CI. Desktop: one doc changes, no code.

**Workflows:** none changes, and none is added.

**Turns.** `cargo test` runs freely. Ask the PM for the Mac slot first before `python3 scripts/local-checks.py --run` and before any local run of `cli/e2e/hardwareWatch.e2e.ts` (Task 2): no big suite or e2e runs while a dial eval has the Mac. Check 3 needs a person's eye; check 4 is Diego's.

**The pull request also says:** nothing under `cli/src/core`, `cli/src/services`, `cli/src/harnessd` or `cli/src/cable` changes; Sound's slot logic moved into the shared helper (Task 2); the app's log lets through one more shape of the watch's stderr (Task 3); check 3 by hand, done or not; the real-dial steps are after release, by Diego (non-blocking).

**1. PR CI, nothing started by hand:**
- `cli-typecheck` and `cli-tests`: Tasks 1 and 2 on Linux. `companions` and `pty-checks` run too, as for any `cli/` change.
- `linux-e2e` and `linux-e2e-summary`: `cli/e2e/hardwareWatch.e2e.ts`, which PR CI picks because the pull request modifies it (`linux_e2e_file` in `scripts/ci-plan.py`; the `linux-e2e` row of `docs/validation-and-release.md`). The whole file runs: Sound's case on the shared helper (the daemon's answer routed by `requestId` on the watch's own socket), the new Voice language case, Notifications'. It shows that a click's line reaches the dial as `settings.set` with `voiceLang` alone, that the watch's line and the `dial_status` Desktop reads both carry the chosen language once the dial says so, and that Desktop's change moves the line. Isolation: the suite's own `IsolatedDaemon` (`cli/e2e/harness/daemon.ts`): a throwaway home, data folder, auth folder and computer id, its own port and tmux server, signed out, the backend at `127.0.0.1:9`; the dial is a fake on the desk file the daemon reads (`HARNESSD_TEST_DIAL_PORT`). No person's daemon, dial, account or backend is touched.
- `windows-e2e` (x64), which `cli/src/devices/` selects: the Windows CLI specs and the dial end to end on a stand-in dial.
- `device-app-checks`: Tasks 3 to 6 (Linux, full `cargo test`; Windows, `cargo test --lib`). This is the menu checked against the fake CLI: `watch.rs` and `runner.rs` drive the app's own `tests/fake-harness` (Task 4 `a_voice_line_reaches_the_watch`, `a_voice_change_is_written_to_the_watch`; Task 6 `a_line_each_time_the_dial_changes`), and `model.rs`, `app.rs` and `parity.rs` build the menu from those lines.
- `device-app-e2e`: `linux.sh` and `windows.ps1` against the fake CLI, whose lines carry no `voiceLang`: their menus read as before.
- `desktop-tests`, which the doc under `desktop/` selects, and `process-checks`.
- Proposal for the maintainers, not this pull request: `scripts/ci-plan.py` could select `cli/e2e/hardwareWatch.e2e.ts` for a later change to `cli/src/devices/client.ts` alone, as it selects the Orca files for Orca's adapter; today a pull request that leaves the e2e file unchanged does not run it.

**2. Local gates,** recorded in the pull request (PR CI does not run them):
- On a Mac, freely: `(cd device-app/ui && npm ci && npm run build) && cd device-app/src-tauri && CARGO_TARGET_DIR=~/.cache/harness-device-target cargo test --locked`. PR CI compiles none of the macOS code ("Harness Device on macOS", `docs/validation-and-release.md`).
- `git diff --stat 0a4f7cf05a -- cli/src/core cli/src/services cli/src/harnessd cli/src/cable cli/src/architecture.coreFiles.txt` prints nothing, so `npm run test:core` and `npm run test:harnessd` are not needed. If it prints a line, stop and report.
- Ask the PM for the Mac slot first, then `python3 scripts/local-checks.py --run` from a clean tree at the final commit. `--list` names no check for this plan's paths today (`{}`); paste what it prints.
- Not needed: `macos.sh` (nothing here installs, starts, follows, draws the tray or updates), the serial and PTY specs, `make desktop-test`, `make device-test`.

**3. The real app against the fake CLI: the native submenu** (by hand, a person's eye; does not block the merge)
- Why by hand: the native menu needs a desktop session and someone to look. Nothing here reaches a daemon or a dial. No agent takes a screenshot.
- Where: a Mac. On the Windows and Linux test machines too when the PM grants one: the same script in a `FAKE_HARNESS` folder, with `tests/fake-harness.cmd` or `tests/fake-harness` as `HARNESS_DEVICE_CLI` and a debug build, as `windows.ps1` and `linux.sh` set them.
- Build, at the final head: `(cd device-app/ui && npm ci && npm run build) && (cd device-app/src-tauri && CARGO_TARGET_DIR=~/.cache/harness-device-target cargo build --locked)`. The app is the unbundled debug binary: never installed, no login item.
- Isolation: as the Sound plan's check 3 (`docs/plans/2026-11-16-device-app-sound-plan.md`): a throwaway `$T` with its own home (`HOME` and `CFFIXED_USER_HOME`), a `PATH` of stubs (`open` and `curl` only record), `FAKE_HARNESS="$T/fake"`, and `state.json` with every flag true, so no login item is asked for and no window opens.
- Scripts in `$T/fake`: `auth_status_--json` holds `{"loggedIn":true}`; `hardware_watch_--json` holds, a line each:
  `{"attached":true,"fw":"0.0.95","muted":false,"voiceLang":"en","notify":"full"}`, `@wait vi`, `{"attached":true,"fw":"0.0.95","muted":false,"voiceLang":"vi","notify":"full"}`, `@wait de`, `{"attached":true,"fw":"0.0.95","muted":false,"voiceLang":"de","notify":"full"}`, `@wait updating`, `{"attached":true,"fw":"0.0.95","updating":"0.0.96","muted":false,"voiceLang":"vi","notify":"full"}`, `@wait old`, `{"attached":true,"fw":"0.0.95","muted":false,"notify":"full"}`, `@wait none`, `{"attached":false}`, `@record`.
- Run, from the repository root, in the isolated shell, naming the binary by the path it had before `HOME` moved: `HARNESS_DEVICE_CLI="$PWD/device-app/src-tauri/tests/fake-harness" "$BIN" &`, where `BIN` was set beforehand to the absolute path of `~/.cache/harness-device-target/debug/harness-device`.
- A person does and sees:
  1. The menu reads `Device ready`, `Signed in`, `Sound` checked, `Notifications ▸`, `Voice language ▸`, a separator, then `Export logs`, `About`, `Quit` (and `Open Harness` when Desktop is installed). Voice language opens to English, Tiếng Việt, Español, Français, 日本語, Italiano, drawn in full, English checked.
  2. Choose Tiếng Việt. Open the submenu again: English still checked. `touch "$T/fake/vi"`: within a second Tiếng Việt is checked.
  3. `touch "$T/fake/de"`: the six, none checked. Choose 日本語: still none checked.
  4. `touch "$T/fake/updating"`: `Updating device…`, no Voice language row. `touch "$T/fake/old"`: `Device ready`, no Voice language row. `touch "$T/fake/none"`: `Plug in your device`, no row.
  5. Quit from the menu. `grep voiceLang "$T/fake/stdin.log"` prints `{"voiceLang":"vi"}`, then `{"voiceLang":"ja"}`, and nothing else. The app's log (`$T/home/Library/Logs/ai.autonomous.harness.device/app-*.log`) has `menu:` lines with `Voice language: English`, `Voice language: Tiếng Việt` and `Voice language`, and no line with `voiceLang`.
- Afterwards: `rm -rf "$T"` (its `stdin.log` also holds which apps were in front; quote only the `voiceLang` lines).
- On GitHub: none. It needs a desktop session and a person's eyes on a native menu.
- Not done before the merge: the pull request says so; it does not hold the merge.

**4. On a dial: the transcript, and the native menu in the real app** (after release, by Diego (non-blocking))
- When: after a release build that carries this change exists. Not before the merge, and never by an agent.
- Where: Diego's own computer, dial and login, with the released Harness Device and Harness Desktop. No plan check runs there.
- Diego does and sees:
  1. The menu shows `Voice language ▸`, opening to English, Tiếng Việt, Español, Français, 日本語, Italiano, the dial's language checked. Note it, to put back.
  2. Choose Tiếng Việt: within about a second the check moves and Desktop ▸ Devices ▸ Voice language reads Tiếng Việt.
  3. Speak Vietnamese to the dial: the transcript is in Vietnamese, with no replug.
  4. In Desktop, choose the noted language: the menu's check follows, with no click in the menu.
  5. Unplug the dial: `Plug in your device`, no Voice language row. Plug it in: the row is back, checked where the dial is.
- Evidence: Diego's word. Until then it is reported as "after release, by Diego (non-blocking)", never as passed.
- On GitHub: none. It needs a dial, a voice and a person's ears and eyes.
