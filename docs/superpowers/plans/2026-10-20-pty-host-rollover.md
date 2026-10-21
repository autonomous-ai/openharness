# PTY Host Rollover and Delivery (sub-project G) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A PTY payload the owner promotes reaches every Windows machine through the self-update. New panes run the new
host and old hosts drain away. Running agents move to the new host by themselves while idle and off screen, unnoticed.

**Architecture:**
- **One host per build.** The host's instance name becomes `p<protocol>-<version tag>`, and every file the instance
  keys follows it, so two builds of protocol 2 run side by side in one home. A seeded `create` is an optional
  protocol-2 feature that the host advertises; `PTY_PROTOCOL` stays 2.
- **Create and drain.** The daemon computes its target instance from the binary it would start. That host is the
  create backend; every other host is a drain backend, reusing today's drain.
- **Delivery.** A PTY poller beside the CLI and hn pollers in the updater process reads the production
  `pty/metadata.json`. It downloads, verifies, canaries and installs a newer payload beside the old one, replaces
  `bin\harness.exe` and `bin\harness-launch.exe` by rename-aside, moves `current-pty`, and tells the master, whose
  probation covers the PTY as it covers the CLI.
- **The mover.** A daemon service moves one idle, quiet, unwatched `conversation` agent at a time onto a host that
  can seed. It captures the old pane, opens a seeded pane on the new host, relaunches the engine with its resume argv,
  swaps the row's runtime, moves open streams, and closes the old pane. On failure it relaunches in the old pane.
- **On screen.** The desktop reports which tiles are on screen through its existing `app_focus` message.

**Tech Stack:**
- Rust 2024 (`pty/`, alacritty_terminal).
- TypeScript (Node 22) in `cli/`, vitest. PowerShell 5.1 in `cli/scripts/install.ps1`.
- Flutter/Dart in `desktop/`, one message field.
- GitHub Actions `windows.yml` (on demand) and `ci.yml`.

**Spec:** `docs/superpowers/specs/2026-10-20-pty-host-rollover-design.md`. Read it first: its Anti-goals are the
acceptance bar.

**Where and when.**
- Branch `feat/windows-pty-rollover`, recreated from current `main`. The old branch (from before the Windows merge)
  is replaced: its history holds commits from before the public-data cleanup. Force-pushing it needs the owner's OK.
- The worktree is `~/harnesses/worktrees/openharness/windows-pty-rollover`.
- First commit: this plan and the spec (`docs: PTY host rollover and delivery spec and plan`).
- Commits and pushes of `feat/windows-pty-rollover` are authorized once it is recreated. Never push `main`; no other
  force-push.
- It ships as its own PR to `main`, opened only when the owner asks.

## Global Constraints

**Platform and behaviour**
- Per user, with no administrator rights and no UAC prompt.
- Scope is Windows, where the PTY host is the terminal backend. tmux is not touched.
- No UI on any client, and no new frame type from the daemon to clients. The only new client signal is
  `app_focus.visibleAgents`, from the desktop to the daemon.
- Never interrupt a turn, and never end a terminal or an engine that cannot resume. Never lose input. Never give an
  agent a new id.

**The host**
- `PTY_PROTOCOL` stays `2` (Rust `pty/src/protocol.rs`, TS `cli/src/lib/ptyHost/protocol.ts`).
  `SUPPORTED_PTY_PROTOCOLS` stays `[1, 2]`.
  - The `protocol.spec.ts` test "keeps the protocol that installed Windows hosts speak" stays until G3.4, which
    replaces it with the CLI protocol rule.
- **Features:**
  - a G host lists `"features":["seed"]` in its hello reply and in its `version` line. A pre-G host lists none; an
    absent field means `[]`;
  - TS `SEED_FEATURE = 'seed'`.
- **Instance name:** `p<protocol>-<tag>`.
  - `<tag>` is the version when it matches `^[0-9A-Za-z.-]{1,32}$`.
  - Otherwise `<tag>` is `h` followed by the first 12 hex digits of SHA-256(version).
  - Pre-G hosts keep `p<protocol>`.
- **Files, all in `<home>/run/`:**
  - `pty-host-<instance>.json` (discovery);
  - `.lock`, `.panes` and `.sock`, with the same stem;
  - when `<home>/run/pty-host-<instance>.sock` would be longer than 100 bytes, the socket is
    `pty-host-s<12 hex of SHA-256(instance)>.sock`;
  - the Windows pipe suffix is `-<instance>`;
  - the host log is `<home>/logs/pty-host-<instance>.log`.
  - Legacy names (`pty-host-<protocol>.json`) are still read.

**Delivery**
- Manifest: `ADAPTER_UPDATE_URL` with its trailing `cli/metadata.json` replaced by `pty/metadata.json`, key `pty`.
  - The entry key is `win32-x64` when `process.arch` is `x64`, and `win32-arm64` when it is `arm64`. The installed
    Node is the machine's native one, as `install.ps1` picks it.
- `PTY_PAYLOAD_FILES`: `harness-pty.exe`, `harness-launch.exe`, `harness.exe`, `conpty.dll`, `OpenConsole.exe`,
  `harness-serial.exe`.
- Under `<runtime>/pty/`:
  - the staging folder is `.staging-<pid>-<ms>`;
  - the probation marker is `pty-pending.json`, `{ "version": s, "previous": s }`;
  - the rejected list is `pty-rejected.json`, a JSON array of versions.
- Renamed-aside files are `bin\<name>.old-<pid>-<ms>`. They are deleted at each updater start, and whenever deletion
  fails (still running), they are left for the next one.
- Canary:
  - `harness-pty.exe version` must print JSON whose `version` is the entry's, whose `protocol` is in
    `SUPPORTED_PTY_PROTOCOLS`, and whose `features` is an array;
  - `harness-serial.exe version`'s `version` must be the entry's;
  - each run has a 5 s timeout, with `windowsHide: true`.
- The CLI's host protocol: a G build answers `cli.js version --json` with `{"version":s,"ptyProtocol":n}`. Output that
  is not that JSON means protocol 2.
- Updater message: `{ type: 'harnessd:staged', version?: string, ptyVersion?: string }`, with at least one of the two.
- The same refusal back-off as the CLI's (`refuse` in `startSelfUpdater`). The same dev-build rule
  (`isLocalDevBuild` of the installed CLI).

**The mover**
- `QUIET_MS = 300_000`: idle with no input for this long.
- `MOVE_TIMEOUT_MS = 30_000`: the new engine must be proven within this.
- `SEED_MAX_BYTES = 4 * 1024 * 1024`: the oldest lines are dropped first.
- `SEED_HISTORY_LINES = 2000`.
- One move at a time per daemon. It runs as `restartJobs.run(agentId, fn, 'move')`.
- A move's target must list `seed`. With a pre-G target, nothing moves.

**Testing and safety**
- Never against the developer's own `~/.harness`, the daemon on 18473, engine homes or tmux.
- No production publish. A staging publish needs the owner's OK. The E2E serves its manifests from the fake HTTPS
  CDN (`fake-cdn.sh`).
- On the ARM64 VM, never touch `C:\work\e2e` or the admin profile's engine settings. On the x64 test PC, touch only
  what G installs, and clean up.
- The repo is public: no addresses, account names, ids, serials or passwords in committed evidence.
- Docs, comments and commit messages are in English. Comments say why.
- Never bare `git stash`, never `git clean -fdx`.
- Conventional commits ending with the engine's `Co-Authored-By` line.

## Review Focus

1. **`bin\harness.exe` is running when the payload lands** (a hook, a `harness send`): the rename-aside leaves the
   path answering at every moment, and the aside file goes once it exits. Pinned by G3.2's Windows real test.
2. **A PTY-only update on a machine whose CLI is current**: the master hands over with `ptyVersion` alone, the new
   core targets the new host, and the updater's next run still checks the CLI. Pinned by G3.3
   `a PTY-only staging tells the master ptyVersion alone, and the next run checks the CLI`.
