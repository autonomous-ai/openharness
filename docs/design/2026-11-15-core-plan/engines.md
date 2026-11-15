# Core engines: the other fourteen engines out of the core (notes to resume)

Task: move the 14 other engines (opencode, cursor, kilo, devin, hermes, amp, agy, grok, copilot, commandcode,
muse, pi, omp, openclaw) out of the daemon core into ONE worker, `engine-others`. Rules: ../2026-11-15-core-plan.md
(read its lessons). Audit rows: docs/design/2026-11-12-core-audit.md section 3, security items 3 and 5.

State (2026-11-15, the second agent): step 1 is split in two pull requests, as the lead allowed.

- **Step 1a, done:** PR #4317 from branch `core-engines-2` (the two WIP commits of `core-engines-1`, finished).
  The worker `engine-others` reads the fourteen engines' history and last turns; the core routes, bounds and checks.
- **Step 1b, carried implementation still WIP:** the live part below (attach, normalizers and readers, live parsers, their Stop
  rules, and the five profile `transcript()` readers). Start it from `main` once 1a has landed, on `core-engines-3`.

## Continuation, 2026-11-15: carried WIP integrated; step 1b still not ready

Worktree `/tmp/harness-core-engines-continue`, branch `codex/core-engines-continue`. This is a local handoff to
root; no push, PR edit, merge or release was performed. The original `core-engines-3` worktree remains untouched.

- Started from `f3e1e35b05`. Preserved its complete tracked diff, including the protocol rename, as
  `/tmp/core-refactor-engines-carried.patch` (SHA-256
  `20f85a2e549e99e1e89ceadc263d4cb71cbadca61febf1a7249eb1b8d5f915a0`) and copied both untracked specs.
  Local commits `26e6481d7e` and `b2057001f0` preserve them before integration.
- Integrated `origin/main` at `aad8dcd535` in `675a98bc51`. Kept main's superseded-attach cursor/retry fix,
  the worker-based attach path, and main's usage-service notifications. The worker's folded lines notify usage too.
- The carried code already moves the fourteen live parsers, Stop rules, Task hooks and profile transcript evidence
  to the worker. The golden fixture expectations are unchanged; its transport is the worker request path with JSON
  round trips. It is substantial WIP, not a finished extraction.
- This continuation fixes a bounded part of restart handling: retain a store's path across reconnect; fence op and
  reconnect-open answers by worker generation/token; forget abandoned reconnect candidates; refuse an old Stop's
  fallback close once a new turn has replaced it. Four new regression cases cover those behaviors.
- Protocol 2 advertisement expectations now match `ENGINE_OTHERS_VERSION=2`, explicitly keeping version 1 as history
  only. Core worker connection events no longer disconnect or reopen the inline live streams under a version-1 master.

### Design of this continuation

- Growth: one store-path reference on each existing session handle, removed with that handle. No new disk data or
  collection. The inherited stream/handle bounds still need the review below; this continuation does not claim 1b's
  whole bound is complete.
- Concurrency: a reply belongs to the captured worker generation and token. Reconnect uses the existing session
  handle; a stale candidate is forgotten. A Stop's fallback is restricted to the turn identity it began with.
- Read cost: no new read or polling. A reconnect reuses the path already resolved at attach; reply checks are constant
  time. Scale: the retained reference grows with attached sessions, as the existing handle map does; the worker's
  stream count and pending-byte limits are the first pressure signals. 10x measurements remain pending.
- Compatibility: no new public field or wire revision in this continuation. The carried protocol-2 change keeps
  protocol-1 history working and live inline. Explicit inline, old-master/new-core and new-master/old-core e2e remain
  required. No disk migration; rollback is reverting the code. No released tag or published contract was changed.
- Audience: the existing owner/local/internal-caller and service-token checks still enforce access. Identity: the
  same account/session and store path as the original attach; no other login is used.
- Failure: stale replies are discarded and abandoned candidates are forgotten; a failed Stop closes only its own
  turn, retaining the existing named warning. The inherited worker-unavailable visible-state work remains below.
- Platforms: affects CLI on macOS, Linux and Windows. No runtime test was executed in this continuation yet; native
  Windows and Linux remain unverified.

### Validation status and exact next checks

