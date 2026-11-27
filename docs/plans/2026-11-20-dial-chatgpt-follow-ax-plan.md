# Dial follows the thread opened in the ChatGPT app — Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with devcrew phase 3, task by task. Steps use checkbox (`- [ ]`)
> syntax for tracking. A test-first task is two commits: `test(<area>): <the task's message> (red)` once its failing
> tests have been run and seen to fail, then the task's own message. A task with no red test is one commit.

**Goal:** On macOS, while the dial is attached and ChatGPT is in front, the dial moves to the Codex thread the person
opens in the ChatGPT app, read from the ChatGPT window's title through Accessibility, which Harness Device asks for once.

**Architecture:** Harness Device (`device-app/`) reads only ChatGPT's focused window's `AXTitle` through an `AXObserver`
on a thread of its own, and writes `{"thread":"<title>"}` on the watch's stdin. Pure rules (`follow.rs`) decide when to
observe, which line to write and when to offer the explanation screen; the macOS door (`follow_macos.rs`) is behind
`cfg(target_os = "macos")`, `NoFollow` elsewhere. The watch (`cli/src/devices/client.ts`) tells the devices process
`{type:'thread', title}`; the devices process matches the title to Codex's own name of one of the ChatGPT source's
threads and follows it as a tab report is followed, with its echo guards. Nothing in `cli/src/core/`.

**Tech Stack:** Rust (Tauri 2, objc2 0.6 / objc2-* 0.3), TypeScript (the window, vitest), TypeScript (`cli/`, vitest).

**Spec:** `docs/plans/2026-11-20-dial-chatgpt-follow-ax-design.md`. Read it with this plan, the root `AGENTS.md`,
`cli/AGENTS.md` (Protect the core, rule 7; Rules 4-6), `device-app/AGENTS.md`, and
`desktop/design/desktop-design-system.md` § Harness Device.

## Base

- Branch `feat/dial-chatgpt-follow-ax` at `7687138398`, in this worktree. The spec and this plan are untracked: the main
  session commits them; no task does.
- **Before the first task, once:** `cd cli && npm ci --no-audit --no-fund` and `cd device-app/ui && npm ci --no-audit
  --no-fund` (neither has `node_modules`). One process runs each, never two tasks at once. Rust: one `CARGO_TARGET_DIR`
  outside the repository for every device-app task (`device-app/AGENTS.md`, Toolchain).
- Names at the base. device-app: `front.rs` `FrontSource`, `FrontFeed`, `front_line`, `FRONT_MAX`; `tabs.rs` `TabFollow`,
  `Out`, `NoTabs`, `system`; `runner.rs` `Doors`, `Shared`, `Tabs`, `Call`, `Runner::polling_every`,
  `Shared::{spawn_watch, front_changed, follow_tabs, open}`, tests' `Doubles`, `Fronts`, `Scripts`, `world_where`,
  `doors`, `RECORDING`, `ATTACHED`, `EVERY`; `app.rs` `App::{apply, act, next, view_of, show, remember, send_menu}`,
  tests' `SEEN`; `model.rs` `menu`, `due`, `menu_log`, `settable`, tests' `state()`, `states()`; `types.rs` `Saved`,
  `Screen`, `Action`, `MenuAction`, `MenuItem`, `AppState`, `Event`, `Effect`; `watch.rs` `Watch::{front, tab}`;
  `main.rs` `menu_id`, `menu_action`. cli: `client.ts` `runDialWatch`, `lines`, `FRONT_LINE_MAX`, `TELL_GAP_MS`,
  `tellTab`; `devicesListener.ts` `tabHandler`, `TAB_MAX_BYTES`, `TAB_PER_SECOND`, `REFUSED`; `devices.ts`
  `dialMovesTo`, `noteMove`, `dialMoves`, `dialMovedAt`, `noting`, `codexNoted`, `codexPane`, `codexAppSource`,
  `appSettled`, `tabReported`, `tabSettled`, `followTab`, `FOLLOWED`, `ATTACH_ECHO_MS`, `TAB_ECHO_MS`, the stop path
  (`tabReport = undefined; selects.clear()`); `cableSession.ts` `FollowCause`; `codexAppSource.ts` `take`, `stop`,
  `CodexAppSourceDeps['threads']`; `codexAppThreads.ts` `namesOf`, `forget`; `sessionTitle.ts` `codexThreadName`.
  If a name differs, follow the code and say so in the report.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 The follow rules | `device-app/src-tauri/src/follow.rs` (new), `lib.rs` | none | high | `follow.rs` tests |
| 2 The menu item, the screen and Allow in the app's rules | `types.rs`, `state.rs`, `model.rs`, `app.rs`, `runner.rs`, `main.rs` (all `device-app/src-tauri/src/`) | 1 | high | `app.rs` `the_offer_opens_the_follow_screen_once_and_remembers_it` and the others listed |
| 3 The macOS door: Accessibility, the observer, the permission | `follow_macos.rs` (new), `follow.rs` (`system` and one test), `lib.rs`, `device-app/src-tauri/Cargo.toml`, `Cargo.lock` | 1 | xhigh | `follow.rs` `the_mac_door_reads_only_the_focused_windows_title_and_sets_nothing`; `follow_macos.rs` tests on a Mac |
| 4 The runner follows ChatGPT | `device-app/src-tauri/src/runner.rs`, `watch.rs` | 2 | xhigh | `runner.rs` `the_chatgpt_title_is_written_to_the_watch_…` and the others listed |
| 5 The window's Follow ChatGPT screen | `device-app/ui/src/{api.ts, screens.ts, gallery.ts, api.test.ts, screens.test.ts, gallery.test.ts}` | none | high | `screens.test.ts` `follow: Allow, Not now` |
| 6 The thread title rule | `cli/src/cable/hosts/threadTitle.ts` (new), `threadTitle.spec.ts` (new) | none | medium | `threadTitle.spec.ts` |
| 7 The watch tells the thread | `cli/src/devices/client.ts`, `client.spec.ts` | 6 | high | `client.spec.ts` `describe('harness hardware watch: the ChatGPT thread')` |
| 8 The listener takes the thread | `cli/src/services/devicesListener.ts`, `devicesListener.spec.ts` | 6 | medium | `devicesListener.spec.ts` `describe('thread')` |
| 9 A title is matched to one thread | `cli/src/cable/hosts/codexAppThreads.ts`, `codexAppSource.ts`, their `.spec.ts`, `cli/src/services/devices.spec.ts` (the two reader fakes only) | none | high | `codexAppSource.spec.ts` `describe('threadNamed')`, `codexAppThreads.spec.ts` `describe('names(ids)')` |
| 10 The devices follow the thread | `cli/src/services/devices.ts`, `devices.spec.ts`, `cli/src/cable/cableSession.ts` | 8, 9 | high | `devices.spec.ts` `describe('the thread opened in the ChatGPT app moves the dial')` |
| 11 End to end on this Mac | `cli/e2e/dialChatgptFollow.e2e.ts` (new) | 7, 10 | high | none: a test only, one commit (its mutation check is a step) |
| 12 Docs | `desktop/design/desktop-design-system.md`, `device-app/AGENTS.md`, `cli/AGENTS.md` | none | medium | none: docs, one commit |

Longest chain: 6 → 8 → 10 → 11 (four tasks). Tasks 1, 5, 6, 9 and 12 start at once; 2 and 3 run side by side after 1;
7 and 8 side by side after 6. Task 2 touches `runner.rs` and `main.rs` only because its new effects and menu actions
must compile there (an exhaustive `match` each); Task 4 then owns `runner.rs`.

## Global Constraints

- **Platforms:** macOS reads and follows. Linux and Windows: `NoFollow` (nothing read, no menu item, no screen), and the
  CLI's handler is there but nothing sends to it. PR CI compiles and tests device-app on Linux only.
- **Accessibility reads** only ChatGPT's (`com.openai.codex`) focused window's `AXTitle`, through the application
  element's `AXFocusedWindow`, only while ChatGPT is the app in front, a watch runs, the dial is attached (the watch's
  `attached`) and `AXIsProcessTrusted()` is true. Never set an attribute (`AXManualAccessibility` included), never
  perform an action. A 1 s messaging timeout on every element called (`AXUIElementSetMessagingTimeout`).
- **Push, no poll:** an `AXObserver` for `AXFocusedWindowChanged` and `AXTitleChanged` on the application element, on a
  thread of its own with its own run loop. The pid is `NSWorkspace`'s front application's, taken as observing starts,
  only when its bundle id is `com.openai.codex`.