3. **`<runtime>/pty/<version>/` already exists** (an `install.ps1` that put it there, or a rolled-back version's
   folder kept by §3): it is reused only when its six files match the zip byte for byte, else the payload is
   refused. Pinned by G3.2 `an existing version folder is reused only when it matches`.
4. **The daemon killed mid-move**, after the old engine stopped and before the swap.
   - After restart the row still names the old pane, which the existing restore relaunches.
   - The new pane carries `HARNESS_MOVE_OF=<agentId>`; it is killed at start before discovery, so the reconciler
     never mints a second agent for it.
   - Pinned by G4.5 `a_move_pane_left_by_a_dead_daemon_is_removed_before_discovery`.
5. **Someone arrives during the swap.**
   - Keystrokes, a paste, or a `harness send` are delivered once, in order, to the new pane.
   - A stream opened then opens on the new pane, and one already open follows it.
   - Pinned by G4.4.

## File map

| File | Task | Responsibility |
|---|---|---|
| `pty/src/instance.rs` (new), `discovery.rs`, `host_lock.rs`, `pane_ids.rs`, `transport/{unix,windows}.rs`, `logfile.rs`, `cli.rs` | G1.1 | Instance per build; every keyed file |
| `pty/tests/fixtures/instances.json` (new), `pty/tests/common/mod.rs`, `pty/tests/control.rs` | G1.1 | Shared vectors; tests that hard-code names |
| `pty/src/protocol.rs`, `cli.rs`, `server.rs` (hello reply), `panes.rs`, `pane.rs`, `pty/tests/fixtures/ops.json`, `pty/tests/stream.rs` | G1.2 | `features`; `create.seed` |
| `cli/src/lib/ptyHost/instance.ts` (new), `launch.ts`, `protocol.ts`, `client.ts`, `cli/src/lib/terminalRuntime.ts`, every `HARNESS_PANE` parser | G2.1 | Discovery by instance; the target; names; features |
| `cli/src/lib/ptyHostBackend.ts`, `cli/src/lib/ptyHost/drain.ts`, `cli/src/core/main.ts` | G2.2 | Create and drain per instance |
| `cli/src/lib/uninstall/ptyHosts.ts` | G2.3 | Uninstall ends every instance |
| `cli/src/lib/windows/ptyPayload.ts` (new) | G3.1 | Check, download, verify, unpack, canary |
| `cli/src/lib/windows/ptyInstall.ts` (new) | G3.2 | Install under the lock, undo, aside files, probation marker, rollback |
| `cli/src/lib/windows/ptyUpdate.ts` (new), `cli/src/services/updaterProcess.ts`, `cli/src/harnessd/{protocol,supervisor,masterProcess}.ts`, `cli/src/lib/selfUpdate.ts` | G3.3 | The poller; one handover; probation and rollback |
| `cli/src/cli.ts` (`version --json`, `harness update`), `selfUpdate.ts` (canary), `protocol.spec.ts`, B spec | G3.4 | The protocol rule; `harness update` |
| `cli/scripts/install.ps1`, `cli/src/scripts/installPs1.spec.ts` | G3.5 | Restart when only the PTY moved |
| `desktop/lib/state/app_state.dart`, `desktop/lib/super_tabs/workspace.dart`, `cli/src/localWsServer.ts`, `cli/src/backendSocket.ts`, `cli/src/lib/terminalStreamManager.ts`, `cli/src/core/terminalWatch.ts` | G4.1 | Who is looking |
| `cli/src/lib/hostMove/quiet.ts` (new) | G4.2 | Idle and input clocks |
| `cli/src/lib/terminalTypes.ts`, `ptyHostBackend.ts`, `cli/src/lib/hostMove/seed.ts` (new) | G4.3 | Seeded create; seed from capture |
| `cli/src/lib/hostMove/gate.ts` (new), `terminalStreamManager.ts`, `cli/src/lib/sessionInput.ts` | G4.4 | Hold input; move open streams |
| `cli/src/lib/hostMove/moveAgent.ts` (new) | G4.5 | One move, with its fallback |
| `cli/src/lib/hostMove/mover.ts` (new), `cli/src/core/main.ts` | G4.6 | Which agent, when; wiring |
| `cli/src/lib/hostMove/hostMove.real.spec.ts` (new), `.github/workflows/windows.yml` | G5.1 | Two real builds |
| `docs/testing/pty-rollover-e2e.md` (new), the spec | G5.2 | The VM and the x64 PC; status |

---

## Phase G1: The host

### Task G1.1: One instance per host build

**Files:** `pty/src/instance.rs` (new). Modify `pty/src/{lib.rs,discovery.rs,host_lock.rs,pane_ids.rs,cli.rs,
logfile.rs}`, `pty/src/transport/{unix.rs,windows.rs}`. Tests: in-file, `pty/tests/fixtures/instances.json`
(new), `pty/tests/common/mod.rs`, `pty/tests/control.rs`.

**Interfaces:**
- Produces (Rust):
  - `pub fn instance_name(protocol: u32, version: &str) -> String`;
  - `pub fn current() -> String` (`instance_name(PROTOCOL, VERSION)`);
  - `pub fn run_file(run_dir: &Path, instance: &str, ext: &str) -> PathBuf` (`pty-host-<instance>.<ext>`);
  - `pub fn socket_path(run_dir: &Path, instance: &str) -> PathBuf`, with the 100-byte rule;
  - `pub fn log_path(home: &Path, instance: &str) -> PathBuf`.
  - `discovery::instance()` is removed; callers use `instance::current()`.
- Produces (shared): `pty/tests/fixtures/instances.json`, an array of `{ "protocol": n, "version": s, "instance": s }`.
  It covers:
  - `0.4.20`;
  - `0.4.21-dev.win1`;
  - `0.1.0`;
  - `0.4.21+meta`, `1 2` and a 40-character version, all hash form.

- [ ] **Step 1: Write the failing tests.**
  - `instance.rs`:
    - `names_follow_the_shared_vectors` reads `../tests/fixtures/instances.json` and asserts each entry.
    - `a_long_home_uses_the_hashed_socket_name`: a run dir of 90 bytes gives `pty-host-s<12hex>.sock`, and a short
      one gives `pty-host-<instance>.sock`.
    - `two_builds_have_different_files`: `run_file` differs for `0.4.20` and `0.4.21`.
  - `tests/control.rs`, a new `two_versions_serve_side_by_side`, run only when `HARNESS_PTY_BIN_OLD` names a build
    of this source with another `HARNESS_PTY_VERSION` (built as in G5.1):
    1. start it and `CARGO_BIN_EXE_harness-pty` on one home;
    2. both publish their own discovery files and both answer hello, with different instances.
  - Update `discovery_names_the_host`, `children_see_harness_pane` and every hard-coded `pty-host-{PROTOCOL}` or
    `p{PROTOCOL}` in `tests/control.rs` and `tests/common/mod.rs` (`grep -n 'pty-host-\|"p{' pty/tests`) to go
    through `instance::current()` and `run_file`.
- [ ] **Step 2: Run them and see them fail.**
  - Run: `cd pty && cargo test --locked instance`.
  - Expected: FAIL; `instance` is not found.
- [ ] **Step 3: Implement.**
  - `instance.rs` per the Global Constraints (SHA-256 via the existing `sha2` dependency).
  - Rewrite `PROTOCOL`'s doc comment "Each value is its own host instance" to "each (protocol, version) is its own
    instance". The value stays 2.
  - Route `discovery::file_path`, the `.tmp` name, `host_lock::file_path`, `pane_ids::file_path`,
    `transport::unix::socket_path`, `set_discovery_aside`, the Windows `pipe_name` suffix, `logfile` and
    `Panes::child_env`'s instance through `instance::current()` and `run_file`.
  - The log rotation stays lock-holder-only, now per instance.
- [ ] **Step 4: Run.**
  - Run: `cd pty && cargo test --locked`.
  - Expected: PASS, every unit and integration test. Windows runs it in `windows.yml` (G5.1); Linux in `ci.yml`.
- [ ] **Step 5: Commit** `feat(pty): one host instance per build, so two versions run side by side`.

### Task G1.2: Features, and a pane created with a seed

