# Desktop test flavor Implementation Plan

> **For agentic workers:** this plan is implemented by its Engineer task by task, test first, by the project's
> instructions (test-driven-development; one independent review on the pull request). Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** One command builds a pull request's Desktop and CLI and starts them as "Harness Test" beside the installed
app, with its own home, port, daemon, tmux server, Keychain item and sign-in, and `stop` removes all of it.

**Architecture:** A Python tool (`desktop/tool/test_flavor.py`, like `tool/native_benchmark/isolation.py`) builds the
PR's CLI bundle into a `mktemp -d` test home, builds Desktop with one new define (`HARNESS_DAEMON_PORT`), copies the app
under the bundle id `ai.autonomous.harness.test` without the `harness://` scheme, and starts it with an environment that
moves every per-user resource Desktop and the CLI use (design, *How it is kept apart*). The test sign-in and computer id
live in `~/.harness-test`, reused across runs; a guard refuses the Mac owner's own account.

**Tech Stack:** Python 3 (stdlib only, unittest), Dart/Flutter 3.47.2 (one const in `desktop/lib/core/config.dart`), the
PR's own CLI bundle (`cli/build-bundle.mjs`, `BUNDLE_OUT_DIR`), PlistBuddy and codesign.

**Spec:** [docs/plans/2026-11-03-desktop-test-flavor-design.md](2026-11-03-desktop-test-flavor-design.md)

## Global Constraints

- Bundle id `ai.autonomous.harness.test`, name and executable "Harness Test"; no `CFBundleURLTypes`.
- Installed app unchanged: `HARNESS_DAEMON_PORT` defaults to 18473; no new setting, no change to Info.plist or xcconfigs.
- Environment of the test flavor (exact names): `HOME`, `PORT`, `TMUX_TMPDIR`, `CLAUDE_CONFIG_DIR`,
  `CLAUDE_SECURESTORAGE_CONFIG_DIR`, `CODEX_HOME`, `HARNESS_AUTH_DIR`, `ADAPTER_COMPUTER_ID_FILE`,
  `ADAPTER_UPDATE_DISABLE=1`.
- Test home: `mktemp -d` (`tempfile.mkdtemp(prefix='harness-test-flavor.')`); shared test state: `~/.harness-test/`
  (`auth/`, `computer-id`); run state: `desktop/build/test-flavor/state.json`.
- Never run the person's CLI; read `~/.harness/auth/session.json` only for its account identity; print no token.
- Stop only pids recorded in the run state; never by name or pattern.
- Same-account refusal copy: "The test copy signed in as this Mac's own account. Sign it in with the test account
  instead."
- macOS only; refuses elsewhere with "The Desktop test flavor runs on macOS."

## Review Focus

1. The person's CLI is mid-refresh when the guard reads `session.json`: the guard must read without taking the CLI's
   lock and treat an unreadable file as "unknown", refusing to proceed rather than guessing (task 4 test).
2. A previous run crashed and left a test daemon and a state file: `start` must refuse to start a second copy on that
   state, and `stop` must still clean it (task 5 test).
3. The chosen port is taken between `start` choosing it and the daemon binding it: the run fails with a plain message and
   cleans up, never falls back to 18473 (task 5 test).
4. The person runs the test copy's "Sign out": it must reach only `~/.harness-test/auth` (task 3 proof covers `logout`).
5. A `PORT` already set in the person's shell: the test environment overrides it, and the installed app never reads
   `PORT` (task 1 test: Desktop's port comes only from the define).

---

### Task 1: Desktop's daemon port comes from one build-time define

**Files:**
- Modify: `desktop/lib/core/config.dart`
- Test: `desktop/test/config_daemon_port_test.dart`

**Interfaces:**
- Produces: `const int localDaemonPort = int.fromEnvironment('HARNESS_DAEMON_PORT', defaultValue: 18473);`;
  `AppConfig`'s default `localCliBaseUrl` is `'http://127.0.0.1:$localDaemonPort'` (a const default cannot call a
  function, and a helper only tests would use is dead code by ENGINEERING.md §2).

