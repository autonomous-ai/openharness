# One path module for Harness's home folder

PR 1 of 2 toward XDG paths on Linux. This PR changes no path.

## Why

A Linux user reported that Harness does not respect XDG paths. The fix (PR 2, a separate item) moves Linux to
`$XDG_DATA_HOME/harness` and `$XDG_STATE_HOME/harness` with a one-time migration. Today `~/.harness` is rebuilt by
hand in about 60 places across the CLI, Desktop, the TUI, the PTY host and the Device app, so PR 2 would touch all of
them. This PR puts every one of those places behind one module per language, so PR 2 becomes a change to those
modules plus the migration.

## Goals

- One module per language decides Harness's home roots and every named entry under them. Every caller that builds a
  path under the account's `~/.harness` goes through it.
- Each entry is tagged with the root PR 2 will put it in (data or state). In this PR both roots resolve to exactly
  today's `~/.harness` (`%USERPROFILE%\.harness` on Windows), so every path is byte-identical on macOS, Linux and
  Windows.
- A guard test per language fails on any new hand-built home `.harness` path outside the module.

## Non-goals

- XDG, a migration, or any path change. That is PR 2.
- The `.harness` folder inside a project or repo: a DSH workspace's `.harness/` (runtime, verdict, legacy
  AGENTS.md), `.harness/handoff/`, `.harness/design.json`, and the repo's `.harness/validation/` receipts written by
  `scripts/*.py`. These are not the home folder and stay as they are.
- `installer/` (its `.harness-desktop-staging-*` names are temporary files beside the install, not the home root) and
  `scripts/*.py` (repo-relative only).
- Mobile and backend: neither builds the home root.
- Files named `.harness-<something>` (temporary files, sentinels like `.harness-team-privacy`, `.harness-route`,
  `.harness-config.json`): not paths under the home root.
- A release.

## Anti-goals (a failure even if it works)

- Any byte change in a path, a hook command, the installed hook script, a pane's launch prelude, or a golden file.
  `cli/src/engines/__fixtures__/hook-installers.golden.json` and Codex `trusted_hash` entries must not change.
- Any change to an environment override: `ADAPTER_DATA_DIR`, `HARNESS_AUTH_DIR`, `HARNESS_CONNECTIONS_DIR`,
  `HARNESS_HOOK_ROUTES_DIR`, `HARNESS_FLASHER_CACHE`, `HARNESS_LOGS_DIR`, `HARNESS_PTY_DIR`, `HARNESS_DEVICES_DIR`,
  `HARNESS_AGENT_MESSAGES_DIR`, `DSH_DIR`, `ADAPTER_CLI_DIR`, `ADAPTER_RUNTIME_DIR`, `ADAPTER_COMPUTER_ID_FILE` and
  the rest. The override stays where it is read today; only the default behind it comes from the module.