No compiler, build or test was run: `/tmp/core-refactor-perf.done` exists, but root held
`/tmp/core-refactor-validation-lock` for Browser #4320 validation. Do not call this green or ready. `git diff --check`
passed. `scripts/local-checks.py --list` selects `cli-core` and `cli-harnessd`; both must meet 100% per file.
The shell's default Node is 26.7.0; CI pins 24.22.2, so select the pinned runtime for the checks.

1. Acquire the shared validation lock atomically; only remove it if this continuation owns it. Run the four new
   restart cases red against `/tmp/core-refactor-engines-streams-before.ts` substituted for
   `cli/src/core/engines/otherStreams.ts`, preserving/restoring the current file in `finally`; then run them green.
   The filter is `reopens a store|ignores a turn operation|does not let an old Stop|does not restore an opening`.
   The tests are written, but neither red nor green has been observed.
2. Typecheck, architecture/lean tests, all changed core/engine tests, the unchanged 1,046-case golden; fix failures.
   Then full `npm run test:core`, `npm run test:harnessd` and the clean-head local-check receipt. Do not waive uncovered
   branches in the new core stream coordinator.
3. E2E: `otherEngines`, `eagerRepair`, `eagerIdentity`, `lean`, `usageProcess`, affected native cancellation/attach
   recovery, plus explicit protocol-1/master skew. Use isolated homes/daemon/tmux and the normal bundle runner.
4. Independent review and the same-workload attach/idle/live-tail CPU comparison. The inherited `OTHER_ENGINES_PERF`
   case measures history reads; it still needs the planned live-tail CPU workload. Listed closure only (not measured
   process performance): `aad8dcd535` 539 files / 92,691 lines; this continuation 539 / 92,713 before this notes edit.

### Remaining implementation review, found by reading (not reproduced yet)

- Initial file opens do not retain the fold's byte boundary: `streams.ts` assigns `stream.offset = resume?.offset`
  and starts an ordinary new tail at current EOF. A restart before the first live frame can fold missed writes as
  history, and a write between fold and tail installation can be skipped. Cursor explicitly skips byte-offset resume
  and snapshots the current rewritten file. Add deterministic first-open/restart/gap tests and preserve the legacy
  rewrite semantics while fixing both paths.
- `open()` in the core still needs the same lifetime protection as reconnect for forget, stop, rebind and competing
  initial opens. Worker async opens also need cancellation/supersession review; timeout must not leave a late stream.
- Enforce/check serial continuity and collection bounds on the core side. The inherited validators check shapes but
  allow unbounded event/frame arrays, and operation validation accepts replies missing required `events`/`turn` fields.
  Audit UTF-8 byte accounting (`JSON.stringify(...).length` currently counts code units), acks and lost-token bounds.
- Worker failure currently logs that conversations are held, but the plan requires an actionable visible session
  state. Its e2e currently checks the log. Prove Stop fallback and recovery exactly once on real isolated processes.
- Finish lifecycle cleanup: main creates `inlineOthers` but does not clear it at shutdown, and the worker request
  factory's `clear()` clears streams without stopping its owned Watcher. Review pending opens, polls, Tasks and timers.
- The inherited core stream specs contain fixed sleeps (5/30 ms); replace them with controlled timers or observable
  completion. Finish coverage and request-validator cases rather than treating the carried tests as evidence.
- Hermes home/store discovery and OpenClaw store discovery remain in core (`transcripts/stores.ts` loads Hermes's
  implementation). Reconcile their movement with step 1b's design. Runtime pane/config/catalog/model-control work
  remains step 2; purge/export remains step 3.

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
- From its review: a history past one frame of the link (4 MiB) comes back in parts the core asks for by offset
  (`READER_PART`, up to 64 MiB): these engines have no pages, or none for some asks, and the core used to send a
  whole replay on. A read past its deadline (15 s, Amp's history 25 s) is answered unavailable and keeps its place
  until it ends; only one still running a minute later recycles the worker (one recycle fails every engine's reads).
  An event the core cannot check is left out and counted, never the whole page. 1b's live pages can reuse the parts.
- Still in the core after 1a, for 1b: Hermes's home lookup (`core/transcripts/stores.ts` `hermesDb`, which loads
  Hermes's code and asks each profile's store, as attach does), and OpenClaw's store lookup (`lib/openclawStore.ts`).
- Core: 543 files, 93,002 lines before (main 85d8e61897); 544 files, 92,925 lines after (+`engines/otherEngines.ts`).
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