- [ ] **Step 1: Write the failing test.** Without the define, `localDaemonPort == 18473` and
  `AppConfig.dev.localCliBaseUrl == 'http://127.0.0.1:18473'`; under `--dart-define=HARNESS_DAEMON_PORT=18999` the base
  URL follows it; a source check that `desktop/lib` has no other literal `18473`.
- [ ] **Step 2: Run** `flutter test test/config_daemon_port_test.dart` → FAIL (`localDaemonPort` not defined).
- [ ] **Step 3: Implement** the two declarations in `config.dart` and use them for the default.
- [ ] **Step 4: Run** the test → PASS; run `flutter analyze lib/core/config.dart`.
- [ ] **Step 5: Commit** (test first, then code).

### Task 2: The test flavor's environment and app identity

**Files:**
- Create: `desktop/tool/test_flavor.py`
- Test: `desktop/tool/test_test_flavor.py`

**Interfaces:**
- Produces:
  - `TEST_ID = 'ai.autonomous.harness.test'`, `TEST_NAME = 'Harness Test'`
  - `flavor_env(base: dict, test_home: Path, shared: Path, port: int) -> dict`, which returns `base` with every Global
    Constraints variable set (`HOME=test_home`, `TMUX_TMPDIR=test_home/'tmux'`, both Claude dirs
    `test_home/'.claude'`, `CODEX_HOME=test_home/'.codex'`, `HARNESS_AUTH_DIR=shared/'auth'`,
    `ADAPTER_COMPUTER_ID_FILE=shared/'computer-id'`, `PORT=str(port)`, `ADAPTER_UPDATE_DISABLE='1'`)
  - `patch_info(info: dict) -> dict`: bundle id, `CFBundleName`, `CFBundleDisplayName` and `CFBundleExecutable` set,
    `CFBundleURLTypes` removed
  - `claude_keychain_service(env: dict) -> str`: mirrors `cli/src/lib/agentCredentials.ts` `claudeKeychainService`

- [ ] **Step 1: Write the failing tests:**
  - `flavor_env` sets each variable to the exact value, overrides an existing `PORT`, and never returns a path inside
    the base `HOME`'s `.harness`;
  - `patch_info` on the repo's `desktop/macos/Runner/Info.plist` gives `TEST_ID` with no `CFBundleURLTypes`;
  - `claude_keychain_service(flavor_env(...))` is not `'Claude Code-credentials'`, and equals
    `'Claude Code-credentials-' + sha256(str(test_home/'.claude'))[:8]`.
- [ ] **Step 2: Run** `python3 -m unittest desktop/tool/test_test_flavor.py` → FAIL (module missing).
- [ ] **Step 3: Implement** the three functions and the constants.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.**

### Task 3: Proof: the PR's real CLI in the test environment leaves the real home untouched

**Files:**
- Create: `desktop/tool/test_test_flavor_isolation.py`

**Interfaces:**
- Consumes: `flavor_env` (task 2).
- Produces: `install_cli(cli_dir: Path, test_home: Path, node: Path) -> Path`, added to `test_flavor.py`. It runs
  `npm run bundle` with `BUNDLE_OUT_DIR=test_home/.harness/cli`, links node at `test_home/.harness/runtime/node`, writes
  that path to `runtime/current-node`, and returns the `cli.js` path.

- [ ] **Step 1: Write the failing test.** It runs in a `mktemp -d` root and never uses the real `HOME`:
  - Setup:
    - a fake real home holds `.harness/auth/session.json` (account `owner@example.com`),
      `.harness/desktop-app-v2/state.json` and `Library/LaunchAgents/ai.autonomous.harness.harnessd.plist`, and is set as
      `HOME` for the test;
    - fake `launchctl`, `security` and `open` on PATH append their argv to a log.
  - Run the PR's CLI with `flavor_env` on a free port and a closed backend URL (`BACKEND_WS_URL=ws://127.0.0.1:1`):
    `start`, `auth status --json`, `logout`, `stop`.
  - Assert:
    - every fake-real-home file is byte-identical (sha256 before and after);
    - the launchctl log is empty;
    - no `security` call names `Claude Code-credentials` without a suffix;
    - the daemon's pid file and socket are under the test home;
    - nothing listens on the test port after `stop`.
