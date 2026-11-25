# A held first launch starts again by itself (2026-11-25)

A new Codex pane can say "The engine did not start because its executable or native hooks changed. The original launch
is held for recovery." and stay that way for good: nothing retries it, `agent_restart` refuses it, and a daemon restart
skips it. The person's only way out is to close the pane and open a new one, and the first task they typed is lost.
Seen on a person's Mac while brew/npm upgraded Codex: three new Codex panes stuck beside running ones.

Goal (Ken): transparent to the person. They never have to notice or act: the pane starts, and the app says "Starting"
meanwhile, as for any launch. Never two engines in one pane; the first task typed exactly once.

## How it happens today

1. `agent_create` with a `creationId` saves the whole request (task text included) as a creation intent
   (`lib/agentCreationReceipt.ts`, `kind: 'native-create-v1'`; every local create without a resume is one, since
   `prepareCreate` is always wired: `core/main.ts:3154`, `core/agents/launches.ts:575`), prepares the launch (native
   evidence: the engine's executable identity and its hook files, `engines/nativeLaunch.ts`), then dispatches it: a
   new pane whose script runs the person's login rc files, then the native guard (`engines/kit/nativeLaunchGuard.ts`),
   then the engine with the first task in its argv (Codex and Claude Code take it as a positional). The intent's result
   says `created` with the new agentId. `agent_fork` with a `creationId` reserves a receipt too, but one that keeps only
   a fingerprint (a hash of the source, name and task: `launches.ts:698`), never the task.
2. The guard re-checks the evidence after the rc files. A Codex binary replaced in that window (a new inode, as a brew
   or npm upgrade does) fails it: no engine runs, and the pane turns itself into the inert held shell under the launch's
   token (`lib/nativePaneHold.ts`; on Windows the daemon picks the held argv itself when the evidence is stale,
   `engineLaunch.ts:668`). The new-pane watcher sees the held shell (`backend.isHeld`) and sets the row
   `launch: { state: 'held', service: 'native', nativeToken }` (`core/agents/newPane.ts:169`). The restored-pane watcher
   does the same for a relaunch (`lib/restoreAgents.ts:1002`).
3. Nothing gets it out:
   - No retry: `heldLaunches.restoreHeld` runs at core start and when a service connects; a hold set at run time arms
     no timer.
   - `agent_restart` refuses with `NATIVE_LAUNCH_HELD` "Its first prompt or fork cannot be replaced by a fresh launch"
     (`core/agents/restart.ts:196-197`, for `held` and `starting` alike).
   - A daemon restart skips it: "original native launch awaits recovery" (`lib/restoreAgents.ts:462`, `496`).
4. Every client draws a held launch as the hourglass "Waiting" banner with the row's detail (Desktop `models.dart`
   `launchDetail`, `harness_sessions.dart`).

Reproduced on an isolated daemon by harness-buddy (the probe `zzReproHeldExec.e2e.ts`): a 2 s `.zshrc`, the fake Codex
binary replaced by rename while the pane sits in it. Held after 90 s, after `agent_restart`, and 60 s after a daemon
restart. Three concurrent launches with nothing changing all become ready; an upgrade before the launch is fine.

