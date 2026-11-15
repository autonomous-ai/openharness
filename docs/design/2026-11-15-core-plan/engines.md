# Core engines: the other fourteen engines out of the core (notes to resume)

Task: move the 14 other engines (opencode, cursor, kilo, devin, hermes, amp, agy, grok, copilot, commandcode,
muse, pi, omp, openclaw) out of the daemon core into ONE worker, `engine-others`. Rules: ../2026-11-15-core-plan.md
(read its lessons). Audit rows: docs/design/2026-11-12-core-audit.md section 3, security items 3 and 5.

State (2026-11-15, the second agent): step 1 is split in two pull requests, as the lead allowed.

- **Step 1a, done:** PR #PR_NUMBER from branch `core-engines-2` (the two WIP commits of `core-engines-1`, finished).
  The worker `engine-others` reads the fourteen engines' history and last turns; the core routes, bounds and checks.
- **Step 1b, not started in code:** the live part below (attach, normalizers and readers, live parsers, their Stop
  rules, and the five profile `transcript()` readers). Start it from `main` once 1a has landed, on `core-engines-3`.

## Step 1a: what landed

- Worker: `engines/others/otherEnginesProcess.ts` (named so the lean bundle gives it a file of its own, as
  `claudeReaderProcess` is: `leanEntry.spec.ts` `RUNNER`), `readerRequests.ts`, `transcripts.ts` (history and last
  turn of all fourteen, moved verbatim from core history.ts and lastTurn.ts, Amp's `threads export` with them).
- Core: `core/engines/readers.ts` routes the fourteen to the worker with per-engine bounds; `history.ts` and
  `lastTurn.ts` are generic; `core/transcripts/stores.ts` (was databaseHistory.ts) names a store; `engines/otherEngines.ts`
  is the plain list (it stays in the core after 1b too). Inline (`HARNESSD_SERVICES=none`, an older master): the
  same readers through `services/inline.ts`. `HARNESSD_ENGINE_OTHERS=<master pid>:1`: **version 1 means history and last
  turn only.** Step 1b must bump `ENGINE_OTHERS_VERSION` to 2 and ask the worker for live only at 2 or more: a
  1a master runs a 1a worker, which serves no live requests.
- Proof: `e2e/otherEngines.e2e.ts` (a fake Pi that writes a turn for each line typed in its pane, announced as Pi's
  extension does): no worker for an empty core; history and a live turn's recap (its last turn) read in the worker;
  SIGKILL and SIGSTOP of the worker answer a read at once as unavailable (retryable) while the pane works on and the
  core follows it, then read again once the master has it back; inline mode reads with no worker. Red on main.
  The golden passes unchanged. Its opt-in case `OTHER_ENGINES_PERF=<report.json> E2E_BUNDLE=1` is the workload for
  1b's before and after: four Pi conversations of 500 turns, attached again as the core starts, the core at rest for
  30 s, 400 history reads. 1a, two runs each on a shared Mac: attach 1.37 to 1.65 s before, 1.37 to 1.41 s after (core
  bound to attached); the core at rest 0.87 to 1.0% before, 0.87% after; the core's CPU for the 400 reads 0.45 s
  before, 0.10 s after; a read's p95 1.2 ms before, 1.4 ms after.
- Core: 543 files, 93,160 lines before (main f8b67d66dc); 544 files, 93,019 lines after (+`engines/otherEngines.ts`).
  The door (`engines/inProcess.ts`) still adds 107 files, 16,037 lines once one of their sessions attaches: 1b is
  what takes that away.

## Step 1b: what is left (one pull request)

The design is below ("Design S"). The order that keeps every commit testable:

1. Worker streams (`engines/others/streams.ts`): per session, the legacy `Watcher` in the worker plus the engine's
   normalizer (file engines) or reader (store engines), Cursor's Task queue and sub-agent manager, OpenClaw's
   holds, header and failed, Devin's turn aborted, copilot's `copilotHistoryTurnOpen` at open, agy's idle answer
   at open (the core captures the pane and sends it), commandcode's run error as a frame `failure` and
   `failureSummary`. The five profile `transcript()` readers (cursor, commandcode, pi, omp, grok) run over each line
   in the worker and frames carry only their compact evidence (`frame.runtime`, as Claude Code's and Codex's).
2. The protocol and its spec (`engines/others/streamRequests.ts`), with the core's validator.
3. The core: `core/engines/otherStreams.ts` (handles, the one long-poll, re-open after a restart), then attach.ts,
   ingest.ts, normalizers.ts and readerLoads.ts lose the fourteen; turnHooks.ts, input.ts (commandcode's open),
   cursorTasks.ts (forwards the Task hook) and agyBackstop.ts (pane check in core, close through the worker) use the
   handle; Stop rules as declared data with the core's own fallback close.
4. The golden through the worker's stream with JSON round trips, unchanged; `watcher.addSession` cases become the
   worker stream's tail starts, the same options.
5. e2e: extend `otherEngines.e2e.ts`: live turns through the worker; the worker killed or frozen: the pane works
   on, the agent says its live view is held (the core says so), and the turn typed meanwhile arrives once, after
   the worker is back. Plus `eagerRepair.e2e.ts`, `eagerIdentity.e2e.ts` and `lean.e2e.ts`, which delete or stall
   `core-inProcess-*` chunks and must change once those chunks leave the core.
6. Numbers on the same workload (`OTHER_ENGINES_PERF`): attach, the core at rest, and per-line CPU on the live tail.

## Design S, for the live part (the first agent's, after reading every touchpoint)

- The lead agreed: the live parsers and their Stop rules are ONE pull request (the parsers cannot leave without them).
- Design chosen for the live part (step 2), after reading all touchpoints: "Design S", worker-owned streams.
  - Why not the Claude/Codex pull protocol: Cursor's sub-agent manager (engines/cursor/subagent.ts) and the five
    store readers produce events with no file change the core could see, so the worker must be able to hand events
    to the core on its own; and the other engines' tail semantics are the legacy Watcher's (watcher/watcher.ts:
    `line`, `history` batch, `rewritten` re-attach), which LiveStreams does not reproduce (the golden would move).
  - Worker: per attached session a stream that runs today's in-core logic nearly verbatim: the legacy `Watcher` (in the
    worker) + the engine's normalizer for file engines, the engine's reader for store engines, Cursor's Task hook queue
    and sub-agent manager, OpenClaw's holds/header/failed, Devin's turn-aborted. Frames: `{ raw?, events, failure?,
    failureSummary?, notes? }` and the stream's turn snapshot `{ identity, turnOpen, continued, openedAt? }`.
  - Protocol (private, v1): `engine_stream_open` (fold history silently as attach.ts does, start tail/poll, answer
    historyTurnOpen, lastStarted, lastAborted, initial live events, lines count); ONE long-poll per worker
    `engine_streams_wait { acks }` (answers pages for streams with frames, or empty after ~25 s; capped 4 MiB) so the
    core's cost at rest is one request per worker; `engine_stream_drain` (worker reads now, answers the serial the
    core must reach); `engine_stream_turn { op: close|abort|open|cancel, identity, text?, emit }` returning events;
    `engine_stream_forget`. Core validates every page (events with liveEvent, sizes, serial order, token, generation).
  - Core: one generic `core/engines/otherStreams.ts`: a LiveState handle per session (turn from the last page;
    closeTurn marks it locally and sends a silent close), the wait loop, re-open after a worker restart (file streams
    resume from the acknowledged byte offset; store streams re-hydrate and reconcile the turn: turn_ended if it ended
    meanwhile). attach.ts 415-599 / ingest.ts 75-134 / normalizers.ts maps / readerLoads.ts go.
  - Stop rules as declared data in each engine's contract (drainFirst, grace, onlyOnError, errorMessage, closeEmits),
    applied by a kit function in core with worker turn ops and a core fallback: when the worker does not answer in
    time, the core closes the turn itself (turn_ended, aborted on error), so a Stop never leaves a turn open.
    commandcode's openTurn (PreToolUse hook and core/input.ts onSubmitted) is a turn op `open`; agy's idle pane is
    declared data (`? for shortcuts` idle, `esc to cancel` busy, last 4 lines) read by a kit helper in core for the
    attach check and the backstop timer, which stays in core.
  - Open question found: runtime profiles. Today attach calls `runtimeProfiles.hydrate(session, lines)` with ALL folded
    lines (other engines' profile readers parse transcript records in core: cursor, commandcode, pi, omp, grok have a
    `transcript()` reader). Shipping every folded line to the core defeats the move. Best fix: the worker reduces the
    profile during its fold and sends only the compact evidence, as `frame.runtime` does for Claude/Codex, which means
    bringing those five engines' profile `transcript()` readers into the worker in this same PR (their `pane()`,
    `config()`, `models()`, targets and catalogs can stay in the core until the model-switch PR). Decide this first.
  - Measure before/after on the same workload: attach time per engine, core CPU at rest with N sessions of these
    engines (e2e/perf.e2e.ts), and per-line core CPU on the live tail.


