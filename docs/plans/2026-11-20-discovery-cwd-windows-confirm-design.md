# Discovery after a deleted start folder, and engines left unconfirmed on Windows: design

Two daemon bugs, fixed in one pull request.

1. **A start folder deleted after the daemon starts breaks discovery for good** (known cause). A firmware flash ran
   `harness start` inside a git worktree, then the worktree was removed. The master kept the deleted folder as its
   working directory, the core inherited it, and from then on `process.cwd()` threw `ENOENT`. Discovery logged
   `[discovery] process table unavailable; keeping existing terminal agents` every 5 s, the runtime-profile pass logged
   `[runtime-profile] periodic reconcile failed: ENOENT: process.cwd failed` every 5 min, and an auto-update did not
   clear it.
2. **A Windows 11 user on CLI 0.6.78 has every tab stuck on "Waiting to confirm the native engine process"** (cause to
   find). After a restart the tabs read "Not confirmed" (`RESUME_UNCONFIRMED`); the dial shows days-old cards and its mic
   says "This agent process is no longer running". Restarting did not help. Reproduce it first; fix it here only if it
   reproduces.

## Goals

- A daemon whose start folder is deleted later keeps finding and confirming engines, with no restart.
- The master and the core never depend on the folder `harness start`, launchd, systemd or Task Scheduler ran them in.
- When discovery cannot look, its log line and `harness status`'s discovery error say why: the process table could not
  be read, or the engines' executables could not be resolved, and the error kind.
- Windows: the report reproduced and fixed with a red test, or, when it does not reproduce, the PR body says exactly
  what was tried and what was seen, and we wait for the user's log.
- Windows: `harness stop` and `harness start` never run a POSIX `ps` they happen to find on PATH (part 5).

## Non-goals

- How a pane picks its folder: an agent's pane still starts in the agent's own folder.
- Services' code: they inherit the master's folder (below).
- The 5 s cadence of the discovery warning, and the "Waiting to confirm" copy, unless the Windows cause needs it.
- No setting, flag or switch.

## Anti-goals

- Discovery must still keep every agent when the process table really cannot be read; the fix never turns "could not
  look" into "nothing is running".
- No test touches the person's real daemon (port 18473) or their homes. Isolated daemons only, each started from a
  stable folder.
- No PATH contents, folder names or other personal content in the new log lines.

## How it works today (from the code)

- `harness start` spawns the master with no `cwd` (`cli/src/cli.ts:1755`, `daemonSpawnOptions` in
  `cli/src/lib/daemonLaunch.ts`); on Windows `harness-launch.exe` starts it (`lib/windows/launcher.ts`); launchd,
  systemd and Task Scheduler start it with their own folder. The master spawns the core with no `cwd`
  (`cli/src/harnessd/master.ts:460`) and the services the same way. Everything inherits the start folder.
- An update re-executes the master in place (`harnessd/reexec.ts`): same pid, same folder. So an update keeps a deleted
  folder too.
- Every master start goes through `startMaster` (`cli/src/masterProcess.ts:234`), from the bundle, the lean bundle or
  the sources; every core start goes through `startCoreProcess` (`cli/src/coreProcess.ts`).
