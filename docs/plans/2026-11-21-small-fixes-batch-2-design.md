# Small fixes batch 2 (2026-11-21): flaky tests, small bugs and CI gaps

## Intent

One pull request that removes a second batch of flaky tests, small bugs and CI gaps (follow-ups of #4525, #4526 and the
nightly `cli-e2e` runs). AGENTS.md: a flaky test is a bug. Each fix removes the cause; no test is loosened, no timeout
is raised as the fix, no fixed sleep is added, nothing is rerun to green.

## Goals

- Every item below is fixed at its cause, or dropped with the reason.
- Where a behavior changes, a test fails first (red commit) and then passes.
- Where only a test is wrong, the evidence is a deterministic repro of the race (an injected delay, a held clock or a
  dropped event) that fails on the old test and passes on the new one.
- "A fix covers every case of the same cause": each fix also covers the sibling cases named below.
- Perf items (5) carry numbers before and after.

## Non-goals

- No new feature, setting, screen or copy.
- No new file in `architecture.coreFiles.txt`. Core files changed here are already on the list.
- Moving the handoff transaction out of the core into an edge host (the core audit's real fix for item 5): a separate
  design. This item only takes its fsyncs off the event loop.
- `lib/secureState.ts` and `engines/kit/folderTrust.ts` synchronous fsync/rewrite: separate items.
- `on:` changes in `ci.yml` selecting suites (item 2): documented only.
- Other "several reconcile passes" sleeps (`e2e/tmuxmoves.e2e.ts:106`, `e2e/tmuxsocket.e2e.ts:69`,
  `e2e/content.e2e.ts:89`): they can use the item 10 signal later; listed in the final report, not changed here unless
  the builder finds them a one-line swap.

## Dropped

- **(6) dsh watcher, a file created and deleted while chokidar starts:** already fixed on main by #4525 (8d6fbf217f):
  `cli/src/dsh/viewer.ts:315` rescans and `cli/src/dsh/verdict.ts:171` republishes on chokidar `ready`.

## Items

### CI

**(1) Nightly `cli-e2e` red with a different test each night.** The ten failing scheduled runs 11-08…11-20 were read.
Most failures were fixed by later commits (#4423, #4424, #4417, #4457, #4460, #4284, #4286, 706a43ad1d, 71a2a71e5c,
c50947ccd7, 1e17b388ce) or their tests were deleted with Swarm/Buddy. Still open on main:
- **`e2e/machine.e2e.ts` "codex: the tmux server dies mid-turn…"** (11-20, shard 2): `agent_resume` returned
  `AGENT_CHANGED` "The harness changed while opening" (`machine.e2e.ts:44`). The test resumes as soon as the row stops
  reading "working" (`:96`), while the daemon may still be cleaning up the dead pane, so an ownership check in
  `src/lib/resumeStoppedAgent.ts:35-51` / `src/lib/resumeAgentService.ts:147-177` fails. Builder: confirm from the
  shard's daemon-log artifact which check fired. If the row reports "stopped" before the cleanup that resume depends
  on has finished, that is a product bug (a resume a person makes at that moment fails the same way): fix the order so
  the row reads stopped only once it can be resumed, or make resume wait for that cleanup. Only if the product is right
  does the test wait on the condition resume needs. Sibling: "engine dies mid-turn" (`:106`).
- **`e2e/scale.e2e.ts` "24 agents…"** (11-17, 11-18): "timed out after 240000ms waiting for all 24 agents to bind". The
  daemon log shows 13 "Conversation identity is held: the observed process changed before publication" in one second
  plus "readiness publication unavailable": with 24 agents at once, binds are refused and never retried. Product race.
  Fix at the cause with a bounded retry (or by removing the refusal's false positive) if that is small; if it needs a
  redesign of the core's binding, stop and tell the orchestrator: it becomes its own item (orchestrator's call).
- **`e2e/updates.e2e.ts` "codex: an update drops resume…"** (11-12, 11-13): expected `RESUME_FAILED`, got
  `resumed:true`. Not seen since, nothing fixed it. Builder: find the race (likely the update not yet visible to the
  resume path when the test resumes) and fix it at the cause, with a repro.
- **Infrastructure, same setup action that PR CI's `linux-e2e` now uses (`.github/actions/cli-e2e-setup`):**
  - 11-16: mongodb-memory-server's download got 504 from fastdl.mongodb.org. Fix: cache the mongod binary (actions
    cache keyed by the mongodb-memory-server version and OS).
  - 11-11: all 8 shards failed at `apt` (exit 100). Fix: bounded retries (3, with a short backoff) around the apt
    steps, each attempt logged.