## What I found (decides the plan)

- The door `engines/inProcess.ts` adds 107 files / 16,037 lines to the core once any other-engine session needs it
  (measured with tools/closure.mjs: `node closure.mjs <cli>/src engines/inProcess.ts core/main.ts list`).
  Groups: transcripts (normalizers, DB readers, amp export), screens (lib/legacyScreen + askQuestion.ts), runtime
  profile readers (profileReader.ts), search providers re-exported by each engine's inProcess.ts (dead weight in core),
  homes (hermes), opencode version/session model.
- The core users of the door: attach.ts, ingest.ts, history.ts, lastTurn.ts, databaseHistory.ts, readerLoads.ts,
  cursorTasks.ts, agyBackstop.ts, runtimeControl.ts, runtimeProfileState.ts, backgroundCommands.ts (hermes),
  main.ts (`inProcessScreen`, `preloadEngine`).
- BIG COUPLING: the live state (normalizer/reader instances in core/transcripts/normalizers.ts maps) is used by the
  Stop rules (core/turns/turnHooks.ts 133-280: cursor, commandcode, devin, copilot, agy, grok), core/input.ts
  (commandcode `openTurn` on submit, via funnel `commandcode` dep), cursorTasks.ts (cursorNormalizers), agyBackstop.ts
  (agyNormalizers), bind (openclaw `paneRead`/`paneDue` on the OpenclawLive stream, main.ts ~1967). So the
  normalizers cannot move to the worker without those touchpoints moving in the same PR. Several closes RETURN
  events (copilot/agy closeTurn+abortTurn, grok abortTurn, cursor closeTurn): the worker must return them.
