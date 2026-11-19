# A hook's caller outlives the hook: no Stop lost to a stalled core

## Intent

Under load, a pane agent's Stop hook was refused (`caller is not a descendant of that engine process`, then
`turn-stop refused · unbound`), so the turn's Stop was lost. Found on Linux with three soak end-to-end runs in parallel
and a core event-loop stall of about one second. The fix must keep the property the check exists for: only a process
in the engine's own tree may speak for it, and a late hook from an engine that has exited (or whose pid was reused) is
never taken for its replacement's.

## Cause

- A pane hook names its caller as `process.ppid` (`cli/hook/notify.mjs` `terminalHookFields`).
- The engine runs its hook through `/bin/sh -c`. On Linux that is dash, which stays the hook's parent and exits with it.
  macOS's `/bin/sh` is a bash that execs the hook, so there the parent is the engine itself.
- The hook waits 500 ms for the daemon's answer, then gives up (`late`) and exits; its shell exits with it.
- The core, held by the stall, handles the request only afterwards. Its read of the process table
  (`core/engines/hooks.ts` `resolveHookAgent`, the `arrival` read) no longer has the shell, so the ancestry walk stops
  at once, no recorded engine process is in it, and the hook is refused (`hookServer.ts` `verifiedBoundMutation`, then
  `refuseUnbound`).
- The early `arrival` read only narrows the window: it is started when the core handles the request, which a stall
  delays past the shell's exit.

`callerPid` is the hook's own claim; what authenticates the hook is its credential. The ancestry check proves that the
claimed pid is, or descends from, the live engine process the agent recorded (pid and start marker). That proof needs
a pid that is still alive when the core reads the table.

## Approaches

- **A, chosen: the hook names the nearest ancestor that outlives it.** It climbs past the shells that ran it, read from
  `/proc` on Linux, never from the environment (Design, 1). `observedCallerPid()` already climbs one shell for the
  paneless hooks the devices keep (GitHub run 43721656615). The core's check is unchanged: the named pid must be the recorded engine process or descend
  from it. The engine lives as long as its turn, so any stall length is covered.
- B, not chosen: on `late`, the hook keeps waiting up to its 4.5 s budget so its shell is alive when the core reads.
  It holds the engine for every stall and still loses a Stop to a stall longer than the budget.
- C, ruled out: peer credentials or a pidfd on the socket. Node exposes neither, and the process is still gone by the
  time a stalled core reads the table.

Decisions (harness-pm): A, with `observedCallerPid()` and the pane hooks' caller made one rule; climb every hook shell in
a row (at most 8; `sh`, `dash`, `bash`, `zsh`, `fish`), the devices' path included; an engine that is itself a shell
must keep working. No B in this pull request.

## Design

