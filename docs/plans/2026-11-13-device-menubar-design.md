# Harness Device: a menu-bar app for the round dial (wave 1b)

Status: approved by the orchestrator (2026-11-13). Branch `feat/device-menubar`. Wave 1b of the device integration roadmap; wave 0
(`feat/device-without-the-app`) makes the daemon list this computer's agents on the dial with no desktop window, and
wave 1a (`device-claude-orca`) adds `harness device claude status|enable|disable`.

## Goal

A person buys the round dial, installs one small app, and the dial works with the agents they already run anywhere
(Orca, herdr, terminals, VS Code), without the Harness desktop app. The desktop app stays; this is the light way in
for device buyers.

Done when, on a Mac with no Harness installed:

1. The app installs the CLI, starts the daemon, and keeps it running (and stops keeping it while `harness flash` or
   `harness uninstall` works, or while the desktop app runs it).
2. Its menu-bar icon shows the dial's state as the daemon reports it, live, including "Updating to X".
3. It offers sign-in once (optional), and Claude Code voice and approvals once (consent first), and both can be
   changed later from the menu.
4. It starts at login as a login item.

## Decided (final)

Taken from the orchestrator's brief; not reopened here.

- **Technology:** Rust + Tauri v2, macOS first, built so Windows and Linux follow. Folder `device-app/`:
  `src-tauri/` (Rust: tray, runs the `harness` CLI, reads NDJSON) and `ui/` (plain TypeScript + esbuild, no UI
  framework, CSS following the desktop design doc). Bundle id `ai.autonomous.harness.device`. The PR adds one
  exception line to AGENTS.md rule 9: "Harness Device app (device-app/): Rust + Tauri, UI webview TypeScript".
  `rustup update stable` is allowed (rustc here is 1.68; Tauri 2 needs >= 1.77; CI uses `dtolnay/rust-toolchain@stable`).
- **Thin over the CLI.** The app owns no daemon logic: install script, `harness start --if-down`, `harness login
  --json`, `harness auth status --json`, `harness hardware watch --json`, `harness device claude …`. The CLI and
  daemon update themselves.
- **Out of this wave** (plan items only, no code): app self-update (tauri-plugin-updater), signing and notarization
  per desktop/RELEASE.md (team 54DJVWMJCC), DMG, any release; the app holding macOS Automation/Accessibility
  permissions for the helper (later wave, objc2).
- **Boundaries:** no change to `cli/src/cable`, `cli/hook`, `cli/src/core`, `plugins/`, `devices/`.

## Decided in this brainstorm (orchestrator: override any of these)

- **Sign-in is optional.** The daemon serves this computer's agents to the dial signed out (wave 0); sign-in adds
  the account's other computers. The window offers it once (Sign in / Later); the menu keeps "Sign in" while signed
  out.
- **The CLI installs on its own** at first run when it is missing, behind a visible progress screen with Retry, as
  the desktop app installs straight after its probe on macOS. No click to start it: the person installed this app to
  get exactly that.
- **One crate.** `device-app/src-tauri` is a single crate with a library (`lib.rs`, every rule, tested by `cargo
  test` against a fake CLI) and a thin binary (`main.rs`: tray, window, wiring). No second crate for the logic.
- **Login item through `SMAppService.mainApp`** (objc2-service-management) on macOS. Not tauri-plugin-autostart: its
  macOS launchers are a LaunchAgent plist (a launchd service, which the brief rules out) or AppleScript (an
  Automation prompt).
- **Desktop app detection on macOS through `NSWorkspace`** (objc2-app-kit): installed =
  `URLForApplicationWithBundleIdentifier("ai.autonomous.harness")`, running =
  `NSRunningApplication.runningApplicationsWithBundleIdentifier`. Elsewhere a process-name check behind the same
  trait (Linux `harness_desktop`/`harness-desktop`, Windows `harness-desktop.exe`; the implementer confirms the names
  from the desktop packaging).
- **The tray menu is native** (Tauri `tray` + `menu`); the webview window is only for the three screens that need
  words and a choice: Install, Sign in, Claude Code. It opens at first run when one of them is due, and from the menu.

## Architecture