- Claude/Codex pattern to copy: core/engines/{readers,liveTransport,liveSessions,liveWatcher}.ts and
  engines/worker/{process,liveRequests,liveStreams,protocol,liveProtocol}.ts. Live = core watches file names
  (chokidar) and pulls pages with acknowledged cursors; core keeps a `LiveState` handle (turnOpen, snapshot,
  closeTurn(reason) marks the cursor closed locally, synchronous). `EngineLive.attachRules` absent = "fold the whole
  bounded file" (facets/live.ts) but LiveStreams.create currently requires attachRules.
- Compatibility pattern: master env flags `<masterPid>:<v>`; inline path via services/inline.ts (never in the core's
  closure). New core + old master: engine-others not listed => inline. Old core + new master: never asks for it.
- Golden `engines/otherTranscripts.golden.spec.ts` (1046 cases) records attach/ingest/history/last turn/agy backstop/
  cursor tasks through the core entries. It is the "no behavior change" proof for every step: keep it passing UNCHANGED,
  rewire only how it reaches the code. It caught one real issue: agy and Muse history replays emit `subagent_finished`
  (a LiveEvent), which the reader protocol's validator rejected.
- `amp threads export` (history) takes up to its 20 s timeout: the reader deadline (5 s, then recycle) would kill the
  whole worker. Done: `historyWaitMs('amp') = 25_000` in core and worker.
- Core-side database history (`core/transcripts/databaseHistory.ts`) is only used by services running INSIDE the core
  (search/handoff processes read stores themselves). Done: it comes from services/inline.ts now.
