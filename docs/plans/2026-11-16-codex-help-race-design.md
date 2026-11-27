# Codex help-probe race: design

Date: 2026-11-16. Branch: `fix/codex-help-race`.

## Problem

CLI e2e `agentClient.e2e.ts` "an agent closes a Codex it started a second ago, which never binds while the close
waits" fails intermittently (run 43746252131, shard 4): the close said "Its conversation is kept; the person can resume
it." for a Codex that never bound a conversation. Reported in #4345's PR body; with the fake Codex's `--help` delayed
400 ms the test failed 3/3 on main, without the delay it passed 15/15.

Two causes, one in the test fixture and one in the daemon.

### 1. The fake Codex's help probe does not look like the real one

The launch script asks the engine's help before each run (`engines/kit/launchStartup.ts` `ownedFlagProbe`:
`codex --help`). Discovery skips such a probe (`lib/processTable.ts` `engineCapabilityProbe`): a standalone
`--help`/`-h`/`--version`/`-V` right after the entrypoint.

Measured on this Mac with Codex 0.167.0 (`codex --help` only, no session), the probe's processes are:

- the npm wrapper: `node <prefix>/bin/codex --help`, an interpreter, script, `--help`: a probe;
- its native child: `<prefix>/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex --help`:
  a probe.

The fake Codex (`e2e/harness/fakeEngine.mjs` `codexWrapper`) starts its child as `spawn(process.execPath,
[<fakeEngine.mjs>, ...args], { argv0: 'codex' })`, so the help child shows in `ps` as
`codex <...>/fakeEngine.mjs --help`. Its command is `codex` (not an interpreter), the token after it is the script path,
not `--help`, so `engineCapabilityProbe` says no and discovery records the help process as the engine. The real
Codex's help process is never recorded; the fake's is, for as long as it runs.

### 2. A close of an unbound harness whose recorded engine has exited says its conversation is kept

`lib/captureResumeIdentity.ts`: a row with no `sessionId` whose recorded process (`processIdentity`) is no longer alive
returns the row unchanged (`if (!live) { await owner.verify(); return session }`). The stop then goes ahead and
`lib/closeAgentService.ts` answers `{ closed: true }`; the agent client (`agentClient/commands.ts`) reads the absent
`withoutConversation` as "Its conversation is kept; the person can resume it." Nothing was kept: the stopped record has
no conversation id, so a resume cannot bring one back (`lib/resumeCapability.ts` `resumesConversation`).

`withoutConversation` today is set only on the one path where the close, after waiting `CLOSE_BIND_WAIT_MS` for a
starting harness, stops it although its conversation cannot be read. Any other close that saves no conversation is
reported as kept.

Real cases besides the fixture: Codex's startup retry (the first run exits, the script runs it again, the recorded pid
is the first run's until discovery sees the second), and an engine the person quit in its pane.

## Decision (PM, 2026-11-16)

Option B: a close reports the truth, and its behavior does not change.

- A close that stops a harness whose saved record holds no conversation it can resume says so:
  `{ closed: true, withoutConversation: true }`, and the agent client prints "It had not started a conversation, so
  none was kept." (MCP and `--json` carry `conversationKept: false`, as today).
- "Holds no conversation it can resume" is `resumeMode(engine) === 'conversation' && !sessionId` on the record the stop
  saved (the one it passes to `checkpoint(s, 'before')`). A `shell` engine (a terminal) and a `fresh` engine (today
  only `omp`: no resume argv) keep today's answer: neither has a conversation id to lose, and "none was kept" would be
  wrong for a conversation a `fresh` engine had. Devin resumes by id (`LAUNCH_RESUME_FLAG.devin`), so it follows the
  rule like Claude Code and Codex.
- No waiting, no refusal, no change to what is stopped or saved. Rejected: A (treat a dead recorded engine as
  unreadable and wait for discovery; the wait loop answers AGENT_CHANGED when the pid changes, and a close of an
  engine that has exited could be refused for good) and C (refuse the close; same dead end).
- The fixture's help child is read by the daemon as a probe from its first instant, as the real one is.

## Changes

