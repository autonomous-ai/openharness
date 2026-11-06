# Decision deadlines implementation plan

> Implement task by task in this session, test first, followed by one independent review.

**Goal:** Apply an unanswered decision's recommended option at its declared deadline and tell its asker once.

**Architecture:** Extend each decision question/needs-human ask with optional ISO `defaultAt`. Persist it on the existing decision row, select due rows through an answeredAt/defaultAt index, and use the existing transactional decision-answer pipeline with a server-only default-applied marker. Keep the legacy 24-hour fallback for questions without a deadline, and run the decision sweep separately every minute rather than behind hourly maintenance.

**Tech Stack:** Existing TypeScript, Zod, Prisma/MongoDB, Vitest and singleton worker timers.

**Spec:** Task #3599, inventory Table A #8; Dee's 11-06 checkable-rules-as-code decision. Existing decisions-in-one-place privacy and answer concurrency contracts remain in force.

## Global Constraints

- No new refusal/execution authority: applying an option records a decision; it does not execute the work it describes.
- One explicit deadline per question, alongside its recommendation, at least 15 minutes after the trusted ask time. Older clients may omit it and retain the 24-hour fallback.
- An answer already committed by a person wins; a repeated sweep creates no second answer/notice.
- Worker questions still route through the PM; their deadline survives in the crew need.
- Notices carry no question/option text, matching existing decision privacy. The authorized decisions list supplies the chosen option and distinguishes automatic defaults from a person's choice.
- Test first, commit failing tests before implementation, push each task. Affected local checks only; full backend unit/integration suites in ready PR CI.
- No real CLI sign-out, production write, process-by-name stop or cli/src/core change. Temp files only in mktemp directories.

## Design

- **Growth:** Two optional fields on existing decision rows (`defaultAt`, `defaulted`), no collection. Existing answered-decision retention removes them with their row. New index holds two scalar dates per row; no text or array fanout.
- **Concurrency:** Due selection is advisory; the answer transaction rereads the row, checks the deadline against its trusted clock, and conditional answer write makes person/sweep races single-winner. Stable operation ID makes retries idempotent.
- **Read cost:** Two bounded index queries (at most 500 candidate IDs each) and at most 500 attempted answers per pass; no full history/collection scans. Due rows carry only IDs/person IDs. A minute sweep has overlap protection and cleanup.
- **Scale:** 10x decisions retain the same per-pass cap and indexed range. Plan test records IXSCAN and examined/returned counts; measure loopback latency. Production read-only environment is absent on this Team machine, so collection count/size/growth evidence is unavailable; no attempt to use another account's credentials.
- **Compatibility:** Optional server fields, additive API only. Keep overdue's existing 24-hour meaning; a separate `defaulted` flag identifies timed defaults. Old clients ignore the deadline fields and still see an agent decision rather than their own choice.
- **Migration/rollback:** Schema release adds a non-TTL index and optional fields. No backfill, no rewrite of old deadlines. Rollback backend ignores new fields; do not deploy new callers until backend supports them. Release owner deploys schema during the authorized window; Engineer performs no production writes.
- **Audience/identity:** Existing answerable/access/work-finished checks remain. Default uses server-only context; a caller cannot claim it. Cross-account text remains data, with no new execution path.
- **Failure/platforms:** Existing loud per-pass errors; no overlapping passes. Explicit defaults are due on the first minute pass at/after deadline; old fallback remains hourly-or-better. Common server behavior for every client.

## Review Focus

- A future explicit deadline must prevent the legacy 24-hour sweep from answering early (Task 2).
- A long-lived question whose deadline is today must not be missed by the createdAt reach (Task 2).
- A person's answer racing the sweep must produce exactly one answer and notice (Task 2).
- A worker's PM-routed question must keep the recommended deadline (Task 1).
- A slow/failed sweep must not overlap itself or block hourly maintenance (Task 3).

### Task 1: Carry and store explicit deadlines

**Files:** `backend/src/superTabs/decisions.ts`, `decisions.test.ts`, `commands.ts`, `crewNeeds.ts`; `backend/prisma/schema.prisma`.
**Interfaces:** `decisionChoices.defaultAt?: string` (ISO), `DecisionDraft.defaultAt?: string`, `DecisionTarget.defaultAt?: number|null`; persisted `SuperTabDecision.defaultAt?: DateTime` and `defaulted?: Boolean`.

- [x] Commit tests: decision.ask and needs-human preserve deadline, malformed time rejected, PM routing retains it, repeats with the same time reuse while a changed time is distinct.
- [x] Run affected decision tests and verify missing schema/field behavior fails.
- [x] Extend choices, row writes/reads/list and crew-need metadata; include normalized deadline in repeat identity. Add optional schema fields/index; generate local Prisma client.
- [x] Run decision/crew-need unit tests, typecheck and focused persistence integration; commit and push.

### Task 2: Apply due defaults once