**(2) #4526 follow-ups in `scripts/ci-plan.py`.**
- (a) A change to `ci.yml`'s top-level `concurrency` selects no suite (`edited_job_suites`, `ci-plan.py:530-562`; only
  `permissions` and `defaults` mark every job edited, `:545`). Fix: add `concurrency` there. Red: a subcase of
  `test_what_a_job_takes_from_the_rest_of_ci_yml_is_part_of_its_definition` (`scripts/tests/test_ci_plan.py:925`)
  expecting every suite.
- `on:` stays as it is and is documented in `docs/validation-and-release.md` (every new suite adds a manual `scope`
  option, so treating `on:` as "everything" would run every suite on each such change).
- (b) The cross-read scan (`CrossReadTests`, `test_ci_plan.py:1702`; job `ci.yml:1332-1348`) is selected only by five
  paths (`ci-plan.py:86-88`), so an undeclared read added by an ordinary PR is caught only by the next planner PR or
  `make merge-pr`'s reuse scan. Fix: select it on every PR that changes a component (about 0.5 runner-minutes, measured
  in #4526). Red: a `cli/src/x.ts` change expects `cross-read-scan` (next to `test_ci_plan.py:128`). Document in
  `docs/validation-and-release.md` that a misread string blocks a PR until it is added to `NOT_READS`.