**Files:**
- Modify: `pty/src/protocol.rs` (`Op::Create`; a `FEATURES` constant), `pty/src/cli.rs` (`version_line`), the hello
  reply's writer (`grep -n '"proof"' pty/src`), `pty/src/panes.rs`, `pty/src/pane.rs` (`PaneSpec`, `Pane::spawn`).
- Tests: `pty/tests/fixtures/ops.json`, `pty/tests/ops_fixture.rs`, `pty/tests/stream.rs`, `parses_every_op` in
  `protocol.rs`, `version_line_is_json_with_protocol` in `cli.rs`.

**Interfaces:**
- Produces:
  - `pub const FEATURES: &[&str] = &["seed"]`. The hello reply carries `"features": FEATURES`, and `version_line()`
    prints `{"version":…,"protocol":2,"features":["seed"]}`.
  - `Op::Create { …, seed: Option<String> }`. The JSON field is `"seed"` and its default is absent. Its text is the
    `capture`/`history` style: SGR-only ANSI, one line per row.
  - `PaneSpec.seed: Option<Vec<u8>>`.

- [ ] **Step 1: Write the failing tests.**
  - `version_line_is_json_with_protocol` also asserts `v["features"] == ["seed"]`. A hello test in
    `tests/control.rs` asserts the reply's `features`.
  - `ops.json` gains `"seed": "a\r\nb"` on its `create` entry.
  - `tests/stream.rs` gains `a_seeded_pane_starts_with_its_seed_in_history`:
    1. create with `seed = "one\r\ntwo\r\n\x1b[31mthree\x1b[0m"`, `rows = 10`, and a command that sleeps before it
       prints;
    2. take the snapshot before any output: `history` ends with the three lines in order, colour kept, and
       `capture` is blank with the cursor at 0,0;
    3. after the child prints `ready`, `capture`'s first line is `ready`.
  - `a_create_without_seed_is_unchanged`: today's snapshot is unchanged.
- [ ] **Step 2: Run.**
  - Run: `cd pty && cargo test --locked seed ops_fixture version_line hello`.
  - Expected: FAIL. `features` is missing, `seed` is an unknown field in the fixture check, and the test is missing.
- [ ] **Step 3: Implement.**
  - In `Pane::spawn`, between `Term::new` and `attach`:
    1. advance the seed bytes;
    2. then advance `"\r\n"` repeated `rows` times and `"\x1b[H"`, so the seed sits wholly in scrollback and the
       live screen is blank;
    3. bump `seq` once.
  - `draw_from_host`'s `cfg` gate does not apply here: this is spawn's own code path.
  - Update the TS `PtyOp` create type and the hello reply type in the same commit, so the `ops.json` check in
    `cli/src/lib/ptyHost/protocol.spec.ts` stays green.
- [ ] **Step 4: Run.**
  - Run: `cd pty && cargo test --locked` and `cd cli && npx vitest run src/lib/ptyHost/protocol.spec.ts`.
  - Expected: PASS.
- [ ] **Step 5: Commit** `feat(pty): advertise features, and create a pane seeded with another pane's scrollback`.

---

## Phase G2: The daemon finds hosts by instance

### Task G2.1: Instances, discovery, features and the target

**Files:**
- Create: `cli/src/lib/ptyHost/instance.ts`.
- Modify: `cli/src/lib/ptyHost/{launch.ts,protocol.ts,client.ts}`, `cli/src/lib/terminalRuntime.ts`, and every
  `HARNESS_PANE` parser. Find them with
  `grep -rn "HARNESS_PANE\|p\\\\d{1,4}" cli/src cli/hook --include=*.ts --include=*.mjs`; today that includes
  `terminalRuntime.ts` `PTY_HOST_PANE`, `hook/notify.mjs`, `messages/command.ts` and `remoteCommand.ts`.
- Tests: `instance.spec.ts` (new), `launch.spec.ts`, `client.spec.ts`, `terminalRuntime.spec.ts`.

**Interfaces:**
- Produces:
  - `hostInstanceName(protocol: number, version: string): string`, held to `pty/tests/fixtures/instances.json`.
  - `PTY_HOST_INSTANCE: RegExp`, which is `^p\d{1,4}(?:-(?:[0-9A-Za-z.-]{1,32}|h[0-9a-f]{12}))?$`, used by every
    `HARNESS_PANE` parser as `^(<instance>):(%\d{1,9})$`.
  - `SEED_FEATURE = 'seed'` in `protocol.ts`. `PtyHostClient.features: readonly string[]`, from the hello reply,
    `[]` when absent.
  - `interface PtyHostTarget { protocol: number; version: string; instance: string; features: readonly string[];
    source: 'installed' | 'binary' }`. `installed` means the version came from `current-pty`.
  - `listDiscoveries(home: string): PtyHostDiscovery[]`. It reads every `run/pty-host-*.json`, legacy included,
    keeps only files whose own `protocol` and `instance` fields are well formed, and sorts by protocol, then
    `compareVersions`.
  - `readInstanceDiscovery(home: string, instance: string): PtyHostDiscovery | null`. It reads legacy `p<n>` from
    `pty-host-<n>.json`.
  - `binaryVersion(binary: string): { version: string; protocol: number; features: string[] } | null`. It runs
    `binary version` with a 5 s timeout, `windowsHide: true`, and an argument array, and is cached by path and mtime.
    G3.1 and G3.4 use it too.
  - `targetHost(options?: PtyHostBinaryOptions): PtyHostTarget | null`. The binary is `ptyHostBinary()`; the
    version is `currentPtyVersion()` when the binary is that folder's (`source: 'installed'`), else
    `binaryVersion()` (`source: 'binary'`). The protocol and features always come from `binaryVersion()`. It is null
    when the version is unknown.
  - `ensurePtyHost(home, options & { target: PtyHostTarget | null })`.
    - With a target, it connects only to that instance's host, else starts the binary.
    - With `null`, it does what it does today: the newest running `PTY_PROTOCOL` host, else start.
    - `startHost` dedupes by home and instance.
  - `reachPtyHost(home: string, instance: string, liveness?)`.
  - `forgetExitedHost(home: string, instance: string, pid: number)`.
  - `discoveredHostDead(home, discovery: Pick<PtyHostDiscovery, 'instance' | 'pid'>, liveness?)`.
  - `discoverHosts(home)` becomes `listDiscoveries`. Its old protocol-only callers go through it.
  - `removeUnusedPtyVersions(home, runtimeDir?)`. Its running set comes from `listDiscoveries`, so every instance
    counts. Its rule is otherwise unchanged: only versions older than `current-pty`; newer folders stay.

- [ ] **Step 1: Write the failing tests.**
  - `instance.spec.ts`: `names follow the host's shared vectors`, which reads `../pty/tests/fixtures/instances.json`.
  - `client.spec.ts`: `features come from the hello reply, empty when absent`.
  - `launch.spec.ts`. Extend the helper `writeDiscoveryOf(home, protocol, value)` with an instance and file name.
    - `listDiscoveries finds legacy and versioned hosts, oldest first`.
    - `targetHost reads current-pty, and is installed`.
    - `targetHost asks a dev binary its version, and is binary` (a fake binary printing
      `{"version":"9.9.9","protocol":2,"features":["seed"]}`).
    - `targetHost is null when neither is known`.
    - `ensurePtyHost with a target never connects to another version's host` (two fake answering hosts).
    - `ensurePtyHost without a target connects to the newest running host`.
    - `removeUnusedPtyVersions keeps a folder a versioned host runs from`.
    - Update the existing `readDiscovery`, `reachPtyHost`, `forgetExitedHost` and `removeUnusedPtyVersions` cases to
      the instance signatures.
  - `terminalRuntime.spec.ts`: `sessionForPaneId accepts p2-0.4.21-dev.win1:%7 and p2-h0123456789ab:%7`.
  - Add the same case to each other parser's spec.
- [ ] **Step 2: Run.**
  - Run: `cd cli && npx vitest run src/lib/ptyHost src/lib/terminalRuntime.spec.ts`.
  - Expected: FAIL on the new cases.