**Files:** `backend/src/superTabs/overdueDecisions.ts`, `decisions.ts`, `commands.ts`, `store.ts`; `backend/integration/overdueDecisions.test.ts`.
**Interfaces:** `dueDefaultDecisions(db, now, limit)` returns IDs only; existing `leaveOverdueDecisions` processes explicit due defaults before legacy fallback. Server-only context `defaulted` becomes `DecisionAnswer.defaulted` and a dedicated notice.

- [x] Commit failing tests: before deadline stays open; exact deadline takes recommendation and tells asker; answered decision untouched; repeated/concurrent sweeps once; later deadline defeats old 24h fallback; long-lived question due today works; ended/private/withdrawn/reflection protections remain; query uses intended index with bounded examined rows.
- [x] Run focused integration file and observe missing timed behavior.
- [x] Add indexed query and transactional deadline validation, recording `defaulted` without mislabeling as person/24-hour choice. Reuse idempotent answer/notice path.
- [x] Run affected unit/integration tests, query-plan evidence and typecheck; commit and push.

### Task 3: Schedule defaults independently

**Files:** `backend/src/superTabs/overdueDecisions.ts`, new `decisionSweep.test.ts`, `backend/src/worker.ts`, `sweeps.ts`.
**Interfaces:** `startDecisionSweep(run, everyMs=60_000): stop`; singleton worker starts/stops it alongside hourly maintenance.

- [x] Commit timer tests with fake clock: immediate pass, one-minute pass, no overlap, failure recovers visibly, stop removes future wakes.
- [x] Run new test and observe missing scheduler.
- [x] Separate decision schedule from hourly maintenance, wire worker shutdown and preserve loud failure reporting.
- [x] Run affected scheduler/decision tests, focused integrations/typecheck, record timing/red-green evidence, mark ready and request one independent review.

## Evidence

- Task 1: `2a25b628e` produced three failures / 27 passes in decisions.test.ts because defaultAt was not accepted; persistence regression `4464f0bfd` also failed on the unsupported field. `2ea902402` passes 38 decision/crew-need tests and the focused storage/list/repeat integration test. Offset-equivalent times share a decision; a changed deadline creates another.
- Task 2: `83f0854f9` produced four failures / one pass in timed integration cases (deadline ignored, future deadline answered early, no due cap/query); `8161cdb57` fails trusted-clock enforcement. `11011f0f5` passes the deadline behavior and existing 24-hour cases. A follow-up removed a redundant date-type filter that Prisma’s profile reader could not decode; the date comparison already uses MongoDB date type bracketing. The intended deadline index returns one due row and examines at most two documents amid future, legacy and answered noise.
- Task 3: `8927710b4` cannot load the absent scheduler. `b9545b2e7` passes immediate/minute/stop, non-overlap and loud failure recovery tests. Decision work no longer waits behind hourly maintenance.
- Final affected local checks: 469 unit tests across decisionSweep, decisions, crewNeeds and commands, plus backend typecheck. Full backend unit and four integration shards are ready PR CI’s responsibility. The focused deadline integration file covers normalized persistence, exact deadline, future and long-lived questions, person/concurrent answers, replay, cap, withdrawal/reflection exclusions and both query plans.
- No production read/write was attempted. The required read-only environment file is absent on this Team machine. Collection count, index size and daily growth therefore remain a release-owner measurement, with bounded loopback query-plan evidence as the local substitute.
- Release: add the non-TTL decision_waiting_default index through the normal schema step, deploy backend before new callers; no backfill. Each pass attempts at most 500 questions, reserving half for legacy questions when both queues are full and reusing unused capacity. Permanently unavailable explicit defaults are withdrawn conditionally, never overwriting a person’s answer; transient failures retry without an age cutoff. A sustained transient failure backlog can delay later explicit questions and is visible in worker failure counts. Minute precision means the first pass at/after deadline; a slow active pass postpones the next one. Rollback ignores the additive fields and leaves the index harmlessly unused.

## Independent-review corrections

- Both reviewers found that an immediate or past deadline gave a person no response time. `44c7ffa35` fails the new lower-bound unit test (one failure / 31 passes). The common check now requires 15 minutes from the trusted ask clock, including worker questions routed through the PM and needs-human asks; exactly 15 minutes passes. The integration fixture asks at its actual historical creation time so due tests model a valid previously asked question.
- SecAlder found permanent rows could occupy the entire due queue indefinitely. The same test-first commit fails a bounded stuck-row integration test: legacy work gets no share. Missing people/tabs and permanent access/decision refusals now conditionally withdraw only unanswered explicit rows. Legacy work reserves half the pass; either queue reuses unused capacity. The existing legacy-cap test caught an initial underfill and is preserved.
- Final review-fix checks: 470 affected unit tests in four files, clean backend typecheck, and all 15 focused deadline integration tests pass. The stuck-row test proves legacy work proceeds immediately and fresh timed work is reached after the unavailable prefix drains. Existing query plans remain green.
- Explicit deadlines farther than 24 hours remain intentional; the task asks to honor the stated time rather than replace it with the old fallback. No maximum or new person-approval authority is introduced. A default records the recommendation with automatic attribution; it does not execute protected work.
