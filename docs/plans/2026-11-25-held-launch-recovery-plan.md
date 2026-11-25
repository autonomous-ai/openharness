# A held first launch starts again by itself Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with devcrew phase 3, task by task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** A launch the native guard held (its executable or hooks changed in the rc window), a first launch or a
conversation's relaunch, starts again by itself in its own pane, a first launch's task delivered exactly once, shown as
"Starting" meanwhile; one that cannot be recovered, or keeps being held, ends in a failed state whose words say what to
do.

**Architecture:** The row learns the receipt that made it (`creationId`) and the guard's proof (`startsAgain` on the
held launch). The restore's held pass, which already relaunches a held row into its own pane with `expectedHeldToken`,
learns to read a first launch's original task from that receipt (`restoreLaunch.ts`) and to launch it into its held
pane only; a held conversation keeps its resume of today. `heldLaunches` gives each guard-held agent its own bounded
attempt schedule, armed by the two watchers that see the hold at run time; `agent_restart` runs an attempt at once. A
restart of a running conversation whose pane swap the guard holds never respawns over its own held shell: it marks
the row held to start again and hands it to the same attempts.
Every frame, and every other place a row's launch leaves the core, shows such a row as a launch starting
(`shownLaunch`); the registry keeps the true hold.

**Tech Stack:** TypeScript (Node 24), Vitest 4. Gates: `npm run typecheck`, `npm run test:core` (100% per file for
`src/core` and `src/services`). All commands run in `cli/`.

