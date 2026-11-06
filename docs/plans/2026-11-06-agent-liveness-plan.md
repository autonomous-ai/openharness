# Automatic liveness for every project worker

> Execute task by task in this Engineer session, test first, with one independent PR review.

**Goal:** Recover lost work, nudge stalled workers and decide idle worker retention without waiting for the PM.

**Architecture:** Extend dispatch eligibility and the existing 2-hour nudge/3-hour return clocks beyond crew. Continue using transactional work.assign and its account/access checks. Include the prior attempt's result and pushed PR ref in reassignment. Restore host-confirmed idle stops for non-crew Engineers; keep Reviewers/Testers and standing crew.

**Tech Stack:** TypeScript, Vitest; existing state records and backend worker.

**Spec:** Task #3592, inventory Table A #1, Dee's 2026-11-06 decision that checkable rules run as code.

## Global Constraints

- No new refusal codes, database queries, dependencies or direct process termination.
- Keep PMs, Buddies, paused projects, pending deliveries, active work, person/review/CI waits, access boundaries and dirty-folder stop refusal safe.
- Standing crew keep the sleep/wake lifecycle; the PM is being asked to confirm this against the brief's idle-stop wording.
- Local validation is affected tests only; full backend unit and Super Tab suites run in PR CI under project instructions.

## Review Focus

- A lost task cannot return immediately to its failed agent, including through a stale pin.
- Reassignment must carry the latest available pushed PR ref, revision and prior result; no invented branch when none is recorded.
- Every non-crew worker gets the same clocks; work waiting on a person or an open step gets neither a nudge nor a timeout from those clocks.
- Idle stops preserve the host's dirty-folder refusal path; Reviewer/Tester and crew retention must not change account access.
- Existing background worker applies decisions while the PM is hung; its notices tell the PM what happened.

## Task 1: Dispatch and handoff

**Files:** `backend/src/superTabs/dispatch.ts`, `dispatch.test.ts`, `commands.ts`.

**Interfaces:** Keep `freeCrew`, `candidatesFor`, `dispatchPlan` signatures; extend eligibility to ordinary project workers using roleNameOf and known task area. Add a test-local scenario invoking real work.assign to check the delivered handoff.

- [ ] Write tests: non-crew Engineer takes lost work; unavailable/failed workers, other projects, stopping agents and protected roles are excluded; stale pins cannot hand it back; assignment includes prior result, PR URL/ref and watched head.
- [ ] Commit tests and run `npm test -- src/superTabs/dispatch.test.ts`; observe missing dispatch/handoff failures.
- [ ] Broaden dispatch eligibility, preserve existing work.assign checks, and append recovery context only for reassigned lost work.
- [ ] Run dispatch tests and commit the passing implementation.

## Task 2: Clocks for all workers

**Files:** `backend/src/superTabs/dispatch.ts`, `dispatch.test.ts`, `liveness.ts`, `liveness.test.ts`.

**Interfaces:** Keep `crewClock(group, worker, assignment, now, rules)`; nudge delivery uses every worker, excluding PMs/Buddies and genuine waits.

- [ ] Add/adjust tests for non-crew nudge once at 2 hours, reset after progress, return at 3 hours, step/person/blocked/review waits and information-only PM notices.
- [ ] Commit and run focused dispatch/liveness tests to see non-crew cases fail.
- [ ] Remove crew-only clock/nudge filters, retain loss fencing and wait checks, and mark PM notices informational.
- [ ] Run affected dispatch/liveness tests and commit.

## Task 3: Idle decisions and PM guidance

**Files:** `backend/src/superTabs/tidy.ts`, `tidy.test.ts`, `model.ts` comments, `pmSchedule.ts`, `pmSchedule.test.ts` as needed.

**Interfaces:** `idleNotices` still returns informational notice drafts; it also records host-confirmed idle stops for Engineers using workDecision, releaseId and idleStop. Existing crew keeper handles sleep/wake.

- [ ] Add failing tests for automatic stop, repeat-pass idempotence, dirty-folder refusal metadata, Reviewer/Tester retention, active work/delivery/usage-limit protection and paused-state safety.
- [ ] Commit tests, run tidy tests and observe missing automatic stop/retention failures.
- [ ] Implement decisions with existing fields, preserve protections, and replace the PM's hand-on/stop instructions with information-only guidance.
- [ ] Run changed test files plus directly affected command/step/worker tests, record evidence, push and mark ready for one independent review. No new suite run after equivalent green CI.