1. `cli/hook/notify.mjs`: one function names the hook's caller, and both the paneless (`/api/hook/observed`) and the
   pane hooks (`terminalHookFields`, every route that sends `callerPid`) use it; it replaces `observedCallerPid()`.
   On Linux it starts at `process.ppid` and climbs past every **command shell** in a row, at most 8 steps, and names
   the first process that is not one. A command shell is a process whose `/proc/<pid>/stat` command is `sh`, `dash`,
   `bash`, `zsh` or `fish` and whose `/proc/<pid>/cmdline` shows it was started to run a command string: an option
   word before the first operand that is `-c` or a cluster holding `c` (`-c`, `-lc`, `-ec`). It never climbs to init
   (pid 1) or past a process it cannot read: it names the last process it reached. Off Linux the answer is
   `process.ppid`.
   - Why the `-c` test (decision of this design, with harness-pm's agreement to cover the case): an engine may itself
     be a shell, a bash wrapper that runs its program without `exec`, recorded as the engine. Such a wrapper runs a
     script (`bash wrapper.sh`), not a command string, so the climb stops at it and names it. A person's interactive
     pane shell has no `-c` either, so the climb never names a process above the engine. harness-pm proposed sending
     the climbed chain for the core to try pid by pid; the `-c` test covers the same case with no new body field and
     no core change.
   - What the registry records as the engine on Linux (checked for harness-pm): the shallowest process under the pane
     that scores as the engine (`lib/processTable.ts` `selectEngineProcess`, `engineProcessMatch`;
     `lib/terminalAgentDiscovery.ts` `rootOwner`). A `sh -c`/`bash -c` row never scores (its entrypoint is inline
     code), and Harness's own launch script (`exec /bin/dash '<uuid>.sh'`) does not either: the engine program below
     it is recorded. A wrapper script named like the engine (`claude` running `/bin/bash …/claude` without `exec`) can
     be recorded; it is no command shell (no `-c`), and the hook's shells sit under the engine program it starts, so
     the climb stops at that program, a descendant of the recorded wrapper. The hook is always started by a program
     (the engine, Hermes' shared gateway), never directly by a recorded `-c` shell, so the climb never passes the
     recorded engine. A test holds the wrapper case anyway.
   - Why every shell in a row: an engine that runs its hook through two shells (`sh -c` then `bash -lc`) leaves the
     outer one dying with the hook too.
   - The climb keeps the security property exactly: it only names an ancestor of the hook's parent, and stops at the
     first process that is not a command shell. An engine is never one, so the named pid is the engine or inside its
     tree whenever the parent is, and outside every engine's tree whenever the parent is.
2. The core is unchanged in behavior. `core/engines/hooks.ts` keeps the early `arrival` read: Windows still needs it
   (below). Its comment is corrected to say which callers it still serves (a shell parent on Windows), since on Linux
   the hook now names a pid that outlives it.
3. Security: the claimed pid still has to be a live process whose own identity, or one of its ancestors', matches the
   agent's recorded engine (pid and start marker). A hook from an exited engine names a pid that is gone or reused
   with another start marker, and is refused as before. Nothing is accepted on runtime evidence that was not before.

## Tests

- Red then green, `cli/src/hookNotify.spec.ts` (Linux): a pane hook (a Stop, posted to `/api/hook/turn-stop`) run
  through a shell that stays its parent names the shell's parent, as the existing paneless test does for
  `/api/hook/observed`.
- Red then green (Linux), the climb's cases: two command shells in a row name the process above both; a shell wrapper
  that is not a command shell (`bash script.sh`) stops the climb and is named; a command shell whose parent is init
  is named itself; the climb ends after 8 steps; an engine behind a wrapper script that does not `exec` (the wrapper
  recorded) runs its hook through `sh -c`, and the hook names the engine program, which the core accepts as a
  descendant of the recorded wrapper (a hook-side test, and a core `hooks.spec.ts` case if none covers it yet).
- macOS needs no change, proven by a test: on macOS (and anywhere `/bin/sh` execs the hook) the hook run through
  `/bin/sh -c` names its parent, which is the engine (the test process), with no `/proc` read.
- End to end, red then green on Linux, run locally in a Linux Docker container (harness-pm agreed; `cli-e2e.yml` does
  not run on pull requests and cannot run one file): a pane agent's Stop hook that arrives while the core is held about a second,
  long enough for the hook and its shell to exit before the core reads the process table, is accepted and ends the
  turn; the log has the `turn-stop` line and no `turn-stop refused · unbound`. Built on `e2e/stall.e2e.ts`'s hold
  (`core.stall`, SIGUSR2 to hold at a chosen moment) and the fake engine, which runs hooks through `/bin/sh -c`. It
  joins the suite `cli-e2e.yml` runs nightly; on macOS it passes before and after, which shows nothing there.
- `npm run test:core` at 100% before the push (a core file's comment changes; the receipt goes in the pull request).

## Platforms

- Linux: fixed.
- macOS: not affected; the test above holds it.
- Windows: the same check runs (the process table comes from harness-pty). Claude Code runs its hook with no shell
  (`argv`), so its parent is the engine: not affected. Codex and Copilot run hooks through PowerShell and Command Code
  through `cmd.exe`; that shell is the hook's parent and exits with it, so a stall can still lose their Stop. Not fixed
  here: Node on Windows cannot read a parent's parent cheaply. Named as a gap in the pull request; harness-pm opens the
  Windows task once this merges.

## Non-goals

- No change to the 500 ms reply budget or the hook's retry rules.
- No peer-credential or native socket work.
- No change to how the core matches, waits for or records engine processes.

## Coordination

The e2e-flakes session is changing `cli/hook/notify.mjs` (`FIRED_AT`, branch `fix/hook-fired-at-origin`). Rebase on
whichever merges first.

## Left to the builder

- The function's name (it serves both hook kinds now) and the exact shape of the tests.
- How the end-to-end test times its hold so the hook has exited before the core reads the table (for example a hold
  armed by SIGUSR2 just before the fake engine's Stop, longer than the hook's 500 ms).