- [ ] **Step 3: Implement** to the signatures above. `client.ts` keeps speaking the protocol its discovery file names.
- [ ] **Step 4: Run.**
  - Run the same command, plus `npx tsc --noEmit -p .`.
  - Expected: PASS. Fix every type error the signature changes cause in their callers (G2.2 and G2.3 own the
    behaviour; here only compile).
- [ ] **Step 5: Commit** `feat(cli): find pty hosts by instance and pick the installed build as the target`.

### Task G2.2: Create on the target, drain the rest

**Files:**
- Modify: `cli/src/lib/ptyHostBackend.ts`, `cli/src/lib/ptyHost/drain.ts`, `cli/src/core/main.ts` (around
  `prepareTerminalBackends`).
- Tests: `drain.spec.ts`, `ptyHostBackend.spec.ts`.

**Interfaces:**
- Consumes: G2.1.
- Produces:
  - `PtyHostBackendOptions` gains `instance?: string` (a drain backend's host) and `target?: PtyHostTarget | null`
    (the create backend's). `protocol` goes.
  - `draining` is `instance !== undefined`.
  - The drain backend's `instance` is set from the option before it is reached, as `p${protocol}` is today.
  - `PtyHostBackend.mayShutDown: boolean`. It is false when there is no target, or when the drain host's discovery
    `version` is newer than the target's (`compareVersions > 0`) and the target's `source` is `binary`. A newer host
    with an `installed` target is a downgrade or a rollback (spec §2): it drains and shuts down like any other.
  - `ptyHostBackends(home, { target, rowsOn, rowInstances })`:
    - the create backend is the target's;
    - there is one drain backend per discovered instance other than the target, with a supported protocol;
    - there is also one per `rowInstances()` instance with no discovery file, so its rows go gone as today.
  - `rowInstances: () => string[]` returns the `ptyhost:` instances named by registry rows.
  - `PtyHostDrain.step()` skips `shutdownHost` for a backend whose `mayShutDown` is false. Its panes stay reachable.
- Main: the target is computed when the core starts (`targetHost()`), and logged as
  `[terminal] ptyhost: target <instance>` or `[terminal] ptyhost: target unknown`.

- [ ] **Step 1: Write the failing tests.**
  - `drain.spec.ts`:
    - `an older version's host of the same protocol drains`.
    - `a legacy p2 host drains`.
    - `a newer host drains and shuts down under an installed target` (a rollback).
    - `a newer host is reached but never shut down under a binary target`.
    - `rows on an instance with no discovery get a drain backend`.
    - `an empty older host is shut down after EMPTY_PASSES and its folder removed`.
    - `a newer host's folder is never removed`.
  - `ptyHostBackend.spec.ts`:
    - `the create backend never makes a pane on a non-target host`.
    - `a drain backend refuses create`, which is today's behaviour, now by instance.
- [ ] **Step 2: Run.** `cd cli && npx vitest run src/lib/ptyHost src/lib/ptyHostBackend.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `main.ts`, pass `target` and `rowInstances`. Everything else around
  `prepareTerminalBackends` is unchanged.
- [ ] **Step 4: Run.**
  - Unit: the same command.
  - Real: `cd pty && cargo +stable build`, then
    `cd cli && HARNESS_PTY_BIN=$(pwd)/../pty/target/debug/harness-pty npx vitest run src/lib/ptyHost/drain.spec.ts src/lib/ptyHostBackend.restart.spec.ts`.
    The drain spec's `HARNESS_PTY_BIN_PREV` case now means "the previous version", built as in G5.1.
  - Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): new panes go to the installed pty host build; others drain`.

### Task G2.3: Uninstall ends every instance

**Files:** `cli/src/lib/uninstall/ptyHosts.ts`, `ptyHosts.spec.ts`.

**Interfaces:**
- Consumes: G2.1's `listDiscoveries`, `reachPtyHost(home, instance)` and `discoveredHostDead`.
- Produces: `PtyHostEnd` keyed by `instance`; `deps.reach(instance)`; `written` keyed by instance.

- [ ] **Step 1: Write the failing test.** `ends a legacy and two versioned hosts of one protocol in one home`: three
  fake discoveries; each is reached and ended once.
- [ ] **Step 2: Run.** `cd cli && npx vitest run src/lib/uninstall/ptyHosts.spec.ts`. Expected: FAIL. Two hosts of one
  protocol collide.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** The same command. Expected: PASS.
- [ ] **Step 5: Commit** `fix(cli): uninstall ends every pty host instance`.

---

## Phase G3: Delivery (spec §5)

### Task G3.1: Check, download, verify, unpack, canary

**Files:** Create `cli/src/lib/windows/ptyPayload.ts`, `ptyPayload.spec.ts`. Tested on every OS; nothing in it calls a
Windows API.

**Interfaces:**
- Consumes: `fetchManifest`, `downloadVerified`, `shouldAutoUpdate`, `isLocalDevBuild`, `DigestMismatchError` and the
  limits from `selfUpdate.ts`; `binaryVersion` from G2.1; `currentPtyVersion` from `launch.ts`.
- Produces:
  - `ptyManifestUrl(cliManifestUrl: string): string`. It throws when the URL does not end in `cli/metadata.json`.
  - `ptyPlatformKey(arch: string = process.arch): 'win32-x64' | 'win32-arm64' | null`.
  - `PTY_PAYLOAD_FILES: readonly string[]`.
  - `interface PtyEntry { version: string; url: string; sha256: string; size: number }`.
  - `fetchPtyEntry(url: string, key: string, limits?): Promise<PtyEntry | null>`.
  - `ptyUpdateWanted(entry: PtyEntry, installed: { pty: string | null; cli: string }, rejected: readonly string[]):
    boolean`. It is false for a dev CLI, a version not newer than `pty`, or a rejected one. A missing `pty` counts as
    older than anything.
  - `interface PreparedPty { version: string; staging: string; protocol: number; features: string[] }`.
  - `preparePtyPayload(entry: PtyEntry, runtimeDir: string, deps?: { download; unzip; probe }):
    Promise<PreparedPty>`. Steps:
    1. download and verify;
    2. unzip into `<runtimeDir>/pty/.staging-<pid>-<ms>`;
    3. require exactly the six files;
    4. run the canary of the Global Constraints.

    Any failure removes the staging folder and throws `PtyPayloadRefused` with a reason. A digest mismatch is wrapped
    too.
  - `unzip` on Windows is `tar.exe -xf` (the bsdtar Windows ships), as `install.ps1`'s `Expand-HarnessZip` falls back
    to; elsewhere `unzip -q`, for tests.

- [ ] **Step 1: Write the failing tests.** Use a zip built in the test from fake files, a fake `download`, and a
  fake `probe` that returns the version lines.
  - `ptyManifestUrl swaps the last two segments`, and `throws on any other url`.
  - `ptyPlatformKey maps x64 and arm64, and nothing else`.
  - `ptyUpdateWanted`: `newer is wanted`; `same and older are not`; `a dev CLI never updates`;
    `a rejected version is not`; `no installed pty wants any`.
  - `preparePtyPayload`:
    - `a good zip is unpacked into a staging folder`;
    - `a digest mismatch is refused and leaves nothing`;
    - `a missing or extra file is refused`;
    - `a host that names another version is refused`;
    - `an unsupported protocol is refused`;
    - `a serial binary that names another version is refused`;
    - `a canary that hangs past 5 s is refused`.
- [ ] **Step 2: Run.** `cd cli && npx vitest run src/lib/windows/ptyPayload.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** The same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): fetch, verify and canary a promoted pty payload`.

### Task G3.2: Install under the lock, undo, and roll back

**Files:** Create `cli/src/lib/windows/ptyInstall.ts`, `ptyInstall.spec.ts`, `ptyInstall.windows.real.spec.ts`.

**Interfaces:**
- Consumes: G3.1's `PreparedPty`; `writePointer`, `readPointer` and `harnessLaunchPath` from `installLayout.ts`.
- Produces:
  - `installPreparedPty(prepared: PreparedPty, rootDir: string, fs?: PtyInstallFs): void`. The caller holds the
    spawn lock. In order:
    1. rename the staging folder to `<runtime>/pty/<version>/`. If that folder exists, compare its six files byte for
       byte with the staging folder's. Equal: delete the staging folder and use it. Different: throw
       `PtyPayloadRefused`;
    2. for `harness.exe`, then `harness-launch.exe`, in `<root>\bin\`: rename the old one aside, copy the new one in
       through a temporary name and a rename, so the path never stands empty;
    3. write `pty-pending.json` `{ version, previous }`;
    4. `writePointer(<runtime>/pty, 'current-pty', version)`.

    A failure at any step undoes the ones before it: the aside files go back, `pty-pending.json` is removed, and the
    pointer is left as it was. Then it throws.
  - `restorePty(rootDir: string): boolean`. With a `pty-pending.json`:
    - point `current-pty` back at `previous`;
    - copy `previous`'s `harness.exe` and `harness-launch.exe` back into `bin\`, the same rename-aside way;
    - add `version` to `pty-rejected.json` and remove the marker.

    It returns whether it restored anything. The version folder stays (spec §3).
  - `confirmPty(rootDir: string): void`. It removes `pty-pending.json`.
  - `rejectedPtyVersions(rootDir: string): string[]`.
  - `sweepAsideFiles(rootDir: string): number`. It deletes `bin\*.old-*` files it can, and returns how many are left.

- [ ] **Step 1: Write the failing tests.**
  - `ptyInstall.spec.ts`, with a temp root and an injectable `fs` for the failure cases:
    - `installs: folder, bin files, marker, pointer`;
    - `a failure at each step leaves the bin files, the marker and the pointer as they were`, one case per step;
    - `an existing version folder is reused only when it matches`, and `refused when it differs`;
    - `restorePty puts the pointer and the bin files back, rejects the version, and keeps the folder`;
    - `restorePty with no marker changes nothing`;
    - `confirmPty removes the marker`;
    - `sweepAsideFiles deletes what it can`.
  - `ptyInstall.windows.real.spec.ts`, run only on win32:
    - `bin files are replaced while copies of them run, and a reader never finds the path missing`:
      1. start a copy of `bin\harness.exe` that waits;
      2. poll the path every millisecond on another worker during the install;
      3. check the poll never saw it missing;
      4. check the new bytes are in place;
      5. check `sweepAsideFiles` deletes the aside file once the copy exits.
- [ ] **Step 2: Run.** `cd cli && npx vitest run src/lib/windows/ptyInstall.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** The same command. Expected: PASS. The real spec runs on Windows CI in G5.1.
- [ ] **Step 5: Commit** `feat(cli): install a pty payload beside the old one, undoably, and roll it back`.

### Task G3.3: The poller, one handover, probation

**Files:**
- Create: `cli/src/lib/windows/ptyUpdate.ts`, `ptyUpdate.spec.ts`.
- Modify:
  - `cli/src/services/updaterProcess.ts`;
  - `cli/src/harnessd/protocol.ts` (`UpdaterMessage` and its guard);
  - `cli/src/harnessd/supervisor.ts` (`updateStaged`);
  - the master's `restoreUpdate` and confirm wiring (`grep -n 'restoreUpdate\|confirm(' cli/src/harnessd`);
  - `cli/src/lib/selfUpdate.ts` (`startSelfUpdater` gains `beforeStage`).
- Tests: `ptyUpdate.spec.ts`, `updaterProcess.spec.ts`, `protocol.spec.ts` (harnessd), `supervisor.spec.ts`,
  `selfUpdate.spec.ts`.

**Interfaces:**
- Consumes: G3.1, G3.2; `withSpawnLock`, `SpawnLockBusyError`.
- Produces:
  - `startPtyUpdater(opts: { url: string; key: string; rootDir: string; intervalMs: number; slotSecond?: number;
    installedCli: () => string; withLock; onStaged: (ptyVersion: string) => void | Promise<void>; deps? }): Poller &
    { readyToStage(): Promise<string | null> }`.
    - It has the CLI poller's shape: scheduled ticks, a download outside the lock, `refuse` back-off, and a re-check
      under the lock that `current-pty` is still older (another installer may have moved it).
    - On its own it installs under the lock and calls `onStaged(version)`.
    - `readyToStage()`, under a lock the caller already holds, installs a payload already prepared and returns its
      version, or returns null. That is how the CLI poller takes the PTY first in one handover.
  - `startSelfUpdater` gains `beforeStage?: () => Promise<string | null>`, called under the lock right before `stage`.
    `onStaged` gains a second argument `ptyVersion: string | null`.
  - `UpdaterMessage` becomes `{ type: 'harnessd:staged'; version?: string; ptyVersion?: string }`. The guard
    accepts any message with at least one non-empty string.
  - `Supervisor.updateStaged(staged: { version?: string; ptyVersion?: string })`. The same hand-over and probation;
    the log line names both.
  - The master's restore runs `selfUpdate.restore` only when a CLI build is pending, and `restorePty` whenever
    `pty-pending.json` exists. Its keep runs `confirm` and `confirmPty`.
  - `updaterProcess.ts`, on win32 only: `sweepAsideFiles` at start, and the PTY poller beside `startCli` and
    `startHn`. A staging of either exits with `SERVICE_EXIT_RESTART`, as today. The next run checks both again.
  - Log lines, in the CLI's words (`[update]`), each said once per version:
    - `[update] newer terminal host available: <a> → <b>`;
    - `[update] staged terminal host <b> — handing over`;
    - `[update] terminal host <b> <reason> — not trying it again for <wait>`.

    The master logs a rollback as `[harnessd] terminal host <b> did not come back healthy — back to <a>`. Nothing
    reaches any client.

- [ ] **Step 1: Write the failing tests.**
  - `ptyUpdate.spec.ts`:
    - `a newer entry is installed under the lock and onStaged gets its version`;
    - `a pointer that moved past it while downloading stages nothing`;
    - `a refused payload backs off`;
    - `a busy lock retries the install next tick without downloading again`;
    - `readyToStage installs a prepared payload, and returns null when there is none`.
  - `selfUpdate.spec.ts`: `beforeStage runs under the lock before stage, and its version reaches onStaged`.
  - `updaterProcess.spec.ts`:
    - `a PTY-only staging tells the master ptyVersion alone, and the next run checks the CLI`;
    - `CLI and PTY in one check send one message with both`.
  - harnessd `protocol.spec.ts`: the guard accepts `{ptyVersion}`, `{version}` and both; it refuses neither.
  - `supervisor.spec.ts`:
    - `a PTY-only staging hands over and goes on probation`;
    - `a failed probation with only a PTY pending restores the PTY and not the CLI`;
    - `a kept probation confirms both`.
- [ ] **Step 2: Run.**
  - Run: `cd cli && npx vitest run src/lib/windows/ptyUpdate.spec.ts src/lib/selfUpdate.spec.ts src/services/updaterProcess.spec.ts src/harnessd`.
  - Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** The same command and `npx tsc --noEmit -p .`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): the Windows updater installs promoted pty payloads, on the master's probation`.

### Task G3.4: The protocol rule, and `harness update`

**Files:**
- Modify: `cli/src/cli.ts` (`version --json`; the `update` command), `cli/src/lib/selfUpdate.ts` (`runCanary`,
  `startSelfUpdater`).
- Modify: `cli/src/lib/ptyHost/protocol.spec.ts`, `docs/superpowers/specs/2026-10-16-windows-native-cli-design.md`
  (self-update item 6).
- Tests: `selfUpdate.spec.ts`, `cliCommand.spec.ts` (or the spec that covers `version`), an update-command spec
  (`grep -ln "Already on the latest" cli/src`).

**Interfaces:**
- Produces:
  - `harness version --json` prints `{"version":VERSION,"ptyProtocol":PTY_PROTOCOL}`. `harness version` is unchanged.
  - `CanaryResult` gains `ptyProtocol: number`. The canary runs `cli.js version --json` and reads plain output as
    protocol 2.
  - `startSelfUpdater` gains `installedPtyProtocol?: () => number | null` (win32: `binaryVersion` of the
    `current-pty` host). A canaried build whose `ptyProtocol` is above it is not staged, and the updater logs once
    per version: `[update] <v> needs pty protocol <n>; this machine's host speaks <m> — waiting for its payload`.
    The bytes stay verified for the next tick.
  - `harness update` on win32:
    - also installs a newer promoted payload (G3.1, G3.2) under its lock, before the CLI;
    - with the CLI current and only the PTY newer, it installs the PTY and restarts the daemon instead of
      "Already on the latest version";
    - it ignores `pty-rejected.json`, as it ignores the CLI's rejected versions.

- [ ] **Step 1: Write the failing tests.**
  - `version --json prints the version and the pty protocol`.
  - `selfUpdate.spec.ts`:
    - `a build needing a newer pty protocol waits, then stages once the host has it`;
    - `plain version output counts as protocol 2`.
  - The update-command spec:
    - `harness update installs a newer pty payload when the CLI is current`;
    - `harness update installs a rejected pty version anyway`.
  - `protocol.spec.ts`: replace "keeps the protocol that installed Windows hosts speak" with
    `a CLI needing a protocol above the installed host's waits (the delivery rule replaces the pin)`, a pointer test
    to the `selfUpdate.spec.ts` case above that asserts `PTY_PROTOCOL` is in `SUPPORTED_PTY_PROTOCOLS`.
- [ ] **Step 2: Run.** `cd cli && npx vitest run src/lib/selfUpdate.spec.ts src/lib/ptyHost/protocol.spec.ts` and
  the update and version specs. Expected: FAIL.
- [ ] **Step 3: Implement.** Update item 6 of the B spec: the payload now updates with the CLI (G), and a protocol
  bump is safe under the delivery rule.
- [ ] **Step 4: Run.** The same commands and `npx tsc --noEmit -p .`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): a CLI waits for the pty protocol it needs, and harness update installs the payload`.

### Task G3.5: `install.ps1` restarts when only the PTY moved

**Files:** `cli/scripts/install.ps1` (`Restart-HarnessDaemon` and its caller), `cli/src/scripts/installPs1.spec.ts`.

**Interfaces:**
- `Restart-HarnessDaemon` gains `-PtyBefore` and `-PtyAfter`. It restarts when the CLI version or the
  `current-pty` version changed. Its line reads `Moving the running Harness to terminal host <PtyAfter> (your agents
  keep running)...` when only the PTY changed.
- **Ruling against spec §5 "Other installers":** `install.ps1` does not take the daemon spawn lock. The lock's
  liveness proof (`processLiveness.ts`) is Node-only. The race is covered by both sides instead:
  - `install.ps1` already unpacks into its own staging folder and moves the pointer atomically;
  - the updater re-reads `current-pty` under its lock before it installs (G3.3);
  - an existing version folder is reused only when it matches (G3.2).

  The cost if wrong: an `install.ps1` run and an updater install in the same second could both restart the daemon.
- `install.ps1` does not read `pty-rejected.json`: an explicit install installs.

- [ ] **Step 1: Write the failing test** in `installPs1.spec.ts`, in the existing restart cases' style:
  `a PTY-only change restarts the daemon`, and `no change in either does not`.
- [ ] **Step 2: Run.** `cd cli && npx vitest run src/scripts/installPs1.spec.ts`. Expected: FAIL. On macOS the
  PowerShell cases run under `pwsh` when it is present, as today.
- [ ] **Step 3: Implement.** The script stays pure ASCII.
- [ ] **Step 4: Run.** The same command. Expected: PASS. Windows CI runs it in G5.1.
- [ ] **Step 5: Commit** `fix(windows): install.ps1 restarts the daemon when only the terminal host changed`.

---

## Phase G4: Moving agents unnoticed

### Task G4.1: Who is looking

**Files:**
- Modify: `desktop/lib/state/app_state.dart` (the `app_focus` send), `desktop/lib/super_tabs/workspace.dart`.
- Modify: `cli/src/localWsServer.ts` (the `app_focus` handler), `cli/src/backendSocket.ts` (`setLocalTerminalFocus`),
  `cli/src/lib/terminalStreamManager.ts`, `cli/src/core/terminalWatch.ts`.
- Tests: `desktop/test/app_focus_visible_agents_test.dart` (new), `cli/src/lib/terminalStreamManager.spec.ts`,
  `cli/src/localWsServer.spec.ts`.

**Interfaces:**
- Produces (wire): the `app_focus` payload gains `visibleAgents?: string[]`.
  - It holds the ids of every agent whose tile is on screen in that window.
  - It is `[]` while the window is minimized or hidden to the tray.
  - The desktop sends it whenever the set changes: tab switch, layout change, minimize, restore, hide or show.
- Produces (TS):
  - `TerminalStreamManager.setVisibleAgents(connId: string, agentIds: readonly string[] | null): void`, where null
    means the window has never sent the list.
  - `TerminalStreamManager.isLookedAt(agentId: string): boolean`. A stream opened with `watch: true` (`watchOnly`)
    never counts. Otherwise it is true when any non-closing stream for the agent is:
    - from a loopback connection whose visible list is null;
    - from a loopback connection whose visible list contains the agent;
    - from any non-loopback connection, the phone pager's `takeover: false` neighbours included.
  - `TerminalWatch.isWatched(agentId: string): boolean`, for Share viewers.
  - `BackendSocket.setLocalTerminalFocus(connId, agentId, visibleAgents?)`.
- Consumes: the existing `app_focus` handling and `setFocusedAgent`. Those stay as they are.

- [ ] **Step 1: Write the failing tests.**
  - TS:
    - `a loopback stream whose window lists other agents is not looked at`.
    - `a loopback stream whose window never sent a list is looked at`.
    - `a mobile or web stream is looked at, a takeover:false one included`.
    - `a watch:true stream is never looked at`.
    - `a minimized window's empty list frees its agents`.
    - `closing the connection forgets its list`.
    - In `localWsServer`: `app_focus with visibleAgents reaches setLocalTerminalFocus`.
  - Desktop:
    - `app_focus carries the on-screen tiles`: two super tabs, only the active tab's tiles are listed.
    - `minimizing sends an empty list`.
- [ ] **Step 2: Run.**
  - Run: `cd cli && npx vitest run src/lib/terminalStreamManager.spec.ts src/localWsServer.spec.ts`, and
    `cd desktop && flutter test test/app_focus_visible_agents_test.dart`.
  - Expected: FAIL.
- [ ] **Step 3: Implement.** The desktop derives the list from the active super tab's mounted, non-`Offstage` tiles
  and the window's visibility state.
- [ ] **Step 4: Run.** The same commands. Expected: PASS.
- [ ] **Step 5: Commit** `feat: the desktop tells its daemon which terminals are on screen`.

### Task G4.2: Quiet clocks

**Files:** `cli/src/lib/hostMove/quiet.ts` (new), `quiet.spec.ts`. Wire it in G4.6.

**Interfaces:**
- Produces `class QuietClock`, constructed with `{ now: () => number }`:
  - `noteInput(agentId: string): void`.
  - `noteActivity(agentId: string, state: ActivityState): void`. It records `idleSince` the first time it sees `idle`
    after anything else, and clears it on `working` or `unknown`.
  - `quietFor(agentId: string): number`. It is `now - max(idleSince, lastInput)`, or 0 when not idle.
  - `forget(agentId: string): void`.
- Fed from:
  - the core's `onInput` (`grep -n 'onInput' cli/src/core/main.ts`);
  - the `SessionInputController` submit paths (a `harness send` is input);
  - the mover's own tick, which reads `turnActivity.snapshot(sessionId)`.

- [ ] **Step 1: Write the failing tests.**
  - `idle without input for QUIET_MS is quiet`.
  - `input resets quiet`.
  - `working or unknown is never quiet`.
  - `idle seen again after working restarts the clock`.
- [ ] **Step 2: Run.** `cd cli && npx vitest run src/lib/hostMove/quiet.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** The same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): track how long an agent has been idle and untouched`.

### Task G4.3: Seeded create, and a seed from a capture

**Files:** `cli/src/lib/terminalTypes.ts`, `cli/src/lib/ptyHostBackend.ts` (`create`), `cli/src/lib/hostMove/seed.ts`
(new). Tests: `seed.spec.ts`, `ptyHostBackend.spec.ts`.

**Interfaces:**
- Produces:
  - `TerminalCreateRequest.seed?: string`. Only the ptyhost backend uses it; tmux ignores it.
  - `PtyHostBackend.create` sends `seed` when `client.features` includes `SEED_FEATURE`. It refuses with
    `not_started` ("this host cannot seed a pane") when a seed is given to a host without it.
  - `PtyHostBackend.canSeed: boolean`, from the connected host's features.
  - `seedFromCapture(text: string, maxBytes = SEED_MAX_BYTES): string`. It normalises line ends to `\r\n` and drops
    whole lines from the top until it fits.
- Consumes: the coordinator's `capture(session, { historyLines: SEED_HISTORY_LINES, ansi: true })` on the old pane.

- [ ] **Step 1: Write the failing tests.**
  - `seed.spec.ts`:
    - `keeps every line under the cap`.
    - `drops the oldest lines first`.
    - `uses CRLF`.
  - `ptyHostBackend.spec.ts`:
    - `create passes the seed to a host with the seed feature`.
    - `create refuses a seed for a host without it`.
- [ ] **Step 2: Run.** `cd cli && npx vitest run src/lib/hostMove/seed.spec.ts src/lib/ptyHostBackend.spec.ts`. Expected:
  FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** The same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): open a pty pane seeded with another pane's scrollback`.

