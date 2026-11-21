# Small fixes batch 2 (2026-11-21): Implementation Plan

> **For agentic workers:** REQUIRED: implement this plan with devcrew phase 3, task by task. Steps use checkbox
> (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(<area>): <the task's message> (red)` once its
> failing tests have been run and seen to fail, then the task's own message. A task with no red test (no behavior
> change, or test-only with a deterministic repro) is one commit. No task pushes or merges, and every task ends green.

**Goal:** One pull request that removes a second batch of flaky tests, small bugs and CI gaps at their causes (spec
items 1-5 and 7-16; item 6 is already fixed on main by #4525), each with its red-then-green test or its deterministic
repro, and numbers before and after for item 5.

**Architecture:**
- **Waits on the event, not on a clock:** the reconciler counts its passes and `/api/status` serves them (item 10), so
  e2e "nothing happened" checks wait two passes (items 4, 10); hook losses are said when they happen (item 3) and each
  paneless event leaves one line (item 4); test fixtures retry or wait on publishes (items 11, 13, 15).
- **One way to a program:** git by one absolute path per process in the CLI and in Desktop (item 7), Windows' folder
  from the file system only (item 8), a link opened without a shell (item 9).
- **The core's loop is not held:** the handoff publication's fsyncs go to libuv's threadpool in the same order (item 5).
- **CI and tooling see what they miss:** the planner (item 2), the change validator (item 14), the e2e setup's mongod
  cache (item 1), the nightly's three open races (item 1), and a console runner that needs no CIM (item 16).

**Tech Stack:** TypeScript on Node 24 (vitest unit, `vitest.core.config.ts`, `vitest.e2e.config.ts`), Dart/Flutter
(`flutter_test`), Python 3 (`unittest`), GitHub Actions composite actions, Windows PowerShell 5.1, Node's test runner
(`store/viewers/game-viewer`). No new dependency.

**Spec:** `docs/plans/2026-11-21-small-fixes-batch-2-design.md`. Read it with this plan, the root `AGENTS.md`,
`cli/AGENTS.md` (Protect the core), `desktop/AGENTS.md` and `desktop/CLAUDE.md` (Testing conventions),
`docs/windows-rules.md` (items 7, 8, 9, 16) and `docs/validation-and-release.md`.

## Base

- `fix/small-fixes-batch-1121b` at `9281024a97` (`origin/main`). The spec and this plan are untracked; the main session
  commits them, no task does.
- Line numbers are the base's. A task follows the expression it names when a line has moved, and says so in its report.
- Once per checkout: `cd cli && npm ci`, `cd desktop && flutter pub get`. Every `cli` command below runs from `cli/`
  unless it says otherwise.
- Files a task "may touch" beyond its list: none. A task that finds its fix needs another file stops before editing it
  and reports the file and why, so devcrew can order it against the task that owns that file.

## Tasks at a glance

| Task | Files (tests included) | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 (item 2a) A change to ci.yml's top-level `concurrency` runs every job's suite; `on:` documented | `scripts/ci-plan.py`, `scripts/tests/test_ci_plan.py`, `docs/validation-and-release.md` | none | medium | `test_what_a_job_takes_from_the_rest_of_ci_yml_is_part_of_its_definition`, the concurrency subcase |
| 2 (item 2b) The cross-read scan runs on every PR that changes a component | `scripts/ci-plan.py`, `scripts/tests/test_ci_plan.py`, `docs/validation-and-release.md` | none | high | `test_the_planner_its_tables_and_every_suites_own_files_run_the_cross_read_scan`, the component cases |
| 3 (item 14) Every way of running `flutter test` holds its folder | `scripts/validate-change.py`, `scripts/tests/test_validate_change.py` | none | medium | `test_desktop_test_commands_hold_the_desktop_folder`, the four new commands |
| 4 (item 1, infra) The real backend's mongod comes from a cache main fills | `.github/actions/cli-e2e-setup/action.yml`, `scripts/tests/test_cli_e2e_workflow.py` | none | high | `test_the_real_backends_mongod_comes_from_a_cache_main_fills` |
| 5 (item 1) machine.e2e: a resume right after the tmux server died | `cli/src/lib/resumeStoppedAgent.ts`, `cli/src/lib/resumeStoppedAgent.spec.ts`, `cli/src/lib/resumeAgentService.ts`, `cli/src/lib/resumeAgentService.spec.ts`, `cli/src/core/agents/discovery.ts`, `cli/src/core/agents/discovery.spec.ts`, `cli/e2e/machine.e2e.ts` | none | xhigh | found by Step 3 (the layer where the cause is), after the log evidence and a deterministic repro |
| 6 (item 1) scale.e2e: 24 binds at once are retried, bounded | `cli/src/core/agents/discovery.ts`, `cli/src/core/agents/discovery.spec.ts`, `cli/src/core/agents/newPane.ts`, `cli/src/core/agents/newPane.spec.ts`, `cli/e2e/scale.e2e.ts` | none | xhigh | `discovery.spec.ts` or `newPane.spec.ts`, the refused-bind case (Step 3); stops instead if the fix is not small |
| 7 (item 1) updates.e2e: a resume after an update that dropped resume | `cli/src/lib/resumeStoppedAgent.ts`, `cli/src/lib/resumeStoppedAgent.spec.ts`, `cli/src/lib/resumeAgentService.ts`, `cli/src/lib/resumeAgentService.spec.ts`, `cli/e2e/updates.e2e.ts`, `cli/e2e/harness/fakeEngine.mjs` | none | xhigh | found by Step 3, after the log evidence and a deterministic repro |
| 8 (item 3) A lost hook event is said when it happens; `dropped` splits in two | `cli/src/core/observedHook.ts`, `cli/src/core/observedHook.spec.ts`, `cli/src/core/deviceHookCalls.ts`, `cli/src/core/deviceHookCalls.spec.ts` | none | high | `observedHook.spec.ts`, `deviceHookCalls.spec.ts`, the at-loss cases |
| 9 (item 4) Each handled paneless event leaves one line | `cli/src/core/observedHook.ts`, `cli/src/core/observedHook.spec.ts` | 8 | high | `observedHook.spec.ts` "notes each handled paneless event in one line…" |
| 10 (item 10) The reconciler counts its passes; `/api/status` serves `discoveryPasses` | `cli/src/lib/terminalAgentReconciler.ts`, `cli/src/lib/terminalAgentReconciler.spec.ts`, `cli/src/core/main.ts` | none | high | `terminalAgentReconciler.spec.ts`, the pass-count cases |
| 11 (item 10) twodaemons waits two passes instead of sleeping | `cli/e2e/harness/daemon.ts`, `cli/e2e/twodaemons.e2e.ts`; `cli/e2e/tmuxmoves.e2e.ts`, `cli/e2e/tmuxsocket.e2e.ts`, `cli/e2e/content.e2e.ts` only for a one-line swap | 10 | high | test-only: deterministic repro (held probe), not committed |
| 12 (item 4) hookclient waits for the paneless line and two passes | `cli/e2e/hookclient.e2e.ts` | 9, 11 | medium | test-only: deterministic repro (delayed observed post), not committed |
| 13 (item 5) The handoff publication's fsyncs leave the core's loop | `cli/src/lib/handoffPublication.ts`, `cli/src/core/handoffPublication.ts`, `cli/src/core/handoffPublication.spec.ts`, `cli/src/core/handoffPublication.native.spec.ts` | none | xhigh | `handoffPublication.spec.ts` "a flush runs off the loop…" |
| 14 (item 7) `gitPath()` and `ghPath()`: one absolute git and gh per process | `cli/src/lib/gitOnPath.ts` (new), `cli/src/lib/gitOnPath.spec.ts` (new), `cli/src/lib/windows/gitBash.ts`, `cli/src/lib/windows/gitBash.spec.ts` | none | xhigh | `gitOnPath.spec.ts` |
| 15 (item 7) Every CLI git spawn runs `gitPath()`, and the pull request reader's gh `ghPath()` | `cli/src/dsh/install.ts`, `cli/src/lib/worktreeDeletion.ts`, `cli/src/lib/projectPreview.ts`, `cli/src/lib/branchNaming.ts`, `cli/src/lib/gitPullRequest.ts`, `cli/src/lib/gitPullRequest.spec.ts`, `cli/src/lib/agentProject.ts`, `cli/src/lib/gitProject.ts`, `cli/src/lib/gitProjectFolder.ts`, `cli/src/lib/agentHandoff.ts`, and the specs of those files that hide git through `PATH` (Step 1 names them) | 14 | high | `gitPullRequest.spec.ts` "runs git by its absolute path…" and "runs gh by its absolute path…" |
| 16 (item 7) Desktop's git resolver | `desktop/lib/core/git_program.dart` (new), `desktop/test/git_program_test.dart` (new) | none | xhigh | `git_program_test.dart` |
| 17 (item 7) Desktop's git spawns run the resolver's git | `desktop/lib/core/repository_clone.dart`, `desktop/lib/core/git_worktree.dart`, `desktop/lib/core/project_preview.dart`, `desktop/test/repository_clone_test.dart`, `desktop/test/git_worktree_test.dart`, `desktop/test/project_preview_test.dart` | 16 | high | the three tests' "runs the resolver's git" cases |
| 18 (item 8) Windows' folder one way: the file system's | `cli/src/lib/windows/powershell.ts`, `cli/src/lib/windows/knownFolders.ts`, `cli/src/lib/windows/systemProgram.spec.ts`, `cli/src/lib/windows/knownFolders.spec.ts`, `cli/src/lib/runtimeInstall.ts`, `cli/src/lib/runtimeInstall.spec.ts`, `cli/src/lib/uninstall/removal.ts`, `cli/src/lib/uninstall/removal.spec.ts`, `cli/src/engines/kit/windowsInstall.ts`, `cli/src/engines/kit/windowsInstall.spec.ts`, `cli/src/lib/uninstall/windowsPath.spec.ts`, `cli/src/lib/windows/powershellModules.spec.ts` | none | xhigh | `systemProgram.spec.ts` "a SystemRoot variable naming another folder is ignored" |
| 19 (item 9) One `openInBrowser`, no shell | `cli/src/lib/openInBrowser.ts` (new), `cli/src/lib/openInBrowser.spec.ts` (new), `cli/src/lib/connectors/command.ts`, `cli/src/cli.ts` | none | xhigh | `openInBrowser.spec.ts` |
| 20 (item 11) The fake `claude plugin install` and the daemon's hook install never interleave | `cli/e2e/harness/fakeEngine.mjs`, `cli/e2e/deviceDialSkill.e2e.ts`, and each e2e file Step 1 finds | none | high | test-only: deterministic repro (delayed fake write), not committed |
| 21 (item 12) No `harness auth status` while uninstall holds its marker | `desktop/lib/state/app_state.dart`, `desktop/test/daemon_readiness_test.dart`, `desktop/test/kept_sign_in_launch_test.dart` | none | high | `daemon_readiness_test.dart` and `kept_sign_in_launch_test.dart`, the uninstall cases |
| 22 (item 13a) The game viewer's test waits on the viewer's publish | `store/viewers/game-viewer/test/viewer.test.mjs` | none | medium | test-only: deterministic repro (2 s watch delay), not committed |
| 23 (item 13b) The legacy lock holder retries while FSEvents starts | `cli/src/lib/__fixtures__/registryLockOwner.cjs` | none | medium | test-only: deterministic repro (dropped first events), not committed |
| 24 (item 15) folderWatch's spec, and its callers through a stream rebuild | `cli/src/cable/hosts/folderWatch.spec.ts`; after Step 1's confirmation: `cli/src/cable/hosts/folderWatch.ts`, `cli/src/cable/hosts/unixSocket.ts`, `cli/src/cable/hosts/unixSocket.spec.ts`, `cli/src/services/devices.ts`, `cli/src/services/devices.spec.ts` | none | xhigh | spec: deterministic repro; product: the dropped-first-events case |
| 25 (item 16) `console.ps1` without CIM | `cli/scripts/windows-dial-e2e/console.ps1`, `cli/scripts/windows-dial-e2e/README.md` | none | high | none: Windows tooling script; the evidence is the VM run (Verification 3) |
| 26 (items 7, 8, 9, 16) Windows rules for what this batch learned | `docs/windows-rules.md` | 14, 18, 19, 25 | medium | none: docs, one commit |

Longest chain of dependent tasks: three (8 → 9 → 12, and 10 → 11 → 12). Others: 14 → 15, 16 → 17, and 14, 18, 19,
25 → 26. Files shared by tasks that do not depend on each other, so devcrew runs them one after the other:
`scripts/ci-plan.py`, `scripts/tests/test_ci_plan.py` and `docs/validation-and-release.md` (1, 2);
`cli/src/core/agents/discovery.ts` and its spec (5, 6); the two resume files and their specs (5, 7);
`cli/e2e/harness/fakeEngine.mjs` (7, 20).

## Global Constraints

- Each fix removes the cause: no test is loosened, no timeout is raised as the fix, no fixed sleep is added, nothing is
  rerun to green (spec, Intent). A temporary repro injection is never committed.
- "A fix covers every case of the same cause": each task covers the siblings the spec names, and says which it found.
- No new feature, setting, screen or copy. `cli/src/architecture.coreFiles.txt` gains no file (spec, Non-goals): the new
  `lib/gitOnPath.ts` and `lib/openInBrowser.ts` are loaded by no core file, and `systemRoot` moves into
  `lib/windows/powershell.ts`, which is already listed.
- Core files this plan may touch (the spec's list, plus `core/deviceHookCalls.ts` and the two `core/agents/` files
  item 1's races may need): `core/observedHook.ts`, `core/deviceHookCalls.ts`,
  `core/handoffPublication.ts`, `core/main.ts`, `core/agents/discovery.ts`, `core/agents/newPane.ts`,
  `lib/handoffPublication.ts`, `lib/terminalAgentReconciler.ts`, `lib/windows/powershell.ts`. `npm run test:core` holds
  every `src/core/**` and `src/services/**` file but `core/main.ts` to 100% statements, branches, functions and lines per
  file (`vitest.core.config.ts`): a task touching one runs it green. `src/architecture.spec.ts` stays green.
- No secrets, session ids, paths, engine names in loss lines, or other identifiers in any new log line (spec,
  Constraints; AGENTS rule 7). Item 4's line names the engine and the event only.
- Tests never touch the developer's own daemon (port 18473), homes, `~/.claude`, `~/.codex` or tmux server: isolated
  daemons (`IsolatedDaemon`), throwaway homes.
- Heavy GitHub runs (`cli-e2e.yml`, `windows.yml`, `windows-desktop.yml`) and the shared Windows ARM VM
  (192.168.64.5) only on harness-pm's go, one at a time. No temporary workflow: nothing under `.github/workflows/` is
  added for a check. The Dell is offline until Monday.
- Platforms: macOS, Linux, Windows x64 and ARM64 (CLI); macOS, Windows, Linux (Desktop). A new Windows rule goes into
  `docs/windows-rules.md` (Task 26).
- Out of scope: `lib/secureState.ts` and `engines/kit/folderTrust.ts` fsyncs; moving the handoff out of the core;
  `on:` in `ci.yml` selecting suites; `twodaemons.e2e.ts:221`'s 1 s sleep; the other reconcile-pass sleeps unless a
  one-line swap (Task 11).

## Decided here, where the spec left it to the builder

- **Item 1, apt:** already fixed on main by #4190 (`scripts/apt-install.sh`, 2026-11-12, after run 43039005877): three
  attempts, each logged, a doubling wait, each command bounded. No task. Item 1's infra task is the mongod cache only.
- **Item 1, mongod cache:** restored on every run, saved only by `main`'s runs (the nightly), as `backend-cache.yml`
  does for the integration shards (#2804, #2822: a PR's cache is that PR's alone). The hit path is first exercised by
  the first nightly after merge (Verification 4).
- **Item 3:** `onObserved` still answers `'ok' | 'invalid' | 'dropped'` (`hookServer.ts:71` only tells `invalid`), so
  `hookServer.ts` and its spec do not change; the split lives in the counts and lines. A refused body has no at-loss
  line of its own (the spec names two); it is counted in the minute's line. "No devices" is said at the first such loss
  after devices were last seen up, the daemon's start counting as seen up, so a machine with no dial says it once. The
  minute line counts every loss not said at once, "no devices" included, as the spec's example line does.
  `deviceHookCalls` says `[devices] a dial hook call was refused; more are counted once a minute` and
  `[devices] a dial hook call was over the bound; more are counted once a minute`, and keeps its minute line.
- **Item 4:** the per-event line is written for each event the rate limit admits: `· forwarded` or `· no devices`. An
  event over the rate, or refused, writes no per-event line: "under the limit's refusal the item 3 lines speak instead"
  (spec), which is also what keeps the line bounded at 20 a second per session.
- **Item 7, CLI:** `gitPath()` is async (the login-shell ask is), caches a found path only (a git installed after the
  daemon started is found on the next call, Review Focus 2), skips every relative `PATH` entry on every OS, and when
  nothing is found rejects with the error a spawn of a missing `git` gives (`code: 'ENOENT'`, `syscall: 'spawn git'`,
  `path: 'git'`, message `spawn git ENOENT`), so each caller's handling is unchanged. The Git for Windows roots come
  from one list in `lib/windows/gitBash.ts`, which `findGitBash` keeps using.
- **Item 7, `gh` (orchestrator's answer to Q2):** the pull request reader's `gh` (`lib/gitPullRequest.ts:96`, `:112`,
  `:184`) runs by `ghPath()`, in Task 15. One resolver for both, in `lib/gitOnPath.ts` (Task 14): one internal search
  that each program calls with its own Windows folders, and one cached finder; `gitPath()` and `ghPath()` are its two
  instances, so git and gh are found the same way (absolute `PATH` entries only on every OS, then the login shell on
  macOS/Linux; on Windows `gh.exe` alone, never the working folder). gh's Windows folders: the GitHub CLI installer's
  `<ProgramFiles|ProgramW6432|ProgramFiles(x86)>\GitHub CLI\gh.exe` (winget installs the same MSI), then
  `<scoop>\shims\gh.exe`; no other folder. A missing gh rejects with `spawn gh ENOENT` (`path: 'gh'`), which the
  reader's catches already turn into `unavailable`. The file keeps the spec's name: gh is git's GitHub companion and has
  no caller outside the pull request reader.
- **Item 7, Desktop:** four spawns, not five: `shortcuts/keymap_commands.dart:417` is the "Branches and pull requests"
  command's search keyword, not a spawn. Desktop has no lookup that returns a login shell's path for a command
  (`environment_provisioner.dart` `_probeShell` answers an exit code only), so the resolver adds none (spec).
- **Item 12, boot (orchestrator's answer to Q1):** while `discovery.spawnHeld()`, boot takes the path a failed
  `harness auth status` takes today and ends on the sign-in page, with no new copy. One private
  `AppNotifier._checkAuthStatus()` replaces `cliLogin.checkStatus()` at the three boot sites (the early check `:5864`,
  `:6119`, the kept sign-in's confirmation `:6200`): held, it throws `CliNotAvailableException` without running the
  CLI. So the early check resolves to null (its `catchError`), `:6119` throws into the existing catch (`:6142`:
  `AppStatus.unauthenticated`, `_lastError` only for a viewer, as today), and the kept window's confirmation gets no
  answer, so the launch starts again from the CLI and ends there too. The down branch (`:7008`) keeps its own guard,
  since it throws its `StateError` either way.
- **Item 8:** `ComSpec` (`engines/kit/windowsInstall.ts:103`) is the same cause, a variable the caller sets choosing
  which Windows program runs, and goes to `systemProgram('cmd.exe')` with the two inline siblings.
- **Item 9:** the one `openInBrowser` keeps the Harness OS browser (`/usr/bin/hn-browser` when it exists) that the
  connectors' copy has; sign-in gains it.
- **Item 15:** if one change in `watchNearest` covers every caller (a re-check of the disk once a watch is live), it goes
  there, not into each caller ("one way").
- **Windows rules:** items 7, 8, 9 and 16 are Windows mistakes, so each gets its rule in one docs task (26), keeping the
  code tasks apart.

## Review Focus

1. **A `PATH` with a relative entry** (`.`, empty, `tools`) and a `git` or `git.exe` in the working folder: the answer
   is never that file, on any OS; expected the absolute git elsewhere on `PATH` or in Git for Windows' folders. Test:
   Task 14, `gitOnPath.spec.ts` "skips relative PATH entries on every platform"; Desktop, Task 16 the same case.
2. **Git installed after the daemon started:** the next git call finds it; a person told "Install Git, then try again"
   can. Test: Task 14 "a miss is asked again; a find is kept"; Task 16 the same.
3. **An uninstall that ends:** once `~/.harness/uninstalling` is gone, Desktop's next readiness check asks
   `harness auth status` again, once. Test: Task 21, the marker-released case.
4. **A URL with `%`, `^`, `&`, a quote, whitespace, or a `file:` or `javascript:` scheme:** `&` and `%` reach the
   browser untouched in one argument; the others are not opened (the URL is printed as before). Test: Task 19's cases.
5. **Two Change agent requests for the same key while the first awaits a flush:** the second is refused `BUSY`, and a
   project path replaced during a flush is held with no link or rename after it. Test: Task 13 "a second publication of
   the same key while a flush is pending is BUSY" and the moved slow-flush cases.

---

### Task 1 (item 2a): A change to ci.yml's top-level `concurrency` runs every job's suite; `on:` documented

**Files:**
- Modify: `scripts/ci-plan.py:530-562` (`edited_job_suites`, its docstring and the tuple at `:545`)
- Test: `scripts/tests/test_ci_plan.py:925-955`
- Docs: `docs/validation-and-release.md:85` (the "anything else" row)

**Depends on:** none. **Effort:** medium.

- [ ] **Step 1: Write the failing subcase.** `workflow()` gains `concurrency="ci"`, written after `permissions` as
  `concurrency:\n  group: {concurrency}\n`; the loop gains `({}, dict(concurrency="other"), {"cli", "pty", "tui", "desktop"})`.
- [ ] **Step 2: Run** `python3 -m unittest discover -s scripts/tests -p test_ci_plan.py -k test_what_a_job_takes_from_the_rest_of_ci_yml -v`.
  Expected: FAIL, the concurrency subcase selects no suite.
- [ ] **Step 3: Implement:** the tuple is `("permissions", "defaults", "concurrency")`; the docstring names it.
- [ ] **Step 4: Docs:** the row names "the permissions, defaults and concurrency"; one sentence after the table: `on:`
  selects no suite, because every new suite adds a manual `scope` option there and reading it as the whole file would
  run every suite on each such change.
- [ ] **Step 5: Run** the whole file (`python3 -m unittest discover -s scripts/tests -p test_ci_plan.py`): green.
- [ ] **Step 6: Commit** `test(scripts): a change to ci.yml's concurrency runs every job's suite (red)`, then
  `fix(scripts): a change to ci.yml's top-level concurrency runs every job's suite`.

### Task 2 (item 2b): The cross-read scan runs on every PR that changes a component

**Files:**
- Modify: `scripts/ci-plan.py:82-88` (the comment above the `cross-read-scan` paths), `:489-503` (`select`)
- Test: `scripts/tests/test_ci_plan.py:438-453`, and every test whose exact `select` set for a component path gains
  `cross-read-scan` (Step 4 names them)
- Docs: `docs/validation-and-release.md:85` and `:113-120` (the `cross-read-scan` paragraph)

**Depends on:** none (shares its files with Task 1). **Effort:** high.

- [ ] **Step 1: Write the failing cases** in `test_the_planner_its_tables_and_every_suites_own_files_run_the_cross_read_scan`:
  `cli/src/x.ts`, `cli/src/lib/relayFrames.ts`, `desktop/lib/devices/x.dart`, `backend/src/app.ts`, `pty/src/stream.rs`
  and `devices/harness-pro/firmware/main/app/pro_app.c` assert `cross-read-scan` in `planner.select([path])[0]` (the two
  that today assert it is not there move); `scripts/local-checks.py`, `scripts/tests/test_pr_e2e_jobs.py`,
  `.github/workflows/ci.yml` and `docs/guide.md` still assert it is not.
- [ ] **Step 2: Run** `python3 -m unittest discover -s scripts/tests -p test_ci_plan.py -k cross_read -v`. Expected:
  FAIL on the component paths.
- [ ] **Step 3: Implement** in `select`: a path whose `owners(path)` holds any suite other than `cross-read-scan` adds
  `cross-read-scan`. `owners()` is unchanged (`test_each_component_owns_only_its_own_suite` stays as it is). The comment
  says why: an undeclared read an ordinary component PR adds was found only by the next planner PR or `make merge-pr`'s
  reuse check; the scan costs about 0.5 runner-minutes (measured in #4526).
- [ ] **Step 4: Run the whole file.** Each failure that is an exact set for a component path gaining
  `cross-read-scan` is updated to include it; any other failure is a bug in Step 3. Name the updated tests in the report.
- [ ] **Step 5: Docs:** the paragraph says the scan runs on every PR that changes a component, and that a string the scan
  reads as an undeclared path blocks the PR until it is declared in `PR_READS`/`DEPENDS`, or added to `NOT_READS` with
  its reason when it is no read. The "anything else" row stays (docs, workflows and scripts alone do not select it).
- [ ] **Step 6: Run** `python3 -m unittest discover -s scripts/tests -p 'test_*.py'` and the scan itself:
  `CROSS_READ_SCAN_REQUIRED=1 python3 -m unittest discover -s scripts/tests -p test_ci_plan.py -k test_every_cross_read_in_this_repository_is_declared -k test_every_declared_input_exists -k test_the_dial_host_files_are_the_ones_cli_e2e_leaves_out -k test_every_desktop_file_the_phone_tests_read_selects_mobile -v`:
  green.
- [ ] **Step 7: Commit** `test(scripts): a component change runs the cross-read scan (red)`, then
  `fix(scripts): the cross-read scan runs on every pull request that changes a component`.

### Task 3 (item 14): Every way of running `flutter test` holds its folder

**Files:**
- Modify: `scripts/validate-change.py:234-244` (`flutter_test_folder`)
- Test: `scripts/tests/test_validate_change.py:108-122`

**Depends on:** none. **Effort:** medium.

- [ ] **Step 1: Write the failing cases** in `test_desktop_test_commands_hold_the_desktop_folder`, each with
  `"cwd": "desktop"`: `[tool, "-d", "macos", "test"]`, `[tool, "--device-id", "macos", "test"]`, `[bat, "test"]`
  (`bat`: the stand-in copied as `tools/flutter.bat`, mode 0o755) and `[fvm, "flutter", "test"]` (`fvm`: a script in
  `tools/` that execs `tool` with its arguments after `flutter`). The status dict and the no-overlap assertion cover
  them.
- [ ] **Step 2: Run** `python3 -m unittest discover -s scripts/tests -p test_validate_change.py -k desktop_test_commands -v`.
  Expected: FAIL (an overlap, exit 3).
- [ ] **Step 3: Implement:** a run is a flutter test when its program is flutter (`Path(argv[0]).name` is `flutter` or
  `flutter.bat`, or it is `fvm` and `argv[1] == "flutter"`) and `"test"` is among its arguments. The comment adds:
  holding a folder by mistake only serialises checks.
- [ ] **Step 4: Run** the whole file: green.
- [ ] **Step 5: Commit** `test(scripts): every way of running flutter test holds its folder (red)`, then
  `fix(scripts): -d, --device-id, flutter.bat and fvm runs of flutter test hold their folder`.

### Task 4 (item 1, infra): The real backend's mongod comes from a cache main fills

**Files:**
- Modify: `.github/actions/cli-e2e-setup/action.yml` (the "Set up the real backend" step, split into steps)
- Test: `scripts/tests/test_cli_e2e_workflow.py`

**Depends on:** none. **Effort:** high.

- [ ] **Step 1: Write the failing test `test_the_real_backends_mongod_comes_from_a_cache_main_fills`** (static, as the
  file's others): the action has, each under `if: inputs.real-backend == 'true'`, (a) a step with an `id` whose run
  prints mongodb-memory-server's installed version to `$GITHUB_OUTPUT` and writes
  `MONGOMS_DOWNLOAD_DIR=${{ runner.temp }}/mongodb-binaries` to `$GITHUB_ENV`; (b) `actions/cache/restore@v4` with that
  `path` and a key holding that version output, `runner.os` and `runner.arch`; (c) on a miss, a step that downloads
  through that installed package's `MongoBinary.getPath()`; (d) `actions/cache/save@v4` with the same path and key, whose
  `if` requires a miss and `github.ref == 'refs/heads/main'`. Every run step keeps `shell: bash`.
- [ ] **Step 2: Run** `python3 -m unittest discover -s scripts/tests -p test_cli_e2e_workflow.py -v`: FAIL.
- [ ] **Step 3: Implement** the steps. The comment names run 43902144004 (2026-11-16: fastdl.mongodb.org answered 504)
  and why only main saves (#2804, #2822). `e2e/harness/realBackend.ts` is unchanged: mongodb-memory-server reads
  `MONGOMS_DOWNLOAD_DIR`. The apt steps are unchanged (#4190, Decided here).
- [ ] **Step 4: Run** the file and `python3 -m unittest discover -s scripts/tests -p 'test_*.py'` (green); `actionlint`
  if installed.
- [ ] **Step 5: Commit** `test(ci): the real backend's mongod comes from a cache (red)`, then
  `fix(ci): the e2e setup restores mongod from a cache main's nightly fills`.

### Task 5 (item 1): machine.e2e: a resume right after the tmux server died

**Files:** may touch `cli/src/lib/resumeStoppedAgent.ts`, `cli/src/lib/resumeAgentService.ts`,
`cli/src/core/agents/discovery.ts`, their specs, and `cli/e2e/machine.e2e.ts:96, :106`.

**Depends on:** none. **Effort:** xhigh (resume ownership; core).

- [ ] **Step 1: Evidence, read-only.** `gh run view 44764451448 --log-failed` (2026-11-20, shard 2) and its daemon-log
  artifact (`gh run download 44764451448 -D <scratchpad>/run-44764451448`, an empty folder of its own; kept 7 days,
  until 2026-11-27). Name which check returned `resumeChanged`: `resumeStoppedAgent.ts:35` (`!deps.current()`), `:51`
  (the live identity changed across `checkLive`), or one of `resumeAgentService.ts:147-177`'s `ownsRoute()`, and the
  cleanup it raced (the log lines in order, ids cut). No dispatch.
- [ ] **Step 2: Reproduce (temporary):** a delay injected at that cleanup, so
  `npx vitest run --config vitest.e2e.config.ts e2e/machine.e2e.ts -t "codex: the tmux server dies mid-turn"` fails with
  `AGENT_CHANGED` on every run here. Record 3 of 3.
- [ ] **Step 3: Decide (spec):** if the row reads stopped before the cleanup resume depends on has finished, it is a
  product bug: write the failing unit test at that layer (`resumeStoppedAgent.spec.ts`, `resumeAgentService.spec.ts` or
  `discovery.spec.ts`) "a resume asked the moment the row reads stopped after its pane died opens the conversation",
  with the race as a held seam, run it (FAIL), then fix the order (the row reads stopped only once it can be resumed) or
  make resume wait for that cleanup, bounded. Only if the product is right does `machine.e2e.ts:96` wait on the
  condition resume needs (no sleep), and that is a test-only commit.
- [ ] **Step 4: Sibling** "engine dies mid-turn" (`:106`): the same check, the same fix or a reason it cannot race.
- [ ] **Step 5: Run** the touched specs, `npm run test:core` (100% on `core/agents/discovery.ts`), `npm run test:resume`
  (100% on the resume files), the repro (passes 10 of 10), then remove it and run `e2e/machine.e2e.ts` three times: green.
- [ ] **Step 6: Commit** `test(cli): a resume right after its tmux server died (red)`, then
  `fix(cli): <the cause, in a person's words>`; the evidence and the repro's numbers in the body.

### Task 6 (item 1): scale.e2e: 24 binds at once are retried, bounded

**Files:** may touch `cli/src/core/agents/discovery.ts:60-90`, `cli/src/core/agents/newPane.ts:240-260`, their specs,
`cli/e2e/scale.e2e.ts`.

**Depends on:** none (shares `discovery.ts` with Task 5). **Effort:** xhigh (binding; core).

- [ ] **Step 1: Evidence first, read-only:** download the artifacts of runs 44122409739 (2026-11-17, expires
  2026-11-24) and 44339410126 (2026-11-18, expires 2026-11-25) before anything else, then `gh run view --log-failed`.
  From the daemon logs: each `Conversation identity is held: the observed process changed before publication`
  (`discovery.ts:84`) and `readiness publication unavailable` (`newPane.ts:256`), what refused it, and why no later pass
  bound that agent.
- [ ] **Step 2: Reproduce:** at the unit layer, `resolvePaneEngineProcess` answering a different identity at
  publication than at the probe, once, for one of several agents bound at once: today the bind is refused and never
  tried again. Then, temporary, the same flip injected in the daemon so `e2e/scale.e2e.ts` times out here every run.
- [ ] **Step 3: Gate (orchestrator's decision):** the fix is in this PR only if it is a bounded retry of the refused
  bind, or the removal of the refusal's false positive, within the files above and keeping the binding's contract. If it
  is not, stop: nothing committed, and report the evidence and the redesign it needs (it becomes its own item).
- [ ] **Step 4: Write the failing test** (`discovery.spec.ts` or `newPane.spec.ts`): "a bind refused because the
  process read changed before publication is tried again, at most N times, and binds once the read holds; past N it
  stays refused and says so". Run: FAIL.
- [ ] **Step 5: Implement** with N and the wait between attempts named in a comment with the measured reason; each
  attempt's log line carries counts and fixed text only.
- [ ] **Step 6: Run** the specs, `npm run test:core`, the repro (passes), then remove it and run `e2e/scale.e2e.ts` three
  times: green.
- [ ] **Step 7: Commit** `test(cli): 24 binds at once (red)`, then `fix(cli): a bind refused by a changed process read is
  retried, bounded`.

### Task 7 (item 1): updates.e2e: a resume after an update that dropped resume

**Files:** may touch `cli/src/lib/resumeStoppedAgent.ts`, `cli/src/lib/resumeAgentService.ts`, their specs,
`cli/e2e/updates.e2e.ts:170-215`, `cli/e2e/harness/fakeEngine.mjs` (the fake's `install`).

**Depends on:** none (shares files with Tasks 5 and 20). **Effort:** xhigh.

- [ ] **Step 1: Evidence, read-only:** `gh run view 43247147594 --log-failed` and `gh run view 43445009338 --log-failed`
  (2026-11-12, -13; their artifacts expired). Expected `RESUME_FAILED`, got `resumed: true`: find what the resume path
  read of the engine (its version, its `resume` support, its binary) and when the update became visible to it.
- [ ] **Step 2: Reproduce:** the race held open on purpose (the spec's likely cause: the update not yet visible to the
  resume path when the test resumes), so the case reads `resumed: true` on every run here. Record.
- [ ] **Step 3: Decide as Task 5 Step 3:** a product race gets its failing unit test at the resume layer and the fix
  at the cause; a fake engine whose update is not atomic is fixed in `fakeEngine.mjs` (written then renamed) with the
  repro as evidence (test-only, one commit).
- [ ] **Step 4: Run** the specs, `npm run test:resume`, the repro (passes), then remove it and run `e2e/updates.e2e.ts`
  three times: green.
- [ ] **Step 5: Commit** red then fix, or one test-only commit, as Step 3 decided.

### Task 8 (item 3): A lost hook event is said when it happens; `dropped` splits in two

**Files:**
- Modify: `cli/src/core/observedHook.ts:112-166` (`minuteCounts`, `createObservedHook`), `cli/src/core/deviceHookCalls.ts:74-77`
- Test: `cli/src/core/observedHook.spec.ts:197-232`, `cli/src/core/deviceHookCalls.spec.ts`

**Depends on:** none. **Effort:** high (core).

**Interfaces:**
- Produces (replaces today's `minuteCounts`):

```ts
/** Each loss: said at once when [lines.now] gives a line and its kind was not said in this minute, else counted. A
 *  minute after the first loss, one line of the counts, only when one was counted. Counts and fixed text only. */
export function minuteCounts<K extends string>(kinds: readonly K[],
  lines: { now: (kind: K) => string | null; minute: (counts: Readonly<Record<K, number>>) => string },
  log: (line: string) => void): (kind: K) => void
```

  `createObservedHook` counts `'invalid' | 'over' | 'no-devices'` (over: the rate or a full counter table, `take()`;
  no-devices: `forward()` false) and keeps `onObserved`'s return type.

- [ ] **Step 1: Write the failing tests** (fake timers):
  - `observedHook.spec.ts` "says the first loss at once and the minute's count only if more came": 21 events in a
    second → exactly `[devices] a paneless hook event was dropped: over 20 a second for its session; more are counted once a minute`
    at once; 5 more over the rate: nothing; at 60 s `[devices] paneless hook events in the last minute: 0 refused, 5 over the rate, 0 with no devices process`;
    60 s more: nothing.
  - "one loss in a minute is said once": one over-the-rate loss, then 60 s → that one line only.
  - "no devices is said once a devices-down period": `forward` false → `[devices] a paneless hook event was dropped: no devices process; more are counted once a minute`
    at once; more → counted; in a later minute, still down → no at-once line, its count in that minute's line; one
    `forward` true, then false again → the at-once line again.
  - the existing title case: refused bodies log nothing at once; at 60 s `… 2 refused, 0 over the rate, 0 with no devices process`.
  - every case: `JSON.stringify(log.mock.calls)` has no session id, path, hint value or engine name.
  - `deviceHookCalls.spec.ts`: the first refused and the first over-the-bound call each say their line (Decided here) at
    once; the minute line `[devices] dial hook calls in the last minute: N refused, M over the bound` comes only if more came.
- [ ] **Step 2: Run** `npx vitest run src/core/observedHook.spec.ts src/core/deviceHookCalls.spec.ts`: FAIL.
- [ ] **Step 3: Implement** the signature above; both callers use it; the timer stays unref'd.
- [ ] **Step 4: Run** the two specs and `src/hookServer.spec.ts` (green), then `npm run test:core` (100% on both files).
- [ ] **Step 5: Commit** `test(cli): hook losses are said when they happen (red)`, then
  `fix(cli): a lost paneless hook event is logged at once, over the rate apart from no devices`.

### Task 9 (item 4): Each handled paneless event leaves one line

**Files:** Modify `cli/src/core/observedHook.ts` (`ObservedHookDeps`, `onObserved`); Test `cli/src/core/observedHook.spec.ts`.

**Depends on:** 8. **Effort:** high (core).

**Interfaces:**
- Produces: `ObservedHookDeps.note?: (line: string) => void`, default `console.log` (loss lines keep `log`). The line:
  `[hooks] paneless ${event.engine} ${event.event} · forwarded` or `… · no devices`.

- [ ] **Step 1: Write the failing test** "notes each handled paneless event in one line, with no session or path":
  `forward` true → `note` called once with `[hooks] paneless claude turn-start · forwarded`; false →
  `[hooks] paneless claude turn-start · no devices`; the 21st in a second and an invalid body → no `note` call; the
  notes hold none of `sessionId`, `cwd`, `transcriptPath`, a hint value.
- [ ] **Step 2: Run** `npx vitest run src/core/observedHook.spec.ts`: FAIL.
- [ ] **Step 3: Implement.** `core/main.ts` passes nothing new (the default is the daemon's log).
- [ ] **Step 4: Run** the spec and `npm run test:core` (green, 100%).
- [ ] **Step 5: Commit** `test(cli): a paneless hook event's line (red)`, then
  `fix(cli): each paneless hook event the daemon handles leaves one line`.

### Task 10 (item 10): The reconciler counts its passes; `/api/status` serves `discoveryPasses`

**Files:**
- Modify: `cli/src/lib/terminalAgentReconciler.ts:280-287` (`drain`, a field beside `probeGivenUp`),
  `cli/src/core/main.ts:2218` (beside `discoveryReady`)
- Test: `cli/src/lib/terminalAgentReconciler.spec.ts`

**Depends on:** none. **Effort:** high (core).

**Interfaces:**
- Produces: `TerminalAgentReconciler.passes: number` (a getter): passes whose `reconcileOnce` returned with a probe
  that was not given up; a pass that throws is not counted. `/api/status` field `discoveryPasses: number`.

- [ ] **Step 1: Write the failing tests:** "counts each completed pass once" (an injected `probe` answering at once;
  three `trigger()`s, one of them coalesced into a running drain, → `passes` equals the passes run); "a given-up probe
  is no pass" (`passDeadlineMs` 10 and a probe that never answers, fake timers → `trigger()` resolves false, `passes`
  0); "a pass that throws is no pass".
- [ ] **Step 2: Run** `npx vitest run src/lib/terminalAgentReconciler.spec.ts`: FAIL.
- [ ] **Step 3: Implement** the count in `drain()` after `reconcileOnce()` when `!this.probeGivenUp`, and the status
  field (`agentReconciler.passes`). A comment says what it is for: an e2e "nothing happened" check waits two more
  passes, so one full pass began after the change.
- [ ] **Step 4: Run** the spec, `src/lib/terminalAgentReconciler.wrapperExec.spec.ts`, `src/architecture.spec.ts`,
  `npm run typecheck` and `npm run test:core` (green).
- [ ] **Step 5: Commit** `test(cli): the reconciler counts its passes (red)`, then
  `fix(cli): /api/status says how many discovery passes have completed, so a check can wait on them`.

### Task 11 (item 10): twodaemons waits two passes instead of sleeping

**Files:**
- Modify: `cli/e2e/harness/daemon.ts` (`IsolatedDaemon`), `cli/e2e/twodaemons.e2e.ts:113, 127, 133, 339`
- May modify, only where it is a one-line swap: `cli/e2e/tmuxmoves.e2e.ts:106`, `cli/e2e/tmuxsocket.e2e.ts:69`,
  `cli/e2e/content.e2e.ts:89`

**Depends on:** 10. **Effort:** high. **Red:** test-only, deterministic repro (not committed). One commit.

**Interfaces:**
- Consumes Task 10's `discoveryPasses`.
- Produces: `IsolatedDaemon.discoveryPasses(): Promise<number>` (`/api/status` with `localHeaders()`; throws when the
  field is not a number) and `IsolatedDaemon.twoMorePasses(what: string): Promise<void>` (reads `n` now, then
  `until(what, passes >= n + 2, 60_000, 250)`).

- [ ] **Step 1: Reproduce (temporary):** hold each probe 15 s in the working tree (an injected wait in the reconciler's
  probe), then run `npx vitest run --config vitest.e2e.config.ts e2e/twodaemons.e2e.ts -t "a dev daemon beside the release one"`
  on the old test with a print of `discoveryPasses` before and after the 12 s sleep: it passes with no pass in between.
- [ ] **Step 2: Change:** the two methods; each sleep becomes `await <daemon>.twoMorePasses('<what>')` on the daemon
  whose pass the assertion is about, called after the test's last create, delete or restart. Look at the three other
  files: swap a sleep only where it is that one line; list the rest in the report.
- [ ] **Step 3: Run** with the injection: the new test waits (passes once passes run). Remove it; run `e2e/twodaemons.e2e.ts`
  (and any swapped file) three times: green.
- [ ] **Step 4: Commit** `test(cli): twodaemons waits two discovery passes, not a fixed time`, the repro in the body.

### Task 12 (item 4): hookclient waits for the paneless line and two passes

**Files:** Modify `cli/e2e/hookclient.e2e.ts:386-393`.

**Depends on:** 9, 11. **Effort:** medium. **Red:** test-only, deterministic repro (not committed). One commit.

- [ ] **Step 1: Reproduce (temporary):** delay the daemon's handling of `/api/hook/observed` 8 s in the working tree; the
  old case passes, and the daemon's log shows its `[hooks] paneless … turn-start` line after the assertion ran.
- [ ] **Step 2: Change:** `const from = d.log().length` after `d.start()`; after the prompt's hook ran, `until` the line
  `[hooks] paneless <engine> turn-start` in `d.log().slice(from)`, then `await d.twoMorePasses('two passes after the prompt')`,
  then the existing assertion. The 6 s sleep goes.
- [ ] **Step 3: Run** with the injection (the new case waits, then passes), remove it, then
  `npx vitest run --config vitest.e2e.config.ts e2e/hookclient.e2e.ts` (green).
- [ ] **Step 4: Commit** `test(cli): hookclient waits for the paneless event and two passes`.

### Task 13 (item 5): The handoff publication's fsyncs leave the core's loop

**Files:**
- Modify: `cli/src/lib/handoffPublication.ts` (`Flushes.flush` `:36-41`, `sync` `:54-68`, `createFile` `:69-82`,
  `directory` `:83-91`, and in `publishHandoff` `save` `:154-166`, `confirmIgnore`, `guards`, `confirmed`, `durable`
  and every call of them); `cli/src/core/handoffPublication.ts:127-129` (the "without yielding" comment goes)
- Test: `cli/src/core/handoffPublication.spec.ts` (`:59-139` move to the async mock), `cli/src/core/handoffPublication.native.spec.ts`
  (only if it spies `fsyncSync`)

**Depends on:** none. **Effort:** xhigh (durability, new interleavings, core).

**Interfaces:**
- Produces: `Flushes.flush(fd: number, info: BigIntStats): Promise<void>`, awaiting `fsync` from `node:fs` (promisified;
  libuv's threadpool, F_FULLFSYNC on macOS as `fsyncSync`) on the fd `openSync` gave, closed after the await;
  `sync(...)`, `createFile(...)`, `directory(...)` return `Promise` of today's result. `publishHandoff`'s signature is
  unchanged.

- [ ] **Step 1: Measure before** on this Mac (temporary, not committed): the core's event-loop delay, `maxMs` and
  `p99Ms`, through `e2e/harness/corePerf.cjs` started as `e2e/perf.e2e.ts:170-200` starts it (`NODE_OPTIONS`
  `--require`, `HARNESS_E2E_PERF_DIR`, `HARNESS_E2E_PERF_TOKEN`), its `/start` and `/end` around one
  `agent_handoff_prepare` of `e2e/handoff.e2e.ts:74`'s case, five runs; and `[handoff-budget]` from
  `npx vitest run src/core/handoffPublication.native.spec.ts`, five runs. Record medians, the machine and its load.
- [ ] **Step 2: Write the failing tests:** "a flush runs off the loop: a setImmediate callback runs while it is pending,
  and fsyncSync is never called" (`fs.fsync` mocked to call back after a held promise; a `setImmediate` set before the
  publish runs before that promise is released; `fsyncSync` spied, 0 calls); Review Focus 5's "a second publication of
  the same key while a flush is pending is BUSY"; the slow-flush cases at `:59-139` on the async mock (their clock moves
  inside the mocked `fsync`).
- [ ] **Step 3: Run** `npx vitest run src/core/handoffPublication.spec.ts`: FAIL.
- [ ] **Step 4: Implement:** each step awaited in order (write tmp → fsync → link/rename → fsync directory → read
  back); `fence()` and `checkRequest()` stay immediately before every `linkSync`/`renameSync` (`:161-162`, `:260`, `:293`,
  `:310`) with no await between them and it; the `publications` map still holds each key across every await.
- [ ] **Step 5: List every state read before an await and used after it** (`receipt`, `previous`, the open fd, the
  route snapshots, `flushes.done`, the lock map, `prepared.exclude`) with, for each, the re-check after the await or why
  it cannot change; the list goes in the commit body.
- [ ] **Step 6: Run** the spec, the native spec, `npm run test:core` (100% on `core/handoffPublication.ts`),
  `npm run typecheck`, and `npx vitest run --config vitest.e2e.config.ts e2e/handoff.e2e.ts` (green).
- [ ] **Step 7: Measure after** as Step 1; both sets in the commit body.
- [ ] **Step 8: Commit** `test(cli): the handoff publication flushes off the loop (red)`, then
  `fix(cli): the handoff publication's fsyncs run on libuv's threadpool, in the same order`.

### Task 14 (item 7): `gitPath()` and `ghPath()`: one absolute git and gh per process

**Files:**
- Create: `cli/src/lib/gitOnPath.ts`, `cli/src/lib/gitOnPath.spec.ts`
- Modify: `cli/src/lib/windows/gitBash.ts:27-48` (its roots become exported lists), `cli/src/lib/windows/gitBash.spec.ts`
  (stays green)

**Depends on:** none. **Effort:** xhigh (security: Windows' working-folder lookup).

**Interfaces:**
- Produces:

```ts
export type Program = 'git' | 'gh'
export interface ProgramSearch {
  platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; isFile?: (path: string) => boolean
  /** macOS and Linux: where the login shell finds the program (tmuxOnPath.ts `resolveViaLoginShell`). */
  loginShell?: () => Promise<string | null>
}
/** The absolute path of the git (or gh) to run, or null. Never a file in the working folder. */
export function findGit(search?: ProgramSearch): Promise<string | null>
export function findGh(search?: ProgramSearch): Promise<string | null>
/** A cached finder: a found path is kept for the process; a miss asks again next time; none rejects with spawn's
 *  ENOENT error for `name`. */
export function createProgramPath(name: Program, find: () => Promise<string | null>): () => Promise<string>
export const gitPath: () => Promise<string>   // createProgramPath('git', () => findGit())
export const ghPath: () => Promise<string>    // createProgramPath('gh', () => findGh())
// lib/windows/gitBash.ts
export function programFilesRoots(env: NodeJS.ProcessEnv): string[]   // ProgramFiles, ProgramW6432, ProgramFiles(x86)
export function gitForWindowsRoots(env: NodeJS.ProcessEnv): string[]  // <each programFilesRoots>\Git, <LOCALAPPDATA>\Programs\Git
export function scoopRoots(env: NodeJS.ProcessEnv): string[]          // SCOOP, ~\scoop, SCOOP_GLOBAL, ProgramData\scoop
```

  `findGit` and `findGh` are one internal search given the program's name and its Windows folders (Decided here). Order:
  macOS/Linux `resolveBinaryOnPath(name, env, isAbsolute)`, then the login shell. Windows: each absolute `PATH` entry's
  `<name>.exe` (never `.cmd`), then the program's folders: git `<root>\cmd\git.exe` for each Git root, then
  `<scoop>\shims\git.exe`; gh `<programFilesRoot>\GitHub CLI\gh.exe`, then `<scoop>\shims\gh.exe`.

- [ ] **Step 1: Write the failing tests** in `gitOnPath.spec.ts`: Windows simulated, a `git.exe` "in the working
  folder" and `PATH` `.;;tools;C:\Tools` with `isFile` true for `.\git.exe`, `tools\git.exe` and
  `C:\Program Files\Git\cmd\git.exe` → `C:\Program Files\Git\cmd\git.exe`, and `isFile` never asked a relative path; a
  `git.cmd` on `PATH` is not chosen; `PATH`'s `C:\X\git.exe` wins over the install folders; LOCALAPPDATA's and Scoop's
  found in that order; macOS with a `PATH` lacking git (an empty temp folder) → the login shell's answer; "skips
  relative PATH entries on every platform" (`.` holding an executable `git`, and the same for `gh`); every answer
  `isAbsolute`; `createProgramPath`: none → rejects with `code: 'ENOENT'`, `path: 'git'` (and `'gh'`, message
  `spawn gh ENOENT`, for `ghPath`'s name); "a miss is asked again; a find is kept" (the finder called twice for
  miss-then-found, once for found-then-asked). gh, Windows simulated: a `gh.exe` in the working folder with `PATH`
  `.;;tools` is not chosen and `isFile` is never asked a relative path; a `gh.cmd` on `PATH` is not chosen; `PATH`'s
  `C:\X\gh.exe` wins; with none on `PATH`, `C:\Program Files\GitHub CLI\gh.exe`, then Scoop's `shims\gh.exe`.
- [ ] **Step 2: Run** `npx vitest run src/lib/gitOnPath.spec.ts`: FAIL (no module).
- [ ] **Step 3: Implement**; `findGitBash` reads the exported roots, same order. Comment: Node on Windows looks for a bare
  name in the child's working folder before `PATH` (`docs/windows-rules.md` §2), so a repository could ship a `git.exe`;
  prepending to `PATH`, as tmux does, cannot fix that.
- [ ] **Step 4: Run** `npx vitest run src/lib/gitOnPath.spec.ts src/lib/windows/gitBash.spec.ts src/architecture.spec.ts`
  (green; core list unchanged), `npm run typecheck`.
- [ ] **Step 5: Commit** `test(cli): one absolute git and gh per process (red)`, then
  `fix(cli): gitPath and ghPath find git and gh once, by an absolute path, never in the working folder`.

### Task 15 (item 7): Every CLI git spawn runs `gitPath()`, and the pull request reader's gh `ghPath()`

**Files:** Modify `cli/src/dsh/install.ts:95, 268`, `cli/src/lib/worktreeDeletion.ts:20`,
`cli/src/lib/projectPreview.ts:42`, `cli/src/lib/branchNaming.ts:11`, `cli/src/lib/gitPullRequest.ts:37-44` (its
runner, which also runs the `gh` of `:96`, `:112`, `:184`),
`cli/src/lib/agentProject.ts:85`, `cli/src/lib/gitProject.ts:29, 460`, `cli/src/lib/gitProjectFolder.ts:40, 230`,
`cli/src/lib/agentHandoff.ts:238, 279, 645`; Test `cli/src/lib/gitPullRequest.spec.ts` and the specs Step 1 names.

**Depends on:** 14. **Effort:** high.

**Interfaces:** Consumes Task 14's `gitPath()` and `ghPath()`. The `git = 'git'` defaults become `git?: string` with
`git ?? await gitPath()`; `gitPullRequest`'s runner keeps the names `'git'` and `'gh'` for its own checks (the
checkout test, the timeouts) and execs `await gitPath()` for `'git'`, `await ghPath()` for `'gh'`.

- [ ] **Step 1: Find every bare git spawn** again: `grep -rnE "(spawn|exec|execFile|spawnSync|execFileSync|spawnTied|execute)\w*\(\s*['\"\`]git['\"\`]" src hook`
  and the `'git'` defaults (specs and fixtures excluded). Any beyond the list is added here and named in the report.
  The same grep for `gh`: any `gh` spawn beyond `gitPullRequest.ts` is named in the report, not changed. Name the specs that make git missing through `PATH`; they mock
  `../lib/gitOnPath.js` instead (dsh's `noGit` path keeps its outcome).
- [ ] **Step 2: Write the failing tests** in `gitPullRequest.spec.ts`, `node:child_process` `execFile` mocked and
  `../lib/gitOnPath.js` mocked to absolute answers: "runs git by its absolute path, with the pane's folder as cwd":
  the file it is given is `isAbsolute` and equals `gitPath()`'s answer. "runs gh by its absolute path, with the pane's
  folder as cwd": through `readGitPullRequest` on a GitHub remote, every `gh` call's file is `isAbsolute` and equals
  `ghPath()`'s answer, never `'gh'` (the URL reader's call, cwd `tmpdir()`, the same). `ghPath()` rejecting with ENOENT
  → `{ status: 'unavailable' }`, as a missing gh gives today.
- [ ] **Step 3: Run** `npx vitest run src/lib/gitPullRequest.spec.ts`: FAIL (`git`, `gh`).
- [ ] **Step 4: Implement** every call site; a missing git reaches each caller's existing handling (dsh/install's
  `gitStartFailure` and `noGit`, the others' ENOENT branches), awaited before any `new Promise` that spawns.
- [ ] **Step 5: Run** each touched file's spec, `npm run test:portability` (`dsh/*.ts`), `npm run typecheck`: green.
- [ ] **Step 6: Commit** `test(cli): the pull request reader runs git and gh by their absolute paths (red)`, then
  `fix(cli): every git the CLI runs is gitPath's, and the pull request reader's gh is ghPath's`.

### Task 16 (item 7): Desktop's git resolver

**Files:** Create `desktop/lib/core/git_program.dart`, `desktop/test/git_program_test.dart`.

**Depends on:** none. **Effort:** xhigh (security).

**Interfaces:**
- Produces:

```dart
/// The git to run, by its absolute path: PATH's absolute folders only, never the working folder; on Windows git.exe
/// alone, then Git for Windows' folders (cli/src/lib/windows/gitBash.ts's roots: <root>\cmd, Scoop's shims).
class GitProgram {
  GitProgram({Map<String, String>? environment, bool? isWindows, bool Function(String path)? isFile});
  /// Found once and kept; a miss looks again next time. None: throws ProcessException('git', const [], 'git was not found', 2),
  /// which every caller already handles from Process.start('git').
  String resolve();
}
String gitProgram();  // the process's GitProgram().resolve()
```

- [ ] **Step 1: Write the failing tests:** a planted `git.exe` in the working folder (Windows simulated, `PATH`
  `.;;tools;C:\Tools`) is not chosen and `isFile` is never asked a relative path; `git.cmd` is not chosen; the answer
  is absolute (`p.windows.isAbsolute` / `p.posix.isAbsolute`); Git for Windows' `cmd` folder and Scoop's `shims` found
  when `PATH` has none; macOS/Linux `PATH` order; none → `ProcessException`; a miss is asked again, a find kept.
- [ ] **Step 2: Run** `cd desktop && flutter test --no-pub test/git_program_test.dart`: FAIL.
- [ ] **Step 3: Implement.** Confirm Desktop has no login-shell path lookup to reuse (Decided here) and say so in the
  report.
- [ ] **Step 4: Run** the test and `flutter analyze lib/core/git_program.dart test/git_program_test.dart`: green, no issues.
- [ ] **Step 5: Commit** `test(desktop): one absolute git per process (red)`, then
  `fix(desktop): GitProgram finds git once, by an absolute path, never in the working folder`.

### Task 17 (item 7): Desktop's git spawns run the resolver's git

**Files:** Modify `desktop/lib/core/repository_clone.dart:52-56, 73`, `desktop/lib/core/git_worktree.dart:1030-1050`
(`runLocalGit`), `desktop/lib/core/project_preview.dart:72-90` (`_git`); Test `desktop/test/repository_clone_test.dart`,
`desktop/test/git_worktree_test.dart`, `desktop/test/project_preview_test.dart`.

**Depends on:** 16. **Effort:** high.

**Interfaces:** Consumes Task 16's `gitProgram()`; each caller takes its program from an injectable source defaulting
to `gitProgram` where it has no seam today.

- [ ] **Step 1: Find every Dart git spawn:** `grep -rnE "(Process\.(start|run)|startHidden|runHidden)\(" desktop/lib`
  with `'git'` as the program; beyond the four, add and name them (`keymap_commands.dart:417` is no spawn).
- [ ] **Step 2: Write the failing tests**, one per caller: "runs the resolver's git": the executable it starts is the
  injected resolver's absolute path, never `'git'`; a resolver that throws `ProcessException` gives the caller's
  existing error (repository_clone: `Git could not start. Install Git, then retry.`).
- [ ] **Step 3: Run** the three tests: FAIL.
- [ ] **Step 4: Implement**; the spawns keep their environments and `includeParentEnvironment` as today.
- [ ] **Step 5: Run** the three tests, `test/local_finder_git_test.dart` if it exists (`runLocalGit`'s caller), and
  `flutter analyze` on the touched files: green.
- [ ] **Step 6: Commit** `test(desktop): git spawns run the resolver's git (red)`, then
  `fix(desktop): every git Desktop runs is GitProgram's`.

### Task 18 (item 8): Windows' folder one way: the file system's

**Files:** Modify `cli/src/lib/windows/powershell.ts:11-21`, `cli/src/lib/windows/knownFolders.ts:43-57`,
`cli/src/lib/runtimeInstall.ts:38-46` (`unpackCommand`), `cli/src/lib/uninstall/removal.ts:426`,
`cli/src/engines/kit/windowsInstall.ts:103`; Test `cli/src/lib/windows/systemProgram.spec.ts`,
`cli/src/lib/windows/knownFolders.spec.ts`, `cli/src/lib/runtimeInstall.spec.ts`, `cli/src/lib/uninstall/removal.spec.ts`,
`cli/src/engines/kit/windowsInstall.spec.ts`, and `cli/src/lib/uninstall/windowsPath.spec.ts`,
`cli/src/lib/windows/powershellModules.spec.ts` where they pass an `env`.

**Depends on:** none. **Effort:** xhigh (security; a core file).

**Interfaces:**
- Produces, in `lib/windows/powershell.ts`: `systemRoot(real?: (path: string) => string): string` (moved from
  `knownFolders.ts` with its character check; cached for the default reader), `systemProgram(name: string): string`,
  `powershellPath(): string` (the `env` parameters go). `unpackCommand(archive, into, platform?)` loses `systemRoot`;
  `finalRemovalDeps().systemRoot` is `systemRoot()`; `knownFolders.ts` imports `systemRoot` and builds its tools with
  `systemProgram`.

- [ ] **Step 1: Write the failing tests:** `systemProgram.spec.ts` "a SystemRoot variable naming another folder is
  ignored" (`vi.stubEnv('SystemRoot', 'D:\\Elsewhere')`, `windir` the same → `systemProgram('reg.exe')` is
  `win32.join(systemRoot(), 'System32', 'reg.exe')` and holds no `Elsewhere`); the same for `unpackCommand(…, 'win32')`,
  `finalRemovalDeps().systemRoot`, and `windowsInstall`'s `comspec` with `ComSpec` stubbed.
- [ ] **Step 2: Run** those specs: FAIL.
- [ ] **Step 3: Grep** `SystemRoot|windir|ComSpec` in non-spec `src`: each read that picks a Windows program goes through
  `systemProgram`; one that passes the folder into a child's environment (as `regQuery` does) stays; list both kinds in
  the report.
- [ ] **Step 4: Implement.** `src/architecture.coreFiles.txt` is unchanged (`knownFolders.ts` is not imported by
  `powershell.ts`).
- [ ] **Step 5: Run** `npx vitest run src/lib/windows src/lib/uninstall src/lib/runtimeInstall.spec.ts src/engines/kit/windowsInstall.spec.ts src/architecture.spec.ts`
  and `npm run typecheck`: green.
- [ ] **Step 6: Commit** `test(cli): Windows' folder ignores the variables (red)`, then
  `fix(cli): Windows' own programs come from the folder the file system names, never SystemRoot, windir or ComSpec`.

### Task 19 (item 9): One `openInBrowser`, no shell

**Files:** Create `cli/src/lib/openInBrowser.ts`, `cli/src/lib/openInBrowser.spec.ts`; Modify
`cli/src/lib/connectors/command.ts:30-40` (its copy goes; `:54`, `:76` import lib's), `cli/src/cli.ts:1107-1115` (its
copy goes; `:876` imports lib's).

**Depends on:** none. **Effort:** xhigh (security: a URL as a command).

**Interfaces:**
- Produces:

```ts
/** What opens [url] on [platform], with no shell; null when [url] is not opened (not http(s), or holds whitespace or
 *  a quote). */
export function browserCommand(url: string, platform: NodeJS.Platform, harnessBrowser?: string | null): { file: string; args: string[] } | null
/** Best-effort: false when refused or not started; the caller prints the URL either way. */
export function openInBrowser(url: string, env?: NodeJS.ProcessEnv): boolean
```

  win32 `{ file: systemProgram('rundll32.exe'), args: ['url.dll,FileProtocolHandler', url] }`; darwin `open`; other
  `xdg-open`; a `harnessBrowser` wins. `openInBrowser` spawns with `stdio: 'ignore'`, `...ownProcessGroup()`, `env`, no
  `shell`, an `error` listener, `unref()`.

- [ ] **Step 1: Write the failing tests:** `browserCommand('https://a/?x=1&y=2', 'win32')` equals the win32 shape above;
  `'https://a/?q=%41^b'` passes unchanged; `'file:///etc/passwd'`, `'javascript:alert(1)'`, `'https://a/ b'`,
  `'https://a/"x'`, `"https://a/'x"` → null; darwin and linux shapes; `harnessBrowser` wins; `openInBrowser` (with
  `node:child_process` mocked) calls `spawn` with no `shell` option and returns false for a refused URL without spawning.
- [ ] **Step 2: Run** `npx vitest run src/lib/openInBrowser.spec.ts`: FAIL (no module).
- [ ] **Step 3: Implement**; remove both copies; both callers still print the URL as today.
- [ ] **Step 4: Run** the spec, the connectors' and CLI specs that reach these paths (`npx vitest run src/lib/connectors src/cli.spec.ts`),
  `src/lib/windows/noWindow.spec.ts` (no new `detached: true`), `npm run typecheck`: green.
- [ ] **Step 5: Commit** `test(cli): a link opens with no shell (red)`, then
  `fix(cli): one openInBrowser: rundll32 on Windows with no shell, so & no longer cuts a sign-in URL`.

### Task 20 (item 11): The fake `claude plugin install` and the daemon's hook install never interleave

**Files:** Modify `cli/e2e/harness/fakeEngine.mjs:241-302` (`claudePlugin`), `cli/e2e/deviceDialSkill.e2e.ts:104-115`
(`fresh`), and each e2e file Step 1 finds.

**Depends on:** none (shares `fakeEngine.mjs` with Task 7). **Effort:** high. **Red:** test-only, deterministic repro
(not committed). One commit.

- [ ] **Step 1: Find the siblings:** e2e files that plug a dial (`plug(`, `plugged(`) right after `d.start()` on a daemon
  that installs Claude's hooks, without `await d.hooksInstalled(['claude'])`. Name them in the report; each is in this
  task (a `dialHost*.e2e.ts` among them also runs the `dial-hosts` PR suite).
- [ ] **Step 2: Reproduce (temporary):** a 1 s wait inside the fake between its read of `settings.json` (`:251`) and
  its write: `npx vitest run --config vitest.e2e.config.ts e2e/deviceDialSkill.e2e.ts` loses the daemon's hooks or logs
  `HookPreparationHeld`, every run.
- [ ] **Step 3: Change:** the fake reads `settings.json` again just before writing and writes a temp file it renames
  over it; `fresh()` and each sibling await `d.hooksInstalled(['claude'])` before plugging. No product change: the
  daemon's unchanged-check is the bound (spec).
- [ ] **Step 4: Run** with the injection (green), remove it, run every touched e2e file: green.
- [ ] **Step 5: Commit** `test(cli): a dial is plugged once Claude's hooks are in, and the fake plugin install writes whole`.

### Task 21 (item 12): No `harness auth status` while uninstall holds its marker

**Files:** Modify `desktop/lib/state/app_state.dart:7003-7016` (`ensureCliDaemonReady`'s down branch), `:5862-5868`
(the early check), `:6119` and `:6200` (`_confirmKeptSignIn`); Test `desktop/test/daemon_readiness_test.dart`,
`desktop/test/kept_sign_in_launch_test.dart`.

**Depends on:** none. **Effort:** high.

**Interfaces:** `Future<CliAuthStatus> _checkAuthStatus()` (private, `AppNotifier`): `cliLogin.checkStatus()`, or, while
`_discovery.spawnHeld()`, throws `CliNotAvailableException` without running the CLI (Decided here, item 12). Every boot
site calls it; the down branch keeps its own guard.

- [ ] **Step 1: Write the failing tests** in `daemon_readiness_test.dart`: `_ScriptedDiscovery` passes
  `uninstalling: () => held` to `LocalCliDiscovery`; a `CliLogin` counting `checkStatus` (as
  `desktop_account_transition_test.dart:27`). "ensureCliDaemonReady runs no harness auth status while uninstall holds
  its marker": probe `down`, `held = true` → throws `StateError` with today's message
  (`The local Harness daemon did not start. Try running \`harness start\` yourself, then reopen the app.`), 0 checks.
  "…and asks again once the marker is gone" (Review Focus 3): `held = false` → 1 check.
- [ ] **Step 2: Write the failing boot tests** in `kept_sign_in_launch_test.dart`, its `_Discovery` taking an
  `uninstalling` function passed to `LocalCliDiscovery` and `_Cli.asked` counting checks:
  - "a launch while uninstall holds its marker runs no harness auth status and ends on the sign-in page": nothing kept,
    held → after `bootstrap()`, `cli.asked == 0`, `status == AppStatus.unauthenticated`, no error text (no new copy).
  - "a kept sign-in while uninstall holds its marker is not confirmed by harness auth status": a kept profile as the
    file's other cases store it, held → `cli.asked == 0`, the launch ends on `AppStatus.unauthenticated`.
  - "a kept window whose check failed asks no second check once uninstall holds its marker": held false at the early
    check, `cli.fails = true`, the kept window opens; held set true before the confirmation's fallback check →
    `cli.asked == 1`, the launch ends on `AppStatus.unauthenticated`.
- [ ] **Step 3: Run** `cd desktop && flutter test --no-pub test/daemon_readiness_test.dart test/kept_sign_in_launch_test.dart`:
  FAIL (checks counted).
- [ ] **Step 4: Implement:** the down branch runs `checkStatus()` and its signed-out handling only when
  `!discovery.spawnHeld()`, the same `StateError` either way; `_checkAuthStatus()` replaces `cliLogin.checkStatus()` at
  `:5864`, `:6119` and `:6200`. Confirm `_discovery` is first touched at `:5864` after `bootstrap()` has loaded the
  persisted config (the `late final` comment at `:956`), and say so in the report.
- [ ] **Step 5: Run** both test files, `test/desktop_account_transition_test.dart`, `test/boot_flow_widget_test.dart`,
  and `flutter analyze lib/state/app_state.dart test/daemon_readiness_test.dart test/kept_sign_in_launch_test.dart`:
  green, no issues.
- [ ] **Step 6: Commit** `test(desktop): no auth status while uninstall holds its marker (red)`, then
  `fix(desktop): Desktop runs no harness auth status while harness uninstall holds its marker`.

### Task 22 (item 13a): The game viewer's test waits on the viewer's publish

**Files:** Modify `store/viewers/game-viewer/test/viewer.test.mjs:18-24` (`until`), `:49`, `:200-222`.

**Depends on:** none. **Effort:** medium. **Red:** test-only, deterministic repro (not committed). One commit.

- [ ] **Step 1: Reproduce (temporary):** delay the viewer's watch callback (`viewer.mjs:617-626`) 2 s; `cd
  store/viewers/game-viewer && npm test` fails with "Condition did not arrive".
- [ ] **Step 2: Change:** a helper that reads the viewer's SSE stream (`text/event-stream`, `viewer.mjs:547-551`) and
  resolves on the first `event: state` whose data meets a predicate, bounded by the test's own timeout, replaces
  `until` at `:49`, `:210`, `:217`. The "no rebuild" check: after `studio.json`'s publish, write `progress.json` again
  and await that publish (the viewer handles them in order), then assert `latest.number` is unchanged; the 400 ms sleep
  goes.
- [ ] **Step 3: Run** with the injection (green), remove it, run `npm test` ten times beside 24 `yes > /dev/null` hogs:
  0 red.
- [ ] **Step 4: Commit** `test(store): the game viewer's test waits on the viewer's publish`.

### Task 23 (item 13b): The legacy lock holder retries while FSEvents starts

**Files:** Modify `cli/src/lib/__fixtures__/registryLockOwner.cjs`.

**Depends on:** none. **Effort:** medium. **Red:** test-only, deterministic repro (not committed). One commit.

- [ ] **Step 1: Reproduce (temporary):** the fixture's watcher drops its events for its first 200 ms;
  `npx vitest run src/lib/registry.persistence.spec.ts -t "starts a legacy lock holder"` times out.
- [ ] **Step 2: Change:** after `'waiting'`, `take()` is also tried every 50 ms (an unref'd interval, cleared once
  taken), as a legacy writer polls. The comment says why: FSEvents starts its stream asynchronously, so a removal before
  it is live is never told; "watch before trying" holds for inotify only.
- [ ] **Step 3: Run** with the injection (green), remove it; the spec ten times beside 24 hogs (0 red);
  `npm run test:portability`.
- [ ] **Step 4: Commit** `test(cli): the legacy lock holder retries while its watch starts`.

### Task 24 (item 15): folderWatch's spec, and its callers through a stream rebuild

**Files:** Modify `cli/src/cable/hosts/folderWatch.spec.ts:10-27` (`toldOf`); after Step 1's confirmation:
`cli/src/cable/hosts/folderWatch.ts:22-35` or the callers `cli/src/cable/hosts/unixSocket.ts:99`,
`cli/src/services/devices.ts:803, 821, 844`, with `unixSocket.spec.ts`, `devices.spec.ts`.

**Depends on:** none. **Effort:** xhigh (an OS race; `services/devices.ts` is under test:core's 100%).

- [ ] **Step 1: Confirm the double rebuild** before fixing: libuv's `src/unix/fsevents.c` (the stream rebuilt on each
  watch start and close) or an instrumented repro under load; report what was read or measured.
- [ ] **Step 2: Spec (test-only, repro first):** a repro that lands `change()` in the second rebuild's gap fails the
  old `toldOf`; `toldOf` then repeats the change with a new name each time until the count grows, as the sentinel loop
  does. One commit `test(cli): folderWatch's spec repeats its change until it is told`.
- [ ] **Step 3: Product siblings, red first:** a test that drops a watch's first events (a held `watch` seam) while the
  socket or file appears: today the caller never sees it (FAIL). Fix per Decided here: one re-check of the disk once a
  watch is live in `watchNearest` if that covers every caller, else each caller re-checks; bounded.
- [ ] **Step 4: Run** `npx vitest run src/cable/hosts src/services/devices.spec.ts`, ten times under 24 hogs for
  `folderWatch.spec.ts`; `npm run test:core` if `devices.ts` changed: green.
- [ ] **Step 5: Commit** `test(cli): a socket appearing in a watch's rebuild gap (red)`, then
  `fix(cli): a folder watch's callers look at the disk once the watch is live`. If Step 1 finds no product gap, no
  product commit, and the report says why.

### Task 25 (item 16): `console.ps1` without CIM

**Files:** Modify `cli/scripts/windows-dial-e2e/console.ps1:35-46, 73-75, 112-140`, `cli/scripts/windows-dial-e2e/README.md:98-110`.

**Depends on:** none. **Effort:** high. **Red:** none (a Windows tooling script): the evidence is Verification 3's run
over SSH as a standard user. One commit.

- [ ] **Step 1: Change:**
  - the console user: `quser.exe` from `[Environment]::GetFolderPath('System')` (no variable names it), the row whose
    session name is `console`, its user matched to this account (`$me.Name`'s user part), case-insensitively; exit 3 as
    today when there is none (quser's "No User exists" included);
  - the wrapper writes its `$PID` to `<name>.pid` first (before the encoding lines, which `e2e/dialWindowsTools.e2e.ts`
    checks); `End-Task` reads it and runs `taskkill /pid <pid> /t /f`; `Files` and the `-Stop` cleanup include it;
  - the task through the `Schedule.Service` COM object (`TASK_LOGON_INTERACTIVE_TOKEN`, no password, least privilege,
    the same action, time limit and `IgnoreNew`), registered, run, stopped and deleted through it, `LastTaskResult` from
    it; `schtasks /Create /XML` only if the VM run shows the COM object denied over SSH.
  - README: the "owner or an administrator" line goes; it says what the script uses and why (a network logon token is
    denied CIM).
- [ ] **Step 2: Check here:** no `Get-CimInstance` or `*-ScheduledTask*` left (`grep -nE 'CimInstance|ScheduledTask' console.ps1`
  → none); if `pwsh` is installed, the parser reports no errors; `npx vitest run --config vitest.e2e.config.ts e2e/dialWindowsTools.e2e.ts` green.
- [ ] **Step 3: Commit** `fix(cli): console.ps1 runs over SSH as a standard user: quser, a pid file and the Task Scheduler's COM object`.

### Task 26 (items 7, 8, 9, 16): Windows rules for what this batch learned

**Files:** Modify `docs/windows-rules.md` (§2 Starting processes, §5 Testing on Windows).

**Depends on:** 14, 18, 19, 25. **Effort:** medium. **Red:** none, docs. One commit.

- [ ] **Step 1: Write**, each with its test: git, and any program run with a project folder as its working folder, by
  the absolute path found once (`gitPath()` and `ghPath()`, `lib/gitOnPath.ts`; Desktop `GitProgram`), because Node and Dart run a
  `git.exe` in the child's working folder before `PATH` (tests: `gitOnPath.spec.ts`, `git_program_test.dart`); the
  existing "Windows' own programs run by their full paths" bullet says Windows' folder is asked of the file system,
  never `SystemRoot`, `windir` or `ComSpec` (`systemProgram.spec.ts`); a link opens through
  `rundll32 url.dll,FileProtocolHandler` with no shell, since `cmd.exe start` cuts at `&`, splits at a space and expands
  `%` (`openInBrowser.spec.ts`); §5: over SSH a standard user's network logon is denied CIM, so a test tool finds the
  console session with `quser.exe` and starts its task through the Task Scheduler's COM object (`console.ps1`, the VM
  run).
- [ ] **Step 2: Commit** `docs: Windows rules for git's working-folder lookup, Windows' folder, links and CIM over SSH`.

---

## Verification

All of it on the final head, after the final review. Nothing runs against production: every daemon is an isolated one
(`IsolatedDaemon`: throwaway root and home, a private tmux server, ports of its own, never 18473, signed out, the fake
backend), and no check signs in. Windows checks use the VM's own standard test user, never a person's account.

**1. Local gates on this Mac** (`docs/validation-and-release.md`: checks PR CI does not run), from a clean tree:
- `python3 scripts/local-checks.py --run`, its fence pasted into the PR body before it is marked ready. Expected
  selection: `cli-core` (`src/core/`, and `src/services/` if Task 24 changed `devices.ts`), `cli-resume` (if Task 5 or 7
  changed a resume file), `cli-portability` (`dsh/install.ts`, Task 15). `npm run test:core` must show 100% per file.
- `cd cli && npm run typecheck` and `npx vitest run src/architecture.spec.ts` (the core list unchanged).
- `python3 -m unittest discover -s scripts/tests -p 'test_*.py'`, and the cross-read scan with
  `CROSS_READ_SCAN_REQUIRED=1` (Task 2 Step 6's command).
- Desktop on macOS: `make desktop-test ARGS="test/git_program_test.dart test/repository_clone_test.dart test/git_worktree_test.dart test/project_preview_test.dart test/daemon_readiness_test.dart test/kept_sign_in_launch_test.dart test/desktop_account_transition_test.dart"`
  and `cd desktop && flutter analyze` on every touched Dart file.
- `cd store/viewers/game-viewer && npm test`.

**2. End to end on this Mac** (the isolated e2e harness, from `cli/`, never a folder that goes):
- `npx vitest run --config vitest.e2e.config.ts e2e/hookclient.e2e.ts e2e/twodaemons.e2e.ts e2e/machine.e2e.ts e2e/scale.e2e.ts e2e/updates.e2e.ts e2e/deviceDialSkill.e2e.ts e2e/handoff.e2e.ts`,
  plus every e2e file Tasks 11 and 20 changed: all green. `machine`, `scale` and `updates` three times each (they failed
  on some nights, not all); the tasks' repros recorded in their commits.
- Item 5's numbers once more on the final head (Task 13 Step 1's procedure, five runs): event-loop delay `maxMs` and
  `p99Ms` during one Change agent run, and `[handoff-budget]`, beside Task 13's before figures.
- Under load (24 `yes > /dev/null` hogs, killed after): `folderWatch.spec.ts`, `registry.persistence.spec.ts` and the
  game viewer's tests ten times each: 0 red.

**3. On the shared Windows ARM VM** (192.168.64.5, only on harness-pm's go, one tester at a time;
`docs/testing/windows-cli-e2e.md`'s setup recipe): SSH with key auth as the VM's standard test user (hxe2e, in `Users`
only), a checkout of this branch in that profile with `npm ci` in `cli/`, Git for Windows installed. `console.ps1`
needs that user signed in at the VM's console: the autologon of the recipe's step 4, restored after, or someone at the
VM's window (marked: needs a person if autologon is not used). Each result is a row; a step that cannot run is an
unverified row, never a pass.
- Item 16: `console.ps1 -Script probe.ps1` (a script printing its session id) prints session 1 and `exit 0`;
  `-NoWait` prints the task's name, then `-Stop <name>` ends it: the task is gone (`schtasks /Query /TN <name>` finds
  none) and no PowerShell running the wrapper is left. With that user not at the console: exit 3.
- Item 9: through `console.ps1`, the branch's `openInBrowser('http://127.0.0.1:<port>/?a=1&b=2&c=%41')` (via `npx tsx`)
  beside a small Node listener on that port: the listener logs the whole query `/?a=1&b=2&c=%41`, and nothing ran as a
  command.
- Item 7: in a folder holding a `git.exe` and a `gh.exe` that are copies of `C:\Windows\System32\hostname.exe`,
  `await gitPath()` and `await ghPath()` run from that folder print Git for Windows' absolute `git.exe` and the GitHub
  CLI's absolute `gh.exe` (the GitHub CLI installed for the test user, `winget install --id GitHub.cli -e` if it is
  missing; it is never signed in); the pull request reader on a checkout
  holding those planted files answers from the real git and gh (`unavailable` with gh signed out is a pass; the
  hostname text in no answer).
- Item 8: with `SystemRoot` and `windir` set to `C:\Users\Public` in the session, `systemProgram('reg.exe')` prints
  `C:\Windows\System32\reg.exe`; `npx vitest run src/lib/windows/systemProgram.spec.ts src/lib/windows/knownFolders.windows.real.spec.ts`
  green there (arm64; PR CI's `windows-e2e` runs `cli/src/lib/windows/` on x64 only).

**4. GitHub.** PR CI selects by path since #4526, so the PR's own run covers: `windows-e2e` x64 (Tasks 18 and 24's
paths), `linux-e2e` (each modified e2e file, and the canary since `cli/e2e/harness/` changes), `dial-hosts` (the setup
action, `cable/hosts/`), `cross-read-scan`, and the unit suites. By hand, one at a time, only on harness-pm's go:
- `cli-e2e.yml` on the branch (8 shards, ubuntu-24.04): only if Task 5, 6 or 7 left its e2e file unmodified, since PR
  CI then runs that file nowhere on Linux, where it failed; expect every shard green and report the link. Otherwise not
  dispatched; the first nightly after merge is the check of the mongod cache's hit path (Task 4), its link reported.
- `windows-desktop.yml` (x64 and arm64): Desktop's resolver and its callers on real Windows (Tasks 16, 17). Without
  it, Desktop's Windows path is proven by the simulated-Windows unit tests only, which the PR says.
- `windows.yml`: not dispatched; PR CI's `windows-e2e` calls it.
- Proposals for later pull requests: none.

**5. What the PR carries:** item 5's numbers before and after; each repro and its red rate; the three nightly causes
from the logs; the red-then-green commits; the local-checks fence; the VM rows; the platforms (macOS, Linux, Windows x64
and ARM64 for the CLI; macOS, Windows, Linux for Desktop); and the final report's list of reconcile-pass sleeps left.