The refusal is right that a plain fresh relaunch is different work: the row is a full relaunch source (engine, folder,
profile home, grid, harness, permission, launch model, named agent, owner's launch words: `lib/launchOverrides.ts`; a
fork's row also names the session it forked, `forkedFrom.sessionId`), but the first task of an argv engine is a launch
option only, never on the row (`engineLaunch.ts` `firstPrompt`). For a create it is on disk, though: the creation intent
keeps the complete private request until the harness is deleted (`scrubCreated`). And the held shell under the launch's
token proves that no engine ever ran under that token, so the task was never delivered.

## What changes

### 1. A held first launch is recovered from its row and its creation receipt

A row is a **held first launch** when its launch is `held`, `service: 'native'`, with a `nativeToken`, it has no
`sessionId`, and its launch says the guard held it: **`startsAgain: true`**, a new field of the held launch, set only
where the core has just seen the pane be the held shell under that token (the new-pane watcher `newPane.ts:169`, the
restored-pane watcher `restoreAgents.ts:1002`, the boot's `restoreAgents.ts:493`), and kept by every later hold of
that row. The other first launches held today without that proof (`newPane.ts:243` a start that timed out,
`restoreAgents.ts:538` a pane gone after a reboot, `:1021`) never get it, and keep today's state, words and restart
refusal exactly.

At the moment the hold is seen, a row with no way to rebuild its request (no `creationId`, or a fork of an engine with
no native fork) goes to the failed state of section 4 instead. Every other one is held with `startsAgain` and recovered.

The restore pass (`restoreAgents`, the boot's and each held pass's) recovers a held first launch when its pane is
alive and is still the held shell under the row's `nativeToken` (`waitingPane(runtime, token) === true`), and its
original request can be read:

- **A create**: the row names the creation intent that made it (`creationId`, below). The intent is a
  `native-create-v1`, not cancelled or scrubbed, and not `created` for another agent. Its status may be `created` for
  this agent, `pending` or `unconfirmed` (its result file could not be written: `agentCreationReceipt.ts:281-285`): the
  row carrying its id is the proof that this intent dispatched this row, and the request is in the intent file in every
  one of those states. Its first task is the intent's `input.prompt`.
- **A native fork** (an engine with a native fork: Claude Code, Codex): the row names its fork receipt (`creationId`),
  not `created` for another agent, and the session it forked (`forkedFrom.sessionId`). Its first task is the one the
  fork's receipt now keeps (below), or none. The launch is the fork again (`forkSessionId`), as `core/agents/fork.ts`
  built it.

A receipt that cannot be read for any other reason (missing, another agent's, scrubbed, corrupt) sends the row to the
failed state of section 4. So does a held first launch whose pane is gone, or is surely no longer the held shell under
its token: it is never relaunched, and failed at once rather than shown starting until a bound. A pane that could not
be read (`'unknown'`, a tmux call that timed out) waits for the next attempt.

**A conversation relaunch the guard held** (a restart, resume or restore of a row with a `sessionId`, whose restored
pane became the held shell: `restoreAgents.ts:1002`, and the boot's `:493` with a conversation) is the same cause and
gets the same treatment: `startsAgain`, the copy, the frame's `starting`, the per-agent attempts and their bounds. Its
recovery is the resume the restore already does for a held row with a conversation (into its own held pane with
`expectedHeldToken`); it needs no receipt. Today it too waits for the next boot or service connection.

**A held first launch never gets a pane from the restore.** It reaches the restore's launch only with its own pane
alive and the held shell under its token; it is never put in a new waiting pane (`allocateWaitingPanes`, `hold()` with
no live pane, both of which write the row's token into a pane the daemon made: `restoreAgents.ts:350-366`, `615-628`).
A held shell the daemon made is no proof that no engine ran, so it must never exist for a first launch.

The recovery is the restore's ordinary launch of the row into that same pane (the path a held row with a conversation
already takes): a fresh native inspection and hooks (`relaunchOverrides`), the row's relaunch options, plus the original
first task as the launch's `firstPrompt` (and, for a fork, `forkSessionId`). It is dispatched with
`respawn(pane, launch, { expectedHeldToken: <the row's token> })`, after `beginNativeDispatch(<the new token>)` journals
the new launch, and then watched as any restored pane is (`watchRestoredPane`) until ready.

An engine that takes its first task typed (`typedFirstPrompt`) already keeps it on the row (`firstTask`, typed once by
the bind pass after ready, `registry.takeFirstTask`); its recovery adds nothing to the argv.

The same at boot for a row left `starting` with a token, no conversation, and its pane the held shell under that token
(`restoreAgents.ts:489-497`): it becomes held, as today, and is then recovered like any held first launch, instead of
"awaits recovery".

When the fresh inspection says the executable or hooks are still changing (brew mid-install: the relaunch build answers
`held: 'native'`, a `nativeHold`, or a hooks hold), the row stays held and the next attempt comes (below). Whatever
holds it (that, or the boot's `defer` hold for `native`, `restoreAgents.ts:85`), a held first launch keeps
`startsAgain` and the detail "Starting again."; the reason goes to the log once per change, by its code. Its pane is
not respawned to show another reason (`restoreAgents.ts:630-633` is skipped for it): the pane already says
"Starting again.".

### 2. A hold set at run time is retried, per agent

When a row becomes a held first launch at run time (the new-pane watcher, the restored-pane watcher), the core asks the
held passes to try that agent again. Each held first launch has its own attempt count, kept in `heldLaunches` while it
is held or its recovery is starting: attempt n comes at least `heldRetryMs(n)` after the one before (2 s, doubling, at
most 30 s), counted from the hold. Every pass honours it (the timer's, a service's, the core's ready pass), so other
held agents' passes never retry it sooner; only a person's `agent_restart` runs an attempt at once. A recovery that
dispatched and is held again is the next attempt, never a new count: a dispatch does not reset it, and it does not
reset the shared count either (`heldLaunches.ts:62`), so no attempt comes more often than that, whatever each one does
(each runs a login shell in the pane; 2026-10-15 measured what an unbounded 2 s retry costs). The count goes when the
row is ready, failed, stopped or gone.

**The retry ends.** A guard that keeps failing for a reason the fresh inspection does not see (a tool rewriting a hook
file on every run, anything that changes between the inspection and the rc files) would otherwise show "Starting"
forever, run a login shell in the pane every 30 s, and keep `harness wait` waiting, which is worse than today. So:

- **10 attempts that dispatched and were held again by the guard** (about 5 minutes with the backoff) send the row to
  the failed state of section 4, its reason logged once by a fixed code (`[restore] <engine> · agent <sid> · first
  launch held again 10 times · NATIVE_GUARD_REPEATED`).
- **Attempts held before dispatch because the evidence is still changing** (brew mid-install) keep waiting, up to **15
  minutes from the first hold**; then the row goes to the same failed state (`NATIVE_EVIDENCE_UNSETTLED`). Only a
  hold for `native` counts toward it: a guard-held row whose recovery waits for another service (models for a grid,
  the Store for a harness, search for an external conversation) waits as any row held for that service does, with no
  bound, and is shown so (section 4).
- **A dispatch the terminal turned away after its journal** (the evidence changed between `beginNativeDispatch` and
  the respawn, so the respawn did not start) leaves the pane the held shell under the old token: the row goes back to
  that guard-held launch (old token, `startsAgain`) and the next attempt comes, never a watch of a token no pane has.
- A person's `agent_restart` of a row that got there answers as for any failed launch with no engine (section 4). The
  bounds are counted in memory: a daemon restart starts them again, once.

### 3. `agent_restart` on a held first launch runs the recovery now

Restart hands a held first launch to `restartHeld`, which runs (or joins) that agent's recovery at once, instead of
refusing. It answers success with the row as it is once the attempt dispatched, or was held again by changing
evidence (the row stays a held first launch, shown starting): the person asked for it to start, and it is starting.
It answers an error only when the attempt sends the row to the failed state. A first launch still `starting` is refused
as today (`NATIVE_LAUNCH_HELD`), with plain copy: "This harness is still starting."; so are the held first launches
without `startsAgain` (above), with their words of today.

**A restart of a running conversation** goes through the pane swap, not the restore (`restart.ts:277`,
`lib/restartAgent.ts`, `core/agents/swap.ts`). When the guard holds the swap's new launch, the swap today finds no
engine within 8 s and respawns over the held shell with the same stale evidence, without `expectedHeldToken`, is held
again, and answers "did not come back up after restart"; the row is never marked held. Same cause, so: a swap that sees
its own launch's held shell (by that launch's token) never respawns over it. It sets the row to a launch the guard held
(`startsAgain`, its conversation kept), hands it to the held passes (the same attempts and bounds), and restart answers
success with the row, shown starting.

### 4. What the person sees

- **A held first launch is shown as starting.** Every frame built from a row (`lib/agentFrame.ts:295`, the one place a
  row's `launch` goes to a client) shows a held launch with `startsAgain` held for `native` as `{ state: 'starting' }`,
  so every client draws its usual "Starting" with no client change. The registry keeps the true `held` state, which
  every core path above runs on. One held with `startsAgain` for another service is shown, and worded, as any launch
  held for that service ("Waiting for the models service. …"): its wait is that service's, not the guard's.
- The held shell's own text in the pane (tmux's in-pane hold and the Windows held argv):
  "Waiting for native launch preparation to be confirmed." → "Starting again."
- The row's detail for a held first launch (newPane, restoreAgents' watch): "Starting again." (logs and the registry;
  no client shows it while the frame says starting).
- **A guard-held first launch that cannot be recovered** goes to `failed`, `ENGINE_DID_NOT_START`, detail "This
  harness did not start. Close it and open a new one." The clients show their failed tile; Restart there answers as today
  for a failed launch with no engine (`NO_ACTIVE_PROCESS`, `restart.ts:243`), and the pane (the held shell) is kept, so
  the words stay until the person closes it. The guard's "held for recovery" sentence goes.
- **`harness wait`** needs no change: during a recovery it waits as for any launch starting and, at its deadline,
  answers `timeout` ("still working", exit 124); once the engine is up it answers idle, and once a bound fails the row,
  failed. The held first launches without the guard's proof keep their words of
  today (above), and so does a row held by the guard before this release (it has no `startsAgain`): transitional, one
  release.

### Which first launches cannot be recovered

Every one whose task is nowhere on disk, or whose pane no longer proves that no engine ran:

| Case | Why | How rare |
|---|---|---|
| A create from a client that sends no `creationId` | no intent | rare: Desktop, mobile, the TUI and `harness new` all send one; only clients from before receipts |
| A create made inside the core: an experiment's `core.agents.create` (`experimentQueries.ts`), the Wi-Fi device's (`wifiAgents.ts`) | they call the create directly, with no intent | rare: experiments are off by default; each still needs an upgrade inside the rc window |
| A `model-create-v1` intent | written only by a daemon without native preparation; this one always has it (`main.ts:3154`) | transitional: one an older release saved and this one dispatches |
| A handoff fork (an engine without a native fork) | its first prompt is composed from the source's memory at fork time and kept nowhere | rare: forks of those engines |
| A guest's harness | never relaunched as the owner (`restoreLaunch.ts`, as today) | covered by the guest rules |
| A later launch with no conversation the guard held: the fresh fallback after a refused resume, a restore of a harness whose engine never named its session | no `creationId` any more (its first task was delivered), and nothing tells it from a first launch with no receipt | rare: a launch with no conversation, held inside the rc window |
| A fork receipt written before this release, of a fork with a first task | the task was never kept | transitional: one release |
| A row held by the guard before this release | no `startsAgain`, no `creationId` | transitional: one release, keeps today's words |
| Any first launch held without the guard's proof: its pane gone, or not the held shell under its token | no proof that no engine ran (`newPane.ts:243`, `restoreAgents.ts:536`, `:1017`) | as today: left as it is, never relaunched |

The last two rows keep today's behaviour exactly; the others become the failed state above, at the hold or at the first
attempt.

### Invariants (never two engines; the first task typed once)

1. **Only over the held shell.** A recovery dispatches only with `expectedHeldToken` set to the row's token, and the
   terminal checks and replaces in one step on its own side: tmux's `if-shell -F <heldPaneFormat> respawn-pane`, the pty
   host's `held_by` in the same `respawn` op. A pane that is anything else (an engine, a shell, another token's hold)
   starts nothing.
2. **The held shell proves the task was never delivered.** The guard runs before the engine's `exec`; the pane becomes
   the held shell under token T only when the guard failed (on Windows, when the daemon chose the held argv over the
   engine for T), and after that only a daemon respawn changes it: a recovery's (a new token), or a held reason's
   (`restoreAgents.ts:630-633`, the same token over the same held shell, skipped for a first launch now). The daemon
   never makes a held shell under a first launch's token in a pane of its own (section 1). So a held shell under T, in
   the first launch's own pane, means no engine ran under T, and the task in T's argv reached nobody.
3. **One flight per agent.** Timer passes, service passes and `agent_restart` share `heldLaunches`' one flight per agent
   (`restoreOne`); two never dispatch the same agent.
4. **A new token for each attempt, journaled first.** `beginNativeDispatch` writes the new token before the respawn. A
   crash between leaves the row `starting` with the new token, which boot watches and never respawns over (as today).
5. **No proof, no recovery.** A held row without a live held shell under its token keeps today's behaviour.

## Approaches

- **A. The restore's held pass, plus the first task from the creation receipt (chosen).** Reuses the one path that
  already relaunches a held row into its own pane with `expectedHeldToken`, its flights, timer and boot pass; the only
  new inputs are the first task, read from the receipt, and for a fork its session, read from the row. Covers the three
  ways out (timer, restart, daemon restart) with one mechanism. Needs a link from the row to its receipt (`creationId`)
  and a fork's receipt that keeps its task.
- **B. Re-dispatch from the create's own memory** (the create closure still has the input when the watcher sees the
  hold). No new data, but lost on a daemon restart, and a second dispatch path in `create.ts` beside the restore's.
- **C. Find the receipt by scanning the receipts folder for the result naming the agentId** (as `scrubCreated` does).
  No new row field, but a walk of every receipt ever written (821 files on the maintainer's Mac, never evicted) on the
  core's event loop for each held agent. Rejected.
- **D. Keep the first task on the row.** One more copy of private text, in a file other code reads. Rejected.

For the presentation: clients taught a new "starting again" case would each need a design-doc and gallery change in
the same pull request; the frame showing `starting` needs none.

## Data

1. **`creationId` on the row.** A create made from a creation intent (`launches.ts`, the `native-create-v1` preparation)
   and a fork made from a fork receipt (`launches.ts` `fork`, its `creationId`) record that id on the registry row they
   register (`createAndRegisterPane`). The id is passed explicitly from the intent or the receipt, never inferred from
   the preparation's `authority.id`: a create made without an intent passes its session label there
   (`create.ts:454-455`), which `validCreationId` cannot tell from an id. Nothing else writes it. It goes from the row
   as soon as a launch of the row is confirmed (an engine ran: `confirmLaunch`, and a hook binding a session): from
   then on the first task has been delivered, so a later launch of the row (a restart, a restore, the fresh fallback
   after a refused resume) never reads it again. A `creationId` on a row is therefore always a first launch's.
2. **`startsAgain` on a held launch.** The held launch's new optional field (section 1), set and cleared with the
   launch itself (`registry.setLaunch`), kept by the registry's `normalizedLaunch`.
3. **A fork's receipt keeps its task.** The fork's receipt (`AgentCreationReceipts.run`, version 1) also keeps the
   fork's first task, when it has one, as a create's intent keeps its request. The fingerprint is unchanged, so a
   retried `agent_fork` still matches. `scrubCreated` removes it when the harness is deleted, as it removes a create's.

## Design (docs/feature-design-rules.md)

Reviewed revision: (this file)  Reviewer: P1 builder-check. Each line: answered / N/A because …

1. Growth: `creationId` is one short id per row, written once at registration, deleted with the row (close, purge). A
   fork receipt's task is at most `MAX_FIRST_PROMPT_CHARS`, one per fork with a task, scrubbed when the harness is
   deleted (as a create's request is today); receipts themselves are kept as today.
2. Concurrency: the invariants above. `creationId` is written once with the row's registration, never changed after.
   The fork receipt's task is written with its reservation (`O_EXCL`), before the fork runs, and again with its
   outcome; the scrub rewrites it whole (`atomicWriteJson`, as today).
3. Read cost: a recovery attempt reads the one receipt its row names (the intent and its result file, or the fork's
   receipt; a few KiB each, through the class's own reader), once per attempt, attempts at most every 2-30 s per held
   agent and only while it is held. No scan. The frame's check is a field read.
4. Scale: 10x held agents at once (30) is 30 small reads every 30 s at worst, beside the login shells each attempt
   runs in its own pane; flights are capped at four across the core (`heldLaunches`). The metric that warns first: the
   `[restore] held · native · launched n of m` line repeating for one agent.
5. Compatibility: rows without `creationId` (older rows, the creates listed above) are the unrecoverable case; older
   fork receipts without a task cannot be told from a fork with none; the case is unreachable, since a row with a
   `creationId` always names a receipt this release wrote (the fork reserves it and registers the row in one process). Every
   reader of the row was checked by search: the registry's normalize and save keep `creationId`; `agentFrame.ts` and
   every frame built from a row never send it. A client that sends no `creationId` creates rows without it.
   `startsAgain` is read by the restore, the held passes, restart and the frame; no client ever sees it (the frame
   sends `starting` instead).
6. Migration and rollback: no migration. An older release keeps or drops the unknown row field (the registry's
   normalize), drops or keeps `startsAgain` (its `normalizedLaunch`), and ignores the fork receipt's extra field (its
   reader takes the known fields); either way its held rows behave as today, shown held.
7. Audience: `creationId` is not secret and goes nowhere but the core (never in a frame). The first task is read from
   the receipt by the core only, put in the engine's argv (as the original launch did) and never logged (lengths and
   codes only). The fork's task is kept under the same private receipts folder (`0700`, read by `readPrivateStateFile`)
   as a create's request, scrubbed the same way.
8. Identity: the recovery runs as the original launch did, as this computer's owner, from the owner's row; a guest's
   row is never relaunched (`restoreLaunch` refuses it, as today).
9. Failure: a recovery that cannot dispatch leaves the row held and retried with backoff, its reason logged once per
   change (`[restore] … could not launch from held · <code>`); an unrecoverable row is failed with words that say
   what to do. The person sees "Starting", or that failed tile; never the "held for recovery" sentences.
10. Platforms: tmux on macOS and Linux (the guard's in-pane hold), the pty host on Windows (the daemon's held argv;
    `respawn` with `expected_held_token` checked in `pty/src/panes.rs`). Same row logic on both.

## Constraints

- Core session behaviour, so it lives in the core modules that own it (`core/agents/heldLaunches.ts`, `newPane.ts`,
  `restart.ts`, `create.ts`, `fork.ts`, `launches.ts`, `restoreLaunch.ts`, `main.ts` wiring only) and the `lib/` files
  they already import (`restoreAgents.ts`, `agentCreationReceipt.ts`, `registry.ts`, `createAgentPane.ts`,
  `agentFrame.ts`, `engineLaunch.ts`). No new file in the core's process: `src/architecture.coreFiles.txt` unchanged. No
  service, no component rule, no client change.
- 100% coverage per file for `src/core` (`npm run test:core`).
- No fixed sleeps in tests; no CPU-hog loops on the Mac.

## Tests

- **End to end, red first**: `cli/e2e/heldLaunchRecovery.e2e.ts`, from the probe's case B: an isolated daemon, a 2 s
  `.zshrc`, `harness new codex <folder> --name b1 -- hello`, the fake Codex binary replaced by rename while the pane is
  in the rc file. Today: held after 90 s. Green: the frame's launch never says `held`, the row is ready within 30 s,
  and the fake engine's launch-argv ledger shows exactly one Codex launch carrying `hello`. POSIX only (it needs the rc
  window); skipped on Windows.
- **Units**: `restoreAgents` (a held first launch with its receipt and a held pane is respawned with
  `expectedHeldToken` and the first task; a native fork with `forkSessionId` and its task; without a usable receipt it
  is failed with the close-and-open detail; a pane that is not the held shell is left alone; one whose pane is gone is
  never given a waiting pane; its hold keeps `startsAgain` and "Starting again." whatever the reason, with no pane
  respawn; the boot's `starting` branch; the no-proof rows unchanged), `heldLaunches` (a run-time hold arms an attempt
  with the per-agent backoff; a dispatch held again is the next attempt; another agent's pass does not retry it sooner;
  at most 30 s; restart runs at once; the count goes when the row is ready, failed, stopped or gone; the 10th held-again
  attempt fails the row; the 15-minute ceiling fails a still-changing one; with a clock and timers the test controls),
  `harness wait` (what it returns while a held first launch recovers: starting, never failed or idle; and the failed
  state once a bound is reached), `restart` (a held
  first launch goes to `restartHeld` and answers success when held again; a `starting` one and a held one without
  `startsAgain` are refused), `newPane` (the hold sets `startsAgain` and asks for an attempt; a row with nothing to
  rebuild from is failed), `agentCreationReceipt` (the first task of an intent or fork naming the agent, created,
  pending or unconfirmed; null for another agent's, a cancelled, scrubbed, missing or legacy receipt; a fork's task kept
  and scrubbed), `create` and `fork` (the row gets the receipt's id, passed explicitly; none without one),
  `agentFrame` (a held launch with `startsAgain` is sent as starting; every other held launch as held).

## Left to the builder

- How the run-time hold reaches `heldLaunches` (a dep of the watchers).
- The receipt reader's exact shape (one method on `AgentCreationReceipts`), reusing its own validation.
- Checking that a recovered launch carries every option the original create or fork passed (but the first task and the
  fork's session): list any gap found, or show none.