```
Menu bar ─ Tauri tray (native menu) ─┐
Window   ─ webview ui/ (3 screens) ──┤ invoke / events
                                     ▼
                         src-tauri lib (Rust)
     cli.rs      find and run `harness`; NDJSON line reader; timeouts
     watch.rs    `harness hardware watch --json` child: DialStatus stream, exit codes
     keepalive.rs  the daemon rule (down twice, :10-:20 slot, desktop app, start --if-down)
     install.rs  install script runs (--host, then --desktop)
     account.rs  `auth status --json`, `login --json`
     claude.rs   `device claude status|enable|disable`
     state.rs    state.json in the app data folder (not ~/.harness)
     desktop.rs  desktop app installed / running (trait; macOS NSWorkspace)
     loginitem.rs SMAppService register (trait)
     model.rs    AppState → menu model (pure: what the menu shows)
                                     │ spawns
                                     ▼
                              harness CLI ──► harnessd
```

Every module that touches the outside sits behind a trait (`Cli`, `Clock`, `DesktopApp`, `LoginItem`, `StateFile`)
so `cargo test` drives the rules with fakes and a fake `harness` script. `model.rs` is pure: given the app's state it
returns the menu rows, so the menu's every state is a unit test.

### Finding the CLI

The same order as the desktop app (`desktop/lib/core/harness_cli_runner.dart`): `~/.harness/runtime/current-node` +
`~/.harness/cli/cli.js`, then `~/.local/bin/harness`, then `harness` on PATH. A Finder-launched app has launchd's bare
PATH, which is why the first two come first. `HARNESS_DEVICE_CLI` overrides it for tests only (the fake CLI); a
release build ignores it (`cfg(debug_assertions)` or a test-only constructor, the implementer's choice, but never
read in release).

Every CLI run has a deadline (status reads 10 s, enable/disable 60 s, install 10 min, `start --if-down` 90 s; login
below) and is killed on timeout; output lines are capped (64 KiB a line) and invalid JSON lines are skipped.

### Install