**(14) `scripts/validate-change.py` does not see `flutter -d macos test` as a flutter test.** `flutter_test_folder`
(`:234-244`) takes the first argument without a dash, which is `-d`'s value `macos`, so two such runs in `desktop/`
overlap again (the #4525 Vulkan-only shader race). Same cause: `--device-id macos`, `--local-engine*` values. Separate
cause, same miss: `flutter.bat` and `fvm flutter test` (`argv[0]` is not literally `flutter`).
- Fix: a run is a flutter test when `test` is among its arguments and `flutter` (any of `flutter`, `flutter.bat`, or
  `fvm` followed by `flutter`) is its program. Holding a folder by mistake only serialises checks.
- Red: `scripts/tests/test_validate_change.py` `test_desktop_test_commands_hold_the_desktop_folder` (`:108`) gains
  `-d macos test`, `--device-id macos test`, `flutter.bat test` and `fvm flutter test`.

### Core

**(3) Dropped hook posts are logged only after 60 s.** `cli/src/core/observedHook.ts:118-132` `minuteCounts` counts
each loss and logs `[devices] paneless hook events in the last minute: N refused, M dropped` only when a 60 s timer
fires. `'dropped'` mixes two causes: over the per-session rate (20/s) or the counter table full (`:164`, `take()`
`:137-151`), and the devices process not running (`forward()` false, `:165`). The route
(`hookServer.ts:1007-1016`) answers 200 either way and the hook never retries.
- Fix: leading-edge, as `gatewayLink.ts:122-135` and `recapsLink.ts:61-74` already do: log the first loss when it
  happens, then count, and log the minute's summary only if more came. Split `'dropped'` into `over the rate` and `no
  devices`. "No devices" is normal on a machine without a dial, so it is logged once per devices-down period (the first
  loss after devices were last seen up), not per event. A refused body (a broken or forged hook) is said at once too,
  as a refused dial hook call is: one rule for every loss. Lines carry counts and fixed text only, no session, path or
  engine:
  - `[devices] a paneless hook event was refused; more are counted once a minute`
  - `[devices] a paneless hook event was dropped: over 20 a second for its session; more are counted once a minute`
  - `[devices] a paneless hook event was dropped: no devices process; more are counted once a minute`
  - `[devices] paneless hook events in the last minute: 1 refused, 7 over the rate, 3 with no devices process, 0 handled
    without a line`
- Same helper, same cause: `deviceHookCalls.ts:76-77` (`dial hook calls … refused, … over the bound`) uses it and
  becomes leading-edge too.
- Red: `cli/src/core/observedHook.spec.ts:212` (today expects no log before 60 s, `:223`) expects the at-drop line at
  once and no second line until the minute ends; `deviceHookCalls.spec.ts` the same.

**(4) `cli/e2e/hookclient.e2e.ts:391` sleeps 6 s** before asserting a paneless pane got no row (`:392`). It covers the
observed post (the route logs nothing) and one tmux reconcile pass (interval 5 s in e2e, `e2e/harness/daemon.ts:546`).
- Product: `observedHook.onObserved` logs one line per handled event, no ids or paths, following `[hooks] … tool-start`
  (`hookServer.ts:991`): `[hooks] paneless <engine> <event> · forwarded | over the rate | no devices`. Bounded by the
  rate limit (at most 20/s per session) and by its own, at most 20 lines a second across sessions, the rest counted in
  item 3's minute line (`N handled without a line`); under the limit's refusal the item 3 lines speak instead.
- Test: take `from = d.log().length`, wait for the `[hooks] paneless … turn-start` line after `from`, then wait for
  two more reconcile passes (item 10's `discoveryPasses`), then assert no row.
- Red: `observedHook.spec.ts` asserts the forwarded line, and that it holds no session id or path.

**(5) The handoff publication runs fsync on the core's event loop.** `cli/src/lib/handoffPublication.ts`:
`Flushes.flush` calls `fsyncSync` (`:36-41`), reached from `sync()` (`:54-68`), `createFile()` (`:69-82`),
`directory()` (`:83-91`); `save()` (`:154-166`) is tmp write + fsync, link or rename, directory fsync, read back. It
yields only at `checkpoint()` (`:203`). One Change agent request runs it (`core/handoffPublication.ts:127` ←
`handoffDependencies.ts:7` ← `main.ts:1582`); the comment at `:26-31` measured 2.5 s of a 3.3 s preparation in fsyncs
at load 8 (macOS F_FULLFSYNC 25-35 ms each). The core audit lists it under "the core's loop can be held".
- Fix: `Flushes.flush` awaits `fs.promises`/`FileHandle.sync` (libuv threadpool; on macOS libuv's async fsync also uses
  F_FULLFSYNC, so durability is unchanged). `sync`, `createFile`, `directory`, `save`, `guards`, `confirmed`, `durable`
  become async and await each step in order, so the order stays write tmp → fsync → link/rename → fsync directory.
- Concurrency: new interleaving points appear where only `checkpoint()` yielded before. Keep the fd open across each
  await, and keep `fence()` and `checkRequest()` immediately before every `linkSync`/`renameSync` (`:161-162`, `:260`,
  `:293`, `:310`); the `publications` lock map (`:15`, `:109`) still serialises one key. Remove the "without yielding"
  comment at `core/handoffPublication.ts:128`. Builder: list every state read before an await and used after it, and
  re-check it after the await or show it cannot change.
- Red: `cli/src/core/handoffPublication.spec.ts`: with `fsync` mocked to resolve after a delay, a `setImmediate`
  callback runs while a flush is pending, and `fsyncSync` is never called. The existing slow-flush tests (`:59-66`,
  `:81-90`, `:112-139`) move to the async mock.
- Numbers: the core's event-loop delay (max and p99, `monitorEventLoopDelay` through `e2e/harness/corePerf.cjs`, as
  `e2e/perf.e2e.ts:175` does) during one Change agent run (`e2e/handoff.e2e.ts:74`), before and after; and the
  preparation's total time (`handoffPublication.native.spec.ts:127` `[handoff-budget]`) before and after, to show it
  did not get slower.

**(10) `cli/e2e/twodaemons.e2e.ts` "nothing happened" sleeps** (`:113` 12 s, `:127` 6 s, `:133` 6 s, `:339` 12 s): each
waits "two reconcile passes" and then asserts a daemon did not take the other's pane. Under load a pass is slow or
overdue (`lib/terminalAgentReconciler.ts:271`), so the window can end before any pass looked, and the test passes
falsely. Nothing observable exists: the reconciler keeps no pass count and logs nothing per pass; `/api/status`
(`core/main.ts:2205-2221`) has only `discoveryReady`/`discoveryError`.
- Fix (orchestrator's call): the reconciler counts completed passes in `drain()`/`reconcileOnce()` (`:280-345`), not
  counting a probe that was given up, and `/api/status` serves it as `discoveryPasses` beside `discoveryReady`
  (`main.ts:2218`). Both files are already core files. This is observability of the core's own work, not a feature or
  an experiment's record. The e2e harness gets `d.discoveryPasses()`; each test reads it after its last create, delete
  or restart and waits `until(passes >= n + 2)`: two more passes means at least one full pass began after the change.
- Red: a reconciler unit test that the count grows by one per completed pass and not on a given-up probe; and the
  repro: an injected held probe stalling passes past 12 s, under which the old e2e passes with no pass run and the new
  one waits.

### CLI

**(7) git is spawned by bare name in 12 product places:** `dsh/install.ts:95,268`, `lib/worktreeDeletion.ts:20`,
`lib/projectPreview.ts:42`, `lib/branchNaming.ts:11`, `lib/gitPullRequest.ts:39-42` (with `cwd` = the pane's folder),
`lib/agentProject.ts:85`, `lib/gitProject.ts:29,460`, `lib/gitProjectFolder.ts:40,230` (default), `lib/agentHandoff.ts:238,
279,645` (default). Hazards: launchd's minimal `PATH` on macOS; on Windows a bare name is looked up in the child's
working folder before `PATH` (`docs/windows-rules.md` §2), so a `git.exe` committed into a repository runs from
`gitPullRequest.ts:42` (security). `lib/tmuxOnPath.ts:151-193` resolves tmux once (PATH, login shell, managed runtime,
install folders) and prepends its folder to `PATH`; prepending cannot fix the working-folder lookup.
- Fix: `lib/gitOnPath.ts` `gitPath()`: resolved once per process, always an absolute path.
  - macOS/Linux: `resolveBinaryOnPath('git')`, then `resolveViaLoginShell('git')` (as tmux).
  - Windows: `PATH` entries only (never the working folder), `git.exe` only (a `.cmd` would need `cmd.exe`), then the
    Git for Windows folders `lib/windows/gitBash.ts:27-48` already knows (`ProgramFiles\Git\cmd`,
    `LOCALAPPDATA\Programs\Git\cmd`, Scoop `shims`).
  - Not found: the same error each caller gives today for a missing git, with the name `git`.
  - `gh` in `lib/gitPullRequest.ts` (`:96`, `:112`, `:184`) has the same cause (bare name, the pane's folder as
    working folder): it goes through the same resolver as `ghPath()` (orchestrator's call).
  - Every call site swaps `'git'` for `gitPath()`; the `git = 'git'` defaults become `gitPath()`. Builder: grep for
    any further bare `'git'` spawns (tests and fixtures excluded) and include them.
- Red: `lib/gitOnPath.spec.ts`: a `git.exe` planted in the working folder (Windows simulated) is not chosen; the answer
  is absolute; macOS with a `PATH` lacking git finds it through the login shell. `gitPullRequest.spec.ts` checks the
  file passed to its exec is absolute.
- Desktop, same cause, same rule, this PR (orchestrator's call): the 5 Dart spawns `core/repository_clone.dart:56,73`,
  `core/git_worktree.dart:1040`, `core/project_preview.dart:79`, `shortcuts/keymap_commands.dart:417` go through one
  Dart resolver (resolved once, absolute: `PATH` entries, never the working folder; Windows `git.exe` plus the Git for
  Windows folders; macOS also the login shell's answer when the app was started with launchd's minimal `PATH`, if
  Desktop already has such a lookup — builder: reuse it, add none if it does not exist and say so). Red: a Flutter unit
  test of the resolver (a planted `git.exe` in the working folder is not chosen; the answer is absolute) and one per
  caller seam that the program it runs is the resolver's.

**(8) `knownFolders.systemRoot` vs `powershell.systemProgram`: two ways to the Windows folder.** `systemRoot`
(`lib/windows/knownFolders.ts:44`) asks the file system (`\\?\GLOBALROOT\SystemRoot`) and refuses characters `cmd.exe`
reads specially; one caller (`regQuery`, `:57`). `systemProgram` (`lib/windows/powershell.ts:14`) reads the
`SystemRoot`/`windir` variables, which whoever runs the command can set; 11 callers. Inline siblings:
`runtimeInstall.ts:43-45`, `uninstall/removal.ts:426`.
- Fix: one way, the file system's. `systemProgram(name)` stays the one entry point and builds on a cached
  `systemRoot()` moved into `powershell.ts` (moving it there, not importing `knownFolders.ts`, keeps the core list
  unchanged). The `env` parameter and the two inline siblings go; `regQuery` uses `systemProgram`.
- Red: `lib/windows/systemProgram.spec.ts`: a `SystemRoot` variable naming another folder is ignored.

**(9) `openInBrowser` on Windows does not quote the URL.** Two copies: `lib/connectors/command.ts:31` and
`cli.ts:1108` (sign-in, `cli.ts:876`), both `spawn('start', [url], { shell: true })`. `cmd.exe` cuts the URL at `&`
(the OAuth authorize URL is full of them) and runs the rest as a command; a space splits it; `%` expands.
- Fix: one `openInBrowser` in `lib/` that both callers use, built on a pure `browserCommand(url, platform)` returning
  `{ file, args }`. Windows: `systemProgram('rundll32.exe')` with `['url.dll,FileProtocolHandler', url]`, no shell.
  macOS/Linux keep `open`/`xdg-open` without a shell. A URL that is not `https?://` or holds whitespace or quotes is
  not opened (it is printed either way, as today).
- Red: `browserCommand('https://a/?x=1&y=2', 'win32')` returns that file and those args with no shell; a `file:` URL
  is refused. Windows real check: the tester opens an `&` URL on a Windows machine and sees the whole URL in the
  browser (or the handler's argv).

**(11) The fake `claude plugin install` races the daemon's hook install on `settings.json`.** Confirmed:
`e2e/harness/fakeEngine.mjs:241-302` reads `settings.json` once (`:251`) and rewrites it in place (`:258-262`); the
daemon's hook install (`engines/kit/hookSettings.ts:45` → `nativeHookFiles.ts:211-237`) checks the file is unchanged
before renaming over it. Interleaved, either the fake writes a stale copy over the daemon's hooks (lost silently), or
the daemon throws `HookPreparationHeld` for that pass, or it reads the fake's half-written file.
`e2e/deviceDialSkill.e2e.ts` plugs a dial right after `d.start()` (`:104-115`, `:161`) without waiting for the hooks.
- Fix (test side only): `fresh()` in `deviceDialSkill.e2e.ts` awaits `d.hooksInstalled(['claude'])`; the fake writes
  to a temp file and renames it, reading the file again just before. Builder: any other e2e file that plugs a dial
  right after start without that wait gets it too.
- Product: Claude Code itself can write `settings.json` the same way; the daemon's unchanged-check is the bound. No
  product change.

### Desktop

**(12) Desktop runs `harness auth status` during an uninstall.** #4525 added `spawnHeld()` (`_flashing() ||
_uninstalling()`, `desktop/lib/ws/local_cli_discovery.dart:282`) at both spawns and the supervisor. Still running the
CLI while `~/.harness/uninstalling` is held:
- `AppNotifier.ensureCliDaemonReady()` (`lib/state/app_state.dart:6971`): the `LocalCliProbeState.down` branch runs
  `cliLogin.checkStatus()` (`:7008`, `harness auth status --json`). Called from boot (`:6486`), sign-in (`:6695`) and
  `retryMachines` (`:11564`), every few seconds. Signed out, `authStatusCommand` (`cli/src/cli.ts:388`) can mint a
  computer-id file again in the folder being removed; on Windows the run holds `node.exe` and the CLI's files.
- Boot's early checks (`app_state.dart:5864`, `:6119`) run it too.
- Boot while the marker is held (orchestrator's call): boot takes the same path a failed check takes today (it ends on
  the sign-in page), no new copy; the kept sign-in confirmation follows the same answer.
- Fix (orchestrator's call: all three): no `checkStatus` while `discovery.spawnHeld()`. The down branch keeps throwing
  the same `StateError` (copy unchanged).
- Red: `desktop/test/daemon_readiness_test.dart`: a scripted discovery that is down with `uninstalling: () => true`
  and a `CliLogin` counting `checkStatus` calls (as `desktop_account_transition_test.dart:27`); expect
  `ensureCliDaemonReady()` to throw with zero checks. The same for the boot path.

### Flaky tests

**(13a) `store/viewers/game-viewer/test/viewer.test.mjs` "Condition did not arrive".** Its helper (`:18-24`) polls
120 × 10 ms (~1.2 s). `:210`/`:217` wait for `fs.watch` delivery of `.harness/progress.json` and `studio.json`
(`viewer.mjs:617-626`), which on macOS (FSEvents) has no bound under load; `:49` waits for the first build. `:218`
sleeps 400 ms to show no rebuild happened.
- Fix: wait on the viewer's own publish (its SSE `event: state`, `viewer.mjs:209-210`) instead of polling a budget; the
  "no rebuild" check reads the publish count after a later event the viewer must handle in order, not after a sleep.
- Repro: delay the viewer's watch callback by 2 s: the old test fails, the new passes.

**(13b) `cli/src/lib/registry.persistence.spec.ts:234` "starts a legacy lock holder" timed out at load 19.** The fixture
(`lib/__fixtures__/registryLockOwner.cjs`) calls `fs.watch(directory)`, tries `take()`, sends `'waiting'`; the test then
removes the lock folder. On macOS libuv starts the FSEvents stream asynchronously, so a removal before it is live is
never told, and the fixture never retries. Its comment ("watch before trying, so a removal is still seen") holds for
inotify, not FSEvents.
- Fix (fixture): after `'waiting'`, also retry `take()` on a short interval, cleared once taken (as a legacy writer
  polls); correct the comment.
- Repro: wrap the fixture's watcher to drop events for its first 200 ms: the old fixture hangs, the new takes the lock.

**(15) `cli/src/cable/hosts/folderWatch.spec.ts` flaky under heavy load** (6/6 alone). `folderWatch.ts` (`watchNearest`,
`:22-35`) opens the new watch and closes the old one; on macOS libuv rebuilds its FSEvents stream per watch start or
close, so the sentinel can be seen on the first rebuilt stream and the test's `change()` lands in the gap of a second
rebuild. The spec's sentinel loop (`:10-27`) proves the stream was live once, not still live.
- Builder: confirm the double rebuild (a libuv source read or an instrumented repro under load) before fixing.
- Fix (spec): in `toldOf`, repeat the change with a new name each time until the count grows, as the sentinel loop does.
- Same cause in product code: callers that wait for a socket to appear through a folder watch
  (`cable/hosts/unixSocket.ts:99`, `services/devices.ts:803,821,844`) can miss a creation in that gap. Builder: each
  re-checks the disk after its watch is live (or on a bounded interval), with a red test that drops the first events.

### Windows test tooling

**(16) `cli/scripts/windows-dial-e2e/console.ps1` cannot run over SSH as a normal user.** `Get-CimInstance
Win32_ComputerSystem` (`:74`, to check this account is at the console) is denied with a network logon token
(`docs/plans/2026-11-19-dial-windows-vm-notes.md:1306`, `README.md:100-101`); `:41` also uses CIM (`Win32_Process`
CommandLine) to find the wrapper, and the ScheduledTasks cmdlets (`:116-130`) are CIM underneath.
`desktop/scripts/windows-e2e/session-run.ps1` is no replacement: it also uses CIM, needs an administrator and compiles
`hxrun.exe`, which Smart App Control blocks.
- Fix: `console.ps1` without CIM:
  - console user: `quser.exe` (signed, WTS APIs), the row whose session name is `console`, matched to this user;
  - ending the task: the wrapper writes its `$PID` to `<name>.pid`; `End-Task` runs `taskkill /pid <pid> /t /f`;
  - the task: the `Schedule.Service` COM object with `TASK_LOGON_INTERACTIVE_TOKEN` (no password), or
    `schtasks /Create /XML`, instead of the ScheduledTasks cmdlets.
  - README updated.
- No red unit test (Windows tooling script); the evidence is a run over SSH as a normal user on a Windows machine
  (the shared ARM VM or the Dell x64 PC, on harness-pm's go) showing the console task starts and ends.

## Approaches

The approach for each item is set by its cause; the choices made between real alternatives:
- (10)/(4) reconcile-pass signal: a pass counter in `/api/status` (chosen: one field, no log noise, exact) vs a log
  line per pass (a line every 5 s on every machine) vs keeping sleeps (fails the request).
- (1) scale race: fix in this PR if a bounded retry or a false-positive removal fixes it; a redesign of binding splits
  out (orchestrator).
- (7) git: an absolute path per process (chosen: fixes Windows' working-folder lookup) vs prepending to `PATH` like
  tmux (cannot fix that lookup).
- (8) one way: the file system's root (chosen: an agent can set the variables) vs the variables (cheaper, spoofable).
- (9) `rundll32 url.dll,FileProtocolHandler` without a shell (chosen) vs quoting for `cmd.exe start` (fragile with `%`,
  `^`, and the title argument).
- (16) rewrite `console.ps1` without CIM (chosen) vs `session-run.ps1` (needs admin, also CIM, blocked compile).

## Constraints

- AGENTS.md code standards: no fixed sleeps, smallest change, nothing left behind, every platform named.
- Core files touched: `core/observedHook.ts`, `hookServer.ts` (if needed), `lib/handoffPublication.ts`,
  `core/handoffPublication.ts`, `lib/terminalAgentReconciler.ts`, `core/main.ts`, `lib/windows/powershell.ts`; all already
  on the core list; `npm run test:core` covers them (100% coverage on core files).
- No secrets or identifiers in any new log line.
- Decisions by harness-pm (2026-11-21): `discoveryPasses` in `/api/status`, no per-pass log line; scale race in this
  PR only if a small fix at the cause (bounded retry on "identity is held", with a test), else split out; Desktop's git
  spawns in this PR; boot's two `auth status` paths blocked too, copy unchanged; cross-read scan on every PR that
  changes a component, `concurrency` added to the planner's whole-file sections. Windows checks on the shared ARM VM
  (192.168.64.5) only after asking harness-pm; the Dell is offline until Monday.
- Windows checks on a shared machine only on harness-pm's go; `cli-e2e.yml`/`windows.yml` dispatches only on
  harness-pm's go.

## Left to the builder

- The exact cause of the three open nightly failures in (1), from logs and repros.
- Whether the item (15) product siblings need a change (after the confirmation).
- Test names, helper placement and the precise wording of log lines within the rules above.
