# Harness Device (wave 1b): Implementation Plan

> **For agentic workers:** REQUIRED: execute with **diegodev phase 3**. A task starts as soon as the tasks it depends
> on are done and no running task shares its files; each task commits its failing test, then the code. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A menu-bar app, `device-app/`, that installs the Harness CLI, keeps the daemon running, shows the dial's
state live in its menu, and offers sign-in and Claude Code voice once; plus the CLI and daemon changes it stands on
(`harness hardware watch --json`, the `--if-down` guards).

**Architecture:** One Rust crate under `device-app/src-tauri`: a library that holds every rule (pure reducers and
small modules behind traits, tested by `cargo test` against a fake `harness` script) and a thin Tauri 2 binary (tray,
window, threads). The window is plain TypeScript in `device-app/ui`, bundled by esbuild, fed one `View` at a time. The
app owns no daemon logic: it runs the `harness` CLI and reads its NDJSON. The daemon gains one thing: a tool
connection that asks for `dial` is sent `dial_status`, and is still not a window.

**Tech Stack:** Rust (stable, edition 2024), Tauri 2, serde, objc2 (macOS only), TypeScript + esbuild + Vitest + jsdom
(UI), TypeScript + Vitest (CLI), Python `unittest` (CI planner), GitHub Actions.

**Spec:** [docs/plans/2026-11-13-device-menubar-design.md](2026-11-13-device-menubar-design.md). Read it with this
plan, the root `AGENTS.md`, `cli/AGENTS.md` and `desktop/design/desktop-design-system.md`. The spec is the authority;
every decision in it is final.

## Global Constraints