### Task G4.4: The move gate, and streams that follow

**Files:**
- Create: `cli/src/lib/hostMove/gate.ts`.
- Modify: `cli/src/lib/terminalStreamManager.ts` (the input frame path that ends in `tookInput`; stream open; stream
  retarget), `cli/src/lib/sessionInput.ts` (`SessionInputController` submit paths).
- Tests: `gate.spec.ts`, `terminalStreamManager.spec.ts`, `sessionInput.spec.ts`.

**Interfaces:**
- Produces `class MoveGate`:
  - `hold(agentId: string): void`.
  - `holding(agentId: string): boolean`.
  - `enqueue(agentId: string, deliver: () => Promise<void>): void`. It queues in arrival order.
  - `whenOpen(agentId: string): Promise<void>`. It resolves at release.
  - `release(agentId: string): Promise<void>`. It runs the queue in order, after the row's runtime has switched (or
    fallen back), so each `deliver` reaches the row's current pane.
- Produces `TerminalStreamManager.retarget(agentId: string, to: TerminalRuntimeRef): Promise<void>`.
  - Every open stream of the agent, of any kind, is re-subscribed on `to` on the daemon's side. The client's
    connection and stream id stay.
  - What the client receives next uses the existing frames: the new pane's output, and the stream's existing resync
    path if the frame sequence needs one.
  - No new frame type, and no close.
