# Agent browser: every Podman child ends with the agent browser's process

The agent browser's process (`harnessd-agentBrowser`, `src/services/agentBrowser.ts`) leaves a real `podman events`
running on the person's computer when it dies abruptly (a crash, SIGKILL, the OOM killer). Each crash and restart
leaves one more. The same holds for every other Podman command it starts. After this change, whenever the process ends,
in any way, every Podman command it started ends too, on macOS, Linux and Windows.

Platforms: macOS and Linux (the mechanism below), Windows (already true there; a test proves it).

## What was seen

- `podman.spawn` (`src/services/agentBrowser/podman.ts:156`) starts `podman events` in a process group of its own
  (`ownProcessGroup()`), and only `stop()` (`agentBrowser.ts:320`, through `events.ts` `close()`) ends it.
- The master ends a service by its pid alone (`harnessd/serviceSupervisor.ts:252`, `:255`, `child.kill`), never a
  group. Nobody ends the service's children when it dies.
- `podman events` reads no stdin, so it does not notice its parent is gone. It lives until a later event makes it
  write to a broken pipe, which on a quiet machine can be never.
- The same gap holds for every Podman command the process starts:
  - `podman.spawn`: `podman events` (`events.ts`), the tool server's `podman exec` (`agentBrowser.ts:158`), and the
    pipe to a browser's screen (`agentBrowser.ts:183`). The two `exec`s end today only because their stdin closes.
  - `podman.run`: every other Podman command, bounded by its timeout, up to 10 minutes for `machine start`, longer for
    an image build.
- Measured on Node 23 and the repo's Node 24: `execFile` passes neither `detached` nor `stdio` to `spawn`, so
  `ownProcessGroup()` in `podman.run` does nothing today, and `execFile` cannot carry the pipe below.
- Windows: Node (libuv) puts every child it starts without `detached` in a Job Object that kills it when Node exits in
  any way (`src/lib/windows/noWindow.ts`). `ownProcessGroup()` there is `windowsHide` alone, so `podman.exe`, a direct
  child, already ends with the process. What Podman starts in turn is not in the job, so a Podman machine started
  through Harness keeps running, as it should.

## Fix

One way the agent browser starts a Podman command, in a new module `src/services/agentBrowser/tied.ts`:
`spawnTied(file, args, options)`, a `spawn` whose child ends when this process ends.

- **macOS and Linux.** The child starts as
  `/bin/sh -c '{ read -r _ <&3 || kill $$; } </dev/null >/dev/null 2>&1 & exec "$0" "$@" 3<&-' file args…`, with a
  fourth stdio pipe (fd 3) from this process:
  - `exec` replaces the shell with the command, so the child's pid, stdio, exit code and signals are the command's own
    (`child.kill` reaches Podman directly, as today).
  - A background watcher holds the read end of fd 3. When this process ends, in any way, the OS closes the write end,
    the watcher reads end-of-file, and it sends SIGTERM to the command (`$$`, the pid `exec` kept).
  - When the command exits on its own, `spawnTied` writes a newline on fd 3 at its `exit`: the watcher reads a line and
    leaves without a signal. No watcher outlives its command.
  - The command does not inherit fd 3, and the watcher holds none of the command's stdio. Node's `close` also waits for
    fd 3, so it comes once the watcher has read the newline (about 55 ms after `exit`, measured).
  - The newline is written only while fd 3 is open, and fd 3 has an `error` listener: a watcher already gone (a spec
    ending its group) never crashes this process.
- **Windows.** A plain `spawn`: the Job Object already ends the command with this process.
- **Signature.** `spawnTied(file, args, { env, detached?, windowsHide?, platform? })`. stdio is always piped (both
  callers pipe all three today); on POSIX the fourth pipe is added. `platform` defaults to `process.platform`;
  `podman.ts` passes its own injected one.
- **Process groups as they are in effect today.** `podman.spawn` keeps `ownProcessGroup()` (detached on POSIX).
  `podman.run` passes only what `execFile` really applied, `windowsHide` on Windows and no `detached`: its children stay
  in the process's group, so the e2e harness's group kills still reach them.

Every Podman command goes through it:
- `podman.spawn` calls `spawnTied` in place of `spawn`.
- `podman.run` moves from `execFile` to `spawnTied`, settling on `close` (all output read), as `execFile` does. It
  keeps the stdin relay (`STDIN_RELAY`, now the tied command), stdin always ended, the timeout (SIGTERM, the same
  `timed out after` message), the 64 MiB output limit and the same `PodmanError` states and messages, with one
  exception: output past the limit ends the command and now reads `podman <cmd> printed more than 64 MiB` (today
  `execFile` reports it as a timeout, which it is not).
