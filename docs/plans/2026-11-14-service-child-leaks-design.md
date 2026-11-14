# Service children end with their service

A service process that dies abruptly (an uncaught error, SIGKILL, the OOM killer, the master's hung-heartbeat kill)
leaves the children it started running on the person's computer: the master ends a service by its pid alone
(`harnessd/serviceSupervisor.ts:252`, `:255`, `:268`), and nothing else ends what that pid started. A parent-side
timeout dies with its parent, so even a child "bounded" by one runs on. #4294 fixed this for the agent browser's
Podman commands with `spawnTied` (`src/services/agentBrowser/tied.ts`). After this change every child a service starts
that can leak (one that runs until stopped, or can run 30 s or more) ends when its service's process ends, in any way,
through that one helper.

Platforms: macOS and Linux (the mechanism below). Windows: already true for direct children (Node's Job Object,
`src/lib/windows/noWindow.ts`); nothing changes there, and the moved spec keeps proving it on `windows.yml`.

## Why

Each crash or restart of a service leaves one more: a headless Chrome per shared viewer, a `codex app-server` per
rate-limit read, a warm `claude --print` router worker, a `grid --remote join --serve` that runs up to 30 minutes, a
login flow holding a localhost port for 15 minutes. They cost memory and CPU, hold ports and locks, and nobody sees
them. Ken: find every child process every service starts and make each end when its service ends, with one helper.

## Goals, non-goals

- Goal: every in-scope child (the table below) ends within a bound after its service's process ends, on macOS and Linux.
- Goal: one helper, moved from `src/services/agentBrowser/tied.ts` to `src/lib/tied.ts`; the agent browser uses it from
  there. No copy.
- Goal: each caller keeps its behavior while its service lives: output, exit codes, errors (including "not installed"),
  timeouts, its own stop and group kill.
- Non-goal: the daemon core. No file listed in `src/architecture.coreFiles.txt` changes, and none starts importing
  `lib/tied.ts` (the architecture spec fails on a new core file).
- Non-goal: the master ending a service's process group (a second way to do the same thing).
- Non-goal: short probes that finish by themselves within seconds (list below).
- Non-goal: Windows (already covered).
- Anti-goal: a tied child that changes what a living service sees (a missing binary reported as a generic failure, a
  lost exit code, a stdin that never closes, an extra fd its own children inherit).

## The helper: `src/lib/tied.ts`

`spawnTied` keeps #4294's mechanism (read its header and `docs/plans/2026-11-14-agent-browser-podman-events-design.md`):
on POSIX the child is `/bin/sh -c TIED file args…` with a fourth pipe, fd 3; a background watcher holds fd 3 and
SIGTERMs the command (`$$`, the pid `exec` kept) when this process's end of it closes; a newline on fd 3 at the
command's `exit` lets the watcher go. On Windows it is a plain `spawn`.

What changes in it:

1. **Moved** to `src/lib/tied.ts` with its spec (`git mv`, so history follows), `windows.yml`'s spec path updated, the
   agent browser's imports pointed there. `agentBrowser/tied.ts` is gone.
2. **Spawn options the new callers need**, passed through to `spawn`: `cwd`, `env`, `detached`, `windowsHide`, and
   `stdio` as three entries (`'pipe' | 'ignore' | 'inherit'` or an fd, as callers use today); POSIX appends the tie as
   fd 3. Defaults stay `pipe` ×3, as the agent browser uses it.
3. **A detached child is ended as a group.** When `detached` is set the command leads its own process group, and every
   such caller today stops it with a group kill (`killGroup`, `killProcessGroup`). The watcher then signals the group
   (`kill -TERM -$$`), so what the command started in its group ends with it. Not detached: the pid alone, as today.
4. **A missing command fails as it does today.** Callers tell "not installed" from a spawn `error` with code `ENOENT`
   (`gridExec.ts:147`, `codexRateLimits.ts:68`, and others). Through the shell that would be exit 127. The tied spawn
   reports a command that is not there as the same `ENOENT` `error`, with no `exit`/`close` reading as a run (the
   builder picks how: resolving the file against the given env's `PATH` before spawning, or a shell-side check; it must
   hold for a bare name and for a path).
5. **An `execFile`-shaped call** for the callers that use `execFile` (or its promisified form) today: timeout and
   `killSignal`, `maxBuffer`, `cwd`, `env`, optional stdin input (stdin always ended), settling on `close`, and an error
   shaped like `execFile`'s (`code`, `killed`, `signal`, `stdout`, `stderr`, `ENOENT` as above), so a converted caller's
   error handling does not change. It is built by moving `podman.run`'s loop (`agentBrowser/podman.ts:107-161`) into
   `lib/tied.ts`; `podman.run` then calls it and keeps its `PodmanError` states and messages. One loop, not two.

Windows: both are the plain `spawn`/`execFile` they replace.

## In scope: children that are tied

Each row's helper moves from `spawn`/`execFile` to `spawnTied`/the tied `execFile` call.

| Service (host) | Site | Child | Why it leaks today |
|---|---|---|---|
| sharing; viewers (`lib/interactiveViewer.ts`) | `sharing/viewer.ts:52` `ViewerCapture.start` | headless Chrome, up to 8 | runs until `stop()`; no group, stdin ignored |
| viewers, store (viewers host); wifi (devices host) | `dsh/shell.ts:167` `spawnDshCommand` (and `runDshCommand` through it) | DSH viewer servers; Store setup, doctor, workspace init in the login shell | own group, stdin ignored; setup up to 30 min |
| store; wifi | `dsh/install.ts:266` `streamGit` | `git clone/fetch/checkout` of a Store package | up to 10 min; the Store setup it precedes is in scope, and a clone nobody awaits is never used |
| windowNames (edge); devices (voice router, `lib/voiceRouter.ts`) | `lib/oneshot.ts` workers `:152 :262 :351 :480 :630 :726 :804 :934` | `claude --print`, `codex exec`, cursor, opencode, kilo, pi, commandcode, grok | own group; the warm router worker lives while a dial is connected plus 5 min |
| usage (edge) | `lib/codexRateLimits.ts:51` | `codex app-server` | own group, 10 s parent-side bound |
| engine-codex | `engines/codex/nativeControl.ts:23` | `codex app-server proxy` | cached until it fails or closes |
| engine-codex | `engines/codex/providerMove.ts:66`, `:51` | `codex app-server`, `codex debug models` | 30 s per request |
| connectors (edge) | `lib/connectors/elsewhere.ts:139` `run` | `claude mcp list` (starts every MCP server), `codex plugin list/add/remove` | up to 5 min; stdin never ended |
| superTabs | `superTabs/claudeSignIn.ts:209` `startEngineLogin` | `claude auth login`, `codex login` (a localhost server) | waits for the person, 15 min |
| superTabs | `superTabs/machines.ts:1317` `createQuietGit` | `git status/remote/push --dry-run` | own group; the network |
| superTabs | `lib/worktreeSweep.ts:30` | `git` | 30 s bound |
| osDevice (edge) | `services/osDevice.ts:120` `githubDeviceSignIn` | `gh auth login --web` | waits for the person, 15 min |
| osDevice (edge) | `agentClient/computerUse.ts:94` | `opencode reload` | 30 s bound |
| models | `lib/gridFleetRpc.ts:75` | `grid --remote join --serve`, `leave`, `start`, `sync`, pulls | up to 30 min |
| models | `lib/gridExec.ts:109` | `grid --remote ls/sync/start/models/info/mcp config`, `grid version` | 30 s bound |
| models | `lib/gridHandoff.ts:140` | `grid login --harness --json` | 60 s bound |
| models | `lib/appModels.ts:45` `exec` | `node fleet.mjs models` (60 s), `lms ls/server start/load/unload/stop` (30 s to 10 min) | as listed |

The builder checks each row's file against `architecture.coreFiles.txt` before changing it (none is listed today) and
follows any caller of the same helper outside the services (a `harness` CLI command): tying there is harmless, since
the command's process is its parent too.

## Out of scope, and why

- **Short probes that finish by themselves** (bounded under 30 s, nothing waits on a person or a server): `ps`,
  `lsof`, `ioreg`, `system_profiler`, `nvidia-smi`, `du`, `sqlite3`, `tmux -V`/`list-panes`, local `git` and `gh`
  calls, `opencode models`, `codex login status`/`claude auth status`, `hn --version`, the memory package's
  `mem.mjs` (25 s), the updater's canary (15 s), the serial port probes, the viewer ledger's `ps`. Sites:
  `cable/serial.ts`, `cable/boardReset.ts`, `projectPreview`, `agentHandoff`, `machineHardware`, `harnessResources`, `macosProcessGpu`,
  `harnessTelemetry`, `sessionSearch/externals/support.ts`, `viewerLedger`, `gpuProcesses`, `tui/*`, `dsh/install.ts:94`,
  `lib/github.ts`, `lib/gitPullRequest.ts`, `lib/engineAccount.ts`, `services/windowNames.ts:124`, `services/memory.ts`,
  `lib/selfUpdate.ts:343`, `agentClient/computerUse.ts:87`.
- **Installers and system changes that must not stop midway** (#4294's decision): `lib/gridInstall.ts:110`,
  `superTabs/contribution.ts:61`, `lib/runtimeInstall.ts:96`, osDevice's `execBounded` (`services/osDevice.ts:152`:
  `setup password`, `install-gh`, network setup, the status check).
- **Meant to outlive the service:** osDevice's `spawnDetached` (`harness update`, reboot, `setup join/sign-out`),
  `lib/appModels.ts:214` `ollama serve`/`llama-server` ("so it outlives this daemon").
- **Windows only** (the Job Object ends them): `cable/windowsSerial.ts`, `lib/windows/ptyPayload.ts`,
  `lib/windows/guestSetupClient.ts`, `lib/windows/gitBashTree.ts`, `lib/windows/powershell.ts`.
- **Started through a file the core loads** (`architecture.coreFiles.txt`; the core's own rules, a separate change):
  `lib/patientExec.ts` and `lib/offThreadExec.ts` (their callers `processTable`, `tmuxVersion`,
  `windows/processTable`, `engines/claude/backgroundJob`, `kit/launchExecutable`, `processEnv`), `lib/gitProject.ts`
  (including `worktreeAdd`, up to 10 min, detached), `lib/projectFolder.ts` (including the superTabs `git clone`,
  detached), `lib/guestRunner.ts` (the guest helper's `sudo`, `osascript`, `pkexec`, up to 10 min),
  `lib/engineLaunch.ts`, `lib/loginShellEnv.ts`, `lib/engineBin.ts`, `lib/tmuxOnPath.ts` (login-shell probes, 5 s),
  `lib/branchNaming.ts`, `lib/agentProject.ts`, `lib/sshHosts.ts`, `lib/sqliteRead.ts`, `lib/processLiveness.ts`,
  `engines/kit/nativeEvidence.ts`, `lib/peerAccount.ts`, `lib/nativeProcessImages.ts`, `lib/ptyHost/launch.ts`.
  The long ones here (`worktreeAdd`, the clone, the guest helper) are a known gap for a core change.
- **The master's own probes** (`harnessd/reexec.ts:269`, `masterProcess.ts:351`): the master is not a service.
- **Grandchildren** of a non-detached tied child (an MCP server `claude mcp list` started, rc-file programs of a login
  shell, a model server `grid` started): the tie ends the command it started, as its own stop does today; what that
  command started is the command's to end on SIGTERM. A detached child's group ends with it (helper change 3).

Accepted risks, as #4294: a command that ignores SIGTERM outlives its service, as it outlives its stop today; pid reuse
in the window between reaping and the newline; a zombie watcher under a PID 1 that does not reap (Harness never runs as
PID 1). Harness OS runs every service inside the core's process with no master (`HARNESS_NO_MASTER=1`): there the tie
ends children with that process, which changes nothing while it lives.

## Tests (red first)

1. `src/lib/tied.spec.ts` (moved): its #4294 cases keep passing from the new path, plus, red first:
   - a detached tied command and a child it started in its group both end after the stand-in's SIGKILL;
   - a command that is not there is an `ENOENT` `error` (a bare name and a path), with nothing reported as a run;
   - the `execFile`-shaped call: output and exit code, a timeout with its signal and error shape, `maxBuffer`, stdin
     input ended, `ENOENT`; and a stand-in SIGKILLed mid-call leaves no child.
   `podman.spec.ts` stays green on `podman.run` through the shared call.
2. **Per row of the in-scope table**, red today: a stand-in service process (a Node script run with tsx, as
   `tied.spec.ts` and `podman.spec.ts` do) starts that row's child through the row's real helper, with a fake binary
   (a Node script that logs its pid and waits) put in by the helper's existing seam (an injected path or `spawn`, the
   env's `PATH`, an engine path variable); the spec SIGKILLs the stand-in and polls, with a bound and no fixed sleep,
   that the fake's pid is gone (and its group, for a detached row). Rows that share one helper share one spec (the
   oneshot workers: one spec over the engine kinds whose binary the spec can point at a fake). A pid the fake logs,
   never a grep of argv (the watcher shares its command's argv).
3. Each converted caller's existing specs stay green; a spec that asserts `execFile`'s or `spawn`'s options becomes
   behavioral, as #4294 did for `podman.run`.

## The viewer ledger stays (my call)

`dsh/viewerLedger.ts` records each DSH viewer server's pid and, at the viewers service's next start, ends the groups a
dead daemon or service left (SIGTERM, then SIGKILL). It stays as it is: it is not a second way to end a viewer with its
service, but the cleanup at the next start for what the tie cannot reach: a viewer that ignores SIGTERM (the ledger
escalates to SIGKILL), the viewers left by a build from before this change, and Windows' Git Bash leftovers. The tie is
what ends a viewer at once; the ledger only acts if the viewers service starts again, which on demand may be never.

## Left to the builder

The seams for each stand-in spec, the exact shared `execFile`-shaped signature, how `ENOENT` is detected, and the task
split. Where a caller relied on a spawn detail the tie changes (an fd it passes, `shell: true`, a `stdio` it never
pipes), keep the caller's behavior and say so in the plan.

## Verification

- This Mac: the moved `tied.spec.ts`, every new stand-in spec, and the converted callers' specs.
- Linux: PR CI's CLI unit job runs them (`/bin/sh` is dash there).
- Windows: `windows.yml` once, on the orchestrator's go: it runs `src/lib/tied.spec.ts` from its new path (the plain
  spawn and the plain `execFile`-shaped call on Windows).
- `npm run test:core` once at the end (the architecture spec: no core file added or changed).