- Any change to which home a caller uses. Callers that pass their own home (`home` parameters, `env.HOME ||
  homedir()`, `accountHome()`, `USERPROFILE` before `HOME` on Windows, Desktop's `homeDir()`) keep passing it.
- A module that pulls anything into the daemon core beyond Node's `os` and `path`.

## Constraints

- **Daemon core** (root `AGENTS.md`, `cli/AGENTS.md#protect-the-core`). `cli/src/core/main.ts` already imports
  `config/env.ts`, so the new module lands in the core's process. It must be tiny, import only `node:os` and
  `node:path`, and be added to `cli/src/architecture.coreFiles.txt` so `cli/src/architecture.spec.ts` stays green. No
  feature logic in it.
- **Standalone scripts stay self-contained.** `cli/hook/notify.mjs` runs as an installed copy with no imports from
  `cli/src`, and `tui/src/shell_integration.sh` is sourced by a shell. They keep their literal fallbacks and sit on the
  guard's allowlist. Their text must not change (the hook script's bytes feed Codex's trusted hash).
- **Shell text built in TypeScript** (the pane launch prelude in `cli/src/lib/engineLaunch.ts`, which writes
  `"$HOME/.harness/run/..."` and `"$HOME/.harness/logs/..."`) gets its `$HOME/.harness/<entry>` text from the module,
  so the bytes stay the same and PR 2 changes it in one place. A test must pin that text before it is touched.
- **Legacy-shape detectors** (`LEGACY_SCRIPT` in `cli/src/engines/kit/notifyHooks.ts`, which recognises hook
  commands written by old installs) describe what old builds wrote, which PR 2 must still recognise. They stay
  literal and go on the allowlist.
- **Shape checks on a path it is handed.** `prepareShortFolder` in `cli/src/lib/localSocket.ts` accepts any folder
  matching `/.harness/s/<16 hex>` without knowing the home it came from; rebuilding it from one home would narrow what
  it accepts. It stays as it is, goes on the allowlist, and is listed for PR 2.
- **Separators.** Each caller keeps the separator it uses today (Node `join`, Dart `p.windows`/`p.posix`/string
  `'/'`, Rust `Path::join`). The helpers return the same string the caller builds now.
- Every platform: macOS, Linux, Windows. Paths are unchanged on all three; the PR names them.

## Approaches

- **A. Roots only.** The module exposes `dataRoot()` and `stateRoot()`; each caller joins its own entry name.
  Smallest API, but the choice of root is spread over ~60 callers, and PR 2 has to revisit each one that picked
  wrong.
- **B. A table of named entries (chosen).** The module holds one table: every top-level entry under `~/.harness`,
  each tagged `data` or `state`. Callers ask for an entry by name. PR 2 changes how the two roots resolve and, if a
  label is wrong, moves the entry in the table, without touching a caller.
- **C. Everyone reads the path the daemon passes in its environment.** Desktop, the TUI and the Device app would
  depend on a running daemon (or its env) to find files they read before the daemon exists (setup, logs, uninstall).
  A behaviour change; rejected.

harness-pm picked B.

## Design

### Entries and their roots

The table is the single source of these names in each language. Labels are only labels in this PR (both roots are
`~/.harness`); PR 2 settles them in the module.

| Entry | Root | What it holds |
|---|---|---|
| `auth` | data | SSO session |
| `computer-id` | data | this computer's identity (a file) |
| `cli` | data | the installed CLI; `cli/data` is the daemon's data folder |
| `connections` | data | connector credentials |
| `agent-messages` | data | agent messaging state |
| `bin` | data | launchers (Windows), `harness-tui` |
| `dsh` | data | installed harness clones |
| `claude-profiles` | data | Claude accounts made by Desktop |
| `desktop-app-v2` (and any other `desktop-app*` name Desktop uses) | data | Desktop's own store |
| `viewer-app-v2` | data | the viewer build's store |
| `tui` | data | the TUI's state |
| `devices` | data | device state |
| `lessons` | data | the companions' lessons store (built in `companions/`, out of this PR; named here for PR 2) |
| `grid-fleet` | data | the grid agent's fleet state (built in `store/agents/`, out of this PR; named here for PR 2) |
| `logs` | state | dated logs |
| `runtime` | state | managed Node, tmux, pty host |
| `hook-routes` | state | per-daemon hook routing records |
| `s` | state | short daemon socket folders |
| `run` | state | download/install markers |
| `shell-requests` | state | shell context requests |
| `pty` | state | PTY host state |
| `uninstalling` | state | the uninstall marker (a file) |
| `flasher` | state | flasher markers and its download cache |

Any other entry the code builds under the home root (for example `memory` or `monitor`, if the code creates them
there) is added to the table with a label by this rule: identity, sign-in, installed program, or something the
person made → data; logs, runtime binaries, markers, sockets, routes → state. No entry gets a third `cache` label in
this PR: none is purely re-downloadable on its own (`flasher` and `runtime` were placed in state by harness-pm and
Ken); PR 2 adds a cache root if it wants one.

### CLI (TypeScript): `cli/src/config/harnessHome.ts`

New, tiny, imports only `node:os` and `node:path`. Shape (names are the builder's to refine):

- `harnessRoot(kind: 'data' | 'state', home = homedir())`: both return today's `join(home, '.harness')` in this PR.
- `harnessRoots(home = homedir())`: the distinct roots, deduplicated: today a list of one, `~/.harness`. Every caller
  that works on the whole tree uses it, so that once PR 2 splits the roots they cover both without a logic change, and
  the connectors' read fence never silently stops covering the state root: `harness uninstall`
  (`uninstall/deps.ts`, `uninstall/removal.ts`), `homeDataFolder.ts`'s "inside the account's `.harness`" check, the
  connectors' read fence in `lib/connectors/call.ts`. With one root, each behaves exactly as today. (My call, from
  the builder check.)
- `harnessPath(entry, home = homedir())`: `join(harnessRoot(rootOf(entry), home), entry)`. `entry` is a typed union of
  the table's names.
- `shellHarnessPath(entry)`: the shell text `$HOME/.harness/<entry>` for the launch prelude.

`config/env.ts` stops building `adapterRootDir` by hand and takes its defaults from the module (`cli`, `cli/data`,
`runtime`, `computer-id`, `logs`, `pty`, `devices`, `hook-routes`, `agent-messages`, `dsh`); the `~/.machine`
adoption code is unchanged (it names a legacy root, not `~/.harness`). Every other CLI file that joins
`.harness` onto a home (about 25: `authSession`, `connectors/store`, `localSocket`, `claudeHomes`, `downloadMarker`,
`flasherDir`, `shellContextReply`, `callerPane`, `startIfDown`, `engineAccount`, `homeDataFolder`, `uninstall/deps`,
`uninstall/removal`, `tui/paths`, `tui/index`, `testing/installerTmuxProbe`, `config/startHome`,
`engineLaunch`, and the rest the inventory finds) calls the module with the home it uses today.
`harnessd/platform.ts`'s fallback data folder stays literal: the master imports only Node and its own folder. It sits
on the guard's allowlist and on PR 2's list. Joins onto a root taken from `dirname(ADAPTER_CLI_DIR)` or handed in as
`rootDir` (`lib/windows/*`, `platformDaemon`, `masterProcess`, `updaterProcess`, `launchers`) are not moved either;
they are on PR 2's list.
`uninstall/removal.ts`'s `ROOT_NAME` safety check keeps checking the folder name `.harness`, taken from the module.

User-facing copy and comments that say `~/.harness` (help text in `cli.ts`, uninstall copy) stay: they describe
today's path and are not path construction. The guard's shapes are chosen so copy is not flagged (see Guard tests).

### Desktop (Dart): `desktop/lib/core/harness_home.dart`

One helper beside `core/home_dir.dart`, with the same entry table (an enum with its root) and functions mirroring the
CLI's: `harnessHome({String? home})`, `harnessRoot(kind, {home})`, `harnessPath(entry, {home, context})`, where
`context` is the `path` package context a caller uses today (`p.windows`, `p.posix`) or plain `/` joining, so every
string stays the same. Callers: `harness_file_store_native.dart`, `harness_cli_runner.dart`, `windows_git_setup.dart`,
`agent_prefetch.dart`, `environment_provisioner.dart`, `app_state.dart` (claude-profiles), `daemon_pipe_record.dart`,
`local_daemon_transport.dart`, `log_file.dart`, `uninstall_marker.dart`, `windows_layout.dart`, the debug settings
cards, and any other the inventory finds.

### Rust: one helper per crate

- `tui/`: `src/harness_home.rs` (or the crate's existing path module): `harness_home()` from `HOME` as today, and
  `harness_path(entry)`. Callers: `shell_context.rs`, `shell_picker.rs`, `app.rs`. `daemon.rs` keeps its one-piece
  `".harness/cli/data"` byte for byte (on Windows its text is `…\.harness/cli/data`, which the helper would change),
  on the guard's allowlist and on PR 2's list.
- `pty/`: `launcher::default_root` already resolves `%USERPROFILE%\.harness` (then `HOME`); it becomes the crate's
  helper, with root names (it builds no entry), and `desktop/uninstall.rs` builds `profile.join(".harness")` through it.
- `device-app/src-tauri/`: one helper for `cli.rs`'s `home.join(".harness")` paths.

Each crate's table declares only the entries that crate uses (Rust warns on a variant no code names); the full table
lives in the TypeScript and Dart modules.

Rust tests that build fixture trees may keep literals (tests are not scanned).

### Guard tests

One per language, each on the CI or required local check that already runs that language's tests:

- CLI: a vitest spec that scans non-test files under `cli/src` and `cli/hook`.
- Desktop: a Flutter test that scans `desktop/lib`.
- Rust: a test in each of `tui`, `pty`, `device-app/src-tauri` that scans its `src`.

Each fails on a hand-built **home** `.harness` path outside its module, in the shapes the code uses today: `.harness`
joined onto a home expression (`homedir()`, `home`, `HOME`, `$HOME`, `~`, `USERPROFILE`, `%USERPROFILE%`, `profile`,
`accountHome()`, Dart `homeDir()`/`$home`), in code, not comments. It ignores `.harness` joined onto a project or
workspace path, `.harness-<name>` file names, and test files. Each has a small explicit allowlist (file plus reason):
`cli/hook/notify.mjs`, `tui/src/shell_integration.sh`, `LEGACY_SCRIPT` in `notifyHooks.ts`, the literals kept for PR 2
(`harnessd/platform.ts`'s fallback, `tui/src/daemon.rs`'s `".harness/cli/data"`), and any user-facing copy the
shapes cannot tell from code. Each guard is proven by a red run: it fails on a deliberately planted literal (a
test fixture string), and on today's tree before the callers move.

### Proving no behaviour change

- A unit test per module asserts every entry resolves to `<home>/.harness/<entry>` on posix and Windows forms, and
  both roots equal `harnessHome`.
- Existing goldens and specs stay byte-identical with no fixture edits: `hook-installers.golden.json`, the launch
  goldens, `hookAdmission.golden.spec.ts`, `hermesIdentity.golden.spec.ts`, `envIsolation.spec.ts`.
- Before a caller whose output is not already pinned by a test is moved (for example the launch prelude's
  `$HOME/.harness` lines), a test pinning today's output lands first.

## PR 2 also has to change

These build `~/.harness` paths too, but stay out of this PR (harness-pm, 2026-11-18): shell, PowerShell, Python and
standalone `.mjs` have no shared module, and the store agents are packages shipped on their own that cannot import
`cli/src`. PR 2 changes them beside the modules and the migration:

- Installers: `cli/scripts/install.sh`, `cli/scripts/install-cli.sh`, `cli/scripts/install.ps1` (lay down `cli`,
  `runtime`, `bin`, `tui/first-run`).
- Companions: `companions/src/memory/lessons/store.ts`, `publish.ts`, `companions/src/application/lessons/propose.ts`,
  `companions/src/shared/classify.ts`, `companions/src/companion/client.ts`, `companions/scripts/memory-extraction-eval.ts`.
- `os/setup.py` (auth, computer-id).
- Store agents that read the home root: `store/agents/autonomous-grid`, `machine-monitor`, `harness-monitor`,
  `memories`, `vllm`, `ollama`, `mlx-lm` (data folder, `s/` sockets, `grid-fleet`). Most other store agents use only a
  workspace's `.harness/`, which does not move.
- Developer and test tools under `cli/scripts/` (e2e drivers, benchmarks, Windows CI checks).
- The standalone files on this PR's allowlist: `cli/hook/notify.mjs`, `tui/src/shell_integration.sh`,
  `prepareShortFolder` in `cli/src/lib/localSocket.ts`, `cli/src/harnessd/platform.ts`'s fallback, `tui/src/daemon.rs`'s
  `".harness/cli/data"`.
- CLI joins onto `dirname(ADAPTER_CLI_DIR)` or a `rootDir`: `cli/src/lib/windows/*`, `lib/platformDaemon.ts`,
  `masterProcess.ts`, `services/updaterProcess.ts`, `lib/launchers.ts`. `LEGACY_SCRIPT` stays: it names what old installs wrote.

## Design section (feature-design-rules)

N/A: this change stores, syncs and exposes no new data and moves none. Every file stays where it is.

## Left to the builder

- Exact function and type names, and where the Rust helper sits inside each crate.
- The full inventory of callers (the lists above are what recon found; the plan lists every file).
- The guard's exact patterns and allowlist, within the shapes above.
- How the Dart helper takes the separator, as long as every string stays the same.