- [ ] **Step 2: Run** `python3 -m unittest desktop/tool/test_test_flavor_isolation.py` → FAIL (`install_cli` missing).
- [ ] **Step 3: Implement** `install_cli`.
- [ ] **Step 4: Run** → PASS. Record the run in the PR.
- [ ] **Step 5: Commit.**

### Task 4: The same-account guard

**Files:**
- Modify: `desktop/tool/test_flavor.py`
- Test: `desktop/tool/test_test_flavor.py`

**Interfaces:**
- Produces: `session_account(path: Path) -> str | None`, which reads the account email or id from a CLI
  `session.json`, or None when the file is missing or unreadable. Also
  `check_not_owner(real: str | None, test: str | None) -> None`, which raises `SameAccount` with the Global Constraints
  copy when they are equal or when `test` is None.

- [ ] **Step 1: Write the failing tests:**
  - the same email → `SameAccount` with the exact copy;
  - different emails pass;
  - an unreadable test session raises;
  - a missing real session (the person is not signed in) passes;
  - `session_account` never returns the token fields (a fixture with `accessToken` returns only the email).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** both, reading the field names the CLI writes (`cli/src/lib/authSession.ts`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.**

### Task 5: `start`, `status`, `stop` and `forget`

**Files:**
- Modify: `desktop/tool/test_flavor.py`
- Test: `desktop/tool/test_test_flavor.py`

**Interfaces:**
- Consumes: tasks 2–4.
- Produces: `main(argv: list[str]) -> int` with subcommands `start [--dry-run]`, `status`, `stop` and `forget`, plus a
  run state `{testHome, port, appPid, app}` in `desktop/build/test-flavor/state.json`.
  - `start`:
    1. refuses if a state file exists ("A test copy is already running; run stop first");
    2. picks a free port;
    3. builds the CLI into a new test home (`install_cli`);
    4. runs `desktop/scripts/build-macos-debug.sh --dart-define=HARNESS_DAEMON_PORT=<port>`;
    5. copies the app to `desktop/build/test-flavor/Harness Test.app`, applies `patch_info`, and re-signs;
    6. signs in with `login --code` when `~/.harness-test/auth` has no session;
    7. runs `check_not_owner`;
    8. launches `Contents/MacOS/Harness Test` with `flavor_env`;
    9. writes the state.
  - `stop`:
    1. quits the recorded pid;
    2. runs `harness stop` in the test environment;
    3. runs `tmux -S <test home>/tmux/tmux-<uid>/default kill-server`;
    4. removes the test home, the app copy and the state file;
    5. reports each step that failed.

- [ ] **Step 1: Write the failing tests.** `start --dry-run` and `stop` run with an injected command runner that
  records commands:
  - the build command carries `--dart-define=HARNESS_DAEMON_PORT=<port>`, not 18473;
  - the launch environment equals `flavor_env`;
  - a second `start` with a state file refuses;
  - `stop` on a crashed run's state (pid not alive) still removes the home and state and exits 0;
  - a port taken after it was chosen fails `start` with "Port <p> was taken; run start again", and the new home is
    removed;
  - `stop` never kills anything but the recorded pid.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `main` and the subcommands; `forget` signs the test account out in a throwaway test home and
  removes `~/.harness-test`.
- [ ] **Step 4: Run** all tool tests → PASS; run `python3 scripts/check-ui-style.py --only desktop/lib/super_tabs`.
- [ ] **Step 5: Commit.**

### Task 6: A Tester uses it once on a real PR

- [ ] A Tester in a person's own account on a Mac with Xcode, routed by the instructions, runs `start` on this PR's
  branch. It signs in with the test account, opens the Swarm screen, signs out, and runs `stop`. It shows the installed
  app's `~/.harness` hash and `harness auth status` before and after, unchanged, with screenshots of "Harness Test"
  beside "Harness".