At start, no CLI found and the state file says no CLI was ever seen here → the window opens on **Install**: "Setting up Harness" with a spinner, then runs, one after
the other, `curl -fsSL https://cdn.autonomous.ai/harness/cli/install.sh | /bin/sh -s -- --host` and the same with
`--desktop` (the desktop app's `kHarnessHostSetupCommand` and `kHarnessDesktopInstallCommand`; no grid download). On
success: `harness start --if-down`, then the screen moves on. On failure: the last lines of the script's output, and
Retry. The output goes to the app's log, not the screen beyond those lines. Windows (`install.ps1 -Desktop`) is a
later wave; the install module returns "not supported here" on other platforms for now.

A CLI that was seen once and is gone now was removed on purpose (`harness uninstall`), so the app never reinstalls it
on its own: the dial line reads "Harness removed" and the menu offers **Install**, which opens the Install screen.
`cliSeen` is set the first time a CLI is found or installed. This is why the app's state and logs live outside
`~/.harness` (below): `harness uninstall` removes everything there but `desktop-app` (`removal.ts`).

### Dial status: `harness hardware watch --json` (CLI change)

New subcommand in `cli/src/devices/client.ts`, dispatched from `cli/src/cli.ts` `hardware`:

- Its own runner (`runDialWatch`), not `runDevicesCommand`, which turns every error into exit 1. Exit codes:
  **3** = the daemon cannot be reached, before or after `connected`: no running daemon (`runningDaemonStatus` is
  null), no socket, a connect error, any close (4403 included, as the machine id changes during `harness login`);
  **4** = the daemon is older than `dial-watch`; **0** = stdin closed (below); **1** = anything else. The app uses
  this command as its probe of the daemon.
- Opens the local socket and sends `machine_select { machineId, localProtocolVersion: 1, tool: true, watch: ["dial"] }`.
- On `connected`: if `features` lacks `dial-watch` (an older daemon) → `{"error":"…Run: harness start --restart"}` and **exits 4**. Before `connected`, a 10 s deadline ends the run with exit 3; every exit 3 writes one line to stderr saying what to do.
- On each `dial_status` frame: reduces it to `{ attached, fw, hw, board, updating, problem }` (the primary flat
  fields; absent fields omitted) and prints one NDJSON line **only when it differs from the last line printed**.
  The first frame (the daemon sends the last status right after `connected`) always prints.
- Exits 0 when its stdin closes: the app spawns it with a stdin pipe, so a killed app never leaves a watch holding
  a tool connection (the `ws` client would answer the daemon's pings for ever).
- Prints NDJSON whether or not `--json` is given (`--json` is accepted, as the other `hardware` commands accept it).
- `DEVICES_USAGE` gains the line `watch [--json]   one line each time this computer's dial changes`.

Daemon side, the smallest change that gives a tool `dial_status` without counting it as a window:

- `cli/src/localWsServer.ts`: `machine_select` reads `watch` for a tool connection only, keeps the known names
  (`"dial"`) and ignores the rest, and passes them to `registerLocalClient(…, { tool: true, watch })` (the
  `LocalWsBackend.registerLocalClient` opts type widens with it). `LOCAL_TOOL_FEATURES` gains `'dial-watch'`. The
  `dial_status` sent right after `connected` goes to a window or to a tool that asked for `dial`; today it goes to
  every tool too, which is how a tool would see dial state it never asked for.
- `cli/src/backendSocket.ts`: a `dialWatchers` set of tool connections that asked; `sendLocal` sends a `dial_status`
  frame to those as well; unregistering removes it. Tools stay out of `localWindows()`, so wave 0's machine list on
  the dial is not ended by the app being open. No other frame reaches a tool this way. The existing tool push
  (`toolWatches`, `core/toolWatches.ts`) is not extended because it lives in `cli/src/core/`, which this wave does
  not change; it follows agents, not the dial.
- Both files load in the core's process today and are not `cli/src/core/`; no line is added to
  `architecture.coreFiles.txt` (both are listed already; no new import). This is transport (who a frame is sent
  to), not a feature in the core. `main.ts` passes `backend` through unchanged.

Firmware update shows "Updating to X" with no percent (a percent is a later cable change).

### Keep-alive (the desktop rule)

`keepalive.rs`, a state machine driven by the watch child's exits and a 5-second tick:

- The watch child running = the daemon is up. Exit 3 = one "down" observation; the app looks again on the next tick
  by starting the watch again.
- **Two down observations in a row** → wait for the next spawn slot, seconds **:10 to :20** of a minute (the desktop's
  `inSpawnSlot`, which keeps clear of the CLI's update slot), then run `harness start --if-down`, then start the
  watch again. Any successful start of the watch resets the count.
- **Never** while the desktop app runs (`DesktopApp::running()`): the desktop app supervises its own daemon
  (`DaemonOwnerGuard`, `startSupervising`). The app still watches the dial. (A desktop app still on its setup or
  sign-in page supervises nothing yet; it starts its daemon itself as it gets there, so the gap ends on its own.)
- `harness start --if-down` itself refuses while `harness flash` holds the port or `harness uninstall` runs (below),
  so the app needs no copy of those rules.
- Exit 4 (daemon older than `dial-watch`) or exit 1 (a CLI older than `watch` answers it with its usage) → menu says
  "Updating Harness"; the watch is tried again every 60 s, and no start is attempted. The daemon updates the CLI
  itself. (An old CLI whose daemon is down stays there until the person runs `harness start`; the app installs the
  current CLI, so only a person who had Harness before can hit it.)
- Exit 0 happens only when the app closed the watch's stdin.
- A start that changes nothing (`harness start --if-down` exits 0 and the next watch still exits 3: a flash, an
  uninstall) → the dial line reads "Harness stopped" until the watch connects. The app does not tell flash from
  uninstall: the CLI owns those rules.
- A start that fails is logged with its exit code and output's last line; the next attempt waits for the next slot.
- `harness stop` on macOS is not remembered (`stoppedThisBoot` is Windows only), so the app starts the daemon again
  within a minute, as the desktop app's supervisor and launchd's KeepAlive do. Quitting the app is how a person stops
  that.
- A daemon the app starts has the app as its macOS "responsible process", so the app's Info.plist carries the desktop
  app's `NSLocalNetworkUsageDescription` and `NSBonjourServices` (copied from `desktop/macos/Runner/Info.plist`),
  or macOS refuses the daemon local-network access without asking. When the desktop app opens later, its
  `DaemonOwnerGuard` restarts that daemon once under itself; that one restart is accepted.

### `harness start --if-down` guards (CLI change)

`cli/src/lib/startIfDown.ts` gains two deps on `IfDownDeps`: `flashing(): boolean` and `uninstalling(): boolean`.
`startIfDown` checks them after the at-logon `forgetStop` and before the pid file, and returns
`{ start: false, why: '`harness flash` holds the dial\'s port' }` or `{ start: false, why: '`harness uninstall` is at work' }`.

- `flashing`: a fresh `flashing` file, or a fresh `flashing.<32 hex>` file, in the flasher folder
  (`HARNESS_FLASHER_CACHE` or `~/.harness/flasher`). `CACHE_DIR` moves out of `cli/src/lib/flash.ts` into a small
  module both import (`cli/src/lib/flasherDir.ts`), so `harness start` does not load the flasher. Fresh = holds a Unix
  time in seconds less than 10 minutes old and not in the future. Unreadable = not flashing (fail open, as
  `desktop/lib/core/serial_port_lease.dart`).
- `uninstalling`: the `uninstalling` marker (`removal.ts` `UNINSTALL_MARKER`) in `~/.harness`, fresh by the same rule
  (`desktop/lib/core/uninstall_marker.dart`).
- Both live in `IfDownIo` with defaults, so tests pass their own; one shared freshness helper reads both files.
- This applies to **every supervisor** that runs `--if-down`: the Windows Task Scheduler task as well as this app.
  The PR says so. Tests: red first for each guard; one test that the Task Scheduler path (`processIfDownDeps('win32')`
  with both guards false) decides exactly as before.

### Sign-in

- `harness auth status --json` → `{ loggedIn, offline?, … }` (no email) read at start, after every sign-in, and when
  the menu opens (at most once a minute).
- **Sign in** (screen or menu) runs `harness login --json`. Events: `authorize_url` → the app opens the URL in the
  default browser (only an `https:` URL) and shows "Finish in your browser" with Cancel; `waiting` → its message under
  that; `result` → success: the screen moves on and the menu shows "Signed in"; error: its message and Retry. Cancel
  kills the child, before `result` only. Other event types are ignored. `harness login` prints `result` and then
  restarts the daemon itself, so after `result` the app waits for the child to exit (60 s deadline) and never kills
  it; the watch's exit 3 and the keep-alive cover the restart. Deadline before `result`: 10 minutes, then the child is
  killed and the screen offers Retry.

### Claude Code voice and approvals

Commands from wave 1a (until it lands, tested against the fake CLI): `harness device claude status --json` →
`{ supported, installed, enabled, claudeVersion }`, `harness device claude enable`, `harness device claude disable`.

- Due when `supported && installed && !enabled` and the state file says it was not asked yet. The screen: what turning
  it on does in two short lines (the dial speaks Claude Code's answers and asks its approvals; Harness adds hooks to
  Claude Code's settings), buttons **Turn on** / **Not now**. Turn on runs `enable`; failure shows its message and
  Retry. Not now records the answer and keeps status-only.
- Menu: when supported and installed: "Claude Code: On" with **Turn off** (runs `disable`), or "Claude Code: Off"
  with **Turn on…** (opens the screen). Nothing when not supported or not installed. Status is read at start, after
  enable/disable, and when the menu opens (at most once a minute).

### Menu

Native tray menu, rebuilt from `model.rs` on every state change. One template icon (Lucide `circle-dot`, standing in for the dial until a dial glyph exists), always shown, also
while the desktop app runs (it has its own `HarnessStatusMenu`).

| Row | Shown |
|---|---|
| Dial line (disabled) | "Dial connected" (· fw), "No dial", "Updating to X", the `problem` text, "Starting Harness", "Harness stopped", "Updating Harness", "Setting up Harness", "Harness removed" |
| **Install** | when "Harness removed", or when an install failed and its window was closed (the dial line then stays "Setting up Harness") |
| Account | "Signed in" (disabled), or **Sign in…** |
| Claude Code | as above; absent when not supported or installed |
| separator | |
| **Open Harness** | when the desktop app is installed (`open -b ai.autonomous.harness`) |
| **Quit** | quits the app; the daemon keeps running |

Copy is short, buttons 1-2 words. An empty state shows nothing extra.

### Window and UI

`device-app/ui/`: plain TypeScript bundled by esbuild into `ui/dist/`, one HTML page, three screens (Install, Sign
in, Claude Code), each a function that renders into the page from the state the Rust side sends. All calls go
through one `api.ts` over Tauri `invoke` and `listen`, so tests mock it. CSS uses the desktop design doc's tokens
(system font, its neutrals and blue selection, light and dark). `ui/gallery.html` shows every screen in every state,
both themes; the design doc gets a short "Harness Device" section that points to it, in the same PR.

Window: 420 × 320, not resizable, centered, closes to the menu bar (closing never quits). No Dock icon: the app lives
in the menu bar only; the bundle reuses the desktop app's icon. Closing the window on the Sign in offer counts as
Later, on the Claude Code offer as Not now (recorded, not offered again); an install or sign-in under way keeps running. Opens at start when the CLI
is missing, sign-in was not asked, or Claude Code is due; screens chain in that order; when none is due it closes.

### State file

In the platform's app data folder (Tauri `app_data_dir`: `~/Library/Application Support/ai.autonomous.harness.device/`
on macOS), not `~/.harness`, so `harness uninstall` leaves it and the app writes nothing into a folder being removed.
`state.json`, mode 0600, written atomically (temp file + rename):
`{ "version": 1, "cliSeen": bool, "askedSignIn": bool, "askedClaude": bool, "loginItem": bool }`. Unknown or unreadable → defaults
(all false) and a log line. No email, token or path in it.

### Login item

At first start, `LoginItem::register()` (SMAppService.mainApp on macOS); success sets `loginItem`. A failure is logged
and tried again at the next start; the app works without it. Never unregistered by the app (the person turns it off in
System Settings ▸ Login Items, which the app respects: once registered, it does not register again).

### Security

- The webview loads only the bundled `ui/dist`; CSP `default-src 'self'`; no remote content, no shell or fs plugin
  exposed to it. Tauri capabilities allow only the app's own commands.
- The app runs only the `harness` CLI found as above and the install script line above; every argument is fixed,
  nothing from the webview becomes a command line.
- Only an `https:` authorize URL is opened. Logs carry no email, token or URL query (the authorize URL is logged
  without its query).

### Failures are seen

Every external step has a deadline and a log line naming it and its exit code. The app's log is
`app-YYYYMMDD.log` in the platform's app log folder (Tauri `app_log_dir`: `~/Library/Logs/ai.autonomous.harness.device/`),
pruned after 14 days, CLI output redacted of tokens before it is
written. The menu's dial line always says the state someone can act on.

### Measures

No new product measures in this wave: the daemon already counts dial attaches; the app sends nothing to any service
itself. The app's log records the keep-alive's starts and their results.

## Testing

- **CLI (vitest):** `startIfDown.spec.ts` red-then-green for both guards and the unchanged Task Scheduler path;
  `devices/client.spec.ts` for `watch` (exit 3 with no daemon, exit 4 without the feature, one line per change, exit
  3 on close, before `connected` and on 4403, exit 0 on stdin EOF); `localWsServer`/`backendSocket` specs that a
  tool with `watch: ["dial"]` gets `dial_status` (on connect and on each change) and is not counted as a window, and a
  tool without it gets no `dial_status`, while a window (the desktop app, and `harness tui`, which selects without
  `tool: true`) still gets it on connect and on each change.
- **Rust (`cargo test`):** every module with fakes; `cli.rs` and `watch.rs` against a fake `harness` script
  (`tests/fake-harness`) that prints scripted NDJSON and exits with given codes; keep-alive's rules (twice in a row,
  slot, desktop running, exit 4, backoff) with a fake clock; `model.rs` every menu state; `state.rs` round trip,
  corrupt file, 0600.
- **UI (vitest + jsdom):** each screen clicked through as a person does, with `invoke` mocked: install progress →
  failure → Retry; sign-in → browser → result; Claude Turn on / Not now.
- **Tester, on this Mac:** build the real app (`cargo tauri build --debug` or `cargo tauri dev`), run it against an
  isolated HOME with the fake CLI and, separately, against a real local CLI with a throwaway data dir, never the
  person's own daemon (port 18473) or `~/.harness`; screenshots of the menu in each state and of each screen in both
  themes.
- **CI:** `device-app` becomes a component: `scripts/ci-plan.py` `EXTRA` and `COMPONENTS` (`JOBS` then names
  `device-app-checks`), plus `PR_READS`/`SOURCE_INPUTS` entries for any file outside `device-app/` it reads; in
  `.github/workflows/ci.yml` a plan output, a `workflow_dispatch` option, a Linux job modelled on `pty-checks`
  (install the Tauri Linux packages: webkit2gtk 4.1, appindicator, rsvg; `cargo test`; `npm ci && npx vitest run`
  in `ui/`) and its entry in `required.needs`; and the ci-plan tests that pin the component list. No macOS job.

## Platforms

macOS: built and tested on this Mac. Linux: compiled and unit-tested on CI; not packaged. Windows: not built in this
wave; the code keeps platform calls behind the traits above so it follows. The CLI changes affect every platform; the
`--if-down` guards are tested for the Windows Task Scheduler path.

## Plan items for later waves (no code here)

App self-update (tauri-plugin-updater); signing and notarization per desktop/RELEASE.md (team 54DJVWMJCC); DMG;
release; Windows install (`install.ps1 -Desktop`) and packaging; the app holding macOS Automation/Accessibility
permissions for the helper; a firmware update percent.
