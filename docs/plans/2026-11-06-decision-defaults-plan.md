# Decision deadlines implementation plan

> Implement task by task in this session, test first, followed by one independent review.

**Goal:** Apply an unanswered decision's recommended option at its declared deadline and tell its asker once.

**Architecture:** Extend each decision question/needs-human ask with optional ISO `defaultAt`. Persist it on the existing decision row, select due rows through an answeredAt/defaultAt index, and use the existing transactional decision-answer pipeline with a server-only default-applied marker. Keep the legacy 24-hour fallback for questions without a deadline, and run the decision sweep separately every minute rather than behind hourly maintenance.

**Tech Stack:** Existing TypeScript, Zod, Prisma/MongoDB, Vitest and singleton worker timers.

**Spec:** Task #3599, inventory Table A #8; Dee's 11-06 checkable-rules-as-code decision. Existing decisions-in-one-place privacy and answer concurrency contracts remain in force.

## Global Constraints

- No new refusal/execution authority: applying an option records a decision; it does not execute the work it describes.
- One explicit deadline per question, alongside its recommendation. Older clients may omit it and retain the 24-hour fallback.
- An answer already committed by a person wins; a repeated sweep creates no second answer/notice.
- Worker questions still route through the PM; their deadline survives in the crew need.
- Notices carry no question/option text, matching existing decision privacy. The authorized decisions list supplies the chosen option and distinguishes automatic defaults from a person's choice.
- Test first, commit failing tests before implementation, push each task. Affected local checks only; full backend unit/integration suites in ready PR CI.
- No real CLI sign-out, production write, process-by-name stop or cli/src/core change. Temp files only in mktemp directories.

## Design

- **Growth:** Two optional fields on existing decision rows (`defaultAt`, `defaulted`), no collection. Existing answered-decision retention removes them with their row. New index holds two scalar dates per row; no text or array fanout.
- **Concurrency:** Due selection is advisory; the answer transaction rereads the row, checks the deadline against its trusted clock, and conditional answer write makes person/sweep races single-winner. Stable operation ID makes retries idempotent.
- **Read cost:** A bounded 500-row due-date index query plus the existing bounded legacy query; no full history/collection scans. Due rows carry only IDs/person IDs. A minute sweep has overlap protection and cleanup.
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

- [ ] Commit tests: decision.ask and needs-human preserve deadline, malformed time rejected, PM routing retains it, repeats with the same time reuse while a changed time is distinct.
- [ ] Run affected decision tests and verify missing schema/field behavior fails.
- [ ] Extend choices, row writes/reads/list and crew-need metadata; include normalized deadline in repeat identity. Add optional schema fields/index; generate local Prisma client.
- [ ] Run decision/crew-need unit tests, typecheck and focused persistence integration; commit and push.

### Task 2: Apply due defaults once

**Files:** `backend/src/superTabs/overdueDecisions.ts`, `decisions.ts`, `commands.ts`, `store.ts`; `backend/integration/overdueDecisions.test.ts`.
**Interfaces:** `dueDefaultDecisions(db, now, limit)` returns IDs only; existing `leaveOverdueDecisions` processes explicit due defaults before legacy fallback. Server-only context `defaulted` becomes `DecisionAnswer.defaulted` and a dedicated notice.

- [ ] Commit failing tests: before deadline stays open; exact deadline takes recommendation and tells asker; answered decision untouched; repeated/concurrent sweeps once; later deadline defeats old 24h fallback; long-lived question due today works; ended/private/withdrawn/reflection protections remain; query uses intended index with bounded examined rows.
- [ ] Run focused integration file and observe missing timed behavior.
- [ ] Add indexed query and transactional deadline validation, recording `defaulted` without mislabeling as person/24-hour choice. Reuse idempotent answer/notice path.
- [ ] Run affected unit/integration tests, query-plan evidence and typecheck; commit and push.

### Task 3: Schedule defaults independently

**Files:** `backend/src/superTabs/overdueDecisions.ts`, new `decisionSweep.test.ts`, `backend/src/worker.ts`, `sweeps.ts`.
**Interfaces:** `startDecisionSweep(run, everyMs=60_000): stop`; singleton worker starts/stops it alongside hourly maintenance.

- [ ] Commit timer tests with fake clock: immediate pass, one-minute pass, no overlap, failure recovers visibly, stop removes future wakes.
- [ ] Run new test and observe missing scheduler.
- [ ] Separate decision schedule from hourly maintenance, wire worker shutdown and preserve loud failure reporting.
- [ ] Run affected scheduler/decision tests, focused integrations/typecheck, record timing/red-green evidence, mark ready and request one independent review.
