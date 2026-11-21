# Small fixes batch (2026-11-21): Implementation Plan

> **For agentic workers:** REQUIRED: implement this plan with devcrew phase 3, task by task. Steps use checkbox
> (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(<area>): <the task's message> (red)` once its
> failing tests have been run and seen to fail, then the task's own message. A task with no red test (no behavior
> change, or test-only with a deterministic repro) is one commit. No task pushes or merges, and every task ends green.

**Goal:** One pull request that removes a batch of flaky tests and small bugs at their causes (spec items 1-9 and
11-15; item 10 is already fixed on main by #4490), each with its red-then-green test or its deterministic repro.

**Architecture:**
- **Tests that raced a real clock run on a held one** (items 1, 6, 7, 11) or wait for the event itself (items 8, 13).
- **Two product bugs get one check each:** the desktop's spawn points read one `_spawnHeld()` (item 3); every Harness
  folder or file override means "relative to the home" in every process, through one `homePath` in
  `config/envFields.ts` (item 15).
- **Windows stops paying for what it does not need:** one process-table reader on every OS (item 14), PowerShell
  modules imported by path with autoload off (item 9), a held pane that ends on the console's close and a pane-start
  deadline sized to the host's own waits (item 12).
- **Slow specs lose the work that made them slow:** one started Node per test run (item 4, measured first), one shell
  per spec file and no flush for a rebuilt file (item 5), and no two `flutter test` runs in one folder (item 2).

**Tech Stack:** TypeScript on Node 24 (vitest, unit and `vitest.e2e.config.ts`), Dart/Flutter (`flutter_test`,
`fake_async`), Python 3 (`unittest`), Rust (`cargo test`, pty host), Windows PowerShell 5.1. No new dependency.

**Spec:** `docs/plans/2026-11-21-small-fixes-batch-design.md`. Read it with this plan, the root `AGENTS.md`,
`cli/AGENTS.md` (Protect the core, Rules), `desktop/AGENTS.md`, `docs/windows-rules.md` (items 9, 12, 14) and
`docs/validation-and-release.md`.

## Base

- `fix/small-fixes-batch-1121` at `58f93696d9` (`origin/main`). The spec and this plan are untracked; the main session
  commits them, no task does.
- Line numbers are the base's. A task follows the expression it names when a line has moved, and says so in its report.
- Once per checkout: `cd cli && npm ci`, `cd companions && npm ci`, `cd desktop && flutter pub get`. Every `cli`
  command below runs from `cli/` unless it says otherwise.

## Tasks at a glance

| Task | Files (tests included) | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 (item 1) Terminal input tests on a held clock; the unreachable 64 KiB split goes | `desktop/test/terminal_session_test.dart`, `desktop/lib/terminal/terminal_session.dart` | none | high | test-only: deterministic repro (busy-wait injection), not committed |
| 2 (item 3) `ensureRunning` spawns nothing while uninstall holds its marker | `desktop/lib/ws/local_cli_discovery.dart`, `desktop/test/local_cli_discovery_test.dart` | none | high | `local_cli_discovery_test.dart`, the uninstall cases |
| 3 (item 2) Two `flutter test` checks in one folder never run at once | `scripts/validate-change.py`, `scripts/tests/test_validate_change.py` | none | high | `test_two_flutter_tests_in_one_folder_never_overlap` |
| 4 (item 4) One started Node per run, linked by `placeNode` (measured first) | `cli/src/testing/placeNode.ts`, `cli/src/testing/placeNode.spec.ts`, `cli/src/testing/testNode.ts`, `cli/src/testing/testNode.spec.ts`, `cli/src/__fixtures__/vitestRun.ts`, `cli/src/config/vitestRun.spec.ts`, `cli/src/lib/selfUpdate.spec.ts`, `cli/src/harnessd/master.spec.ts` (comments only), `cli/e2e/developerState.e2e.ts`, `cli/e2e/deviceDialSkill.e2e.ts` | none (open question Q1) | xhigh | `placeNode.spec.ts` "a placed Node is the run's started Node" |
| 5 (item 5) dsh writes its files through `atomicWriteFile`; CONTEXT.md as cache | `cli/src/dsh/runtime.ts`, `cli/src/dsh/runtime.spec.ts` | none | high | `runtime.spec.ts`, the write-kind case |
| 6 (item 5) dsh specs make their test shell once per file | `cli/src/dsh/install.spec.ts`, `cli/src/dsh/update.spec.ts` | none | medium | none: no behavior change, numbers before and after |
| 7 (item 6) The registry deadline helper; the four copies use it | `cli/src/testing/registryDeadline.ts` (new), `cli/src/testing/registryDeadline.spec.ts` (new), `cli/src/lib/registryPersistence.ts`, `cli/src/lib/registry.spec.ts`, `cli/src/lib/registry.binding.spec.ts`, `cli/src/lib/registry.homes.spec.ts`, `cli/src/lib/registryAdmission.golden.spec.ts` | none | high | `registryDeadline.spec.ts` |
| 8 (item 6) Seven registry specs hold the deadline | `cli/src/lib/registry.{diskFailure,externalResume,fingerprint,firstTask,hermesHome,launchCallers,launchIdentity}.spec.ts` | 7 | high | the seven, with the slow-sync disk and no hold |
| 9 (item 6) Seven more registry specs hold the deadline | `cli/src/lib/registry.{namesCost,openclawLocal,persistence,persistenceCost,quarantine,admission,hookPersistence}.spec.ts` | 7 | high | the seven, with the slow-sync disk and no hold |
| 10 (item 7) The recall deadline runs on an injected clock | `companions/src/memory/runtime.ts`, `companions/src/memory/runtime.spec.ts` | none | medium | `runtime.spec.ts`, the deadline case |
| 11 (item 8) e2e daemons are ready once their hooks are installed | `cli/e2e/harness/daemon.ts`, `cli/e2e/hookclient.e2e.ts` | none | high | test-only: deterministic repro (delayed install), not committed |
| 12 (item 11) cableFleet's drop waits on a held `Date` | `cli/src/cable/cableFleet.spec.ts` | none | medium | test-only: deterministic repro (injected delay), not committed |
| 13 (item 13) The orphan socket closes after its second answer | `cli/e2e/twodaemons.e2e.ts` | none | medium | test-only: deterministic repro (3.5 s delay), not committed |
| 14 (item 14) `processRows()` reads Windows' table on win32 | `cli/src/lib/processTable.ts`, `cli/src/lib/processTable.rows.spec.ts` (new), `cli/src/lib/uninstall/ptyHosts.ts`, `cli/src/lib/uninstall/ptyHosts.spec.ts` | none | xhigh | `processTable.rows.spec.ts` |
| 15 (item 14) VS Code terminals and app models read `processRows()` | `cli/src/cable/hosts/vscodeTerminals.ts`, `cli/src/cable/hosts/vscodeTerminals.spec.ts`, `cli/src/lib/appModels.ts`, `cli/src/lib/appModels.spec.ts` | 14 | high | both specs, the Windows cases |
| 16 (item 14) The hook's lock marker runs no `ps` on win32 | `cli/hook/notify.mjs`, `cli/src/lib/processLiveness.spec.ts` | none | medium | `processLiveness.spec.ts`, the Windows case for the hook |
| 17 (item 14) Resource samples and foreground checks answer unknown on win32 | `cli/src/lib/harnessResources.ts`, `cli/src/lib/harnessResources.spec.ts`, `cli/src/lib/externalOwnerControl.ts`, `cli/src/lib/externalOwnerControl.spec.ts` | none | xhigh | both specs, the Windows cases |
| 18 (item 14) Search's tty/cwd reads and the native probes answer unknown on win32 | `cli/src/lib/sessionSearch/externals/support.ts`, `cli/src/lib/sessionSearch/externals/support.spec.ts`, `cli/src/engines/kit/nativeEvidence.ts`, `cli/src/engines/kit/nativeEvidence.spec.ts` | none | xhigh | both specs, the Windows cases |
| 19 (item 9) PowerShell scripts import their modules by path, autoload off | `cli/src/lib/windows/powershell.ts`, `cli/src/lib/windows/powershellModules.spec.ts` (new), `cli/src/lib/peerAccount.ts`, `cli/src/lib/windows/storePackage.ts`, `cli/src/lib/windows/guestScript.ts`, `cli/src/team/windowsRemoveScript.ts`, `cli/src/lib/signOut.ts`, `cli/src/lib/uninstall/removal.ts`, `cli/src/lib/windows/ptySignatures.ts`, `cli/src/lib/uninstall/windowsPath.ts`, `cli/src/engines/kit/windowsInstall.ts`, `docs/windows-rules.md` | none | xhigh | `powershellModules.spec.ts` |
| 20 (item 12a) The Windows held pane ends on the console's close | `cli/src/lib/windows/engineStart.ts`, `cli/src/lib/windows/engineStart.spec.ts`, `cli/src/lib/ptyHostBackend.restart.spec.ts`, `docs/windows-rules.md` | none | xhigh | `engineStart.spec.ts` hangup case; the restart contract case on Windows |
| 21 (item 12b) `create` and `respawn` get a 15 s deadline | `cli/src/lib/ptyHost/client.ts`, `cli/src/lib/ptyHost/client.spec.ts` | none | xhigh | `client.spec.ts`, the pane-start deadline cases |
| 22 (item 12c) The host logs how long each create and respawn took | `pty/src/panes.rs` | none | high | `panes.rs` test `took_line_names_the_op_and_its_milliseconds` |
| 23 (item 15) `homePath`, the path fields, the env file reader, the docs | `cli/src/config/envFields.ts`, `cli/src/config/envFields.spec.ts`, `cli/src/config/loadEnv.ts`, `cli/src/config/loadEnv.spec.ts`, `cli/src/config/env.ts`, `cli/src/config/env.spec.ts`, `cli/src/homeMove/conditions.ts`, `cli/src/homeMove/conditions.spec.ts`, `cli/src/lib/daemonState.pidFile.spec.ts`, `docs/cli.md`, `docs/development.md`, `cli/README.md` | none | xhigh | `envFields.spec.ts`, `loadEnv.spec.ts`, `env.spec.ts`, `conditions.spec.ts`, `daemonState.pidFile.spec.ts` |
| 24 (item 15) Every other reader of the overrides goes through `homePath` | `cli/src/lib/authSession.ts`, `cli/src/lib/authSession.spec.ts`, `cli/src/lib/secureState.ts`, `cli/src/lib/secureState.spec.ts`, `cli/src/lib/homeDataFolder.ts`, `cli/src/lib/homeDataFolder.spec.ts`, `cli/src/homeMove/start.ts`, `cli/src/homeMove/start.spec.ts`, `cli/src/tui/index.ts`, `cli/src/tui/index.spec.ts`, `cli/src/lib/connectors/store.ts`, `cli/src/lib/connectors/store.spec.ts` (new unless one exists), `cli/src/lib/flasherDir.ts`, `cli/src/lib/flasherDir.spec.ts` (new) | 23 | xhigh | each reader's relative-value case |
| 25 (item 15) The hook's readers of the overrides | `cli/hook/notify.mjs`, `cli/src/hookNotify.spec.ts` | 23 | high | `hookNotify.spec.ts`, the relative routes case |

Longest chain of dependent tasks: two (7 → 8, 7 → 9, 14 → 15, 23 → 24, 23 → 25). Files shared by tasks that do not
depend on each other, so devcrew runs them one after the other: `cli/hook/notify.mjs` (16 and 25) and
`docs/windows-rules.md` (19 and 20). Task 4 waits for the answer to open question Q1 before its Step 4.

## Global Constraints

- Each fix removes the cause: no test is loosened, no timeout is raised as the fix, no fixed sleep is added, nothing is
  rerun to green (spec, Intent). Item 12's per-op deadline is sized from the host's own waits, not raised to pass a test.
- "A fix covers every case of the same cause": each task covers the sibling cases the spec names.
- No new feature, setting, screen or copy. `cli/src/architecture.coreFiles.txt` gains no file: a helper the core
  loads goes into a file the core already loads (spec, Non-goals; `cli/AGENTS.md` Protect the core, rule 6).
- Tests use held clocks, injected delays or events. A temporary repro injection is never committed.
- Comments say why and name the incident or measurement (`cli/AGENTS.md` Rules 7). Docs and comments in English.
- New log lines (item 12c) carry no content and no identifiers: the op's name and milliseconds only (AGENTS rule 7).
- Tests never touch the developer's own daemon (port 18473), homes, `~/.claude`, `~/.codex` or tmux server
  (`cli/AGENTS.md` Rules 6): isolated daemons (`IsolatedDaemon`), throwaway homes.
- Heavy GitHub runs (`cli-e2e.yml`, `windows.yml`) and the shared Windows ARM VM only on harness-pm's go, one at a time.
- Platforms: macOS, Linux, Windows x64 and ARM64 (CLI); macOS, Windows, Linux (Desktop). Windows rules:
  `docs/windows-rules.md`; a new Windows rule is added there in the same change as its fix.
- Out of scope: the other fixed sleeps in `cli/e2e/twodaemons.e2e.ts` (12 s, 6 s), the companions git-backed lesson
  specs, the boot-screen copy while `harness uninstall` holds its marker.

## Decided here, where the spec left it to the builder

- **Task split and order:** as the table above. Item 6 is split by file sets after its helper; item 14 by caller kind.
- **Item 1:** `kInputFrameMaxBytes` becomes `8 * 1024`, the buffer's own size (it flushes at it), documented as below
  the daemon's 64 KiB `INPUT_MAX_BYTES`; `_flushInput` sends one frame. No caller can reach the 64 KiB loop: the only
  writer of `_inputBytes` is `_onTerminalOutput` (`terminal_session.dart:1404-1408`), which flushes at 8 KiB, and
  `_flushInput` copies and clears the buffer before its first `await`.
- **Item 4 names:** `copyNode` (today's copy, for a process that must be told apart by its file, and for the run's
  started copies) and `placeNode` (a hard link of the run's started copy); the provided key is `startedNode`.
- **Item 6 helper API:** in Task 7's Interfaces. The helper imports only `vitest`: a spec loads it through
  `vi.hoisted`, before `node:fs/promises` is mocked, so it must not load `registryPersistence.ts` (which would bind the
  real `fs/promises`); specs pass it `REGISTRY_WRITE_DEADLINE_MS`.
- **Item 9 helper:** `modulesByPath(...)` in `lib/windows/powershell.ts`.
- **Item 12a's contract bound** is the host's 2 s respawn grace (`RESPAWN_GRACE`, `pty/src/panes.rs`), not the spec's
  1 s: old behavior is ≥ 2 s by construction, so 2 s separates old from new deterministically, and 1 s would add only
  load sensitivity on the arm64 runner. The test prints the measured time for the PR.
- **Item 15:** the helper lives in `config/envFields.ts` (already a core file), not a new `config/` file. An empty value
  (`ADAPTER_DATA_DIR=`) is unset, as `env.ts:77,87` already read it, so no override can make the home itself the
  folder. Same cause, so covered too: `HARNESS_CONNECTIONS_DIR` (`lib/connectors/store.ts:67`), `HARNESS_FLASHER_CACHE`
  (`lib/flasherDir.ts:9`) (both in `homeMove/conditions.ts` `OVERRIDE_NAMES`), and the hook's own readers
  (`hook/notify.mjs:166, 1292, 1530`), which run in the engine's process with the project as their folder.
  `config/startHome.ts:26` only prints the raw value and needs no change.

## Review Focus

1. **An empty override** (`ADAPTER_DATA_DIR=` in an env file) must never turn the home itself into the data folder;
   expected: the default location. Test: Task 23, `envFields.spec.ts` `homeRelative(...)('')` and `homePath('')`.
2. **A daemon whose hook install fails or meets a malformed file** must still count as started, or every e2e daemon
   started on a broken file on purpose (`enginehomes.e2e.ts`) waits 60 s and fails. Expected: any install outcome line
   ends the wait. Test: Task 11 runs `enginehomes.e2e.ts` and `eagerHooks.e2e.ts` green.
3. **A script with autoload off that calls a Management or Utility cmdlet it did not import** (`Join-Path`,
   `Select-Object`) fails with "not recognized". Expected: the static spec names it before Windows does. Test: Task 19,
   `powershellModules.spec.ts` rejects an unknown cmdlet and requires those modules where used.
4. **The Windows held pane** must still survive a person's Ctrl-C and Ctrl-Break once it stops ignoring hangup.
   Test: Task 20 keeps `engineStart.spec.ts` "keeps waiting through an interrupt" and `engineStart.real.spec.ts` (Ctrl-C,
   on `windows.yml`) green.
5. **The person's instruction file** (a workspace `AGENTS.md` or `CLAUDE.md`) keeps its own mode, and one that is a
   symlink is still refused, once dsh writes through `atomicWriteFile`. Test: Task 5's mode and symlink cases.

---

### Task 1 (item 1): Terminal input tests on a held clock; the unreachable 64 KiB split goes

**Files:**
- Modify: `desktop/test/terminal_session_test.dart` (helper beside `tick` at `:1290`; the tests holding the waits at
  `:385`, `:389`, `:403`, `:429`, `:431`, `:446`, `:474`, `:797`, `:802`, `:885`, `:899`, `:915`, `:917`, `:933`, `:949`,
  `:951`, `:953`, `:965`, `:968`, `:978`, `:990`, `:1022`, `:1037`)
- Modify: `desktop/lib/terminal/terminal_session.dart:1404-1408, 1461-1490, 1594-1596`

**Depends on:** none. **Effort:** high. **Red:** test-only, deterministic repro (not committed); the loop's removal
changes no behavior. One commit.

- [ ] **Step 1: Reproduce the race on the old test (temporary).** In "input larger than the daemon accepts is split,
  never refused", replace `await Future<void>.delayed(const Duration(milliseconds: 12));` with:

```dart
final wait = Future<void>.delayed(const Duration(milliseconds: 12));
final busy = Stopwatch()..start();
while (busy.elapsedMilliseconds < 20) {} // both timers are due when the loop next runs, as on a loaded host
await wait;
```

  Run `cd desktop && flutter test --no-pub test/terminal_session_test.dart --plain-name 'input larger than the daemon'`
  ten times. Expected: it reads 65536, not 70000. If it never fails, use the spec's repro instead (24 CPU hogs:
  `for i in $(seq 24); do yes > /dev/null & done`, kill them after) and record the red rate. Keep the injection for
  Step 4, then remove it.

- [ ] **Step 2: Add the clock helper** beside `tick`:

```dart
/// Moves the input clock and fakeAsync's timers together, so the 4 ms coalesce window
/// (`_inputCoalesceWindow`) runs on the test's clock, never the host's.
void elapse(FakeAsync async, Duration by) {
  controlledNow = controlledNow!.add(by);
  async.elapse(by);
}
```

- [ ] **Step 3: Convert every test that waits on the input timer** (the 23 `Duration(milliseconds: 12)` waits listed
  above, and the 1 ms and 8 ms waits inside those same tests, `:421`, `:458`, `:883`, `:892`) to
  `fakeAsync((async) { controlledNow = DateTime(2026, 9, 18); ... })`, as `:2144` does: `ready(); async.flushMicrotasks();`,
  each `session.handleBinary(...)` followed by `async.flushMicrotasks()`, and `elapse(async, const Duration(milliseconds: 4))`
  where the test waited for the window. A 1 ms wait that checks the leading edge becomes `async.flushMicrotasks()`. A
  30 ms or 70 ms wait on another timer inside a converted test elapses that span on the fake clock; such waits in other
  tests stay (out of scope). Assertions do not change.

- [ ] **Step 4: Remove the 64 KiB loop.** In `_flushInput`, send `bytes` as one frame (the guards and the slow-send
  log stay as they are). `kInputFrameMaxBytes = 8 * 1024`, documented: the most one input frame carries, the size the
  buffer flushes at, below the daemon's 64 KiB `INPUT_MAX_BYTES` (`cli/src/lib/terminalStreamManager.ts:102`). The two
  `8 * 1024` literals in `_onTerminalOutput` and the test's at `:446` use it. Rename the test at `:1029` to
  "input larger than one frame goes out as several, in order, every byte once" and correct its comment: it proves a
  70,000-byte burst goes out as frames of at most `kInputFrameMaxBytes`, seq in order, totalling 70,000.

- [ ] **Step 5: Run.** The Step 1 injection on the converted test: passes 10 of 10. Then remove the injection and run
  `flutter test --no-pub test/terminal_session_test.dart` (all green), the same 30 times under the 24 hogs (0 red, the
  spec measured 0 of 150), and `flutter analyze lib/terminal/terminal_session.dart test/terminal_session_test.dart`
  (no issues).

- [ ] **Step 6: Commit** `fix(desktop): terminal input tests run on a held clock; the unreachable 64 KiB split goes`,
  with the repro's red rate and the loaded run's count in the message body.

### Task 2 (item 3): `ensureRunning` spawns nothing while uninstall holds its marker

**Files:**
- Modify: `desktop/lib/ws/local_cli_discovery.dart:294-340, 452-463`
- Test: `desktop/test/local_cli_discovery_test.dart` (beside `:686-730`, with `_SupervisionProbe`)

**Depends on:** none. **Effort:** high.

- [ ] **Step 1: Write the failing tests**, each under `fakeAsync` with `monotonicClock: () => async.elapsed`:
  - `ensureRunning spawns nothing while harness uninstall holds its marker`: `readProbe` down, `uninstalling: () => true`;
    result state `down`, `spawnCount == 0` (today 1).
  - `ensureRunning spawns nothing while a dial is being flashed`: the same with `flashing: () => true` (the missing case;
    passes today).
  - `ensureRunning does not fall back to a spawn when the daemon goes down mid-wait while uninstall holds its marker`:
    probes `notReady` then `down`, `uninstalling: () => true`, elapse 1 s; result `down`, `spawnCount == 0` (today 1).
  - The same mid-wait case for flashing (passes today).
- [ ] **Step 2: Run** `cd desktop && flutter test --no-pub test/local_cli_discovery_test.dart`. Expected: the two
  uninstall cases FAIL with `spawnCount` 1.
- [ ] **Step 3: Implement `bool _spawnHeld() => _flashing() || _uninstalling();`** with one doc comment carrying both
  reasons (the dial's port belongs to esptool; `harness uninstall` is removing the daemon's files, and on Windows a new
  daemon holds them). Use it at both spawn points (`:303`, `:327`) and in place of the two checks at `:458-463`.
- [ ] **Step 4: Run** the file again (all green) and `flutter analyze lib/ws/local_cli_discovery.dart test/local_cli_discovery_test.dart`.
- [ ] **Step 5: Commit** `test(desktop): ensureRunning spawns nothing while uninstall holds its marker (red)`, then
  `fix(desktop): ensureRunning spawns nothing while uninstall holds its marker`.

### Task 3 (item 2): Two `flutter test` checks in one folder never run at once

**Files:**
- Modify: `scripts/validate-change.py:234-301` (`run_checks`)
- Test: `scripts/tests/test_validate_change.py`

**Depends on:** none. **Effort:** high.

- [ ] **Step 1: Write the failing test `test_two_flutter_tests_in_one_folder_never_overlap`.** A fake program named
  `flutter` (a Python script with `#!{sys.executable}`, mode 0o755, in `self.root / "tools"`), run as
  `[str(tool), "test", name]` with `cwd: "app"` (made in the fixture), does: create `.harness/flutter-running` with
  `O_EXCL` (exists: write `.harness/overlap` and exit 3), then poll every 0.02 s until `.harness/go` exists, remove
  `flutter-running`, exit 0. Plan: two such checks (`first`, `second`), then a plain check `other` that polls until
  `.harness/flutter-running` exists and writes `.harness/go`. `run_plan` with the default `--jobs 2`. Assert: receipt
  `passed`, all three `passed`, no `.harness/overlap`, and `second`'s `started_at` not before `first`'s `finished_at`.
  (`other` running beside `first` is the proof that other checks still run in parallel.)
- [ ] **Step 2: Run** `python3 -m unittest scripts.tests.test_validate_change -k flutter -v` from the repo root (or
  `python3 scripts/tests/test_validate_change.py ValidationTests.test_two_flutter_tests_in_one_folder_never_overlap`).
  Expected: FAIL, `second` exits 3.
- [ ] **Step 3: Implement.** A check is a `flutter test` when `Path(argv[0]).name in ("flutter", "flutter.bat")` and
  `argv[1:2] == ["test"]`; its folder is `(root / check.get("cwd", ".")).resolve()`. The start loop takes the first
  pending check that is not a `flutter test` in a folder an active `flutter test` holds, keeping the others' order; when
  none can start it waits on the existing 0.05 s poll. The comment names the outside cause: flutter_tools' fixed
  `build/unit_test_assets`, shared impellerc outputs, a silent Vulkan-only fallback and an mtime-only rebuild check left
  `ink_sparkle.frag` Vulkan-only and 84 files failing (Flutter 3.47.5).
- [ ] **Step 4: Run** the whole file (`python3 -m unittest discover -s scripts/tests -p 'test_validate_change.py' -v`)
  and `python3 -m unittest discover -s scripts/tests -p 'test_desktop_tests.py'`: all green.
- [ ] **Step 5: Commit** `test(scripts): two flutter test checks in one folder never run at once (red)`, then
  `fix(scripts): two flutter test checks in one folder never run at once`.

### Task 4 (item 4): One started Node per run, linked by `placeNode` (measured first)

**Files:**
- Modify: `cli/src/testing/placeNode.ts`, `cli/src/testing/testNode.ts`, `cli/src/__fixtures__/vitestRun.ts`,
  `cli/src/lib/selfUpdate.spec.ts:1624-1632`, `cli/e2e/developerState.e2e.ts:330, 359`, `cli/e2e/deviceDialSkill.e2e.ts:140`,
  `cli/src/harnessd/master.spec.ts` (only a comment that names a per-call copy)
- Test: `cli/src/testing/placeNode.spec.ts`, `cli/src/testing/testNode.spec.ts`, `cli/src/config/vitestRun.spec.ts`

**Depends on:** none (Q1 answered: (a)). **Effort:** xhigh (every unit run's setup; one inode across
tests; #4395).

**Interfaces:**
- Produces: `copyNode(path: string, runFrom?: string[], machine?: Machine): void` (today's `placeNode` body: refuse
  Rosetta, clone, chmod, link libnode beside each folder); `placeNode(path: string, runFrom?: string[], machine?: Machine): void`
  (refuse Rosetta, `linkSync(inject('startedNode'), path)`, libnode links as today); `ProvidedContext.startedNode: string`.

- [ ] **Step 1: Measure before** on this Mac: `npx vitest run src/harnessd/master.spec.ts` alone three times, and twice
  beside a full `npx vitest run` in another terminal (the loaded case); and `npx vitest run src/config/envFields.spec.ts`
  three times (what every run's setup costs). Record each Duration.
- [ ] **Step 2: Prototype and measure after** (uncommitted): Steps 4-5 below in the working tree, then Step 1 again.
  If master.spec is not faster in the loaded case, stop: restore the tree, report both sets of numbers, land nothing
  for item 4 (decision). Also report what the setup adds to the one-spec run.
- [ ] **Step 3: Write the failing test** in `placeNode.spec.ts`: "a placed Node is the run's started Node":
  `placeNode(node)`; `statSync(node).ino === statSync(inject('startedNode')).ino`, and
  `statSync(node).ino !== statSync(realpathSync(process.execPath)).ino`. Run `npx vitest run src/testing/placeNode.spec.ts`:
  FAIL (a copy has its own inode).
- [ ] **Step 4: Implement** (Q1 = (a): on a Node with a `libnode` beside it, the run makes no started copy and provides `''`-like "copy per call", and `placeNode` copies as today, the same way the Rosetta case is handled; a test covers that branch):
  - `copyNode`: today's `placeNode`. Used by `setUpTestNode` (`testNode.ts`), by the unit setup below, and by the e2e
    callers (`developerState.e2e.ts`, `deviceDialSkill.e2e.ts`), whose `codex` process is told apart by the file the
    kernel ran (`lsof -c codex`), so it keeps a file of its own.
  - `placeNode`: `refuseRosettaNode(machine)`, then link the provided copy; with no `startedNode` it throws
    `placeNode needs src/__fixtures__/vitestRun.ts as the run's globalSetup, which starts the run's Node`.
  - `vitestRun.ts` `startRun`: after `beginRun`, `copyNode(join(root, 'node', 'bin', basename(process.execPath)))`,
    `firstStart` it (from `testNode.ts`), `project.provide('startedNode', node)`. On a Node Rosetta runs, it makes no
    copy and provides `''`, so `placeNode` still refuses by name. The e2e pool (`e2e/harness/testNode.ts`) is unchanged.
  - `selfUpdate.spec.ts`: drop `firstStart(node)` and its import; its comment says the copies are links of the run's
    started Node.
  - `placeNode.ts` comments: a link costs as much as a copy only under Rosetta (its translation cache is per path);
    on native arm64 the first-run check is per file (recon: a fresh copy's first start 2.1 s under load, a link of a
    started copy 0.05 s, even from another folder). The Rosetta cases of `placeNode.spec.ts` cover both functions.
- [ ] **Step 5: Run** `npx vitest run src/testing src/config/vitestRun.spec.ts src/harnessd/master.spec.ts src/harnessd/processName.spec.ts src/lib/selfUpdate.spec.ts`
  (green), then the last three five times in a row (the `process.execPath` and process-name assertions must hold with
  one inode across tests).
- [ ] **Step 6: Measure after** (Step 1 again) and put both sets in the commit body.
- [ ] **Step 7: Commit** `test(cli): a placed Node is the run's started Node (red)`, then
  `fix(cli): the unit run starts one copy of its Node, and placeNode links it`.

### Task 5 (item 5): dsh writes its files through `atomicWriteFile`; CONTEXT.md as cache

**Files:**
- Modify: `cli/src/dsh/runtime.ts:110-120, 152, 181, 291, 294`
- Test: `cli/src/dsh/runtime.spec.ts` (describe "runtime validation and file ownership")

**Depends on:** none. **Effort:** high.

- [ ] **Step 1: Measure before:** `npx vitest run src/dsh/portability.integration.spec.ts` three times; record.
- [ ] **Step 2: Write the failing test** "writes CONTEXT.md as a rebuilt file, and runtime.json and the instruction
  file durably": `vi.mock('../lib/secureState.js', ...)` wraps the real `atomicWriteFile` in a `vi.fn`; after a launch's
  runtime is made: called with `(contextFile, any, 'cache', objectContaining({ durable: false }))`,
  `(runtimeJson, any, 'cache', objectContaining({ durable: true }))`, `(instructionFile, any, 'cache', objectContaining({ durable: true }))`.
  Guards beside it (green before and after): an instruction file at 0o644 keeps 0o644; a symlinked one is refused with
  `Refusing to replace a symlink`.
- [ ] **Step 3: Run** `npx vitest run src/dsh/runtime.spec.ts`: the write-kind case FAILS (no `atomicWriteFile` call).
- [ ] **Step 4: Implement `writeManagedFile(path: string, body: string, durable: boolean): void`.** It keeps its two
  guards (refuses a symlink; keeps the file's mode, 0o600 for a new one) and writes through
  `atomicWriteFile(path, body, 'cache', { mode, durable })`; its own open/write/fsync/rename goes. `:152` and `:181`
  (the person's instruction file) and `:294` (runtime.json) pass `true`; `:291` (CONTEXT.md, rewritten at every launch,
  restore and fork) passes `false`. The comment says why CONTEXT.md needs no flush.
- [ ] **Step 5: Run** `npx vitest run src/dsh src/lib/stateWrites.guard.spec.ts` (green), `npm run test:portability`,
  and Step 1 again; record after.
- [ ] **Step 6: Commit** `test(cli): dsh writes CONTEXT.md as a rebuilt file (red)`, then
  `fix(cli): dsh writes its files through atomicWriteFile, CONTEXT.md without a flush`, numbers in the body.

### Task 6 (item 5): dsh specs make their test shell once per file

**Files:** Modify `cli/src/dsh/install.spec.ts:16-23`, `cli/src/dsh/update.spec.ts:66-80`.

**Depends on:** none. **Effort:** medium. **Red:** none, no behavior change. One commit.

- [ ] **Step 1: Measure before:** `npx vitest run src/dsh/install.spec.ts` and `src/dsh/update.spec.ts`, three times each.
- [ ] **Step 2: Change both files:** a `beforeAll` writes `test-shell` once into a folder of its own and runs it once
  (`execFileSync(shell, ['-c', 'true'])`: the one first-exec check); `beforeEach` only `vi.stubEnv('SHELL', shell)` (the
  `afterEach`'s `vi.unstubAllEnvs()` stays); an `afterAll` removes the folder. In `update.spec.ts` the shell leaves the
  per-test `root`.
- [ ] **Step 3: Run** both specs (green) and Step 1 again.
- [ ] **Step 4: Commit** `test(cli): dsh specs write and start their test shell once per file`, numbers in the body.

### Task 7 (item 6): The registry deadline helper; the four copies use it

**Files:**
- Create: `cli/src/testing/registryDeadline.ts`, `cli/src/testing/registryDeadline.spec.ts`
- Modify: `cli/src/lib/registryPersistence.ts:15, 64, 71, 101`; `cli/src/lib/registry.spec.ts`,
  `cli/src/lib/registry.binding.spec.ts`, `cli/src/lib/registry.homes.spec.ts`, `cli/src/lib/registryAdmission.golden.spec.ts`
  (each loses its ~25-line copy)

**Depends on:** none. **Effort:** high.

**Interfaces:**
- Produces:

```ts
// lib/registryPersistence.ts: REQUEST_MS renamed and exported, every use follows
export const REGISTRY_WRITE_DEADLINE_MS = 5_000
// testing/registryDeadline.ts: imports only vitest
export function slowSyncFsPromises(
  original: () => Promise<typeof import('node:fs/promises')>,
  options?: { afterSync?: (path: string, actual: typeof import('node:fs/promises')) => Promise<void> },
): Promise<typeof import('node:fs/promises')>
export function holdRegistryDeadline(deadlineMs: number, options?: { hold?: readonly number[] }): {
  expire(): void          // runs every held deadline timer's callback
  fire(ms: number): void  // runs every held timer of [ms] (one listed in hold)
}
```

  A spec uses it as:

```ts
vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => 0 } }))
const deadline = await vi.hoisted(() => import('../testing/registryDeadline.js'))
vi.mock('node:fs/promises', original => deadline.slowSyncFsPromises(original))
beforeEach(() => { deadline.holdRegistryDeadline(REGISTRY_WRITE_DEADLINE_MS) })
```

  Semantics: `holdRegistryDeadline` spies `setTimeout`/`clearTimeout` (restored by `vi.restoreAllMocks`). A timer of
  exactly `deadlineMs`, or of a `hold` value, is held: never scheduled on the host's clock. A real wait from 250 ms up
  to `deadlineMs` runs on the host's clock and also fires as soon as a registry image (`registry.json.*.tmp`) syncs
  through `slowSyncFsPromises`, as on a loaded disk. Its state is one module instance, bound through `vi.hoisted`, so a
  spec's `vi.resetModules()` gives the factory no second copy.

- [ ] **Step 1: Write the failing tests** in `registryDeadline.spec.ts`: a held deadline timer runs on `expire()` and
  not before (the host's `setTimeout` is never called with `deadlineMs`); a cleared one runs on no `expire()`; a held
  `hold` timer runs on `fire(ms)` only; a 300 ms timer runs once a `registry.json.x.tmp` handle opened through
  `slowSyncFsPromises` syncs, before its 300 ms; a 100 ms timer is left alone.
- [ ] **Step 2: Run** `npx vitest run src/testing/registryDeadline.spec.ts`: FAIL (no module).
- [ ] **Step 3: Implement** the helper and the export. Replace the four copies; each keeps its `perf_hooks` mock and its
  own extras (`registry.homes.spec.ts`'s `slow.image` wait goes through `afterSync`).
- [ ] **Step 4: Run** `npx vitest run src/testing/registryDeadline.spec.ts src/lib/registry.spec.ts src/lib/registry.binding.spec.ts src/lib/registry.homes.spec.ts src/lib/registryAdmission.golden.spec.ts src/lib/registryPersistence.spec.ts`
  (green) and `npm run test:portability`.
- [ ] **Step 5: Commit** `test(cli): the registry deadline helper (red)`, then
  `test(cli): one helper holds the registry's write deadline; the four copies use it`.

### Task 8 (item 6): Seven registry specs hold the deadline

**Files:** Modify `cli/src/lib/registry.diskFailure.spec.ts`, `registry.externalResume.spec.ts`,
`registry.fingerprint.spec.ts`, `registry.firstTask.spec.ts`, `registry.hermesHome.spec.ts`,
`registry.launchCallers.spec.ts`, `registry.launchIdentity.spec.ts` (all in `cli/src/lib/`).

**Depends on:** 7. **Effort:** high.

**Interfaces:** Consumes Task 7's `slowSyncFsPromises`, `holdRegistryDeadline`, `REGISTRY_WRITE_DEADLINE_MS`.

- [ ] **Step 1: Red.** In each file add the `perf_hooks` mock where missing and the `slowSyncFsPromises` mock, without
  the hold. Run `npx vitest run <the seven>`. Expected: cases reject with `write deadline exceeded`; record which.
- [ ] **Step 2: Hold.** Add `holdRegistryDeadline(REGISTRY_WRITE_DEADLINE_MS)` in each `beforeEach`; a case that means
  the deadline to pass calls `expire()`. A case that depends on real time passing for another bound (the 2 s lock)
  goes in the report, unchanged.
- [ ] **Step 3: Run** the seven (green) and `npm run test:portability`.
- [ ] **Step 4: Commit** `test(cli): seven registry specs on a loaded disk (red)`, then
  `test(cli): seven registry specs hold the write deadline`.

### Task 9 (item 6): Seven more registry specs hold the deadline

**Files:** Modify `cli/src/lib/registry.namesCost.spec.ts`, `registry.openclawLocal.spec.ts`,
`registry.persistence.spec.ts`, `registry.persistenceCost.spec.ts`, `registry.quarantine.spec.ts`,
`registry.admission.spec.ts` (its `httpFixture` spies at `:436-443` go), `registry.hookPersistence.spec.ts` (its
`beforeEach` spies at `:62-70` go).

**Depends on:** 7. **Effort:** high.

**Interfaces:** Consumes Task 7's helper. The 250 ms hook-reply grace these two files hold passes as `{ hold: [250] }`
and fires through `fire(250)`; their slow-sync state becomes the helper's.

- [ ] **Step 1: Red** as Task 8 Step 1. For `admission` the red cases are those outside `httpFixture`; for
  `hookPersistence`, those before its spy. Record which.
- [ ] **Step 2: Hold** as Task 8 Step 2, from each file's first case.
- [ ] **Step 3: Run** the seven (green) and `npm run test:portability`.
- [ ] **Step 4: Commit** `test(cli): seven more registry specs on a loaded disk (red)`, then
  `test(cli): seven more registry specs hold the write deadline`.

### Task 10 (item 7): The recall deadline runs on an injected clock

**Files:**
- Modify: `companions/src/memory/runtime.ts:43-52` (`RuntimeDeps`), `:302-326` (`recallBound`)
- Test: `companions/src/memory/runtime.spec.ts:75` (construction), `:322-329` (the one-off freeze goes)

**Depends on:** none. **Effort:** medium.

- [ ] **Step 1: Write the failing test** "a recall whose clock passes 200 ms inside prepareRecall times out with no
  receipt": `await learn()`; `intercept` on `'prepareRecall'` adds 201 to the spec's held clock; then
  `runtime.preparePromptRecall('agent', { query: 'coding' })` has `packet.status === 'timeout'` and `receipt === null`.
  The spec's `beforeEach` passes `deadlineClock: () => clock` with `clock = 0`.
- [ ] **Step 2: Run** `cd companions && npx vitest run src/memory/runtime.spec.ts`: FAIL (the runtime reads
  `performance.now()`).
- [ ] **Step 3: Implement** `RuntimeDeps.deadlineClock?: () => number` (default `() => performance.now()`), read for
  `deadline`, `remaining()` and the check at `:323`. Remove the `vi.spyOn(performance, 'now')` at `:322-329`; its
  comment moves to the `beforeEach` clock (the October 6 CI failure, run 44482400232).
- [ ] **Step 4: Run** the spec (green) and `npm run typecheck`.
- [ ] **Step 5: Commit** `test(companions): the recall deadline case (red)`, then
  `fix(companions): the recall deadline runs on an injected clock`.

### Task 11 (item 8): e2e daemons are ready once their hooks are installed

**Files:**
- Modify: `cli/e2e/harness/daemon.ts:640-650` (`IsolatedDaemon.start`, the `'wired'` readiness and its comment)
- Modify: `cli/e2e/hookclient.e2e.ts:386` (the 6 s sleep)

**Depends on:** none. **Effort:** high. **Red:** test-only, deterministic repro (not committed). One commit.

- [ ] **Step 1: Reproduce (temporary).** Find where the daemon installs hooks after `[cli] ready` (#1166,
  `src/startupOrder.spec.ts:147`) and delay that install 2 s in the working tree. Run
  `npx vitest run --config vitest.e2e.config.ts e2e/hookclient.e2e.ts -t 'opened by hand'`. Expected: FAIL (the daemon
  is stopped before its hooks are in).
- [ ] **Step 2: Wait for the installs.** In the `'wired'` branch, after the ready line: wait (`until`, 60 s, 100 ms) for
  one install outcome line, in this start's output, of every engine in `HOOK_INSTALL_ENGINES` that has an install
  contract (none when `DISABLE_HOOK_INSTALL === 'true'`). A line counts when it fits one of that engine's contract
  `messages` templates (`installed`, `current`, `updated`, `failed`, `malformed`), `{…}` matching anything, read from
  the engines' own contracts (`src/engines/claude/hookContract.ts`, `src/engines/codex/hookContract.ts`, each native
  contract), never copied. Any outcome counts (Review Focus 2). Then `assertHooksStayedInside()`. Correct the comment at
  `:647`: hooks install after ready, by design, so `'wired'` waits for them.
- [ ] **Step 3: Replace the 6 s sleep** with a wait for the daemon's log line, since this start, that it handled that
  session's `UserPromptSubmit` (its session id from the fake engine's hook log, `hooksSince`), then the existing
  assertion that no agent was made. If the daemon logs no such line for a session it does not own, stop and report:
  this task changes no product code.
- [ ] **Step 4: Run** the repro (passes), remove the injection, then
  `npx vitest run --config vitest.e2e.config.ts e2e/hookclient.e2e.ts e2e/eagerHooks.e2e.ts e2e/enginehomes.e2e.ts` (green).
- [ ] **Step 5: Commit** `test(cli): e2e daemons are ready once their hooks are installed; hookclient waits for the prompt`.

### Task 12 (item 11): cableFleet's drop waits on a held `Date`

**Files:** Modify `cli/src/cable/cableFleet.spec.ts:93-139`.

**Depends on:** none. **Effort:** medium. **Red:** test-only, deterministic repro (not committed). One commit.

- [ ] **Step 1: Reproduce (temporary):** inject a 300 ms delay between each fault burst or flood and the scan that
  follows in "is dropped alone after five faults…" and "is dropped at once when it floods…". Run
  `npx vitest run src/cable/cableFleet.spec.ts`: both FAIL. Try 100 ms and 400 ms too.
- [ ] **Step 2: Change both tests:** `vi.useFakeTimers({ toFake: ['Date'] })` (restored in their `finally`),
  `const at = Date.now()` just before each burst or flood, and `vi.setSystemTime(at + wait - 1)` before the scan that
  must not reopen, `vi.setSystemTime(at + wait)` before the one that must, where `wait` is that drop's wait (300 in
  the first; 100, then 200, in the second). Absolute, never `advanceTimersByTime` (`vi.waitFor` moves a faked clock per
  poll). The real `setTimeout` sleeps go.
- [ ] **Step 3: Run** the repro on the new tests (passes at 100, 300, 400 ms), remove it, run the spec (green).
- [ ] **Step 4: Commit** `test(cli): cableFleet's drop waits run on a held Date`.

### Task 13 (item 13): The orphan socket closes after its second answer

**Files:** Modify `cli/e2e/twodaemons.e2e.ts:276-295`.

**Depends on:** none. **Effort:** medium. **Red:** test-only, deterministic repro (not committed). One commit.

- [ ] **Step 1: Reproduce (temporary):** a 3.5 s delay before `restarted.start({ ready: 'none' })`. Run
  `npx vitest run --config vitest.e2e.config.ts e2e/twodaemons.e2e.ts -t 'waits for that core to leave'`: FAIL.
- [ ] **Step 2: Change the case:** the orphan server counts the status requests it answers and closes once it has
  answered the second (the new core asked, waited a round, asked again); the case's first half runs in a `try` whose
  `finally` closes it; the 3 s `setTimeout` goes; `refuseServedDataFolder`'s own 20 s bound stays the timeout.
- [ ] **Step 3: Run** with the repro (passes), remove it, run the file (green).
- [ ] **Step 4: Commit** `test(cli): the orphan socket closes after the new core has asked it twice`.

### Task 14 (item 14): `processRows()` reads Windows' table on win32

**Files:**
- Modify: `cli/src/lib/processTable.ts:421-425`, `cli/src/lib/uninstall/ptyHosts.ts:188-191`
- Test: `cli/src/lib/processTable.rows.spec.ts` (new), `cli/src/lib/uninstall/ptyHosts.spec.ts`

**Depends on:** none. **Effort:** xhigh (core files).

**Interfaces:**
- Produces: `processRows()` with no source installed reads `windowsProcessRows(null)` (`harness-pty ps --json`) on
  win32 and `readProcessRows()` elsewhere. `setProcessTableSource` is unchanged; the daemon's installed source still wins.

- [ ] **Step 1: Write the failing test** "with no source installed, Windows reads harness-pty's table and runs no ps":
  `Object.defineProperty(process, 'platform', { value: 'win32' })` (restored after); `vi.mock('./windows/processTable.js')`
  so `windowsProcessRows` resolves fixture rows; `child_process` mocked. `await processRows()` returns those rows,
  `windowsProcessRows` was called with `null`, and no `ps` was run. Beside it: on linux it runs `ps` as today.
- [ ] **Step 2: Run** `npx vitest run src/lib/processTable.rows.spec.ts`: FAIL (`ps` runs).
- [ ] **Step 3: Implement** the fallback in `processRows` (import `windowsProcessRows`; both files are core files
  already, and `windows/processTable.ts` imports only a type from `processTable.ts`). `ptyHostsDeps` takes
  `rows: processRows` and drops its win32 branch; `ptyHosts.spec.ts` asserts that on win32 it reads Windows' table
  through `processRows`.
- [ ] **Step 4: Run** `npx vitest run src/lib/processTable.rows.spec.ts src/lib/processTable.engineChildren.spec.ts src/lib/uninstall src/lib/windows/processTable.spec.ts src/architecture.spec.ts`
  (green; `src/architecture.coreFiles.txt` unchanged).
- [ ] **Step 5: Commit** `test(cli): processRows reads Windows' own table (red)`, then
  `fix(cli): one process-table reader on every OS: processRows reads harness-pty's table on Windows`.

### Task 15 (item 14): VS Code terminals and app models read `processRows()`

**Files:**
- Modify: `cli/src/cable/hosts/vscodeTerminals.ts:60-92`, `cli/src/lib/appModels.ts:250-255`
- Test: `cli/src/cable/hosts/vscodeTerminals.spec.ts`, `cli/src/lib/appModels.spec.ts`

**Depends on:** 14. **Effort:** high.

**Interfaces:** Consumes Task 14's `processRows()`. Produces
`readProcessParents(rows?: () => Promise<ProcessRow[] | null>): Promise<ProcessParent[]>` (default `processRows`; null
or no rows still throws `process table not read`) and
`readForeground(agent, shell, exec?, platform?: NodeJS.Platform)` (`undefined` on win32 before any exec).

- [ ] **Step 1: Write the failing tests:** `vscodeTerminals.spec.ts` "reads each process's parent from the process
  table, Windows included" (rows injected; the exec seam never called) and "has no foreground group to read on
  Windows, and runs no ps" (`platform: 'win32'` → `undefined`, exec not called); `appModels.spec.ts` "tells its own
  engine by the pid's command line in the process table, on Windows too" (`setProcessTableSource` rows with the pid and
  args naming the binary → stopped; no `ps` run; a pid whose args name another binary is not ours).
- [ ] **Step 2: Run** `npx vitest run src/cable/hosts/vscodeTerminals.spec.ts src/lib/appModels.spec.ts`: FAIL.
- [ ] **Step 3: Implement** the two signatures and `ours`: the row for `record.pid` from `processRows()`, ours when its
  `args` include `basename(record.binary)`; no row or no table is not ours. `src/architecture.spec.ts` must still pass
  (an edge folder importing `lib/` is allowed).
- [ ] **Step 4: Run** the two specs, `src/lib/appModels.tied.spec.ts` and `src/architecture.spec.ts` (green).
- [ ] **Step 5: Commit** `test(cli): VS Code terminals and app models on Windows (red)`, then
  `fix(cli): VS Code terminals and app models read the one process table; no ps on Windows`.

### Task 16 (item 14): The hook's lock marker runs no `ps` on win32

**Files:** Modify `cli/hook/notify.mjs:1880-1891` (`processStartMarker`); Test `cli/src/lib/processLiveness.spec.ts:84-99`.
Shares `cli/hook/notify.mjs` with Task 25.

**Depends on:** none. **Effort:** medium.

- [ ] **Step 1: Red:** move the `describe('on Windows', …)` case into the `describe.each` over `daemon` and
  `offline hook`, using `api.*`. Run `npx vitest run src/lib/processLiveness.spec.ts`: the hook's case FAILS (`ps` runs).
- [ ] **Step 2: Implement** the early return `process.platform === 'win32' || !Number.isSafeInteger(pid) || pid <= 0`,
  as `processLiveness.ts:37` (#4517). Keep the markers the spec slices the hook by (`function processStartMarker(` …
  `async function withRegistryLock(`).
- [ ] **Step 3: Run** the spec and `npx vitest run src/hookNotify.spec.ts` (green).
- [ ] **Step 4: Commit** `test(cli): the hook's lock marker on Windows (red)`, then
  `fix(cli): the hook's lock marker runs no ps on Windows`.

### Task 17 (item 14): Resource samples and foreground checks answer unknown on win32

**Files:** Modify `cli/src/lib/harnessResources.ts:57-58` (`sampleProcesses`), `cli/src/lib/externalOwnerControl.ts:9-15`
(`verifiedForegroundJob`); Test their specs.

**Depends on:** none. **Effort:** xhigh (`externalOwnerControl.ts` is a core file).

- [ ] **Step 1: Write the failing tests:** `harnessResources.spec.ts` "has no process readings on Windows and runs no
  ps" (win32, `node:child_process` mocked, `createHarnessResourcesReader` with its default deps: the read answers as
  for `Process readings unavailable`, and `execFile` is never called);
  `externalOwnerControl.spec.ts` "answers unknown on Windows without ps" (`verifiedForegroundJob(pid, exec)` →
  `'unknown'`, exec never called). win32 through `Object.defineProperty(process, 'platform', …)`, as
  `processLiveness.spec.ts:84-90`.
- [ ] **Step 2: Run** both specs: FAIL.
- [ ] **Step 3: Implement** the two early answers before any spawn, each with a comment (Windows has no `ps`;
  `docs/windows-rules.md` §3).
- [ ] **Step 4: Run** both specs (green).
- [ ] **Step 5: Commit** `test(cli): resource samples and foreground checks on Windows (red)`, then
  `fix(cli): resource samples and foreground checks answer unknown on Windows, without ps`.

### Task 18 (item 14): Search's tty/cwd reads and the native probes answer unknown on win32

**Files:** Modify `cli/src/lib/sessionSearch/externals/support.ts:237-330` (`processCwds`, `processView`,
`processTtys`), `cli/src/engines/kit/nativeEvidence.ts:42-47` (`nativeProbe`); Test their specs.

**Depends on:** none. **Effort:** xhigh (`nativeEvidence.ts` is a core file).

- [ ] **Step 1: Write the failing tests:** `support.spec.ts` "reads no tty, cwd or open file on Windows, and runs
  neither ps nor lsof" (`processTtys(pids, exec, 'win32')`, `processCwds(pids, exec, 'win32')` (its existing `os` seam), and `processView`'s
  `openFiles` and `openFilesOf` with `platform: 'win32'` all give empty maps, exec never called);
  `nativeEvidence.spec.ts` "a native probe on Windows is unavailable, and spawns nothing" (rejects through
  `nativeUnavailable`, `execFile` never called; `processEvidence.ts:80, 98` go through it).
- [ ] **Step 2: Run** both specs: FAIL.
- [ ] **Step 3: Implement:** `processTtys` and `processView` take a trailing `platform = process.platform`, and
  `processCwds` answers on `os === 'win32'` before its `lsof`; the empty answer is the one a failed exec gives today. `nativeProbe` answers
  `nativeUnavailable('the native process probes do not run on Windows')` on win32.
- [ ] **Step 4: Run** both specs and `src/lib/processEvidence.spec.ts` (green).
- [ ] **Step 5: Commit** `test(cli): search's process reads and the native probes on Windows (red)`, then
  `fix(cli): search's process reads and the native probes answer unknown on Windows, without ps or lsof`.

### Task 19 (item 9): PowerShell scripts import their modules by path, autoload off

**Files:**
- Modify: `cli/src/lib/windows/powershell.ts` (the helper); the scripts in `cli/src/lib/peerAccount.ts:199-260`,
  `cli/src/lib/windows/storePackage.ts:16`, `cli/src/lib/windows/guestScript.ts`, `cli/src/team/windowsRemoveScript.ts`,
  `cli/src/lib/signOut.ts:83-86`, `cli/src/lib/uninstall/removal.ts:370-380`, `cli/src/lib/windows/ptySignatures.ts:46-53`,
  and, if its script calls a module cmdlet, `cli/src/lib/uninstall/windowsPath.ts` and `cli/src/engines/kit/windowsInstall.ts`
- Create: `cli/src/lib/windows/powershellModules.spec.ts`
- Modify: `docs/windows-rules.md` (shared with Task 20)

**Depends on:** none. **Effort:** xhigh.

**Interfaces:**
- Produces: `modulesByPath(...modules: PowershellModule[]): string` → `$PSModuleAutoLoadingPreference = 'None'`, then one
  `Import-Module -Name "$PSHOME\Modules\<M>\<M>.psd1"` per module (a string path: `Join-Path` is itself a module cmdlet).
  `PowershellModule` names the modules the table below knows: `NetTCPIP`, `CimCmdlets`, `Appx`,
  `Microsoft.PowerShell.Management`, `Microsoft.PowerShell.Utility`, `Microsoft.PowerShell.Security`, and any other a
  listed script needs. A script exports the text the spec reads (for example `storePackage.ts`'s `SCRIPT`).

- [ ] **Step 1: Write the failing static spec**, as `harnessDevicePlugin.spec.ts:107` does: a table, keyed by source file,
  of every script those files run (`windowsPeerQuery(1, 2).script`, `windowsListenerQuery(1).script`, `storePackage`'s,
  `removal`'s `START_OUTSIDE_JOB`, the guest and team-removal scripts, `signOut`'s command, `ptySignatures`'
  `SIGNATURES_SCRIPT`, …), and a cmdlet → module map. For each script: autoload is off before any cmdlet; every
  `Verb-Noun` cmdlet is a Core one (`Import-Module`, `Where-Object`, `ForEach-Object`, …) or in a module the script
  imports by path after that line; a cmdlet the map does not know fails by name. Guard: every non-spec file under
  `cli/src/` that names a `NetTCPIP`, `CimCmdlets` or `Appx` cmdlet is a key of the table.
- [ ] **Step 2: Run** `npx vitest run src/lib/windows/powershellModules.spec.ts`: FAIL, naming each script.
- [ ] **Step 3: Implement:** each script starts with `modulesByPath(...)` for what it calls (Management and Utility
  included where used, Review Focus 3). Comments name the cost: the first command autoload must find costs a Windows
  PowerShell 5.1 process 22-29 s on windows-11-arm and 0.25-0.8 s on windows-latest (runs 43581413308, 43582091190); the
  peer query timed out at 93.7 s against `WINDOWS_PEER_MS` 45 s; `ptySignatures.ts` imported by path took 1.8 s.
- [ ] **Step 4: Windows rule** in `docs/windows-rules.md` §2: "**A PowerShell script imports each module it calls by
  path, with autoload off.** …" with the numbers above and `Test: cli/src/lib/windows/powershellModules.spec.ts`.
- [ ] **Step 5: Run** `npx vitest run src/lib/windows src/lib/peerAccount.spec.ts src/lib/uninstall src/team src/lib/signOut.spec.ts src/harnessDevicePlugin.spec.ts`
  (green on this Mac; the real runs are on `windows.yml`, Verification).
- [ ] **Step 6: Commit** `test(cli): every PowerShell script imports its modules by path (red)`, then
  `fix(cli): PowerShell scripts import their modules by path with autoload off`.

### Task 20 (item 12a): The Windows held pane ends on the console's close

**Files:**
- Modify: `cli/src/lib/windows/engineStart.ts:70-81` (`windowsHeldPaneArgv`)
- Test: `cli/src/lib/windows/engineStart.spec.ts` (beside `:53`), `cli/src/lib/ptyHostBackend.restart.spec.ts` (beside `:148`)
- Modify: `docs/windows-rules.md` (shared with Task 19)

**Depends on:** none. **Effort:** xhigh.

- [ ] **Step 1: Confirm the claim before relying on it.** (i) `git log -S'"SIGHUP"' -- cli/src/lib/windows/engineStart.ts`:
  if SIGHUP was ignored for a reason other than parity with the `/bin/sh` loop (a close the held pane must survive),
  stop and report. (ii) In the libuv that Node 24.22.2 bundles, `src/win/signal.c`: `CTRL_CLOSE_EVENT` is dispatched as
  SIGHUP; with a listener the handler thread waits, so the process ends only at Windows' own timeout or the host job's
  end after `RESPAWN_GRACE` (2 s); with none, the default handler ends it at once. Quote the lines in the report. If
  either is wrong, item (a) becomes whatever makes the held pane exit on the close; say what.
- [ ] **Step 2: Write the failing tests:**
  - `engineStart.spec.ts` "ends on a hangup, as the held pane elsewhere does" (`skipIf` win32, as its neighbour): spawn
    the argv, wait for its line, `child.kill('SIGHUP')`, await `exit` (bounded at 5 s) → `signalCode === 'SIGHUP'`.
    Today it survives: FAIL at the bound.
  - `ptyHostBackend.restart.spec.ts` "a respawn over this platform's own held pane replies before the host's 2 s grace":
    create a pane with `heldPaneArgv('why', token)` (`core/agents/heldLaunches.ts`: the real Windows argv on Windows, the
    `/bin/sh` loop elsewhere), time `backend.respawn(pane, { command: SHELL, expectedHeldToken: token })` →
    `succeeded` and under 2,000 ms; print the measured ms (the PR carries it). Green on macOS before and after; red on
    Windows today (≥ 2 s), proven on `windows.yml` (Verification).
- [ ] **Step 3: Run** `cd pty && cargo build && cd ../cli && HARNESS_PTY_BIN=$(pwd)/../pty/target/debug/harness-pty npx vitest run src/lib/windows/engineStart.spec.ts src/lib/ptyHostBackend.restart.spec.ts`:
  the hangup case FAILS.
- [ ] **Step 4: Implement:** the held pane ignores only `SIGINT` and `SIGBREAK`. The doc comment says it survives Ctrl-C
  and Ctrl-Break, ends on the console's close as the `/bin/sh` loop ends on hangup, so a respawn over it spends none of
  the host's 2 s grace (#4517's VM run: six panes reopened after a reboot, two hit the 5 s deadline). Windows rule in
  `docs/windows-rules.md` §2: a console process that listens for SIGHUP holds a close until it is killed; with the
  test named.
- [ ] **Step 5: Run** Step 3 again (green) and `npx vitest run src/lib/windows/engineStart.spec.ts src/core/agents` (the
  interrupt case stays green, Review Focus 4).
- [ ] **Step 6: Commit** `test(cli): the Windows held pane ends on a hangup (red)`, then
  `fix(cli): the Windows held pane ends on the console's close, so a respawn over it is quick`.

### Task 21 (item 12b): `create` and `respawn` get a 15 s deadline

**Files:** Modify `cli/src/lib/ptyHost/client.ts:49, 255-264`; Test `cli/src/lib/ptyHost/client.spec.ts`.

**Depends on:** none. **Effort:** xhigh (core file, the one control connection).

- [ ] **Step 1: Write the failing tests** with fake timers and the spec's fake host socket: "a respawn reply at 6 s
  still succeeds", "a respawn with no reply by 15 s is no reply within 15000 ms", the same two for `create`, and
  "another op still has 5 s" (`inventory` with no reply by 5 s → `unknown`).
- [ ] **Step 2: Run** `npx vitest run src/lib/ptyHost/client.spec.ts`: the 6 s cases FAIL (`no reply within 5000 ms`).
- [ ] **Step 3: Implement** beside `DEFAULT_TIMEOUT_MS`:

```ts
/** What the host itself may wait before a respawn replies (pty/src/panes.rs): RESPAWN_GRACE 2 s for the old child,
 *  EXIT_REPORT 1 s for its exit, and pane.rs `finish`'s 1 s more on Windows. */
const HOST_PANE_WAITS_MS = 4_000
/** A cold console and engine start beside them: #4517's VM run reopened six panes after a reboot and confirmed every
 *  agent within 23 s, while two respawns missed 5 s. Defender's first-run scan and boot load are outside causes. */
const COLD_START_MS = 11_000
/** `create` and `respawn`, from the request's send. */
const PANE_START_TIMEOUT_MS = HOST_PANE_WAITS_MS + COLD_START_MS
```

  and `call(op, timeoutMs = op.op === 'create' || op.op === 'respawn' ? PANE_START_TIMEOUT_MS : DEFAULT_TIMEOUT_MS)`.
- [ ] **Step 4: Run** `npx vitest run src/lib/ptyHost src/lib/ptyHostBackend.spec.ts` (green).
- [ ] **Step 5: Commit** `test(cli): pane starts get the host's own waits and a cold start (red)`, then
  `fix(cli): create and respawn wait 15 s, the host's own waits and a cold start; other ops keep 5 s`.

### Task 22 (item 12c): The host logs how long each create and respawn took

**Files:** Modify `pty/src/panes.rs` (`handle`, the `Op::Create` and `Op::Respawn` arms at `:516` and `:740`; its test module).

**Depends on:** none. **Effort:** high.

- [ ] **Step 1: Write the failing test** `took_line_names_the_op_and_its_milliseconds`:
  `took_line("respawn", Duration::from_millis(1234)) == "respawn took 1234 ms"` and the same for `"create"`.
- [ ] **Step 2: Run** `cargo test --locked --manifest-path pty/Cargo.toml took_line`: FAIL (no function).
- [ ] **Step 3: Implement `fn took_line(op: &str, took: Duration) -> String`** and, in both arms,
  `log::info!("{}", took_line(op, started.elapsed()))` once the op has its result, success or error. The op's name and
  milliseconds only: no pane id, command, path or error text.
- [ ] **Step 4: Run** `cargo test --locked --manifest-path pty/Cargo.toml` (green).
- [ ] **Step 5: Commit** `test(pty): the took line (red)`, then `fix(pty): the host logs how long each create and respawn took`.

### Task 23 (item 15): `homePath`, the path fields, the env file reader, the docs

**Files:**
- Modify: `cli/src/config/envFields.ts`, `cli/src/config/loadEnv.ts:9-15`, `cli/src/config/env.ts:77-78, 87, 225-389`,
  `cli/src/homeMove/conditions.ts:76-80`, `docs/cli.md:117`, `docs/development.md:93`, `cli/README.md:276, 292`
- Test: `cli/src/config/envFields.spec.ts`, `cli/src/config/loadEnv.spec.ts`, `cli/src/config/env.spec.ts`,
  `cli/src/homeMove/conditions.spec.ts`, `cli/src/lib/daemonState.pidFile.spec.ts`

**Depends on:** none. **Effort:** xhigh (where state lives; core files).

**Interfaces:**
- Produces (all in `config/envFields.ts`, a file the core already loads, so `architecture.coreFiles.txt` is unchanged;
  `loadEnv.ts` reads the file at import and must not be imported for its reader):

```ts
/** An absolute value as given; a relative one joined to the home (the folder enterHome enters), never the current
 *  folder; '' stays ''. */
export function homePath(value: string, home: string = homedir()): string
/** A Harness folder or file override: unset or '' → [fallback]; else homePath(raw). */
export const homeRelative = (fallback: string): EnvField<string> => …
/** HARNESS_ENV_FILE, else DOTENV_CONFIG_PATH, trimmed, through homePath; null when neither is set. */
export function envFilePath(env: NodeJS.ProcessEnv, home?: string): string | null
```

- [ ] **Step 1: Write the failing tests:**
  - `envFields.spec.ts`: `homePath('/abs', '/h') === '/abs'`, `homePath('data', '/h') === join('/h', 'data')`,
    `homePath('', '/h') === ''`; `homeRelative('/fallback')` gives `'/fallback'` for `undefined` and `''`, and
    `join(homedir(), 'data')` for `'data'` (Review Focus 1); `envFilePath` prefers `HARNESS_ENV_FILE` and trims.
  - `loadEnv.spec.ts` (its spawn pattern): "reads a relative HARNESS_ENV_FILE from the home, whatever folder the
    process starts in": `HOME` and `USERPROFILE` a throwaway home holding `harness.env`, the process started in another
    folder holding its own `harness.env`; the home's values are read. The same for `DOTENV_CONFIG_PATH`.
  - `env.spec.ts`: `ADAPTER_DATA_DIR: 'data'` and `HARNESS_PTY_DIR: 'pty'` in a process started in another folder give
    `<home>/data` and `<home>/pty`; and the legacy identity's candidates (`env.ts:77-78`) are under `<home>/data`.
  - `conditions.spec.ts`: `withEnvFile` with a relative `HARNESS_ENV_FILE` reads `<home>/<file>`.
  - `daemonState.pidFile.spec.ts`: "the pid file is under the home's data folder when ADAPTER_DATA_DIR is relative,
    from any folder" (a process started in another folder prints `PID_FILE` = `<home>/data/adapter.pid`).
- [ ] **Step 2: Run** `npx vitest run src/config src/homeMove/conditions.spec.ts src/lib/daemonState.pidFile.spec.ts`: FAIL.
- [ ] **Step 3: Implement:** the three exports; `loadEnvFile` and `withEnvFile` read `envFilePath`; in `env.ts`,
  `ADAPTER_DATA_DIR`, `HARNESS_LOGS_DIR`, `HARNESS_PTY_DIR`, `HARNESS_DEVICES_DIR`, `HARNESS_HOOK_ROUTES_DIR`,
  `HARNESS_AGENT_MESSAGES_DIR`, `DSH_DIR`, `ADAPTER_COMPUTER_ID_FILE`, `ADAPTER_CLI_DIR`, `ADAPTER_RUNTIME_DIR` and
  `HARNESS_BIN_DIR` become `homeRelative(...)`; the raw reads at `:77-78, 87` go through `homePath` (an empty value is
  unset there already). Engine `*_PATH` and `AMP_*` variables stay `text`. `CARRIED_ENV` (`lib/platformDaemon.ts:43`)
  is unchanged. The comment names why: the master resolved against its start folder, the core after `enterHome`
  against the home, the CLI against the shell's folder; a relative env file could fail every core start, a relative data
  folder split the pid file, lock, socket and log (harness-pm, 2026-11-21: no refusal; home in every process).
- [ ] **Step 4: Docs:** the three places say a value is "absolute, or relative to your home".
- [ ] **Step 5: Run** Step 2's command (green), `npx vitest run src/architecture.spec.ts src/architecture.startEnvironment.spec.ts src/config`
  and `npm run typecheck`.
- [ ] **Step 6: Commit** `test(cli): a relative override means the home in every process (red)`, then
  `fix(cli): a relative Harness folder or file override is relative to the home in every process`.

### Task 24 (item 15): Every other reader of the overrides goes through `homePath`

**Files:**
- Modify: `cli/src/lib/authSession.ts:77`, `cli/src/lib/secureState.ts:49-52` (`windowsStateRoots`),
  `cli/src/lib/homeDataFolder.ts:37`, `cli/src/homeMove/start.ts:193-194`, `cli/src/tui/index.ts:127`,
  `cli/src/lib/connectors/store.ts:66-68`, `cli/src/lib/flasherDir.ts:9`
- Test: `cli/src/lib/authSession.spec.ts`, `cli/src/lib/secureState.spec.ts`, `cli/src/lib/homeDataFolder.spec.ts`,
  `cli/src/homeMove/start.spec.ts`, `cli/src/tui/index.spec.ts`, `cli/src/lib/connectors/store.spec.ts` (new unless one
  exists), `cli/src/lib/flasherDir.spec.ts` (new)

**Depends on:** 23. **Effort:** xhigh.

**Interfaces:** Consumes Task 23's `homePath(value, home?)`.

- [ ] **Step 1: Find every reader** again: `grep -rnE "(ADAPTER_DATA_DIR|HARNESS_AUTH_DIR|HARNESS_LOGS_DIR|HARNESS_PTY_DIR|HARNESS_DEVICES_DIR|HARNESS_HOOK_ROUTES_DIR|HARNESS_AGENT_MESSAGES_DIR|DSH_DIR|ADAPTER_COMPUTER_ID_FILE|ADAPTER_CLI_DIR|ADAPTER_RUNTIME_DIR|HARNESS_BIN_DIR|HARNESS_CONNECTIONS_DIR|HARNESS_FLASHER_CACHE|HARNESS_ENV_FILE|DOTENV_CONFIG_PATH)" src hook`
  (non-spec). Every reader of a raw value is one of the files above, `env.ts` or `loadEnv.ts`/`conditions.ts`
  (Task 23), or the hook (Task 25); one that is not is added here and named in the report.
- [ ] **Step 2: Write the failing tests**, one per reader, each "a relative value is under the home": `AUTH_DIR` and
  `FLASHER_DIR` (module constants: `vi.resetModules`, `vi.stubEnv`, import), `windowsStateRoots({ ADAPTER_DATA_DIR: 'data' }, '/h')`
  includes `join('/h', 'data')`, `inheritedAccountDataFolder` compares `join(HOME, dataDir)` for a relative one,
  `homeMove/start`'s log goes to `<home>/data/harness.log`, the TUI's data folder, `connectorsDir({ HARNESS_CONNECTIONS_DIR: 'c', HOME: '/h' })`.
- [ ] **Step 3: Run** them: FAIL.
- [ ] **Step 4: Implement:** each raw read goes through `homePath`, with the home the reader already has where it has
  one (`windowsStateRoots`' `home`, `homeMove/start`'s `deps.home`, `connectorsDir`'s `env.HOME || homedir()`,
  `inheritedAccountDataFolder`'s `environ.HOME`) and `homedir()` otherwise; an empty value keeps each reader's own
  fallback.
- [ ] **Step 5: Run** the specs and `npx vitest run src/lib/stateWrites.guard.spec.ts src/architecture.spec.ts` (green),
  `npm run typecheck`.
- [ ] **Step 6: Commit** `test(cli): every reader of a relative override reads the home (red)`, then
  `fix(cli): every reader of a Harness folder override resolves a relative one against the home`.

### Task 25 (item 15): The hook's readers of the overrides

**Files:** Modify `cli/hook/notify.mjs:166, 1292, 1530`; Test `cli/src/hookNotify.spec.ts`. Shares `cli/hook/notify.mjs`
with Task 16.

**Depends on:** 23. **Effort:** high.

- [ ] **Step 1: Write the failing test** "a relative HARNESS_HOOK_ROUTES_DIR is the home's, not the project's": the
  hook run as the spec runs it, from a project folder, with `HOME` a throwaway home and `HARNESS_HOOK_ROUTES_DIR: 'routes'`;
  it reads its route from `<home>/routes` (today `<project>/routes`). Beside it, the same for a relative
  `ADAPTER_DATA_DIR` with whatever the spec already observes of the data folder.
- [ ] **Step 2: Run** `npx vitest run src/hookNotify.spec.ts`: FAIL.
- [ ] **Step 3: Implement** the hook's own copy of the rule (it is a standalone file and imports no TypeScript):
  `const homePath = (value) => isAbsolute(value) ? value : join(homedir(), value)`, used at the three reads, each still
  falling back as today when the value is empty; the comment points at `config/envFields.ts` `homePath`. Place it outside
  the text `processLiveness.spec.ts` slices.
- [ ] **Step 4: Run** `npx vitest run src/hookNotify.spec.ts src/lib/processLiveness.spec.ts src/lib/hooks.spec.ts` (green).
- [ ] **Step 5: Commit** `test(cli): the hook reads a relative override from the home (red)`, then
  `fix(cli): the hook resolves a relative override against the home, not the project`.

---

## Verification

All of it on the final head, after the final review. Nothing runs against production: every daemon is an isolated one
(`IsolatedDaemon`: throwaway root and home, a private tmux server, ports of its own, never 18473, signed out, local
fake backend), and no check signs in.

**1. Local gates on this Mac** (`docs/validation-and-release.md`: checks PR CI does not run), from a clean tree:
- `python3 scripts/local-checks.py --run`, its fence pasted into the PR body. With Task 4 landed it selects every
  `cli-*` check (`cli/src/__fixtures__/vitestRun.ts` is a shared CLI input): core, harnessd, orchestrator, sharing,
  resume, remote-viewers, portability, local-models, serial, pty, shell. Without it: `cli-portability` (`dsh/*.ts`,
  `lib/registry*`) and `cli-pty` (`lib/ptyHost*`, `pty/*`).
- `cd cli && npm run test:core` and `npm run typecheck`: the batch changes files the core loads (items 12, 14, 15).
- `make desktop-test ARGS="test/terminal_session_test.dart test/local_cli_discovery_test.dart"` and
  `cd desktop && flutter analyze lib/terminal/terminal_session.dart lib/ws/local_cli_discovery.dart test/terminal_session_test.dart test/local_cli_discovery_test.dart`.
- `python3 -m unittest discover -s scripts/tests -p 'test_*.py'` (also PR CI's `process-checks`).
- `cd companions && npm run typecheck && npx vitest run src/memory`.
- `cargo test --locked --manifest-path pty/Cargo.toml`, then
  `cd cli && HARNESS_PTY_BIN=$(pwd)/../pty/target/debug/harness-pty npx vitest run src/lib/ptyHostBackend.restart.spec.ts`.

**2. End to end on this Mac** (isolated daemons, the run's own Node; started from `cli/`, never a folder that goes):
- `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/hookclient.e2e.ts e2e/twodaemons.e2e.ts e2e/eagerHooks.e2e.ts e2e/enginehomes.e2e.ts`:
  all green; the Task 11 and 13 repros recorded in their tasks.
- Item 2 for real: in this worktree only, `rm -rf desktop/build`, then a `scripts/validate-change.py` plan of two
  `flutter test` checks in `desktop/` (two Material widget test files, which draw `ink_sparkle.frag`) and `--jobs 2`:
  both pass, and the receipt shows the second starting after the first finished.
- Item 1 under load: `flutter test --no-pub test/terminal_session_test.dart` 30 times beside 24 `yes > /dev/null` hogs:
  0 red (Task 1 Step 5).

**3. GitHub workflows, by hand, on harness-pm's go, one at a time** (heavy; the branch pushed by the main session):
- `gh workflow run cli-e2e.yml --ref fix/small-fixes-batch-1121` (8 shards, ubuntu-24.04): items 8 and 13. Item 8
  changes every e2e daemon's readiness, so the whole suite is the proof. Expect all shards green; report the run link.
- `gh workflow run windows.yml --ref fix/small-fixes-batch-1121` (windows-latest and windows-11-arm): items 9, 12, 14.
  Expect green on both runners, and record from the windows-11-arm log: `peerAccount.windows.real.spec.ts` "still gets
  the same yes from PowerShell, for an older host" from 24-45 s to a few seconds (item 9); the restart contract case's
  printed respawn time under 2,000 ms on both runners (item 12a, red on main by construction); `src/lib/uninstall` and
  `src/lib/windows/processTable.spec.ts` green (item 14); `engineStart.real.spec.ts`'s Ctrl-C case green (Review Focus 4).

**4. On the shared Windows ARM VM** (optional; harness-pm's go; the VM's own test account, never a person's;
`docs/testing/windows-cli-e2e.md`): a build of this branch, six Claude Code panes open, reboot. Expect every pane
reopened with no `pty host could not respawn the pane`, every agent confirmed, and the host log's `create took` and
`respawn took` lines; their numbers join #4517's (six panes, all confirmed within 23 s) as the measurement behind 15 s.

**5. What the PR carries:** master.spec before and after, or "no faster, item 4 dropped" (Task 4); both dsh specs'
times (Tasks 5, 6); item 1's red rate and the 30 loaded runs; the windows.yml numbers above; the outside causes named
(flutter_tools' race on Flutter 3.47.5; Defender's first-run scan and boot load); the red-then-green commits; the
platforms (macOS, Linux, Windows x64 and ARM64; Desktop on all three).

**Item 15 end to end: none beyond its process-level specs.** `loadEnv.spec.ts`, `env.spec.ts` and
`daemonState.pidFile.spec.ts` start real processes in a folder other than the home, the layer where resolution happens
(at process start, in the same `env.ts` the master, core and CLI load); `cli-e2e` proves absolute values unchanged.

## Open questions

1. **Q1, item 4 on a Homebrew Node.** Task 4 links one started copy into every test that places a Node. Homebrew's
   Node loads `libnode` from beside the path the process runs as, and macOS may name a hard-linked file by any of its
   links (#4395). Today only one test's links share an inode; after, every test's do, so a test removing its folder
   while another test's process starts from the same inode could bring #4395 back across tests. This Mac (nvm) and CI
   run official Nodes with no `libnode`, so no run here would show it. Choose: (a) on a Node with a `libnode` the run
   makes no started copy and `placeNode` copies as today (a second path, as the Rosetta refusal is); (b) accept it;
   (c) drop item 4.
   **Answer (2026-11-21, child's call under harness-pm's standing go, reversible): (a).**