- `ownershipKey()` (`cli/src/lib/engineBin.ts:368`) puts `process.cwd()` into the key that tells whether the inputs of
  an ownership pass changed, since a relative PATH entry resolves against it (#4339). With the folder deleted it throws
  `ENOENT` synchronously, before the `[engine] <kind>: executable ownership unavailable` line is reached.
- `probeTerminalAgents` (`cli/src/lib/terminalAgentDiscovery.ts:316-322`) returns `processTableAvailable: false` both
  when the process table read fails and when the ownership snapshot throws. The reconciler then logs
  `process table unavailable` and reports that string as the probe error (`terminalAgentReconciler.ts:351-369`), which
  `/api/status` serves as `discoveryError` (`core/main.ts:2218`). The log names the wrong cause.
- The new-pane watcher (`core/agents/newPane.ts`) and the restore watcher (`lib/restoreAgents.ts`) confirm an engine
  through `lookupPaneEngineProcess` (`lib/paneEngineProcess.ts`), which needs the same snapshot and answers
  `ENGINE_LOOKUP_UNAVAILABLE` (unknown) when it throws. So no engine is ever confirmed: after 10 minutes a launch with a
  native token is held as "Waiting to confirm the native engine process". Bug 1 shows exactly bug 2's symptom on macOS
  and Linux.

## Approaches

- **A. Enter a stable folder at start; take the folder out of the key; name the reason (chosen).** Two calls, at the one
  start of each process, cover every way it is launched, an update included, and every later relative-path use, not
  only the one we saw.
- **B. Give each spawn a `cwd`** (`harness start`, the Windows launcher, the master's spawn of the core and services).
  Rejected: more places, and it misses launchd/systemd/Task Scheduler and a master re-executed by an update, which
  keeps its own folder.
- **C. Only drop `process.cwd()` from the key.** Rejected: any other relative path the daemon resolves still throws
  (the runtime-profile pass did), and a relative PATH entry still fails the whole ownership pass.

## Design

### 1. The master and the core start in the person's home

- `startMaster` and `startCoreProcess`, as their first step (beside `ensureUtf8Locale`, before they start or read
  anything), change the process's folder to the person's home (`os.homedir()`). If that fails, the root of the
  filesystem the home is on (`/` on macOS and Linux), with one log line giving the error kind. A process never stays in
  the folder it was started in.
- Why home, not the data folder: the data folder is Harness's own and moves (the Linux home move to the XDG folders)
  or goes (uninstall, reset), and on Windows a process's working folder cannot be deleted while it runs, so the data
  folder as the daemon's folder would block an uninstall or a move. The home exists as long as the person is signed in.
- Why both processes: a master from before this fix still starts the new core after an auto-update, and a core can run
  with no master (`HARNESS_NO_MASTER=1`). The services, the tmux server and the PTY host inherit the folder of the
  process that starts them, so they need nothing of their own.
- Side effect on Windows, worth naming in the PR: the folder `harness start` ran in is no longer held open by the
  daemon, so it can be deleted (a `git worktree remove` there no longer fails while Harness runs).

### 2. The ownership key no longer reads the folder

- `ownershipKey()` drops `process.cwd()`. The folder no longer changes after start, so it says nothing about a pass's
  inputs. Relative PATH entries still resolve against the daemon's folder, now the home: no other behavior change.
- Any failure while the key or the pass's inputs are read rejects the returned promise and reaches the
  `[engine] <kind>: executable ownership unavailable` line; nothing throws synchronously out of
  `agentCommandOwnershipSnapshotAsync`.

### 3. Discovery names the real reason

- The probe says which of the two it could not do: read the process table, or resolve the engines' executables (with
  the error kind: `ENGINE_LOOKUP_FAILED`, `ENGINE_LOOKUP_TIMEOUT`, `ENGINE_LOOKUP_CHANGED`, `ENGINE_LOOKUP_PATH_LIMIT`,
  or a system code such as `ENOENT`).
- The reconciler's warning and the probe error it reports carry that reason, e.g.
  `[discovery] engine executables could not be resolved (ENGINE_LOOKUP_FAILED); keeping existing terminal agents`, and
  `[discovery] process table unavailable; keeping existing terminal agents` only when the table read failed. The same
  text reaches `discoveryError`. Error kinds only (`errorKind`), never paths or PATH contents.
- What discovery does in either case is unchanged: every agent is kept.
- The reason keeps the system code underneath (our call, so the next log can tell the leads apart): `engineBin.ts`
  today folds every unexpected code from a PATH folder or a candidate file into a bare `ENGINE_LOOKUP_FAILED`; it
  carries the original code with it (`ENGINE_LOOKUP_FAILED EPERM`, never a path), and `engineBin`'s own
  `executable ownership unavailable` line shows it. `lookupPaneEngineProcess`'s `ENGINE_LOOKUP_UNAVAILABLE` reason,
  which the new-pane and restore watchers and the reaper read, carries the same kind.

### Starting from the sources

Once the master works in the home, a bare `--import tsx` in its `execArgv` no longer resolves (Node resolves it from
the working folder), and the core it starts from the sources would fail. The `tsx` command passes an absolute loader
path and is not affected; the isolated-daemon helper (`cli/e2e/harness/daemon.ts:603`) and any script that starts a
daemon with `node --import tsx` pass the absolute path of tsx's loader instead (our call). CI runs the end-to-end
tests from the bundle and is not affected either way.

### Tests (red first, where the behavior lives)

- **End to end** (`cli/e2e/`, isolated daemon, fake engine): a daemon started from a temporary folder that is deleted
  once the daemon is up; then a new agent is created and its launch must be confirmed (ready), and the log must hold no
  `process table unavailable`, `executable ownership unavailable` or `process.cwd` line. Run with the master and with no
  master. Fails on `main`: the agent is never confirmed. The isolated-daemon helper starts every daemon from
  `CLI_ROOT` today, so it needs a way to name the start folder.
- **Unit:** the probe and the reconciler give the ownership reason when the snapshot fails and `process table
  unavailable` when the table read fails; `ownershipKey` with a deleted folder does not throw; the start of the master
  and of the core enter the home, and the fallback when the home cannot be entered.
- **An update clears it** (our call, since the report says an update did not): a check, not a CI test, on this Mac
  with an isolated daemon and its own data folder, port and start folder: release 0.6.78 started in a folder that is
  then deleted, an agent created and left unconfirmed, then the daemon updated (or its master re-executed) onto this
  branch's build; the agent is confirmed without a manual restart, and new agents are too. Agents already held as
  "Waiting to confirm" are retried by the restore path the new core runs (`lib/restoreAgents.ts`, held launches), so
  no new recovery code is planned; the check proves it.
- Platforms: macOS and Linux run the end-to-end test (Linux on CI). On Windows a running process's folder cannot be
  deleted; that is checked on the VM and recorded, not tested.

## The Windows report: reproduce first

Bug 1 cannot be bug 2's cause on Windows as far as the code shows (a folder in use cannot be deleted there, and Node's
`process.cwd()` on Windows does not fail for one); the reproduction checks this. Leads, none proven:

- **a. The ownership pass fails on a Windows error code.** `engineBin.ts` accepts only `ENOENT`, `ENOTDIR` and `EACCES`
  from a PATH folder or a candidate file; any other code fails the whole pass (`ENGINE_LOOKUP_FAILED`), and then no
  engine is confirmed anywhere, with discovery saying `process table unavailable`. libuv reports Windows'
  `ERROR_ACCESS_DENIED` as `EPERM`, and odd PATH entries (a folder the user cannot list, a quoted entry, an unexpanded
  `%VAR%`, a missing drive, the App Execution Alias folder) may give `EPERM`, `EINVAL` or `UNKNOWN`.
- **b. The process table read fails** (`lib/windows/processTable.ts`): the PTY host binary missing, an old host, the 3 s
  timeout, unreadable output; each is `null`.
- **c. The engine process is seen but not recognized**: an npm-installed Claude Code (`node.exe` running its `cli.js`),
  the native `claude.exe`, or an install folder missing from the daemon's PATH (the PATH the Desktop app started it
  with).

Where:

- The Windows 11 ARM VM (192.168.64.5), when harness-pm hands over its turn: release CLI 0.6.78 and the current Desktop,
  in a Windows user and data folder of our own; Claude Code and Codex; `harness stop`/`start`, a VM reboot, and an
  auto-update (0.6.77 updated to 0.6.78) if it can be done; read the data folder's `harness.log` for `process table
  unavailable`, `ENGINE_LOOKUP_*`, `executable ownership unavailable` and `[agent] create timed out`.
- GitHub runners, x64 (`windows-latest`) and ARM (`windows-11-arm`), through a temporary workflow
  (`.github/workflows/tmp-discovery-cwd-windows-confirm.yml`, push to this branch only, `contents: read`, no secrets,
  removed before the merge; approved by harness-pm): release CLI 0.6.78 signed out, Claude Code and Codex from npm, a
  baseline, a stop/start, the odd PATH entries of lead a with the error codes Windows gives for each, and a start folder
  deleted after start.

Outcome (harness-pm, 2026-11-20):

- **Reproduced through lead a**, on the user's setup or with a planted PATH entry of a kind real machines have (a
  folder the user cannot list, say): fixed in this pull request with a red test, and the PR says it is "a likely cause,
  not yet matched to the user's log". The fix covers the whole cause, on every OS, not only `EPERM` (part 4 below).
- **Reproduced through another lead:** this design and the plan are updated with that fix before its tasks start, with
  a red test at the layer where it lives.
- **Not reproduced:** no code change for bug 2. The PR body lists every scenario tried, where, on which build, and what
  was seen; the user's log will then name the reason (part 3).
- Either way the tasks of bug 1 do not wait for it. The merge does not wait for the user's log; it waits for the VM
  round (harness-pm hands over the turn; if everything else is green and the VM is still busy, ask harness-pm then).

Result of the GitHub round (run 44758521149, release 0.6.78, `windows-latest` x64 and `windows-11-arm`, alike):
**reproduced through lead a.** With one PATH folder the user cannot list (`icacls … /deny <user>:(RX)`: `stat` ok,
`opendir` `EPERM`, `access` ok), every pass logged `[engine] ENGINE_LOOKUP_FAILED: executable ownership unavailable`,
discovery `process table unavailable`, the restore `could not be surveyed · Unsurveyed`, and a new Claude Code and a new
Codex both stayed unconfirmed for the whole watch. The other odd entries (a quoted entry, an unexpanded `%VAR%`, a
missing drive, a relative `.`, the WindowsApps folder) answered `ENOENT` or ok, which are tolerated today. The
baseline, a stop/start and a start folder deleted after start all confirmed on Windows: there the installed copy's
master is started by `harness-launch.exe`, not in `harness start`'s folder, and the folder could be deleted. The VM
round still runs (with the user's own kind of setup, a reboot and an update) before the merge.

### 4. One bad PATH entry never fails the whole lookup

- Today a PATH folder or a candidate file that answers anything but `ENOENT`, `ENOTDIR` or `EACCES` fails the whole
  ownership pass, and so every engine on the computer goes unconfirmed. Instead, one rule for every error a folder's
  read gives (`EACCES`, `EPERM`, `EINVAL`, `ELOOP`, `UNKNOWN`, a broken junction, anything): the folder is probed by
  name, as `EACCES` is today. Each engine's known file names are looked up in it directly, because a folder that cannot
  be listed may still let a file in it be read by its name (a traverse-only folder), and skipping it could lose a real
  engine. The folder is skipped for the pass only when those probes fail too, or hang. A candidate file whose read fails
  is skipped, never the pass. A relative entry that cannot be resolved is skipped. The pass answers with the rest. On
  every OS.
- An entry whose read, its probes by name included, does not answer in a bound of its own (2 s: a dead network share, a
  hung junction) is skipped the same way, and is not read again while that read is still outstanding, so a hung entry
  never holds more than one of Node's filesystem threads and never holds the pass. The pass keeps its overall deadline
  as a last resort.
- Folders that could not be listed, and folders skipped, are counted and logged by kind, in one line, once: when that
  line would change, e.g. `[engine] PATH: 1 folder not listed (EPERM), probed by name` or
  `[engine] PATH: 1 folder not listed (EACCES), probed by name; 1 folder skipped (TIMEOUT)`; never per pass and never
  with the folder's name or path (AGENTS rule 7).
- `ENOENT` and `ENOTDIR` stay what they are today, an entry with nothing in it, and are not counted.
- Unchanged: the limits (`ENGINE_LOOKUP_PATH_LIMIT`), `ENGINE_LOOKUP_CHANGED`, and what a missing engine means. A
  skipped folder's engines are simply not found there, which is no worse than today, when none were found anywhere.
- Red tests in `engineBin.ts`'s own tests, with the error codes injected per entry and per file and a hung entry, for
  `EPERM` and `EACCES` at least; the Windows CLI specs (`windows.yml`) run them on Windows too.

### 5. `harness stop` and `harness start` run no POSIX `ps` on Windows

- Seen in run 44758521149 (release 0.6.78, both runners): right after every `harness stop` and every `harness start`,
  `ps: unknown option -- o` and "Try `ps --help' for more information.". GitHub's Windows images have Git's `usr\bin` on
  PATH, and its `ps` takes no `-o`.
