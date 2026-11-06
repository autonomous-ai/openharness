# Automatic liveness for every project worker

> Execute task by task in this Engineer session, test first, with independent PR reviews.

**Goal:** Recover lost work, nudge stalled workers and decide idle worker retention without waiting for the PM.

**Architecture:** Extend dispatch eligibility and the existing 2-hour nudge/3-hour return clocks beyond crew. Continue using transactional work.assign and its account/access checks. Point to the prior attempt’s attributed status and include its pushed PR ref in reassignment. Restore host-confirmed idle stops for non-crew Engineers; keep Reviewers/Testers and standing crew.

**Tech Stack:** TypeScript, Vitest; existing state records and backend worker.

**Spec:** Task #3592, inventory Table A #1, Dee's 2026-11-06 decision that checkable rules run as code.

## Global Constraints

- No new refusal codes, database queries, dependencies or direct process termination.
- Keep PMs, Buddies, paused projects, pending deliveries, active work, person/review/CI waits, access boundaries and dirty-folder stop refusal safe.
- Standing crew keep the sleep/wake lifecycle; the PM is being asked to confirm this against the brief's idle-stop wording.
- Local validation is affected tests only; full backend unit and Super Tab suites run in PR CI under project instructions.

## Review Focus

- A lost task cannot return immediately to its failed agent, including through a stale pin.
- Reassignment must carry the latest available pushed PR ref and revision, with a pointer to the attributed prior status; no invented branch when none is recorded.
- Every non-crew worker gets the same clocks; work waiting on a person or an open step gets neither a nudge nor a timeout from those clocks.
- Idle stops preserve the host's dirty-folder refusal path; Reviewer/Tester and crew retention must not change account access.
- Existing background worker applies decisions while the PM is hung; its notices tell the PM what happened.

## Task 1: Dispatch and handoff

**Files:** `backend/src/superTabs/dispatch.ts`, `dispatch.test.ts`, `commands.ts`, `reviewerPick.test.ts`.

**Interfaces:** Keep `freeCrew`, `candidatesFor`, `dispatchPlan` signatures; extend eligibility to ordinary project workers using roleNameOf and known task area. Add a test-local scenario invoking real work.assign to check the delivered handoff.

- [x] Write tests: non-crew Engineer takes lost work; unavailable/failed workers, other projects, stopping agents and protected roles are excluded; stale pins cannot hand it back; assignment points to the prior status and includes PR URL/ref and watched head.
- [x] Commit tests and run `npm test -- src/superTabs/dispatch.test.ts`; observe missing dispatch/handoff failures.
- [x] Broaden dispatch eligibility, preserve existing work.assign checks, and append recovery context only for reassigned lost work.
- [x] Run dispatch tests and commit the passing implementation.

## Task 2: Clocks for all workers

**Files:** `backend/src/superTabs/dispatch.ts`, `dispatch.test.ts`, `liveness.ts`, `liveness.test.ts`.

**Interfaces:** Keep `crewClock(group, worker, assignment, now, rules)`; nudge delivery uses every worker, excluding PMs/Buddies and genuine waits.

- [x] Add/adjust tests for non-crew nudge once at 2 hours, reset after progress, return at 3 hours, step/person/blocked/review waits and information-only PM notices.
- [x] Commit and run focused dispatch/liveness tests to see non-crew cases fail.
- [x] Remove crew-only clock/nudge filters, retain loss fencing and wait checks, and mark PM notices informational.
- [x] Run affected dispatch/liveness tests and commit.

## Task 3: Idle decisions and PM guidance

**Files:** `backend/src/superTabs/tidy.ts`, `tidy.test.ts`, `model.ts` comments, `pmSchedule.ts`, `pmSchedule.test.ts` as needed.

**Interfaces:** `idleNotices` still returns informational notice drafts; it also records host-confirmed idle stops for Engineers using workDecision, releaseId and idleStop. Existing crew keeper handles sleep/wake.

- [x] Add failing tests for automatic stop, repeat-pass idempotence, dirty-folder refusal metadata, Reviewer/Tester retention, active work/delivery/usage-limit protection and paused-state safety.
- [x] Commit tests, run tidy tests and observe missing automatic stop/retention failures.
- [x] Implement decisions with existing fields, preserve protections, and replace the PM's hand-on/stop instructions with information-only guidance.
- [x] Run changed test files plus directly affected command/step/worker tests, record evidence, push and mark ready for independent review. No new suite run after equivalent green CI.


## Task 4: Persisted dispatch and integration expectations

**Files:** `backend/src/superTabs/store.ts`, `backend/integration/crewDispatch.test.ts`, `backend/integration/superTabTidy.test.ts`.

**Interfaces:** Preserve the store dispatch API and timer coalescing. A write opening work schedules dispatch when any project worker exists, even with no crew. Lost Review/Test steps use the existing independent candidate selector.

- [x] Commit a failing integration test showing an ordinary Engineer receives no automatic assignment when the project has no crew.
- [x] Broaden the write trigger from crew to workers; preserve transactional revalidation when an agent starts stopping during the pass.
- [x] Update prior crew-only and notice-only integration expectations to the new behavior.
- [x] Run the two affected integration files, affected unit tests and backend typecheck; record red/green and hot-path timings in the PR.

## Data and rollout

Existing assignment, lost-attempt, release and idle-stop fields are reused: no new collection, index, query, stored history or migration. The existing transaction/operation receipt fences concurrent assignment; the host's release identity fences stale stops. Current clients already understand these fields. Backend deploy enables the decisions; reverting the backend restores notice-only non-crew idle handling. Any stop already requested remains host-confirmed and can be refused for dirty work. No client release is needed; behavior applies to macOS, Linux and Windows hosts. Existing source/account checks remain authoritative and the PM receives informational loss/idle notices.

The store uses its existing delta loads and capped dispatch attempts; no new polling or database read is added. The existing liveness/dispatch notices and state expose progress and unavailable capacity. Benchmarks compare dispatch and liveness on the same 2,000-task workload; full suites run once in PR CI.

## Final review scope

Although the brief requests one review, project instructions require two independent security reviews for cleanup or anything deleting data. Automatic idle stops reach the existing host worktree cleanup path, so two independent security reads must verify dirty-folder refusal, stop identity, PM/Buddy protection, paused projects and account boundaries before merge. They also review all acceptance cases; a separate third general review is unnecessary.


## Review fixes

- [x] Ordinary Engineers receive only lost tasks with a recorded lost attempt or tasks pinned to them. New tasks remain with standing crew lanes and the PM’s route. Test 2c58b2b84 fails before c030d0825 fixes it; existing lost-step eligibility remains unchanged.
- [x] Never copy an earlier agent’s free-text result into a system-authored recovery brief. Reference its attributed status in the task conversation; retain verified PR references. Tests 4f8f0debe fail before the fix.
- [x] Re-run directly affected dispatch/command/candidate tests and dispatch integration; request confirmation of the revised head from the same two reviewers.

- [x] Reproduce CI’s five host-form failures with the focused integration group. Refresh only its unrelated running-task fixture’s progress timestamp; 19 host-form tests pass, preserving real 3-hour timeout behavior.
