# Small fixes batch (2026-11-21): flaky tests and small bugs

## Intent

One pull request that removes a batch of flaky tests and small bugs found during recent work (#4483, #4513, #4517 and
CI runs). AGENTS.md: a flaky test is a bug. Each fix removes the cause; no test is loosened, no timeout is raised as the
fix, no fixed sleep is added, nothing is rerun to green.

## Goals

- Every item below is fixed at its cause, or dropped with the reason.
- Where a behavior changes, a test fails first (red commit) and then passes.
- Where only a test is wrong, the evidence is a deterministic repro of the race (an injected delay or held clock) that
  fails on the old test and passes on the new one.
- "A fix covers every case of the same cause": each fix also covers the sibling cases named below.

## Non-goals

- No new feature, setting, screen or copy.
- No change to the core's rules or its file list beyond what a fix needs (`architecture.coreFiles.txt` gains no file).
- Fixed sleeps in `cli/e2e/twodaemons.e2e.ts` other than the 3 s one (the 12 s and 6 s "nothing happens" windows can
  only pass falsely under load; replacing them needs an observable reconcile count, a separate item).
- The boot-screen copy shown while `harness uninstall` holds its marker (item 3) stays as it is.
- Companions git-backed lesson specs (`publish.more`, `export`, `store`, `usage`) that failed once with all cores
  loaded: not investigated here; listed in the final report.

## Dropped