- **Not touched:** `cli/src/cable`, `cli/hook`, `cli/src/core`, `plugins/`, `devices/`. No line is added to
  `cli/src/architecture.coreFiles.txt` (see [Layers](#layers) for where each CLI file runs).
- **Toolchain:** rustc here is 1.68; Tauri 2 needs 1.77 or newer. `rustup update stable` is allowed (Task 1 runs it).
  The repo pins no toolchain; CI uses `dtolnay/rust-toolchain@stable`. The app needs macOS 13 or later (`SMAppService`).
- **Bundle id** `ai.autonomous.harness.device`; product name `Harness Device`; the desktop app is `ai.autonomous.harness`.
- **The app runs only** the `harness` CLI it found, the two install lines, and `open`. Every argument is fixed in
  Rust. Nothing from the webview becomes a command line: the webview sends one of six `Action` names, nothing else.
- **Deadlines:** status reads 10 s; enable and disable 60 s; `start --if-down` 90 s; install 10 min per script; sign-in
  10 min to its `result`, then 60 s for the child to exit. A run past its deadline is killed with its process group
  (never a sign-in after its `result`).
- **Outside text is data:** an output line is at most 64 KiB (longer is dropped), invalid JSON is skipped, only an
  `https:` authorize URL is opened.
- **Logs and state hold no email, token, URL query or path of the person's.** Every log line passes `log::redact`.
  The sign-in child's stdout is never logged; `auth status` stdout is never logged.
- **Copy** is short; buttons are 1-2 words; an absent thing shows nothing. Menu and screen words are in
  [The contract](#the-contract), are approved (decision 5) and are used as written. Every string a person reads
  follows the [Naming System](../naming-system.md): the menu, the screens, the gallery's captions, the design doc's
  section, the CLI's lines. A task that needs a word the contract does not give takes it from that document, and
  reports one it cannot find there.
- **One writer per shared file.** `Cargo.toml`, `Cargo.lock`, `src/lib.rs`, `src/types.rs`, `tauri.conf.json`,
  `capabilities/`, `ui/package.json`, `ui/package-lock.json`, `ui/build.mjs` and `ui/src/api.ts` are written by Task 1
  only (Task 15 may adjust the Tauri config). A task that needs another crate, package or shared type stops and
  reports to the main session.
- **No path of another component in a string.** `scripts/ci-plan.py` scans every source file under `device-app/` and
  reads a quoted `'cli/…'`, `'desktop/…'`, `'tests/…'` or `'../desktop/…'` as a read of that folder
  (`test_every_cross_read_in_this_repository_is_declared`). Join path segments one by one
  (`.join("cli").join("cli.js")`), and name other components only in comments on their own lines. The fake CLI's path
  comes from `testing::fake_harness()` (Task 2), never from a literal.
- **Rust tests** run with `cargo test --lib <module>::` from `device-app/src-tauri`; they need no `ui/dist`. A plain
  `cargo test` also compiles the binary, which embeds `ui/dist`: build the UI first (`npm run build` in
  `device-app/ui`). Tests that start a process are `#[cfg(unix)]`. No fixed sleeps: a test waits on a channel, or on
  a file the fake CLI is told to wait for.
- **CLI tests** run from `cli/` (`npx vitest run <file>`), then `npm run typecheck`.
- Tip: Tauri's dependencies take minutes to compile. One `CARGO_TARGET_DIR` outside the repository, shared by every
  task of this plan, compiles them once.

## Layers

`cli/AGENTS.md` shapes the daemon as master, core and services. Every CLI file this plan touches, where it runs,
and the task that touches it (checked against `cli/src/architecture.coreFiles.txt` on 2026-11-13):

| File | Layer, process | Task |
|---|---|---|
| `cli/src/lib/flasherDir.ts` (new) | launcher: the `harness` CLI's own process (`harness start`, `harness flash`). Not loaded by the core | 16 |
| `cli/src/lib/startIfDown.ts` | launcher: the `harness start --if-down` process, before any daemon exists. Not in `coreFiles` | 16 |
| `cli/src/lib/flash.ts` | CLI command (`harness flash`), its own process. Not in `coreFiles` | 16 |
| `cli/src/backendSocket.ts` | transport, **the core's process** (`coreFiles` line 5) | 17 |
| `cli/src/localWsServer.ts` | transport, **the core's process** (`coreFiles` line 547) | 18 |
| `cli/src/devices/client.ts` | CLI client command: the `harness hardware …` process, a tool on the daemon's local socket. Not in `coreFiles` | 19 |
| `cli/src/cli.ts` | the CLI's entry, its own process. Not in `coreFiles` | 19 |
| `cli/src/**/*.spec.ts` (the four specs) | tests: no process loads them (`architecture.spec.ts` skips them) | 16 to 19 |
| `cli/e2e/hardwareWatch.e2e.ts` (new) | test: the end-to-end suite's own Vitest process, which starts the real daemon and the `harness hardware watch` process beside it. Outside `src/`: no daemon process loads it, and `architecture.spec.ts` and `npm run typecheck` do not read it | 22 |

- **Nothing here is master (`src/harnessd/`), core (`src/core/`) or a service (`src/services/`).** The dial's
  status is still made in the devices' process (`services/devices.ts`, unchanged) and still reaches the core through
  `core/main.ts` `sendLocal` (unchanged).
- **In the core's process the change is transport only:** which connections `localWsServer.ts` and
  `backendSocket.ts` send a `dial_status` frame to. No rule about the dial, no parsing of its payload, no timer, no
  new state but one set of connection ids, and **no new import** in either file: `architecture.spec.ts` walks every
  value import from `core/main.ts`, and one more file fails it.
- **`harness hardware watch` is a CLI client command.** Everything it decides (reducing a frame to six fields,
  printing only a change, its exit codes) runs in the CLI's process, never the daemon's.
- **The `--if-down` guards and `flasherDir.ts` are launcher code.** Nothing the core loads may import them. (They
  may import what the core also loads, as `startIfDown.ts` already imports `lib/daemonState.ts`.)
- **No task adds a file to the core's process, so no line is added to `architecture.coreFiles.txt`** and no file
  comes under the 100% gate (`npm run test:core`). Each of Tasks 16 to 19 proves it the same way: `npx vitest run
  src/architecture.spec.ts` passes, and the list has no diff against the branch's base (so commits count too),
  from `cli/`: `git diff --exit-code "$(git merge-base origin/main HEAD)" -- src/architecture.coreFiles.txt`
  prints nothing.
  A task that finds it needs a new import in `backendSocket.ts` or `localWsServer.ts`, or a core file importing
  launcher code, stops and reports: that is a new `coreFiles` line, which needs its reason and 100% coverage, and is
  a decision for the main session.

## Found while reading the code

1. **`harness login --json` watches its stdin** (`cli/src/lib/jsonDriver.ts`): a pipe that closes means the app has
   gone, and the sign-in gives up with `CANCELLED`. So the app holds the child's stdin pipe open until the child ends
   (Task 8, pinned by the fake CLI's `@driver`).
2. **`harness start --if-down` that refuses prints one line and exits 0** (`cli/src/cli.ts` `startCommand`). That is
   the spec's "a start that changes nothing".
3. **A pipe's writes are asynchronous on macOS and Linux in Node**, so `process.exit` right after a line can cut it.
   `runDialWatch` therefore lets go of everything that holds the process open and `cli.ts` sets `process.exitCode`,
   as its neighbours do (Task 19).
4. **The local socket spec pins the tool's features** (`localWsServer.spec.ts`, `features: ['openclaw-local']`); Task
   18 updates that assertion.
5. **The managed CLI:** `~/.harness/runtime/current-node` holds an absolute path that must lie under
   `~/.harness/runtime/` and exist; it runs with `~/.harness/cli/cli.js`. The child's `PATH` starts with
   `~/.local/bin`, and `LC_ALL=C.UTF-8` is set when no UTF-8 locale is (`desktop/lib/core/harness_cli_runner.dart`).
6. **The desktop app's process names:** macOS by bundle id; Linux's binary is `harness`
   (`desktop/linux/CMakeLists.txt` `BINARY_NAME`), the CLI launcher's name too, so off macOS the check compares the
   executable file's name, never the command name; Windows `harness-desktop.exe`.
7. **Wave 1a is not on main and defines no failure output** for `harness device claude enable|disable`. The app
   reads it tolerantly (Task 9), and a CLI without the command simply has no Claude Code row.
8. **This Mac:** arm64, with rustup's `stable-x86_64-apple-darwin` toolchain: the debug app is an x86_64 binary under
   Rosetta, which this wave does not care about. `Harness.app` is installed and running here, and the person's
   daemon listens on 18473: see decisions 7 and 8.
9. **The rules that join the modules need a home `cargo test` reaches.** The spec lists ten modules, each one door
   to the outside. Which screen is due, what an answer records, when a status is read again: these go in `app.rs` (a
   pure reducer) and `runner.rs` (runs what the reducer asks, on threads). `types.rs` holds the shared words and
   `log.rs` the log. `main.rs` keeps only what no test can reach: tray, window, timer.
10. **Tauri's `invoke` travels over `ipc:`.** With `default-src 'self'` alone it falls back to a slower path and
    logs a refusal on every call, so the CSP is `default-src 'self'; connect-src ipc: http://ipc.localhost`, as
    Tauri's own guide writes it. Still no remote content.
11. **Local gates:** `python3 scripts/local-checks.py --list` on every path this plan touches prints `{}` (run
    2026-11-13). No file under `cli/src/core` or `cli/src/services` changes, so `npm run test:core` is not needed.
12. **The install line's exit code is the shell's, not curl's.** In `curl -fsSL … | /bin/sh -s -- --host`, a `curl`
    that fails (no network) hands `/bin/sh` nothing, and `/bin/sh` exits 0. The line is fixed, so the app judges the
    outcome instead: an install counts only when a CLI is found after it, as the desktop app verifies after its own
    run (Task 10).
13. **The end-to-end suite (`cli/e2e/`, Task 22).** No spec there runs `harness hardware`. `e2e/harness/daemon.ts`
    (`IsolatedDaemon`) starts the real daemon under a throwaway home, data folder, port and tmux server, with
    `CABLE_DISABLE=true`: no dial, no devices' process, and the status a new connection is told is the core's first
    one, `{ attached: false }` (`core/main.ts` `lastDialStatus`). `backgroundCommands.e2e.ts` reads a running
    `harness watch` child line by line; `agentBrowserPodman.e2e.ts` runs the CLI from the run's bundle when there is
    one (`CLI_ENTRY`). A file without a hint in `cli/ci-e2e-durations.json` costs the default, so that file does not
    change. PR CI never runs `cli/e2e`: the suite is `npm run test:e2e` on a person's machine, and the "CLI end to
    end" workflow nightly or by hand (`docs/validation-and-release.md`).

## Decisions

10. (orchestrator, 2026-11-13) Add Task 23, defining "Harness Device" and "dial" in docs/naming-system.md in this
    PR; the tester runs the "CLI end to end" workflow once in phase 4 after asking the orchestrator for the runner slot.

Diego's answers to the draft's open questions (2026-11-13). Final; the plan below follows them.

1. **Install failed and its window closed:** the dial line stays "Setting up Harness" and the menu offers
   **Install**, which opens the Install screen and runs again.
2. **Closing the window instead of pressing a button:** on the Sign in offer it is Later, on the Claude Code offer
   Not now (recorded, not offered again; the menu keeps both). An install or a sign-in under way keeps running.
3. **No Dock icon** (`LSUIElement`, activation policy Accessory).
4. **Icons:** the tray's template icon is Lucide `circle-dot`, shown in the gallery; the bundle reuses the desktop
   app's icon.
5. **Copy:** the copy table in [The contract](#the-contract) is approved. Every string follows the
   [Naming System](../naming-system.md): Tasks 13 and 14 check it, and the final reviewer does
   ([Review Focus](#review-focus), 6).
6. **Checks that keep running after this pull request.** (a) Yes: Task 22 adds a CLI end-to-end spec for `harness
   hardware watch` (`cli/AGENTS.md` rule 5); its gate is `npm run test:e2e`, run locally by the tester
   (Verification, check 6). (b) No: no `scripts/local-checks.py` receipt for `cargo test` on a Mac.
7. **Verification while `Harness.app` runs on this Mac:** no override, and the desktop app is not quit. The tester
   records which case this Mac is in and checks that case (Verification, checks 2 and 3).
8. **The login item:** the tester registers none. Every verification run starts from a state file whose
   `loginItem` is already true, so the app never asks macOS for one; the login item rests on its unit tests (a
   double).
9. **No CI run by hand.** The pull request's automatic CI runs `device-app-checks`; `AGENTS.md` forbids an extra
   run.

Still open, asked with this update (no task waits on either):

- **Words the Naming System does not hold.** The approved copy says `dial` (the desktop app's own word: "Your dial
  is unplugged") and names the app `Harness Device`; the document's tables have neither, write the controller
  `Harness device`, and ask that a new term be defined there first. Does this pull request add them to
  `docs/naming-system.md`? Until answered the copy stands as approved and no task edits that document.
- **The whole end-to-end suite.** The validation guide's row for `cli/e2e` asks one "CLI end to end" workflow run on
  the branch for a user-facing CLI flow. Decision 6 makes the new spec a local check and decision 9 forbids an
  extra run, so the plan starts none. Should the tester start that one run?

## Review Focus

Inputs the spec implies and its test list does not name, most likely first. Each is pinned by a test in the task
that owns the code.

1. **The person closes the window instead of pressing a button.** Expected: decision 2; never a window
   that comes back at every login. Task 11, `closing_the_window_*`.
2. **A CLI that lacks a command the app runs** (wave 1a not landed: true today; a CLI older than `watch`). Expected:
   no Claude Code row and no screen, no error; "Updating Harness" and no start. Task 9
   `a_cli_without_the_command_has_no_claude`, Task 11 `no_claude_row_or_screen_without_the_command`, Task 4.
3. **The watch child ends or speaks in a way the table does not list** (a signal, an unlisted code, a line that is
   not a status, a line past 64 KiB). Expected: a down observation; junk is skipped; memory stays bounded. Task 4
   `any_other_end_is_a_down_observation`, Task 7 `lines_that_are_not_a_status_are_skipped`, Task 2
   `a_line_over_64_kib_is_dropped`.
4. **A click that arrives twice, or while its command runs** (Sign in…, Turn off, Install, Retry). Expected: the
   command runs once. Task 11 `a_second_click_runs_nothing_twice`.
5. **Outside input that is almost right:** `watch` that is not an array, names unknown things, or comes from a window
   (Task 18); a marker that is a folder, holds a future time or junk (Task 16); an authorize URL that is not
   `https:` (Task 8); install output with colour codes and a 10,000-character line (Task 10).
6. **A string that does not follow the Naming System** (decision 5). The final reviewer reads every string this
   branch adds for a person against `docs/naming-system.md`: the menu rows (Task 5), the screens and fixed sentences
   (Tasks 8 to 11 and 13), the gallery's captions and the design doc's section (Task 14), the CLI's usage and error
   lines (Tasks 16 and 19). Expected: product and vendor names as the document writes them (`Harness`; `Claude
   Code` whole; `harnessd` is a process's name, never a name on screen); the contract's words unchanged; no word
   for a thing the document names otherwise. `dial` and the app's name `Harness Device` are the approved copy and not in the
   document ([Decisions](#decisions), still open): the reviewer reports them and changes neither. Tasks 13 and 14
   check their own strings first.

## The contract

Task 1 writes this into `device-app/src-tauri/src/types.rs` and `device-app/ui/src/api.ts`; every other task reads it
and none changes it.

```rust
//! The words every module shares. No rule lives here.

/// One line of `harness hardware watch --json`. A line without a boolean `attached` is not a status.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct DialStatus { pub attached: bool, pub fw: Option<String>, pub hw: Option<String>,
    pub board: Option<String>, pub updating: Option<String>, pub problem: Option<String> }

/// harnessd, as the keep-alive last saw it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)] pub enum Daemon { Starting, Up, Stopped, Updating }
/// The `harness` CLI on this computer. Removed: seen once and gone now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)] pub enum CliState { Found, Installing, InstallFailed, Removed }

/// `harness device claude status --json`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)] #[serde(rename_all = "camelCase", default)]
pub struct ClaudeStatus { pub supported: bool, pub installed: bool, pub enabled: bool, pub claude_version: Option<String> }

/// state.json: `{ "version": 1, "cliSeen", "askedSignIn", "askedClaude", "loginItem" }`. Default: version 1, all false.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct Saved { pub version: u32, pub cli_seen: bool, pub asked_sign_in: bool, pub asked_claude: bool, pub login_item: bool }

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)] #[serde(rename_all = "snake_case")]
pub enum Screen { Install, SignIn, Claude }
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)] #[serde(rename_all = "snake_case")]
pub enum Phase { Offer, Working, Browser, Failed }
/// What the window draws: `{"screen":"sign_in","phase":"browser","lines":["…"]}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct View { pub screen: Screen, pub phase: Phase, pub lines: Vec<String> }
/// What the window may ask: `"retry" | "sign_in" | "later" | "cancel" | "turn_on" | "not_now"`. Anything else is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)] #[serde(rename_all = "snake_case")]
pub enum Action { Retry, SignIn, Later, Cancel, TurnOn, NotNow }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuAction { Install, SignIn, ClaudeOn, ClaudeOff, OpenHarness, Quit }
/// Text is a disabled line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MenuItem { Text(String), Action(MenuAction, String), Separator }

/// What the menu is drawn from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppState { pub cli: CliState, pub daemon: Daemon, pub dial: Option<DialStatus>,
    pub signed_in: Option<bool>, pub claude: Option<ClaudeStatus>, pub desktop_installed: bool, pub saved: Saved }

/// AuthorizeUrl holds an `https:` URL only (account.rs lets no other through).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LoginEvent { AuthorizeUrl(String), Waiting(String), Done(Result<(), String>) }

/// What happened. WatchExit(None): ended by a signal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Tick { now: u64, desktop_running: bool }, MenuOpened { now: u64, desktop_installed: bool },
    Cli(bool), WatchLine(DialStatus), WatchExit(Option<i32>), StartDone { ok: bool },
    InstallDone(Result<(), Vec<String>>), Auth(Option<bool>), Claude(Option<ClaudeStatus>),
    Login(LoginEvent), ClaudeSet(Result<(), String>), LoginItem(bool),
    Menu(MenuAction), Act(Action), WindowClosed,
}
/// What to do about it. Show(None) hides the window. Menu, Show and Quit are the binary's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    FindCli, SpawnWatch, StopWatch, RunStart, RunInstall, ReadAuth, ReadClaude, RunLogin, CancelLogin,
    SetClaude(bool), OpenUrl(String), OpenDesktop, RegisterLoginItem, Save(Saved), Log(String),
    Menu(Vec<MenuItem>), Show(Option<View>), Quit,
}

/// A finished run.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Output { pub code: Option<i32>, pub timed_out: bool, pub stdout: String, pub stderr: String }

pub trait Clock: Send + Sync { /** Unix seconds. */ fn now(&self) -> u64; }
pub struct SystemClock;
pub trait Log: Send + Sync { fn line(&self, text: &str); }
// #[cfg(test)]: MemoryLog (keeps its lines, `lines() -> Vec<String>`) and FixedClock (`set(u64)`), for every task's tests.
```

```ts
// device-app/ui/src/api.ts: the UI's one door to Rust.
export type Screen = 'install' | 'sign_in' | 'claude'
export type Phase = 'offer' | 'working' | 'browser' | 'failed'
export interface View { screen: Screen; phase: Phase; lines: string[] }
export type Action = 'retry' | 'sign_in' | 'later' | 'cancel' | 'turn_on' | 'not_now'
export function view(): Promise<View | null>                                       // invoke('view')
export function act(action: Action): Promise<void>                                 // invoke('act', { action })
export function onView(listener: (view: View | null) => void): Promise<() => void> // listen('view'), the payload
```

**Menu words** (the spec's, in this order; a row with nothing to say is absent):

| Row | Label |
|---|---|
| Dial line (`Text`) | `Setting up Harness` · `Harness removed` · `Updating Harness` · `Harness stopped` · `Starting Harness` · `Updating to {updating}` · `{problem}` · `Dial connected · {fw}` or `Dial connected` · `No dial`, the first that applies |
| Install | `Install` (`MenuAction::Install`) |
| Account | `Signed in` (`Text`) or `Sign in…` (`MenuAction::SignIn`) |
| Claude Code | `Claude Code: On` (`Text`) then `Turn off` (`ClaudeOff`); or `Claude Code: Off` (`Text`) then `Turn on…` (`ClaudeOn`) |
| Separator | |
| Open Harness | `Open Harness` |
| Quit | `Quit` |

**Screen words** (approved, decision 5; the window's title is `Harness Device`):

| Screen, phase | Heading | Under it | Buttons |
|---|---|---|---|
| install, working | Setting up Harness | a spinner | none |
| install, failed | Setting up Harness | `lines`, monospace, at most 4 | Retry |
| sign_in, offer | Sign in | Add your other computers to the dial. | Sign in (primary) · Later |
| sign_in, working | Sign in | a spinner | Cancel |
| sign_in, browser | Finish in your browser | `lines[0]`, when there is one | Cancel |
| sign_in, failed | Sign in | `lines[0]`, error ink | Retry (primary) |
| claude, offer | Claude Code | The dial speaks Claude Code's answers and asks its approvals. / Harness adds hooks to Claude Code's settings. | Turn on (primary) · Not now |
| claude, working | Claude Code | a spinner | none |
| claude, failed | Claude Code | `lines[0]`, error ink | Retry (primary) |

Fixed sentences: `Sign-in did not finish.` (no `result`, or the 10-minute deadline) · `Could not change Claude Code.`
(a failure that printed nothing) · `Not supported here.` (install off macOS) · `Setup timed out.` (a script past 10
minutes that printed nothing) · `Harness was not installed.` (both scripts ended, printed nothing, and no CLI is
there).

**CSS tokens** (values copied from `desktop/lib/shared/theme/app_theme.dart`; light / dark):

| Token | Light | Dark | Design doc role |
|---|---|---|---|
| `--surface` | `#FFFFFF` | `#2E2E2E` | floating surface (`AppMenu.fill`) |
| `--text` | `#1A1A18` | `#F5F5F5` | primary text |
| `--muted` | `#62615B` | `#A8A8A2` | metadata |
| `--rim` | `rgba(0,0,0,.08)` | `rgba(255,255,255,.12)` | hairline rim |
| `--control` | `#F2F2F4` | `#303030` | neutral control fill (`AppDesktop.field`) |
| `--accent` | `#2F5BEA` | `#2F5BEA` | primary action |
| `--focus` | `#2F5BEA` | `#8BA9FF` | 1.5 px focus boundary |
| `--danger` | `#B3261E` | `#FF7068` | error ink |

Type: system face; heading 17 semibold, line height 1.3; body 13, 1.45; control 13 medium, 1.25; metadata 12, 1.35.
Geometry: content inset 24; group gap 16; control gap 8; buttons are capsules, 32 high at least, 6 or more above and
below the label. A spinner stands still under `prefers-reduced-motion`. Themes: `:root` is light,
`@media (prefers-color-scheme: dark)` sets dark on `:root:not([data-theme])`, and `[data-theme="light"]` /
`[data-theme="dark"]` set either on any element (the gallery uses them).

## Files

| Path | What | Task |
|---|---|---|
| `device-app/AGENTS.md`, `CLAUDE.md`, `.gitignore` | the component's guide (toolchain note) and ignores | 1 |
| `device-app/src-tauri/Cargo.toml`, `Cargo.lock`, `build.rs`, `tauri.conf.json`, `Info.plist`, `capabilities/default.json`, `icons/` | the crate and the Tauri config | 1 (15 may adjust the config) |
| `device-app/src-tauri/src/lib.rs`, `types.rs` | module list, the contract | 1 |
| `device-app/src-tauri/src/cli.rs`, `testing.rs`, `tests/fake-harness` | find and run `harness`; the fake CLI | 2 |
| `device-app/src-tauri/src/state.rs`, `log.rs` | state.json; the log | 3 |
| `device-app/src-tauri/src/keepalive.rs` | the daemon rule | 4 |
| `device-app/src-tauri/src/model.rs` | menu rows, which screen is due | 5 |
| `device-app/src-tauri/src/desktop.rs`, `loginitem.rs` | the desktop app; the login item | 6 |
| `device-app/src-tauri/src/watch.rs` | the watch child | 7 |
| `device-app/src-tauri/src/account.rs` | `auth status`, `login` | 8 |
| `device-app/src-tauri/src/claude.rs` | `device claude …` | 9 |
| `device-app/src-tauri/src/install.rs` | the install script runs | 10 |
| `device-app/src-tauri/src/app.rs` | the reducer | 11 |
| `device-app/src-tauri/src/runner.rs` | runs effects | 12 |
| `device-app/src-tauri/src/main.rs` | tray, window, timer | 1 (minimal), 15 |
| `device-app/ui/package.json`, `package-lock.json`, `tsconfig.json`, `build.mjs`, `vitest.config.ts`, `src/api.ts`, `src/api.test.ts` | the UI package and its door | 1 |
| `device-app/ui/index.html`, `src/main.ts`, `src/screens.ts`, `src/styles.css`, `src/screens.test.ts` | the three screens | 1 (placeholders), 13 |
| `device-app/ui/gallery.html`, `src/gallery.ts`, `src/gallery.test.ts`; `desktop/design/desktop-design-system.md` | gallery and its doc section | 14 |
| `cli/src/lib/flasherDir.ts`, `flash.ts`, `startIfDown.ts`, `startIfDown.spec.ts` | the `--if-down` guards | 16 |
| `cli/src/backendSocket.ts`, `backendSocket.dialWatch.spec.ts` | dial watchers | 17 |
| `cli/src/localWsServer.ts`, `localWsServer.spec.ts` | `watch` on the local socket | 18 |
| `cli/src/devices/client.ts`, `client.spec.ts`, `cli/src/cli.ts` | `harness hardware watch` | 19 |
| `cli/e2e/hardwareWatch.e2e.ts` | `harness hardware watch` on the real daemon, end to end | 22 |
| `scripts/ci-plan.py`, `scripts/tests/test_ci_plan.py`, `.github/workflows/ci.yml`, `docs/validation-and-release.md` | the CI component | 20 |
| `AGENTS.md` | rule 9's exception line | 21 |

## Tasks at a glance

| Task | Depends on | Effort |
|---|---|---|
| 1 Scaffold | nothing | high |
| 2 `cli.rs` and the fake CLI | 1 | xhigh |
| 3 State file and log | 1 | high |
| 4 Keep-alive | 1 | high |
| 5 Menu model | 1 | high |
| 6 Desktop app and login item | 1 | high |
| 7 Watch child | 2 | high |
| 8 Account | 2 | xhigh |
| 9 Claude Code | 2 | medium |
| 10 Install | 2 | xhigh |
| 11 App reducer | 4, 5 | xhigh |
| 12 Runner | 2, 3, 6, 7, 8, 9, 10, 11 | xhigh |
| 13 UI screens | 1 | high |
| 14 Gallery and design doc | 13 | high |
| 15 Binary | 12, 13 | high |
| 16 `--if-down` guards | nothing | high |
| 17 Daemon: dial watchers | nothing | xhigh |
| 18 Daemon: `watch` on the local socket | nothing | xhigh |
| 19 `harness hardware watch` | nothing | high |
| 20 CI component | nothing | high |
| 21 AGENTS.md rule 9 | nothing | medium |
| 22 End-to-end spec for `harness hardware watch` | 18, 19 | high |
| 23 Naming System: Harness Device and dial | nothing | medium |

Tasks 16 to 21 and Task 1 can start at once; Task 22 starts when Tasks 18 and 19 are both done (18 → 22 and
19 → 22, a chain of two). The longest chain is five tasks: 1 → 2 → 7 (or 8, 9, 10) → 12 → 15.

---

### Task 1: Scaffold

**Depends on:** nothing. **Effort:** high.

**Red test:** `types::tests` (the contract and the config), `ui/src/api.test.ts`.

**Files:**
- Create: `device-app/AGENTS.md`, `device-app/CLAUDE.md` (one line: `@AGENTS.md`), `device-app/.gitignore`
  (`src-tauri/target/`, `src-tauri/gen/`, `ui/dist-gallery/`)
- Create: `device-app/src-tauri/Cargo.toml`, `Cargo.lock`, `build.rs`, `tauri.conf.json`, `Info.plist`,
  `capabilities/default.json`, `icons/icon.png`, `icons/icon.icns`, `icons/tray.png`
- Create: `device-app/src-tauri/src/lib.rs`, `types.rs`, `main.rs`, and one line of `//!` in each of `account.rs`,
  `app.rs`, `claude.rs`, `cli.rs`, `desktop.rs`, `install.rs`, `keepalive.rs`, `log.rs`, `loginitem.rs`, `model.rs`,
  `runner.rs`, `state.rs`, `testing.rs`, `watch.rs`
- Create: `device-app/ui/package.json`, `package-lock.json`, `tsconfig.json`, `build.mjs`, `vitest.config.ts`,
  `index.html`, `src/api.ts`, `src/api.test.ts`, `src/main.ts`, `src/styles.css`

**Interfaces:**
- Produces: everything in [The contract](#the-contract); `lib.rs` with `pub mod` for every module above and
  `#[cfg(test)] mod testing;`; the commands' names `view` and `act`; the event name `view`; npm scripts `build`,
  `gallery`, `test`, `typecheck`.

- [ ] **Step 1: Toolchain**

Run `rustup update stable`, then `rustc --version` (expect 1.77 or newer) and
`cargo install tauri-cli --version "^2" --locked` (needed to build and run the app; CI does not use it).

- [ ] **Step 2: Write the failing tests**

`Cargo.toml` (package `harness-device`, edition 2024, `[lib] name = "harness_device"`, `[[bin]] name =
"harness-device"`), `lib.rs`, and `types.rs` holding only its tests. Dependencies, all declared now: `tauri` 2
(features `tray-icon`, `image-png`), `tauri-build` 2, `serde` (derive), `serde_json`, `regex`, `url`; unix: `libc`;
macOS: `objc2`, `objc2-foundation`, `objc2-app-kit`, `objc2-service-management` at the versions Tauri's own tree
resolves; not macOS: `sysinfo`; dev: `tempfile`. No `tauri-plugin-*`.

| Test (`types::tests`) | Asserts |
|---|---|
| `a_status_line_needs_attached` | `{"attached":true,"fw":"0.0.95","settings":{}}` → attached, fw `0.0.95`, the rest `None`; `{}`, `{"error":"x"}` and `{"attached":"yes"}` are errors |
| `a_view_is_the_json_the_window_reads` | `View { SignIn, Browser, ["Waiting"] }` → `{"screen":"sign_in","phase":"browser","lines":["Waiting"]}` |
| `the_window_may_ask_six_things` | each of the six names parses; `"quit"`, `"sh -c x"`, `1` and `null` are errors |
| `state_json_keys` | `Saved::default()` → `{"version":1,"cliSeen":false,"askedSignIn":false,"askedClaude":false,"loginItem":false}` and back |
| `claude_status_reads_camel_case` | `{"supported":true,"installed":true,"enabled":false,"claudeVersion":"2.1.0"}`; `{}` → all false |
| `the_window_is_small_fixed_and_hidden` | `tauri.conf.json` (`include_str!`): identifier `ai.autonomous.harness.device`, productName `Harness Device`, one window `main`: 420 × 320, `resizable` false, `center` true, `visible` false; `csp` is exactly `default-src 'self'; connect-src ipc: http://ipc.localhost`; `frontendDist` `../ui/dist` |
| `the_webview_may_call_two_commands` | `capabilities/default.json` permissions are exactly `core:event:allow-listen`, `core:event:allow-unlisten`, `allow-view`, `allow-act`; `Cargo.toml` names no `tauri-plugin` |
| `the_bundle_asks_for_the_local_network` | `Info.plist` has `NSLocalNetworkUsageDescription` `Harness finds and connects to Autonomous robots on your local network.`, `NSBonjourServices` `_autonomous._tcp`, and `LSUIElement` true (decision 3) |

`ui/src/api.test.ts` (`vi.mock('@tauri-apps/api/core')`, `vi.mock('@tauri-apps/api/event')`): `view()` calls
`invoke('view')` and returns its answer; `act('not_now')` calls `invoke('act', { action: 'not_now' })`;
`onView(listener)` calls `listen('view', …)`, hands the listener each event's `payload`, and resolves to the
unlisten function.

- [ ] **Step 3: Run them and see them fail**

`cd device-app/src-tauri && cargo test --lib types::` → does not compile (no types). `cd device-app/ui && npm install
&& npx vitest run src/api.test.ts` → fails (no `api.ts` exports). Commit: `Harness Device: the crate, and its
contract tests (failing)`.

- [ ] **Step 4: Write the scaffold**

- `types.rs`: the contract block, as written.
- `build.rs`: `tauri_build` with an app manifest naming the commands `view` and `act`, so each needs its permission.
- `tauri.conf.json`: as the test says; `bundle.targets` `["app"]`, `bundle.macOS.minimumSystemVersion` `13.0`; a
  before-build command that runs `npm run build` in `../ui`.
- `Info.plist`: the three keys above (the first two copied from `desktop/macos/Runner/Info.plist`).
- `icons/`: `icon.png` and `icon.icns` from the desktop app's icon (`cargo tauri icon`); `tray.png`: Lucide
  `circle-dot`, black on clear, square, 44 px (decision 4).
- `main.rs`: the smallest Tauri app that compiles (`generate_context!`); Task 15 replaces it.
- `ui`: `esbuild`, `typescript` and `vitest` at the versions `cli/package.json` pins; `jsdom` and `@tauri-apps/api`
  (2) at their current release. `build.mjs` bundles `src/main.ts` to `dist/main.js` as one classic script (`iife`)
  and copies `index.html` and `src/styles.css` into `dist/`; with `--gallery` it bundles `src/gallery.ts` to
  `dist-gallery/gallery.js` instead. `index.html`: `<div id="app">`, the stylesheet, the script, no inline code.
  `src/main.ts` and `src/styles.css`: one line each (Task 13 writes them). `vitest.config.ts`: the `jsdom`
  environment, tests in `src/**/*.test.ts`.
- `device-app/AGENTS.md`: what the app is (three lines); the toolchain (Step 1); the commands (`cargo test --lib`,
  `npm run build` before `cargo test` or `cargo build`, `cargo tauri build --debug`, `npm run gallery`); the rules a
  change must keep (thin over the CLI; fixed arguments; one log, redacted; no other component's path in a string;
  `HARNESS_DEVICE_CLI` is read by debug builds only); that PR CI compiles Linux only.

- [ ] **Step 5: Run everything**

```bash
cd device-app/ui && npx tsc --noEmit && npx vitest run && rm -rf dist && cd ../src-tauri
cargo test --lib          # passes with no ui/dist: every other task relies on this
(cd ../ui && npm run build) && cargo build && cargo test
```

Expected: all pass. If `cargo test --lib` needs `ui/dist`, stop and report: the other tasks' commands assume it does
not.

- [ ] **Step 6: Commit** `Harness Device: the crate, the Tauri config and the UI package`.

---

### Task 2: `cli.rs` and the fake CLI

**Depends on:** Task 1. **Effort:** xhigh (child processes, deadlines, killing a process group).

**Red test:** `cli::tests`.

**Files:**
- Modify: `device-app/src-tauri/src/cli.rs`, `device-app/src-tauri/src/testing.rs`
- Create: `device-app/src-tauri/tests/fake-harness` (POSIX `sh`, mode 755)

**Interfaces:**
- Consumes: `types::{Output, Log, MemoryLog}`.
- Produces, in `cli.rs`:
  - `LINE_MAX = 64 * 1024`; `STATUS_DEADLINE` 10 s, `CHANGE_DEADLINE` 60 s, `START_DEADLINE` 90 s,
    `INSTALL_DEADLINE` 600 s, `LOGIN_DEADLINE` 600 s, `LOGIN_EXIT_DEADLINE` 60 s (`Duration`).
  - `struct Invocation { program: PathBuf, prefix: Vec<OsString>, env: Vec<(OsString, OsString)> }`
  - `fn find_cli(home: &Path, path_var: Option<&OsStr>, over: Option<&Path>) -> Option<Invocation>`
  - `fn cli_override(debug: bool, var: Option<OsString>) -> Option<PathBuf>`: `None` unless `debug`.
  - `fn child_env(home: &Path, path_var: Option<&OsStr>, locale: Option<&OsStr>) -> Vec<(OsString, OsString)>`:
    `PATH` with `{home}/.local/bin` first; `LC_ALL=C.UTF-8` unless `locale` names a UTF-8 one. `find_cli` gives
    it the app's own `LC_ALL`, else `LC_CTYPE`, else `LANG`.
  - `fn run(command: std::process::Command, deadline: Duration) -> io::Result<Output>`: its own process group; past
    the deadline the group is killed and `timed_out` is true; each stream keeps its last 256 KiB.
  - `trait Cli: Send + Sync { fn run(&self, args: &[&str], deadline: Duration) -> io::Result<Output>;
    fn spawn(&self, args: &[&str]) -> io::Result<Child>; }`
  - `struct HarnessCli` with `fn new(invocation: Invocation, log: Arc<dyn Log>) -> Self`, `impl Cli`.
  - `struct Child` (stdin held open, stdout read by a thread): `fn line(&mut self, wait: Duration) ->
    Result<Option<String>, Timeout>` (`None`: the output ended), `fn close_stdin(&mut self)`,
    `fn exit(&mut self, wait: Duration) -> Result<Option<i32>, Timeout>` (`Ok(None)`: a signal),
    `fn killer(&self) -> Killer`; `struct Killer: Clone + Send` with `fn kill(&self)` (the group; nothing once the
    child was reaped, so a reused pid is never signalled); `struct Timeout`.
  - Log lines, one when a run or a spawned child ends: `harness {args}: exit {code}`, with `: {last output line}`
    after a non-zero code; `harness {args}: killed by a signal`; `harness {args}: timed out after {seconds} s`.
- Produces, in `testing.rs` (`#[cfg(test)]`):
  - `fn fake_harness() -> PathBuf`: the script's path, built from `CARGO_MANIFEST_DIR` segment by segment.
  - `struct Fake` with `fn new() -> Fake` (a temp folder holding its own copy of the script and its `fake` folder,
    so tests run side by side with no environment variable), `fn program(&self) -> PathBuf` (that copy),
    `fn script(&self, args: &str, lines: &[&str])`, `fn touch(&self, name: &str)`, `fn calls(&self) -> Vec<String>`,
    `fn ends(&self) -> Vec<String>`, `fn pids(&self) -> Vec<i32>`, `fn log(&self) -> Arc<MemoryLog>`,
    `fn cli(&self) -> HarnessCli`.
  - `fn alive(pid: i32) -> bool` and `fn wait_gone(pid: i32) -> bool` (asks until the process is gone, 5 s at most):
    how a test sees a kill without sleeping.
- The fake's contract. Its folder is `FAKE_HARNESS`, or, when that is unset, the folder `fake` beside the script:
  - it appends its arguments (joined by spaces) to `calls.log` and its pid to `pids.log`;
  - it reads the file named by its arguments joined with `_` (`hardware_watch_--json`); with none, it prints
    `Unknown command` on stderr and exits 1;
  - it prints each line, except: `@err TEXT` (to stderr), `@wait NAME` (until the file NAME exists in the folder),
    `@stdin` (until stdin closes), `@hang` (for ever, in the same process: `exec`), `@exit N`, and `@driver` (from
    here on, stdin closing makes it print `{"type":"result","status":"error","code":"CANCELLED","message":"Sign-in
    stopped: the app that started it has gone."}` and exit 1, as `harness login --json` does; its watcher ends with
    the script and holds no pipe open after it);
  - when it ends by itself it appends its arguments to `ends.log`; a killed run leaves no line.

- [ ] **Step 1: Write the failing tests**

| Test (`cli::tests`) | Asserts |
|---|---|
| `the_managed_cli_comes_first` | a home with `current-node` naming a file under `.harness/runtime/`, `cli.js`, a launcher and a `harness` on PATH → program is that node, prefix is `[…/cli.js]` |
| `a_node_pointer_outside_the_runtime_folder_is_not_used` | `current-node` = `/usr/bin/env`, or naming a missing file, or empty → the launcher |
| `then_the_launcher_then_path_then_nothing` | only `.local/bin/harness` → it; only a PATH folder's `harness` → its absolute path; a relative PATH entry is skipped; none → `None` |
| `the_override_is_for_debug_builds` | `cli_override(true, Some(p))` is `Some(p)`; `cli_override(false, Some(p))` is `None`; `find_cli` uses `over` first |
| `the_child_path_starts_with_the_launcher_folder` | `child_env(home, Some("/usr/bin:/bin"), None)` → `PATH` = `{home}/.local/bin:/usr/bin:/bin` and `LC_ALL=C.UTF-8`; with locale `C` the same; with `en_US.UTF-8` or `vi_VN.utf8` no `LC_ALL`; with no `path_var` `PATH` is the launcher folder alone |
| `a_run_gives_code_and_output` | script `ok`, `@err bad`, `@exit 7` → code `Some(7)`, stdout `ok\n`, stderr `bad\n`, not timed out |
| `a_run_past_its_deadline_dies_with_its_children` | `run(sh -c 'sleep 600 & echo $! > pid; wait', 300 ms)` → `timed_out`, returns within 5 s, and `wait_gone` is true for the recorded pid |
| `a_child_gives_its_lines_then_ends` | script `a`, `b`, `@stdin` → `line` twice; `close_stdin`; `line` → `Ok(None)`; `exit` → `Ok(Some(0))` |
| `a_line_over_64_kib_is_dropped` | a 70,000-character line then `{"a":1}` → the first `line` is `{"a":1}` |
| `a_kill_ends_a_child_and_a_later_kill_does_nothing` | `@hang` → `killer().kill()` → `exit` is `Ok(None)` within 5 s and `wait_gone(pids()[0])`; `kill()` again returns |
| `every_run_is_one_log_line` | `auth status --json` exit 0 → `harness auth status --json: exit 0`; `@err no session`, `@exit 1` → `…: exit 1: no session`; a timeout → `…: timed out after 0.3 s` |
| `the_fake_keeps_its_contract` | `calls()` and `pids()` list each run; `ends()` lists a run that ended and not a killed one; `@wait go` blocks until `touch("go")`; `@driver` with stdin closed prints the `CANCELLED` line and exits 1; after a `@driver` script ends by itself its output ends too (`line` gives `Ok(None)` with stdin still open) |

- [ ] **Step 2: Run** `cargo test --lib cli::` → fails to compile. Commit `Harness Device: find and run the CLI
(failing)`.

- [ ] **Step 3: Implement.** `process_group(0)` on every child; the deadline kills `-pgid` with `SIGKILL`. A reader
  thread per stream; a line longer than `LINE_MAX` is read through and dropped, never buffered whole.

- [ ] **Step 4: Run** `cargo test --lib cli::` → pass.

- [ ] **Step 5: Commit** `Harness Device: find and run the CLI, with deadlines`.

---

### Task 3: State file and log

**Depends on:** Task 1. **Effort:** high (a private file written atomically; what a log may hold).

**Red test:** `state::tests`, `log::tests`.

**Files:**
- Modify: `device-app/src-tauri/src/state.rs`, `device-app/src-tauri/src/log.rs`

**Interfaces:**
- Consumes: `types::{Saved, Log, Clock, MemoryLog, FixedClock}`.
- Produces:
  - `state::StateFile: Send + Sync { fn load(&self) -> Saved; fn save(&self, saved: &Saved) -> io::Result<()>; }`
  - `state::JsonStateFile::new(dir: PathBuf, log: Arc<dyn Log>)`: `state.json` in `dir`.
  - `log::FileLog::new(dir: PathBuf, clock: Arc<dyn Clock>) -> FileLog`, `impl Log`; `log::KEEP_DAYS = 14`;
    `log::redact(text: &str) -> String`.

- [ ] **Step 1: Write the failing tests**

| Test | Asserts |
|---|---|
| `state::a_save_reads_back` | save `{cli_seen, asked_claude}` → `load()` equals it; the file is `state.json` |
| `state::the_file_is_private_and_whole` | mode `0o600`; the folder holds `state.json` only (no temp file); a stale `state.json.tmp` from before is gone after a save |
| `state::a_missing_file_is_a_first_run` | defaults, no log line |
| `state::an_unknown_or_unreadable_file_gives_defaults_and_one_log_line` | `not json`, `[]`, `{"version":2,"cliSeen":true}`, `{"version":1,"cliSeen":"yes"}` → defaults; the log has `state: unreadable, starting from defaults` once each |
| `state::a_newer_key_is_ignored` | `{"version":1,"cliSeen":true,…,"later":1}` → `cli_seen` true |
| `state::a_save_makes_its_folder_and_says_when_it_cannot` | a missing folder is made (mode `0o700`); a folder path that is a file → `Err` |
| `log::the_file_is_named_for_the_utc_day` | clock 1794614399 → `app-20261113.log`; clock 1794614400 → `app-20261114.log`; a line reads `2026-11-13T23:59:59Z {text}` |
| `log::nothing_secret_is_written` | `Bearer abcdefgh1234` → `Bearer <redacted>`; `sk-ant-abcdefgh1234` → `sk-<redacted>`; `"session_token": "abc123def"` → the value `<redacted>`; `https://id.example/cb?code=abc&state=def` → `https://id.example/cb`; `person@example.com` → `<email>`; `harness start --if-down: exit 0` is unchanged |
| `log::old_logs_go_and_nothing_else_does` | with `app-20261029.log`, `app-20261030.log`, `app-junk.log`, `cli.txt` and the clock at 1794614399, `new` removes `app-20261029.log` only |
| `log::a_log_that_cannot_be_written_never_stops_the_app` | the folder is a file → `line` returns |

- [ ] **Step 2: Run** `cargo test --lib state:: log::` → fails to compile. Commit `Harness Device: state file and log
(failing)`.

- [ ] **Step 3: Implement.** State: temp file `state.json.tmp` in the same folder, mode 0600 at creation, then
  rename. Log: `redact` is the desktop's four rules (`desktop/lib/logging/redact.dart` `_textRedactions`) plus two:
  a URL loses its query and fragment, an email address becomes `<email>`. `FileLog::line` redacts every line.

- [ ] **Step 4: Run** `cargo test --lib state:: log::` → pass.

- [ ] **Step 5: Commit** `Harness Device: a private state file and a redacted log`.

---

### Task 4: Keep-alive

**Depends on:** Task 1. **Effort:** high.

**Red test:** `keepalive::tests`.

**Files:**
- Modify: `device-app/src-tauri/src/keepalive.rs`

**Interfaces:**
- Consumes: `types::Daemon`.
- Produces:
  - `fn in_spawn_slot(now: u64) -> bool`: seconds 10 to 19 of a minute.
  - `RETRY_OLD_SECS: u64 = 60`.
  - `enum Keep { SpawnWatch, RunStart }`
  - `struct KeepAlive` with `fn new() -> Self` (the caller has just spawned the watch), `fn watch_line(&mut self)`,
    `fn watch_exit(&mut self, code: Option<i32>, now: u64)`, `fn tick(&mut self, now: u64, desktop_running: bool) ->
    Option<Keep>`, `fn start_begun(&mut self, now: u64)` (a start the caller runs outside the slot, after an install),
    `fn start_done(&mut self, ok: bool)` (the caller spawns the watch again), `fn daemon(&self) -> Daemon`.
    `tick` returning `RunStart` has marked the start begun.

- [ ] **Step 1: Write the failing tests** (times: `B = 1794556800`, second 0 of a minute)

| Test | Asserts |
|---|---|
| `the_slot_is_seconds_10_to_19` | true at `B+10`, `B+19`; false at `B+9`, `B+20` |
| `a_running_watch_is_a_daemon_that_is_up` | `new()` → `Starting`; `watch_line()` → `Up`; ticks → `None` |
| `one_down_looks_again_on_the_next_tick` | `watch_exit(Some(3), B)` → `Starting`; `tick(B+5, false)` → `SpawnWatch`; a second tick before the next exit → `None` |
| `two_downs_in_a_row_start_it_in_the_slot` | exit 3 at `B`, `tick(B+5)` → `SpawnWatch`, exit 3 → `tick(B+9)` `None` (out of the slot) → `tick(B+10)` `RunStart` → ticks `None` while it runs → `start_done(true)` → exit 3 → `Stopped` |
| `a_watch_that_connects_resets_the_count` | exit 3, `tick` → `SpawnWatch`, `watch_line()`, exit 3 → `tick(B+10)` is `SpawnWatch`, not `RunStart` |
| `never_while_the_desktop_app_runs` | two downs → `tick(B+10, true)` is `SpawnWatch` (it still watches); `daemon()` stays `Starting` |
| `an_old_daemon_or_cli_is_updating_and_is_never_started` | `watch_exit(Some(4), B)` and `watch_exit(Some(1), B)` → `Updating`; ticks before `B+60` → `None`; `tick(B+60)` → `SpawnWatch`; never `RunStart` |
| `a_start_that_changes_nothing_reads_stopped_until_the_watch_connects` | after `start_done(true)` and exit 3 → `Stopped`; `watch_line()` → `Up` |
| `a_failed_start_waits_for_the_next_slot` | `RunStart` at `B+10`, `start_done(false)`, exit 3, `tick(B+12)` → `SpawnWatch`, exit 3 → `tick(B+15)` `None` (in the slot, but the same minute) → ticks to `B+65` `None` → `tick(B+70)` `RunStart`; `daemon()` is `Starting`, not `Stopped` |
| `any_other_end_is_a_down_observation` | `watch_exit(None, B)` and `watch_exit(Some(143), B)` count as exit 3 |
| `exit_0_is_the_app_closing_it` | `watch_exit(Some(0), B)` → ticks give `None` |
| `a_start_after_an_install_is_not_started_twice` | `start_begun(B+30)` → ticks `None` until `start_done` |

- [ ] **Step 2: Run** `cargo test --lib keepalive::` → fails to compile. Commit `Harness Device: the keep-alive rule
(failing)`.

- [ ] **Step 3: Implement.** A start is asked at most once a minute (`now / 60` differs from the last start's). The
  down count restarts after each start.

- [ ] **Step 4: Run** `cargo test --lib keepalive::` → pass.

- [ ] **Step 5: Commit** `Harness Device: the keep-alive rule`.

---

### Task 5: Menu model

**Depends on:** Task 1. **Effort:** high.

**Red test:** `model::tests`.

**Files:**
- Modify: `device-app/src-tauri/src/model.rs`

**Interfaces:**
- Consumes: `types::{AppState, MenuItem, MenuAction, Screen, CliState, Daemon}`.
- Produces: `fn dial_line(state: &AppState) -> String`, `fn menu(state: &AppState) -> Vec<MenuItem>`,
  `fn due(state: &AppState) -> Option<Screen>`, `fn menu_log(items: &[MenuItem]) -> String` (labels joined by ` | `,
  no separators).

- [ ] **Step 1: Write the failing tests** (a helper `state()` gives: `Found`, `Up`, a dial `{attached: true, fw:
  "0.0.95"}`, signed in, Claude `{supported, installed, enabled}`, the desktop app installed, everything asked)

| Test | Asserts |
|---|---|
| `the_whole_menu` | `state()` → `Text("Dial connected · 0.0.95")`, `Text("Signed in")`, `Text("Claude Code: On")`, `Action(ClaudeOff, "Turn off")`, `Separator`, `Action(OpenHarness, "Open Harness")`, `Action(Quit, "Quit")` |
| `every_dial_line` | `Installing` → `Setting up Harness`; `Removed` → `Harness removed`; `Updating` → `Updating Harness`; `Stopped` → `Harness stopped`; `Starting`, and `Up` with no line yet → `Starting Harness`; `updating: "0.0.96"` → `Updating to 0.0.96` (over `problem` and `attached`); `problem: "Not answering — unplug and replug"` → that text; attached with no `fw` → `Dial connected`; not attached → `No dial` |
| `install_is_offered_when_harness_was_removed` | `Removed` → the second row is `Action(Install, "Install")`; `Found` and `Installing` have none; `InstallFailed` → `Setting up Harness` then `Install` (decision 1) |
| `the_account_row` | signed out → `Action(SignIn, "Sign in…")`; `signed_in: None` → no account row |
| `the_claude_rows` | `enabled: false` → `Text("Claude Code: Off")`, `Action(ClaudeOn, "Turn on…")`; not supported, not installed, or `None` → no Claude row |
| `open_harness_needs_the_desktop_app` | not installed → the menu ends `Separator`, `Quit` |
| `without_a_cli_the_menu_says_only_what_it_knows` | `Removed`, account and Claude `None` → `Harness removed`, `Install`, `Separator`, `Quit` |
| `screens_are_due_in_order` | `Installing` or `InstallFailed` → `Install`; else signed out and not asked → `SignIn`; else Claude supported, installed, off and not asked → `Claude`; signed in and not asked → not `SignIn`; `signed_in: None` → not `SignIn`; everything asked → `None` |
| `the_menu_as_a_log_line` | `menu_log(menu(&state()))` = `Dial connected · 0.0.95 \| Signed in \| Claude Code: On \| Turn off \| Open Harness \| Quit` (plain bars) |

- [ ] **Step 2: Run** `cargo test --lib model::` → fails to compile. Commit `Harness Device: what the menu shows
(failing)`.

- [ ] **Step 3: Implement.** Pure functions; the labels are the contract's.

- [ ] **Step 4: Run** `cargo test --lib model::` → pass.

- [ ] **Step 5: Commit** `Harness Device: what the menu shows`.

---

### Task 6: Desktop app and login item

**Depends on:** Task 1. **Effort:** high (objc2 calls into AppKit and ServiceManagement).

**Red test:** `desktop::tests`, `loginitem::tests`.

**Files:**
- Modify: `device-app/src-tauri/src/desktop.rs`, `device-app/src-tauri/src/loginitem.rs`

**Interfaces:**
- Produces:
  - `desktop::DESKTOP_BUNDLE_ID = "ai.autonomous.harness"`.
  - `desktop::DesktopApp: Send + Sync { fn installed(&self) -> bool; fn running(&self) -> bool; }` and
    `desktop::SystemDesktopApp`. macOS: `NSWorkspace URLForApplicationWithBundleIdentifier`,
    `NSRunningApplication runningApplicationsWithBundleIdentifier`; both are read on the main thread (the caller's
    duty, said in the doc comment). Elsewhere: `installed()` is false in this wave; `running()` is
    `running_among(std::env::consts::OS, <every process's executable path, by sysinfo>)`.
  - `desktop::process_names(os: &str) -> &'static [&'static str]`: `"linux"` → `["harness"]`, `"windows"` →
    `["harness-desktop.exe"]`, anything else → `[]`.
  - `desktop::running_among(os: &str, executables: impl Iterator<Item = String>) -> bool`: whether one of them is
    a `process_names(os)` name: the file name, whole; `"windows"` splits on `\` too and ignores case.
  - `desktop::open_desktop_args() -> [&'static str; 2]`: `["-b", DESKTOP_BUNDLE_ID]`.
  - `desktop::run_open(args: &[&str]) -> io::Result<()>`: starts the program `open` (found on `PATH`) with these
    arguments and does not wait.
  - `loginitem::LoginItem: Send + Sync { fn register(&self) -> Result<(), String>; }` and
    `loginitem::SystemLoginItem`: macOS `SMAppService.mainApp` `registerAndReturnError`; elsewhere
    `Err("Login items are not supported here.".into())`.

- [ ] **Step 1: Write the failing tests**

| Test | Asserts |
|---|---|
| `desktop::the_names_come_from_the_desktop_packaging` | the three rows of `process_names` above |
| `desktop::a_name_matches_the_file_whole` | `running_among("linux", …)` is true for `/opt/harness/harness`; false for `/usr/bin/node`, `/x/harness-pty`, `/x/harnessd`, `/x/Harness`; `running_among("windows", …)` is true for `C:\x\Harness-Desktop.exe`; `running_among("macos", …)` is always false |
| `desktop::open_harness_is_one_fixed_command` | `open_desktop_args()` is `["-b", "ai.autonomous.harness"]` |
| `desktop::the_system_answers` (macOS) | `SystemDesktopApp.installed()` and `.running()` return (either value) |
| `desktop::no_desktop_app_is_installed_off_a_mac` (not macOS) | `installed()` is false; `running()` returns |
| `loginitem::there_is_none_off_a_mac` (not macOS) | `register()` is `Err("Login items are not supported here.")` |
| `loginitem::it_is_a_door` | a `Box<dyn LoginItem>` holding a test double compiles and is called |

`SystemLoginItem.register()` is never called under `cargo test` on a Mac: it would register the test binary as a
login item of the developer's account. Its proof is Verification.

- [ ] **Step 2: Run** `cargo test --lib desktop:: loginitem::` → fails to compile. Commit `Harness Device: the
desktop app and the login item (failing)`.

- [ ] **Step 3: Implement** as the interfaces say.

- [ ] **Step 4: Run** `cargo test --lib desktop:: loginitem::` → pass (the macOS rows run here; the others on CI).

- [ ] **Step 5: Commit** `Harness Device: the desktop app and the login item, behind their traits`.

---

### Task 7: Watch child

**Depends on:** Task 2. **Effort:** high.

**Red test:** `watch::tests`.

**Files:**
- Modify: `device-app/src-tauri/src/watch.rs`

**Interfaces:**
- Consumes: `cli::Cli`, `types::{DialStatus, Event}`, `testing::Fake`.
- Produces: `fn spawn_watch(cli: &dyn Cli, send: impl Fn(Event) + Send + 'static) -> io::Result<Watch>`: runs
  `hardware watch --json`; sends `Event::WatchLine` for each status line and one `Event::WatchExit` at the end.
  `struct Watch` with `fn stop(&self)` (closes the child's stdin; the child exits 0 and `WatchExit(Some(0))` still
  arrives). Dropping a `Watch` stops it.

- [ ] **Step 1: Write the failing tests** (events arrive on an `mpsc` channel; `recv_timeout(5 s)`)

| Test | Asserts |
|---|---|
| `a_line_each_time_the_dial_changes` | script `{"attached":false}`, `@wait next`, `{"attached":true,"fw":"0.0.95","hw":"cst816s"}`, `@stdin` → `WatchLine(attached false)`; after `touch("next")` → `WatchLine(attached, fw 0.0.95, hw cst816s)`; `calls()` is `["hardware watch --json"]` |
| `lines_that_are_not_a_status_are_skipped` | `not json`, `[1]`, `{"error":"Harness is too old"}`, `{}`, then `{"attached":false}` → exactly one `WatchLine` |
| `the_exit_code_arrives` | `@exit 3` → `WatchExit(Some(3))`; `@exit 4` → `WatchExit(Some(4))`; no script (the CLI has no such command) → `WatchExit(Some(1))` |
| `stopping_closes_stdin_and_the_child_ends_by_itself` | `{"attached":false}`, `@stdin` → `stop()` → `WatchExit(Some(0))`; `ends()` has the run |
| `a_cli_that_is_gone_is_an_error` | a `HarnessCli` whose program does not exist → `Err`, kind `NotFound` |

- [ ] **Step 2: Run** `cargo test --lib watch::` → fails to compile. Commit `Harness Device: the watch child
(failing)`.

- [ ] **Step 3: Implement.** One thread reads lines until the output ends, then waits for the exit.

- [ ] **Step 4: Run** `cargo test --lib watch::` → pass.

- [ ] **Step 5: Commit** `Harness Device: the dial's state from harness hardware watch`.

---

### Task 8: Account

**Depends on:** Task 2. **Effort:** xhigh (a URL from outside is opened; a child that must and must not be killed; a
stream that carries an email).

**Red test:** `account::tests`.

**Files:**
- Modify: `device-app/src-tauri/src/account.rs`

**Interfaces:**
- Consumes: `cli::{Cli, STATUS_DEADLINE, LOGIN_DEADLINE, LOGIN_EXIT_DEADLINE}`, `types::{Event, LoginEvent, Log}`,
  `testing::Fake`.
- Produces:
  - `NO_RESULT = "Sign-in did not finish."`
  - `fn auth_status(cli: &dyn Cli) -> Option<bool>`: `auth status --json`; `loggedIn`, or `None` when the run fails,
    times out or prints no such JSON.
  - `fn login(cli: &dyn Cli, log: Arc<dyn Log>, send: impl Fn(Event) + Send + 'static) -> io::Result<Login>`: runs
    `login --json`, sends `Event::Login(…)`. `struct Login` with `fn cancel(&self)`: kills the child before its
    `result`, does nothing after; no `Done` follows a cancel.
  - Log lines: `sign-in: browser {scheme}://{host}{path}`, `sign-in: waiting`, `sign-in: result success`,
    `sign-in: result error {code}`, `sign-in: no result`, `sign-in: cancelled`.

- [ ] **Step 1: Write the failing tests** (the two deadlines are arguments of a private function the tests call with
  300 ms; `login` passes the constants)

| Test | Asserts |
|---|---|
| `auth_status_reads_logged_in` | `{"loggedIn":true,"machineId":"m"}` → `Some(true)`; `{"loggedIn":false,"signedOut":"pending-refresh"}` → `Some(false)`; `oops`, `@exit 1`, and `@hang` past the deadline → `None` |
| `the_browser_url_then_the_result` | `@driver`, `{"type":"authorize_url","url":"https://id.example/a?state=S"}`, `{"type":"waiting","message":"Harness is finishing an update"}`, `@wait go`, `{"type":"result","status":"success","email":"person@example.com"}` → `AuthorizeUrl("https://id.example/a?state=S")`, `Waiting(…)`, and after `touch("go")` `Done(Ok(()))`. The `@driver` proves stdin stayed open |
| `only_an_https_url_is_passed_on` | `http://id.example/a`, `javascript:alert(1)`, `file:///etc/passwd`, `not a url` → no event; `HTTPS://id.example/a` → `AuthorizeUrl` |
| `an_error_result_carries_its_message` | `{"type":"result","status":"error","code":"BACKEND_ERROR","message":"fetch failed"}`, `@exit 1` → `Done(Err("fetch failed"))`; a result with no message → `Done(Err(NO_RESULT))` |
| `a_child_that_ends_without_a_result_is_a_failure` | `@exit 1` → `Done(Err(NO_RESULT))` |
| `other_events_and_junk_are_ignored` | `{"type":"qr","url":"x"}`, `{"type":"confirm","email":"a@b.c"}`, `nonsense` → no event |
| `cancel_kills_before_the_result_only` | the URL line then `@hang` → `cancel()` → `wait_gone(pids()[0])`, `ends()` empty, and the channel closes with no `Done`. With `result success` then `@wait later` → `cancel()` does nothing: `alive(pid)`; after `touch("later")` `ends()` has the run |
| `no_result_in_time_ends_it` | the URL line then `@hang`, deadline 300 ms → `Done(Err(NO_RESULT))`, and `wait_gone(pid)` |
| `after_the_result_it_waits_and_never_kills` | `result success` then `@wait later`, exit deadline 300 ms → the channel closes (the login's thread ended) and `alive(pid)` is still true; `touch("later")` → `ends()` has the run |
| `the_log_has_no_query_and_no_email` | after a run with the scripts of `the_browser_url_then_the_result`, `fake.log().lines()` has `sign-in: browser https://id.example/a` and no line with `state=S`, `person@example.com` or `@` |

- [ ] **Step 2: Run** `cargo test --lib account::` → fails to compile. Commit `Harness Device: account status and
sign-in (failing)`.

- [ ] **Step 3: Implement.** The child's stdin is never closed by this module. The URL is parsed with `url::Url`;
  the scheme must be `https`.

- [ ] **Step 4: Run** `cargo test --lib account::` → pass.

- [ ] **Step 5: Commit** `Harness Device: account status and sign-in through the CLI`.

---

### Task 9: Claude Code

**Depends on:** Task 2. **Effort:** medium.

**Red test:** `claude::tests`.

**Files:**
- Modify: `device-app/src-tauri/src/claude.rs`

**Interfaces:**
- Consumes: `cli::{Cli, STATUS_DEADLINE, CHANGE_DEADLINE}`, `types::ClaudeStatus`, `testing::Fake`.
- Produces: `FAILED = "Could not change Claude Code."`; `fn status(cli: &dyn Cli) -> Option<ClaudeStatus>` (`device
  claude status --json`; `None` when the run fails, times out or prints no JSON object);
  `fn set(cli: &dyn Cli, on: bool) -> Result<(), String>` (`device claude enable` or `device claude disable`).
  A failure's message: the last non-empty output line, stderr before stdout; when that line is a JSON object with a
  string `error` or `message`, that string; a leading `✗` and spaces are dropped; cut to 200 characters; nothing
  printed → `FAILED`.

- [ ] **Step 1: Write the failing tests**

| Test | Asserts |
|---|---|
| `status_reads_the_four_fields` | `{"supported":true,"installed":true,"enabled":false,"claudeVersion":"2.1.0"}` → that `ClaudeStatus` |
| `a_cli_without_the_command_has_no_claude` | no script (exit 1, `Unknown command`), usage text on stdout with exit 0, `[]` → `None` |
| `on_and_off_run_one_command_each` | `set(true)` → `calls()` is `["device claude enable"]`; `set(false)` → `["device claude disable"]`; both `Ok` on exit 0 |
| `a_failure_says_why` | `@err ✗ Could not write Claude Code's settings.`, `@exit 1` → `Err("Could not write Claude Code's settings.")`; stdout `{"error":"Claude Code is too old."}`, `@exit 1` → `Err("Claude Code is too old.")`; `@exit 1` alone → `Err(FAILED)`; a 300-character line → 200 characters |

- [ ] **Step 2: Run** `cargo test --lib claude::` → fails to compile. Commit `Harness Device: Claude Code status and
switch (failing)`.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** `cargo test --lib claude::` → pass.

- [ ] **Step 5: Commit** `Harness Device: Claude Code status and switch through the CLI`.

---

### Task 10: Install

**Depends on:** Task 2. **Effort:** xhigh (it runs a script from the network; the line is fixed).

**Red test:** `install::tests`.

**Files:**
- Modify: `device-app/src-tauri/src/install.rs`

**Interfaces:**
- Consumes: `cli::{run, INSTALL_DEADLINE}`, `types::{Output, Log, MemoryLog}`.
- Produces:
  - The two lines, exactly the desktop app's `kHarnessHostSetupCommand` and `kHarnessDesktopInstallCommand`:

    ```
    HOST    = curl -fsSL https://cdn.autonomous.ai/harness/cli/install.sh | /bin/sh -s -- --host
    DESKTOP = curl -fsSL https://cdn.autonomous.ai/harness/cli/install.sh | /bin/sh -s -- --desktop
    ```
  - `NOT_SUPPORTED = "Not supported here."`, `TIMED_OUT = "Setup timed out."`,
    `NOT_INSTALLED = "Harness was not installed."`, `LAST_LINES = 4`, `LINE_CHARS = 120`.
  - `trait Shell: Send + Sync { fn run(&self, line: &str, deadline: Duration) -> io::Result<Output>; }`
  - `struct SystemShell` (`/bin/sh -c line` through `cli::run`); `fn system_shell() -> Option<SystemShell>`: `Some`
    on macOS, `None` elsewhere.
  - `fn install(shell: &dyn Shell, log: &dyn Log, cli_there: &dyn Fn() -> bool) -> Result<(), Vec<String>>`: `HOST`,
    then `DESKTOP`, each with `INSTALL_DEADLINE`; a run that exits non-zero or times out is a failure; and after
    both, so is a computer where `cli_there()` is false (finding 12). `Err` holds the last lines of the run that
    failed, or of the last run.

- [ ] **Step 1: Write the failing tests** (a `Shell` double records its lines and answers from a list)

| Test | Asserts |
|---|---|
| `the_lines_are_the_desktop_apps` | `HOST` and `DESKTOP` equal the two strings above |
| `host_then_desktop_each_with_ten_minutes` | both exit 0 and a CLI is there → `Ok`; the double saw `[HOST, DESKTOP]`, each with 600 s; `cli_there` was asked after both, not before |
| `an_install_that_leaves_no_cli_is_a_failure` | both exit 0 (as `curl … \| sh` does with no network), the last run's stderr is `curl: (6) Could not resolve host: cdn.autonomous.ai`, no CLI there → `Err` of that line; with no output at all → `Err([NOT_INSTALLED])` |
| `a_failed_host_run_stops_there_with_its_last_lines` | exit 6 with ten stderr lines → `Err` of the last 4; `DESKTOP` not run |
| `a_run_past_its_deadline_is_a_failure` | `timed_out` with output → its last lines; with none → `Err([TIMED_OUT])` |
| `a_shell_that_cannot_start_is_a_failure` | the double returns `Err(io)` → `Err` with one line, the error's text |
| `the_lines_shown_are_clean_and_short` | output with `\x1b[31m` colour codes, a `\r` progress line and a 10,000-character line → at most 4 lines, each at most 120 characters, no control character, no empty line |
| `the_whole_output_goes_to_the_log` | every output line appears in the log as `install: {line}`, then `install: --host exit 0` |
| `the_system_shell_is_for_macos` | `system_shell().is_some()` equals `cfg!(target_os = "macos")` |
| `the_system_shell_runs_through_sh` (unix) | `SystemShell.run("printf hi; exit 3", 5 s)` → code `Some(3)`, stdout `hi` |

- [ ] **Step 2: Run** `cargo test --lib install::` → fails to compile. Commit `Harness Device: the install runs
(failing)`.

- [ ] **Step 3: Implement.** No argument, variable or path is ever added to either line.

- [ ] **Step 4: Run** `cargo test --lib install::` → pass.

- [ ] **Step 5: Commit** `Harness Device: install the CLI with the desktop app's two commands`.

---

### Task 11: App reducer

**Depends on:** Tasks 4, 5. **Effort:** xhigh (every flow's state, and what is saved).

**Red test:** `app::tests`.

**Files:**
- Modify: `device-app/src-tauri/src/app.rs`

**Interfaces:**
- Consumes: `keepalive::{KeepAlive, Keep}`, `model::{menu, due, menu_log}`, everything in `types`.
- Produces: `struct App` with
  `fn new(saved: Saved, cli_found: bool, desktop_installed: bool, now: u64) -> (App, Vec<Effect>)`,
  `fn handle(&mut self, event: Event) -> Vec<Effect>`, `fn view(&self) -> Option<View>`.
  No I/O, no clock: time arrives in `Tick` and `MenuOpened`.

**Rules** (each is a test below):
- Every `handle` ends by comparing `menu(state)` with the last menu sent: when it differs, `Effect::Menu(items)` and
  `Effect::Log("menu: " + menu_log(items))`.
- **Start.** Found: `SpawnWatch`, `ReadAuth`, `ReadClaude`, and `Save` with `cli_seen` when it was false. Not found
  and never seen: `Installing`, `RunInstall`, `Show(install, working)`. Not found and seen: `Removed`, nothing runs,
  no window. `RegisterLoginItem` when `login_item` is false; `LoginItem(true)` → `Save` with it; `LoginItem(false)`
  saves nothing.
- **First screen.** Once `Auth` and `Claude` have both answered for the first time and no window shows (or the
  Install screen shows after a finished install), the window shows `due(state)` at `Offer`, or hides.
- **A screen that ends** (Later, a finished sign-in, Not now, Claude Code turned on) shows the next `due` screen, or
  hides.
- **Install.** `InstallDone(Ok)` (the runner found the CLI after it) → `Found`, `Save(cli_seen)`, `start_begun`,
  `RunStart`, `ReadAuth`, `ReadClaude`. `InstallDone(Err(lines))` → `InstallFailed`, `Show(install, failed, lines)`
  when the window shows Install. `Act(Retry)` there and `Menu(Install)` → `Installing`, `RunInstall`, `Show(install,
  working)`.
- **Sign-in.** `Act(SignIn)` or `Act(Retry)` → `RunLogin`, `Show(sign_in, working)`. `AuthorizeUrl(url)` →
  `OpenUrl(url)`, `Show(sign_in, browser, [])`. `Waiting(text)` → the same phase with `[text]`. `Done(Ok)` →
  `asked_sign_in`, `Save`, signed in, `ReadAuth`, next screen. `Done(Err(text))` → `Show(sign_in, failed, [text])`.
  `Act(Cancel)` → `CancelLogin`, `Show(sign_in, offer)`. `Act(Later)` → `asked_sign_in`, `Save`, next screen.
  `Menu(SignIn)` → `Show(sign_in, offer)`, or the running sign-in's view.
- **Claude Code.** `Act(TurnOn)` or `Act(Retry)` → `SetClaude(true)`, `Show(claude, working)`. `ClaudeSet(Ok)` →
  `ReadClaude`; after a turn-on from the window also `asked_claude`, `Save`, next screen. `ClaudeSet(Err(text))` →
  `Show(claude, failed, [text])` when the window shows Claude; a failed turn-off changes nothing (the runner logged
  it). `Act(NotNow)` → `asked_claude`, `Save`, next screen. `Menu(ClaudeOn)` → `Show(claude, offer)`.
  `Menu(ClaudeOff)` → `SetClaude(false)`.
- **Reads.** `MenuOpened` keeps `desktop_installed`; with the CLI found and 60 s since the last read: `ReadAuth`,
  `ReadClaude`. `Auth(None)` keeps the last answer.
- **Daemon.** `Tick`: with the CLI found, `keep.tick` → `SpawnWatch` or `RunStart`; without one (and no install
  running) → `FindCli`. `WatchLine` → `keep.watch_line`, the dial. `WatchExit` → `keep.watch_exit`, no dial.
  `StartDone` → `keep.start_done`, `SpawnWatch`. `Cli(true)` while `Removed` or `InstallFailed` → as a found CLI at
  start. `Cli(false)` while `Found` → `Removed`, `StopWatch`.
- **Menu.** `Menu(OpenHarness)` → `OpenDesktop`. `Menu(Quit)` → `StopWatch`, `Quit`.
- **Window closed** (decision 2): on `sign_in, offer` or `failed` as `Later`; on `claude, offer` or `failed` as
  `NotNow`; on `sign_in, working` or `browser`: `asked_sign_in` is saved and the sign-in keeps running; on Install:
  nothing stops. Always `Show(None)`.

- [ ] **Step 1: Write the failing tests** (helpers: `found()`, `fresh()` (no CLI, never seen), `removed()`; `has(&
  effects, Effect)`; `rows(&effects)` gives the last menu's labels)

| Test | Asserts |
|---|---|
| `a_found_cli_is_watched_and_read` | `new(default, true, …)` → `SpawnWatch`, `ReadAuth`, `ReadClaude`, `Save(cli_seen)`, `RegisterLoginItem`, a menu starting `Starting Harness`; no window |
| `no_cli_ever_seen_installs_on_its_own` | `fresh()` → `RunInstall`, `Show(install, working)`, menu `Setting up Harness` |
| `a_cli_that_was_seen_and_is_gone_is_never_reinstalled` | `removed()` → no `RunInstall`, no `Show`, menu `Harness removed \| Install \| Quit`; `Cli(false)` while found → the same menu and `StopWatch` |
| `the_login_item_is_registered_once` | `LoginItem(true)` → `Save` with `login_item`; a new `App` from that state has no `RegisterLoginItem`; `LoginItem(false)` → no `Save` |
| `an_install_that_works_starts_the_daemon_and_moves_on` | `InstallDone(Ok)` → `Save(cli_seen)`, `RunStart` (at once, no slot), `ReadAuth`, `ReadClaude`, and the window still on `install, working`; `StartDone` → `SpawnWatch`; `Auth(Some(false))`, `Claude(None)` → `Show(sign_in, offer)` |
| `an_install_that_fails_shows_its_lines_and_retry` | `InstallDone(Err(["a","b"]))` → `Show(install, failed, ["a","b"])`; `Act(Retry)` → `RunInstall`, `Show(install, working)` |
| `the_first_screen_waits_for_both_answers` | found, `Auth(Some(false))` alone → no `Show`; then `Claude(…)` → `Show(sign_in, offer)`; with everything asked → no `Show` |
| `sign_in_from_offer_to_browser_to_done` | `Act(SignIn)` → `RunLogin`, `Show(sign_in, working)`; `AuthorizeUrl(u)` → `OpenUrl(u)`, `Show(sign_in, browser, [])`; `Waiting("w")` → `Show(sign_in, browser, ["w"])`; `Done(Ok)` → `Save(asked_sign_in)`, `ReadAuth`, a menu with `Signed in`, then the Claude offer when it is due, else `Show(None)` |
| `a_sign_in_that_fails_offers_retry` | `Done(Err("fetch failed"))` → `Show(sign_in, failed, ["fetch failed"])`; `Act(Retry)` → `RunLogin` |
| `cancel_takes_the_sign_in_back` | in `browser`, `Act(Cancel)` → `CancelLogin`, `Show(sign_in, offer)`; a `Done(Err)` after it shows nothing |
| `later_and_not_now_are_remembered` | `Act(Later)` → `Save(asked_sign_in)`; `Act(NotNow)` → `Save(asked_claude)`; a new `App` from that state shows no screen |
| `claude_turns_on_from_the_window` | `Act(TurnOn)` → `SetClaude(true)`, `Show(claude, working)`; `ClaudeSet(Ok)` → `ReadClaude`, `Save(asked_claude)`, `Show(None)`; `ClaudeSet(Err("x"))` → `Show(claude, failed, ["x"])` |
| `claude_turns_off_from_the_menu` | `Menu(ClaudeOff)` → `SetClaude(false)`, no `Show`; `ClaudeSet(Ok)` → `ReadClaude`; `Claude(enabled false)` → rows `Claude Code: Off`, `Turn on…` |
| `no_claude_row_or_screen_without_the_command` | `Claude(None)` → no Claude row, `due` never `Claude` |
| `the_menu_reads_again_at_most_once_a_minute` | `MenuOpened` 10 s after start → no read; at 60 s → `ReadAuth`, `ReadClaude`; at 70 s → none; `desktop_installed` flips the `Open Harness` row |
| `a_dial_line_changes_the_menu_and_the_log` | `WatchLine(attached, fw)` → `Menu` starting `Dial connected · 0.0.95` and `Log("menu: Dial connected · 0.0.95 \| …")`; the same line again → neither |
| `the_keep_alive_drives_the_daemon` | `WatchExit(Some(3))`, `Tick`, `WatchExit(Some(3))`, `Tick{now: B+10, desktop_running: false}` → `RunStart`; with `desktop_running: true` → `SpawnWatch` and one `Log("keep-alive: the desktop app runs; not starting")`, not one per tick |
| `a_cli_that_comes_back_is_found_on_a_tick` | `removed()`, `Tick` → `FindCli`; `Cli(true)` → `SpawnWatch`, reads, a menu without `Install` |
| `a_second_click_runs_nothing_twice` | `Menu(SignIn)` twice during a sign-in → one `RunLogin`; `Act(TurnOn)` twice → one `SetClaude`; `Menu(Install)` twice → one `RunInstall`; `Menu(ClaudeOff)` twice before `ClaudeSet` → one `SetClaude(false)` |
| `closing_the_window_on_an_offer_is_later` | `WindowClosed` on `sign_in, offer` → `Save(asked_sign_in)`, `Show(None)`; on `claude, offer` → `Save(asked_claude)`; neither opens another screen |
| `closing_the_window_never_stops_what_runs` | on `sign_in, browser` → no `CancelLogin`, `Save(asked_sign_in)`; a later `Done(Ok)` → `Signed in`, no `Show`; on `install, working` → no effect but `Show(None)`; a later `InstallDone(Err)` → menu `Setting up Harness \| Install \| …`, no `Show` (decision 1) |
| `open_and_quit` | `Menu(OpenHarness)` → `OpenDesktop`; `Menu(Quit)` → `StopWatch` then `Quit` |

- [ ] **Step 2: Run** `cargo test --lib app::` → fails to compile. Commit `Harness Device: the app's rules
(failing)`.

- [ ] **Step 3: Implement** the rules. `App` keeps the last `now` it was told and gives it to the keep-alive.

- [ ] **Step 4: Run** `cargo test --lib app::` → pass.

- [ ] **Step 5: Commit** `Harness Device: the rules that join the menu, the window and the daemon`.

---

### Task 12: Runner

**Depends on:** Tasks 2, 3, 6, 7, 8, 9, 10, 11. **Effort:** xhigh (threads and child processes).

**Red test:** `runner::tests`.

**Files:**
- Modify: `device-app/src-tauri/src/runner.rs`

**Interfaces:**
- Consumes: every module's `Produces` above.
- Produces:
  - `struct Doors { home: PathBuf, path_var: Option<OsString>, cli_override: Option<PathBuf>,
    shell: Option<Arc<dyn Shell>>, login_item: Arc<dyn LoginItem>, state: Arc<dyn StateFile>, log: Arc<dyn Log>,
    open: Arc<dyn Fn(&[&str]) -> io::Result<()> + Send + Sync> }`
  - `struct Runner` with `fn new(doors: Doors, send: Arc<dyn Fn(Event) + Send + Sync>) -> Runner`,
    `fn find_cli(&self) -> bool` (looks now and keeps what it found for later runs),
    `fn run(&self, effect: Effect) -> Option<Effect>`: `Menu`, `Show` and `Quit` come back untouched; everything
    else is done here, anything slow on a thread, and answers through `send`.

| Effect | What runs | Answer |
|---|---|---|
| `FindCli` | `find_cli()` | `Cli(found)` |
| `SpawnWatch` | `watch::spawn_watch`; a watch still running is stopped first, and nothing more of it is sent (its late `WatchExit(Some(0))` would read as the app closing the new one) | its events; `Cli(false)` when the program is not there |
| `StopWatch` | `Watch::stop` | `WatchExit(Some(0))` |
| `RunStart` | `start --if-down`, `START_DEADLINE` | `StartDone { ok }`: exit 0 and not timed out |
| `RunInstall` | `install::install`, with `find_cli()` as its `cli_there`; with no shell `Err([NOT_SUPPORTED])` | `InstallDone` |
| `ReadAuth`, `ReadClaude` | `account::auth_status`, `claude::status` | `Auth`, `Claude` |
| `RunLogin`, `CancelLogin` | `account::login`, `Login::cancel` | its events |
| `SetClaude(on)` | `claude::set`; a failure is one log line `claude: {message}` | `ClaudeSet` |
| `OpenUrl(url)`, `OpenDesktop` | `open([url])`, `open(["-b", "ai.autonomous.harness"])`; a failure is one log line | none |
| `RegisterLoginItem` | `LoginItem::register`; log `login item: registered` or `login item: not registered: {error}` | `LoginItem(ok)` |
| `Save(saved)` | `StateFile::save`; a failure is `state: could not save: {error}` | none |
| `Log(text)` | `Log::line` | none |

- [ ] **Step 1: Write the failing tests** (a `world()` helper: a `Fake`, `cli_override` at `fake.program()`, an
  empty temp home, a recording shell, login item, state file and `open`, a `MemoryLog`, and a channel for events)

| Test | Asserts |
|---|---|
| `each_effect_gives_its_answer` | one row of the table per assertion, against the fake: `RunStart` puts `start --if-down` in `calls()` and answers `StartDone { ok: true }`; a script with `@exit 1` → `ok: false`; `SetClaude(true)` → `device claude enable`; and so on |
| `a_cli_that_vanished_says_so` | `find_cli()` true; the test deletes `fake.program()`; `SpawnWatch` → `Cli(false)` |
| `an_install_counts_only_when_a_cli_is_there` | no override; a shell double whose runs exit 0 and install nothing → `InstallDone(Err(…))`; one whose run writes an executable launcher into the temp home's `.local/bin` (a two-line script that prints `{"loggedIn":true}`) → `InstallDone(Ok(()))`, and a `ReadAuth` after it answers `Auth(Some(true))` |
| `install_off_a_mac_is_not_supported` | `shell: None`, `RunInstall` → `InstallDone(Err(["Not supported here."]))` |
| `what_opens_is_fixed` | `OpenDesktop` → the `open` double saw `["-b", "ai.autonomous.harness"]`; `OpenUrl("https://id.example/a?state=S")` → `["https://id.example/a?state=S"]` |
| `the_binary_gets_its_three_effects_back` | `Menu`, `Show`, `Quit` come back; every other effect gives `None` |
| `a_second_watch_replaces_the_first` | `SpawnWatch` twice → the first child ended (`ends()` has it once), one watch runs, and no `WatchExit` of the first reaches `send`; then `StopWatch` → `WatchExit(Some(0))` of the second |
| `from_start_to_dial_connected` | `App::new` with what `find_cli()` said; every effect goes through `run`, every event back into `handle`, until a `Menu` whose first row is `Dial connected · 0.0.95` (scripts: the watch prints that status and `@stdin`; `auth status` says signed in; no Claude script). `calls()` holds `hardware watch --json`, `auth status --json`, `device claude status --json` |
| `nothing_personal_reaches_the_log` | a sign-in run whose URL has `?state=S` and whose result has an email → no log line holds `state=S` or `@` |

- [ ] **Step 2: Run** `cargo test --lib runner::` → fails to compile. Commit `Harness Device: run what the rules ask
(failing)`.

- [ ] **Step 3: Implement.** One thread per slow effect; the runner holds the current `HarnessCli`, `Watch` and
  `Login` behind mutexes. An effect that needs the CLI when none is known answers `Cli(false)`.

- [ ] **Step 4: Run** `cargo test --lib` (the whole library) → pass.

- [ ] **Step 5: Commit** `Harness Device: run what the rules ask, and answer with events`.

---

### Task 13: UI screens

**Depends on:** Task 1. **Effort:** high.

**Red test:** `ui/src/screens.test.ts`.

**Files:**
- Modify: `device-app/ui/src/main.ts`, `device-app/ui/src/styles.css`, `device-app/ui/index.html`
- Create: `device-app/ui/src/screens.ts`, `device-app/ui/src/screens.test.ts`

**Interfaces:**
- Consumes: `api.ts` (`view`, `act`, `onView`, the types).
- Produces: `screens.ts`: `function render(root: HTMLElement, view: View | null, act: (action: Action) => void):
  void` (draws one screen; `null` draws nothing); `main.ts`: `function start(root: HTMLElement): Promise<void>`
  (draws `view()`'s answer, then each `onView` view), called on load with `#app`.

- [ ] **Step 1: Write the failing tests** (`vi.mock('./api')`; `mount(view)` calls `start`, keeps the `onView`
  listener as `push`, and gives `heading()`, `text()`, `buttons()` (labels in order), `click(label)`, `spinner()`)

| Test | A person does and sees |
|---|---|
| `install: progress, then failure, then Retry` | `install, working` → heading `Setting up Harness`, a spinner, no button. `push(install, failed, ["curl: (6) Could not resolve host", "exit 6"])` → both lines, button `Retry`. Click → `act('retry')`. `push(install, working)` → the spinner again |
| `sign-in: offer, browser, done` | `sign_in, offer` → heading `Sign in`, `Add your other computers to the dial.`, buttons `Sign in`, `Later`. Click `Sign in` → `act('sign_in')`. `push(sign_in, working)` → a spinner, button `Cancel`. `push(sign_in, browser, ["Harness is finishing an update"])` → heading `Finish in your browser`, the note, `Cancel`. Click → `act('cancel')`. `push(null)` → the page is empty |
| `sign-in: Later, and a failure` | `Later` → `act('later')`. `push(sign_in, failed, ["fetch failed"])` → `fetch failed`, button `Retry` → `act('retry')` |
| `Claude Code: Turn on, Not now, a failure` | `claude, offer` → heading `Claude Code`, both sentences, buttons `Turn on`, `Not now`. `Turn on` → `act('turn_on')`. `push(claude, working)` → a spinner, no button. `push(claude, failed, ["Claude Code is too old."])` → the text, `Retry`. From a fresh offer, `Not now` → `act('not_now')` |
| `outside text is drawn as text` | `lines: ["<img src=x onerror=alert(1)>"]` → the page has no `img` element; the text shows as typed |
| `the first button has the focus` | on each offer, `document.activeElement` is the primary button |

- [ ] **Step 2: Run** `cd device-app/ui && npx vitest run src/screens.test.ts` → fails (no `screens.ts`). Commit
`Harness Device: the three screens (failing)`.

- [ ] **Step 3: Implement.** `textContent` only, never `innerHTML`. Words and tokens are the contract's. Buttons are
  real `<button>` elements; the spinner has `role="status"`. Every string the page shows, the spinner's accessible
  name and the page's title included, is the contract's word for word or follows `docs/naming-system.md` (decision
  5); the report lists each string that is not in the contract.

- [ ] **Step 4: Run** `npx tsc --noEmit && npx vitest run && npm run build` → pass; `dist/` holds `index.html`,
  `main.js`, `styles.css`.

- [ ] **Step 5: Commit** `Harness Device: the Install, Sign in and Claude Code screens`.

---

### Task 14: Gallery and design doc

**Depends on:** Task 13. **Effort:** high.

**Red test:** `ui/src/gallery.test.ts`.

**Files:**
- Create: `device-app/ui/gallery.html`, `device-app/ui/src/gallery.ts`, `device-app/ui/src/gallery.test.ts`
- Modify: `desktop/design/desktop-design-system.md` (a new section before `## Interaction and review`)

**Interfaces:**
- Consumes: `screens.render`, the `View` type.
- Produces: `gallery.ts`: `const STATES: { name: string; view: View }[]` and `function draw(root: HTMLElement): void`.

`STATES`, in this order: `install working`; `install failed` (4 lines); `sign in offer`; `sign in working`; `sign in
browser`; `sign in browser, waiting` (one line); `sign in failed`; `claude offer`; `claude working`; `claude failed`.

- [ ] **Step 1: Write the failing test**

`the gallery draws every state in both themes`: `draw(root)` → `root.querySelectorAll('[data-theme="light"]
.frame')` and the dark one each have `STATES.length` frames; each frame is 420 × 320 (inline size), has a caption
equal to its state's name, and holds what `render` draws for that view (its heading text matches); `STATES` holds
every screen with every phase the contract's screen table lists (10 rows); the page holds the tray icon twice (on a
light and on a dark bar).

- [ ] **Step 2: Run** `npx vitest run src/gallery.test.ts` → fails. Commit `Harness Device: the gallery (failing)`.

- [ ] **Step 3: Implement.** `gallery.html` loads `src/styles.css` and `dist-gallery/gallery.js` (a classic script,
  so it opens from a file). The buttons in the gallery do nothing. The doc section, under `## Harness Device`:
  what the app is (two lines); that its window has three screens at 420 × 320 and its menu is native; the token
  table (CSS name → this document's role) and the type and geometry rows it uses; the tray icon (the gallery shows
  `../src-tauri/icons/tray.png`); a link to
  `../../device-app/ui/gallery.html` and how to build it (`npm run gallery` in `device-app/ui`); that a change to a
  screen changes the gallery and this section in the same pull request. The captions, the page's title and every
  sentence of the doc section follow `docs/naming-system.md` (decision 5): `Harness` and `Claude Code` as it writes
  them, the screens and buttons by the contract's words; the report lists each string that is not in the contract.

- [ ] **Step 4: Run** `npx vitest run && npm run gallery`, then `open gallery.html`: 20 frames, readable in both
  themes, nothing clipped at 420 × 320.

- [ ] **Step 5: Commit** `Harness Device: its gallery, and its section in the desktop design doc`.

---

### Task 15: Binary

**Depends on:** Tasks 12, 13. **Effort:** high.

**Red test:** none. The spec keeps tray, window and timer in the binary, outside `cargo test`; every rule they call
is tested in Tasks 2 to 12. One commit; its proof is Step 3 here and Verification.

**Files:**
- Modify: `device-app/src-tauri/src/main.rs`; if Step 3 shows the need, `tauri.conf.json` and
  `capabilities/default.json` (then `types::tests` still pass)

**Interfaces:**
- Consumes: `app::App`, `runner::{Runner, Doors}`, `types::*`, `desktop::{SystemDesktopApp, run_open}`,
  `loginitem::SystemLoginItem`, `state::JsonStateFile`, `log::FileLog`, `install::system_shell`,
  `cli::cli_override`.

- [ ] **Step 1: Write `main.rs`**

- **Doors:** home from Tauri's `home_dir`; `path_var` from the environment's `PATH`; state in `app_data_dir`, log
  in `app_log_dir`; `cli_override(cfg!(debug_assertions), env "HARNESS_DEVICE_CLI")`; `open` is
  `desktop::run_open`.
- **One loop thread** owns the `App`: it takes events from a channel, calls `handle`, gives each effect to
  `Runner::run`, and hands what comes back to the main thread (`run_on_main_thread`).
- **Start:** `runner.find_cli()`, `SystemDesktopApp.installed()` (main thread), `App::new`, run its effects.
- **Tick:** a thread wakes every 5 s and, on the main thread, sends `Tick { now, desktop_running:
  SystemDesktopApp.running() }`.
- **Tray:** id `main`, the template icon `icons/tray.png` (`icon_as_template(true)`), tooltip `Harness Device`, the
  menu on a click. A click on the icon sends `MenuOpened { now, desktop_installed }`. `Effect::Menu(items)` builds a
  native menu: `Text` a disabled item, `Action` an item whose id is the action's name, `Separator`; a chosen item
  sends `Event::Menu`.
- **Window `main`:** `Effect::Show(Some(view))` keeps the view, emits `view` with it, shows and focuses the window;
  `Show(None)` emits `view` with `null` and hides it. A close request is refused, the window is hidden, and
  `WindowClosed` is sent. Commands: `view` returns the kept view; `act(action: Action)` sends `Event::Act`.
- **macOS:** activation policy Accessory (decision 3).
- **Quit:** `Effect::Quit` exits the app; the daemon is left alone.

- [ ] **Step 2: Build** `(cd device-app/ui && npm run build) && cd device-app/src-tauri && cargo build && cargo
test` → all pass.

- [ ] **Step 3: Launch it against the fake CLI**, under the isolation of [Verification](#verification) (its `env`
  file and stubs), with `HARNESS_DEVICE_CLI` at `device-app/src-tauri/tests/fake-harness` and the scripts of check
  2's first row. Expected: a dial icon in the menu bar; the log in
  `$HOME/Library/Logs/ai.autonomous.harness.device/` has `menu: No dial | Signed in | Claude Code: On | Turn off |
  …`; the menu shows those rows; Quit ends the process. With `auth status` saying signed out and a first-run state
  (Verification: `loginItem` already true, so this Mac gets no login item), the window opens on Sign in, 420 × 320,
  and `Later` hides it. If a click on the icon sends no `MenuOpened` on
  macOS, say so in the report: the reads then follow the tick, and that is a finding for the main session.

- [ ] **Step 4: Commit** `Harness Device: the tray, the window and the timer`.

---

### Task 16: `--if-down` guards

**Depends on:** nothing. **Effort:** high (every supervisor runs this: the Windows scheduled task and this app).

**Red test:** `cli/src/lib/startIfDown.spec.ts`.

**Layer:** launcher. `startIfDown.ts` runs in the `harness start --if-down` process and `flash.ts` in `harness
flash`'s; the new `flasherDir.ts` is theirs. None is in `architecture.coreFiles.txt`, and nothing the core loads may
import any of them: Step 4 proves it (the architecture spec passes, the list has no diff).

**Files:**
- Create: `cli/src/lib/flasherDir.ts`
- Modify: `cli/src/lib/flash.ts` (lines 32-37 and 120: the folder comes from `flasherDir.ts`),
  `cli/src/lib/startIfDown.ts`
- Test: `cli/src/lib/startIfDown.spec.ts`

**Interfaces:**
- Produces:
  - `flasherDir.ts`: `export const FLASHER_DIR: string` (`HARNESS_FLASHER_CACHE`, else `~/.harness/flasher`; the
    comment moves with it). It imports nothing of the flasher.
  - `startIfDown.ts`: `IfDownDeps` and `IfDownIo` each gain `flashing(): boolean` and `uninstalling(): boolean`;
    `export function freshMarker(file: string, nowMs: number = Date.now()): boolean`;
    `export function flashHolds(dir: string, nowMs: number = Date.now()): boolean`.
  - The two answers: `` { start: false, why: "`harness flash` holds the dial's port" } `` and
    `` { start: false, why: '`harness uninstall` is at work' } ``.

- [ ] **Step 1: Write the failing tests**

The `deps()` helper gains `flashing: () => false, uninstalling: () => false`; `io()` the same.

```ts
describe('harness start --if-down while a flash or an uninstall is at work', () => {
  it('does nothing, after the logon start forgot a stop and before the pid file is read', async () => {
    await expect(startIfDown(deps({ flashing: () => true }))).resolves.toEqual({ start: false, why: "`harness flash` holds the dial's port" })
    await expect(startIfDown(deps({ uninstalling: () => true }))).resolves.toEqual({ start: false, why: '`harness uninstall` is at work' })
    const forgetStop = vi.fn(), readPid = vi.fn(() => null)
    await startIfDown(deps({ flashing: () => true, forgetStop, readPid }), { atLogon: true })
    expect(forgetStop).toHaveBeenCalledOnce()
    expect(readPid).not.toHaveBeenCalled()
    // A `harness stop` still answers first.
    await expect(startIfDown(deps({ stoppedThisBoot: () => true, flashing: () => true }))).resolves.toMatchObject({ why: expect.stringMatching(/^`harness stop`/) })
  })
})
```

| Test | Asserts |
|---|---|
| `a marker is fresh for ten minutes, and never from the future` | with `now = 1_800_000_000_000`: text `1799999401` (599 s old), with a newline after it → true; `1799999400` (600 s) → false; `1800000001` → false; `soon`, an empty file, `12.5`, a missing file, a folder of that name → false |
| `a flash holds the port by either of its files` | a fresh `flashing` → true; a fresh `flashing.` + 32 lower-case hex → true; `flashing.` + 31 hex, upper-case hex, `flashing.bak`, a stale file, a missing folder → false |
| `every supervisor asks, on every platform` | `processIfDownDeps('win32', io({ flashing: () => true })).flashing()` and the same for `'darwin'` and `'linux'` are true; likewise `uninstalling` |
| `the scheduled task decides as before when neither is at work` | `startIfDown(processIfDownDeps('win32', io({ stoppedThisBoot: () => false })))` → `{ start: false, why: 'it runs (pid 500)' }`; with `readPid: () => null` as well → `{ start: true }`; with `io()` as it is (its `stoppedThisBoot` is true) → the `harness stop` sentence |
| `this computer's own markers are read by default` | `FLASHER_DIR` lies under the test's home; with a fresh `flashing` there `processIfDownDeps('darwin').flashing()` is true; with a fresh `uninstalling` in `~/.harness`, `.uninstalling()` is true; without them both are false |

- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/startIfDown.spec.ts` → the new tests fail. Commit `harness
start --if-down: tests for a flash and an uninstall at work (failing)`.

- [ ] **Step 3: Implement.** `startIfDown` asks `flashing()` then `uninstalling()` after the stop check and before
  `readPid()`. `freshMarker`: the file's trimmed text is whole digits, a Unix time in seconds; fresh when its age is
  at least 0 and under 600,000 ms; anything unreadable is not fresh (fail open, as
  `desktop/lib/core/serial_port_lease.dart` and `uninstall_marker.dart`). The uninstall marker is
  `join(homedir(), '.harness', UNINSTALL_MARKER)` (`lib/uninstall/removal.ts`).

- [ ] **Step 4: Run** `npx vitest run src/lib/startIfDown.spec.ts src/lib/flash.spec.ts src/architecture.spec.ts &&
npm run typecheck` → pass. Then
`git diff --exit-code "$(git merge-base origin/main HEAD)" -- src/architecture.coreFiles.txt` → no output (the core
loads neither the guards nor `flasherDir.ts`).

- [ ] **Step 5: Commit** `harness start --if-down: leave the daemon down while a flash or an uninstall is at work`.

---

### Task 17: Daemon: dial watchers

**Depends on:** nothing. **Effort:** xhigh (the core's process; who a frame is sent to).

**Red test:** `cli/src/backendSocket.dialWatch.spec.ts`.

**Layer:** transport, in the core's process (`architecture.coreFiles.txt` line 5; not under `src/core/`, so
`npm run test:core` does not measure it). The change is only who a `dial_status` frame is sent to: one set of
connection ids, filled at registration, read in `sendLocal`, emptied at unregistration. No dial rule, no reading of
the payload, no new import, no new `coreFiles` line. The spec below covers every new branch.

**Files:**
- Modify: `cli/src/backendSocket.ts` (`toolClients`' comment near line 115, `sendLocal` near 673,
  `registerLocalClient` near 764, `unregisterLocalClient` near 814)
- Create: `cli/src/backendSocket.dialWatch.spec.ts`

**Interfaces:**
- Produces: `registerLocalClient(connId, sink, opts: { tool?: boolean; surface?: WindowSurface; watch?: readonly
  'dial'[] } = {})`. A tool registered with `watch` holding `'dial'` is sent every `dial_status` frame `sendLocal` is
  given, and nothing else by this way. It stays a tool: not in `localWindows()`, `hasLocalClient()` or
  `localClientIds()`.

- [ ] **Step 1: Write the failing tests** (as `backendSocket.toolWatch.spec.ts`: `relaySocket('fixture')`, sinks that
  collect frames)

```ts
it('sends dial_status to a tool that asked for the dial, each time it changes, and to no other tool', async () => {
  const socket = relaySocket('fixture')
  const into = (frames: Frame[]) => ({ sendFrame: (frame: Frame) => { frames.push(frame); return true }, sendBinary: () => true })
  const watcher: Frame[] = [], tool: Frame[] = [], window: Frame[] = []
  socket.registerLocalClient('local:watcher', into(watcher), { tool: true, watch: ['dial'] })
  socket.registerLocalClient('local:tool', into(tool), { tool: true })
  try {
    // Still no window: the machine list on the dial must not end because the menu-bar app is open.
    expect(socket.hasLocalClient()).toBe(false)
    expect(socket.localClientIds()).toEqual([])
    socket.registerLocalClient('local:window', into(window))
    const attached = { type: 'dial_status', payload: { attached: true, fw: '0.0.95' } }
    const gone = { type: 'dial_status', payload: { attached: false } }
    socket.sendLocal(attached)
    socket.sendLocal(gone)
    socket.sendLocal({ type: 'dial_scroll', payload: { phase: 'move', dy: 1, velocity: 0 } })
    socket.sendLocal(() => attached)   // a frame made per window is a window's
    expect(watcher).toEqual([attached, gone])
    expect(tool).toEqual([])
    expect(window.map((frame) => frame.type)).toEqual(['dial_status', 'dial_status', 'dial_scroll', 'dial_status'])
    await socket.unregisterLocalClient('local:watcher')
    socket.sendLocal(attached)
    expect(watcher).toHaveLength(2)
  } finally {
    for (const id of ['local:watcher', 'local:tool', 'local:window']) await socket.unregisterLocalClient(id)
    await socket.stop()
  }
})
```

| Test | Asserts |
|---|---|
| `lets go of a watcher whose socket is gone` | a watcher whose `sendFrame` returns false is asked once; the next `dial_status` does not call it; `isToolClient` is false for it |
| `a window that names watch is a window` | `registerLocalClient('local:w', sink, { watch: ['dial'] })` → `hasLocalClient()` true; one `dial_status` reaches it once, not twice |
| `send never reaches a watcher` | `socket.send({ type: 'dial_status', payload: { attached: true } })` → the watcher has nothing |

- [ ] **Step 2: Run** `cd cli && npx vitest run src/backendSocket.dialWatch.spec.ts` → fails. Commit `Daemon: tests
for a tool that asks for the dial's status (failing)`.

- [ ] **Step 3: Implement.** A `dialWatchers` set of connection ids; `registerLocalClient` adds a tool whose `watch`
  holds `'dial'`; `sendLocal`, after the windows, sends a `dial_status` frame (never a per-window function) to each
  through `sendLocalTo`; `unregisterLocalClient` removes it. The comment on `toolClients` says what a tool may now be
  pushed.

- [ ] **Step 4: Run** `npx vitest run src/backendSocket.dialWatch.spec.ts src/backendSocket.toolWatch.spec.ts
src/backendSocket.devices.spec.ts src/architecture.spec.ts && npm run typecheck` → pass;
`git diff --exit-code "$(git merge-base origin/main HEAD)" -- src/architecture.coreFiles.txt` → no output;
`git diff "$(git merge-base origin/main HEAD)" -- src/backendSocket.ts | grep '^+import'` → no output (no new import
in the core's process).

- [ ] **Step 5: Commit** `Daemon: a tool that asks for the dial is sent dial_status, and is still no window`.

---

### Task 18: Daemon: `watch` on the local socket

**Depends on:** nothing. **Effort:** xhigh (the core's process; a field a client shapes).

**Red test:** `cli/src/localWsServer.spec.ts`.

**Layer:** transport, in the core's process (`architecture.coreFiles.txt` line 547; not under `src/core/`). The
change is only what a tool's `machine_select` may ask and who is sent the `dial_status` that follows `connected`:
`watch` is read as data (an array, known names kept, the rest dropped), handed to the backend, and never acted on
here. No dial rule, no new import, no new `coreFiles` line.

**Files:**
- Modify: `cli/src/localWsServer.ts` (`LOCAL_TOOL_FEATURES` line 30, `LocalWsBackend.registerLocalClient` line 44,
  the selection near 474-497)
- Test: `cli/src/localWsServer.spec.ts` (`FakeBackend` records `watches`; the features test near line 130)

**Interfaces:**
- Produces: `LOCAL_TOOL_FEATURES = ['openclaw-local', 'dial-watch']`; `LocalWsBackend.registerLocalClient`'s `opts`
  is `{ tool?: boolean; surface?: 'tui'; watch?: readonly 'dial'[] }`; a tool is registered with `{ tool: true,
  watch }`, where `watch` is the known names (`'dial'`) found in `machine_select`'s `watch` array, else `[]`; a
  window's `watch` is never read. The `dial_status` right after `connected` goes to a window, and to a tool whose
  `watch` holds `'dial'`.

- [ ] **Step 1: Write the failing tests**

`FakeBackend.registerLocalClient` also pushes `opts.watch` to `watches`. In `tells a tool what this daemon can do`,
the tool's features become `['openclaw-local', 'dial-watch']`.

A helper `after(ws, backend)` makes absence checkable without waiting: it sends `{ type: 'agents_list', payload: {
requestId: 'after' } }`, waits until `backend.frames` holds it, calls `local!.sendToWindow(backend.connId!, { type:
'marker', payload: {} })`, and resolves with every frame type the client received up to `marker`.

| Test | Asserts |
|---|---|
| `sends the last dial status to a window and to a tool that asked for the dial` | with `dialStatus: () => ({ attached: true, fw: '0.0.95' })`: a window receives `connected`, `dial_status` (that payload), …, `marker`; a tool with `watch: ['dial']` the same, and `backend.watches` is `[['dial']]` |
| `sends a tool that did not ask no dial status` | `{ tool: true }` → the types are `['connected', 'marker']`; `backend.watches` is `[[]]` |
| `reads watch from a tool only, and only names it knows` | `{ tool: true, watch: 'dial' }`, `{ tool: true, watch: ['agents', 7, null] }`, `{ tool: true, watch: {} }` → registered with `watch: []`, no `dial_status`; `{ tool: true, watch: ['agents', 'dial', 'dial'] }` → `['dial']`; a window that sends `watch: ['dial']` is registered with no `tool` and no `watch` (`backend.tools` empty, `backend.watches` `[undefined]`) and still receives `dial_status`; `harness tui` (`client: 'tui'`) still receives it |

- [ ] **Step 2: Run** `cd cli && npx vitest run src/localWsServer.spec.ts` → the new and the changed test fail.
Commit `Daemon: tests for watch on a tool's machine_select (failing)`.

- [ ] **Step 3: Implement** as the interfaces say. Nothing else in the selection changes.

- [ ] **Step 4: Run** `npx vitest run src/localWsServer.spec.ts src/architecture.spec.ts && npm run typecheck` →
pass; `git diff --exit-code "$(git merge-base origin/main HEAD)" -- src/architecture.coreFiles.txt` → no output;
`git diff "$(git merge-base origin/main HEAD)" -- src/localWsServer.ts | grep '^+import'` → no output.

- [ ] **Step 5: Commit** `Daemon: a tool's machine_select may ask for the dial, and only then is told its status`.

---

### Task 19: `harness hardware watch`

**Depends on:** nothing. **Effort:** high.

**Red test:** `cli/src/devices/client.spec.ts`.

**Layer:** a CLI client command. `devices/client.ts` and `cli.ts` run in the `harness hardware watch` process, one
per run, which talks to the daemon as a tool on its local socket. Neither is in `architecture.coreFiles.txt`.
Everything the command decides (the six fields, printing only a change, the exit codes) is here; the daemon only
sends the frame (Tasks 17 and 18).

**Files:**
- Modify: `cli/src/devices/client.ts`, `cli/src/cli.ts` (the `hardware` case near line 2945)
- Test: `cli/src/devices/client.spec.ts`

**Interfaces:**
- Produces, in `client.ts`:
  - `interface DialWatchDeps extends Pick<DevicesClientDeps, 'port' | 'dataDir' | 'machineId' | 'connect'> {
    stdin: { on(event: 'end' | 'close', listener: () => void): unknown; resume(): unknown; pause(): unknown };
    print(line: string): void }`
  - `function dialWatchLine(payload: unknown): string`: JSON of `attached` (true only for `true`), then `fw`, `hw`,
    `board`, `updating`, `problem`, each only when it is a string, in that order.
  - `function runDialWatch(argv: string[], deps: DialWatchDeps): Promise<number>` (`argv`: the words after `watch`).
    Exit codes: 3 the daemon cannot be reached (no machine id, a connect error, any close, before or after
    `connected`); 4 the daemon has no `dial-watch`; 0 stdin closed; 1 anything else.
  - `DEVICES_USAGE` gains, after the `set` line: `  watch [--json]   one line each time this computer's dial changes`.
  - The line printed before exit 4: `{"error":"Harness on this computer is too old for this. Run: harness update"}`.
- `cli.ts`: `hardware watch …` calls `runDialWatch(rest.slice(1), { port: daemonPort(), machineId, connect, stdin:
  process.stdin, print: (line) => console.log(line) })` and sets `process.exitCode`; every other `hardware` command
  goes to `runDevicesCommand` as today.

- [ ] **Step 1: Write the failing tests** (a socket and a stdin that are `EventEmitter`s with spies, as the file's
  `deviceRequest` test; `watch(over)` starts `runDialWatch([ '--json' ], …)` and returns `{ done, socket, stdin,
  printed }`; `connected(features)` emits the `connected` frame)

| Test | Asserts |
|---|---|
| `exits 3 when no daemon runs` | `machineId: async () => null` → 3; `connect` is never called |
| `exits 3 when the daemon cannot be reached` | `connect` throws → 3; the socket emits `error` → 3; `close` with 1006 before `connected` → 3; `close` with 4403 before `connected` → 3; `close` with 1000 after `connected` → 3 |
| `asks for the dial as a tool` | on `open` the first frame sent is `{ type: 'machine_select', payload: { machineId: 'local', localProtocolVersion: 1, tool: true, watch: ['dial'] } }` |
| `exits 4 on a daemon without dial-watch` | `connected(['openclaw-local'])` and `connected(undefined)` → one printed line, the error line above; resolves 4; the socket is closed |
| `prints one line each time the status changes` | after `connected(['dial-watch'])`: `{ attached: false, devices: [] }` → `{"attached":false}`; the same again → nothing; `{ attached: true, fw: '0.0.95', hw: 'cst816s', settings: { brightness: 80 }, devices: [{}] }` → `{"attached":true,"fw":"0.0.95","hw":"cst816s"}`; the same with `brightness: 20` → nothing; with `updating: '0.0.96'` → a line ending `"updating":"0.0.96"}`; `{ attached: false, board: 'pro', problem: 'Not answering — unplug and replug' }` → that line |
| `skips what is not a status` | a frame that is not JSON, `{ type: 'agents_list_result' }`, a `dial_status` whose payload is a string → nothing printed, still running |
| `exits 0 when stdin closes` | `stdin.emit('end')` after `connected` → 0, the socket closed; before `connected` → 0; `stdin.resume` was called at the start |
| `lets go of everything when it ends` | after any exit: `socket.close` called, `stdin.pause` called |
| `anything else is its usage and exit 1` | `runDialWatch(['now'], deps)` → prints `DEVICES_USAGE`, 1, no connect |
| `--json is accepted and not needed` | `runDialWatch([], deps)` prints the same NDJSON lines as with `['--json']` |
| `the usage names watch` | `DEVICES_USAGE` contains `watch [--json]` and `one line each time this computer's dial changes` |

- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/client.spec.ts` → the new tests fail. Commit `harness
hardware watch: tests (failing)`.

- [ ] **Step 3: Implement.** Its own runner, not `runDevicesCommand`. It prints NDJSON with or without `--json`.

- [ ] **Step 4: Run** `npx vitest run src/devices/client.spec.ts src/architecture.spec.ts && npm run typecheck` →
pass; `git diff --exit-code "$(git merge-base origin/main HEAD)" -- src/architecture.coreFiles.txt` → no output.

- [ ] **Step 5: Commit** `harness hardware watch: one line each time this computer's dial changes`.

---

### Task 20: CI component

**Depends on:** nothing. **Effort:** high.

**Red test:** `scripts/tests/test_ci_plan.py`.

**Files:**
- Modify: `scripts/ci-plan.py` (`EXTRA` line 31, `COMPONENTS` line 44), `.github/workflows/ci.yml`,
  `docs/validation-and-release.md` (the PR CI table)
- Test: `scripts/tests/test_ci_plan.py`

**Interfaces:**
- Produces: the suite `device-app` (in `EXTRA`, so `JOBS` names `device-app-checks` and `MANUAL` takes the scope);
  `COMPONENTS["device-app"] = "device-app"`. No `PR_READS`, `DEPENDS` or `SOURCE_INPUTS` entry: the app reads no
  file outside `device-app/` (the Global Constraints keep it so).

- [ ] **Step 1: Write the failing tests**

In `test_each_component_owns_only_its_own_suite`, add `"device-app/src-tauri/src/lib.rs": {"device-app"}` and
`"device-app/ui/src/main.ts": {"device-app"}`. Add:

```python
def test_the_device_app_runs_its_own_suite_and_no_other(self):
    for path in ("device-app/src-tauri/src/keepalive.rs", "device-app/src-tauri/Cargo.lock",
                 "device-app/ui/package-lock.json", "device-app/AGENTS.md"):
        with self.subTest(path=path):
            self.assertEqual(planner.select([path])[0], {"device-app"})
    self.assertEqual(planner.JOBS["device-app"], {"device-app-checks"})
    self.assertEqual(planner.MANUAL["device-app"], {"device-app"})
    self.assertNotIn("device-app", planner.PR_READS)

def test_the_workflow_carries_every_suite(self):
    workflow = (Path(__file__).resolve().parents[2] / ".github/workflows/ci.yml").read_text()
    options = re.search(r"(?m)^        options: \[(.+)\]$", workflow).group(1).split(", ")
    self.assertEqual(set(options), set(planner.MANUAL))
    jobs = dict(re.findall(r"(?m)^  ([\w-]+):\n((?:(?:    .*)?\n)+)", workflow))
    needs = set(re.findall(r"[\w-]+", re.search(r"(?m)^    needs: \[((?:.|\n)+?)\]", jobs["required"]).group(1)))
    for suite in sorted(planner.SUITES):
        with self.subTest(suite=suite):
            self.assertIn(f"      {suite}: ${{{{ steps.select.outputs.{suite} }}}}", jobs["plan"])
            for job in planner.JOBS[suite]:
                self.assertIn(f"needs.plan.outputs.{suite} == 'true'", jobs[job])
                self.assertIn(job, needs)
    job = jobs["device-app-checks"]
    for text in ("libwebkit2gtk-4.1-dev", "libayatana-appindicator3-dev", "librsvg2-dev",
                 "working-directory: device-app/ui", "npx vitest run", "npm run build",
                 "cargo test --locked --manifest-path device-app/src-tauri/Cargo.toml"):
        self.assertIn(text, job)
    self.assertLess(job.index("npm run build"), job.index("cargo test"))   # the binary embeds ui/dist
    self.assertNotIn("macos", job)
```

- [ ] **Step 2: Run** `cd scripts/tests && python3 -m unittest test_ci_plan -v` → the two new tests and the changed
one fail. Commit `CI: tests for the device-app component (failing)`.

- [ ] **Step 3: Implement**

- `ci-plan.py`: `"device-app"` in `EXTRA`; `"device-app": "device-app"` in `COMPONENTS`.
- `ci.yml`: `device-app` in the `workflow_dispatch` options; `device-app: ${{ steps.select.outputs.device-app }}` in
  the plan's outputs; `device-app-checks` in `required.needs`; and the job, modelled on `pty-checks`:

```yaml
  device-app-checks:
    concurrency:
      group: ci-${{ github.event_name }}-${{ github.event.action || 'run' }}-${{ github.event.pull_request.number || github.run_id }}-device-app-checks
      cancel-in-progress: ${{ github.event_name == 'pull_request' }}
    needs: plan
    if: needs.plan.outputs.ready == 'true' && needs.plan.outputs.device-app == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ env.CI_SOURCE_SHA }}
      # Tauri's Linux packages: the webview, the tray, SVG icons, and libxdo, which its menu crate links.
      - run: sudo bash scripts/apt-install.sh libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev
      - uses: actions/setup-node@v7
        with:
          node-version: ${{ env.CLI_NODE_VERSION }}
          cache: npm
          cache-dependency-path: device-app/ui/package-lock.json
      - name: UI tests and bundle
        working-directory: device-app/ui
        run: |
          npm ci --no-audit --no-fund
          npx tsc --noEmit
          npx vitest run
          npm run build
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6 # v2.9.2
        with:
          workspaces: device-app/src-tauri
          shared-key: device-app-pr
          cache-bin: false
      - name: Rust unit tests
        run: cargo test --locked --manifest-path device-app/src-tauri/Cargo.toml
```

- `docs/validation-and-release.md`, the PR CI table, a row after `pty/`:
  `` | `device-app/` | `device-app-checks` (the UI's Vitest and bundle, then `cargo test` with Tauri's Linux packages; the macOS code is not compiled) | a few minutes | ``.

- [ ] **Step 4: Run** `python3 -m unittest test_ci_plan -v` → pass; and
`GOTOOLCHAIN=go1.26.8 go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 .github/workflows/ci.yml` from the
root → no output (skip with a note if Go is not installed: the `plan` job runs it).

- [ ] **Step 5: Commit** `CI: device-app is a component with its own Linux check`.

---

### Task 21: AGENTS.md rule 9

**Depends on:** nothing. **Effort:** medium.

**Red test:** none: one line of words that no program reads. One commit.

**Files:**
- Modify: `AGENTS.md` (Code standards, rule 9)

- [ ] **Step 1: Add the line** as the last line of rule 9, indented as the rule's text:

```
   Exception: Harness Device app (`device-app/`): Rust + Tauri, UI webview TypeScript.
```

- [ ] **Step 2: Commit** `AGENTS.md: the Harness Device app is Rust and Tauri`.

---

### Task 22: End-to-end spec for `harness hardware watch`

**Depends on:** Tasks 18, 19. **Effort:** high.

**Red test:** `cli/e2e/hardwareWatch.e2e.ts`, the spec itself, written against the command as the spec defines it.
It fails on this branch's base, where `harness hardware watch` answers with its usage and exit 1; Step 2 shows
that. One commit: the code it tests is Tasks 18 and 19's.

**Layer:** a test (`cli/AGENTS.md` rule 5: end to end for every user-facing flow). It runs in the end-to-end suite's
Vitest process and starts two real ones: the daemon from this checkout (`IsolatedDaemon`) and the `harness hardware
watch` command beside it. Nothing under `src/` changes; no daemon process loads the file.

**Files:**
- Create: `cli/e2e/hardwareWatch.e2e.ts`
- Read, not changed: `cli/e2e/harness/daemon.ts` (`IsolatedDaemon`, `CLI_ROOT`, `until`),
  `cli/e2e/backgroundCommands.e2e.ts` (a running `watch` child read line by line),
  `cli/e2e/agentBrowserPodman.e2e.ts` (`CLI_ENTRY`), `cli/vitest.e2e.config.ts`. A spec that needs a change to
  `cli/e2e/harness/` stops and reports.

**Interfaces:**
- Consumes: `harness hardware watch --json` as Task 19 makes it (NDJSON on stdout; exit 3 the daemon cannot be
  reached, exit 0 stdin closed) and the `dial_status` a tool that asks for the dial is sent after `connected` (Task
  18).
- Produces: nothing another task reads.

**Isolation** (`cli/AGENTS.md` rule 6) is `IsolatedDaemon`'s: a throwaway home, data folder, auth folder, computer
id, port and tmux server, `CABLE_DISABLE=true` (no dial, real or fake, and no devices' process), the backend at
`127.0.0.1:9`. The command runs with the daemon's own environment (`d.env`), so it reads that data folder and port
and never the person's daemon (18473) or `~/.harness`.

- [ ] **Step 1: Write the spec**

```ts
// How `harness hardware watch` is started: the run's bundle when there is one (E2E_BUNDLE), as the daemon runs.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']

/** The command as the menu-bar app runs it: a stdin pipe held open, stdout read line by line as it prints. */
function watch(d: IsolatedDaemon) {
  const child = spawn(process.execPath, [...CLI_ENTRY, 'hardware', 'watch', '--json'], {
    cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: '' }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines: string[] = []
  createInterface({ input: child.stdout }).on('line', (line) => { lines.push(line) })
  const exit = new Promise<number | null>((done) => child.on('close', (code) => done(code)))
  return { child, lines, exit }
}
```

`describe('harness hardware watch on the real daemon')`: one `IsolatedDaemon.create()` and `start()` per test;
`afterEach` kills every watch child still running and closes the daemon; `onTestFailed` prints the last 150 lines
of the daemon's log, as the file's neighbours do. Every wait is `until(…)` on a line or on `exit`: no fixed sleep.

| Test | Asserts |
|---|---|
| `prints that no dial is attached, and stays` | `watch(d)`; `until` its first line → `lines[0]` is exactly `{"attached":false}`, and the child has not exited (`child.exitCode` is `null`) |
| `exits 3 when the daemon stops` | after the first line, `await d.stop()` → `exit` resolves 3 and `lines` is still that one line. Then, with no daemon running, a second `watch(d)` → `exit` resolves 3 and it printed nothing |
| `exits 0 when its stdin closes, and leaves the daemon running` | after the first line, `child.stdin.end()` → `exit` resolves 0; `fetch` of `http://127.0.0.1:${d.port}/api/health` is still ok |

- [ ] **Step 2: See it fail on the branch's base.** From the worktree's root, with `cli/node_modules` installed
  (`npm ci` in `cli/`) and `E2E_BUNDLE` unset:

```bash
B="$(git merge-base origin/main HEAD)"; W="$(mktemp -d)/base"
git worktree add --detach "$W" "$B"
cp cli/e2e/hardwareWatch.e2e.ts "$W/cli/e2e/"
ln -s "$PWD/cli/node_modules" "$W/cli/node_modules"
(cd "$W/cli" && npx vitest run --config vitest.e2e.config.ts e2e/hardwareWatch.e2e.ts)
git worktree remove --force "$W"
```

  Expected: the three tests fail (the first line is the usage as an `{"error":…}` line, and the command exits 1).
  Quote that output in the report: it is the red. A run that fails for another reason (a daemon that does not
  start, a missing module) is not the red: fix the spec or report.

- [ ] **Step 3: Run it on this branch** `cd cli && npm run test:e2e -- e2e/hardwareWatch.e2e.ts` → 3 pass. Three
  times in a row, and once more as `E2E_BUNDLE=1 npm run test:e2e -- e2e/hardwareWatch.e2e.ts` (the build that
  ships): all pass. A test that fails once is a bug to find, never a retry. If it fails here because the command or
  the daemon does not do what the spec says, stop and report: the fix is Task 18's or 19's file, not this task's.

- [ ] **Step 4: Commit** `harness hardware watch: end to end on the real daemon`.

---

### Task 23: Naming System: Harness Device and dial

**Effort:** medium. **Depends on:** nothing. **Red test:** none (docs only, no behavior).

**Files:**
- Modify: `docs/naming-system.md` (Product names: "Harness Device", the menu-bar app for the round dial; Work and
  interface terms: "dial", the round Harness device on a desk, as desktop copy already says "Your dial is unplugged")

Define both terms in the document's own format, beside the nearest existing entries (read the whole file first; it
writes the controller as "Harness device" today: keep that entry and say how the app name differs). One commit.

## For the pull request

- Platforms: macOS built and tested on this Mac; Linux compiled and unit-tested by `device-app-checks`; Windows not
  built. The CLI changes affect every platform.
- The `--if-down` guards apply to every supervisor that runs it: the Windows Task Scheduler task as well as this app.
- Rule 9's exception line; the design doc's section and the gallery, with screenshots of both themes.
- Each task's red and green commits (Task 22: its red on the branch's base); Verification's evidence; the local
  gate that was run, `npm run test:e2e` on the new spec (check 6), and that `scripts/local-checks.py` asks for none
  (finding 11).
- Left for later waves, no code here: self-update, signing and notarization, DMG, any release, Windows install and
  packaging, the app holding Automation and Accessibility permissions, a firmware update percent.

## Verification

**Where:** this Mac (macOS, arm64; the debug app is x86_64 under Rosetta), in the feature worktree at the final
head. Linux is the pull request's own CI (`device-app-checks`); no run is started by hand (decision 9). Nothing
touches production: no check signs in to a real account, downloads the real installer or reaches the Harness
backend.

**Isolation.** The repo's guide (`docs/development.md`, "Isolated end-to-end testing", and `cli/AGENTS.md` rule 6)
asks for a separate data folder, auth folder, computer id and port. This recipe gives those and a home, a tmux
server and a `PATH` of its own, so nothing reads or writes the person's `~/.harness`, `~/.claude`, daemon (18473),
tmux server, browser, apps or dial:

```bash
T="$(mktemp -d /tmp/hd.XXXXXX)"     # short on purpose: the daemon's socket path must stay under 96 bytes
mkdir -p "$T"/{home,bin,tmux,fake,cli,shots}
cat > "$T/env" <<EOF
export HOME="$T/home" CFFIXED_USER_HOME="$T/home" ZDOTDIR="$T/home"
export PATH="$T/bin:$T/home/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"   # no folder of the person's
export PORT=28473 HARNESS_CONNECTIONS_PORT=0
export ADAPTER_DATA_DIR="$T/home/.harness/cli/data" HARNESS_AUTH_DIR="$T/home/.harness/auth"
export ADAPTER_COMPUTER_ID_FILE="$T/home/.harness/computer-id"
export BACKEND_WS_URL=ws://127.0.0.1:9 WEB_URL=http://127.0.0.1:9
export ADAPTER_UPDATE_DISABLE=true ANALYTICS_ENABLED=false DISABLE_HOOK_INSTALL=true
export CABLE_DISABLE=true CABLE_FW_DISABLE=true      # the person's daemon owns the real dial's port
export TMUX_TMPDIR="$T/tmux" FAKE_HARNESS="$T/fake"
unset TMUX TMUX_PANE CLAUDE_CONFIG_DIR CODEX_HOME HARNESS_ENV_FILE HARNESS_FLASHER_CACHE HARNESS_DEVICE_CLI
EOF
# The only tools of this Mac the isolated shell may use, by link: node and tmux.
ln -s "$(command -v node)" "$T/bin/node"; ln -s "$(command -v tmux)" "$T/bin/tmux"
# First on PATH: `open` and `curl` only record, so nothing opens in the person's browser or apps and nothing is
# downloaded; no keychain, sudo or gh.
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s/open.log"\n' "$T" > "$T/bin/open"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s/curl.log"\necho "curl: (6) Could not resolve host: cdn.autonomous.ai" >&2\nexit 6\n' "$T" > "$T/bin/curl"
printf '#!/bin/sh\nexit 44\n' > "$T/bin/security"
printf '#!/bin/sh\nexit 1\n' > "$T/bin/sudo"; cp "$T/bin/sudo" "$T/bin/gh"
chmod +x "$T"/bin/*
lsof -nP -iTCP:28473 -sTCP:LISTEN            # expect nothing: the port is free
lsof -nP -iTCP:18473 -sTCP:LISTEN -t > "$T/person-daemon.pid"   # compared again at the end
```

Checks 2, 3 and 4 run in a shell that sourced `"$T/env"` (there `command -v harness` prints nothing until check 3
writes its launcher); builds, and checks 1, 5 and 6, run in an ordinary shell. The app is the unbundled debug binary,
`APP=device-app/src-tauri/target/debug/harness-device`, built once: `(cd device-app/ui && npm ci && npm run build)
&& (cd device-app/src-tauri && cargo build --locked)`. Login items belong to the macOS account and cannot be
isolated, so every run of checks 2 and 3 starts from a `state.json` whose `loginItem` is true: the app then never
asks macOS for one, and the tester registers none (decision 8). **A first-run state** below means
`{"version":1,"cliSeen":false,"askedSignIn":false,"askedClaude":false,"loginItem":true}` in
`$HOME/Library/Application Support/ai.autonomous.harness.device/state.json`. At the end: stop what was started,
`rm -rf "$T"`, and check that `lsof -nP -iTCP:18473 -sTCP:LISTEN -t` still prints the pid in `person-daemon.pid`.

The desktop app is left as it is (decision 7): the tester notes whether `Harness.app` runs, follows that case in
checks 2 and 3, and says which in the report. A step that reads "with the desktop app quit" is for a Mac where it
was not running; the tester never quits it, and no override stands in for it.

**Screenshots** go to `$T/shots` and into the pull request. The menu: click the dial icon (by hand, or
`osascript -e 'tell application "System Events" to tell process "harness-device" to click menu bar item 1 of menu
bar 2'`), then `screencapture -x`. This needs Screen Recording, and Accessibility for the scripted click, for the
terminal the tester runs in; without them the tester asks the main session and does not skip. The `menu:` lines of
`$HOME/Library/Logs/ai.autonomous.harness.device/app-*.log` are quoted beside each screenshot. Both themes: the
window is taken once as the Mac is set and once with the app started as `"$APP" -AppleInterfaceStyle Dark` (or
`-NSRequiresAquaSystemAppearance YES` on a dark Mac). If that argument changes nothing, the other theme's window
shots are reported as not taken and the gallery's frames stand for them; the Mac's own appearance is never changed.

| # | What to run | Where | What a person should see |
|---|---|---|---|
| 1 | The suites, at the final head: `cd cli && npm ci && npx vitest run src/lib/startIfDown.spec.ts src/devices/client.spec.ts src/localWsServer.spec.ts src/backendSocket.dialWatch.spec.ts src/backendSocket.toolWatch.spec.ts src/architecture.spec.ts && npm run typecheck`; `cd device-app/ui && npm ci && npx tsc --noEmit && npx vitest run && npm run build`; `cd device-app/src-tauri && cargo test --locked`; `cd scripts/tests && python3 -m unittest test_ci_plan`; `git diff --exit-code "$(git merge-base origin/main HEAD)" -- cli/src/architecture.coreFiles.txt` | this Mac, the full checkout | all pass, and the last prints nothing: the core's process loads no new file ([Layers](#layers)). `cargo test` here is the macOS proof (PR CI compiles Linux only); `test_ci_plan` on a full checkout runs `test_every_cross_read_in_this_repository_is_declared`, which PR CI's sparse checkout skips |
| 2 | The real app against the fake CLI: `HARNESS_DEVICE_CLI="$PWD/device-app/src-tauri/tests/fake-harness" "$APP"`, once per row of the table below | this Mac, isolated | each row's menu, word for word, and each screen; no `curl` line in any run but the install row; `$T/open.log` holds only what the rows say |
| 3 | The real app against a real CLI built from this branch (steps below) | this Mac, isolated, port 28473 | the menu follows a real daemon: `No dial`, then `Starting Harness` after a stop, and back; the guards hold; Quit leaves the daemon running |
| 4 | `harness hardware watch --json` against that daemon (steps below) | this Mac, isolated | `{"attached":false}`; exit 3 when the daemon stops; exit 0 when stdin closes |
| 5 | The gallery: `cd device-app/ui && npm run gallery && open gallery.html` | this Mac | 20 frames (10 states, light and dark), each 420 × 320, text readable, nothing clipped; the tray icon on a light and a dark bar. Screenshot the page |
| 6 | The end-to-end spec (Task 22), its local gate: `cd cli && npm ci && E2E_BUNDLE=1 npm run test:e2e -- e2e/hardwareWatch.e2e.ts` | this Mac; the spec's own isolation: a real daemon from this branch's bundle under a throwaway home, data folder, port and tmux server (`e2e/harness/daemon.ts`), no dial, the backend at `127.0.0.1:9` | 3 tests pass: `{"attached":false}` is printed, exit 3 when the daemon stops, exit 0 when stdin closes. Quote Vitest's summary; at the end `lsof -nP -iTCP:18473 -sTCP:LISTEN -t` still prints the person's daemon's pid |

**Check 2, row by row.** Each script is a file in `$T/fake` named by the arguments joined with `_`. Unless a row
says otherwise: `auth_status_--json` holds `{"loggedIn":true}`, `device_claude_status_--json` holds
`{"supported":true,"installed":true,"enabled":true}`, and `state.json` has every flag true. "Open Harness" is in
the menu because the desktop app is installed on this Mac; note it.

| State | Scripts | The menu, then what else |
|---|---|---|
| No dial | `hardware_watch_--json`: `{"attached":false}`, `@stdin` | `No dial` · `Signed in` · `Claude Code: On` · `Turn off` · — · `Open Harness` · `Quit` |
| Dial, update, problem | the watch: `{"attached":false}`, `@wait a`, `{"attached":true,"fw":"0.0.95"}`, `@wait b`, `{"attached":true,"fw":"0.0.95","updating":"0.0.96"}`, `@wait c`, `{"attached":false,"board":"pro","problem":"Not answering — unplug and replug"}`, `@stdin` | `touch $T/fake/a` → `Dial connected · 0.0.95`; `b` → `Updating to 0.0.96`; `c` → `Not answering — unplug and replug`. Each within a second, with no click |
| Starting, stopped | the watch: `@exit 3`; `start_--if-down`: an empty file | `Starting Harness`. While the desktop app runs here (it does today): the line stays, `calls.log` never gains `start --if-down`, the log says `keep-alive: the desktop app runs; not starting` once. With the desktop app not running (only on a Mac where it was not: decision 7): within 70 s `calls.log` has `start --if-down` and the line reads `Harness stopped` |
| Updating Harness | the watch: `@exit 4` | `Updating Harness`; `calls.log` gains one `hardware watch --json` a minute and no `start --if-down` |
| Signed out, sign-in | a first-run state; `auth_status_--json`: `{"loggedIn":false}`; `login_--json`: `@driver`, `{"type":"authorize_url","url":"https://example.invalid/authorize?state=abc"}`, `{"type":"waiting","message":"Harness is finishing an update"}`, `@wait signed`, `{"type":"result","status":"success","email":"person@example.invalid"}` | the window opens on **Sign in** (420 × 320, titled Harness Device); the menu has `Sign in…`. Click Sign in → `Finish in your browser`, the note, Cancel; `$T/open.log` holds the full URL. Put `{"loggedIn":true}` in the auth script, `touch $T/fake/signed` → the window closes, the menu has `Signed in`. The log has `sign-in: browser https://example.invalid/authorize` and neither `state=abc` nor `person@example.invalid` |
| Sign-in fails; Later | `login_--json`: `{"type":"result","status":"error","code":"BACKEND_ERROR","message":"fetch failed"}`, `@exit 1` | `fetch failed` and Retry. From the offer, Later → the window hides, `state.json` has `"askedSignIn":true`, and the next start opens no window |
| Claude Code | Claude status `enabled: false`, `askedClaude` false; `device_claude_enable`: `@wait on` | the window opens on **Claude Code** with both sentences; the menu has `Claude Code: Off` · `Turn on…`. Turn on → a spinner. Set the status script to `enabled: true`, `touch $T/fake/on` → the window closes; `Claude Code: On` · `Turn off`. Turn off → `calls.log` has `device claude disable` |
| Claude Code fails; Not now | `device_claude_enable`: `@err ✗ Could not write Claude Code's settings.`, `@exit 1` | that sentence and Retry. From the offer, Not now → hidden, `"askedClaude":true` |
| Harness removed | no `HARNESS_DEVICE_CLI`; `state.json` with every flag true | `Harness removed` · `Install` · — · `Open Harness` · `Quit`; no window; `$T/curl.log` does not exist |
| Install fails, then works | no `HARNESS_DEVICE_CLI`, a first-run state, the stub `curl` as it is (it fails as a Mac with no network does, and `/bin/sh` after it exits 0: finding 12) | the window opens on **Setting up Harness** with a spinner, then `curl: (6) Could not resolve host: cdn.autonomous.ai` and Retry; the menu line reads `Setting up Harness`. Replace the stub with one that logs its arguments and prints a script copying the fake to `$HOME/.local/bin/harness`; Retry → the spinner, then the next screen or a closed window; `state.json` has `"cliSeen":true`; every line of `curl.log` is `-fsSL https://cdn.autonomous.ai/harness/cli/install.sh` |
| Window and quit | any row | the red button hides the window and the app stays (`pgrep harness-device`); Quit ends it, and no `hardware watch` child of it is left; `state.json` is mode 600 |

**Check 3, the real CLI.**

```bash
# In an ordinary shell (npm needs the person's own PATH), with T set:
(cd cli && npm ci && BUNDLE_OUT_DIR="$T/cli" node build-bundle.mjs)
# In the isolated shell:
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\nexec "%s" "%s/cli/cli.js" "$@"\n' "$T/bin/node" "$T" > "$HOME/.local/bin/harness"
chmod +x "$HOME/.local/bin/harness"
"$APP" &
```

What to see, in order:
1. From a first-run state, the app finds the CLI by itself (the launcher, the second place it looks); `state.json`
   has `"cliSeen":true`.
2. The daemon. With the desktop app quit: within 70 s the log has `harness start --if-down: exit 0` and the menu
   reads `No dial`. While the desktop app runs (today's case): the log says the keep-alive is not starting; run
   `harness start` in the isolated shell, and the menu reads `No dial` within 5 s.
3. `Sign in…` in the menu, and the window on Sign in (a first run, signed out). Sign in → the CLI's own error
   sentence (the backend is `127.0.0.1:9`) and Retry. Later.
4. No Claude Code row: this branch's CLI has no `device claude` (wave 1a).
5. `harness stop` → `Starting Harness` within 5 s. With the desktop app quit, the daemon is back within 70 s.
6. The guards. `mkdir -p "$HOME/.harness/flasher" && date +%s > "$HOME/.harness/flasher/flashing"`, then
   `harness stop`, then by hand `harness start --if-down; echo "exit=$?"` → it prints `` harness start --if-down:
   `harness flash` holds the dial's port — nothing to do ``, `exit=0`, and `harness status` shows no daemon. With the
   desktop app quit, the app shows the same: within 70 s its log has `harness start --if-down: exit 0` and the menu
   reads `Harness stopped`; remove the file → `No dial` within 70 s. Then the same with `date +%s >
   "$HOME/.harness/uninstalling"` (`` `harness uninstall` is at work ``); remove it and `harness start`.
7. Quit from the menu → `harness status` still shows the daemon; `pgrep -f "hardware watch"` finds no child of the
   app. Start the app again, `kill -9` it → its watch child is gone within a second.
8. Clean up: `harness stop`; `tmux -S "$T/tmux/tmux-$(id -u)/default" kill-server`.

**Check 4, the watch command** (the isolated daemon running, no dial):

```bash
line() { until [ -s "$T/watch.out" ]; do sleep 0.2; done; cat "$T/watch.out"; }   # waits for the first line
mkfifo "$T/in"; harness hardware watch --json < "$T/in" > "$T/watch.out" & W=$!; exec 3> "$T/in"
line                                    # {"attached":false}
harness stop; wait $W; echo "exit=$?"   # exit=3: the daemon went away
harness hardware watch --json < "$T/in"; echo "exit=$?"   # exit=3 at once: no daemon
harness start; : > "$T/watch.out"
harness hardware watch --json < "$T/in" > "$T/watch.out" & W=$!
line                                    # {"attached":false}
exec 3>&-; wait $W; echo "exit=$?"      # exit=0: its stdin closed
harness hardware watch nonsense; echo "exit=$?"   # the usage, exit=1
```

**Checks the repository requires and PR CI does not run:** one, the CLI's end-to-end suite. PR CI never runs
`cli/e2e` (`docs/validation-and-release.md`, "What PR CI does not run"), and this branch adds a user-facing CLI flow
with its spec, so the tester runs that spec with its gate, `npm run test:e2e` (check 6), and the pull request records
it. The guide's row also asks one "CLI end to end" workflow run on the branch: decision 10 (orchestrator, 2026-11-13)
says the tester runs it once in phase 4, after the orchestrator grants the runner slot (one heavy workflow at a time
across children); its run link goes in the PR. Nothing else: `python3 scripts/local-checks.py --list` on this plan's paths,
the new spec's among them, prints `{}` (2026-11-13), and decision 6(b) adds no receipt for `cargo test` on a Mac;
the CLI changes touch no `src/core`, `src/services` or `src/harnessd` file, so `npm run test:core` and the other
coverage gates are not needed. PR CI runs every component by itself, because `scripts/` and `.github/` are shared
inputs. No temporary workflow: no check here is long, and none needs GitHub.

**Not checked end to end, and why:** the real installer from `cdn.autonomous.ai` (production; the app runs the same
two lines the desktop app runs today, and check 2 drives the screen with a stub `curl`); a real sign-in (a real
account); a real dial attached (the person's daemon owns its port; the status lines come from the fake CLI and the
daemon's unit tests); Claude Code against a real CLI (wave 1a is not on main); the login item (decision 8: it
cannot be isolated, so the tester registers none; its rule is unit-tested with a double); the keep-alive's own start
in the real app while `Harness.app` runs here (decision 7: the desktop app is not quit; its rule is unit-tested);
Windows (not built); the app on Linux beyond compiling and unit tests, which the pull request's own CI runs (not
packaged; decision 9).