- e2e coverage of these engines is thin. eagerRepair.e2e.ts has fake muse/pi binaries (bind via PI_HOME session file +
  `--session-id`); hermesTerminalRecord.e2e.ts has e2e/harness/fakeHermes.mjs (SQLite store). eagerRepair.e2e.ts and
  lean.e2e.ts delete/stall `core-inProcess-*` chunks: they must change once normalizers leave the core.
- Lessons that apply: measure the hop on attach and the live tail; core keeps its own bounds; "no answer" = unknown,
  never none/false; ask the worker before the first irreversible step.


## The first agent's plan, kept for its detail (its 2 and 3 are step 1b now, its 4 step 2, its 5 step 3)

2. Live state to the worker (security item 3). Because of the coupling above, the Stop-rule touchpoints come in the
   same PR:
   - File engines (cursor, muse, amp, grok, agy, copilot, pi, omp, commandcode): each gets `engines/<e>/live.ts`, an
     `EngineLive` (LiveParser wrapping its normalizer, no attachRules). Extend LiveStreams for no-attachRules adapters
     (span = newest 64 MiB from a line start, like tailFileCapped). Generalize liveTransport/liveSessions/engineLinks
     from READER_SERVICES to an engine->service map (one live op per ENGINE, not per service). The core's remote
     attach branch then serves them; delete attach.ts 415-599 and ingest.ts 75-134 branches.
   - Engine specifics as worker logic or declared data: copilot's `copilotHistoryTurnOpen` at prepare end (worker);
     commandcode run error -> frame `failure` plus a new optional `failureSummary` for the device; agy's attach idle
     check (core captures the pane, worker reads `agyPaneIdle`); pane capture for chips after attach (cursor 100,
     opencode 100, grok/agy/devin/openclaw 60) as declared data; LivePage `lastAborted?` so `settled` stays exact.
   - Extend `engine_live_close` to return the parser's closing events (close | abort) and accept an open-turn op
     (commandcode `openTurn(text)`); core keeps its own fallback when the worker does not answer (close the turn and
     emit a plain turn_ended), so a Stop never leaves a turn open. turnHooks.ts, input.ts, agyBackstop.ts and
     cursorTasks.ts (Cursor's Task hook queue feeds its normalizer: it moves to the worker) use the handle.
   - Store engines (opencode, kilo, hermes, devin, openclaw): new store-stream protocol: the worker runs the reader
     (its 1 s poll stays in the worker), core long-polls `engine_store_read {token, serial, closed?}` (worker holds it
     up to ~10 s), core keeps a LiveState handle; on worker restart core reopens with its turnOpen so the hydrate
     emits only the difference (turn_ended if it ended meanwhile). OpenClaw holds/header/failed and Devin's
     onTurnAborted become typed page notes. Hermes home lookup moves to the worker, reported back for the row.
   - Inline compat: services/inline.ts gives the same adapters; `preloadEngine`/readerLoads go.
   - Measure before/after on the same workload: attach time per engine and the core's CPU at rest with N sessions
     (e2e/perf.e2e.ts, PERF_READERS-like workload). Golden must pass unchanged (wire it through the worker live path).
3. Stop rules as declared data (turnHooks.ts 133-280 -> each engine's contract + kit, like kit/stopHook.ts), if any
   engine-specific code is left in core after step 2.
4. Model switch and question steps through a grant (lib/runtimeControl.ts 229-663, kit/nativeSessionModel.ts,
   engines/launchControl.ts, lib/questionController.ts key steps, kit/questionPane.ts), plus screens (legacyScreen via
   the screen transport) and runtime profile readers (runtimeProfileState.ts inline readers) for the 14: copy
   core/engines/{modelControls,questionControls,controlTransport,screenTransport,runtimeTransport}.ts.
   e2e: engineModelControl/engineQuestionControl/engineSubmission patterns with a fake other engine.
5. Store engines' purge deletes (lib/purgeAgentService.ts 54-190) and close export (lib/sessionCheckpoint.ts 23-101,
   lib/sqlitePage.ts) to the worker; ask the worker before the first irreversible step.
End state: the core never imports engines/inProcess.ts (the door lives on in the worker and search), and the door's
closure is no longer reached from core/main.ts.