- Behaviour:
  - While the gate holds an agent, a stream input frame for it becomes an `enqueue` of a raw write to the row's
    runtime. That uses the backend's raw input op: ptyhost `write`, adding `TerminalBackend.writeInput?(runtime,
    bytes)` if no such method exists.
  - A `SessionInputController` submission is enqueued as itself.
  - A stream open waits `whenOpen`, then opens on the row's current runtime.
  - A held agent counts as looked at from the moment input or an open arrives. The mover reads that through
    `isLookedAt` on its next tick; it does not cancel a swap already past the stop of the old engine.

- [ ] **Step 1: Write the failing tests.**
  - `input during a hold is delivered once, in order, after release`.
  - `a harness send during a hold is delivered after release`.
  - `a stream opened during a hold opens on the new runtime`.
  - `an open stream follows a retarget with no close, and gets the new pane's output`.
  - `nothing is held for other agents`.
- [ ] **Step 2: Run.**
  - Run: `cd cli && npx vitest run src/lib/hostMove/gate.spec.ts src/lib/terminalStreamManager.spec.ts src/lib/sessionInput.spec.ts`.
  - Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** The same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): hold an agent's input while it changes host, and move its open streams`.

### Task G4.5: One move

**Files:** `cli/src/lib/hostMove/moveAgent.ts` (new), `moveAgent.spec.ts`. Dependency-injected like `restartAgent.ts`.

