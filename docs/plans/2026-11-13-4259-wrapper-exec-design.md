# An agent whose bound process execs into another name stays tracked (#4259)

## Why

On a lamp, `hermes` is a shell wrapper (`/usr/local/bin/hermes`) that runs `exec /usr/bin/unshare … hermes-ns`; the
real Hermes then runs under `unshare`, as another pid in the same pane. On 13 Nov (lamp-9adf, 14:22 GMT+7) Harness
reported the run's agent `stopped` about 2.5 s after launch, while Hermes was still loading. The lamp took `stopped`
as finished and ended the task with nothing done. Two earlier runs on the same lamp were fine: it is a race.

What happens (traced on `39f9dc6872`):

1. The new-pane watcher (`cli/src/core/agents/newPane.ts`) polls from 50 ms and catches the wrapper before its `exec`.
   On Linux a `#!/bin/sh` script's comm is its name, `hermes`, which matches Hermes's signature
   (`ENGINE_PROCESS_SIGNATURES` in `cli/src/lib/processTable.ts`). The agent's process identity (pid + start) is set
   to the wrapper's, and its launch is `ready`.
2. The wrapper execs: the same pid and start time, now `unshare`, which matches no engine. Until Python Hermes is far
   enough along to match, the pane has no engine process in it.
3. The reconciler (`cli/src/lib/terminalAgentReconciler.ts`) counts a miss on each pass with no engine matching the
   recorded identity; after two (`MISS_LIMIT`, with no minimum time; passes also run on hints) it calls `onDormant`.
   `retainExitedSession` archives the agent in `stopped-agents/`, sends `agent_deleted`, and `harness wait` reports
   `stopped`.
4. Releasing the engine leaves a terminal row in the pane ("Terminal harness 11-13 14:22"). When the real Hermes
   (pid 1998001) shows up, that row adopts it under a new agent id, since nothing ties it to the archived agent: the
   archive holds the wrapper's identity, and `archivedOwner` matches only an identical one.

Even when Hermes is matched before two misses, the row is not re-bound to it: the reconciler finds a row's process by
its recorded identity, by `formerProcesses` (today only Hermes's gateways, below the engine), or by the pane while the
row has no session yet (`unboundRouteObservation`). A row that already has a session and the wrapper's identity
matches none of these, and the observed Hermes becomes a new agent.

## What changes

The agent's process is the one Harness bound, followed through `exec`. Two rules, for every engine (nothing about
Hermes or lamps in them):

1. **The bound process still running means the agent is still running.** A pass that finds no engine process in the
   pane counts no miss while the agent's recorded process (same pid and same start, so a reused pid never counts) is
   still alive in that pane's process tree. Only when that process is gone do misses count, as today.
2. **An engine process that descends from the bound process is the agent's process.** When the probe picks a pane's
   engine process, the processes above it in the pane's tree, up to and including the pane's root process, are
   `formerProcesses` of it, alongside Hermes's gateways. The reconciler already re-records a row whose identity is one
   of the observed process's `formerProcesses`, so the agent is re-bound to the real engine process, keeps its id,
   session and name, and no second record is made.

Rule 1 also holds where the daemon restores its agents at start (`terminalSurvey` in `cli/src/lib/restoreAgents.ts`):
today a pane with no engine process in it archives its agent ("its engine exited while the daemon was down"), so a
daemon that restarts while the pane holds only `unshare` would report the same false stop. An agent whose recorded
process is still alive in its pane is restored, not archived, and the reconciler follows it from there. (My call: a fix
covers every case of the same cause.) The restart path in `swap.ts` already waits for a process that stays the same, so
it needs no change.

Rule 1 also holds for input: `validate` in `tmuxBackend` and `ptyHostBackend` does not answer `gone` while the agent's
recorded process (same pid and start) is alive in its pane, so a message sent to the agent while the pane holds only
`unshare` is accepted, not refused as sent to a stopped agent. (Decided at plan review: it is the same false stop.)

Together: the wrapper's pid lives on as `unshare` while Hermes loads (rule 1), and once Hermes matches, the agent
moves to it (rule 2). When Hermes ends, `unshare` ends with it, and the agent is reported stopped as today.

## Constraints

- No time-based grace and no new setting; no change to `MISS_LIMIT`.
- Identity is pid plus start, as everywhere else (`sameProcessIdentity`): a pid reused by another process is never the
  agent's.
- Only processes inside the agent's own pane count, for both rules; a process outside it never keeps or claims an
  agent.
- The root is included because an agent can be the pane's own command (the wrapper is then the root, and Python Hermes
  its child). A pane's shell does not tie later engines to an old agent: a former process only re-binds a row whose
  recorded identity it is, and a row only ever records a process that matched an engine when it was bound.
- An agent with no recorded process (still starting) keeps today's behavior.
- All platforms: the rules are written over the process table Harness already reads (`ps` on macOS/Linux, the
  Windows table on Windows). Windows has no `exec`, so rule 2 only matters there for a launcher that stays the
  engine's parent, which is the same agent.
- Not in the daemon core's scope beyond what `cli/src/lib/terminalAgent*.ts` and `processTable.ts` already are; no
  new process or door.

## Not in scope

- `archivedOwner` stays exact-identity only: with the two rules no agent is archived while its process lives.
- `checkSessionRuntime` (`paneEngineProcess.ts`, used by resume) is unchanged.
- The lamp's own handling of `stopped` (lampOS #6432).

## Known residual

A wrapper that does not `exec` and keeps running after its engine exits (for example a script that runs Hermes and
then waits on something else) keeps its agent alive until the script ends. That is the process Harness bound, so this
is the intended reading.

## Done when

- A test at the reconciler layer, for a row that already has a `sessionId` (without one, `unboundRouteObservation`
  re-binds by pane today and the test proves nothing), with process rows modelling `sh hermes` → `unshare` (same pid and start) → Python
  Hermes (a child): fails on today's code (the agent goes dormant after two passes with only `unshare` in the pane)
  and passes after: the agent stays, then is re-recorded to the Python Hermes's identity with the same agent id, and
  no new agent is opened.
- A test at the probe layer: the engine process's ancestors inside the pane, root included, are its
  `formerProcesses`, and nothing outside the pane is; a Hermes gateway below it still is.
- A test that a reused pid (same pid, different start) still counts as a miss.
- A test for `validate` in each of `tmuxBackend` and `ptyHostBackend`: with only the recorded process (now `unshare`)
  alive in the pane it does not answer `gone`; with that process gone, or its pid reused, it still does.
- A test at the restore layer: an agent whose pane holds only its recorded process (now `unshare`) is restored, not
  archived; one whose recorded process is gone is still archived.
- The existing reconciler, discovery and process-table specs pass.
