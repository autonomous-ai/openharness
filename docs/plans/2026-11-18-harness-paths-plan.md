# One path module for Harness's home folder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(<area>): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. A caller task's red commit deletes its own not-moved list, so the guard fails on exactly its hits. A pin (`test(<area>): pin …`) lands green before the red commit. A task with no red test is one commit. No task pushes or merges, and no guard lands red: every task ends green.

**Goal:** Every path under the account's `~/.harness` is built by one module per language, from a table of named entries tagged data or state, and a guard test per language fails on a hand-built one. No path changes.

**Architecture:**
- **One module per language** holds the table and resolves `<home>/.harness/<entry>`: `cli/src/config/harnessHome.ts` (TypeScript), `desktop/lib/core/harness_home.dart` (Dart), and one `harness_home.rs` in each of `tui`, `pty` and `device-app/src-tauri` (Rust). Both roots resolve to today's `~/.harness`.
- **Callers keep their home, their override and their separator.** Each replaces the hand-joined `.harness` with a call, passing the home it reads today. Whole-tree callers (uninstall, the connectors' read fence, `homeDataFolder.ts`) take the list of roots, today one.
- **A guard per language** scans the sources for the shapes the code uses today and allows a short list: standalone scripts, legacy detectors, user-facing copy and the literals kept for PR 2. The CLI and Desktop guards land green, with today's hits on a "not moved yet" list, one file per caller task; each caller task deletes its file and moves its callers, and a last task per guard removes the list's code.

**Tech Stack:** TypeScript (Node, vitest) in `cli/`; Dart and Flutter test in `desktop/`; Rust (`cargo test`, std only, no new crate) in `tui/`, `pty/`, `device-app/src-tauri/`.

**Spec:** `docs/plans/2026-11-18-harness-paths-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md` (Protect the core), `cli/src/harnessd/AGENTS.md`, `desktop/CLAUDE.md`, `device-app/AGENTS.md` and `docs/validation-and-release.md`.

**Open questions:** none. The draft's four, and three more decisions, were answered by the orchestrator on 2026-11-18 (under "Decided here").

## Base

- `chore/harness-paths` at `e6737565c2` (`main` after #4437). The spec and this plan are untracked. The main session commits them; no task does.
- Line numbers below are the base's. A task follows the expression it names when a line has moved, and says so in its report.
- Nothing is installed in this worktree: no `cli/node_modules`, no `desktop/.dart_tool`, no `device-app/ui/node_modules`, no Rust `target`.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 CLI: the module | `cli/src/config/harnessHome.ts`, `harnessHome.spec.ts` (new) | none | xhigh | `harnessHome.spec.ts` |
| 2 CLI: pin today's default paths | `cli/src/config/harnessHome.defaults.spec.ts` (new) | none | high | none: it pins today's output, one commit |
| 3 CLI: the guard | `cli/src/config/harnessHome.guard.spec.ts` (new); `cli/src/config/harnessHome.notMoved/env.txt`, `core.txt`, `launch.txt`, `outside.txt`, `fence.txt`, `uninstall.txt` (new) | none | high | none: it lands green with today's 25 hits listed as not moved; its run without the lists, red, is the report's evidence |
| 4 CLI: `env.ts` takes its defaults from the module | `cli/src/config/env.ts`, `cli/src/architecture.coreFiles.txt`, `cli/src/config/harnessHome.notMoved/env.txt` (deleted) | 1, 2, 3 | xhigh | the CLI guard, once `env.txt` is deleted |
| 5 CLI: callers in the core's process | `cli/src/lib/authSession.ts`, `lib/localSocket.ts`, `lib/claudeHomes.ts`, `lib/claudeHomes.spec.ts` (new), `engines/kit/downloadMarker.ts`, `config/harnessHome.notMoved/core.txt` (deleted) | 4 | xhigh | the CLI guard, once `core.txt` is deleted |
| 6 CLI: the launch prelude | `cli/src/lib/engineLaunch.ts`, `config/harnessHome.notMoved/launch.txt` (deleted) | 4 | xhigh | the CLI guard, once `launch.txt` is deleted |
| 7 CLI: callers outside the core | `cli/src/lib/connectors/store.ts`, `lib/flasherDir.ts`, `lib/shellContextReply.ts`, `lib/callerPane.ts`, `lib/startIfDown.ts`, `lib/engineAccount.ts`, `tui/paths.ts`, `tui/index.ts`, `tui/index.spec.ts`, `testing/installerTmuxProbe.ts`, `config/harnessHome.notMoved/outside.txt` (deleted) | 1, 2, 3 | high | the CLI guard, once `outside.txt` is deleted |
| 8 CLI: the read fence and the home-following check | `cli/src/lib/connectors/call.ts`, `lib/connectors/call.spec.ts` (new), `lib/homeDataFolder.ts`, `config/startHome.ts`, `config/harnessHome.notMoved/fence.txt` (deleted) | 1, 2, 3 | xhigh | the CLI guard, once `fence.txt` is deleted |
| 9 CLI: uninstall works on every root | `cli/src/lib/uninstall/deps.ts`, `command.ts`, `removal.ts`, `command.spec.ts`, `removal.spec.ts`, `config/harnessHome.notMoved/uninstall.txt` (deleted) | 1, 3 | xhigh | `command.spec.ts`, and the CLI guard once `uninstall.txt` is deleted |
| 10 Desktop: the module | `desktop/lib/core/harness_home.dart`, `desktop/test/harness_home_test.dart` (new) | none | high | `harness_home_test.dart` |
| 11 Desktop: the guard | `desktop/test/harness_home_guard_test.dart` (new); `desktop/test/harness_home_not_moved/store.txt`, `runner.txt`, `provisioner.txt`, `joins.txt` (new) | none | high | none: it lands green with today's 13 hits listed as not moved; its run without the lists, red, is the report's evidence |
| 12 Desktop: the store and what names entries through it | `desktop/lib/core/harness_file_store_native.dart`, `harness_file_store_web.dart`, `serial_port_lease.dart`, `uninstall_marker.dart`, `lib/logging/log_file.dart`, `lib/ws/local_cli_discovery.dart`; `test/harness_file_store_test.dart`, `serial_port_lease_test.dart`, `uninstall_marker_test.dart`, `local_cli_discovery_test.dart`, `test/harness_home_not_moved/store.txt` (deleted) | 10, 11 | high | the Desktop guard, once `store.txt` is deleted |
| 13 Desktop: the CLI runner, the Windows layout, the community folder | `desktop/lib/core/harness_cli_runner.dart`, `windows_layout.dart`, `lib/community/fork_project.dart`; `test/harness_cli_runner_test.dart`, `harness_cli_runner_windows_test.dart`, `community_fork_test.dart`, `test/harness_home_not_moved/runner.txt` (deleted) | 10, 11 | high | the Desktop guard, once `runner.txt` is deleted |
| 14 Desktop: the provisioner | `desktop/lib/bootstrap/environment_provisioner.dart`, `test/environment_provisioner_test.dart`, `test/harness_home_not_moved/provisioner.txt` (deleted) | 10, 11 | high | the Desktop guard, once `provisioner.txt` is deleted |
| 15 Desktop: the remaining joins | `desktop/lib/bootstrap/agent_prefetch.dart`, `windows_git_setup.dart`, `lib/ws/daemon_pipe_record.dart`, `local_daemon_transport.dart`, `lib/state/app_state.dart`; `test/agent_prefetch_test.dart`, `windows_git_setup_test.dart`, `test/harness_home_not_moved/joins.txt` (deleted) | 10, 11 | high | the Desktop guard, once `joins.txt` is deleted |
| 16 hn: the helper, the guard, three callers | `tui/src/harness_home.rs` (new), `main.rs`, `shell_picker.rs`, `shell_context.rs`, `app.rs` | none | high | `harness_home.rs`'s tests |
| 17 PTY host: the helper, the guard, the launcher, the Desktop uninstaller | `pty/src/harness_home.rs` (new), `lib.rs`, `launcher.rs`, `desktop/uninstall.rs` | none | xhigh | `harness_home.rs`'s tests |
| 18 Harness Device: the helper, the guard, the CLI lookup | `device-app/src-tauri/src/harness_home.rs` (new), `lib.rs`, `cli.rs` | none | high | `harness_home.rs`'s tests |
| 19 The temporary workflow | `.github/workflows/tmp-harness-paths.yml` (new) | 1, 2 | medium | none: a temporary workflow, one commit |
| 20 Remove the temporary workflow | `.github/workflows/tmp-harness-paths.yml` (deleted) | 1 to 19, 21, 22, and Verification 1 with its evidence recorded | medium | none: one commit |
| 21 CLI: the guard keeps no not-moved list | `cli/src/config/harnessHome.guard.spec.ts` | 4, 5, 6, 7, 8, 9 | medium | none: test code only, the guard stays green, one commit |
| 22 Desktop: the guard keeps no not-moved list | `desktop/test/harness_home_guard_test.dart` | 12, 13, 14, 15 | medium | none: test code only, the guard stays green, one commit |

Longest chain: four tasks (1, 2 or 3 → 4 → 5 or 6 → 21), then Task 20.

- Tasks 1, 2, 3, 10, 11, 16, 17 and 18 share no file and start at once.
- Files shared by two tasks are shared only along a dependency: Task 3 creates the six CLI list files and Tasks 4 to 9 each delete their own; Task 21 edits Task 3's guard spec after Tasks 4 to 9. Tasks 11, 12 to 15 and 22 do the same for Desktop. The caller tasks of one guard share no file, so they run at once.
- Task 4 alone edits `architecture.coreFiles.txt`: Tasks 5 and 6 wait for it because their files load in the core's process.
- Task 19 waits for Tasks 1 and 2: its Windows job runs their specs. Task 20 is started by the main session, not by the end of Task 19.

## Layers

| Files | Process | Gate |
|---|---|---|
| `config/harnessHome.ts`, `config/env.ts`, `lib/authSession.ts`, `lib/localSocket.ts`, `lib/claudeHomes.ts`, `engines/kit/downloadMarker.ts`, `lib/engineLaunch.ts` | **The core's process**, and every other CLI process | `src/architecture.spec.ts` (one new line in `architecture.coreFiles.txt`), their specs, the goldens; locally `cli-shell` and `npm run test:core` |
| The other CLI callers (Tasks 7, 8, 9) | CLI commands and services; never the core, never the master | Their specs; `src/lib/uninstall` again on Windows (the Windows workflow) |
| `cli/src/harnessd/platform.ts` | **The master** | Not edited: its fallback stays literal, on the CLI guard's allowlist |
| `desktop/lib/**` | The desktop app | `desktop-tests` in PR CI; `make desktop-test` on a Mac; the Windows desktop workflow |
| `tui/src/**`, `pty/src/**`, `device-app/src-tauri/src/**` | `hn`, the PTY host and launchers, the menu-bar app | `cargo test` in PR CI (Linux); the Windows workflow; `cargo test` for the Device app on a Mac |

## Before starting

- CLI: `cd cli && npm ci` once.
- Desktop: Flutter 3.47 or later (`flutter --version`), `flutter config --enable-swift-package-manager` once, then `cd desktop && flutter pub get`.
- Device app: `cd device-app/ui && npm ci && npm run build` before any `cargo test` there (the binary embeds `ui/dist`). Rust stable 1.95 or later.
- Rust: one `CARGO_TARGET_DIR` outside the repository for the three crates saves the Tauri compile.
- Every command below runs from the folder it names. A shell keeps nothing between an agent's commands.

## Global Constraints

- **No path changes.** Every path, hook command, installed hook script, launch prelude and golden file is byte for byte today's on macOS, Linux and Windows. `cli/hook/notify.mjs`, `tui/src/shell_integration.sh` and everything under `cli/src/engines/__fixtures__/` and `cli/src/lib/__fixtures__/` are not edited: `git diff --stat "$(git merge-base HEAD origin/main)" -- cli/hook cli/src/engines/__fixtures__ cli/src/lib/__fixtures__ tui/src/shell_integration.sh` prints nothing.
- **Overrides stay where they are read.** `ADAPTER_DATA_DIR`, `HARNESS_AUTH_DIR`, `HARNESS_CONNECTIONS_DIR`, `HARNESS_HOOK_ROUTES_DIR`, `HARNESS_FLASHER_CACHE`, `HARNESS_LOGS_DIR`, `HARNESS_PTY_DIR`, `HARNESS_DEVICES_DIR`, `HARNESS_AGENT_MESSAGES_DIR`, `DSH_DIR`, `ADAPTER_CLI_DIR`, `ADAPTER_RUNTIME_DIR`, `ADAPTER_COMPUTER_ID_FILE`: only the default behind each comes from the module.
- **Callers keep their home.** `homedir()`, a `home` parameter, `env.HOME || homedir()`, `accountHome()`, `process.env.HOME`, Dart's `homeDir()` and `maybeHomeDir()`, Rust's `HOME` and `USERPROFILE` then `HOME`: each caller passes what it reads today.
- **The pinning rule.** A row marked `existing` names the test that already pins the path. A row marked `add first` gets that test written against today's code, run green and committed before the edit (`test(<area>): pin <what>`). A row marked `none` says why no test can see it; nobody adds a seam for it. A pin that fails on the untouched tree means this plan misread today's value: today's value is the truth, the expectation is corrected, and the report says so.
- **The module in the core.** `cli/src/config/harnessHome.ts` imports only `node:os` and `node:path`, holds no feature logic, and is one new line of `cli/src/architecture.coreFiles.txt` (Task 4). No architecture rule is loosened: a caller that a rule forbids from importing the module is reported, not forced.
- **The master is not edited.** `cli/src/harnessd/` imports only Node and its own folder (`src/architecture.spec.ts`).
- **Out of scope**, not edited: `cli/scripts/`, `cli/e2e/`, `companions/`, `os/`, `store/`, `installer/`, `scripts/`, `mobile/`, `backend/`; a project's or workspace's `.harness/`; `.harness-<name>` file names; XDG; a migration; a release.
- **No quoted path of another component.** `scripts/ci-plan.py` reads a quoted path that starts with another top-level folder (`"cli/data"` in `tui/`, `'tui/…'` in `desktop/`) as a dependency on it. Join such segments one at a time; guards name files relative to their own scan root.
- **No new dependency**, no lockfile change. The Rust guards use `std` only.
- **Comments say why.** A comment that says where `~/.harness` is stays true: it names today's path.
- **Platforms the pull request names:** macOS, Linux, Windows, paths unchanged on all three.

## The table

Each module copies this table. Labels are only labels here: both roots are `<home>/.harness`.

| Root | Entries |
|---|---|
| data | `auth`, `computer-id`, `cli`, `connections`, `agent-messages`, `bin`, `dsh`, `claude-profiles`, `desktop-app-v2`, `viewer-app-v2`, `tui`, `devices`, `lessons`, `grid-fleet`, `community` |
| state | `logs`, `runtime`, `hook-routes`, `s`, `run`, `shell-requests`, `pty`, `uninstalling`, `flasher` |

24 entries. `viewer-app-v2` (the viewer build's store) and `community` (forked community projects, `desktop/lib/community/fork_project.dart`) are the inventory's additions, both by the spec's rule: something the person made is data.

## Review Focus

1. **A home that is not normalized** (`HOME=/tmp/x/`, a trailing separator). Node's `join` normalizes and a text join does not; each helper must give what its caller gave before. Tasks 1 and 10 (`joins as its caller joined`).
2. **An override is set.** The override still wins and the default is not used. Task 2 (`an override still wins`).
3. **No home at all** (a launch from Explorer or launchd with `HOME` unset). Rust's `unwrap_or_default()` still gives the relative `.harness/…`; the PTY host's `home()` still gives none; Dart's store still throws `StateError` and the marker's path is still null. Tasks 16 and 17 (`an empty home`), Task 12 (`with no home`).
4. **A `~/.harness` that is a link.** The connectors' read fence and the home-following check compare real locations, per root. Task 8 (`a linked root`), and `homeDataFolder.spec.ts`'s own case.
5. **The hook script and the goldens.** One changed byte in `notify.mjs` changes Codex's `trusted_hash`. The guard allowlists the script and the first Global Constraint's `git diff --stat` proves it untouched: the final reviewer runs it.

## Decided here, where the spec was silent

- **Names.** TypeScript: `harnessRoot`, `harnessRoots`, `harnessPath`, `harnessPathText`, `HARNESS_HOME_NAME`, `HARNESS_ENTRIES`. Dart: `HarnessHome`, `HarnessEntry`, `HarnessRootKind`, `separatorJoin`. Rust: `harness_root`, `harness_roots`, `harness_path`, `Entry`, `Root`.
- **`harnessPathText(entry, home = '$HOME')`** is the spec's `shellHarnessPath` with the home as a parameter: the launch prelude passes none, and `startHome.ts`'s message passes `process.env.HOME`, so both keep their bytes for any home.
- **A third parameter `platform`** on the TypeScript functions picks `node:path`'s `win32` or `posix`, defaulting to `process.platform`: on each real platform that is `node:path`'s own `join`, and a Linux runner can test the Windows form.
- **Dart takes a join function.** `HarnessHome.of(home, join:)` and `HarnessHome.at(root, join:)` take the two-argument join a caller uses today (`p.join`, `p.windows.join`, `p.posix.join`, the store's own `_join`, or `separatorJoin('/')` for string joins). `at` serves the callers that hold a `Directory harnessHome` handed to them (tests hand a temporary one).
- **Desktop joins onto `harnessHome.path` move too**, through `HarnessHome.at`: the spec lists `windows_layout.dart`, which has no other kind.
- **Uninstall with more than one root** repeats each step and each line per root. With one root the output is today's. What two roots should say is PR 2's copy.
- **The Rust guards land inside each crate's one task**, red only between that task's two commits.

- **Not moved, and why:**
  - `cli/src/harnessd/platform.ts:507`: the master may not import the module.
  - `tui/src/daemon.rs:50`: through the helper its Windows text would change from `…\.harness/cli/data` to `…\.harness\cli\data`.
  - The CLI joins onto a derived or handed-in root (below).
  - `desktop/lib/bootstrap/environment_provisioner.dart:1213` (`harnessHome.parent`, the profile on Windows): the folder that holds the root, not a path under it.
  - User-facing copy: the allowlists below.

Answered by the orchestrator on the draft's open questions (2026-11-18):

- **No guard lands red.** The CLI and Desktop guards land green: beside the reasoned allowlist, each holds a "not moved yet" list of today's hits, one `.txt` file per caller task (`cli/src/config/harnessHome.notMoved/`, `desktop/test/harness_home_not_moved/`). An entry is one hit as the guard prints it, `<file>:<line>: <matched text>`, and excuses only a hit equal to it, so a new hit in a listed file still fails. A case checks that every entry still matches a hit. Each caller task deletes its own file in its red commit (the guard then fails on exactly its hits) and moves its callers in its code commit. Task 21 (CLI) and Task 22 (Desktop), after every caller task of their guard, delete the code that reads the lists. One file per caller task keeps the caller tasks parallel. `.txt`, because `scripts/ci-plan.py` reads no `.txt`, so an entry such as `tui/paths.ts:4` is not read as a dependency on `tui/`. The spec's "red on today's tree before the callers move" is each guard's run without its lists (Tasks 3, 11), in the report.
- **The master's fallback** (`cli/src/harnessd/platform.ts:507`) keeps its literal, is on the CLI guard's allowlist and on "For PR 2". The master is not edited.
- **`tui/src/daemon.rs:50`** (`".harness/cli/data"` joined in one piece) keeps its literal byte for byte, is on the tui guard's allowlist and on "For PR 2". Task 16 does not move it.
- **Each Rust crate's table declares only the entries it uses**: `hn` `tui` and `shell-requests`, the Device app `cli` and `runtime`, the PTY host the roots alone.
- **CLI joins onto `dirname(ADAPTER_CLI_DIR)` or a `rootDir`** (`lib/windows/*`, `lib/platformDaemon.ts:122,218`, `masterProcess.ts:248`, `services/updaterProcess.ts:76-79`, `lib/launchers.ts:142`) are not moved and are on "For PR 2". They follow an override and, but for `launchers.ts`, read the Windows install layout; none is a guard hit.
- **`viewer-app-v2` and `community` (data)** are in the table.
- **The hand-started checks run in a row:** the tester runs checks 3, 4 and 5 one after another without asking the orchestrator before each (Verification, "Turns").

---

### Task 1: CLI: the module

**Layer:** every CLI process, the core's from Task 4. **Depends on:** none. **Effort:** `xhigh`.

**Red test:** `cli/src/config/harnessHome.spec.ts`.

**Files:**
- Create: `cli/src/config/harnessHome.ts`
- Test: `cli/src/config/harnessHome.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export const HARNESS_HOME_NAME = '.harness'
  export type HarnessRootKind = 'data' | 'state'
  /** Every top-level entry under the home folder, and its root: "The table" above, 24 keys. */
  export const HARNESS_ENTRIES = { auth: 'data', /* … */ flasher: 'state' } as const satisfies Record<string, HarnessRootKind>
  export type HarnessEntry = keyof typeof HARNESS_ENTRIES
  export function harnessRoot(kind: HarnessRootKind, home?: string, platform?: NodeJS.Platform): string
  /** The distinct roots, the data root first: today one. */
  export function harnessRoots(home?: string, platform?: NodeJS.Platform): string[]
  export function harnessPath(entry: HarnessEntry, home?: string, platform?: NodeJS.Platform): string
  /** `<home>/.harness/<entry>` as text, the home as written, nothing normalized. */
  export function harnessPathText(entry: HarnessEntry, home?: string): string
  ```
  Defaults: `home = homedir()`, `platform = process.platform`, and `'$HOME'` for `harnessPathText`.

- [ ] **Step 1: Write the failing test**, in `describe('Harness\'s home folder')`:
  - `the table is the spec's`: `HARNESS_ENTRIES` equals the 24 keys and labels of "The table", written out in the test.
  - `every entry is <home>/.harness/<entry>, on posix and on Windows`: for each key `e`, `harnessPath(e, '/home/me', 'linux')` is `'/home/me/.harness/' + e` and `harnessPath(e, 'C:\\Users\\me', 'win32')` is `'C:\\Users\\me\\.harness\\' + e`.
  - `both roots are the home's .harness, and the roots are one`: `harnessRoot('data', '/h', 'linux')` and `harnessRoot('state', '/h', 'linux')` are `'/h/.harness'`; `harnessRoots('/h', 'linux')` equals `['/h/.harness']`; `harnessRoots('C:\\h', 'win32')` equals `['C:\\h\\.harness']`.
  - `joins as its caller joined` (Review Focus 1): `harnessPath('cli', '/tmp/x/', 'linux')` is `'/tmp/x/.harness/cli'`; `harnessPathText('cli', '/tmp/x/')` is `'/tmp/x//.harness/cli'`; `harnessPathText('run')` is `'$HOME/.harness/run'`.
  - `defaults to this account's home and this platform`: `harnessPath('logs')` is `join(homedir(), '.harness', 'logs')` with `node:path`'s `join`.
  - `loads nothing but node:os and node:path`: every `from '…'` in the module's own source is `node:os` or `node:path`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/config/harnessHome.spec.ts`. Expected: FAIL (the module does not exist).
- [ ] **Step 3: Implement.** The root comes from one record keyed by kind, whose two values are the same function today: that record is what PR 2 changes. The join is `(platform === 'win32' ? win32 : posix).join`.
- [ ] **Step 4: Run** the step 2 command and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `CLI: one module names Harness's home folder and its entries`.

### Task 2: CLI: pin today's default paths

**Depends on:** none. **Effort:** `high`.

**Red test:** none. It pins what today's code resolves, and passes before and after every move: one commit. Show it bites by changing one expected value locally, seeing it fail, and putting it back.

**Files:**
- Create: `cli/src/config/harnessHome.defaults.spec.ts`

Each case runs a child process as `src/config/env.spec.ts` does (`tsx --eval`, a throwaway home, 60 s), with an environment built from nothing: `PATH`, `HOME` and `USERPROFILE` set to the throwaway home, and on Windows `SystemRoot`, `TEMP` and `TMP` passed through.

- [ ] **Step 1: Write the spec**, in `describe('the default folders, as today')`:
  - `with nothing set, every default is under <home>/.harness`: the child prints these as JSON and the test compares them with `root = join(home, '.harness')`:

    | Read | Expected |
    |---|---|
    | `env.ADAPTER_CLI_DIR` | `join(root, 'cli')` |
    | `env.ADAPTER_DATA_DIR` | `join(root, 'cli', 'data')` |
    | `env.AMP_SESSIONS_DIR` | `join(root, 'cli', 'data', 'amp-sessions')` |
    | `env.ADAPTER_RUNTIME_DIR` | `join(root, 'runtime')` |
    | `env.ADAPTER_COMPUTER_ID_FILE` | `join(root, 'computer-id')` |
    | `env.HARNESS_LOGS_DIR`, `HARNESS_PTY_DIR`, `HARNESS_DEVICES_DIR`, `HARNESS_HOOK_ROUTES_DIR`, `HARNESS_AGENT_MESSAGES_DIR`, `DSH_DIR` | `join(root, 'logs')`, `'pty'`, `'devices'`, `'hook-routes'`, `'agent-messages'`, `'dsh'` |
    | `AUTH_DIR` (`lib/authSession.ts`) | `join(root, 'auth')` |
    | `FLASHER_DIR` (`lib/flasherDir.ts`) | `join(root, 'flasher')` |
    | `connectorsDir()` (`lib/connectors/store.ts`) | `join(root, 'connections')` |
    | `installedTuiPath()` (`tui/paths.ts`) | `join(root, 'bin', 'harness-tui')` |
    | `shortSocketFolder('/x')` (`lib/localSocket.ts`) | `join(root, 's', <first 16 hex of sha256('/x')>)` |
  - `an override still wins` (Review Focus 2): with `ADAPTER_CLI_DIR`, `ADAPTER_DATA_DIR`, `ADAPTER_RUNTIME_DIR`, `ADAPTER_COMPUTER_ID_FILE`, `HARNESS_LOGS_DIR`, `HARNESS_PTY_DIR`, `HARNESS_DEVICES_DIR`, `HARNESS_HOOK_ROUTES_DIR`, `HARNESS_AGENT_MESSAGES_DIR`, `DSH_DIR`, `HARNESS_AUTH_DIR`, `HARNESS_FLASHER_CACHE` and `HARNESS_CONNECTIONS_DIR` each set to a folder of its own under a second throwaway folder, each value read is that folder.
  - `a HOME that is not the account's is told its data folder` (not on Windows; skipped where `userInfo()` has no entry): the child sets `process.argv[2] = 'status'` and imports `config/startHome.ts` alone, with `HOME` a throwaway folder and `ADAPTER_DATA_DIR = join(userInfo().homedir, '.harness', 'cli', 'data')`. Its stderr is exactly
    `` harness: HOME is <HOME>, not this account's home, so ignoring ADAPTER_DATA_DIR=<that folder>; using <HOME>/.harness/cli/data. Set ADAPTER_DATA_DIR to a folder outside ~/.harness to choose one. ``
    and a newline. The account's folder is named as a string only: `startHome.ts` compares paths and opens nothing.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/config/harnessHome.defaults.spec.ts`. Expected: PASS on the untouched tree.
- [ ] **Step 3: Commit** `test(cli): pin every default folder under the home, and the overrides`.

### Task 3: CLI: the guard

**Depends on:** none. **Effort:** `high`.

**Red test:** none committed: the guard lands green, with today's hits on the not-moved lists. Step 2 runs it before the lists exist and sees it fail on every hit: that output is the guard's red run on today's tree, in the report. This task moves no caller and adds no allowlist entry beyond the table below.

**Files:**
- Create: `cli/src/config/harnessHome.guard.spec.ts`
- Create: `cli/src/config/harnessHome.notMoved/env.txt`, `core.txt`, `launch.txt`, `outside.txt`, `fence.txt`, `uninstall.txt`

**What it scans:** every `.ts`, `.mjs`, `.js`, `.cjs` and `.sh` file under `cli/src` and `cli/hook`, but `*.spec.ts`, `*.test.ts`, `__fixtures__/`, `generated/` and `config/harnessHome.ts` itself. Paths are compared with forward slashes, relative to `cli/src`, or `hook/…` for the hook.

**Comments are dropped first:** a block comment runs from a line whose first text is `/*` to the first line holding `*/`; a line comment starts at `//` at the start of a line or after whitespace (`#` in a `.sh` file).

**A hit** is one match, with its file, line and matched text:

```ts
/** A `.harness` path segment that starts a string literal: '.harness', ".harness/runtime". */
const SEGMENT = /(['"`])\.harness(?:[\\/][^'"`\n]*)?\1/g
/** A home, on the literal's line or one of the two lines above it: SEGMENT is a hit only with one. */
const HOME = /homedir\(\)|accountHome\(\)|\bhome\b|\bHOME\b|\bUSERPROFILE\b|\baccount\b/
/** `.harness` straight after home text in one literal: $HOME/.harness, ~/.harness, %USERPROFILE%\.harness, ${x}/.harness. */
const INLINE = /(?:\$HOME|~|%USERPROFILE%|\$env:USERPROFILE|\})[\\/]+\.harness(?![\w-])/g
/** A regular expression that matches a home path: \/\.harness, [\\/]\.harness. */
const PATTERN = /(?:\\\/|\[\\\\\/\])\\\.harness(?![\w-])/g
```

**The allowlist**, each entry a file, a test of the matched text, and its reason:

| File | Matched text | Why |
|---|---|---|
| `hook/notify.mjs` | any | Runs as an installed copy with no import from `src`; its bytes feed Codex's trusted hash |
| `engines/kit/notifyHooks.ts` | `PATTERN` | `LEGACY_SCRIPT`: what old installs wrote |
| `lib/localSocket.ts` | `PATTERN` | `prepareShortFolder` checks the shape of a folder it is handed |
| `harnessd/platform.ts` | `SEGMENT` | The master imports only Node and its own folder; its fallback is listed for PR 2 |
| `cli.ts`, `lib/uninstall/command.ts`, `config/startHome.ts`, `config/testIsolation.ts` | starts with `~` | Help and message text a person reads |

**The not-moved lists**, `cli/src/config/harnessHome.notMoved/*.txt`: today's hits that a caller task moves, one file per caller task. Each line is one hit exactly as the guard prints it, `<file>:<line>: <matched text>`. A hit is excused only by a line equal to its printed form, so a new hit in a listed file, or a listed literal that moved to another line, still fails. A missing folder or file is an empty list. The files are `.txt`: `scripts/ci-plan.py` reads no `.txt`, so `tui/…` in a line is not read as a dependency on `tui/`.

| File | Its caller task | Hits |
|---|---|---|
| `env.txt` | 4 | `config/env.ts:13` |
| `core.txt` | 5 | `lib/authSession.ts:76`, `lib/localSocket.ts:59`, `lib/claudeHomes.ts:45,112,150`, `engines/kit/downloadMarker.ts:37` |
| `launch.txt` | 6 | `lib/engineLaunch.ts:1339,1356,1358,1359` |
| `outside.txt` | 7 | `lib/connectors/store.ts:66`, `lib/flasherDir.ts:10`, `lib/shellContextReply.ts:15`, `lib/callerPane.ts:47,146`, `lib/startIfDown.ts:152`, `lib/engineAccount.ts:140`, `tui/paths.ts:4`, `tui/index.ts:124`, `testing/installerTmuxProbe.ts:9` |
| `fence.txt` | 8 | `lib/connectors/call.ts:49`, `lib/homeDataFolder.ts:40`, `config/startHome.ts:17` |
| `uninstall.txt` | 9 | `lib/uninstall/deps.ts:36` |

The code that reads the lists is a few lines of its own, under a comment that names Task 21, which deletes it.

- [ ] **Step 1: Write the spec**, in `describe('no hand-built home .harness path outside config/harnessHome.ts')`:
  - `finds each shape in a planted line`: one hit each for `join(homedir(), '.harness', 'cli')`, `join(home, '.harness/runtime')`, a `'.harness'` literal two lines under a line that names `process.env.HOME`, `"$HOME/.harness/run"`, `` `${home}/.harness/logs` ``, `'%USERPROFILE%\\.harness'`, `/\/\.harness\/cli/` and `/[\\/]\.harness[\\/]s/`.
  - `ignores comments, a project's folder and .harness-<name> files`: no hit for `// join(home, '.harness')`, a `/* … */` block holding one, `join(workspace, '.harness', 'runtime')`, `'.harness/handoff'`, `'.harness-team-privacy'`, `` `${file}.harness-${process.pid}.tmp` `` and `owner.harness`.
  - `a not-moved line excuses only its own hit`: with a planted source of two hits in one file and a list holding the first one's printed form, the second is still a hit; the same line with another line number excuses nothing.
  - `cli/src and cli/hook hold none but the allowlisted and the not moved yet`: the hits left after the allowlist and the lists equal `[]`. The failure prints one `file:line: text` per hit.
  - `every allowlist entry still matches a hit`: none is stale.
  - `every not-moved line still matches a hit`: none is stale; the failure names the list file and the line.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/config/harnessHome.guard.spec.ts`, before the lists exist. Expected: every case PASSES but `… hold none but the allowlisted and the not moved yet`, which FAILS with 25 hits in 19 files: `config/env.ts:13`, `config/startHome.ts:17`, `engines/kit/downloadMarker.ts:37`, `lib/authSession.ts:76`, `lib/callerPane.ts:47,146`, `lib/claudeHomes.ts:45,112,150`, `lib/connectors/call.ts:49`, `lib/connectors/store.ts:66`, `lib/engineAccount.ts:140`, `lib/engineLaunch.ts:1339,1356,1358,1359`, `lib/flasherDir.ts:10`, `lib/homeDataFolder.ts:40`, `lib/localSocket.ts:59`, `lib/shellContextReply.ts:15`, `lib/startIfDown.ts:152`, `lib/uninstall/deps.ts:36`, `testing/installerTmuxProbe.ts:9`, `tui/index.ts:124`, `tui/paths.ts:4`. Keep this output for the report: it is the guard's red run on today's tree. A file in the output that this list lacks is a caller the inventory missed: stop and report it.
- [ ] **Step 3: Write the six lists** from that output, each printed line into the file the table above names.
- [ ] **Step 4: Run** the step 2 command. Expected: PASS, every case.
- [ ] **Step 5: Commit** `test(cli): no hand-built home .harness path outside the module, today's callers listed as not moved yet`, with step 2's failing output in the report.

### Task 4: CLI: `env.ts` takes its defaults from the module

**Layer:** the core's process. **Depends on:** 1, 2, 3. **Effort:** `xhigh`.

**Red test:** the CLI guard, once `harnessHome.notMoved/env.txt` is deleted. The paths do not change: Task 2 pins them.

**Files:**
- Modify: `cli/src/config/env.ts` (lines 11-27 and the six defaults at 229-247)
- Modify: `cli/src/architecture.coreFiles.txt` (one line, `config/harnessHome.ts`, after `config/envFields.ts`)
- Delete: `cli/src/config/harnessHome.notMoved/env.txt`

**Interfaces:**
- Consumes: `harnessPath(entry)` from Task 1.

| Today | Becomes |
|---|---|
| `adapterRootDir = join(homedir(), '.harness')` | gone |
| `adapterCliDir = join(adapterRootDir, 'cli')` | `harnessPath('cli')` |
| `adapterDataDir = join(adapterCliDir, 'data')` | unchanged |
| `adapterRuntimeDir`, `computerIdFile` | `harnessPath('runtime')`, `harnessPath('computer-id')` |
| `join(adapterRootDir, 'logs' \| 'pty' \| 'devices' \| 'hook-routes' \| 'agent-messages' \| 'dsh')` | `harnessPath('logs')` and the same five names |

The `~/.machine` adoption and every `homedir()` that names another product's folder are not edited.

- [ ] **Step 1: Run** `cd cli && npx vitest run src/config/harnessHome.defaults.spec.ts`. Expected: PASS, before any edit.
- [ ] **Step 2: Delete** `src/config/harnessHome.notMoved/env.txt` and run `npx vitest run src/config/harnessHome.guard.spec.ts`. Expected: FAIL with exactly one hit, `config/env.ts:13`. Commit `test(cli): env.ts's hand-built home is no longer excused (red)`.
- [ ] **Step 3: Edit** `env.ts` and add the line to `architecture.coreFiles.txt`.
- [ ] **Step 4: Run** `npx vitest run src/config/harnessHome.guard.spec.ts src/config/harnessHome.defaults.spec.ts src/config/env.spec.ts src/config/envIsolation.spec.ts src/architecture.spec.ts src/architecture.environment.spec.ts src/architecture.startEnvironment.spec.ts` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `CLI: env.ts takes its default folders from the home module`. The report carries the sentence the pull request needs: `config/harnessHome.ts` joins the core's files because `config/env.ts`, which every session's core loads, takes its default folders from it; it is a table and four pure functions over `node:os` and `node:path`.

### Task 5: CLI: callers in the core's process

**Layer:** the core's process. **Depends on:** 4. **Effort:** `xhigh`.

**Red test:** the CLI guard, once `harnessHome.notMoved/core.txt` is deleted. The paths do not change.

**Files:**
- Modify: `cli/src/lib/authSession.ts`, `cli/src/lib/localSocket.ts`, `cli/src/lib/claudeHomes.ts`, `cli/src/engines/kit/downloadMarker.ts`
- Test: `cli/src/lib/claudeHomes.spec.ts` (new)
- Delete: `cli/src/config/harnessHome.notMoved/core.txt`

| Where | Today | Becomes | Pin |
|---|---|---|---|
| `lib/authSession.ts:76` | `join(homedir(), '.harness', 'auth')` | `harnessPath('auth')` | existing: Task 2 |
| `lib/localSocket.ts:59` | `join(home, '.harness', 's', <hash>)` | `join(harnessPath('s', home), <hash>)` | existing: Task 2, and `localSocket.spec.ts` (`/h/.harness/s/…`) |
| `engines/kit/downloadMarker.ts:37` | `join(home, '.harness', 'run', <name>)` | `join(harnessPath('run', home), <name>)` | existing: `downloadMarker.spec.ts` |
| `lib/claudeHomes.ts:45,112,150` | `join(<home>, '.harness', 'claude-profiles')` | `harnessPath('claude-profiles', <home>)`, each with the home it has | add first: `claudeHomes.spec.ts` |

`lib/localSocket.ts:124` (the `prepareShortFolder` regular expression) is not edited.

- [ ] **Step 1: Pin `claudeHomes.ts`** in a new `claudeHomes.spec.ts`, with a throwaway `home`:
  - `a folder under <home>/.harness/claude-profiles is Harness's own`: `claudeHomeListed(join(home, '.harness', 'claude-profiles', '1'), 'm', { home, environment: {} })` is true, and false for `join(home, '.harness', 'claude-profilesx', '1')`.
  - `it is listed, and labelled Claude <name>`: with `settings.json` in `join(home, '.harness', 'claude-profiles', '2')`, `listClaudeProfiles([], { home, environment: {}, machineId: 'm' })` holds a profile with that path and the label `Claude 2`.
  Run `cd cli && npx vitest run src/lib/claudeHomes.spec.ts`: PASS on today's code. Commit `test(cli): pin Claude's profile folder under the home`.
- [ ] **Step 2: Delete** `src/config/harnessHome.notMoved/core.txt` and run `npx vitest run src/config/harnessHome.guard.spec.ts`. Expected: FAIL with exactly the six hits of `core.txt`: `lib/authSession.ts:76`, `lib/localSocket.ts:59`, `lib/claudeHomes.ts:45,112,150`, `engines/kit/downloadMarker.ts:37`. Commit `test(cli): the core's process's hand-built homes are no longer excused (red)`.
- [ ] **Step 3: Edit** the four files.
- [ ] **Step 4: Run** `npx vitest run src/config/harnessHome.guard.spec.ts src/lib/claudeHomes.spec.ts src/lib/localSocket.spec.ts src/engines/kit/downloadMarker.spec.ts src/lib/authSession.spec.ts src/config/harnessHome.defaults.spec.ts src/config/envIsolation.spec.ts src/architecture.spec.ts` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `CLI: the sign-in, short socket, download marker and Claude profile folders come from the home module`.

### Task 6: CLI: the launch prelude

**Layer:** the core's process. **Depends on:** 4. **Effort:** `xhigh`.

**Red test:** the CLI guard, once `harnessHome.notMoved/launch.txt` is deleted. The bytes do not change: `src/engines/__fixtures__/launch-shapes.golden.json`, `dsh-launch-shapes.golden.json` and `launch-argv.golden.json` already hold all four lines (the log line 32, 36 and 16 times).

**Files:**
- Modify: `cli/src/lib/engineLaunch.ts` (lines 1339, 1356, 1358, 1359)
- Delete: `cli/src/config/harnessHome.notMoved/launch.txt`

**Interfaces:**
- Consumes: `harnessPathText('run')` is `$HOME/.harness/run`; `harnessPathText('logs')` is `$HOME/.harness/logs`.

Each of the four shell lines takes its `$HOME/.harness/run` or `$HOME/.harness/logs` from `harnessPathText`, inside the same double quotes, with every other character as it is.

- [ ] **Step 1: Run** `cd cli && npx vitest run src/engines/launchShapes.golden.spec.ts src/engines/dshLaunchShapes.golden.spec.ts src/engines/launchArgv.golden.spec.ts`. Expected: PASS, before any edit.
- [ ] **Step 2: Delete** `src/config/harnessHome.notMoved/launch.txt` and run `npx vitest run src/config/harnessHome.guard.spec.ts`. Expected: FAIL with exactly `lib/engineLaunch.ts:1339,1356,1358,1359`. Commit `test(cli): the launch prelude's hand-built home is no longer excused (red)`.
- [ ] **Step 3: Edit** the four lines.
- [ ] **Step 4: Run** the step 1 command with `src/config/harnessHome.guard.spec.ts src/lib/engineLaunch.spec.ts src/lib/engineLaunch.windows.spec.ts src/lib/engineInstall.user.spec.ts src/architecture.spec.ts`, and `npm run typecheck`. Expected: PASS, and `git status --short src/engines/__fixtures__` prints nothing.
- [ ] **Step 5: Commit** `CLI: the launch prelude's run and log folders come from the home module`.

### Task 7: CLI: callers outside the core

**Depends on:** 1, 2, 3. **Effort:** `high`.

**Red test:** the CLI guard, once `harnessHome.notMoved/outside.txt` is deleted. The paths do not change.

**Files:**
- Modify: `cli/src/lib/connectors/store.ts`, `lib/flasherDir.ts`, `lib/shellContextReply.ts`, `lib/callerPane.ts`, `lib/startIfDown.ts`, `lib/engineAccount.ts`, `tui/paths.ts`, `tui/index.ts`, `testing/installerTmuxProbe.ts`
- Test: `cli/src/tui/index.spec.ts`
- Delete: `cli/src/config/harnessHome.notMoved/outside.txt`

| Where | Today | Becomes | Pin |
|---|---|---|---|
| `lib/connectors/store.ts:66` | `join(env.HOME \|\| homedir(), '.harness', 'connections')` | `harnessPath('connections', env.HOME \|\| homedir())` | existing: Task 2 |
| `lib/flasherDir.ts:10` | `join(homedir(), '.harness', 'flasher')` | `harnessPath('flasher')` | existing: Task 2, `startIfDown.spec.ts:174` |
| `lib/shellContextReply.ts:15` | `join(home, '.harness', 'shell-requests')` | `harnessPath('shell-requests', home)` | existing: `shellContextReply.spec.ts` |
| `lib/callerPane.ts:47,146` | `join(accountHome(), '.harness', 'runtime')` | `harnessPath('runtime', accountHome())` | none: the default names the real account's folder, which no test reads; Task 1 pins the join |
| `lib/startIfDown.ts:152` | `join(homedir(), '.harness', UNINSTALL_MARKER)` | `harnessPath('uninstalling')` | existing: `startIfDown.spec.ts:180` |
| `lib/engineAccount.ts:140` | `join(home, '.harness', 'cli', 'data')` | `join(harnessPath('cli', home), 'data')` | existing: `engineAccount.spec.ts:104` |
| `tui/paths.ts:4` | `join(homedir(), '.harness', 'bin', 'harness-tui')` | `join(harnessPath('bin'), 'harness-tui')` | existing: Task 2 |
| `tui/index.ts:124` | `resolve(homedir(), '.harness', 'cli', 'data')` | `resolve(harnessPath('cli'), 'data')` | add first: `tui/index.spec.ts` |
| `testing/installerTmuxProbe.ts:9` | `join(process.env.HOME!, '.harness/runtime')` | `harnessPath('runtime', process.env.HOME!)` | existing: `src/scripts/install.spec.ts`, which runs the probe |

- [ ] **Step 1: Pin `tui/index.ts`**: a case `with no ADAPTER_DATA_DIR the data folder is <home>/.harness/cli/data` beside the one at `tui/index.spec.ts:104`, with the variable unset, expecting `localDaemonStatus` called with `join(homedir(), '.harness', 'cli', 'data')`. Run `cd cli && npx vitest run src/tui/index.spec.ts`: PASS on today's code. Commit `test(cli): pin hn's default data folder`.
- [ ] **Step 2: Delete** `src/config/harnessHome.notMoved/outside.txt` and run `npx vitest run src/config/harnessHome.guard.spec.ts`. Expected: FAIL with exactly the ten hits of `outside.txt` (Task 3's table). Commit `test(cli): the hand-built homes outside the core are no longer excused (red)`.
- [ ] **Step 3: Edit** the nine files.
- [ ] **Step 4: Run** `npx vitest run src/config/harnessHome.guard.spec.ts src/config/harnessHome.defaults.spec.ts src/lib/startIfDown.spec.ts src/lib/shellContextReply.spec.ts src/lib/callerPane.spec.ts src/lib/engineAccount.spec.ts src/tui src/scripts/install.spec.ts src/lib/connectors` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `CLI: connectors, flasher, shell requests, hn and the caller's pane take their folders from the home module`.

### Task 8: CLI: the read fence and the home-following check

**Depends on:** 1, 2, 3. **Effort:** `xhigh`.

**Red test:** the CLI guard, once `harnessHome.notMoved/fence.txt` is deleted. The behaviour does not change.

**Files:**
- Modify: `cli/src/lib/connectors/call.ts`, `cli/src/lib/homeDataFolder.ts`, `cli/src/config/startHome.ts`
- Test: `cli/src/lib/connectors/call.spec.ts` (new)
- Delete: `cli/src/config/harnessHome.notMoved/fence.txt`

**Interfaces:**
- Consumes: `harnessRoots(home)`, `harnessPathText(entry, home)`.

| Where | Today | Becomes | Pin |
|---|---|---|---|
| `lib/connectors/call.ts:49` | `join(home, '.harness')` in `uploadPath`'s forbidden list | `...harnessRoots(home)` in the same place | add first: `call.spec.ts` |
| `lib/homeDataFolder.ts:40` | inside `join(account, '.harness')` | inside any of `harnessRoots(account)`, the same test per root | existing: `homeDataFolder.spec.ts` |
| `config/startHome.ts:17` | `` `${process.env.HOME}/.harness/cli/data` `` in the message | `` `${harnessPathText('cli', process.env.HOME)}/data` `` | existing: Task 2 |

The rest of the message, `outside ~/.harness` included, is not edited.

- [ ] **Step 1: Pin the fence** in a new `call.spec.ts`, with a throwaway home passed as `{ HOME: home }`:
  - `refuses a file under the home's .harness`: `uploadPath(join(home, '.harness', 'logs', 'shot.png'), env)` throws `not a media file the helper may send`, for a file that exists. A `.png`, so that the fence refuses it and not the suffix rule.
  - `a linked root` (Review Focus 4): with `<home>/.harness` a symlink to a folder elsewhere, a file reached through the link is refused, and so is the same file by its real path.
  - `takes a picture beside it`: a `.png` in `<home>/pictures` is returned by its real path.
  Run `cd cli && npx vitest run src/lib/connectors/call.spec.ts`: PASS on today's code. Commit `test(cli): pin the connectors' upload fence around the home folder`.
- [ ] **Step 2: Delete** `src/config/harnessHome.notMoved/fence.txt` and run `npx vitest run src/config/harnessHome.guard.spec.ts`. Expected: FAIL with exactly `lib/connectors/call.ts:49`, `lib/homeDataFolder.ts:40`, `config/startHome.ts:17`. Commit `test(cli): the fence's and the home check's hand-built homes are no longer excused (red)`.
- [ ] **Step 3: Edit** the three files.
- [ ] **Step 4: Run** `npx vitest run src/config/harnessHome.guard.spec.ts src/lib/connectors src/lib/homeDataFolder.spec.ts src/config/harnessHome.defaults.spec.ts` and `npm run typecheck`. Expected: PASS; `config/startHome.ts`'s `~/.harness` copy is still excused by the allowlist.
- [ ] **Step 5: Commit** `CLI: the upload fence and the home-following check cover every Harness root`.

### Task 9: CLI: uninstall works on every root

**Depends on:** 1, 3. **Effort:** `xhigh`.

**Red test:** `cli/src/lib/uninstall/command.spec.ts`, and the CLI guard once `harnessHome.notMoved/uninstall.txt` is deleted.

**Files:**
- Modify: `cli/src/lib/uninstall/deps.ts`, `cli/src/lib/uninstall/command.ts`, `cli/src/lib/uninstall/removal.ts`
- Test: `cli/src/lib/uninstall/command.spec.ts`, `cli/src/lib/uninstall/removal.spec.ts`
- Delete: `cli/src/config/harnessHome.notMoved/uninstall.txt`

**Interfaces:**
- Consumes: `harnessRoots(home)`, `harnessRoot('state', home)`, `harnessPath('uninstalling' | 'bin', home)`, `HARNESS_HOME_NAME`.
- Produces: `UninstallDeps.roots: readonly string[]` in place of `root: string`: Harness's roots under this home, the data root first, today one.
- `command.ts`: every use of `deps.root` becomes a pass over `deps.roots`, in order:
  - the Windows refusal when the terminal is in a folder the uninstall removes: any root;
  - the check before anything is touched (`checkRemovable(planFor(…))`): each root, all before the first stop;
  - `whatItDoes`' delete line: one per root; its Windows PATH line names `bin` under the first root;
  - `removeFiles`: each root; the files are done only when every root's are;
  - `refusal()`: each root is written as `~`;
  - the "left …: it is outside …" note: a folder outside every root, naming the first.
- `deps.ts`: `roots` is `harnessRoots(home)`; the marker is `harnessPath('uninstalling', home)`; `ownedBinEntries`' third argument is `harnessRoot('state', home)`, the root that holds `runtime`; the Windows PATH entry is `harnessPath('bin', home)`.
- `removal.ts`: `ROOT_NAME` is `HARNESS_HOME_NAME`. Nothing else in it changes.

- [ ] **Step 1: Write the failing test** in `command.spec.ts`: change the fake deps' `root: '…'` to `roots: ['…']` (the expected lines do not change), and add `with two roots, every step runs for each`: with `roots: ['/Users/u/.harness', '/Users/u/state/.harness']`, `--yes`, both listed with entries: `checkRemovable` saw a plan for each root before `stopDaemon` ran, `removeNow` got one plan per root in order, the output holds one `✓ removed` line per root, and a `RemovalRefused` from the second root's check removes nothing from the first. In `removal.spec.ts`: `ROOT_NAME` equals `HARNESS_HOME_NAME`. Delete `src/config/harnessHome.notMoved/uninstall.txt`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/uninstall/command.spec.ts src/lib/uninstall/removal.spec.ts src/config/harnessHome.guard.spec.ts`. Expected: FAIL (`roots` is not a dependency yet; the guard with exactly `lib/uninstall/deps.ts:36`). Commit `test(cli): harness uninstall works on every Harness root (red)`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/lib/uninstall src/lib/startIfDown.spec.ts src/config/harnessHome.guard.spec.ts` and `npm run typecheck`. Expected: PASS, with no expected line of an existing case edited.
- [ ] **Step 5: Commit** `CLI: harness uninstall works on every Harness root`.

### Task 10: Desktop: the module

**Depends on:** none. **Effort:** `high`.

**Red test:** `desktop/test/harness_home_test.dart`.

**Files:**
- Create: `desktop/lib/core/harness_home.dart` (imports only `package:path/path.dart`, so the web build loads it)
- Test: `desktop/test/harness_home_test.dart`

**Interfaces:**
- Produces:
  ```dart
  const harnessHomeName = '.harness';
  enum HarnessRootKind { data, state }
  /// "The table" above: 24 values, e.g. computerId('computer-id', HarnessRootKind.data).
  enum HarnessEntry { /* … */; const HarnessEntry(this.segment, this.root); final String segment; final HarnessRootKind root; }
  typedef HarnessJoin = String Function(String left, String right);
  /// `left` + separator + `right`, nothing normalized: the string joins.
  HarnessJoin separatorJoin(String separator);
  final class HarnessHome {
    /// `<home>/.harness`, joined as the caller joins.
    HarnessHome.of(String home, {HarnessJoin join = p.join});
    /// Both roots at [root]: a folder a caller already holds.
    const HarnessHome.at(String root, {HarnessJoin join = p.join});
    String root(HarnessRootKind kind);
    String path(HarnessEntry entry);
  }
  ```
  Value names: `auth`, `computerId`, `cli`, `connections`, `agentMessages`, `bin`, `dsh`, `claudeProfiles`, `desktopApp`, `viewerApp`, `tui`, `devices`, `lessons`, `gridFleet`, `community`, `logs`, `runtime`, `hookRoutes`, `s`, `run`, `shellRequests`, `pty`, `uninstalling`, `flasher`.

- [ ] **Step 1: Write the failing test**, in `group('HarnessHome')`:
  - `the table is the spec's`: `{for (final e in HarnessEntry.values) e.segment: e.root}` equals the 24 segments and labels, written out in the test.
  - `every entry is <home>/.harness/<segment>, on posix and on Windows`: for each value, `HarnessHome.of('/Users/me', join: p.posix.join).path(e)` is `'/Users/me/.harness/${e.segment}'` and `HarnessHome.of(r'C:\Users\me', join: p.windows.join).path(e)` is `C:\Users\me\.harness\<segment>`.
  - `both roots are one folder`: `root(HarnessRootKind.data)` and `root(HarnessRootKind.state)` are `'/Users/me/.harness'`.
  - `at() takes a folder a caller already holds`: `HarnessHome.at('/t/h', join: separatorJoin('/')).path(HarnessEntry.runtime)` is `'/t/h/runtime'`.
  - `joins as its caller joined` (Review Focus 1): `HarnessHome.of('/Users/me/', join: separatorJoin('/')).path(HarnessEntry.cli)` is `'/Users/me//.harness/cli'`, and `'/Users/me/.harness/cli'` with `p.posix.join`.
- [ ] **Step 2: Run** `cd desktop && flutter test --no-pub test/harness_home_test.dart`. Expected: FAIL (the library does not exist).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command and `flutter analyze lib/core/harness_home.dart test/harness_home_test.dart`. Expected: PASS, no issue.
- [ ] **Step 5: Commit** `Desktop: one module names Harness's home folder and its entries`.

### Task 11: Desktop: the guard

**Depends on:** none. **Effort:** `high`.

**Red test:** none committed: the guard lands green, with today's hits on the not-moved lists. Step 2 runs it before the lists exist and sees it fail on every hit: that output is the guard's red run on today's tree, in the report. This task moves no caller.

**Files:**
- Create: `desktop/test/harness_home_guard_test.dart`
- Create: `desktop/test/harness_home_not_moved/store.txt`, `runner.txt`, `provisioner.txt`, `joins.txt`

**What it scans:** every `.dart` file under `desktop/lib` but `core/harness_home.dart`, read as `test/home_dir_test.dart` reads them, with comments dropped as in Task 3 (`//` and `///`).

**A hit:**

```dart
/// A `.harness` path segment that starts a string literal.
final segment = RegExp(r'''(['"])\.harness(?:[\\/][^'"\n]*)?\1''');
/// A home, on the literal's line or one of the two lines above it: [segment] is a hit only with one.
final home = RegExp(r'homeDir\(|maybeHomeDir\(|userHome\(|\b_?home\b|\bHOME\b|\bUSERPROFILE\b');
/// `.harness` straight after home text in one literal: $home/.harness, ${x}.harness, $sep.harness, ~/.harness, %USERPROFILE%\.harness.
final inline = RegExp(r'(?:\$[A-Za-z_]\w*|\}|~|%USERPROFILE%)[\\/]*\.harness(?![\w-])');
```

**The allowlist:** `bootstrap/environment_provisioner.dart` and `widgets/environment_setup_screen.dart`, for matched text that starts with `~` or `%USERPROFILE%`: setup copy a person reads.

**The not-moved lists**, `desktop/test/harness_home_not_moved/*.txt`, as Task 3's: one file per caller task, each line one hit as the guard prints it (`<file>:<line>: <matched text>`), excusing only a hit equal to it; a missing folder or file is an empty list. `desktop/test/` already holds a `.txt` (`windows_known_failures.txt`), and `flutter test` runs only `*_test.dart`. The code that reads them is a few lines of its own, under a comment that names Task 22, which deletes it.

| File | Its caller task | Hits |
|---|---|---|
| `store.txt` | 12 | `core/harness_file_store_native.dart:57` |
| `runner.txt` | 13 | `core/harness_cli_runner.dart:86` |
| `provisioner.txt` | 14 | `bootstrap/environment_provisioner.dart:550` |
| `joins.txt` | 15 | `bootstrap/agent_prefetch.dart:66,447,475`, `bootstrap/windows_git_setup.dart:81`, `state/app_state.dart:4566,4583,14889,14892`, `ws/daemon_pipe_record.dart:60`, `ws/local_daemon_transport.dart:61` |

- [ ] **Step 1: Write the test**, in `group('no hand-built home .harness path outside core/harness_home.dart')`:
  - `finds each shape in a planted line`: one hit each for `p.join(home, '.harness')`, a `'.harness',` line two lines under `homeDir(`, `'$home/.harness/run'`, `'$home${Platform.pathSeparator}.harness'`, `'$home$sep.harness${sep}auth'` and `r'%USERPROFILE%\.harness'`.
  - `ignores comments, a project's folder and .harness-<name> files`: no hit for `/// ~/.harness/logs`, `p.join(workspace.path, '.harness', 'design.json')`, `'.harness/handoff'`, `'.harness-clone-'` and `'${task.harness} · done'`.
  - `a not-moved line excuses only its own hit`: as Task 3's.
  - `lib/ holds none but the allowlisted copy and the not moved yet`: the hits left equal `[]`; the failure prints one `file:line: text` per hit.
  - `every allowlist entry still matches a hit`.
  - `every not-moved line still matches a hit`: the failure names the list file and the line.
- [ ] **Step 2: Run** `cd desktop && flutter test --no-pub test/harness_home_guard_test.dart`, before the lists exist. Expected: `lib/ holds none …` FAILS with 13 hits in 8 files: `bootstrap/agent_prefetch.dart:66,447,475`, `bootstrap/environment_provisioner.dart:550`, `bootstrap/windows_git_setup.dart:81`, `core/harness_cli_runner.dart:86`, `core/harness_file_store_native.dart:57`, `state/app_state.dart:4566,4583,14889,14892`, `ws/daemon_pipe_record.dart:60`, `ws/local_daemon_transport.dart:61`. The others PASS. Keep this output for the report: it is the guard's red run on today's tree. A file this list lacks is a caller the inventory missed: stop and report it.
- [ ] **Step 3: Write the four lists** from that output, by the table above.
- [ ] **Step 4: Run** the step 2 command. Expected: PASS, every case.
- [ ] **Step 5: Commit** `test(desktop): no hand-built home .harness path outside the module, today's callers listed as not moved yet`, with step 2's failing output in the report.

### Task 12: Desktop: the store and what names entries through it

**Depends on:** 10, 11. **Effort:** `high`.

**Red test:** the Desktop guard, once `harness_home_not_moved/store.txt` is deleted. The paths do not change.

**Files:**
- Modify: `desktop/lib/core/harness_file_store_native.dart`, `harness_file_store_web.dart`, `serial_port_lease.dart`, `uninstall_marker.dart`, `desktop/lib/logging/log_file.dart`, `desktop/lib/ws/local_cli_discovery.dart`
- Test: `desktop/test/harness_file_store_test.dart`, `serial_port_lease_test.dart`, `uninstall_marker_test.dart`, `local_cli_discovery_test.dart`
- Delete: `desktop/test/harness_home_not_moved/store.txt`

**Interfaces:**
- Produces: `HarnessFileStore.defaultDirectoryPath({Map<String, String>? environment, HarnessEntry? entry})` in place of `{environment, String? name}`, in the native and the web store (the web one still throws `UnsupportedError`). With no entry it is the store's own: `HarnessEntry.viewerApp` in a viewer build, `HarnessEntry.desktopApp` otherwise. `directoryName` goes.

| Where | Today | Becomes | Pin |
|---|---|---|---|
| `harness_file_store_native.dart:57` | `_join(_join(home, '.harness'), name ?? directoryName)` | `HarnessHome.of(home, join: _join).path(entry ?? <its own>)` | existing: `harness_file_store_test.dart:30` |
| `serial_port_lease.dart:26` | `name: 'flasher'` | `entry: HarnessEntry.flasher` | existing: `serial_port_lease_test.dart` |
| `uninstall_marker.dart:27` | `name: 'uninstalling'` | `entry: HarnessEntry.uninstalling` | existing: `uninstall_marker_test.dart:24` |
| `logging/log_file.dart:52` | `name: 'logs'` | `entry: HarnessEntry.logs` | add first: `harness_file_store_test.dart` |
| `ws/local_cli_discovery.dart:89-95` | the store's folder, its `parent`, then `computer-id` | `defaultDirectoryPath(environment: environment, entry: HarnessEntry.computerId)` | existing: `local_cli_discovery_test.dart:29` |

`settings/sections/debug_paths_card.dart` reads `DailyLogFile.defaultDirectory` and needs no edit.

- [ ] **Step 1: Pin** in `harness_file_store_test.dart`, beside the case at line 30 and through today's `name:` parameter: `names a sibling under Harness home` (`{'HOME': '/Users/tester'}` with `'logs'`, `'flasher'` and `'uninstalling'` gives `/Users/tester/.harness/logs`, `…/flasher`, `…/uninstalling`), and `with no home` (Review Focus 3: an empty environment on a computer throws `StateError`; `UninstallMarker.path(environment: {})` is null). Run `cd desktop && flutter test --no-pub test/harness_file_store_test.dart test/uninstall_marker_test.dart`: PASS on today's code. Commit `test(desktop): pin the store's sibling folders`.
- [ ] **Step 2: Delete** `test/harness_home_not_moved/store.txt` and run `flutter test --no-pub test/harness_home_guard_test.dart`. Expected: FAIL with exactly `core/harness_file_store_native.dart:57`. Commit `test(desktop): the store's hand-built home is no longer excused (red)`.
- [ ] **Step 3: Edit** the six files, and in the four tests change `name: '…'` to the entry. No expected string changes.
- [ ] **Step 4: Run** `flutter test --no-pub test/harness_home_guard_test.dart test/harness_file_store_test.dart test/serial_port_lease_test.dart test/uninstall_marker_test.dart test/local_cli_discovery_test.dart test/harness_home_test.dart` and `flutter analyze lib test/harness_file_store_test.dart`. Expected: PASS, no issue.
- [ ] **Step 5: Commit** `Desktop: the store, the logs, the flasher, the uninstall marker and the computer id come from the home module`.

### Task 13: Desktop: the CLI runner, the Windows layout, the community folder

**Depends on:** 10, 11. **Effort:** `high`.

**Red test:** the Desktop guard, once `harness_home_not_moved/runner.txt` is deleted. The paths do not change.

**Files:**
- Modify: `desktop/lib/core/harness_cli_runner.dart`, `desktop/lib/core/windows_layout.dart`, `desktop/lib/community/fork_project.dart`
- Test: `desktop/test/harness_cli_runner_test.dart`, `harness_cli_runner_windows_test.dart`, `community_fork_test.dart`
- Delete: `desktop/test/harness_home_not_moved/runner.txt`

`harnessHome` stays a `Directory` everywhere, and `managedWindowsCli` and `installedTerminalHost` keep their signatures. Below, `at(x)` is `HarnessHome.at(x.path)` with the join named.

| Where | Today | Becomes | Pin |
|---|---|---|---|
| `harness_cli_runner.dart:83-88` | `Directory(p.join(homeDir(…), '.harness'))` | `Directory(HarnessHome.of(homeDir(…)).root(HarnessRootKind.data))` | existing: `harness_cli_runner_windows_test.dart:213` |
| `harness_cli_runner.dart:112` | `'${harnessHome.path}${Platform.pathSeparator}runtime'` | `at(harnessHome)` with `separatorJoin(Platform.pathSeparator)`, `.path(HarnessEntry.runtime)` | existing: `harness_cli_runner_test.dart` |
| `harness_cli_runner.dart:118` | `…${sep}cli${sep}cli.js` | the same `at`, `.path(HarnessEntry.cli)`, then the separator and `cli.js` | existing: `harness_cli_runner_test.dart` |
| `harness_cli_runner.dart:170,277` | `p.join(harnessHome.path, 'bin'[, 'harness.exe'])` | `at(harnessHome).path(HarnessEntry.bin)`, then `p.join(…, 'harness.exe')` at 170 | existing: `harness_cli_runner_windows_test.dart` |
| `windows_layout.dart:75,81,101` | `p.join(harnessHome.path, 'runtime' \| 'cli')`, `p.join(harnessHome.path, 'runtime', 'pty')` | `at(harnessHome).path(HarnessEntry.runtime \| .cli)`, then `p.join(…, 'pty')` at 101 | existing: `harness_cli_runner_windows_test.dart` |
| `fork_project.dart:52` | `p.join(HarnessCliRunner().harnessHome.path, 'community')` | `at(HarnessCliRunner().harnessHome).path(HarnessEntry.community)` | add first: `community_fork_test.dart` |
| `fork_project.dart:435-440` | `p.join(cli.harnessHome.path, 'dsh', 'autonomous', 'godogen', 'node_modules')` | `p.join(at(cli.harnessHome).path(HarnessEntry.dsh), 'autonomous', 'godogen', 'node_modules')` | add first: `community_fork_test.dart` |

- [ ] **Step 1: Pin** in `community_fork_test.dart`, through the seams the file already has: the default `root` of `ForkProjectImporter` is `<runner's harnessHome>/community` with `p.join`, and `prepareRuntime` for `autonomous/godogen` links `node_modules` to `<harnessHome>/dsh/autonomous/godogen/node_modules`, with a runner given a temporary `harnessHome`. Run `cd desktop && flutter test --no-pub test/community_fork_test.dart`: PASS on today's code. Commit `test(desktop): pin the community folder and godogen's modules`. A default no test can reach without the real home is reported as `none`.
- [ ] **Step 2: Delete** `test/harness_home_not_moved/runner.txt` and run `flutter test --no-pub test/harness_home_guard_test.dart`. Expected: FAIL with exactly `core/harness_cli_runner.dart:86`. Commit `test(desktop): the CLI runner's hand-built home is no longer excused (red)`.
- [ ] **Step 3: Edit** the three files.
- [ ] **Step 4: Run** `flutter test --no-pub test/harness_home_guard_test.dart test/harness_cli_runner_test.dart test/harness_cli_runner_windows_test.dart test/community_fork_test.dart test/cli_transcript_test.dart test/local_cli_discovery_test.dart` and `flutter analyze lib/core lib/community`. Expected: PASS, no issue.
- [ ] **Step 5: Commit** `Desktop: the CLI runner, the Windows layout and the community folder take their folders from the home module`.

### Task 14: Desktop: the provisioner

**Depends on:** 10, 11. **Effort:** `high`.

**Red test:** the Desktop guard, once `harness_home_not_moved/provisioner.txt` is deleted. The paths do not change.

**Files:**
- Modify: `desktop/lib/bootstrap/environment_provisioner.dart`
- Test: `desktop/test/environment_provisioner_test.dart`
- Delete: `desktop/test/harness_home_not_moved/provisioner.txt`

Below, `slash(x)` is `HarnessHome.at(x, join: separatorJoin('/'))`.

| Where | Today | Becomes | Pin |
|---|---|---|---|
| `:545-551` | `'$home${Platform.pathSeparator}.harness'` | `HarnessHome.of(home, join: separatorJoin(Platform.pathSeparator)).root(HarnessRootKind.data)` | add first: a provisioner made with no `harnessHome` has `'${userHome()}${Platform.pathSeparator}.harness'` |
| `:1461` | `'${harnessHome.path}/runtime/current-node'` | `'${slash(harnessHome.path).path(HarnessEntry.runtime)}/current-node'` | existing: the managed-CLI cases |
| `:1465` | `'${harnessHome.absolute.path}/runtime/'` | `'${slash(harnessHome.absolute.path).path(HarnessEntry.runtime)}/'` | existing: the same cases |
| `:1475` | `'${harnessHome.path}/cli/cli.js'` | `'${slash(harnessHome.path).path(HarnessEntry.cli)}/cli.js'` | existing: the same cases |
| `:1537` | `p.join(harnessHome.path, 'bin')` | `HarnessHome.at(harnessHome.path).path(HarnessEntry.bin)` | existing: the Windows signature cases |
| `:1738` | `'${harnessHome.path}/desktop-app-v2/setup-runs/…'` | `'${slash(harnessHome.path).path(HarnessEntry.desktopApp)}/setup-runs/…'` | add first: the Terminal handoff's script is under `'${scratch.path}/desktop-app-v2/setup-runs/'` |

Lines 303, 310, 319, 327, 786, 787 and 2164 are copy and are not edited. Line 1213 (`harnessHome.parent`) is not edited.

- [ ] **Step 1: Pin** the two `add first` rows in `environment_provisioner_test.dart`, through the fakes it already has. Run `cd desktop && flutter test --no-pub test/environment_provisioner_test.dart`: PASS on today's code. Commit `test(desktop): pin the provisioner's default home and its setup-run folder`. A row no fake can see is reported as `none`.
- [ ] **Step 2: Delete** `test/harness_home_not_moved/provisioner.txt` and run `flutter test --no-pub test/harness_home_guard_test.dart`. Expected: FAIL with exactly `bootstrap/environment_provisioner.dart:550`. Commit `test(desktop): the provisioner's hand-built home is no longer excused (red)`.
- [ ] **Step 3: Edit** the six places.
- [ ] **Step 4: Run** `flutter test --no-pub test/harness_home_guard_test.dart test/environment_provisioner_test.dart test/environment_setup_screen_test.dart test/process_responsibility_test.dart` and `flutter analyze lib/bootstrap`. Expected: PASS, no issue; the provisioner's copy is still excused by the allowlist.
- [ ] **Step 5: Commit** `Desktop: the provisioner takes its folders from the home module`.

### Task 15: Desktop: the remaining joins

**Depends on:** 10, 11. **Effort:** `high`.

**Red test:** the Desktop guard, once `harness_home_not_moved/joins.txt` is deleted. The paths do not change.

**Files:**
- Modify: `desktop/lib/bootstrap/agent_prefetch.dart`, `desktop/lib/bootstrap/windows_git_setup.dart`, `desktop/lib/ws/daemon_pipe_record.dart`, `desktop/lib/ws/local_daemon_transport.dart`, `desktop/lib/state/app_state.dart`
- Test: `desktop/test/agent_prefetch_test.dart`, `desktop/test/windows_git_setup_test.dart`
- Delete: `desktop/test/harness_home_not_moved/joins.txt`

Below, `slash(h)` is `HarnessHome.of(h, join: separatorJoin('/'))` and `sep(h)` is `HarnessHome.of(h, join: separatorJoin(Platform.pathSeparator))`.

| Where | Today | Becomes | Pin |
|---|---|---|---|
| `agent_prefetch.dart:66` | `'$_home/.harness/run'` | `slash(_home!).path(HarnessEntry.run)` | none: null under `flutter test` (`kUnderTest`) |
| `agent_prefetch.dart:447` | `'$home/.harness/runtime/current-node'` | `'${slash(home).path(HarnessEntry.runtime)}/current-node'` | none: private, reads the real home |
| `agent_prefetch.dart:475` | `'$home/.harness/cli'` | `slash(home).path(HarnessEntry.cli)` | existing: `agent_prefetch_test.dart:623-639` |
| `windows_git_setup.dart:81` | `p.windows.join(home, '.harness', 'run', 'git-install-tried')` | `p.windows.join(HarnessHome.of(home, join: p.windows.join).path(HarnessEntry.run), 'git-install-tried')` | add first: `windows_git_setup_test.dart`, the marker's path with `{'USERPROFILE': r'C:\Users\me'}` is `r'C:\Users\me\.harness\run\git-install-tried'` |
| `ws/daemon_pipe_record.dart:60` | `(windows ? p.windows : p.posix).join(home, '.harness', 'cli', 'data')` | the same context's `join(HarnessHome.of(home, join: <that context's join>).path(HarnessEntry.cli), 'data')` | existing: `daemon_pipe_record_test.dart:37,44` |
| `ws/local_daemon_transport.dart:61` | `'$home/.harness/s/$hex/…'` | `'${slash(home).path(HarnessEntry.s)}/$hex/…'` | existing: `local_daemon_transport_test.dart:153,169` |
| `state/app_state.dart:4566` | `'$home${Platform.pathSeparator}.harness${Platform.pathSeparator}cli'` | `sep(home).path(HarnessEntry.cli)` | none: `kUnderTest` answers before it |
| `state/app_state.dart:4583` | `'$home$sep.harness${sep}auth${sep}session.json'` | `'${sep(home).path(HarnessEntry.auth)}${Platform.pathSeparator}session.json'` | none: `kUnderTest` answers before it |
| `state/app_state.dart:14889,14892` | `'$home/.harness/claude-profiles/$n'` | `'${slash(home).path(HarnessEntry.claudeProfiles)}/$n'` | existing: `agent_change_test.dart:1755` |

- [ ] **Step 1: Pin** the Windows Git marker in `windows_git_setup_test.dart`, through the file seam the test already fakes. Run `cd desktop && flutter test --no-pub test/windows_git_setup_test.dart`: PASS on today's code. Commit `test(desktop): pin the Windows Git marker's path`. If the marker's path reaches no fake, report it as `none`.
- [ ] **Step 2: Delete** `test/harness_home_not_moved/joins.txt` and run `flutter test --no-pub test/harness_home_guard_test.dart`. Expected: FAIL with exactly the ten hits of `joins.txt` (Task 11's table). Commit `test(desktop): the remaining hand-built homes are no longer excused (red)`.
- [ ] **Step 3: Edit** the five files.
- [ ] **Step 4: Run** `flutter test --no-pub test/harness_home_guard_test.dart test/agent_prefetch_test.dart test/windows_git_setup_test.dart test/daemon_pipe_record_test.dart test/local_daemon_transport_test.dart test/agent_change_test.dart test/sign_in_step_flow_test.dart test/kept_sign_in_launch_test.dart` and `flutter analyze lib/bootstrap lib/ws lib/state/app_state.dart`. Expected: PASS, no issue.
- [ ] **Step 5: Commit** `Desktop: prefetch, Git setup, the daemon's record and socket, and the app's own checks take their folders from the home module`.

### Task 16: hn: the helper, the guard, three callers

**Depends on:** none. **Effort:** `high`.

**Red test:** the tests in `tui/src/harness_home.rs`.

**Files:**
- Create: `tui/src/harness_home.rs`
- Modify: `tui/src/main.rs` (`mod harness_home;`), `tui/src/shell_picker.rs`, `tui/src/shell_context.rs`, `tui/src/app.rs`

`tui/src/shell_integration.sh` and `tui/src/daemon.rs` are not edited.

**Interfaces:**
- Produces:
  ```rust
  pub const HARNESS_DIR: &str = ".harness";
  #[derive(Clone, Copy, Debug, PartialEq, Eq)] pub enum Root { Data, State }
  /// What hn builds through the helper: tui (Data), shell-requests (State).
  #[derive(Clone, Copy, Debug, PartialEq, Eq)] pub enum Entry { Tui, ShellRequests }
  impl Entry { pub fn name(self) -> &'static str; pub fn root(self) -> Root }
  pub fn harness_root(home: impl AsRef<Path>, root: Root) -> PathBuf;
  /// `<home>/.harness/<entry>`: `home.join(".harness").join(name)`.
  pub fn harness_path(home: impl AsRef<Path>, entry: Entry) -> PathBuf;
  ```

| Where | Today | Becomes |
|---|---|---|
| `shell_picker.rs:138`, `shell_context.rs:507` | `PathBuf::from(var("HOME").unwrap_or_default()).join(".harness/shell-requests")` | `harness_path(var("HOME").unwrap_or_default(), Entry::ShellRequests)` |
| `app.rs:224` | `PathBuf::from(var("HOME").unwrap_or_default()).join(".harness").join("tui")` | `harness_path(var("HOME").unwrap_or_default(), Entry::Tui)` |

`daemon.rs:50` (`PathBuf::from(var_os("HOME").unwrap_or_default()).join(".harness/cli/data")`) keeps its literal byte for byte: joined in one piece, its Windows text is `…\.harness/cli/data`, which the helper would turn into `…\.harness\cli\data`. It is on the guard's allowlist and on "For PR 2".

Each caller keeps `var` as it has it. The pins are the native fixtures (Verification 1): no Rust test can set `HOME` in a threaded run.

**The guard** (`std` only), over every `.rs` and `.sh` under `src` but `harness_home.rs`, with `//` comments (`#` in `.sh`) and every `#[cfg(test)]` `mod … { … }` block dropped:
- a join hit: a line holds `".harness` followed by `"`, `/` or `\`, and that line or one of the two above holds `HOME`, `USERPROFILE`, `home` or `profile` as a whole word;
- an inline hit: a line holds `$HOME/.harness`, `~/.harness`, `%USERPROFILE%\.harness` or `{home}/.harness`, not followed by a letter, a digit, `_` or `-`.
- Allowlist, each entry a file, its matched text and its reason:
  - `shell_integration.sh`, any: sourced by a shell that cannot call the helper.
  - `daemon.rs`, the text `".harness/cli/data"`: its one-piece join is today's Windows text; listed for PR 2.

- [ ] **Step 1: Write the failing tests** in `harness_home.rs`:
  - `every entry is under the home's .harness`: `harness_path("/h", Entry::Tui)` is `PathBuf::from("/h").join(".harness").join("tui")`, and so for `shell-requests`; the roots are `Data`, `State`.
  - `both roots are one folder`: `harness_root("/h", Root::Data)` equals `harness_root("/h", Root::State)` equals `PathBuf::from("/h").join(".harness")`.
  - `the same paths as before`: `harness_path("/h", Entry::ShellRequests)` equals `PathBuf::from("/h").join(".harness/shell-requests")`.
  - `an empty home` (Review Focus 3): `harness_path("", Entry::Tui)` equals `PathBuf::from("").join(".harness").join("tui")`.
  - `the guard finds each shape in a planted line`, `the guard ignores comments, test modules, a project's folder and .harness-<name>` (`".harness/handoff/{}"` with no home is no hit), `src holds none but the allowlisted`, and `every allowlist entry still matches a hit`.
- [ ] **Step 2: Run** `cd tui && cargo test --locked harness_home`. Expected: FAIL to compile (the helper is not written).
- [ ] **Step 3: Implement the helper**, then run again. Expected: every test passes but `src holds none but the allowlisted`, which FAILS with `app.rs:224`, `shell_context.rs:507`, `shell_picker.rs:138`. Commit `test(hn): the home helper's tests and guard (red)` with that output in the report.
- [ ] **Step 4: Move the three callers.**
- [ ] **Step 5: Run** `cargo test --locked`. Expected: PASS.
- [ ] **Step 6: Commit** `hn: its folders under the home come from one helper`.

### Task 17: PTY host: the helper, the guard, the launcher, the Desktop uninstaller

**Depends on:** none. **Effort:** `xhigh`.

**Red test:** the tests in `pty/src/harness_home.rs`.

**Files:**
- Create: `pty/src/harness_home.rs`
- Modify: `pty/src/lib.rs` (`pub mod harness_home;`), `pty/src/launcher.rs`, `pty/src/desktop/uninstall.rs`

**Interfaces:**
- Produces:
  ```rust
  pub const HARNESS_DIR: &str = ".harness";
  #[derive(Clone, Copy, Debug, PartialEq, Eq)] pub enum Root { Data, State }
  /// `%USERPROFILE%`, then `HOME` (off Windows, for the tests); none when unset or empty.
  pub fn home(env: impl Fn(&str) -> Option<OsString>) -> Option<PathBuf>;
  pub fn harness_root(home: &Path, root: Root) -> PathBuf;
  /// The distinct roots, the data root first: today one.
  pub fn harness_roots(home: &Path) -> Vec<PathBuf>;
  ```
- `launcher::default_root(env)` keeps its name and signature and becomes `home(env).map(|home| harness_root(&home, Root::Data))`: the install root holds `cli` and `bin`.
- `desktop/uninstall.rs`: line 272's overlap check runs for each of `harness_roots(&profile)`; `remove_app_state` (line 325) answers `harness_roots(profile)` when the profile does not resolve; `remove_state_at` (line 329) does its work for each root and gathers what is left.

**Pins:** existing. `launcher.rs:378-384` (`the_default_root_is_the_profiles_harness_folder`) and the uninstaller's own tests from `uninstall.rs:730`, which build `.harness` trees by hand and are not edited.

**The guard:** as Task 16's, with no allowlist (and so no stale-allowlist case).

- [ ] **Step 1: Write the failing tests** in `harness_home.rs`:
  - `the home is the profile, then HOME`: with both set it is `USERPROFILE`'s; with `HOME` alone, `HOME`'s; none with neither or with an empty value (Review Focus 3).
  - `both roots are the home's .harness, and the roots are one`: `harness_root(Path::new("P"), Root::Data)` equals `harness_root(Path::new("P"), Root::State)` equals `PathBuf::from("P").join(".harness")`; `harness_roots(Path::new("P"))` is that one path.
  - the first three guard tests of Task 16 (no allowlist, so no stale-allowlist case).
- [ ] **Step 2: Run** `cd pty && cargo build --locked && cargo test --locked harness_home`. Expected: FAIL to compile.
- [ ] **Step 3: Implement the helper**, then run again. Expected: every test passes but `src holds none`, which FAILS with `desktop/uninstall.rs:272,325,329` and `launcher.rs:64`. Commit `test(pty): the home helper's tests and guard (red)` with that output in the report.
- [ ] **Step 4: Move** `launcher.rs` and `desktop/uninstall.rs`.
- [ ] **Step 5: Run** `cargo test --locked`. Expected: PASS, with no existing test edited.
- [ ] **Step 6: Commit** `PTY host: the launcher and the Desktop uninstaller take Harness's roots from one helper`.

### Task 18: Harness Device: the helper, the guard, the CLI lookup

**Depends on:** none. **Effort:** `high`.

**Red test:** the tests in `device-app/src-tauri/src/harness_home.rs`.

**Files:**
- Create: `device-app/src-tauri/src/harness_home.rs`
- Modify: `device-app/src-tauri/src/lib.rs` (`pub mod harness_home;`), `device-app/src-tauri/src/cli.rs`

**Interfaces:**
- Produces: `Root { Data, State }`; `Entry { Cli, Runtime }` with `name()` (`cli`, `runtime`) and `root()` (`Data`, `State`); `harness_root(home: &Path, root: Root) -> PathBuf`; `harness_path(home: &Path, entry: Entry) -> PathBuf`.
- `cli.rs:85-88` (`installed`): `cli_js` is `harness_path(home, Entry::Cli).join("cli.js")` and the runtime is `harness_path(home, Entry::Runtime)`.

**Pins:** existing. `cli.rs`'s tests from line 588 build `.harness/runtime` and `.harness/cli/cli.js` by hand and are not edited.

**The guard:** as Task 16's, with no allowlist. The helper names no other component's path in a string (`device-app/AGENTS.md`): single segments only.

- [ ] **Step 1: Write the failing tests** in `harness_home.rs`: `every entry is under the home's .harness` (`harness_path(Path::new("/h"), Entry::Cli)` is `PathBuf::from("/h").join(".harness").join("cli")`, and so for `runtime`; roots `Data`, `State`), `both roots are one folder`, and the first three guard tests of Task 16.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --locked --lib harness_home`. Expected: FAIL to compile.
- [ ] **Step 3: Implement the helper**, then run again. Expected: every test passes but `src holds none`, which FAILS with `cli.rs:86`. Commit `test(device): the home helper's tests and guard (red)` with that output in the report.
- [ ] **Step 4: Move** `cli.rs`.
- [ ] **Step 5: Run** `cargo test --locked --lib`. Expected: PASS, with no existing test edited.
- [ ] **Step 6: Commit** `Harness Device: the CLI lookup takes its folders from one helper`.

### Task 19: The temporary workflow

**Depends on:** 1, 2 (its Windows job runs their specs). **Effort:** `medium`.

**Red test:** none. A temporary workflow changes no behaviour: one commit. A fault in the file that a later push shows is fixed in a commit of its own.

**Files:**
- Create: `.github/workflows/tmp-harness-paths.yml`

- [ ] **Step 1: Create the workflow** with exactly this content:

```yaml
name: tmp harness-paths

# TEMPORARY: removed before the merge (docs/plans/2026-11-18-harness-paths-plan.md, Task 20).
# hn's native fixtures pin the folders it finds under the home (PR CI runs its unit tests only), and the home
# module's specs run on a real Windows (windows.yml does not name them). No secret, no cache, nothing published or
# written outside the run.
on:
  push:
    branches: [chore/harness-paths]

permissions:
  contents: read

concurrency:
  group: tmp-harness-paths
  cancel-in-progress: true

jobs:
  tui-native:
    runs-on: ubuntu-latest
    timeout-minutes: 40
    steps:
      - uses: actions/checkout@v7
      - uses: dtolnay/rust-toolchain@stable
      - uses: actions/setup-node@v7
        with:
          # The same pin as release-tui.yml.
          node-version: 24.22.2
      - name: Install native test dependencies
        run: |
          sudo apt-get update && sudo apt-get install -y tmux zsh
          npm ci --prefix cli --no-audit --no-fund
      - name: Build hn
        working-directory: tui
        run: cargo build --locked --release
      - name: Build native comparison reference
        id: reference-tmux
        uses: ./.github/actions/reference-tmux
      - name: The native fixtures
        env:
          REFERENCE_TMUX_BIN: ${{ steps.reference-tmux.outputs.bin }}
          TERM: xterm-256color
          COLORTERM: truecolor
        run: PATH="$REFERENCE_TMUX_BIN:$PATH" python3 scripts/validate-tui-native.py tui/target/release/harness-tui
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: tmp-harness-paths-tui-native
          path: .harness/validation/
          if-no-files-found: ignore
          retention-days: 7

  windows-paths:
    runs-on: windows-latest
    timeout-minutes: 30
    defaults:
      run:
        shell: pwsh
        working-directory: cli
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          # The same pin as windows.yml.
          node-version: 24.22.2
      - name: CLI install
        run: npm ci
      # vitest by its file: no shell in between.
      - name: The home module, and today's default folders, on Windows
        run: node node_modules/vitest/vitest.mjs run src/config/harnessHome.spec.ts src/config/harnessHome.defaults.spec.ts --maxWorkers=1 --reporter=verbose
```

- [ ] **Step 2: Lint** with `actionlint .github/workflows/tmp-harness-paths.yml` when it is installed (PR CI's `plan` job runs it too). Expected: no output.
- [ ] **Step 3: Commit** `TEMPORARY: hn's native fixtures and the home module on Windows, for harness-paths`.

### Task 20: Remove the temporary workflow

**Depends on:** Tasks 1 to 19, 21 and 22, and Verification 1 with its evidence recorded. The main session starts it. **Effort:** `medium`.

**Red test:** none: one commit.

**Files:**
- Delete: `.github/workflows/tmp-harness-paths.yml`

- [ ] **Step 1: Remove it and commit:** `git rm .github/workflows/tmp-harness-paths.yml`, then `git commit -m "Remove the temporary workflow of harness-paths"`.
- [ ] **Step 2: Check nothing of it is left:** `git grep -n "tmp-harness-paths" -- . ':!docs/plans'` and `git diff --stat origin/main...HEAD -- .github` both print nothing.

### Task 21: CLI: the guard keeps no not-moved list

**Depends on:** 4, 5, 6, 7, 8, 9: each deletes its own list. **Effort:** `medium`.

**Red test:** none: test code only, and the guard stays green. One commit.

**Files:**
- Modify: `cli/src/config/harnessHome.guard.spec.ts`

- [ ] **Step 1: Check the lists are gone:** `git ls-files cli/src/config/harnessHome.notMoved` prints nothing. A list still there names a caller task that has not landed: stop and report it.
- [ ] **Step 2: Delete** the code that reads the lists and the cases `a not-moved line excuses only its own hit` and `every not-moved line still matches a hit`, and rename `… hold none but the allowlisted and the not moved yet` to `cli/src and cli/hook hold none but the allowlisted`.
- [ ] **Step 3: Run** `cd cli && npx vitest run src/config/harnessHome.guard.spec.ts`. Expected: PASS. `grep -n -i "not.moved" src/config/harnessHome.guard.spec.ts` prints nothing.
- [ ] **Step 4: Commit** `test(cli): the home guard keeps no not-moved list`.

### Task 22: Desktop: the guard keeps no not-moved list

**Depends on:** 12, 13, 14, 15: each deletes its own list. **Effort:** `medium`.

**Red test:** none: test code only, and the guard stays green. One commit.

**Files:**
- Modify: `desktop/test/harness_home_guard_test.dart`

- [ ] **Step 1: Check the lists are gone:** `git ls-files desktop/test/harness_home_not_moved` prints nothing. A list still there names a caller task that has not landed: stop and report it.
- [ ] **Step 2: Delete** the code that reads the lists and the cases `a not-moved line excuses only its own hit` and `every not-moved line still matches a hit`, and rename `lib/ holds none but the allowlisted copy and the not moved yet` to `lib/ holds none but the allowlisted copy`.
- [ ] **Step 3: Run** `cd desktop && flutter test --no-pub test/harness_home_guard_test.dart` and `flutter analyze test/harness_home_guard_test.dart`. Expected: PASS, no issue. `grep -n -i "not.moved" test/harness_home_guard_test.dart` prints nothing.
- [ ] **Step 4: Commit** `test(desktop): the home guard keeps no not-moved list`.

---

## The pull request's body

Written by the main session, not a task. It carries:

- **What and why:** PR 1 of 2 toward XDG paths on Linux; no path changes.
- **Platforms:** macOS, Linux, Windows: every path byte for byte as before. Mobile and backend untouched.
- **The core:** the sentence from Task 4 on why `config/harnessHome.ts` is a new line of `architecture.coreFiles.txt`.
- **Evidence:** each guard's red run on today's tree (Tasks 3 and 11, run without their not-moved lists; Tasks 16, 17 and 18), each caller task's red commit (Tasks 4 to 9, 12 to 15) and every guard green on the final head, with no not-moved list left (Tasks 21, 22); Task 2's spec green before and after; the unchanged-bytes `git diff --stat`; the `harness-local-checks` fence; the links of the hand-started runs.
- **For PR 2:** the list at the end of this plan.

## Verification

There is no new feature to click through. Every check below proves that the same paths resolve as before.

**Never touched:** the developer's real `~/.harness`, `~/.claude`, `~/.codex`, everyday daemon (port 18473), tmux server, any backend, production. Every check uses a throwaway home, the suites' own isolation, or a GitHub runner.

**Turns.** The tester runs the hand-started GitHub runs, checks 3, 4 and 5, one after another without asking the orchestrator before each: it starts the next only once the previous has finished (the account runs at most 20 jobs at once).

**1. The temporary workflow** (`.github/workflows/tmp-harness-paths.yml`, by itself at each push to `chore/harness-paths`)
- `tui-native`, Linux: builds `hn` from the branch and runs `scripts/validate-tui-native.py`, each fixture in a home, socket name and mock port of its own. A person sees every fixture pass. `shell-integration` and `composer-machine` find requests under `<home>/.harness/shell-requests`; `welcome` and `workspace-controls` read and write `<home>/.harness/tui/…`; `workspace-controls`' mock daemon listens in `<home>/.harness/cli/data`. A red fixture is run once more by itself on `hn` built at the merge base: red there too, it is not this branch's, and the report carries both results.
- `windows-paths`, Windows: Task 1's and Task 2's specs pass on a real Windows, where `homedir()` is `%USERPROFILE%` and the join is `\`.
- Evidence: the run of the final head before Task 20 removes the file. Its link goes in the pull request.
- Proposal, not built here: name `src/config` in `windows.yml`'s CLI spec list, so these specs keep running on Windows.

**2. In PR CI, by itself**, once the pull request is ready: `cli-typecheck` and `cli-tests` (Tasks 1 to 9 and 21, the goldens, `architecture.spec.ts`), `companions` and `pty-checks` (a `cli/` and a `pty/` change), `desktop-tests` (Tasks 10 to 15 and 22; `mobile-checks` if a file the phone's tests read changed), `tui-test` (Task 16), `device-app-checks` (Task 18), `process-checks` (the workflow file). A person sees `ci/required` green with the three guards in it. Nothing is started by hand.

**3. CLI end to end** (the real daemon in a throwaway home: its data folder, hooks, sockets and routes still resolve)
- On GitHub, by hand, once on the final head: Actions → CLI end to end → Run workflow, branch `chore/harness-paths` (`.github/workflows/cli-e2e.yml`). Eight Linux shards and the macOS disk-full job; isolation is the suite's own (`cli/e2e/harness/daemon.ts`).
- A person sees every shard pass, `e2e-summary` green. The link goes in the pull request.

**4. Windows** (the PTY host, `hn` and the launcher on Windows; `src/lib/uninstall` on Windows; a real install, then `harness uninstall`)
- On GitHub, by hand, once on the final head, after check 3 has finished: Actions → Windows → Run workflow, branch `chore/harness-paths`, inputs left as they are (`.github/workflows/windows.yml`).
- A person sees both architectures pass: `cargo test` for `pty` and `tui`, the Windows CLI specs, and the `install` job's "Check the install" and "Uninstall, and check nothing is left".

**5. Windows desktop** (Desktop's Windows paths: `daemon_pipe_record`, `windows_layout`, `windows_git_setup`, the runner and the provisioner)
- On GitHub, by hand, once on the final head, after check 4: Actions → Windows desktop → Run workflow, branch `chore/harness-paths`, `release` off (`.github/workflows/windows-desktop.yml`).
- A person sees the suite pass on x64 and arm64 against `desktop/test/windows_known_failures.txt`, with no new failure.

**Windows needs nothing beyond checks 1, 4 and 5:** no real PC, no sign-in.

**6. Local gates on this Mac**, at the final head, recorded in the pull request (PR CI does not run them):
- `python3 scripts/local-checks.py --run` from a clean tree. These paths select two checks: `cli-shell` (`lib/engineLaunch.ts`) and `cli-pty` (`pty/`). Its fence goes in the pull request's body before the tested commit is pushed.
- `cd cli && npm run test:core`: not selected by the paths, run because the module loads in the core's process. 100% per file, as before.
- `make desktop-test`: not selected by the paths (no macOS-specific Desktop file changes), run because Desktop reads these folders on a Mac.
- `cd device-app/ui && npm run build && cd ../src-tauri && cargo test --locked`: PR CI compiles the Device app's Linux code only.
- The unchanged-bytes check of the first Global Constraint: no output.
- `cd cli && npx vitest run src/config/harnessHome.spec.ts src/config/harnessHome.defaults.spec.ts src/config/harnessHome.guard.spec.ts --reporter=verbose`: the resolved paths, posix and Windows forms, and no hand-built path left. Nothing is installed.
- Not needed: `npm run test:harnessd` (the master is not edited), the other coverage gates, the serial specs, a firmware build, an OS image.

**7. Needs the user themselves:** none. **Against production:** none, and never.

## For PR 2

Beside the spec's own list, found by this plan's inventory:

- `cli/src/harnessd/platform.ts:507`: the master's fallback data folder, a literal on the guard's allowlist.
- `tui/src/daemon.rs:50`: `".harness/cli/data"` joined in one piece (`…\.harness/cli/data` on Windows), a literal on the tui guard's allowlist.
- CLI code that joins onto a root it derives or is handed: `lib/windows/*` (`rootDir`), `lib/platformDaemon.ts:122,218`, `masterProcess.ts:248`, `services/updaterProcess.ts:76-79`, and `lib/launchers.ts:142`, which expects the managed tmux under `<root>/runtime`.
- `cli/src/lib/uninstall/removal.ts`: `PROGRAM` (`bin`, `runtime`, `pty`), `cli` and the marker are named relative to one root, and `ROOT_NAME` refuses a root not named `.harness`. `command.ts`'s copy for two roots.
- Desktop: `HarnessCliRunner.harnessHome` and `EnvironmentProvisioner.harnessHome` are one `Directory` that tests hand in; `environment_provisioner.dart:1213` takes its parent as the profile.
- Desktop `state/app_state.dart:14889`: the Claude profile folder is built here for another machine's home, which may be a Linux one.
- The copy on the guards' allowlists: `cli.ts`, `lib/uninstall/command.ts`, `config/startHome.ts`, `config/testIsolation.ts`, Desktop's setup screens.