**Interfaces:**
- Produces:
  - `type MoveOutcome = { moved: true; resumed: boolean } | { moved: false; reason: string; fellBack: boolean }`.
  - `moveAgent(session: RegisteredSession, deps: MoveAgentDeps): Promise<MoveOutcome>`.
  - `MOVE_MARKER_ENV = 'HARNESS_MOVE_OF'`.
  - `removeOrphanMovePanes(backends: TerminalBackend[], rows: RegisteredSession[]): Promise<number>`, run once at
    core start, before discovery.
- `MoveAgentDeps`:
  - `capture(session): Promise<string | null>`;
  - `createSeeded(session, seed: string): Promise<{ ok: true; runtime } | { ok: false; reason }>`. It calls the create
    backend's `create` with `seed`, `hold: true`, the waiting-shell argv restore uses (`waitingLaunch` in
    `core/main.ts`), the row's cwd, and `HARNESS_MOVE_OF=<agentId>`;
  - `respawn(runtime, launch: RestoreLaunch): Promise<{ ok: boolean; reason?: string }>`. It is the backend's
    `respawn` with the launch's argv, cwd and env, as `restoreTerminals.ts` does, and keeps the pane's scrollback;
  - `buildLaunch: RestoreAgentsDeps['buildLaunch']`, from `core/agents/restoreLaunch.ts` `createRestoreLaunch`,
    shared and not copied;
  - `stopEngine(session): Promise<TerminateOutcome>`; the old pane is kept, as `paneSwapDeps` `terminate` does
    (`core/agents/swap.ts`);
  - `probeProcess(runtime, engine): Promise<ProcessIdentity | null>`, polled until `MOVE_TIMEOUT_MS`;
  - `swap(agentId, runtime, identity): void`. In one `registry.transaction` it calls
    `updateRuntimes(agentId, [runtime], terminalRouteKey(runtime))` and `updateProcessIdentity`, then announces the
    session as a restart does;
  - `retarget(agentId, runtime)`: G4.4's;
  - `killPane(runtime)`;
  - `relaunchOld(session): Promise<boolean>`; `restartAgent` in the old pane, with resume;
  - `gate: MoveGate`;
  - `holdRoute` and `releaseRoute`, for both routes for the whole move;
  - `current(): boolean`;
  - `log(message)`.
- Order (spec §4). Two engines never hold one conversation at once:
  1. capture;
  2. buildLaunch;
  3. createSeeded (the new pane waits, with no engine);
  4. `gate.hold`;
  5. stopEngine (old);
  6. respawn (new) with the launch;
  7. probe (new);
  8. swap, then retarget;
  9. killPane (old);
  10. `gate.release`.

  A failure at 1–3 changes nothing, apart from killing a pane step 3 made. From step 4 on, a failure kills the new
  pane, runs `relaunchOld` if step 5 ran, and then releases the gate.

- [ ] **Step 1: Write the failing tests.**
  - `moves an idle conversation agent and keeps its id`.
  - `capture_failure_changes_nothing`.
  - `a refused create changes nothing`.
  - `a new engine that never appears falls back to the old pane`.
  - `open streams are retargeted after the swap, never before`.
  - `the gate is released on every path`.
  - `a_move_pane_left_by_a_dead_daemon_is_removed_before_discovery`.
  - `a cancelled move (current() false) before step 5 changes nothing`.
- [ ] **Step 2: Run.** `cd cli && npx vitest run src/lib/hostMove/moveAgent.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** The same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): move one agent to another pty host, falling back to its old pane`.

### Task G4.6: The mover, and the wiring

**Files:**
- Create: `cli/src/lib/hostMove/mover.ts`.
- Modify `cli/src/core/main.ts`:
  - after `ptyDrain.step()` in `onReconciled`;
  - the `onInput`;
  - before restore and discovery at start, for `removeOrphanMovePanes`.