- Cause, from the code: both commands take the spawn lock (`lib/daemonSpawnLock.ts`, `tryCreate`), whose owner record
  asks `processLockIdentity(process.pid)`; `processStartMarker` (`lib/processLiveness.ts`) runs
  `ps -p <pid> -o lstart=` on every OS but Linux, and `execFileSync` hands ps's error output to the console. On Windows
  the marker was always meant to be empty (that module's own comment: "which is what Windows gets"): a pid is all a
  Windows owner record holds, and where a reused pid matters the Windows process table proves it
  (`spawnLockOwnerReused`, read through `lib/windows/processTable.ts` by `harness start --if-down`).
- Fix: on Windows `processStartMarker` answers null and runs nothing. Every caller gets it at once: the spawn lock
  (`stop`, `start`, and the update, reset and logout that stop first), the agent client's locks
  (`agentClient/ledger.ts`, `agentClient/program.ts`) and `externalProcessGeneration`. What a lock means on Windows is
  unchanged.
- Red test in `processLiveness.spec.ts`, with the platform set to Windows: no `ps` and no `/proc` read, an empty marker.
- Out of scope: other POSIX `ps` callers elsewhere; the plan lists the ones seen.

## Constraints

- Core rules (`cli/src/core/AGENTS.md`): a fix, not a feature; any new file the core loads gets its line in
  `cli/src/architecture.coreFiles.txt`; `npm run test:core` coverage per file stays at 100%.
- Platforms: macOS, Linux, Windows x64 and ARM64. Nothing is stored, synced or exposed beyond the existing
  `discoveryError` string, whose text changes.
- Repo-required local gates for the touched area (`npm run test:core`, and the others `docs/validation-and-release.md`
  names for the CLI) run once, in the final checks.

## Left to the builder

- The helper's name and module for entering the home (one small module both starts use), and its log line's wording.
- How the probe carries the reason (a field on the probe result is enough), and the exact log wording within the shape
  above.
- How the isolated-daemon helper takes the start folder.
- Whether relative PATH entries stay as they are (proposed: yes, they resolve against the home).
