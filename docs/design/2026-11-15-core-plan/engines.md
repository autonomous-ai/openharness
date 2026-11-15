# Core engines: the other fourteen engines out of the core (notes to resume)

Task: move the 14 other engines (opencode, cursor, kilo, devin, hermes, amp, agy, grok, copilot, commandcode,
muse, pi, omp, openclaw) out of the daemon core into ONE worker, `engine-others`. Rules: ../2026-11-15-core-plan.md
(read its lessons). Audit rows: docs/design/2026-11-12-core-audit.md section 3, security items 3 and 5.

State: worktree `.claude/worktrees/core-engines-1`, branch `core-engines-1`, two
WIP commits (`ac64e94c79`, `d71bb11e2f`) on origin/main `d50957ac3c`, PUSHED to origin/core-engines-1. No PR.
`npm ci` done in cli/.

## Update 2 (since the first notes)

- The lead agreed: steps 1 and 2 below are ONE PR (the parsers cannot leave without their Stop rules).
- Done since: `engines/others/readerRequests.spec.ts` passes (7 tests); harnessd/services.spec.ts passes (44 tests,
  new case for `otherEnginesVersion`, parser made strict: `/^(\d+):([1-9]\d{0,5})$/`). ENGINE_OTHERS version 1 will
  mean everything this one PR delivers (readers + live + Stop rules): no released worker exists yet, so no bump needed.
- Still failing/not run: `src/leanEntry.spec.ts` (2 cases about the lean bundle's roles: give `engine-others` its own
  entry like engine-claude; run it alone, it builds the bundle and takes minutes).
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

## Done in the WIP commit (core-engines-1, step 1 of the plan)

- `engines/otherEngines.ts`: OTHER_ENGINES, isOtherEngine, OTHER_ENGINES_SERVICE='engine-others', STORE_ENGINES,
  keepsStore, historyWaitMs. inProcess.ts and lib/sqliteRead.ts re-export (one list).
- Worker: `engines/others/transcripts.ts` (history + last turn of all 14, moved verbatim from core history.ts and
  lastTurn.ts; engine code loaded through the same lazy door, in the worker), `engines/others/readerRequests.ts`
  (private `engine_history_page`/`engine_last_turn`, v1, engine named per read, 4 per engine / 16 total, 5 s deadline,
  25 s for Amp history, recycle on timeout, 4 MiB reply cap), `engines/others/process.ts` (`runOtherEngines`),
  registered in serviceProcess.ts.
- harnessd/services.ts: host `engine-others` (onDemand, askedSince 0, 512/1024 MiB), `ENGINE_OTHERS_ENV`
  (`HARNESSD_ENGINE_OTHERS=<pid>:1`), `otherEnginesVersion(env, ppid)` (0 = none).
- Core: readers.ts routes the 14 to engine-others (per-engine bounds, denies the worker's queries), history.ts and
  lastTurn.ts are generic (`readerFor` + `storeOf`), `core/transcripts/stores.ts` (renamed from databaseHistory.ts:
  hermesDb + createStoreOf), main.ts wiring (othersHosted, isolated set, onDemand, startWaits, storeOf, inline
  databaseHistory). Protocol: HistoryAnswer gains `truncated?`, events may be `subagent_finished`.
- Specs updated and passing: history, lastTurn, openclaw (core/transcripts), stores, lib/databaseHistory (new),
  readers (new cases), engines/registry, architecture (coreFiles +stores.ts +otherEngines.ts -databaseHistory.ts,
  EDGE `^engines/others/`), and the golden passes unchanged through the worker port with JSON round trips.
- `engines/others/readerRequests.spec.ts` written, NOT yet run.

## Left for step 1 (finish before the PR)

1. Run `npx vitest run src/engines/others/readerRequests.spec.ts` and fix.
2. harnessd/services.spec.ts: 2 failures — the reader-worker list test and `serviceProcessesEnv` expectations need
   `engine-others` and `[ENGINE_OTHERS_ENV]: '42:1'`; add tests for `otherEnginesVersion` (100% gate: test:harnessd).
3. leanEntry.spec.ts: 2 failures (roles of the lean bundle): the new service process must be its own entry like
   engine-claude; read the failure (it builds the bundle; takes minutes; run alone).
4. e2e: new `cli/e2e/otherEngines.e2e.ts` copying engineReaders.e2e.ts: a fake Pi (eagerRepair.e2e.ts pattern) with a
   written session file; `session_get` through the worker; no worker for an empty core; SIGKILL and SIGSTOP the
   `engine-others` worker -> history ENGINE_UNAVAILABLE fast, core pid same, Pi pane alive, worker back, reads again;
   `HARNESSD_SERVICES=none` reads inline with no worker process. Add the private types to the "UNSUPPORTED on the
   client router" list. Run lean.e2e.ts, eagerRepair.e2e.ts, engineReaders.e2e.ts, history.e2e.ts, hermes*.e2e.ts.
5. Docs: services/AGENTS.md table and cli/AGENTS.md process table get `engine-others`; audit doc: mark the rows'
   progress (only my rows). Update the October plan doc's header if needed.
6. Gates: `npx tsc --noEmit -p .`, `npm run test:core`, `npm run test:harnessd`, `python3 scripts/local-checks.py --list`
   then `--run --base origin/main` from the clean committed head; `/code-review high` on the diff; PR (draft, receipt
   in body, then ready). Core files/lines before: 547 files (coreFiles.txt), closure 543 files / 92,994 lines.

## The plan after step 1 (one PR each, branches core-engines-2, -3, ...)

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