- Tests: `mover.spec.ts`.

**Interfaces:**
- Produces `class HostMover`, built with
  `{ list, isDrainRow(row), targetCanSeed(), resumesConversation, activity(row), quiet: QuietClock, lookedAt(agentId),
  busy(agentId), move(row), now, log }`:
  - `step(): Promise<void>`. It does nothing while `targetCanSeed()` is false. At most one move is in flight. It picks
    the oldest-quiet candidate that meets every condition in spec §4.
  - Each row has at most one failed move per core start (`failed: Set<string>`).
- Wiring:
  - `busy` is `restartJobs.busy(id) || stopJobs.has(id) || restorePanes.busy(id) || pinnedControls.has(id)`.
  - `move` runs inside `restartJobs.run(agentId, …, 'move')`.
  - `lookedAt` is `terminalStreams.isLookedAt(id) || terminalWatch.isWatched(id)`.
  - `isDrainRow` is true when the row's runtime instance is a drain backend's: older hosts, and a newer one after a
    downgrade or rollback.
  - `targetCanSeed` is the create backend's `canSeed`.
- Logs: `[terminal] move <agentId>: moved (resumed|fresh)`, `skipped (<reason>)` and `failed (<reason>)`. The skipped
  line is logged once per reason change, not every tick. One line, once per core start, when the target cannot seed:
  `[terminal] ptyhost: target <instance> cannot seed; agents stay on their hosts`.

- [ ] **Step 1: Write the failing tests.** One per condition:
  - `a working agent is not moved`.
  - `unknown activity is not moved`.
  - `input within QUIET_MS blocks`.
  - `a looked-at agent is not moved`.
  - `a terminal is never moved`.
  - `a fresh engine is never moved`.
  - `no session id is never moved`.
  - `a busy agent is not moved`.
  - `one at a time`.
  - `a failed agent is not retried until restart`.
  - `an agent on the target host is never a candidate`.
  - `nothing moves while the target cannot seed`.
  - `an agent on a newer host moves after a rollback`.
- [ ] **Step 2: Run.** `cd cli && npx vitest run src/lib/hostMove/mover.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement, and wire it in `main.ts`.**
- [ ] **Step 4: Run.**
  - Run: `cd cli && npx vitest run src/lib/hostMove src/lib/ptyHost src/lib/windows src/lib/terminalStreamManager.spec.ts src/lib/sessionInput.spec.ts && npx tsc --noEmit -p .`.
  - Run the coverage gates the change touches (AGENTS.md): `npm run test:core`, `npm run test:resume`,
    `npm run test:harnessd`.
  - Expected: PASS. A red test in a suite with known base failures is compared by name against a clean worktree of
    `main`. The documented base failures are 3 `searchProcess` tests in `test:core` and 2 `sessionRepair` tests in
    `test:resume`.
- [ ] **Step 5: Commit** `feat(cli): move idle, unwatched agents to the installed pty host`.

---

## Phase G5: Proof

### Task G5.1: Two real builds on Windows CI

**Files:** `cli/src/lib/hostMove/hostMove.real.spec.ts` (new), `.github/workflows/windows.yml`.

**Interfaces:**
- Consumes everything above.
- `HARNESS_PTY_BIN` is the new build. The old build is the same source built with `HARNESS_PTY_VERSION=0.0.1`: a
  number, because it names its version folder under `<runtime>/pty/` as an install's does (`VERSION_DIR`). The TS
  specs read it as `HARNESS_PTY_BIN_PREV` (the drain spec's name), the Rust `two_versions_serve_side_by_side` as
  `HARNESS_PTY_BIN_OLD`. Build the old one first, copy it aside, then build the new one: the env change recompiles
  only the crate.

- [ ] **Step 1: Write the real spec**, run only when both env vars are set. Use a temp home and a stand-in engine
  that resumes: a script that prints its argv and waits for input. Cases:
  - `a pane on the old host keeps streaming and taking input while a new pane opens on the new host`;
  - `a moved pane's history holds the old pane's lines`;
  - `the old host shuts down after its last pane goes, and its version folder is removed`;
  - `input sent during the swap arrives in the new pane`.
- [ ] **Step 2: Run locally first** (the fast loop; Windows CI is the proof).
  - Run: `cd pty && HARNESS_PTY_VERSION=0.0.1 cargo +stable build && cp target/debug/harness-pty <scratch>/harness-pty-old && cargo +stable build`.
  - Then: `cd cli && HARNESS_PTY_BIN=$(pwd)/../pty/target/debug/harness-pty HARNESS_PTY_BIN_PREV=<the copy> npx vitest run src/lib/hostMove/hostMove.real.spec.ts src/lib/ptyHost/drain.spec.ts`.
  - Expected: PASS.
- [ ] **Step 3: Windows CI.**
  - In `windows.yml`'s `windows-pty` job, after the Rust tests:
    - add the old build to the same target, run `two_versions_serve_side_by_side` with it (`HARNESS_PTY_BIN_OLD`),
      and run the real spec with both binaries;
    - run `src/lib/windows/ptyInstall.windows.real.spec.ts` and `src/scripts/installPs1.spec.ts`.
  - `windows.yml` runs on demand: push the branch once, then `gh workflow run windows.yml --ref feat/windows-pty-rollover`
    with `release=false`. Watch it on x64 and arm64: `gh run watch <run> --exit-status`.
  - Expected: both pass, and the vitest output names the real cases (not skipped).
- [ ] **Step 4: Commit** `test(windows): pty host rollover and payload install against real builds`, and record the
  run link in the ledger.

### Task G5.2: The VM and the x64 PC, the way a person updates; status

**Files:** `docs/testing/pty-rollover-e2e.md` (new), the spec's status line and Known limits.

- [ ] **Step 1: Delivery, on the ARM64 VM and on the x64 test PC,** with the owner's OK and only when each is free.
  Use a throwaway standard user on the VM; on the PC, touch only what G installs.
  1. Build N and N+1 of the branch: CLI and PTY payload, non-dev versions (`0.4.<n>-e2e.1`).
  2. Serve N from the fake HTTPS CDN (`fake-cdn.sh` + `vm-cdn.ps1`, as B5.13 did) and install it with `install.ps1`.
  3. Serve a PTY manifest naming N+1. Check that within one update check, with no `install.ps1`:
     - `current-pty` names N+1;
     - `bin\harness.exe` and `bin\harness-launch.exe` are N+1's;
     - the daemon log shows the handover.
  4. On the x64 PC: the dial on COM3 is found through N+1's `harness-serial.exe`.
  5. Serve an N+2 payload with a wrong digest: it is refused, and nothing changes.
  6. Serve a CLI N+2 that needs protocol 3 (a test build with `PTY_PROTOCOL` raised): it waits, and the daemon log
     says so.
- [ ] **Step 2: Rollover, on the ARM64 VM.** These are the spec's Testing steps:
  1. on N, start a claude agent, a codex agent and a terminal;
  2. let the updater install N+1's payload;
  3. check that a new agent opens on the new host;
  4. keep one tile on screen, put one in another super tab, and minimize;
  5. wait out `QUIET_MS`. Check that:
     - the off-screen agents moved, with the same ids, their scrollback and resumed conversations;
     - the on-screen one did not move;
     - the terminal was not touched;
  6. close the terminal. Check that the old host exits and its folder is deleted;
  7. repeat steps 2–3 once with an `install.ps1` update instead of the updater.
- [ ] **Step 3: Record** each item as passed, failed, or not run with the reason, in
  `docs/testing/pty-rollover-e2e.md`. Leave no addresses, account names or ids in it.
- [ ] **Step 4: Clean up** the throwaway user, the fake CDN settings and everything G installed, on both machines.
- [ ] **Step 5: Update the spec:** `Status: implemented on feat/windows-pty-rollover; E2E in
  docs/testing/pty-rollover-e2e.md`, and one Known limits line for each limit found and not fixed.
- [ ] **Step 6: Commit** `docs: PTY host rollover and delivery E2E and status`.