- A Podman removed after it was found: today a spawn `error` (ENOENT); through the shell it is exit 127 and sh's
  `not found`. `run` fails with `podman_failed` as for any failed call, and the event stream drops and reconnects with
  backoff (`events.ts` treats `close` as it treats `error`). Accepted.

Accepted risks:
- **Pid reuse.** If this process dies between reaping its command and writing the newline, the watcher SIGTERMs a pid
  that is free again. The window is the synchronous `exit` handler.
- **SIGTERM only.** A command that ignores SIGTERM outlives the process, as with `stop()` today. Podman exits on it.
- **Zombie watchers under a PID 1 that does not reap.** After its command exits, the watcher is reparented to PID 1
  (or the nearest subreaper) and reaped there. In a container whose PID 1 is Harness itself, each call would leave a
  zombie `sh`. Harness does not run as PID 1 on any supported install (launchd, systemd, a Windows task).

Not changed, by the orchestrator's decision (Ken's proxy): `hostTools.run` (`osascript`, `pkexec`, the Windows
installer). An installer ends by itself within its timeout, so it never leaks for long as `podman events` does, and
ending it midway can leave the person's computer half installed. It keeps today's behavior.

## Tests (red first)

1. `src/services/agentBrowser/tied.spec.ts`, real processes, every platform: a Node process stands in for the agent
   browser, starts a long-lived Node child through `spawnTied`, and reports both pids; the spec kills that process
   (SIGKILL; on Windows `process.kill`, which is TerminateProcess) and expects the child gone within a bound, polled,
   no fixed sleep. Also: a child that exits on its own keeps its exit code and leaves no watcher (the spec starts it
   detached and polls its group empty: a zombie still counts for `kill(-pgid, 0)` until it is reaped); `child.kill`
   reaches the command itself; stdin, stdout and stderr are the command's. Red today on macOS and Linux with plain
   `spawn` in its place (the child lives on).
2. `podman.spec.ts`: a stand-in process (run with tsx, as other specs do, with an injected `resolve` and the fake
   Podman; `oneShotParentEnv` must not start the real login shell) starts `podman events` through `podman.spawn` and a
   hanging call through `podman.run`; the spec SIGKILLs it, and neither fake stays running (the pids the fake logs,
   never a grep of argv: the watcher, a fork, shares its command's argv). Red today.
   The `run` specs that assert `execFile`'s options (`timeout`, `maxBuffer`, the argv at `:205`) become behavioral: a
   hanging call times out with its message, output past 1 MB (execFile's old default) is read whole, output past the
   limit fails with the new message (through a seam the planner picks, so no spec prints 64 MiB), the login-shell env
   reaches the fake (`FAKE_PODMAN_MARK`). The relay's group checks (`:277`, `:285`, vacuous today since no group
   exists) check the fake's and the relay shell's pids instead, polled.
3. `e2e/agentBrowser.e2e.ts:446` (the browser's process SIGKILLed under a panel): the fake `podman events` logs its
   pid when it starts; after the kill, the dead process's `podman events` ends before the test closes the daemon (the
   close ends leftovers since #4287, so the check is made before it). Red today. The `pipe started by process.ppid`
   check still holds: `exec` keeps the pid, so the fake's parent is the agent browser's process.

`tied.spec.ts` is added to the CLI specs `windows.yml` runs, so the Windows half is proven on a Windows runner.

## Out of scope

- Other services' children in a group of their own (`src/lib/codexRateLimits.ts`, `oneshot.ts`, …): a proposal to the
  PM if wanted.
- The master ending a service's process group.

## Verification

- Locally on this Mac: `tied.spec.ts`, `podman.spec.ts`, `events.spec.ts`, `toolServers.spec.ts`, `streams.spec.ts`,
  `agentBrowser.e2e.ts`; a process census before and after the e2e (no `podman events` naming the run's root left
  after the SIGKILL case).
- Linux: PR CI's CLI unit job runs the new specs (`/bin/sh` is dash there).
- Windows: `windows.yml` once on the orchestrator's go (its CLI specs step runs `tied.spec.ts`).
- `cli-e2e` once on the orchestrator's go, for `agentBrowser.e2e.ts` on Linux.