- **The line:** `{"thread":"<title>"}`. Each observer start writes its first read whatever was written before; after
  that, a line only for a change. A title over **256 UTF-16 code units** (a JavaScript string's `length`, the CLI's
  rule) or with a **control character (Unicode Cc: U+0000–U+001F, U+007F–U+009F)** is the empty title; no focused window
  is the empty title. The same two rules on both sides, so the two never disagree. Rust alone also sends the empty
  title when the line, its `\n` included, would pass **512 bytes** (`PIPE_BUF`, `THREAD_LINE_MAX`: the stdin pipe is
  non-blocking and only such a write is whole); the CLI keeps 256 units, so Rust never sends what the CLI drops.
- **Private:** the title goes on the watch's stdin and to the devices listener, and is held in memory only for a waiting
  report. Never in an Event, a log line, `state.json`, the window, a `[device]` line. Log lines are fixed words:
  device-app `chatgpt: follow on`, `chatgpt: follow off`, `chatgpt: no observer`, `chatgpt: asked`; cli `[device] thread ·
  moved`, `· skipped · echo`, `· skipped · not in front`, `· skipped · no match`, `· skipped · ambiguous`,
  `· skipped · no tile`. Never a title, name, thread id, pid, path or tty.
- **The offer** (`Event::FollowOffer`, valueless, never logged): when ChatGPT *comes* to the front (a change after the
  front source's first value) while a watch runs, the dial is attached, ChatGPT is installed and Harness is not trusted.
  The app opens the screen unless `askedFollow` is set, and sets it. In `due()` it ranks after Install and Sign in.
  Never at start, never a second time by itself.
- **Allow:** always `AXIsProcessTrustedWithOptions` with `kAXTrustedCheckOptionPrompt`. When `askedAx` is already set,
  also `/usr/bin/open x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` (the fixed
  argument). The checked item's click runs the same `open`. Allow closes the window at once; a grant heard while the
  Follow screen shows closes it too.
- **Permission heard:** `AXIsProcessTrusted()` read at start, when ChatGPT comes to the front, and at the distributed
  notification `com.apple.accessibility.api`, then once more 1 s later (`TRUST_AGAIN`).
- **Saved state:** `askedFollow`, `askedAx`, each `#[serde(default)]`; a file without them loads as before.
- **No entitlement** is added (`tabs.rs` `the_bundle_may_send_apple_events` stays as it is).
- **Installed:** `ChatGPT.app` in `/Applications` or `~/Applications` whose `CFBundleIdentifier` is `com.openai.codex`,
  read each time the dial attaches.
- **Copy (exact):** menu `Follow ChatGPT` (check item, no `…`); heading `Follow ChatGPT`; body `Your dial moves to the
  thread you open in ChatGPT. Harness reads only the ChatGPT window's title, while ChatGPT is in front.`; buttons
  `Not now` (action `later`), `Allow` (action `allow`, primary). Menu position: after `Notifications ▸`, before the
  app-update row.
- **CLI bounds:** the watch's stdin line cap stays `FRONT_LINE_MAX` (1024 bytes); the thread tell has its own slot with
  the 100 ms gap (`TELL_GAP_MS`); the listener's `thread` is 10 a second (`THREAD_PER_SECOND`) and at most
  `THREAD_MAX_BYTES = 1024`; the source keeps at most 200 ids (`MAX_ROWS`).
- **Echo:** `report.moves !== dialMoves`; the dial's own ChatGPT switch within `TAB_ECHO_MS` (2 s) of the report,
  consumed (`codexSwitches`); a report followed at the settle within `ATTACH_ECHO_MS` (2 s) of `dialMovedAt`.
- **Core:** nothing under `cli/src/core/`, no line of `cli/src/architecture.coreFiles.txt`, and no change to
  `cli/src/lib/sessionTitle.ts` (the core's process loads it: rule 7). `src/services/devices.ts` and
  `devicesListener.ts` stay at 100% per file (`npm run test:core`).
- **No fixed sleeps** in tests: fake clocks (vitest), condition waits with a bound (Rust `wait_timeout_while`, e2e
  `until`). The Rust runner tests take a short `trust_again` instead of 1 s.
- **Tests never touch the real thing:** no test calls `prompt()` (it would show macOS's dialog), the real `observe()`
  (it would read the real ChatGPT if it is in front), or reads `/Applications`. No e2e reaches the real `~/.codex`,
  the ChatGPT app, the daemon on port 18473, tmux, or a backend.

## Decisions made in this plan (the spec left them to the builder)

- **"256 characters" is UTF-16 code units** on both sides (Rust `encode_utf16().count()`, JS `.length`), and "control
  character" is Unicode Cc on both (Rust `char::is_control`, JS `/[\u0000-\u001f\u007f-\u009f]/`): the spec's "so the two
  never disagree".
- **The revocation notification uses CoreFoundation's distributed center**, `CFNotificationCenterGetDistributedCenter`
  with `CFNotificationSuspensionBehaviorDeliverImmediately` (`objc2-core-foundation` feature `CFNotificationCenter`),
  **not** `objc2-foundation`'s `NSDistributedNotificationCenter` the spec names: AppKit suspends distributed
  notifications while the app is not active, and only an observer added with `DeliverImmediately` hears them then;
  Harness is an accessory app that is almost never active. NSDistributedNotificationCenter takes that behaviour only in
  its selector form, which needs an Objective-C class of our own; the CF form is a C callback. No `NSDistributedNotificationCenter`
  feature is added.
- **The AX attribute and notification names** are written as literal CFStrings (`"AXFocusedWindow"`, `"AXTitle"`,
  `"AXFocusedWindowChanged"`, `"AXTitleChanged"`), so a test can hold the file to those four names.
- **`installed`'s Info.plist** is read with `NSDictionary::dictionaryWithContentsOfURL_error` (features already on:
  `NSDictionary`, `NSURL`, `NSError`, `NSString`): it reads a binary or XML plist fresh each time, where `NSBundle`
  caches a bundle for the process's life.
- **Threads:** every door call that can wait on ChatGPT (`observe`, dropping an observation) and the `installed` read
  run on one follow thread of the runner; `trusted()` (a local check) is read inline where it is needed;
  `prompt()` runs where `Effect::AskAx` runs. Dropping an observation never blocks: it stops the run loop and does not
  join the thread.
- **Lock order** in the runner: `watch` → `watching` → the follow state. The follow state's lock is never held across a
  door call or `send`. A title is written to the watch under `watch`, as the tab thread writes a tab line.
- **`chatgpt: follow on`/`off`** is logged by the app's rules at each change of `trusted` from what the app held, which
  starts false: at start, `on` is said when Harness is already trusted, nothing when it is not.
- **Not now** closes the window (`Show(None)`), as the spec says; closing the window on the screen is Not now.
- **The matcher's names** come from `codexThreadName(id, home)` for each kept id, under one regular-file check of
  `session_index.jsonl`: up to 200 calls a followed report (accepted by the PM; Task 9 measures it).
- Names: `follow.rs` `ChatgptFollow`, `Observer`, `Heard`, `Shown`, `ChatgptWindow`, `AxTrust`, `FollowDoor`, `NoFollow`,
  `thread_line`, `chatgpt_installed`, `CHATGPT_BUNDLE`, `TITLE_MAX`, `THREAD_LINE_MAX`, `TRUST_AGAIN`, `AX_SETTINGS`; `types.rs`
  `FollowState`, `Screen::Follow`, `Action::Allow`, `MenuAction::{FollowChatgpt, FollowSettings}`,
  `Event::{Follow, FollowOffer}`, `Effect::{AskAx, OpenAxSettings}`; cli `threadTitle.ts` `threadTitleOf`,
  `THREAD_TITLE_MAX`, `threadHandler`, `THREAD_MAX_BYTES`, `THREAD_PER_SECOND`, `CodexAppThreads.names`,
  `CodexAppSource.threadNamed`, `ThreadMatch`, `FollowCause` `'thread'`.

## Review Focus

Inputs the spec implies and its own test list does not name. Each has its test in the task that owns the code.

1. **A title of non-ASCII text at the limit** (CJK, emoji: an astral character is two UTF-16 units and four bytes).
   Expected: every title Rust keeps, the CLI keeps, so no line Rust sends is dropped by the CLI; Rust's 512-byte cut
   is the only place the two differ, and it is the stricter. Task 1 `a_thread_line_is_the_title_or_the_empty_title`
   (124 `🦀` kept, 125 the empty title by bytes, 129 by units, U+0085 refused) and Task 6
   `the same titles as Harness Device` (Rust's table, plus the titles only Rust's byte cut empties).
2. **A title from an observer already stopped** arriving after the next observer started (the person left ChatGPT and
   came back fast). Expected: written nowhere; the new start's own first title is written. Task 1
   `a_title_from_an_earlier_start_is_dropped`, Task 4 `a_title_heard_after_its_observer_was_dropped_is_written_nowhere`.
3. **A ChatGPT that hangs** (every AX call waits its 1 s timeout, or the door's start is slow). Expected: front and tab
   lines keep flowing, the main thread is never held. Task 4 `a_chatgpt_that_hangs_holds_back_no_front_line`, Task 3
   `the_observer_thread_ends_when_its_handle_is_dropped` (drop returns at once).
4. **A thread renamed in the app after the last list read** (Codex appends a new name to `session_index.jsonl`; the
   store's WAL write that would read the list again may come later). Expected: the next report with the new name
   matches it. Task 9 `a name Codex gives after the last read is matched`.
5. **Spaces around the title or Codex's name, and letter case.** Expected: both trimmed, compared exactly (case kept);
   a whitespace-only title matches nothing. Task 9 `trims both sides and keeps case`.

---

### Task 1: The follow rules

**Files:**
- Create: `device-app/src-tauri/src/follow.rs`
- Modify: `device-app/src-tauri/src/lib.rs` (`pub mod follow;`)

**Interfaces:**
- Produces (all `pub` in `follow.rs`):
  - `CHATGPT_BUNDLE: &str = "com.openai.codex"`, `TITLE_MAX: usize = 256`, `THREAD_LINE_MAX: usize = 512` (bytes
    written, the `\n` the watch's writer adds included: macOS's `PIPE_BUF`), `TRUST_AGAIN: Duration = 1 s`,
    `AX_SETTINGS: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"`.
  - `fn thread_line(title: Option<&str>) -> String` — `{"thread":"…"}` by `serde_json`, the empty title for `None`, one
    over `TITLE_MAX` UTF-16 units, one with a `char::is_control` character, or one whose line plus `\n` would pass
    `THREAD_LINE_MAX` bytes.
  - `fn chatgpt_installed(home: &Path, applications: &Path, bundle_id: &dyn Fn(&Path) -> Option<String>) -> bool` —
    `applications/ChatGPT.app`, then `home/Applications/ChatGPT.app`, whose `bundle_id` is `CHATGPT_BUNDLE`.
  - `enum Heard { Title(Option<String>), NoObserver }` (`Debug, Clone, PartialEq`).
  - `trait ChatgptWindow: Send + Sync { fn installed(&self) -> bool; fn observe(&self, heard: Box<dyn Fn(Heard) + Send + Sync>) -> Option<Box<dyn Send>>; }`
    — `observe`: None when the app in front is not ChatGPT; otherwise the observation, which stops when dropped, and
    `heard` gets the title now, once, then at each change, or `NoObserver` once when the observer could not be made.
  - `trait AxTrust: Send + Sync { fn trusted(&self) -> bool; fn prompt(&self); fn start(&self, changed: Box<dyn Fn() + Send + Sync>); }`
  - `trait FollowDoor: ChatgptWindow + AxTrust {}` with `impl<T: ChatgptWindow + AxTrust> FollowDoor for T {}`.
  - `struct NoFollow;` — installed false, observe None, trusted false, prompt and start do nothing.
  - `fn system(home: PathBuf) -> Arc<dyn FollowDoor>` — `NoFollow` on every platform for now (Task 3 gives macOS its
    door).
  - `enum Observer { Start(u64), Stop, Same }`; `struct Shown { pub trusted: bool, pub installed: bool }`
    (`Clone, Copy, Debug, Default, PartialEq, Eq`).
  - `#[derive(Default)] struct ChatgptFollow` with `front(&mut self, bundle: &str)`, `watching(&mut self, on: bool)`
    (a new watch is detached, as `TabFollow`), `attached(&mut self, on: bool)`, `trusted(&mut self, on: bool)`,
    `installed(&mut self, on: bool)`, `observes(&self) -> bool`, `observer(&mut self) -> Observer` (a new start number
    when observing should start, `Stop` when it should end, else `Same`), `heard(&mut self, start: u64, heard: Heard) -> crate::tabs::Out`,
    `take_offer(&mut self) -> bool`, `take_look(&mut self) -> bool` (true once after each attach: `installed` is to be
    read), `shown(&self) -> Shown`.

- [ ] **Step 1: Write the failing tests** in `follow.rs`'s `mod tests`:
  - `a_thread_line_is_the_title_or_the_empty_title`: `Some("Fix login")` → `{"thread":"Fix login"}`; `None` →
    `{"thread":""}`; `"a".repeat(256)` kept, `"a".repeat(257)` → empty (units); `"🦀".repeat(124)` kept (510 bytes
    with `\n`), `"🦀".repeat(125)` → empty (bytes), `"🦀".repeat(129)` → empty; `"\u{4e00}".repeat(166)` kept (512),
    `"\u{4e00}".repeat(167)` → empty; `"\"".repeat(249)` kept (512, escaped), `"\"".repeat(250)` → empty;
    `"a\nb"`, `"a\u{7f}"`, `"a\u{85}"`, `"a\u{9f}"`, `"\u{0}"` → empty; `"a\"b"` and `"a\\b"` kept (escaped, not
    refused).
  - `the_longest_thread_line_is_one_atomic_pipe_write` (as `front.rs`'s `the_longest_line_is_one_atomic_pipe_write`):
    for `"\u{4e00}"`, `"🦀"`, `"\""`, `"\\"`, `"a"`, each repeated 1 to 300 times, `thread_line(..).len() + 1 <= 512`
    and the line holds no `\n` or `\r`.
  - `it_observes_only_with_chatgpt_in_front_a_watch_the_dial_and_the_permission`: each of the four alone and in threes
    → `observes()` false and `observer()` `Same`; all four → `Start(n)`, then `Same`.
  - `a_front_change_a_detach_a_watch_ending_or_the_permission_going_stops_it`: from observing, each of
    `front("com.microsoft.VSCode")`, `attached(false)`, `watching(false)`, `watching(true)`, `trusted(false)` →
    `observer()` `Stop`; back to all four → a new `Start` with a larger number.
  - `each_start_writes_its_first_title_even_the_last_one_and_a_repeat_none`: `heard(n, Title(Some("A")))` → line A;
    again → none; `Title(Some("B"))` → B; `Title(None)` → the empty line; after a stop and a new start `m`, `Title(Some("A"))`
    → A again, then a repeat none.
  - `a_title_from_an_earlier_start_is_dropped`: after start `m` replaced `n`, `heard(n, …)` → no line, no log.
  - `no_observer_is_one_log_line_a_start`: `heard(n, NoObserver)` → log `["chatgpt: no observer"]`, again → none; the
    next start's `NoObserver` → the line again: "a start" is each start of observing, so ChatGPT coming to the front
    again tries again (after `NoObserver`, a stop and the four conditions again give a new `Start`).
  - `the_offer_comes_when_chatgpt_comes_to_the_front_untrusted`: the first `front` value is ChatGPT (in front at start)
    → `take_offer()` false; another app, then ChatGPT, with a watch, the dial attached, installed, untrusted → true,
    then false; ChatGPT again with no other app between → false; each of trusted, not installed, no watch, detached
    → false.
  - `installed_is_looked_for_once_each_attach`: `attached(true)` → `take_look()` true, then false; a status that says
    attached again → false; detach and attach → true.
  - `shown_is_the_permission_and_the_app_installed`.
  - `installed_is_chatgpt_app_in_applications_or_the_home_applications_with_the_codex_bundle_id`: a fake `bundle_id`
    answering per path: `/Applications` one with `com.openai.codex` → true; only `~/Applications` → true; another id or
    none → false; the paths asked are exactly the two (in that order).
  - `no_follow_reads_nothing_and_asks_nothing`.
  - `no_line_or_log_holds_a_title`: every `Out.log` from the runs above holds neither title.
- [ ] **Step 2: Run them to see them fail:** `cd device-app/src-tauri && cargo test --lib follow::` → FAIL (no module).
- [ ] **Step 3: Implement** `follow.rs` and add `pub mod follow;` to `lib.rs`. Module doc: the title is private like a
  tty (the watch's stdin and nowhere else); comments say why each rule is (the CLI's limit, `PIPE_BUF` for the byte
  cut, "push, no poll", the generation against a late title).
- [ ] **Step 4: Run** `cargo test --lib follow::` → PASS; then `cargo test --lib` → PASS.
- [ ] **Step 5: Commit** `feat(device-app): the rules for following the ChatGPT window`.

---

### Task 2: The menu item, the screen and Allow in the app's rules

**Files:**
- Modify: `device-app/src-tauri/src/types.rs`, `state.rs` (tests), `model.rs`, `app.rs`, `runner.rs` (`Doors`, `run`,
  tests), `main.rs` (`Doors`, `menu_id`, `menu_action`, its test)

**Interfaces:**
- Consumes: `follow::{FollowDoor, NoFollow, AX_SETTINGS, system}` (Task 1).
- Produces:
  - `Saved` gains `#[serde(default)] pub asked_follow: bool` and `#[serde(default)] pub asked_ax: bool` (`askedFollow`,
    `askedAx`; `Saved::default()` false).
  - `Screen::Follow` (`"follow"`), `Action::Allow` (`"allow"`), `MenuAction::FollowChatgpt` (the unchecked item's
    click) and `MenuAction::FollowSettings` (the checked item's).
  - `#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)] pub struct FollowState { pub trusted: bool, pub installed: bool, pub waiting: bool }`
    and `AppState.follow: FollowState` (`waiting`: the screen opened by itself waits behind Install or Sign in).
  - `Event::Follow { trusted: bool, installed: bool }`, `Event::FollowOffer`, `Effect::AskAx`, `Effect::OpenAxSettings`.
  - `Doors.follow: Arc<dyn FollowDoor>`; `main.rs` sets it to `follow::system(paths.home_dir()?)`.
  - Menu ids `follow_chatgpt`, `follow_settings`.

- [ ] **Step 1: Write the failing tests.**
  - `types.rs`: `the_window_may_ask_five_things` (adds `("allow", Action::Allow)`; `"not_now"` stays refused);
    `state_json_keys` (`"askedFollow": false, "askedAx": false` beside the four); `a_view_is_the_json_the_window_reads`
    adds `Screen::Follow` → `"follow"`.
  - `state.rs`: `an_old_file_without_the_follow_keys_keeps_asked_sign_in` —
    `{"version":1,"cliSeen":true,"askedSignIn":true,"loginItem":true}` loads as
    `Saved { cli_seen: true, asked_sign_in: true, login_item: true, ..Saved::default() }` with no log line;
    `the_follow_keys_read_back`. (Struct literals of `Saved` in the existing tests take `..Saved::default()`.)
  - `model.rs` `the_follow_item`: with a dial that has Sound and Notifications and `follow.installed`, the item is
    `Check(MenuAction::FollowChatgpt, "Follow ChatGPT", false)` right after the Notifications submenu and before the
    separator; trusted → `Check(MenuAction::FollowSettings, "Follow ChatGPT", true)`; with `AppUpdate::Installing` the
    update row comes after it; with a dial without settings it comes after `Signed in`; absent when not installed, with
    no dial, or with the dial detached. `the_follow_screen_is_due_after_install_and_sign_in`: `waiting` → `Some(Screen::Follow)`;
    Install or Sign in due → that one; `waiting` and trusted → None. `the_menu_as_a_log_line` gains
    `… | Notifications: All | Follow ChatGPT ✓ | …`. `states()` keeps covering every state (no agent or Orca row).
  - `app.rs`:
    - `the_offer_opens_the_follow_screen_once_and_remembers_it`: `Event::FollowOffer` → `Save(… asked_follow: true …)`
      and `Show(Some(View { screen: Follow, phase: Offer, lines: [] }))`; after Not now, a second offer → no `Show`, no
      `Save`.
    - `the_offer_never_covers_install_or_sign_in`: with the Sign in offer shown, an offer shows nothing; Sign in's
      Later then shows the Follow screen. With the install running, the same.
    - `allow_asks_macos_each_time_and_opens_the_settings_after_the_first`: first Allow → `AskAx`, no
      `OpenAxSettings`, `Save(… asked_ax: true …)`, `Log("chatgpt: asked")`; the screen again from the menu, Allow →
      `AskAx` and `OpenAxSettings`, no `Save`, `Log("chatgpt: asked")`.
    - `allow_closes_the_window`: Allow's effects include `Show(None)`, the first time and after it.
    - `the_permission_given_closes_the_follow_screen`: the Follow screen shown (by the offer, and again from the menu),
      an `Event::Follow` that turns trusted → `Show(None)` and `waiting` false; the same event with another screen
      shown (Sign in) or no window → no `Show`.
    - `not_now_and_closing_close_the_follow_screen`: `Act(Later)` → `Show(None)` and `waiting` false; reopened from
      the menu, `WindowClosed` → `Show(None)`; neither saves anything.
    - `the_follow_item_opens_the_screen_unchecked_and_the_settings_checked_and_draws_the_menu_again`:
      `Menu(FollowChatgpt)` → `Show(Some(follow offer))` and `Menu(<the last menu>)`; `Menu(FollowSettings)` →
      `OpenAxSettings` and `Menu(<the last menu>)`.
    - `a_permission_change_redraws_the_menu_and_says_follow_on_or_off`: with an attached dial, `Event::Follow { trusted: true, installed: true }`
      → a `Menu` holding the checked item and `Log("chatgpt: follow on")`; the same event again → neither; trusted
      false → `Log("chatgpt: follow off")`; an `installed` change alone → a `Menu`, no log.
    - `only_allow_and_not_now_act_on_the_follow_screen`: `Retry`, `SignIn`, `Cancel` there → no effects.
  - `runner.rs`: `allow_asks_macos_and_the_settings_open_with_one_fixed_argument` — a door double counting `prompt`:
    `run(Effect::AskAx)` → one prompt, `None` returned; `run(Effect::OpenAxSettings)` → `opened == [[AX_SETTINGS]]`;
    `the_binary_gets_its_four_effects_back` lists the two new effects among the runner's. The tests' `doors()` sets
    `follow: Arc::new(NoFollow)`.
  - `main.rs` `every_menu_action_has_its_own_id`: 13 actions, `menu_id(FollowChatgpt) == "follow_chatgpt"`,
    `menu_id(FollowSettings) == "follow_settings"`.
- [ ] **Step 2: Run them to see them fail:** `cd device-app/src-tauri && cargo test --lib` → FAIL (compile errors on the
  new names count as the red; record which tests).
- [ ] **Step 3: Implement.** `model.rs`: the item after the Notifications submenu, shown when `follow.installed` and the
  dial is attached; `due()` gives `Screen::Follow` last, when `waiting` and not trusted. `app.rs`: `Event::Follow`
  updates `state.follow` (log on a change of `trusted`; trusted clears `waiting` and closes a Follow screen that shows,
  and only that screen); `Event::FollowOffer` does nothing when `asked_follow` is set, else remembers it, sets `waiting`
  and, with no window, shows `due()`; `act` handles `(Follow, Offer, Allow)` (its effects, then `Show(None)`) and
  `(Follow, Offer, Later)`;
  `WindowClosed` on Follow is Not now; `view_of(Screen::Follow)` is the offer. `runner.rs` `run`: `AskAx` →
  `doors.follow.prompt()` on the caller's thread; `OpenAxSettings` → `shared.open(&[AX_SETTINGS], "accessibility settings")`.
  `main.rs`: `Doors.follow`, the two ids in `menu_id` and `menu_action`.
- [ ] **Step 4: Run** `cargo test --lib` and `cargo test --locked` (`main.rs`'s tests; needs `ui/dist`: `cd ../ui && npm run build` first) → PASS.
- [ ] **Step 5: Commit** `feat(device-app): Follow ChatGPT in the menu, its screen and Allow`.

---

### Task 3: The macOS door: Accessibility, the observer, the permission

**Files:**
- Create: `device-app/src-tauri/src/follow_macos.rs`
- Modify: `device-app/src-tauri/src/follow.rs` (`system`; one test), `lib.rs` (`#[cfg(target_os = "macos")] pub mod follow_macos;`),
  `device-app/src-tauri/Cargo.toml`, `device-app/src-tauri/Cargo.lock`

**Interfaces:**
- Consumes: Task 1's traits, `Heard`, `CHATGPT_BUNDLE`, `chatgpt_installed`.
- Produces: `pub struct MacFollow` (`MacFollow::new(home: PathBuf)`) implementing `ChatgptWindow` and `AxTrust`;
  `follow::system(home)` returns it on macOS, `NoFollow` elsewhere. Private, for its tests:
  `fn bundle_id(app: &Path) -> Option<String>`, `MacFollow::installed_in(&self, applications: &Path) -> bool`
  (`installed()` is `installed_in(Path::new("/Applications"))`), and
  `fn observe_pid(pid: libc::pid_t, heard: Box<dyn Fn(Heard) + Send + Sync>, ended: impl FnOnce() + Send + 'static) -> Box<dyn Send>`
  (`observe` passes a no-op `ended`).
- Crates (macOS target only; checked in the crates.io index on 2026-11-20, all of the objc2 0.6 family the app pins):
  - add `objc2-application-services = { version = "0.3", default-features = false, features = ["std", "HIServices", "AXUIElement", "AXError"] }`
    (0.3.2; `AXUIElement` turns on `objc2-core-foundation/CFRunLoop`, `CFArray`, `CFDictionary`). Before writing code,
    confirm in its `Cargo.toml`/docs that these features gate `AXUIElementCreateApplication`,
    `AXUIElementCopyAttributeValue`, `AXUIElementSetMessagingTimeout`, `AXObserverCreate`, `AXObserverAddNotification`,
    `AXObserverRemoveNotification`, `AXObserverGetRunLoopSource`, `AXIsProcessTrusted`,
    `AXIsProcessTrustedWithOptions` and `kAXTrustedCheckOptionPrompt`; add a feature only if one is missing, and say so.
  - add `objc2-core-foundation = { version = "0.3", default-features = false, features = ["std", "CFRunLoop", "CFString", "CFDictionary", "CFNumber", "CFNotificationCenter"] }`
    (0.3.2, already in `Cargo.lock` as a dependency of the others).
  - `objc2-foundation`: no new feature (see Decisions). `objc2-app-kit` already has `NSWorkspace`, `NSRunningApplication`.
  - `Cargo.lock` gains `objc2-application-services` (run `cargo check` on the Mac; commit the lock: Linux CI runs
    `cargo test --locked`, and a lock is the same for every target).

- [ ] **Step 1: Write the failing tests.**
  - In `follow.rs` (runs on Linux CI too): `the_mac_door_reads_only_the_focused_windows_title_and_sets_nothing` — over
    `include_str!("follow_macos.rs")` with `//` comments stripped: the set of string literals matching `"AX[A-Za-z]*"`
    is exactly `{"AXFocusedWindow", "AXTitle", "AXFocusedWindowChanged", "AXTitleChanged"}`; none of
    `SetAttributeValue`, `set_attribute_value`, `PerformAction`, `perform_action`, `AXManualAccessibility`,
    `AXEnhancedUserInterface` appears; `com.apple.accessibility.api` and the messaging timeout call appear.
  - In `follow_macos.rs` (macOS only):
    - `a_bundle_id_is_read_from_its_info_plist`: a temp `X.app/Contents/Info.plist` (XML, `CFBundleIdentifier`
      `com.openai.codex`) → `Some`; no plist, a plist without the key, a folder in its place → `None`.
    - `installed_reads_only_the_two_places`: `MacFollow::new(<temp home>)` with a fake `~/Applications/ChatGPT.app`,
      `installed_in(<an empty temp folder>)` → true; without the fake → false. Never the real `/Applications`.
    - `the_observer_thread_ends_when_its_handle_is_dropped`: `observe_pid(<this test's own pid>, heard, ended)` dropped
      at once, and once more after its first `heard`, each `ended` within 5 s, whether or not this process may use
      Accessibility; the drop itself returns at once.
    - `the_permission_is_read_and_its_notification_registered`: `trusted()` returns (either answer); `start(cb)`
      returns. No test calls `prompt()` or `observe()`.
- [ ] **Step 2: Run them to see them fail:** on Linux or the Mac, `cargo test --lib follow::` → the scan test FAILS (no
  file); on the Mac, `cargo test --lib follow_macos::` → FAIL (no module).
- [ ] **Step 3: Implement** `follow_macos.rs`:
  - `observe(heard)`: `NSWorkspace::sharedWorkspace().frontmostApplication()`; None unless its `bundleIdentifier` is
    `CHATGPT_BUNDLE`; else `Some(observe_pid(app.processIdentifier(), heard, || {}))`.
  - `observe_pid(pid, heard, ended)` spawns the observer thread and waits only for its `CFRunLoop::current()` (sent
    before any AX call). The thread: the application element with a 1 s messaging timeout; `AXObserverCreate(pid, callback)`
    and `AXObserverAddNotification` of the two names on the application element (any failure: `heard(NoObserver)`,
    clean up, end); the observer's source on its run loop in the default mode; `heard(Title(read_title(app)))`; run the
    loop; once it returns, remove both notifications and the source, then `ended()`. The callback reads the title again
    and calls `heard`. `read_title`: the application's `AXFocusedWindow`, a 1 s timeout on that element, its `AXTitle`
    as a `String`; any error or no window → `None`.
  - The handle's `Drop` calls `CFRunLoopStop` on the thread's run loop and returns: a stop before the loop runs is kept
    by the run loop and honoured as it starts, so an at-once drop is never lost. A `CFRunLoop` may be stopped from
    another thread (CoreFoundation's thread-safety rules); if the binding's type is not `Send`, wrap it with a `SAFETY`
    comment saying so.
  - `trusted()` → `AXIsProcessTrusted()`; `prompt()` → `AXIsProcessTrustedWithOptions` with
    `{kAXTrustedCheckOptionPrompt: kCFBooleanTrue}`; `start(changed)` → the distributed center's observer for
    `com.apple.accessibility.api`, object none, `DeliverImmediately`, its context a box kept for the app's life (as
    `MacFront`'s observer is).
  - `installed()` → `chatgpt_installed(&home, Path::new("/Applications"), &bundle_id)`; `bundle_id` reads
    `Contents/Info.plist` with `NSDictionary::dictionaryWithContentsOfURL_error` and takes `CFBundleIdentifier` as a
    string.
  - `follow::system` returns `Arc::new(MacFollow::new(home))` under `cfg(target_os = "macos")`.
  - Every `unsafe` block has its `SAFETY` comment; comments say why (a hung ChatGPT, no attribute set, the pid of the app
    in front because a lookup by bundle id can return several).
- [ ] **Step 4: Run** on the Mac: `cargo test --lib` (all, `follow_macos::` included) and `cargo build`; on Linux the
  scan test passes with the rest (`cargo test --lib`, a Linux container or CI).
- [ ] **Step 5: Commit** `feat(device-app): read the ChatGPT window's title through Accessibility on macOS`.

---

### Task 4: The runner follows ChatGPT

**Files:**
- Modify: `device-app/src-tauri/src/runner.rs`, `device-app/src-tauri/src/watch.rs`

**Interfaces:**
- Consumes: Task 1's `ChatgptFollow`, `Observer`, `Heard`, `Shown`, `FollowDoor`, `CHATGPT_BUNDLE`, `TRUST_AGAIN`;
  Task 2's `Doors.follow`, `Event::{Follow, FollowOffer}`.
- Produces: `Watch::thread(&self, line: &str)` (as `tab`: a title is as private as a tty); `Runner::polling_every(doors, send, every, trust_again)`
  (the tests' constructor; `Runner::new` passes `POLL_EVERY` and `TRUST_AGAIN`); a follow thread that ends with the runner.

- [ ] **Step 1: Write the failing tests** in `runner.rs` with a door double (`struct Chatgpt`) that keeps each `observe`'s
  `heard` and a flag its handle sets when dropped, counts `trusted()`, `installed()` and `prompt()` calls, keeps
  `start`'s `changed`, and can hold `observe` on a gate:
  - `the_chatgpt_title_is_written_to_the_watch_with_chatgpt_in_front_the_dial_attached_and_the_permission`: front
    `com.openai.codex`, trusted, an `ATTACHED` watch → one observe; `heard(Title(Some("Fix login")))` → stdin is
    `[{"front":"com.openai.codex"}, {"thread":"Fix login"}]`.
  - `nothing_is_observed_without_the_permission_the_dial_or_chatgpt_in_front` (`still` for ten ticks).
  - `the_observer_is_dropped_when_chatgpt_leaves_the_dial_detaches_the_watch_ends_or_the_permission_goes`: each stop
    drops the handle; coming back observes again and its first title is written even when it is the last one.
  - `a_title_heard_after_its_observer_was_dropped_is_written_nowhere`.
  - `the_permission_is_read_at_the_notification_and_once_more_a_moment_later`: `changed()` → one `trusted()` read at
    once and one more after `trust_again`; a revocation heard on the second read drops the observer.
  - `a_change_of_the_permission_or_of_the_app_installed_is_one_follow_event`: the dial attaches → one `installed()`
    read and `Event::Follow { trusted: false, installed: true }`; a notification that finds trust →
    `Event::Follow { trusted: true, installed: true }`; nothing that changes neither sends one.
  - `the_offer_is_one_event_when_chatgpt_comes_to_the_front_and_none_for_the_app_in_front_at_start`: ChatGPT in front
    as the runner starts, attached, installed, untrusted → no `FollowOffer`; VS Code, then ChatGPT → one; the front's
    `trusted()` is read before the offer is judged.
  - `no_observer_is_one_log_line_each_time_observing_starts`: the door's `heard(NoObserver)` → the log has
    `chatgpt: no observer` once and nothing is written; VS Code, then ChatGPT again → `observe` is called again, and its
    `NoObserver` logs the line a second time.
  - `a_chatgpt_that_hangs_holds_back_no_front_line` (Review Focus 3): `observe` held on its gate, the front changes to
    VS Code → `{"front":"com.microsoft.VSCode"}` reaches stdin while the gate is still shut.
  - `nothing_of_a_title_reaches_the_log_an_event_or_the_state_file`: after titles `"Secret thread"` and others, no log
    line, event or saved state holds them.
  - `the_follow_thread_ends_with_the_runner` (as `the_tab_thread_ends_with_the_runner`).
- [ ] **Step 2: Run them to see them fail:** `cargo test --lib runner::` → FAIL.
- [ ] **Step 3: Implement.** `Shared` gains the follow state (`ChatgptFollow`, the time a trust read is due again,
  `ended`) behind a mutex and a condvar. At start: `trusted()` read, `doors.follow.start(changed)` (weakly, as the front
  source), the follow thread spawned. `front_changed`: for ChatGPT's bundle, `trusted()` first, then `front`.
  `spawn_watch` / `StopWatch` / the watch's events: `watching`, `attached`, as for the tabs, inside the same locks.
  The notification: `trusted()` now, and a read due `trust_again` later. The follow thread waits on the condvar (a
  timeout only for the due read) and, with no lock held: reads `installed()` when `take_look()`; starts
  (`observe` with a `heard` that carries the start number and holds the runner weakly) or drops the observation as
  `observer()` says; sends `Event::Follow` when `shown()` changed from what it last sent (starting at `Shown::default()`),
  and `Event::FollowOffer` when `take_offer()`. `heard`: lock `watch`, then the follow state; write the line with
  `Watch::thread`; each log line to the log. Runner `Drop` ends the follow thread as it ends the tab thread.
- [ ] **Step 4: Run** `cargo test --lib` → PASS (every existing runner test unchanged: `NoFollow` sends no event).
- [ ] **Step 5: Commit** `feat(device-app): the dial follows the thread in front in ChatGPT`.

---

### Task 5: The window's Follow ChatGPT screen

**Files:**
- Modify: `device-app/ui/src/api.ts` (`Screen` adds `'follow'`, `Action` adds `'allow'`), `screens.ts` (the
  `'follow.offer'` face; the file's first comment says three screens), `gallery.ts` (one state), `api.test.ts`,
  `screens.test.ts`, `gallery.test.ts`

**Interfaces:**
- Produces: `View { screen: 'follow', phase: 'offer', lines: [] }` drawn as heading `Follow ChatGPT`, one body
  paragraph (the spec's two sentences, exact), buttons `Not now` (`later`) then `Allow` (`allow`, primary, focused).

- [ ] **Step 1: Write the failing tests.**
  - `screens.test.ts` `follow: Allow, Not now`: mount `at('follow', 'offer')` → heading `Follow ChatGPT`; text contains
    `Your dial moves to the thread you open in ChatGPT. Harness reads only the ChatGPT window's title, while ChatGPT is in front.`;
    buttons `['Not now', 'Allow']`; focus on `Allow` (Return takes it); `click('Allow')` → `act('allow')`;
    `click('Not now')` → `act('later')`. The primary table gains `['follow', 'offer', 'Allow']`; the screen-reader test
    gains Allow described by the body.
  - `api.test.ts`: `act('allow')` → `invoke('act', { action: 'allow' })`.
  - `gallery.test.ts`: `STATES` has 9; `CONTRACT_PAIRS` gains `'follow.offer'`; still one focused frame per theme,
    `Sign in`.
- [ ] **Step 2: Run them to see them fail:** `cd device-app/ui && npx vitest run` → FAIL; `npm run typecheck` → FAIL.
- [ ] **Step 3: Implement** the face, the types and `{ name: 'Follow ChatGPT · offer', view: { screen: 'follow', phase: 'offer', lines: [] } }`
  after the Sign in states.
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run build && npm run gallery` → PASS.
- [ ] **Step 5: Commit** `feat(device-app): the Follow ChatGPT screen`.

---

### Task 6: The thread title rule

**Files:**
- Create: `cli/src/cable/hosts/threadTitle.ts` (imports nothing: the watch loads it), `cli/src/cable/hosts/threadTitle.spec.ts`

**Interfaces:**
- Produces: `export const THREAD_TITLE_MAX = 256`; `export function threadTitleOf(value: unknown): string | null` — the
  string itself when it is a string of at most 256 UTF-16 units (`length`) with no character in
  `/[\u0000-\u001f\u007f-\u009f]/`; else null. The empty string passes.

- [ ] **Step 1: Write the failing test** `threadTitle.spec.ts` `the same titles as Harness Device`: every title Task 1's
  `a_thread_line_is_the_title_or_the_empty_title` keeps passes here (256 `a`, 124 `🦀`, 166 `一`, 249 `"`, `a"b`,
  `a\\b`, `''`); the ones Rust empties only by its 512-byte cut pass here too (125 and 128 `🦀`, 167 `一`, 250 `"`:
  the CLI keeps 256 units, Rust is the stricter); 257 `a`, 129 `🦀`, `a\nb`, `a\u007f`, `a\u0085`, `a\u009f`,
  `\u0000` are null; `5`, `null`, `{}`, `[]` are null. A comment names the Rust test as the other half and says why the
  byte cut is Rust's alone (`PIPE_BUF` is the pipe's, not the listener's).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/threadTitle.spec.ts` → FAIL (no module).
- [ ] **Step 3: Implement** the file; its comment says why the two rules match Harness Device's (`follow.rs`).
- [ ] **Step 4: Run** the spec and `npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(cli): the ChatGPT window title the dial follows`.

---

### Task 7: The watch tells the thread

**Files:**
- Modify: `cli/src/devices/client.ts`, `cli/src/devices/client.spec.ts`

**Interfaces:**
- Consumes: `threadTitleOf` (Task 6).
- Produces: `DialWatchDeps.tell`'s message union gains `{ type: 'thread'; title: string }`; the `stdin` doc names the
  `{"thread":"<title>"}` line.

- [ ] **Step 1: Write the failing tests** in a new `describe('harness hardware watch: the ChatGPT thread')` (fake timers
  as the tab block; `threadLine = (value) => \`${JSON.stringify({ thread: value })}\n\``):
  - `a thread line is told to the devices listener as a thread message`: `"Fix login"` → `{ type: 'thread', title: 'Fix login' }`;
    `""` → `{ type: 'thread', title: '' }`.
  - `a title out of rule, one that is not a string and a line with another key are dropped, and the next line is told`:
    257 `a`, `a\nb`, `5`, `null`, `{"thread":"x","pad":1}` → nothing told; then `"Next"` → told.
  - `two thread lines while a tell is under way: the newest is told when it ends, the one between is skipped`.
  - `a thread tell does not wait for a front or a tab tell under way`.
  - `nothing of a thread goes on the core's socket, stdout or stderr`.
  - `stdin closing with a thread tell waiting leaves no timer`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/client.spec.ts` → FAIL.
- [ ] **Step 3: Implement** a thread slot like `tellTab` (one at a time, `TELL_GAP_MS` after each, the newest last; one
  not taken is not tried again), the line taken only with `thread` its one key (as `muted`'s), and
  `clearTimeout` of its gap in `finish`. Update `FRONT_LINE_MAX`'s comment: Harness Device writes a thread line of at
  most 512 bytes (`PIPE_BUF`), and the longest the watch's own 256-unit rule takes (256 three-byte letters) is 781 bytes,
  both under the cap.
- [ ] **Step 4: Run** the spec and `npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(cli): the watch tells the devices the ChatGPT thread in front`.

---

### Task 8: The listener takes the thread

**Files:**
- Modify: `cli/src/services/devicesListener.ts`, `cli/src/services/devicesListener.spec.ts`

**Interfaces:**
- Consumes: `threadTitleOf` (Task 6).
- Produces: `export const THREAD_PER_SECOND = 10`; `export const THREAD_MAX_BYTES = 1024` (comment: the longest message
  `{"type":"thread","title":…}` with 256 three-byte letters is 795 bytes); `export function threadHandler(report: (title: string) => void): ListenerHandler`
  — `threadTitleOf(message.title)` checked again, `REFUSED` otherwise; keeps nothing, logs nothing.

- [ ] **Step 1: Write the failing tests** in `describe('thread')`: a 1024-byte message is 204 and a 1025-byte one 413;
  the 11th in a second on one connection is 429; a title out of rule, not a string, or missing is `REFUSED` and never
  reported; `''` is reported; `the thread handler holds nothing: it is its two limits and handle` (as front's).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devicesListener.spec.ts` → FAIL.
- [ ] **Step 3: Implement** beside `tabHandler`; the file's head comment names `thread` among what the watch tells.
- [ ] **Step 4: Run** the spec, `npm run typecheck` and `npm run test:core` (100% for `devicesListener.ts`) → PASS.
- [ ] **Step 5: Commit** `feat(cli): the devices listener takes the ChatGPT thread`.

---

### Task 9: A title is matched to one thread

**Files:**
- Modify: `cli/src/cable/hosts/codexAppThreads.ts`, `codexAppThreads.spec.ts`, `cli/src/cable/hosts/codexAppSource.ts`,
  `codexAppSource.spec.ts`, `cli/src/services/devices.spec.ts` (`noCodexApp` and `withThreads`' reader gain `names`)

**Interfaces:**
- Produces:
  - `CodexAppThreads.names(ids: readonly string[]): ReadonlyMap<string, string>` — Codex's own name of each id that has
    one, trimmed and whole (not `observedTitle`'s 64-character cut), through `codexThreadName(id, this.home)` (its
    cache reads `session_index.jsonl` at most once for them all); empty unless the index is a regular file (the FIFO
    guard `namesOf` has). The folder fallback is never a name here.
  - `CodexAppSourceDeps['threads']` is `Pick<CodexAppThreads, 'there' | 'read' | 'forget' | 'names'>`.
  - `export type ThreadMatch = { threadId: string } | 'none' | 'ambiguous'` and `CodexAppSource.threadNamed(title: string): ThreadMatch`
    — over the ids of the last good read (`read.order`, every kept thread up to 200, not only the 16 listed; a failed
    read keeps them; cleared on `stop`): exactly one whose name, trimmed, equals the trimmed title → its id; none →
    `'none'`; two or more → `'ambiguous'`. Stopped, or a title empty once trimmed → `'none'` without asking `names`.

- [ ] **Step 1: Write the failing tests.**
  - `codexAppThreads.spec.ts` `describe('names(ids)')`: a 100-character name comes back whole; `'  Spaced  '` comes back
    `'Spaced'`; an id with no name is absent; no index, or an index that is a FIFO, gives an empty map at once;
    `a name Codex gives after the last read is matched` half: a name appended after a `read()` is in the next
    `names()` (Review Focus 4).
  - `codexAppSource.spec.ts` `describe('threadNamed')`: one name → `{ threadId }`; a thread kept but not among the 16
    listed matches (fixture of 20 threads); two threads of one name → `'ambiguous'`; no thread of that name →
    `'none'`; `trims both sides and keeps case` (`' Fix login '` matches `Fix login`, `'fix login'` does not, `'   '`
    → `'none'` with `names` not asked) (Review Focus 5); after a failed read the last good ids still match; after
    `stop()` → `'none'` and `names` not asked; `a name Codex gives after the last read is matched` (a fake whose
    `names` answers the new name).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/codexAppThreads.spec.ts src/cable/hosts/codexAppSource.spec.ts` → FAIL.
- [ ] **Step 3: Implement** both; give the two `devices.spec.ts` reader fakes `names: () => new Map()`. Comments: why the
  raw name (the window shows Codex's name whole), why all kept ids (a thread low in the sidebar is still opened), why
  one `codexThreadName` call per id and no batch lookup in `sessionTitle.ts` (the core's process loads it: rule 7; up
  to 200 calls a followed report, accepted by the PM, 2026-11-20).
- [ ] **Step 4: Run** both specs, `npx vitest run src/services/devices.spec.ts` and `npm run typecheck` → PASS.
- [ ] **Step 5: Measure** `threadNamed` over 200 ids against a real-file index (the `names(ids)` fixture written with
  200 named threads, the cache cold, then warm): a throwaway script or a one-off run with a `performance.now()` pair,
  not committed and not asserted (no timing test). Report both times (median of 20 runs each, the machine named) for
  the pull request's numbers.
- [ ] **Step 6: Commit** `feat(cli): match the ChatGPT window title to one Codex thread`.

---

### Task 10: The devices follow the thread

**Files:**
- Modify: `cli/src/services/devices.ts`, `cli/src/services/devices.spec.ts`, `cli/src/cable/cableSession.ts`
  (`FollowCause` gains `'thread'`, its doc names the thread opened in the ChatGPT app)

**Interfaces:**
- Consumes: `threadHandler` (Task 8), `CodexAppSource.threadNamed`, `ThreadMatch` (Task 9).
- Produces: in `devices.ts`: `FOLLOWED.thread = { moved: '[device] thread · moved', 'no-tile': '[device] thread · skipped · no tile' }`;
  `const codexSwitches = dialMovesTo()`; `codexNoted` notes `codexSwitches.note(pane.id)` in `show` and `focus` before
  the move is noted (its comment "No echo to guard" goes); `threadReported(title)`, `threadSettled(app)`,
  `followThread(report, atSettle)` beside the tab follow; the listener's `thread:
  threadHandler((title) => part.call('dial', () => threadReported(title)))`; `appSettled` calls
  `threadSettled(app)` beside `tabSettled(app)`; the stop path clears the waiting report and `codexSwitches`.
- Rules (`followThread`, in this order, each a line or the move): the report is taken; no dial linked → nothing, no
  line; `report.moves !== dialMoves` → `skipped · echo`; at the settle and `dialMovedAt` within `ATTACH_ECHO_MS` →
  `skipped · echo`; `threadNamed` → `'none'` `skipped · no match`, `'ambiguous'` `skipped · ambiguous`;
  `codexSwitches.echo(threadId, report.at)` → `skipped · echo`; else `cable.followLocal(observedAgentId('codex', threadId), 'thread')`.
  `threadReported('')` drops a waiting report and does nothing else. With `codex` settled in front a report is
  followed at once; else it waits, and another app's settle drops it (`skipped · not in front`, only with a dial
  linked).

- [ ] **Step 1: Write the failing tests** in `describe('the thread opened in the ChatGPT app moves the dial (docs/plans/2026-11-20-dial-chatgpt-follow-ax-design.md)')`,
  on `withThreads`' devices (macOS, the reader with names, the dial attached) with the listener's `thread` handler:
  - `with the ChatGPT app settled in front a report follows its thread at once` → `calls('followLocal')` is
    `[[observedAgentId('codex', T1), 'thread']]`.
  - `a report before the settle waits for it, then follows`; `another app settling drops it, said not in front once`.
  - `an empty title drops the waiting report and says nothing`.
  - `no match and ambiguous are one line each, and nothing is followed`.
  - `the dial moving after the report is an echo`; `the dial's own rest or tap on that thread within 2 s is an echo,
    once` (a `focus` or `show` through `codexNoted`, then the report; the next report of it after that follows);
    `a report followed at the settle within 2 s of a dial move is an echo`, and one 2 s after it follows.
  - `the dial's answer is counted: thread · moved, and thread · skipped · no tile` (through `localFollowed`).
  - `with no dial linked nothing is followed or said`.
  - `the match runs only for a report followed` (a reader whose `names` counts calls: a dropped or echoed report asks
    nothing).
  - `the log holds no title, name or thread id`: every `[device] thread` line matches
    `/^\[device\] thread · (moved|skipped · (echo|not in front|no match|ambiguous|no tile))$/`, and the whole log
    holds neither title nor id.
  - `stopping drops the waiting report`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts` → FAIL.
- [ ] **Step 3: Implement** as above; the block's comment points to the spec, as the tab block's does.
- [ ] **Step 4: Run** the spec, `npx vitest run src/cable/cableSession.spec.ts`, `npm run typecheck` and
  `npm run test:core` (100% for `devices.ts`) → PASS.
- [ ] **Step 5: Commit** `feat(cli): the dial follows the thread opened in the ChatGPT app`.

---

### Task 11: End to end on this Mac

**Files:**
- Create: `cli/e2e/dialChatgptFollow.e2e.ts` (`describe.skipIf(process.platform !== 'darwin')`)

**Interfaces:**
- Consumes: `IsolatedDaemon`, `until`, `CLI_ROOT` (`e2e/harness/daemon.ts`), `Desk` (`e2e/harness/desk.ts`),
  `codexAppFixture`, `NEVER_READ` (`src/testing/codexAppFixture.ts`), `devicesListenerPath`, `observedAgentId`; the
  fake app bundle and the inside-the-root checks of `deviceCodexAppThreads.e2e.ts`; the real watch spawned as in
  `dialTerminalFollow.e2e.ts` (`CLI_ENTRY`, its environment checks).

- [ ] **Step 1: Write the test** `the dial follows the thread opened in the ChatGPT app, from the window title on the watch's stdin`:
  1. A daemon of its own (`CABLE_DISABLE: 'false'`); its open, `/Applications` and home inside its root; a fake
     `~/Applications/ChatGPT.app` (Info.plist of `com.openai.codex`); a fixture Codex home in the root's `~/.codex`
     (checked inside the root and not `CODEX_HOME`) with five threads; `fixture.name` gives one Recent thread **that is
     not the list's first row** `Fixture Named` (the dial lands on the first row, and a follow to the agent shown is a
     no-op), and two others the same name `Twice`.
  2. A fake dial with `{ appFilter: 'v1' }`; wait for the ChatGPT page and the five rows.
  3. The real `harness hardware watch --json` under the daemon's environment only (`ADAPTER_DATA_DIR` is the daemon's,
     the listener path is `<dataDir>/devices.sock`, `PORT` is not 18473); it writes `{"front":"com.openai.codex"}`
     first.
  4. `{"thread":"Fixture Named"}` → the dial gets `focus` on that thread's agent and the log says `[device] thread · moved`.
  5. `{"thread":"Twice"}` → `[device] thread · skipped · ambiguous`, and no `focus` on either `Twice` agent after it.
  6. The log holds neither `Fixture Named` nor `Twice`, no thread id, no folder, and not `NEVER_READ`; every
     `[device] thread` line matches Task 10's pattern.
- [ ] **Step 2: Check it can fail:** in the working tree only, remove the `thread:` key from `devices.ts`'s listener
  handlers, run the file → it FAILS waiting for `[device] thread · moved`; restore with
  `git checkout -- cli/src/services/devices.ts`.
- [ ] **Step 3: Run** `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialChatgptFollow.e2e.ts` → PASS.
- [ ] **Step 4: Commit** `test(cli): the dial follows the ChatGPT thread end to end`.

---

### Task 12: Docs

**Files:**
- Modify: `desktop/design/desktop-design-system.md` (§ Harness Device), `device-app/AGENTS.md`, `cli/AGENTS.md` (the
  `devices` row)

- [ ] **Step 1: Write.**
  - Design doc: "sign-in is the one thing it offers" becomes sign-in and, on a Mac with the ChatGPT app, Follow
    ChatGPT; the window has three screens, Install, Sign in and Follow ChatGPT; a new rule bullet: a permission another
    app keeps (macOS's Accessibility) is one check item, checked when given, whose click always asks for more (unchecked:
    the Follow ChatGPT screen; checked: System Settings' Accessibility list) and so has no `…`; its label never changes,
    as every check item's. The menu block gains `✓ Follow ChatGPT` after `Notifications ▸`. The gallery sentence stays
    (the gallery gained the screen in Task 5).
  - `device-app/AGENTS.md`: three screens; five action names (`retry`, `sign_in`, `later`, `cancel`, `allow`); the
    `open` of `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` among the fixed commands;
    "The app in front is private" names the offer cue (`Event::FollowOffer`, valueless, never logged) as the one Event
    derived from it; a new rule "The ChatGPT window's title is private as a tty" (the watch's stdin and nowhere else,
    `follow.rs`); a new rule "What Accessibility reads" (only ChatGPT's focused window's `AXTitle`, on the four
    conditions, nothing set, no action; `follow.rs`'s test holds `follow_macos.rs` to it); "One entitlement" notes
    Accessibility needs none.
  - `cli/AGENTS.md` `devices` row: the ChatGPT app's thread the person opens, followed from the window title Harness
    Device reads (`{"thread"}` on the watch's stdin, the listener's `thread`), matched to Codex's own name of one of the
    ChatGPT source's threads (`codexAppSource.ts` `threadNamed`), and the latest thread report (in memory).
- [ ] **Step 2: Check** the copy against the spec's Copy section word for word.
- [ ] **Step 3: Commit** `docs: Follow ChatGPT in Harness Device and the devices row`.

---

## Pull request

The pull request body says, besides the evidence `AGENTS.md` asks for (each task's red-then-green, the gates below):

- **Platforms:** macOS (Harness Device and the CLI). Linux and Windows: nothing a person sees changes (`NoFollow`;
  the CLI's handler is never sent to). device-app's macOS code is built and tested on a Mac by hand; PR CI is Linux.
- **Release order:** release the CLI before or with Harness Device. Either order is safe: an older CLI drops the
  `thread` line, an older Harness Device sends none.
- **By hand after release (Diego):** the step in Verification 5. There is no real-app gate on this Mac.
- **Numbers:** `threadNamed` over 200 ids, cold and warm, from Task 9's Step 5 (the matcher's one call per id is a
  request-path cost the PM accepted).
- **Gallery:** Diego looks at the Follow ChatGPT screen in both themes himself (Verification 4); no screenshot is
  taken (the PM's rule).

## Verification

1. **End to end, on this Mac** (macOS, an arm64 Node 24, Xcode's command line tools for the process-image helper):
   `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialChatgptFollow.e2e.ts`, then the two
   files it leans on, `e2e/deviceCodexAppThreads.e2e.ts` and `e2e/dialTerminalFollow.e2e.ts`, the same way (the devices
   process and the watch changed under them). Isolation is the e2e harness's own: each `IsolatedDaemon` has a
   throwaway root holding its home, data folder, a port of its own (never 18473), `HARNESS_APPLICATIONS_DIR` (empty)
   and a fake `open` (`HARNESS_OPEN_BIN`, records only); the Codex home is `codexAppFixture` in the root's `~/.codex`
   (it refuses the real one); the ChatGPT app is a fake Info.plist in the root's `~/Applications`; the dial is the fake
   desk (`HARNESSD_TEST_DIAL_PORT`); the watch runs under the daemon's environment only and its listener path is in the
   daemon's data folder. No backend, no Harness Device, no real ChatGPT, `~/.codex`, daemon or tmux. A person sees
   the three files pass. Each takes a few minutes, so they run locally; `cli-e2e.yml` runs Linux shards only (where
   these files skip), so there is no GitHub run of them and no temporary workflow is needed. Proposal for the
   maintainers (not this pull request): a macOS job in `cli-e2e.yml` for the darwin-only dial files.
2. **The CLI's local gates PR CI does not run:** `cd cli && npm run test:core` (100% per file, `devices.ts` and
   `devicesListener.ts`), `npm run typecheck`, and `npx vitest run src/devices/client.spec.ts
   src/services/devicesListener.spec.ts src/services/devices.spec.ts src/cable/hosts/threadTitle.spec.ts
   src/cable/hosts/codexAppSource.spec.ts src/cable/hosts/codexAppThreads.spec.ts src/cable/cableSession.spec.ts`.
   Recorded in the pull request.
3. **device-app on this Mac** (PR CI compiles and tests it on Linux only): `cd device-app/ui && npm run build && npm test
   && npm run typecheck`; then `cd device-app/src-tauri && cargo test --locked --lib` (it compiles `follow_macos.rs` and
   runs its tests; none prompts or reads the real ChatGPT) and `cargo test --locked` (the binary's tests). PR CI's
   `device-app-checks` runs the same on Linux, where the scan of `follow_macos.rs` runs too.
4. **The gallery, for Diego's eye** (the user himself): `cd device-app/ui && npm run gallery`, then
   `open device-app/ui/gallery.html`: the Follow ChatGPT screen in light and dark, its copy, Allow as the primary
   button.
5. **By hand after release, on Diego's own Mac** (the user himself: his login, his ChatGPT app, his dial; listed in the
   pull request, the PM asks him): install the released CLI and Harness Device; plug in the dial; bring ChatGPT to the
   front → the Follow ChatGPT screen opens once; Allow → macOS's Accessibility prompt and the window closes; turn Harness on in System
   Settings → the menu shows `✓ Follow ChatGPT`; open two Codex threads in ChatGPT in turn → the dial moves to each;
   swipe the dial to another ChatGPT thread → no bounce back; turn Harness off in System Settings → the item unchecks
   and the dial stops following. Nothing here runs against production: the follow uses no backend.

## Decisions (the PM, 2026-11-20)

1. **Allow closes the window at once**, and a grant heard while the Follow screen shows closes it too (Task 2).
2. **Rust also sends the empty title when the line would pass 512 bytes** (`PIPE_BUF`); the CLI keeps 256 UTF-16 units
   (Tasks 1, 6, 7).
3. **Up to 200 `codexThreadName` calls a followed report are accepted**; Task 9 measures the time and reports it for
   the pull request.
4. **"Logged once a start" is each start of observing**: tried again whenever ChatGPT comes to the front (Tasks 1, 4).
5. **The plan's two departures from the spec are approved:** the revocation notice through CoreFoundation's
   distributed center with deliver-immediately, and `cli/src/lib/sessionTitle.ts` untouched (the core loads it).