**Spec:** `docs/plans/2026-11-25-held-launch-recovery-design.md` (read it with this plan; it was revised on 2026-11-25
with the bounded retry of section 2, "The retry ends", the `harness wait` test, and the four answers listed under
[Decisions](#decisions), and again with section 3's "A restart of a running conversation", Tasks 18-19). The orchestrator's decisions of 2026-11-25 are final: approach A; `creationId` on the row, passed explicitly; `startsAgain: true` on the held launch,
sent as `{ state: 'starting' }`; no client change; the unrecoverable and the no-proof cases as the spec lists them;
never a new waiting pane for a first launch; the per-agent backoff and its bounds; restart runs `restartHeld`; the copy;
`src/architecture.coreFiles.txt` unchanged; 100% per file; no fixed sleeps.

## Global Constraints

- **Copy, exactly.** Pane text and row detail of a launch the guard held (a first launch or a conversation):
  `Starting again.` (it replaces the "…held for recovery." sentence at `restoreAgents.ts:1003` and the boot's
  "Waiting to confirm the engine executable and native hooks." at `:494`). Refusal of a first launch still starting:
  `NATIVE_LAUNCH_HELD`, `This harness is still starting.` The failed state: `failed`, error `ENGINE_DID_NOT_START`,
  detail `This harness did not start. Close it and open a new one.` Restart on it answers `NO_ACTIVE_PROCESS` as today
  (`restart.ts:243`), and the held shell is kept. The held rows without `startsAgain` keep their words and restart
  answers of today.
- **The guard's proof.** `startsAgain: true` is set only where the core has just seen the pane be the held shell under
  the row's token: the new-pane watcher (`newPane.ts:169`), the restored-pane watcher (`restoreAgents.ts:1002`), the
  boot's `starting` branch (`restoreAgents.ts:489-497`), each with or without a `sessionId`. Every later hold of that
  row keeps it. Nothing else sets it.
- **Never a pane from the restore for a first launch.** A held first launch reaches the restore's launch only with its
  own pane alive and `waitingPane(runtime, token) === true`; it is never given a waiting pane (`allocateWaitingPanes`,
  `hold()` with no live pane) and its pane is never respawned to show a reason (`restoreAgents.ts:630-633`).
- **Dispatch.** Only through the restore's existing respawn with `expectedHeldToken: <the row's token>`, after
  `beginNativeDispatch(<the new token>)`. One flight per agent (`heldLaunches.restoreOne`).
- **Backoff.** Attempt n at least `heldRetryMs(n)` after the one before (2 s, doubling, at most 30 s), counted from the
  hold; every pass honours it but a person's `agent_restart`. A dispatch held again is the next attempt; a guard-held
  row's dispatch never resets the shared `quietPasses`. The same for a first launch and a conversation.
- **Bounds.** 10 attempts that dispatched and were held again: failed, logged once
  `[restore] <engine> · agent <sid> · first launch held again 10 times · NATIVE_GUARD_REPEATED`. Attempts that did not
  dispatch (held by changing evidence, or a pane not read): up to 15 minutes from the first hold, then failed, logged
  once with `NATIVE_EVIDENCE_UNSETTLED`. In memory; a core restart starts them again. A conversation's lines say
  `relaunch` for `first launch`.
- **Data.** `creationId` is written once, at registration, from the intent or the fork receipt; never inferred from
  `authority.id` inside `create.ts`/`fork.ts`. The first task is read only from the receipt the row names, never
  logged (lengths and codes only), and never put on the row.
- **Core.** No new file in the core's process: `src/architecture.coreFiles.txt` does not change. `core/main.ts` gains
  wiring only. One factory per module, explicit deps.
- **Tests.** Red first, at the layer that owns the behaviour. No fixed sleeps: timers and the clock are the test's
  (`vi.useFakeTimers()` and an injected `now`). Throwaway homes and data folders only.
- **Commits.** Each task: one commit of its failing tests, then one of the change (a no-behaviour task: one commit).
  Stage only the files the task names.

## What this plan decides from the spec's words

- **Two predicates, in `lib/registry.ts`.** `guardHeld(row)`: launch `held`, `startsAgain === true`, a `nativeToken`
  (with or without a `sessionId`): "a launch the guard held". `heldFirstLaunch(row)`: `guardHeld(row)` and no
  `sessionId`. Neither requires `service: 'native'`: the boot's defer and a build that waits for models or the Store
  re-hold the row under that service, and it stays guard-held.
- **Which rule is whose** (decision 4). For every `guardHeld` row: `startsAgain` and "Starting again." on every later
  hold, no pane respawn to show a reason and no hold line of `hold()`'s own; the frame's `starting` (and the Wi-Fi
  list's, the shell service's); the per-agent attempts and both bounds; `restartHeld`'s answers. For a
  `heldFirstLaunch` only: rebuildable-or-failed at the hold (`guardHold`; a conversation is always rebuildable: it
  resumes); the receipt read and the original task (`restoreLaunch`); never a waiting pane; failed at once when its pane
  is gone or `waitingPane` is `false`; a failed row keeps its pane in the restore's error branch; the restart refusal of
  a `starting` one.
- **A guard-held conversation's pane** keeps today's behaviour: gone (a reboot), it is resumed into a new waiting pane
  under its token (`allocateWaitingPanes`, then the respawn with `expectedHeldToken`); alive but not the held shell
  under its token, it is `unsurveyed` and waits for the next attempt, so the 15-minute bound ends it. This keeps
  invariants 1-5: the new waiting pane is a held shell under the row's token, so the resume still dispatches only over
  it (1); invariant 2 is about a first launch's token only, and a resume carries no first task to deliver twice; one
  flight and the journal are unchanged (3, 4); and "no proof, no recovery" means today's behaviour, which for a
  conversation is that resume (5).
- **The run-time hold reaches `heldLaunches`** (left to the builder) through one dep of both watchers and the boot
  branch, `startAgain(agentId)`, wired in `main.ts` to `heldLaunches.startAgain` (created at `main.ts:551`, before
  both). A pass that meets a `guardHeld` row with no record (held before a core restart) starts its record then, and
  that pass is its first attempt.
- **The receipt reader** (left to the builder) is one method, `AgentCreationReceipts.firstLaunchTask(id, agentId,
  kind)`, built on the class's own `read()`/`intentStatus()` validation; any storage error reads as null.
- **Where each part lives.** The decision "rebuildable or failed, at the hold" is `guardHold(row, token)` in
  `lib/restoreAgents.ts` (used by both watchers and the boot branch); the receipt read and the original task are
  `core/agents/restoreLaunch.ts`'s (it builds every restore launch); the schedule and its bounds are
  `heldLaunches.ts`'s. `main.ts`'s restore `launch` closure already spreads its `opts` into `buildEngineLaunchArgv`, so
  `firstPrompt` and `forkSessionId` reach the argv with no change there; `firstPromptArgs` adds nothing for a typed
  engine, and `restoreLaunch` passes no `firstPrompt` for one (its task is the row's `firstTask` already).
- **A failed first launch keeps its pane** (the held shell), at the hold, at an attempt and at a bound: the restore's
  `killPane` on a failed held row is skipped for it. A closed pane would turn the tile "Unavailable" and let discovery
  remove the row, words and all (`discovery.ts` `onRemoved`). A bound never closes a pane, a conversation's either;
  the restore's error branch still closes a held conversation's pane, as today.
- **The frame says active too.** `setLaunch` makes every held row inactive (`registry.ts:2709`), and the frame's
  `status` would then read `offline`; a launch starting is active. `shownLaunch(row)` returns the launch and the
  activity a client sees: `{ launch: { state: 'starting' }, active: true }` for a `guardHeld` row.
- **`creationId` goes nowhere but the core**: `agentFrame` never sends it (it builds the frame field by field) and
  `agentView` (`core/api.ts`, every row a service or device gets) leaves it out.
- **Reasons, once per change.** `hold()` logs no line of its own for a `guardHeld` row; `heldLaunches` logs
  `[restore] <sid> · could not launch from held · <service>` once per change, beside its existing failed-code line.
  The 15-minute line: `[restore] <engine> · agent <sid> · first launch held 15 minutes · NATIVE_EVIDENCE_UNSETTLED`.
  A conversation's two bound lines say `relaunch` where a first launch's say `first launch` (`… · relaunch held again
  10 times · NATIVE_GUARD_REPEATED`, `… · relaunch held 15 minutes · NATIVE_EVIDENCE_UNSETTLED`).
- **Clock.** `heldLaunches` reads time only through `now` (default `performance.now()`), so a wall-clock step neither
  stalls nor bursts attempts.
- **The swap's hold** (section 3, "A restart of a running conversation"; Task 18). The swap's launch is built with
  the restart's fresh native inspection (`built.overrides.native`), whose `token` the held shell runs under. The rule
  "never respawn over it" lives where the respawn-then-fallback order lives, `lib/restartAgent.ts`: after a spawn whose
  wait found no engine, the swap asks once whether its pane is the held shell under that token (`heldShell`, read by
  `backend.isHeld` in `swap.ts`); `true` ends the swap with no further respawn, `false` and `'unknown'` keep today's
  path (the fresh fallback). So it holds for every swap (restart, retarget, a move's fallback). Only `restart.ts`
  marks the row and hands it on, and only a row with a `sessionId`: a ready row without one would become a
  `heldFirstLaunch`, whose recovery delivers the receipt's first task a second time. Without one, and for retarget and
  a move, the answer is today's error. The reply's `resumed` is `true`: the conversation is kept and the held pass
  resumes it; `false` would make Desktop say "Started a new conversation." (`restart_agent_action.dart:262`). The
  backend's hold on the pane is not released (the pane stays the held shell), and `commitRelaunchedEngine` is not run.
- **Older fork receipts.** A row with a `creationId` always has a receipt this release wrote: the fork reserves it and
  registers the row in the same process, and a pending receipt a dead core left is never run again
  (`AgentCreationReceipts.run`). So a fork receipt with no `firstTask` is a fork with none.
- **Option parity** (left to the builder). A recovered create or native fork carries every option the original passed,
  as every restore of that row does: engine, folder, the agent id its session is named after, a fresh native
  inspection and hooks, permission (`bypassPermission`/`permissionMode`), grid (`gridLaunch`, held for models while it
  is down), Codex and Claude profiles (`codexHome`, `claudeHome` through the native environment), harness (`dsh`, its
  env and args, held for the Store; a fork's own runtime key, which its preparation filled from the source's before its
  dispatch), SCM env (`scmLaunch`), named agent, machine MCP servers, Harness's instructions and the pull request line
  (`startedBy`), launch model (`launchModel`), install recipe, cleared variables, Windows pane launch, typed first task
  (`firstTask`), Browser, OpenClaw's folder. Differences, all shared with every restore and none worth a change:
  (1) a permission flag the engine no longer takes is downgraded to Ask with a log line (`downgradedPermission(...,
  'restore')`) where a create refused it; (2) a Codex on its own login gets its profile's provider named again
  (`ownLoginProviderArgs`), which it reads anyway; (3) create-time preparation is not repeated: a harness template,
  folder trust, connectors' profile-home MCP config, instruction writes and API tools all ran before the original
  dispatch, which did happen (the pane exists). No gap needs a task.

## Every reader of a row's launch outside the frame

Searched (`launch?.state`, `.launch.state`, `'held'`, `.active` in `cli/src`, the clients' `launchState`): every client
(Desktop, mobile, the TUI, the CLI's `ps`/`show`/`wait`/`new`/`ensure`/`watch`, the gateway's and the core's usage
counts, tool watches) reads the **frame**, so `shownLaunch` in `agentFrame` covers them. Rows leave the core in three
more places; the rest read the true hold on purpose.

| Reader | Reads | Today, for a launch the guard held | After |
|---|---|---|---|
| `lib/agentFrame.ts` `agentFrame` (every client, `agent_synced`, replies) | `launch`, `active` | held, `offline` | starting, active (Task 15) |
| `core/wifiAgents.ts` (the Wi-Fi device's list) | `launch`, `active` | `unavailable` (held rows are inactive) | `starting` (Task 16) |
| `core/terminals/sessions.ts` `describe` (the shell service's created reply) | `launch` | held | starting (Task 16) |
| `core/api.ts` `agentView` (CoreApi lists for services, the devices' list) | the row | raw | `creationId` left out (Task 16); launch and `active` stay true: services read only `failed` (`services/orchestrator.ts:74`) and `active` (Hachi, search, Agent Messages), none of which a first launch with no conversation or children reaches; a message to it waits until it is up, as for any harness without a conversation; a guard-held conversation reads to them as a held conversation does today (inactive) until its resume is up |
| Agent client (`agentClient/model.ts` `listedStateOf`, `ensure.ts`, `newCommand.ts`) | the frame | `offline`; `ensure` read held as not starting and asked whether its engine runs | as any starting launch: `wait` looks again until it settles or its deadline (`timeout`); `failed` once a bound fails it (Task 5 pins it) |
| `gateway/gateway.ts:358`, `core/usageOutcomes.ts:75`, `lib/productUsageSignals.ts:117`, `core/toolWatches.ts:31` | the frame | counted `held` | counted `starting`, then `ready` or `failed` |
| Gates: `lib/closeAgentService.ts:59` (unused chat), `lib/hostMove/mover.ts:140`, `lib/purgeAgentService.ts:256`, `core/terminals/sessions.ts:23` (`visitStatus`) | true launch | not ready, the same as starting | unchanged: each treats held and starting alike |
| Recovery mechanics: `heldLaunches.ts`, `restoreAgents.ts`, `restoreLaunch.ts`, `newPane.ts`, `restart.ts`, `discovery.ts` (`onDormant`/`onRemoved` skip held rows), `terminalAgentReconciler.ts`, `terminalBackendCoordinator.ts:131`, `launchAuthority.ts` | true launch | held | unchanged except as the tasks below say: they run on the true hold |
| Input (`core/input.ts`, `lib/sessionInput.ts`, `core/deliveries.ts`), the dial (`cable/`, `services/devices.ts`) | no launch state | — | nothing to change |

## Review Focus

Each line is a case the spec implies and its test list does not exercise; the test is in the task named.

1. **One upgrade holds several panes at once** (the reported case: three Codex panes). Flights stay capped at four,
   each agent keeps its own count, and a pass turned away by full flights is not an attempt. Task 12,
   `heldLaunches.spec.ts`.
2. **Restart pressed twice, from two windows, while a timer attempt runs.** One flight, one dispatch, both answered.
   Task 12.
3. **A first task with quotes, `$`, backticks and a newline** is relaunched byte for byte as one argv word, as the
   create launched it. Task 14 (`restoreLaunch.spec.ts`) and Task 1 (the eagerHooks prompts carry quotes and `$HOME`).
4. **A wall-clock step during the backoff or the 15 minutes** (sleep and wake, NTP) neither stalls nor bursts attempts:
   only `now` is read. Task 12.
5. **A recovery whose respawn tmux turns away after its journal** (`adoption-mismatch`: the pane is no longer that held
   shell) leaves the row `starting` under the new token: it is watched as boot watches a journaled dispatch
   (`watchRestoredPane`), never left "Starting" with nothing watching. Task 10.

## Task graph

| # | Task | Effort | Depends on |
|---|---|---|---|
| 1 | The red end to end (`heldLaunchRecovery.e2e.ts`, `eagerHooks.e2e.ts`) | high | - |
| 2 | The row: `creationId`, `startsAgain`, `guardHeld`, `heldFirstLaunch` | xhigh | - |
| 3 | A receipt's first task (`AgentCreationReceipts`) | xhigh | - |
| 4 | The held shell says "Starting again." | medium | - |
| 5 | Pin `harness wait` across a recovery | medium | - |
| 6 | A create records its intent's id | medium | 2 |
| 7 | A fork records its receipt's id | medium | 2 |
| 8 | The launches pass the id; a fork's receipt keeps its task | high | 3, 7 |
| 9 | The restore marks the guard's hold, first launch or conversation | xhigh | 2 |
| 10 | The restore recovers a guard-held launch into its own pane | xhigh | 9 |
| 11 | The new-pane watcher marks the guard's hold | high | 9 |
| 12 | Each guard-held launch's attempts, bounds and restart | xhigh | 2, 9 |
| 13 | `agent_restart` hands a held first launch to `restartHeld` | high | 2 |
| 14 | The restore's launch carries the original task | high | 2, 3, 9 |
| 15 | The frame shows a guard-held launch starting | high | 2 |
| 16 | The other places a row leaves the core | medium | 15 |
| 17 | Wiring (`core/main.ts`); turns Tasks 1 and 19 green | high | 1, 6, 8, 10, 11, 12, 14, 15, 18, 19 |
| 18 | A restart whose swap the guard held starts again (the swap) | xhigh | 2, 9, 13 |
| 19 | The red end to end of a restart the guard held | high | 1 |

Longest chain: four tasks (2 → 9 → 10 → 17; also 2 → 7 → 8 → 17, 2 → 9 → 12 → 17, 2 → 9 → 14 → 17, 2 → 9 → 18 → 17,
2 → 13 → 18 → 17). Tasks 1 and 19 stay red until Task 17. Files, all under `cli/` (each in one task only, but
where a task names the earlier one it follows):

- 1, 19: `e2e/heldLaunchRecovery.e2e.ts` (new in 1; 19 adds a case), `e2e/eagerHooks.e2e.ts` (1 only).
- 2: `src/lib/registry.ts`, `src/lib/createAgentPane.ts`, `src/lib/registry.firstLaunch.spec.ts` (new),
  `src/lib/createAgentPane.spec.ts`.
- 3: `src/lib/agentCreationReceipt.ts`, `src/lib/agentCreationReceipt.spec.ts`.
- 4: `src/lib/engineLaunch.ts`, `src/lib/engineLaunch.spec.ts`.
- 5: `src/agentClient/commands.spec.ts`.
- 6: `src/core/agents/create.ts`, `src/core/agents/create.spec.ts`.
- 7: `src/core/agents/fork.ts`, `src/backendSocket.ts` (one optional field of a type), `src/core/agents/fork.spec.ts`.
- 8: `src/core/agents/launches.ts`, `src/core/agents/launches.spec.ts`.
- 9, 10: `src/lib/restoreAgents.ts`, `src/lib/restoreAgents.spec.ts` (9, then 10).
- 11: `src/core/agents/newPane.ts`, `src/core/agents/newPane.spec.ts`.
- 12: `src/core/agents/heldLaunches.ts`, `src/core/agents/heldLaunches.spec.ts`.
- 13, 18: `src/core/agents/restart.ts`, `src/core/agents/restart.spec.ts` (13, then 18).
- 18: `src/lib/restartAgent.ts`, `src/lib/restartAgent.spec.ts`, `src/core/agents/swap.ts`,
  `src/core/agents/swap.spec.ts`.
- 14: `src/core/agents/restoreLaunch.ts`, `src/core/agents/restoreLaunch.spec.ts`.
- 15: `src/lib/agentFrame.ts`, `src/lib/agentFrame.spec.ts`.
- 16: `src/core/wifiAgents.ts`, `src/core/terminals/sessions.ts`, `src/core/api.ts`, `src/core/wifiAgents.spec.ts`,
  `src/core/terminals/sessions.spec.ts` (new), `src/core/api.spec.ts`.
- 17: `src/core/main.ts` (it wires Task 18's dep too, so it follows 18).

---

### Task 1: The red end to end

**Files:** Create `cli/e2e/heldLaunchRecovery.e2e.ts`; Modify `cli/e2e/eagerHooks.e2e.ts` (the
`keeps a post-rc held %s …` case, lines 176-225).

**Depends on:** nothing. **Effort:** high. **Failing test:** both files; red until Task 17.

- [ ] **Step 1: Write `heldLaunchRecovery.e2e.ts`** from the probe's case B
  (`zzReproHeldExec.e2e.ts`, in the orchestrator's scratchpad): no `probe.log`, no case A, no `sleep()`, assertions in
  place of log lines. `describe.skipIf(process.platform === 'win32')` (it needs the rc window). Keep the probe's
  `harness()` helper (TMUX_PANE empty, a person's shell).

```ts
it('a first launch the guard held starts again in its own pane, its task delivered once', async () => {
  // IsolatedDaemon.create(); the fake Codex shim at d.root/bin/codex; `sleep 2` appended to the isolated .zshrc; start.
  // `harness new codex <projects>/b1 --name b1 -- hello`, not awaited; as soon as agents_list has b1 (polled, until()),
  // the shim is rewritten to bin/codex.new and renamed over bin/codex: its pane is in the 2 s rc file then.
  // `harness wait b1 --timeout 2m` starts beside it.
  // until('b1 ready', ..., 30_000, 250): every frame of b1 seen has launch.state !== 'held'; ends on launch.state === 'ready'.
  expect(d.log()).toContain(`[launch] ${id.slice(0, 8)} starting → held`)          // the guard did hold it
  const codex = launches(d).filter(l => l.engine === 'codex' && l.args.includes('hello'))  // d.root/launch-argv
  expect(codex).toHaveLength(1)
  expect(waited.code, waited.out + waited.err).toBe(0)
  expect(waited.out.trim()).toBe('b1: idle · read it: harness show b1')
}, 180_000)

it('a conversation the guard held on its restore resumes in its own pane, without a second engine', async () => {
  // The same daemon set-up. `harness new codex <projects>/c1 --name c1 -- hi`; until c1 is ready with a sessionId S.
  // d.stop(); its pane (the only one: d.tmux.run('list-panes', '-a', '-F', '#{pane_id}')) killed with kill-pane;
  // a watcher started before d.start() polls d.log() every 50 ms for c1's `[restore] codex · agent <id> · pane`
  // line with `· resuming <S8>` and then replaces bin/codex by rename: the restored pane is in its 2 s rc file then.
  // until('c1 resumed', ..., 60_000, 250): every frame of c1 seen has launch.state !== 'held'; ends on ready, sessionId S.
  expect(d.log().slice(restartAt)).toContain(`[launch] ${id.slice(0, 8)} starting → held`)  // the guard held the resume
  const resumed = launches(d).slice(before).filter(l => l.engine === 'codex')               // launches after d.stop()
  expect(resumed).toHaveLength(1)
  expect(resumed[0].args).toContain(S)
}, 180_000)
```

- [ ] **Step 2: Rewrite eagerHooks' post-rc case** to the new behaviour, keeping its fixture (the bash rc that changes
  the Codex config once inside a pane, the wrapper that records every dispatch's argv):
  - `it.each(['create', 'fork'])('recovers a post-rc held %s from its receipt across a core restart, its request
    delivered once')`: the request carries a `creationId` (`post-rc-<operation>-recovery`) and the prompt
    `original "held" prompt $HOME` (create) or `original "fork" prompt $HOME` (fork); the reply is
    `{ creationId, state: 'created', agent }`. Once the log shows `[launch] <id8> starting → held`, the core is
    SIGKILLed at once and `[cli] ready` awaited, as today (a comment: the first attempt comes 2 s after the hold, so the
    boot's restore recovers it; if the attempt wins, every assertion still holds). The `writeFileSync(config, original)`
    repair goes: the recovery's fresh inspection reads the config as the rc left it. Then: `until` the row is
    `launch.state === 'ready'` (60 s), no frame seen with `launch.state === 'held'`; the recorded dispatches are exactly
    one for a create, its last argv word the prompt byte for byte; for a fork two (the source's, then one with `fork`,
    the source's session id, and the prompt last).
  - `it('fails a post-rc held create made without a creationId, with words that say what to do')`: the same fixture,
    no `creationId`; `until` the row reads
    `{ launch: { state: 'failed', error: 'ENGINE_DID_NOT_START', detail: 'This harness did not start. Close it and open a new one.' } }`;
    no dispatch recorded; then `agent_restart` answers `{ error: 'NO_ACTIVE_PROCESS' }` (decision 1), the row reads the
    same failed launch after it, and its pane is still there (`list-panes -a` has it, the held shell) with no dispatch
    recorded.

- [ ] **Step 3: Run both, see them fail for the right reason**

Run: `npx vitest run --config vitest.e2e.config.ts e2e/heldLaunchRecovery.e2e.ts e2e/eagerHooks.e2e.ts`
Expected: FAIL. `b1 ready` times out with `launch.state` `held`, and `harness wait` exits 124; `c1 resumed` times out
with `launch.state` `held` (the "…held for recovery." hold nothing retries until a service connects); eagerHooks'
recovery cases time out on `ready`, and the no-`creationId` case on `failed` (the row stays held). The hold itself is
seen in every case (the `starting → held` line).

- [ ] **Step 4: Commit** the two e2e files (red).

### Task 2: The row: `creationId`, `startsAgain`, `guardHeld`, `heldFirstLaunch`

**Files:** Modify `cli/src/lib/registry.ts`, `cli/src/lib/createAgentPane.ts`; Test
`cli/src/lib/registry.firstLaunch.spec.ts` (new), `cli/src/lib/createAgentPane.spec.ts`.

**Depends on:** nothing. **Effort:** xhigh (a persisted row field). **Failing test:** the specs below.

**Interfaces:** Produces, in `lib/registry.ts`:

```ts
export type AgentLaunch = /* … */ | { state: 'held'; service: string; detail: string; nativeToken?: string; startsAgain?: true }
// RegisteredSession: creationId?: string   (the receipt that made it: written once at registration, never in a frame)
// openPendingAgent(input: { …; creationId?: string })
/** A launch the native guard held, to start again by itself: held, `startsAgain`, a `nativeToken`; any `sessionId`. */
export function guardHeld(row: Pick<RegisteredSession, 'launch'> | undefined): boolean
/** `guardHeld` and no `sessionId`: a first launch, recovered from its receipt. */
export function heldFirstLaunch(row: Pick<RegisteredSession, 'launch' | 'sessionId'> | undefined): boolean
```

and `CreateAgentPaneDeps.creationId?: string` in `lib/createAgentPane.ts`, handed to `openPendingAgent`.

- [ ] **Step 1: Write the failing tests** (`registry.firstLaunch.spec.ts`, on a throwaway registry file as the other
  `registry.*.spec.ts` do):
  - `it('keeps the creation id a pending agent was opened with, across a save and a load')`.
  - `it('drops a saved creation id that is not one')` for `42`, `''`, `'short'`, `'has/slash-xxxxxxxxxxxx'` (the rule is
    `validCreationId`, imported from `./agentCreationReceipt.js`), and opens no row without one.
  - `it('keeps startsAgain on a held launch, and only there')`: `setLaunch` held with `startsAgain: true` keeps it
    through a load; `startsAgain: 'yes'` and `startsAgain` on `starting`/`failed` are dropped; `beginNativeDispatch`
    leaves `{ state: 'starting', nativeToken }` without it.
  - `it.each` truth table for `guardHeld` and `heldFirstLaunch`: `guardHeld` true for held + `startsAgain` + a token,
    with or without a `sessionId` (whatever its `service`), false without each of the three and for `undefined`;
    `heldFirstLaunch` the same but false with a `sessionId`.
  - `createAgentPane.spec.ts`: `it('opens the pending agent with the creation id it was given, and none when not')`.
- [ ] **Step 2: Run** `npx vitest run src/lib/registry.firstLaunch.spec.ts src/lib/createAgentPane.spec.ts`;
  Expected: FAIL (`creationId` absent, `startsAgain` dropped by `normalizedLaunch`, no `guardHeld`/`heldFirstLaunch`
  export).
- [ ] **Step 3: Implement.** `normalizedLaunch` keeps `startsAgain: true` on a held launch; `strictPersistedRow` takes
  `creationId` out of the spread and puts it back only when `validCreationId`; `openPendingAgent` stores it when given;
  `createAndRegisterPane` passes `deps.creationId` on. A comment on the field says why (the receipt a held first launch
  is recovered from, 2026-11-25).
- [ ] **Step 4: Run** the two specs and `npx vitest run src/lib/registry` (every registry spec); Expected: PASS.
- [ ] **Step 5: Commit** red, then the change.

### Task 3: A receipt's first task

**Files:** Modify `cli/src/lib/agentCreationReceipt.ts`; Test `cli/src/lib/agentCreationReceipt.spec.ts`.

**Depends on:** nothing. **Effort:** xhigh (private text on disk). **Failing test:** below.

**Interfaces:** Produces:

```ts
run(id: string, fingerprint: string, create: () => Promise<AgentCreationOutcome>, guest?: string, firstTask?: string): Promise<AgentCreationStatus>
/** The first task of the launch receipt [id] made for [agentId]: a create's `native-create-v1` intent (`input.prompt`)
 *  or a fork's receipt (`firstTask`), created for [agentId], pending or unconfirmed. `task` null: it had none. Null when
 *  the receipt cannot say: missing, another agent's, cancelled, scrubbed, failed, the other kind, a model or legacy
 *  receipt, or unreadable. */
firstLaunchTask(id: string, agentId: string, kind: 'create' | 'fork'): { task: string | null } | null
```

- [ ] **Step 1: Write the failing tests**:
  - `it('keeps a fork's first task with its reservation and its outcome, under the same fingerprint')`: the file after
    the reservation and after the outcome both carry `firstTask`; a retried `run` with the same fingerprint and no task
    answers the outcome; none is written when the fork has no task.
  - `it('refuses a fork receipt whose first task is not text')` (read as corrupt, `CREATION_STORAGE_FAILED`).
  - `it.each` for `firstLaunchTask(id, 'agent-a', 'create')` on a `native-create-v1` intent: created for `agent-a`,
    pending (in flight), unconfirmed (claimed, no result) → `{ task: 'fix it' }`; an empty or absent prompt →
    `{ task: null }`; created for `agent-b`, cancelled, scrubbed, missing, a `model-create-v1` intent, a version 1
    receipt, a corrupt file → `null`.
  - The same for `'fork'`: created for `agent-a`, pending, unconfirmed → its task, or `{ task: null }` without one;
    failed, created for `agent-b`, a version 2 intent, missing → `null`.
  - `it('scrubs a deleted fork's first task, and still answers its outcome')`: `scrubCreated('agent-a')` counts it, the
    file has no `firstTask`, `status` is unchanged; another agent's fork keeps its task.
- [ ] **Step 2: Run** `npx vitest run src/lib/agentCreationReceipt.spec.ts`; Expected: FAIL.
- [ ] **Step 3: Implement** on the class's own reader: `run` writes `firstTask` (when given) into the reservation, the
  completed receipt and its `unsaved` copy; `read()` refuses a version 1 receipt whose `firstTask` is present and not a
  non-empty string; `firstLaunchTask` uses `read()` and `status`/`intentStatus`, returns null on any thrown error;
  `scrubCreated` also rewrites a version 1 receipt created for the agent without its `firstTask`.
- [ ] **Step 4: Run** the spec; Expected: PASS.
- [ ] **Step 5: Commit** red, then the change.

### Task 4: The held shell says "Starting again."

**Files:** Modify `cli/src/lib/engineLaunch.ts` (lines 669 and 705); Test `cli/src/lib/engineLaunch.spec.ts` (line 841
and the tmux held command's test).

**Depends on:** nothing. **Effort:** medium. **Failing test:** none (copy only; one commit).

- [ ] **Step 1:** Replace `Waiting for native launch preparation to be confirmed.` with `Starting again.` in the
  Windows held argv and the tmux held command, and in the specs that assert them. `harness-held` and the token stay
  (`heldPaneFormat`, `pty/src/panes.rs` `held_by` match on those, not on the words).
- [ ] **Step 2: Run** `npx vitest run src/lib/engineLaunch.spec.ts src/lib/engineLaunch.windows.spec.ts`; Expected: PASS.
- [ ] **Step 3: Commit** one commit.

### Task 5: Pin `harness wait` across a recovery

**Files:** Test `cli/src/agentClient/commands.spec.ts` (the `describe('harness wait')` block).

**Depends on:** nothing. **Effort:** medium. **Failing test:** none: these pin what `wait` already does with the
frames a recovery shows (one commit); no CLI change (decision 3).

- [ ] **Step 1: Write the tests** with the block's `FakeDaemon`:
  - `it('waits through a first launch starting again: never idle, failed or held, and times out still waiting')`:
    frames `frame('b1', { sessionId: '', status: 'active', launch: { state: 'starting' }, createdAt: <past STARTING_MS> })`,
    every `agent_close` inspect answering `activity: 'unknown'`; `waitCommand(['b1', '--timeout', '3s'])` returns
    `EXIT.timeout`, out `b1: timeout · still working; wait again or read it: harness show b1`; `--json` state `timeout`.
  - `it('ends on the failed state a bound gives it, with its words')`: the same frames for three looks, then
    `launch: { state: 'failed', error: 'ENGINE_DID_NOT_START', detail: 'This harness did not start. Close it and open a new one.' }`;
    returns `EXIT.failed`, out `b1: failed · This harness did not start. Close it and open a new one.`
- [ ] **Step 2: Run** `npx vitest run src/agentClient/commands.spec.ts -t "harness wait"`; Expected: PASS.
- [ ] **Step 3: Commit** one commit.

### Task 6: A create records its intent's id

**Files:** Modify `cli/src/core/agents/create.ts`; Test `cli/src/core/agents/create.spec.ts`.

**Depends on:** 2. **Effort:** medium. **Failing test:** below.

**Interfaces:** Produces `prepare(input, authority: LaunchAuthority, context?: { local: boolean; creationId?: string })`;
consumes `CreateAgentPaneDeps.creationId` (Task 2).

- [ ] **Step 1: Write the failing tests:** `it('records the creation intent's id on the row it registers, as the caller
  names it')` (`prepare(input, authority, { local: true, creationId: 'intent-0123456789abcdef' })` → the registered
  row's `creationId`); `it('records none for a create made without an intent, whatever its authority is called')`
  (`createAgent(input)`, whose authority id is the session label, and `prepare` without `creationId`).
- [ ] **Step 2: Run** `npx vitest run src/core/agents/create.spec.ts`; Expected: FAIL.
- [ ] **Step 3: Implement:** `context.creationId` goes to `createAndRegisterPane`; nothing reads `authority.id` for it.
- [ ] **Step 4: Run** the spec; Expected: PASS. **Step 5: Commit** red, then the change.

### Task 7: A fork records its receipt's id

**Files:** Modify `cli/src/core/agents/fork.ts`, `cli/src/backendSocket.ts` (`onForkAgent`'s input gains
`creationId?: string`); Test `cli/src/core/agents/fork.spec.ts`.

**Depends on:** 2. **Effort:** medium. **Failing test:** below.

**Interfaces:** Produces `onForkAgent(input: { agentId: string; name: string | null; prompt: string | null; creationId?: string })`.

- [ ] **Step 1: Write the failing tests:** `it('records the fork receipt's id on the fork's row')`,
  `it('records none for a fork asked without one')`.
- [ ] **Step 2: Run** `npx vitest run src/core/agents/fork.spec.ts`; Expected: FAIL.
- [ ] **Step 3: Implement:** `prepare`'s input `creationId` goes to `createAndRegisterPane`.
- [ ] **Step 4: Run** the spec and `npm run typecheck`; Expected: PASS. **Step 5: Commit** red, then the change.

### Task 8: The launches pass the id; a fork's receipt keeps its task

**Files:** Modify `cli/src/core/agents/launches.ts`; Test `cli/src/core/agents/launches.spec.ts`.

**Depends on:** 3 (`run`'s `firstTask`), 7 (the fork input). **Effort:** high. **Failing test:** below.

**Interfaces:** Consumes `run(..., guest, firstTask)` (Task 3), `onForkAgent`'s `creationId` (Task 7). Produces
`LaunchRequestDeps.prepareCreate`'s context `{ local: boolean; creationId?: string }`.

- [ ] **Step 1: Write the failing tests:**
  - `it('hands the native-create preparation its intent's id, for a folder and for a new project')`: both
    `prepareCreate` calls in the `native-create-v1` branch get `{ local, creationId: '<the request's creationId>' }`.
  - `it('keeps a fork's first task on its receipt and names the receipt to the fork')`: `agent_fork` with a
    `creationId` and a prompt → `receipts.run` called with the prompt as `firstTask`, the fork called with
    `{ agentId, name, prompt, creationId }`; the fingerprint is the one of today (`{ operation: 'fork', agentId, name,
    prompt }`); without a prompt no task; without a `creationId` neither.
- [ ] **Step 2: Run** `npx vitest run src/core/agents/launches.spec.ts`; Expected: FAIL.
- [ ] **Step 3: Implement** the three call sites.
- [ ] **Step 4: Run** the spec; Expected: PASS. **Step 5: Commit** red, then the change.

### Task 9: The restore marks the guard's hold, first launch or conversation

**Files:** Modify `cli/src/lib/restoreAgents.ts`; Test `cli/src/lib/restoreAgents.spec.ts`.

**Depends on:** 2. **Effort:** xhigh (the invariants' proof). **Failing test:** below.

**Interfaces:** Produces, exported from `lib/restoreAgents.ts`:

```ts
export const STARTING_AGAIN = 'Starting again.'
export const DID_NOT_START = { error: 'ENGINE_DID_NOT_START', detail: 'This harness did not start. Close it and open a new one.' } as const
/** The launch a row gets once its pane is seen to be the guard's held shell under [nativeToken]: held, to start again,
 *  for a conversation (it resumes) and for a first launch whose request can be rebuilt (a `creationId`, and for a fork an
 *  engine with a native fork and the session it forked); else the failed state. */
export function guardHold(row: RegisteredSession, nativeToken: string): AgentLaunch
// RestoreAgentsDeps.startAgain?: (agentId: string) => void   — the held passes, asked to try that agent again
```

`guardHold` is `{ state: 'held', service: 'native', nativeToken, startsAgain: true, detail: STARTING_AGAIN }` or
`{ state: 'failed', ...DID_NOT_START }` (`supportsNativeFork` from `./engineLaunch.js`); only a row with no `sessionId`
can get the failed state.

- [ ] **Step 1: Write the failing tests:**
  - `it.each` for `guardHold`: a create with a `creationId`; a Codex and a Claude Code fork with
    `forkedFrom.sessionId`; a row with a `sessionId` and no `creationId` → held, `startsAgain`, `Starting again.`; no
    `creationId`, an OpenCode (handoff) fork, a native fork without `forkedFrom.sessionId` (none with a `sessionId`) →
    failed.
  - `it('a restored first launch the guard holds starts again, and asks the held passes for it')`: the watch sees the
    pane held under the row's (new) token → the row is `guardHold`'s held launch, `startAgain` called once.
  - `it('a restored first launch the guard holds with nothing to rebuild from fails, asking nothing')`.
  - `it('a restored conversation the guard holds starts again too: startsAgain, "Starting again.", and the held passes
    are asked for it')` (a `sessionId` row; the "…held for recovery." sentence is gone from every row; decision 4).
  - `it('boot: a first launch left starting in its held shell becomes a held first launch')` (the `restoreAgents.ts:489`
    branch with no `sessionId`: `guardHold`'s launch, `startAgain` called; failed with nothing to rebuild from, no
    `startAgain`). Still skipped afterwards in this task; Task 10 recovers it.
  - `it('boot: a conversation left starting in its held shell starts again, and is relaunched in this pass as today')`
    (the same branch with a `sessionId`: `guardHold`'s launch in place of "Waiting to confirm the engine executable and
    native hooks.", `startAgain` called, the row in `missing` with its pane alive).
  - The no-proof sites keep their launch and words exactly: `it('a first launch whose pane went with a reboot, or whose
    watch ran out, is held as today, without startsAgain')` (`restoreAgents.ts:536`, `:1017`).
- [ ] **Step 2: Run** `npx vitest run src/lib/restoreAgents.spec.ts`; Expected: FAIL.
- [ ] **Step 3: Implement** the exports and the two sites (the guard's "held for recovery" sentence at `:1003` and the
  boot's words at `:494` go for every row; both sites call `deps.startAgain` for a held result).
- [ ] **Step 4: Run** `npx vitest run src/lib/restoreAgents.spec.ts src/lib/restoreAgents.settle.spec.ts`; Expected:
  PASS. **Step 5: Commit** red, then the change.

### Task 10: The restore recovers a guard-held launch into its own pane

**Files:** Modify `cli/src/lib/restoreAgents.ts`; Test `cli/src/lib/restoreAgents.spec.ts`.

**Depends on:** 9. **Effort:** xhigh (never two engines). **Failing test:** below.

**Interfaces:** Consumes `guardHeld`, `heldFirstLaunch` (Task 2), `STARTING_AGAIN`, `DID_NOT_START` (Task 9). The summary's shape does not change:
a recovery that dispatched is in `restored`; one held again before dispatch is in `held`.

- [ ] **Step 1: Write the failing tests** (the spec's restore list, at this layer; `buildLaunch` is a fake):
  - `it('relaunches a held first launch into its held pane only: respawn with the row's token, the new token journaled
    first')`: `livePane` true, `waitingPane(runtime, rowToken)` true → `respawn(pane, launch, { expectedHeldToken:
    rowToken })`, `beginNativeDispatch(agentId, launch.nativeToken)` before it, the row `starting` with the new token,
    the pane watched; `createPane` never called.
  - `it('at boot, too: held for native by the defer, then relaunched by the held pass')` (the `starting` branch of
    Task 9 now goes on to `missing`, its defer hold keeps `startsAgain`, an `only` pass relaunches it).
  - `it('fails a held first launch at once when its pane is gone or surely not its held shell, and never gives it a
    pane')` (decision 2): `livePane` false, and `waitingPane` false → the row `failed` with `DID_NOT_START`'s words,
    `summary.failed` has `ENGINE_DID_NOT_START`; no `buildLaunch`, `respawn`, `createPane` or `killPane`;
    `allocateWaitingPanes` makes none.
  - `it('waits for the next attempt when its pane could not be read')`: `waitingPane` `'unknown'` → `unsurveyed`, the
    row unchanged.
  - `it('resumes a guard-held conversation whose pane went into a new waiting pane, as today')` (decision 4): `livePane`
    false → `allocateWaitingPanes` makes its pane under the row's token, then `respawn` with that `expectedHeldToken`
    and `resumeSessionId`; its row keeps `startsAgain` until the dispatch. One whose pane is alive and not its held
    shell → `unsurveyed`, as today.
  - `it.each(['native', 'models', 'store'])('a guard-held %s launch, first or conversation, held again keeps startsAgain
    and "Starting again.", with no pane respawn and no hold line')`: `buildLaunch` answers `{ held }`, or the boot's
    defer holds it; both a first launch and a conversation row.
  - `it('fails a held first launch whose request cannot be read, and keeps its pane')`: `buildLaunch` answers
    `{ error: 'ENGINE_DID_NOT_START', detail }` → the row failed with those words, `summary.failed` has the code,
    `killPane` not called. A held conversation row's failure still closes its pane, as today.
  - Review Focus 5: `it('watches a journaled recovery whose respawn tmux turned away, as boot watches one')`: `respawn`
    runs `onDispatch` then answers not started (`The waiting pane changed`) → the row is watched on its pane.
  - The rows of today stay so: a held first launch without `startsAgain` → `skipped` "original native launch awaits
    recovery"; a held conversation without `startsAgain` is relaunched as today, its hold words as today.
- [ ] **Step 2: Run** `npx vitest run src/lib/restoreAgents.spec.ts`; Expected: FAIL.
- [ ] **Step 3: Implement** in the survey loop (`:458-473`), the boot branch (`:489-497`), `hold()` (`:614-640`), the
  error branch (`:672-678`) and the dispatch's not-started branch (`:711-735`).
- [ ] **Step 4: Run** `npx vitest run src/lib/restoreAgents.spec.ts src/lib/restoreAgents.settle.spec.ts`; Expected:
  PASS. **Step 5: Commit** red, then the change.

### Task 11: The new-pane watcher marks the guard's hold

**Files:** Modify `cli/src/core/agents/newPane.ts`; Test `cli/src/core/agents/newPane.spec.ts`.

**Depends on:** 9 (`guardHold`). **Effort:** high. **Failing test:** below.

**Interfaces:** Produces `PaneWatcherDeps.startAgain?: (agentId: string) => void`.

- [ ] **Step 1: Write the failing tests:** `it('a new pane the guard held starts again: startsAgain, "Starting again.",
  and the held passes are asked for it')` (announced once; `startAgain` once); `it('a held new pane with nothing to
  rebuild from fails with words that say what to do')` (no `creationId`; a handoff fork) → `failed`,
  `ENGINE_DID_NOT_START`, the close-and-open detail, a `[agent] create failed · <engine> · ENGINE_DID_NOT_START` warning,
  no `startAgain`; `it('a watch that runs out is held as today, without startsAgain')` (`newPane.ts:241-245`).
- [ ] **Step 2: Run** `npx vitest run src/core/agents/newPane.spec.ts`; Expected: FAIL.
- [ ] **Step 3: Implement** at `newPane.ts:168-173` with `guardHold` (a new pane is always a create or a fork: no
  `sessionId`).
- [ ] **Step 4: Run** the spec (100% for the file: `npx vitest run src/core/agents/newPane.spec.ts --coverage
  --coverage.include=src/core/agents/newPane.ts`); Expected: PASS. **Step 5: Commit** red, then the change.

### Task 12: Each guard-held launch's attempts, bounds and restart

**Files:** Modify `cli/src/core/agents/heldLaunches.ts`; Test `cli/src/core/agents/heldLaunches.spec.ts`.

**Depends on:** 2 (`guardHeld`), 9 (`DID_NOT_START`). **Effort:** xhigh (concurrency and timers).
**Failing test:** below.

**Interfaces:** Produces:

```ts
export interface HeldLaunchesDeps {
  registry: Pick<typeof registry, 'list' | 'byAgent' | 'setLaunch'>
  restore: (only: ReadonlySet<string>, current: () => boolean) => Promise<RestoreSummary>
  announce: (session: RegisteredSession) => void
  log: (line: string) => void
  /** Monotonic milliseconds; `performance.now()` unless a test gives its own. */
  now?: () => number
}
// createHeldLaunches(...) returns { boot, restoreHeld, restartHeld, startAgain(agentId: string): void, close }
```

Per `guardHeld` row, a first launch or a conversation alike, in memory: the first hold's time, attempts made, guard
holds after a dispatch, and when the next attempt may come. `startAgain` starts that record (next attempt
`heldRetryMs(0)` after the hold) or, for an agent that already has one, counts a guard hold after a dispatch; the 10th
fails the row. A pass that meets a `guardHeld` row with no record (held before a core restart) starts one, and that
pass is its first attempt. An attempt runs only when due (a
person's restart: at once), counts, and sets the next one `heldRetryMs(made)` later. An attempt that did not dispatch
past 15 minutes from the first hold fails the row. One timer, set for the earliest due agent, runs only the due ones
(never a full pass). A record goes when its row is gone or neither `guardHeld` nor its recovery starting (`starting`
with a `nativeToken`). A guard-held row's dispatch never resets `quietPasses`, and its holds do not arm the shared
timer. A held row without `startsAgain` keeps the shared schedule and `restartHeld`'s answers of today. Failing a row: `setLaunch(failed, DID_NOT_START)`, `announce`, one log line, the record dropped.

- [ ] **Step 1: Write the failing tests** (`vi.useFakeTimers()` and a test `now`; no sleeps):
  - `it('a hold seen at run time arms one attempt for that agent 2 s later')`; nothing before.
  - `it('a recovery held again is the next attempt, not a new count')`: attempt 1 at +2 s dispatched; `startAgain`
    again → attempt 2 at attempt 1 + 4 s; then 8, 16, 30, 30 s.
  - `it('another agent's pass, a service's and the ready pass never try it sooner')`.
  - `it('a guard-held dispatch does not hurry the other held agents')` (`quietPasses` unchanged).
  - `it('a conversation the guard held has the same attempts, bounds and restart answers')` (decision 4: a row with a
    `sessionId`; its bound lines say `relaunch`).
  - `it('a guard-held row met with no record, after a core restart, starts one: that pass is attempt 1')`.
  - `it('a held row without startsAgain keeps the shared schedule and its answers of today')` (`SERVICE_UNAVAILABLE`
    from `restartHeld` while held).
  - `it('fails the row on its 10th guard hold after a dispatch, once')`: the row failed with `DID_NOT_START`, announced,
    `[restore] codex · agent <sid> · first launch held again 10 times · NATIVE_GUARD_REPEATED` logged once, no attempt
    after.
  - `it('fails a first launch whose evidence is still changing 15 minutes after its first hold')`: every attempt held
    before dispatch; the one after 15 minutes fails it, `NATIVE_EVIDENCE_UNSETTLED` logged once.
  - `it('says why it is held again once per change, by its service')`.
  - `it('forgets the count once the row is ready, failed, stopped or gone: a later hold starts at 2 s again')`.
  - `restartHeld`: `it('a person's restart runs an attempt at once, and it counts')`; `it('answers success when the
    attempt dispatched or was held again by changing evidence')`; `it('answers the failed state when the attempt or a
    bound failed the row')`.
  - Review Focus 1: `it('three first launches held by one upgrade keep their own counts; a pass turned away by full
    flights is no attempt')` (six due agents, four flights).
  - Review Focus 2: `it('two restarts and a due attempt at once run one flight and dispatch once')`.
  - Review Focus 4: `it('reads only its own clock: Date stepped back an hour, the attempt still comes on time')`.
- [ ] **Step 2: Run** `npx vitest run src/core/agents/heldLaunches.spec.ts`; Expected: FAIL.
- [ ] **Step 3: Implement** `startAgain`, the per-agent records and timer, the bounds, and `restartHeld`'s answers.
  The module comment says why (2026-10-15's 27,491 attempts a day; the bounds: a guard that keeps failing would show
  "Starting" for good).
- [ ] **Step 4: Run** `npx vitest run src/core/agents/heldLaunches.spec.ts --coverage
  --coverage.include=src/core/agents/heldLaunches.ts`; Expected: PASS at 100%. **Step 5: Commit** red, then the change.

### Task 13: `agent_restart` hands a held first launch to `restartHeld`

**Files:** Modify `cli/src/core/agents/restart.ts` (lines 196-200); Test `cli/src/core/agents/restart.spec.ts`.

**Depends on:** 2. **Effort:** high. **Failing test:** below.

- [ ] **Step 1: Write the failing tests:** `it('a held first launch restarts through restartHeld, and its answer is the
  restart's')` (success while held again; the failed state's error); `it('a first launch still starting is refused:
  "This harness is still starting."')` (`NATIVE_LAUNCH_HELD`); `it('a held first launch without startsAgain is refused
  with the words of today')`; `it('a guard-held conversation goes to restartHeld, as every held conversation does')`.
  The failed tile's Restart (`NO_ACTIVE_PROCESS`, decision 1) is today's code and is pinned end to end by Task 1.
- [ ] **Step 2: Run** `npx vitest run src/core/agents/restart.spec.ts`; Expected: FAIL.
- [ ] **Step 3: Implement** with `heldFirstLaunch`.
- [ ] **Step 4: Run** the spec (100% for the file); Expected: PASS. **Step 5: Commit** red, then the change.

### Task 14: The restore's launch carries the original task

**Files:** Modify `cli/src/core/agents/restoreLaunch.ts`; Test `cli/src/core/agents/restoreLaunch.spec.ts`.

**Depends on:** 2, 3 (`firstLaunchTask`), 9 (`DID_NOT_START`). **Effort:** high. **Failing test:** below.

**Interfaces:** Produces `RestoreLaunchDeps.receipts: Pick<AgentCreationReceipts, 'firstLaunchTask'>` and the `launch`
opts `{ resumeSessionId?: string; agentId: string; firstPrompt?: string; forkSessionId?: string }`.

For a `heldFirstLaunch` row, after the guest, external-resume and folder checks and before `relaunchOverrides`: a create
(no `forkedFrom`) reads `firstLaunchTask(creationId, agentId, 'create')`; a fork needs `supportsNativeFork(engine)` and
`forkedFrom.sessionId`, reads `'fork'`, and launches with `forkSessionId: forkedFrom.sessionId`. The task becomes
`firstPrompt` unless `typedFirstPrompt(engine, task)` (then the row's `firstTask` carries it). No `creationId`, a null
read, a handoff fork or a fork without its session: `{ error: DID_NOT_START.error, detail: DID_NOT_START.detail }`.

- [ ] **Step 1: Write the failing tests:** `it('relaunches a held create with the first task its intent kept')`;
  `it('relaunches a held native fork as the fork again, with the task its receipt kept')`; `it('adds nothing to the argv
  of an engine that takes its task typed')`; `it('a task none was given adds none')`; `it.each` for the refusal (no
  `creationId` — the reader is not asked —, the reader's null, a handoff fork, a fork without `forkedFrom.sessionId`);
  `it('reads no receipt for any other row')` (a guard-held conversation among them: its resume of today, no
  `firstPrompt`, no `forkSessionId`); Review Focus 3: `it('hands the task on byte for byte')` with
  ``it's "$(rm -rf ~)" `x`\nnext``.
- [ ] **Step 2: Run** `npx vitest run src/core/agents/restoreLaunch.spec.ts`; Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the spec (100% for the file); Expected: PASS. **Step 5: Commit** red, then the change.

### Task 15: The frame shows a guard-held launch starting

**Files:** Modify `cli/src/lib/agentFrame.ts`; Test `cli/src/lib/agentFrame.spec.ts`.

**Depends on:** 2. **Effort:** high. **Failing test:** below.

**Interfaces:** Produces:

```ts
/** The launch and the activity a client is shown for [row]: a launch the guard held (`guardHeld`), which starts again
 *  by itself, reads as a launch starting. The registry keeps the true hold, which the restore and the held passes run on. */
export function shownLaunch(row: Pick<RegisteredSession, 'launch' | 'active' | 'sessionId'>): { launch: AgentLaunch; active: boolean }
```

- [ ] **Step 1: Write the failing tests:** `it.each(['a first launch', 'a conversation'])('sends %s the guard held as a
  launch starting, and active')` (frame `launch` exactly `{ state: 'starting' }`, `status: 'active'`, no `nativeToken`,
  `detail` or `startsAgain`; with and without a `sessionId`); `it('sends every other held launch as it is')` (no
  `startsAgain`, with and without a `sessionId`); `it('never sends the creation id')`.
- [ ] **Step 2: Run** `npx vitest run src/lib/agentFrame.spec.ts`; Expected: FAIL.
- [ ] **Step 3: Implement** `shownLaunch` and use it for `launch` and `status`.
- [ ] **Step 4: Run** `npx vitest run src/lib/agentFrame`; Expected: PASS. **Step 5: Commit** red, then the change.

### Task 16: The other places a row leaves the core

**Files:** Modify `cli/src/core/wifiAgents.ts` (lines 40-42), `cli/src/core/terminals/sessions.ts` (line 41),
`cli/src/core/api.ts` (`agentView`); Test `cli/src/core/wifiAgents.spec.ts`, `cli/src/core/terminals/sessions.spec.ts`
(new), `cli/src/core/api.spec.ts`.

**Depends on:** 15 (`shownLaunch`). **Effort:** medium (three mechanical call sites). **Failing test:** below.

- [ ] **Step 1: Write the failing tests:** `it('lists a guard-held launch to the Wi-Fi device as starting')` (today
  `unavailable`); `it('describes a guard-held launch to the shell service as starting')`; `it('gives a service no
  creation id')`.
- [ ] **Step 2: Run** `npx vitest run src/core/wifiAgents.spec.ts src/core/terminals/sessions.spec.ts
  src/core/api.spec.ts`; Expected: FAIL.
- [ ] **Step 3: Implement:** `wifiAgents` and `describe` read `shownLaunch(row)`; `agentView` leaves `creationId` out
  with `gridLaunch`.
- [ ] **Step 4: Run** them (100% for each file); Expected: PASS. **Step 5: Commit** red, then the change.

### Task 17: Wiring

**Files:** Modify `cli/src/core/main.ts` (wiring only).

**Depends on:** 1, 6, 8, 10, 11, 12, 14, 15, 18, 19. **Effort:** high (the integration). **Failing test:** Task 1's
two e2e files and Task 19's case; this task turns them green.

- [ ] **Step 1:** Move `const receipts = new AgentCreationReceipts(...)` (`main.ts:2954`) above `createRestoreLaunch`
  (`:2615`) and pass `receipts` to it; give `createHeldLaunches` (`:551`) `announce: (session) => announceSession(session)`
  (defined at `:850`, called only after); give `createPaneWatcher` (`:2839`), `restoreDeps` (`:2674`) and
  `createAgentRestarter` (`:3035`) `startAgain: (agentId) => heldLaunches.startAgain(agentId)`. Nothing else.
- [ ] **Step 2: Run** `npm run typecheck`, then `npx vitest run --config vitest.e2e.config.ts
  e2e/heldLaunchRecovery.e2e.ts e2e/eagerHooks.e2e.ts`; Expected: PASS.
- [ ] **Step 3: Commit** the change (its red is Task 1's and Task 19's commits).

### Task 18: A restart whose swap the guard held starts again

**Files:** Modify `cli/src/lib/restartAgent.ts`, `cli/src/core/agents/swap.ts` (`paneSwapDeps`),
`cli/src/core/agents/restart.ts` (after Task 13; lines 277-285); Test `cli/src/lib/restartAgent.spec.ts`,
`cli/src/core/agents/swap.spec.ts`, `cli/src/core/agents/restart.spec.ts` (after Task 13).

**Depends on:** 2 (`startsAgain`), 9 (`guardHold`), 13 (`restart.ts` and its spec are Task 13's first).
**Effort:** xhigh (a respawn over a pane: never two engines, never the conversation lost). **Failing test:** below;
end to end, Task 19's case, green with Task 17's wiring.

**Interfaces:** Consumes `guardHold`, `STARTING_AGAIN` (Task 9). Produces:

```ts
// lib/restartAgent.ts
export type RestartOutcome =
  | { ok: true; processIdentity: ProcessIdentity; resumed: boolean }
  | { ok: false; detail: string; error?: 'ENGINE_LAUNCH_REFUSED'; held?: true }  // held: its pane is its own launch's held shell
// RestartAgentDeps:
/** Whether the pane is the native guard's held shell under this swap's own launch token. Left out: never asked. */
heldShell?: () => Promise<boolean | 'unknown'>
// core/agents/restart.ts, RestartDeps:
/** The held passes, asked to try that agent again (core/agents/heldLaunches.ts `startAgain`). */
startAgain?: (agentId: string) => void
```

`swap.ts` gives `heldShell: () => backend.isHeld(runtime, launch.native.token)` only when `launch.native?.token` and
`backend.isHeld` exist. `restartAgent`: after any spawn whose `waitForProcess` answered null, `heldShell` `true` returns
`{ ok: false, held: true, detail: '<engine> did not come back up after restart' }` at once (no fresh fallback, no
`keepAbandoned`); `false` or `'unknown'` goes on as today. `restart.ts`, on `held` with `session.sessionId`, still
`current()`: `registry.setLaunch(agentId, guardHold(<the row now>, built.overrides.native.token))` (the conversation's
`sessionId` kept), `announceSession`, `startAgain(agentId)` once, a log line `[restart] <sid> <engine> · held by the
native guard · starting again`, and `{ ok: true, session: <that row>, resumed: true }`; no `commitRelaunchedEngine`, no
`releaseHold`. On `held` without a `sessionId`: today's `{ ok: false, error: 'RESTART_FAILED', detail }`, the row
untouched. Retarget and a move's fallback get the `held` outcome as a failure, as today, and change nothing.

- [ ] **Step 1: Write the failing tests:**
  - `restartAgent.spec.ts`: `it('never respawns over its own launch's held shell: a resume the guard held answers held,
    with no fresh fallback')` (`waitForProcess` null, `heldShell` true → that outcome, `respawn` called once, no
    "retrying fresh" line, `keepAbandoned` not called); `it.each([false, 'unknown'])('falls back fresh as today when
    its pane is not its held shell (%s)')` (two respawns); `it('asks nothing when the engine came back up')`;
    `it('a fresh start the guard held answers held, once')` (no `sessionId`: one respawn).
  - `swap.spec.ts`: `it('reads its own launch's held shell by that launch's token')` (`isHeld(runtime, 'tok-1')` for
    `{ native: { token: 'tok-1', … } }`); `it('has no held-shell read without a native launch or a backend that can
    tell')`.
  - `restart.spec.ts` (the spec's fake `paneSwapDeps` with `waitForProcess: async () => null`, `heldShell: async () =>
    true`): `it('a restart of a conversation the guard held starts it again: the row held to start again, the held
    passes asked, success shown starting')` (the row `{ state: 'held', service: 'native', nativeToken: <the inspected
    launch's token>, startsAgain: true, detail: 'Starting again.' }` with its `sessionId`, announced once,
    `startAgain('a1')` once, the reply `{ ok: true, session: <the row>, resumed: true }`, `confirmLaunch` and
    `releaseHold` not called, one respawn); `it('a restart of a row with no conversation the guard held answers as
    today and marks nothing')`; `it('a held swap that changed under it marks nothing')` (`current()` false after the
    swap → `AGENT_CHANGED`, launch unchanged, no `startAgain`).
- [ ] **Step 2: Run** `npx vitest run src/lib/restartAgent.spec.ts src/core/agents/swap.spec.ts
  src/core/agents/restart.spec.ts`; Expected: FAIL (no `heldShell`, the fallback respawns, restart answers
  `RESTART_FAILED`).
- [ ] **Step 3: Implement** the three changes above. A comment at the check says why (the fallback respawned over the
  held shell on the same stale evidence and was held again, 2026-11-25).
- [ ] **Step 4: Run** the three specs (100% for `swap.ts` and `restart.ts`: `--coverage
  --coverage.include=src/core/agents/swap.ts --coverage.include=src/core/agents/restart.ts`) and `npm run typecheck`
  (retarget and the move compile unchanged); Expected: PASS. **Step 5: Commit** red, then the change.

### Task 19: The red end to end of a restart the guard held

**Files:** Modify `cli/e2e/heldLaunchRecovery.e2e.ts` (after Task 1: one case added, its helpers reused).

**Depends on:** 1. **Effort:** high. **Failing test:** the case below; red until Task 17.

- [ ] **Step 1: Write the case:**

```ts
it('a restart of a running conversation the guard held resumes in its own pane, answered at once as starting', async () => {
  // The same daemon set-up. `harness new codex <projects>/r1 --name r1 -- hi`; until r1 is ready with a sessionId S.
  // Its pane P (the frame's tmuxPane) and P's #{pane_pid} read with d.tmux.run('display-message', '-p', '-t', P, ...).
  // A watcher polls that pid every 50 ms; once it changes (the swap's respawn: the new shell is in its 2 s rc file),
  // it replaces bin/codex by rename. The restart's native inspection ran before the kill, on the old shim.
  const restarted = await client.request('agent_restart', { agentId: id }, 60_000)
  expect(restarted.error, JSON.stringify(restarted)).toBeUndefined()
  expect(restarted).toMatchObject({ resumed: true, agent: { id, sessionId: S, launch: { state: 'starting' } } })
  // until('r1 resumed', ..., 60_000, 250): every frame of r1 seen has launch.state !== 'held'; ends on ready, sessionId S.
  expect(d.log().slice(restartAt)).toMatch(new RegExp(`\\[launch\\] ${id.slice(0, 8)} \\S+ → held`))  // the guard held the swap
  expect(d.log().slice(restartAt)).not.toContain('retrying fresh')                                     // no respawn over it
  const resumed = launches(d).slice(before).filter(l => l.engine === 'codex')                           // launches after the restart
  expect(resumed).toHaveLength(1)
  expect(resumed[0].args).toContain(S)
}, 180_000)
```

- [ ] **Step 2: Run** `npx vitest run --config vitest.e2e.config.ts e2e/heldLaunchRecovery.e2e.ts -t "a restart"`;
  Expected: FAIL: the restart answers `RESTART_FAILED`, `codex did not come back up after restart`, after the log's
  `retrying fresh` line; the `→ held` line is never written (the row is never marked held).
- [ ] **Step 3: Commit** the case (red).

## Decisions

The orchestrator's answers of 2026-11-25 to the draft's five questions, final; the spec carries them (sections 1, 2
"The retry ends", 3, 4).

1. **Restart on the failed tile** keeps today's answer: `agent_restart` of a failed launch with no engine answers
   `NO_ACTIVE_PROCESS` (`restart.ts:243`); the pane (the held shell) is kept. Nothing relaunches it. Pinned end to end
   in eagerHooks' no-`creationId` case (Task 1).
2. **A held first launch whose pane is gone, or surely not the held shell under its token**, is failed at once
   (`ENGINE_DID_NOT_START`, the close-and-open words), never relaunched; a pane read that is `'unknown'` waits for the
   next attempt (Task 10).
3. **`harness wait`**: no CLI change. During a recovery it waits and at its deadline answers `timeout` ("still
   working", exit 124); `idle` once the engine is up; `failed` once a bound fails the row (Tasks 1 and 5).
4. **A conversation relaunch the guard held** (a row with a `sessionId` whose restored pane became the held shell:
   `restoreAgents.ts:1002`, and the boot's branch at `:489-497`) is in this pull request: `startsAgain`, "Starting
   again." (in place of the "…held for recovery." sentence and the boot's words), the frame's `starting`, the per-agent
   attempts and both bounds. Its recovery is the restore's resume of today into its own held pane with
   `expectedHeldToken`; no receipt. Which rule covers which row is under "What this plan decides" ("Which rule is
   whose", "A guard-held conversation's pane"). Tasks 1, 2, 9, 10, 12, 13, 14, 15 and 16.
5. **A restart of a running conversation whose pane swap the guard holds** (the draft's open question) is the same
   cause and in this pull request, as its own task with a red test: the swap never respawns over its own launch's held
   shell (by that launch's token); the row becomes a launch the guard held (`startsAgain`, its conversation kept),
   handed to the held passes (`startAgain`); `agent_restart` answers success with the row, shown starting (spec
   section 3; "The swap's hold" under "What this plan decides"). Tasks 18 and 19, wired in 17.

## Verification

1. **End to end, this Mac, POSIX.** From `cli/`:
   `npx vitest run --config vitest.e2e.config.ts e2e/heldLaunchRecovery.e2e.ts e2e/eagerHooks.e2e.ts`
   (eagerHooks builds its own bundle first). Isolation is the e2e harness's (`e2e/harness/daemon.ts` `IsolatedDaemon`,
   `cli/AGENTS.md` rule 6): a throwaway root with its own HOME, ZDOTDIR, rc files and data folder, a private tmux
   server under its own `TMUX_TMPDIR` with `TMUX`/`TMUX_PANE` unset, its own port (never 18473), fake Claude Code and
   Codex engines, signed out (no backend, no account). What a person sees: all cases pass; b1's log shows
   `starting → held`, then `held → starting`, then the ready line; `launch-argv` has one Codex launch with `hello`;
   `harness wait` prints `b1: idle · read it: harness show b1`; c1's log shows the restore's `· resuming` line, then
   `starting → held`, then the ready line with the same conversation, and `launch-argv` has one Codex launch after the
   stop; r1's restart answers at once with `resumed: true` and the row starting, the log shows `→ held` and no
   `retrying fresh`, and `launch-argv` has one Codex launch after the restart, resuming the same conversation; the
   failed create answers Restart with `NO_ACTIVE_PROCESS` and keeps its pane. Before Task 17 they fail as Task 1,
   Step 3 and Task 19, Step 2 say.
   Also locally, darwin only: `npx vitest run --config vitest.e2e.config.ts e2e/identityHoldVisible.e2e.ts`.
2. **Regression end to end, on GitHub by hand** (long): Actions → CI → Run workflow, scope `linux-e2e`, `e2e_files`
   `cli/e2e/forks.e2e.ts cli/e2e/agentClient.e2e.ts cli/e2e/restartIdentity.e2e.ts cli/e2e/recovery.e2e.ts
   cli/e2e/storeProcess.e2e.ts cli/e2e/serviceProcesses.e2e.ts cli/e2e/adopt.e2e.ts cli/e2e/updates.e2e.ts
   cli/e2e/enginehomes.e2e.ts`, on the branch.
3. **`npm run test:core`**: 100% per file for `src/core` and `src/services`; PR CI does not run it, so it is run here
   and recorded in the pull request.
4. **`npm run typecheck`**, and `git diff --exit-code origin/main -- src/architecture.coreFiles.txt` (unchanged), with
   `npx vitest run src/architecture.spec.ts`.
5. **The changed files' unit suites:** `npx vitest run src/lib/registry src/lib/createAgentPane.spec.ts
   src/lib/agentCreationReceipt.spec.ts src/lib/engineLaunch src/agentClient/commands.spec.ts
   src/core/agents/create.spec.ts src/core/agents/fork.spec.ts src/core/agents/launches.spec.ts src/lib/restoreAgents
   src/core/agents/newPane.spec.ts src/core/agents/heldLaunches.spec.ts src/core/agents/restart.spec.ts
   src/lib/restartAgent.spec.ts src/core/agents/swap.spec.ts src/core/agents/retarget.spec.ts src/core/agents/hostMove.spec.ts
   src/core/agents/restoreLaunch.spec.ts src/lib/agentFrame src/core/wifiAgents.spec.ts
   src/core/terminals/sessions.spec.ts src/services/shell.spec.ts src/core/api.spec.ts`.
6. **GitHub, on the pull request, by path** (`scripts/ci-plan.py`): the CLI unit suite, and `linux-e2e`, which runs the
   e2e files a PR adds or changes (`heldLaunchRecovery.e2e.ts`, `eagerHooks.e2e.ts`) on Ubuntu 24.04 with zsh: the
   Linux run of the same check. `windows-e2e` is not selected: no changed file is in `windows.yml`'s spec lists or
   their modules (`WINDOWS_SPECS`). Both can be run by hand (`ci.yml` `workflow_dispatch`, scope `windows-e2e` or
   `linux-e2e` with `e2e_files`; `windows.yml` and `cli-e2e.yml` have `workflow_dispatch` too). Windows needs no run of
   its own: the change there is the same row logic and the held argv's words; the pty host's
   `respawn`/`expected_held_token` is unchanged, and no Windows-only behaviour is shown, so no VM and no Dell.
7. **No check needs the user:** no client changes, and what clients are sent is asserted on the frames.