1. `cli/e2e/harness/fakeEngine.mjs`
   - `codexWrapper`: when the arguments are a probe (exactly one argument, `--help`, `-h`, `--version` or `-V`: the
     shape `engineCapabilityProbe` skips, not `run`'s wider `args.includes('--help')`), start the child
     under the interpreter's own name (no `argv0: 'codex'`), so `ps` shows `node <...>/fakeEngine.mjs --help`: an
     interpreter, its script, then the probe, which `engineCapabilityProbe` skips just as it skips the real
     `<vendor>/codex --help`. The engine run keeps `argv0: 'codex'` (the rollout reader needs it,
     `processTable.ts` `engineChildren`). A comment names this incident.
   - A new fake config `helpDelayMs` (both engines, read in `run`'s help branch): the help answer waits that long
     before printing, so a test can hold the probe process open as a slow first run of a fresh Codex does (2.9 s
     measured, `launchStartup.ts`).
2. `cli/src/lib/closeAgentService.ts` `attempt`: remember the record the stop saved (from `checkpoint(s, 'before')`);
   after a confirmed stop, answer `withoutConversation: true` when that record holds no conversation it can resume
   (above), as well as on today's path. The `AgentCloseResult` comment says so. A close that saved no record keeps
   `{ closed: true }`: a pending `externalResume` cancelled (`stopAgentService.ts` returns before saving), a row already
   gone, and a close that joined a stop already running (`stopJobs` reuse, which runs with the first caller's options).
3. `cli/src/services/agentCleanup.ts` `close`: its log line ends "Its conversation is kept." only when the result has no
   `withoutConversation`; otherwise "It had not started a conversation, so none was kept." Same cause, same truth.
4. `cli/e2e/agentClient.e2e.ts`: both rows of "an agent closes a Codex it started a second ago" run with
   `helpDelayMs: 400`, so the race is covered on every run.

Existing specs that expect `{ closed: true }` for an unbound Claude or Codex whose saved record has no `sessionId` now
expect `{ closed: true, withoutConversation: true }`, which is the truth for each: `closeAgentService.spec.ts` (the
unused-chat close of claude and codex, ~line 395; the real-timer test, ~line 736) and `unusedCodexClose.spec.ts`
(~lines 76, 111, 149; 111 is exactly the dead-recorded-engine case).

Nothing else: no change to discovery, capture, stop, the wait loop or the agent client's wording.

## Tests (red first)

- Fixture, at its layer: a unit spec under `cli/src/testing/` writes its own `bin/codex` shim in a throwaway folder
  (as `agentClient.e2e.ts` does: `#!<node>` importing `fakeEngine.mjs` and calling `run('codex', config)`), starts it
  with `--help` and `helpDelayMs`, reads the help child's row from the process table while it waits, and expects
  `engineProcessMatch(row, 'codex').score === 0`. Red on main (the row is `codex <...>/fakeEngine.mjs --help`,
  matched by name), green after change 1. No fixed sleeps: it polls the table until the child appears, bounded.
- Daemon: `cli/src/lib/closeAgentService.spec.ts`: a `now` close whose stop saves a Codex record with no `sessionId`
  answers `{ closed: true, withoutConversation: true }`; one whose record has a `sessionId` answers `{ closed: true }`;
  a terminal and an `omp` record with no `sessionId` answer `{ closed: true }`. Red on main for the first case.
- e2e: change 3, run in the CLI e2e shard on CI.

## Failure cases

- A hook binds the conversation after the stop saved its record: the binding changes `bindingIdentity` and the close's
  identity, so the stop throws "changed" and the close tries again with the bound row (unchanged behavior); it never
  answers "none was kept" for it.
- The windows' Close reads nothing from `withoutConversation`; out of scope.
- `checkpoint` not reached (the stop fails before it): no answer is computed; the error path is unchanged.

## Platforms

macOS and Linux (the fixture and discovery run there; Windows has no launch-script probe and capture returns early on
`win32`). The `closeAgentService` change is platform-independent.

## Core

`lib/closeAgentService.ts` is in the core's process (`architecture.coreFiles.txt`). This is a fix of what the core
already answers: no new file, rule or record. `npm run test:core` covers `src/services/` (the `agentCleanup.ts`
change) and must stay at 100%; `npm test` runs the `lib/` specs.