- **(10) cli `hachi.spec` in test:core**: already fixed on main by #4490 (f6cf1d6e20, a date time-bomb). `npm run
  test:core` passes on main (262 files, 5833 tests).

## Items

### Desktop

**(1) `desktop/test/terminal_session_test.dart` "input larger than the daemon accepts is split…" reads 65536, not 70000,
under load.** Test bug: the test sleeps a real 12 ms (`:1037`) waiting for the 4 ms input timer
(`terminal_session.dart:1424`); under load both timers fire in one batch and the test asserts before the timer's
microtask sends the last 4464 bytes. No byte is lost (measured: 46% red under 24 CPU hogs, 0/150 with the fix).
- Fix: run the test under `fakeAsync` and `async.elapse` the coalesce window, as `:2144` already does.
- Same cause: the other ~23 `Future.delayed(12 ms)` waits on that 4 ms timer in this file (`:385`, `:403`, `:429`,
  `:797`, `:885`, `:990`, …) convert the same way.
- The test's comment claims it covers the 64 KiB split loop in `_flushInput` (`terminal_session.dart:1461-1472`), but
  `_inputBytes` never holds more than 8 KiB, so that loop is unreachable. Builder: if no caller can reach it, delete it
  (AGENTS.md: no dead code) and fix the comment; if one can, give it a test that reaches it. (Our call.)

**(2) Two concurrent `flutter test` runs into a fresh `desktop/build/` leave `ink_sparkle.frag` Vulkan-only; 84 files
fail.** Cause is in flutter_tools (fixed `build/unit_test_assets` path, shared impellerc outputs, a silent fallback to
Vulkan-only, mtime-only rebuild check); reproduced on Flutter 3.47.5. Ours: `scripts/validate-change.py` `run_checks`
starts up to 2 checks at once and can start two `flutter test` checks in the same folder; `scripts/test-desktop.py`
goes through `run_checks`.
- Fix: `run_checks` never runs two `flutter test` checks in the same folder at once (others still run in parallel).
- Red: `scripts/tests/test_validate_change.py`, two `flutter test` checks in one folder whose fake program records start
  and end; with jobs=2 they must not overlap.
- Name the outside cause in the PR: the flutter_tools race (no issue number looked up; the builder may find one).

**(3) `LocalCliDiscovery.ensureRunning` ignores the uninstall marker** (product bug). While `harness uninstall` holds
`~/.harness/uninstalling`, the app's boot, sign-in and machine retry (every 2-30 s) call `ensureRunning`, which spawns
`harness start` again; on Windows the new daemon then holds the files being removed.
- Fix: one private check `_flashing() || _uninstalling()` at both spawn points in `ensureRunning`
  (`local_cli_discovery.dart:303`, `:327`) and in the supervisor (`:458-463`). While held, `ensureRunning` returns the
  down probe and spawns nothing.
- Red: `test/local_cli_discovery_test.dart` — `ensureRunning` with the marker held spawns 0 (today 1); the mid-wait case
  under `fakeAsync` (not ready, then down) does not fall back to a spawn; plus the missing flash case beside them.

### CLI and companions

**(4) `master.spec` slow on loaded macOS.** macOS checks each new executable file on its first run, one at a time
machine-wide (~2 s each under load). `placeNode` (`cli/src/testing/placeNode.ts:39`) copies Node afresh on every call
(7 times in master.spec, also `processName.spec.ts`, `selfUpdate.spec.ts`).
- Fix: the unit run's globalSetup (`cli/src/__fixtures__/vitestRun.ts`) copies Node once into the run's folder, starts it
  once (`firstStart` from `testNode.ts`) and `provide`s its path; `placeNode` hard-links that copy (never the running
  Node, so #4395 stays fixed). `selfUpdate.spec`'s own `firstStart` goes. The e2e pool (`e2e/harness/testNode.ts`) stays.
- Red: `placeNode.spec.ts` "a placed Node is the run's started Node" (same inode).
- Numbers: master.spec time before and after on this Mac.
- Measured in recon on this Mac (arm64, native Node): a fresh copy's first start ~2.1 s under load; a hard link of a copy
  that already ran once starts in 0.05 s, even from another folder, so on native arm64 the check is per file. The note
  in `placeNode.ts` that a link costs as much as a copy is about x64 Node under Rosetta (its translation cache is per
  path); that case is not targeted. The task measures before it lands: if master.spec gets no faster here, it reports
  that and lands nothing for item 4. (Our call.)

**(5) `dsh/install.spec` and `dsh/portability.integration` hit 30 s under load.**
- portability: each case does ~75-80 `fsyncSync` calls through `writeManagedFile` (`cli/src/dsh/runtime.ts:110-120`), a
  second way to write a whole file beside `atomicWriteFile` (`lib/secureState.ts`). Fix: replace `writeManagedFile` with
  `atomicWriteFile`; CONTEXT.md (rewritten every launch, restore and fork) is written as `'cache'` (no flush);
  runtime.json and the person's instruction file stay durable. Every real launch gets faster too. Red: `runtime.spec`
  asserts CONTEXT.md is written as cache.
- install.spec: `beforeEach` writes a fresh `test-shell` per test (`install.spec.ts:16-23`, same in
  `update.spec.ts:70-72`), one more first-exec check each. Fix: write it once per file in `beforeAll` and run it once
  before any test. The rest of the spec is local git and new scripts by nature; no single further cause.
- Numbers: both specs' time before and after.

**(6) Registry specs still run on a real 5 s write deadline.** `REQUEST_MS = 5_000` (`registryPersistence.ts:15`) is a
real `setTimeout` plus a `performance.now()` check. 12 specs never own it (`registry.diskFailure`, `.externalResume`,
`.fingerprint`, `.firstTask`, `.hermesHome`, `.launchCallers`, `.launchIdentity`, `.namesCost`, `.openclawLocal`,
`.persistence`, `.persistenceCost`, `.quarantine`), two own it only partly (`registry.admission` outside
`httpFixture`, `registry.hookPersistence` before its spy), and four carry their own copy of the same ~25-line fix
(`registry.spec`, `registry.binding.spec`, `registry.homes.spec`, `registryAdmission.golden.spec`).
- Fix: one helper, `cli/src/testing/registryDeadline.ts`: holds the deadline timer instead of scheduling it on the
  host's clock (matched by a constant exported from `registryPersistence.ts`, not the literal), returns `expire()` for a
  test that means to fire it, and exports a "slow sync" `fs/promises` factory that fires pending real waits as a loaded
  disk does. The `vi.mock('node:perf_hooks', …)` line stays in each spec (vi.mock must be hoisted there). All 18 specs
  use it; the four copies go.
- Red: with the slow-sync factory and no helper the specs reject with "write deadline exceeded"; with it, green.

**(7) companions `memory/runtime.spec.ts` "rejects a native-session replace during the read" flaky on CI** (run
44482400232: fails at `:118`, receipt null). The recall (`companions/src/memory/runtime.ts:303-323`) has a 200 ms
deadline on the real `performance.now()`; a 200 ms stall on a loaded runner returns `timeout`. The product behavior is
right; the tests depend on machine speed. One test (`:322-329`) already froze the clock after an October CI failure.
- Fix: the runtime takes its deadline clock as an input (default `performance.now`); the spec's `beforeEach` gives it a
  held clock; the one-off freeze goes. New test: the clock moves past 200 ms inside `prepareRecall` → `timeout`, no
  receipt (fails first; the deadline branch has no test today).

**(8) `cli/e2e/hookclient.e2e.ts:368` "claude in a tmux session the person opened by hand…" flaky.** "Ready" is printed
before the hook install by design (#1166, guarded by `src/startupOrder.spec.ts:147`); the test stops the daemon right
after ready, cutting the install. Fix the harness, not the product:
- `IsolatedDaemon.start()`'s default `'wired'` readiness (`e2e/harness/daemon.ts:645-649`) also waits for the first
  `[hooks] installed …` / `… already installed` line of every engine in `HOOK_INSTALL_ENGINES`, then runs
  `assertHooksStayedInside()`. Correct the false comment at `daemon.ts:647`. This covers every e2e test that relies on
  hooks right after start.
- Changed while building (child's call, 2026-11-21): the default `'wired'` readiness stays as it is, because waiting
  there for every engine's install broke `e2e/eagerHooks.e2e.ts` (it holds an install on purpose) and risks Hermes,
  which may log no install line. Instead the harness has one explicit wait, `hooksInstalled(engines)`, which every
  e2e file that runs an engine by hand right after start calls (hookclient and 17 device/dial files).
- Same file: the fixed 6 s sleep at `hookclient.e2e.ts:386` waits instead for the daemon's log line that it handled that
  session's `UserPromptSubmit`, then asserts no agent was made.

**(11) `cli/src/cable/cableFleet.spec.ts:139` failed under load ~80.** The drop's wait is stamped with `Date.now()`;
the test polls and then sleeps a real 120 ms against a 200 ms wait. Same race in the test at `:93-116` (real 350 ms
sleep against 300 ms).
- Fix (test only): fake only `Date` (`vi.useFakeTimers({ toFake: ['Date'] })`), record `at = Date.now()` before each
  flood, and use absolute `vi.setSystemTime(at + 199)` / `(at + 200)` around each scan. Absolute, not
  `advanceTimersByTime` (`vi.waitFor` advances a faked clock per poll). Repro: a 100-400 ms injected delay fails the old
  tests, passes the new.

**(13) `cli/e2e/twodaemons.e2e.ts:285` closes the fake orphan socket on a fixed 3 s timer** (failed under load ~108).
The new core must ask that socket at least once and log `…waiting for it to leave` (`lib/localSocket.ts:448`) first.
- Fix: close the socket after it has answered its second status request (proof the core waited a round); close it in a
  `finally`; `refuseServedDataFolder`'s own 20 s bound stays the timeout. Repro: a 3.5 s delay before
  `restarted.start()` fails the old test, passes the new.

**(14) POSIX `ps` callers not guarded on Windows** (list started in
`docs/plans/2026-11-20-discovery-cwd-windows-confirm-plan.md`). One way to read the process table on every OS:
- `processRows()` (`lib/processTable.ts:421-433`) with no source installed falls back to `windowsProcessRows(null)`
  (`lib/windows/processTable.ts:90`) on win32 instead of `ps`. Both files are already core files. Then
  `lib/uninstall/ptyHosts.ts:190` drops its own win32 branch.
- Callers needing only pid, parent or args read `processRows()`: `cable/hosts/vscodeTerminals.ts:62-63`
  (`readProcessParents`; today VS Code/Cursor terminals cannot be matched on Windows), `lib/appModels.ts:252` (`ours`,
  match on `args`).
- Callers needing a POSIX-only field (tty, pgid/tpgid, rss/cpu, state, cwd) answer "unknown" on win32 without spawning:
  `hook/notify.mjs:1880-1891` `processStartMarker` (early return, as #4517 did in `processLiveness.ts:37`),
  `vscodeTerminals.ts:79-82` `readForeground` (`undefined`), `lib/harnessResources.ts:57-58` `sampleProcesses`,
  `lib/externalOwnerControl.ts:9-10` (`'unknown'`), `lib/sessionSearch/externals/support.ts:327-329` `processTtys`
  (and its `lsof` calls at `:251`, `:316`, `:319`), `engines/kit/nativeEvidence.ts:42-47` `nativeProbe`
  (`nativeUnavailable`, which also covers `lsof` and `lib/processEvidence.ts:80,98`).
- Already safe on Windows, no change: `dsh/viewerLedger.ts:80`, `lib/processTree.ts:35`, `lib/tmux.ts:112`,
  `engines/kit/downloadMarker.ts:71`, `cable/hosts/scannedApp.ts:84,94`, `cable/hosts/tabs.ts:41`,
  `cable/hosts/herdrOuter.ts:149`, `lib/callerPane.ts:155`, `lib/registryPersistence.ts:236`, `lib/pidFileSettle.ts:81`,
  `lib/signOut.ts:82`, `testing/spawnedRuns.ts:38`.
- Red: one spec per caller, win32 simulated through the injected platform/exec seam each already has (or
  `Object.defineProperty(process, 'platform', …)` as `processLiveness.spec.ts:82-90` does for the hook copy): no spawn
  of `ps`/`lsof`, and the expected answer. `processLiveness.spec.ts`'s Windows case moves into the `describe.each` over
  daemon and hook so the hook's copy is covered.

**(15) A relative `HARNESS_ENV_FILE` / `DOTENV_CONFIG_PATH` / `ADAPTER_DATA_DIR` resolves against different folders
in different processes** (the master against its start folder, the core and daemon against home after `enterHome`;
the CLI against the shell's folder). A relative env file can fail every core start; a relative data folder splits the
pid file, lock, socket and log across two places.
- Decision (harness-pm, 2026-11-21): no refusal. A relative value means relative to the person's home in **every**
  process: the CLI, the master and the core, before and after `enterHome`. That is what a service started with
  cwd = home does today, so no installed machine changes behavior on update and none can get stuck in a probation
  rollback. One helper applies it to every Harness file and folder override.
- Fix:
  - One helper (say `homePath(value, home)` in `config/`): an absolute value as given, a relative one joined to the
    home folder (`os.homedir()`, the same home `enterHome` enters), never to `process.cwd()`.
  - Env file: `loadEnvFile` (`config/loadEnv.ts`) resolves `HARNESS_ENV_FILE` / `DOTENV_CONFIG_PATH` through it
    instead of `resolve(file)`. One exported reader, also used by `homeMove/conditions.ts:77-79` (today its own
    `resolve(file)`).
  - Folders: a path field kind in `config/envFields.ts` that resolves through the helper, used for `ADAPTER_DATA_DIR`
    and every other Harness folder or file override read as a path (`HARNESS_AUTH_DIR`, `HARNESS_LOGS_DIR`,
    `HARNESS_PTY_DIR`, `HARNESS_DEVICES_DIR`, `HARNESS_HOOK_ROUTES_DIR`, `HARNESS_AGENT_MESSAGES_DIR`, `DSH_DIR`,
    `ADAPTER_COMPUTER_ID_FILE`, `ADAPTER_CLI_DIR`, `ADAPTER_RUNTIME_DIR`, `HARNESS_BIN_DIR`). Engine `*_PATH` variables
    can be bare command names and stay as they are. Raw `process.env` reads of these (e.g. `migrateLegacyAdapterState`,
    `env.ts:77-78, 87`, which runs before `validateEnv`; `lib/authSession.ts`) go through the same helper, so no reader
    resolves against the current folder. Builder: find every reader of each variable.
  - `CARRIED_ENV` (`lib/platformDaemon.ts:43`) copies values verbatim into the service definition; with the helper a
    relative value there means the same folder in every process, so it needs no change.
- Docs: `docs/cli.md:118`, `docs/development.md:93` and `cli/README.md:276,292` say "absolute, or relative to your home".
- Red: `config/loadEnv.spec.ts` (a relative `HARNESS_ENV_FILE` with the file under home, process started in another
  folder: today it reads the other folder's file or fails; expect home's), the same for `DOTENV_CONFIG_PATH`;
  `config/env.spec.ts` (`ADAPTER_DATA_DIR: 'data'` from another cwd → `<home>/data`); `envFields.spec.ts` for the field
  kind; a spec for the CLI-side reader (`harness status`'s pid-file path) from a non-home cwd.

### Windows

**(9) `peerAccount.windows.real.spec` "still gets the same yes from PowerShell, for an older host" timed out on
windows-11-arm (93.7 s).** #4513's fix (F) changed only the harness-device plugin hook, not `cli/src/lib/peerAccount.ts`.
Same cause as (F), still here: `windowsPeerQuery` (`peerAccount.ts:199`) and `windowsListenerQuery` (`:241`) rely on
PowerShell module autoload for `Get-NetTCPConnection` (NetTCPIP), `Get-CimInstance` / `Invoke-CimMethod` (CimCmdlets).
On arm64 that search costs ~25-45 s (x64: 1-2 s), against a 45 s bound (`WINDOWS_PEER_MS`); `ptySignatures.ts:47`,
which imports by `$PSHOME` path, takes 1.8 s on the same runner. The product pays it too: the connectors bridge's port
check runs `windowsListenerQuery` each time.
- Fix: those scripts turn autoload off and import their modules by `$PSHOME\Modules\…` path, as `ptySignatures.ts:47`
  does. Same cause: `storePackage.ts` (`Get-AppxPackage`, 10 s bound), `guestScript.ts`, `team/windowsRemoveScript.ts`,
  `signOut.ts`, `uninstall/removal.ts`.
- Red: a static spec (like `harnessDevicePlugin.spec.ts:107`): every script run through `runPowershell*` that calls a
  module cmdlet imports that module by path with autoload off. On the windows-11-arm runner the real spec's time drops
  from 24-45 s to a few seconds (recorded from the windows.yml run).
- The cause on arm64 is a strong hypothesis from timings, not measured on a machine; the windows.yml run is the proof.

**(12) After a reboot, Claude Code panes say "pty host could not respawn the pane: no reply within 5000 ms"** (seen
again on #4517's VM run: six panes reopened at once, two hit it, all agents confirmed within 23 s — the host finished,
the daemon's deadline dropped the late reply). Ours:
- Restore creates a held pane, then respawns the engine over it (`restoreAgents.ts:703-704`). The host's respawn
  (`pty/src/panes.rs:405-451`) ends the old child first: up to 2 s grace (`job.rs:180`), then 1 s + 1 s
  (`pane.rs:722-727`, `panes.rs:51,55`). The Windows held pane (`cli/src/lib/windows/engineStart.ts:76`) ignores SIGHUP,
  so it never ends on the close and always costs the full 2 s; the Mac's held pane (`heldLaunches.ts:180`) does not
  ignore hangup and ends at once.
- Every op has the generic 5 s deadline (`cli/src/lib/ptyHost/client.ts:49`, `:255-264`), which leaves 1-3 s for a cold,
  just-booted console and `claude.exe` start, and anything queued ahead on the one control connection.
- Fix: (a) the Windows held pane stops ignoring SIGHUP, as on the Mac, so a respawn over it ends it in milliseconds;
  (b) `create` and `respawn` get their own deadline (the PR carries the measurement that justifies it) sized from the host's known waits (2 s + 1 s + 1 s) plus a cold-start
  budget, named as constants beside the host values, instead of the generic 5 s; (c) the host logs how long each create
  and respawn took (no content, no identifiers).
  - Deadline sizing (our call): per operation, from the request's send, as today; no queue-aware clock. With (a) a
    respawn costs the console and engine start only, so restoring six panes at once fits. `create`/`respawn` get 15 s:
    the host's own 4 s of waits plus an 11 s cold-start budget, set from #4517's VM run (six panes after a reboot, all
    agents confirmed within 23 s). Other ops keep 5 s. Outside causes named in the PR: Defender's first-run scan and boot load.
- Red: (a) in the Windows contract suite against the real host, beside `ptyHostBackend.restart.spec.ts:148`: create a
  pane with the real `windowsHeldPaneArgv`, respawn under its token, reply in under 1 s (today ≥ 2 s); (b) a fake-timer
  unit spec in `ptyHost/client` where a respawn reply at 6 s still succeeds and one past the new deadline still fails.
- Builder: confirm the SIGHUP claim (libuv delivers CTRL_CLOSE as SIGHUP and the console waits on the handler) before
  relying on (a); if wrong, (a) is whatever makes the held pane exit on the close.

## Constraints

- AGENTS.md code standards; cli/AGENTS.md "protect the core" (no new core file; items 14 and 12 touch core files only to
  fix them); docs/windows-rules.md for items 9, 12, 14.
- No fixed sleeps; tests use held clocks, injected delays or events.
- Heavy GitHub runs (cli-e2e for items 8 and 13, windows.yml for items 9, 12, 14) only on harness-pm's go; the shared
  Windows ARM VM only on its go.
- Local gates for touched areas (cli `npm run test:core`, desktop, scripts) recorded in the PR.

## Approaches

One sensible way per item; the alternatives are the ones AGENTS.md forbids: raising timeouts, retries in tests, or
rerunning to green. For item 12, a retry or a state check after "no reply" was set aside for removing the 2 s cause and
sizing the deadline to the work. For item 2, a lock file under `desktop/build/` would also cover hand-run concurrent
tests but needs a cross-platform lock; serializing in `run_checks` is smaller and covers every repo path.

## Left to the builder

Task split and order; exact helper names; which items share files (6 and 4 both touch `cli/src/testing/`; 14 and 9
both touch Windows lib files; 15's `envFields` change and 4's globalSetup are independent).
