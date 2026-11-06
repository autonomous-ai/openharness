# Project crew lanes implementation plan

> Implement task by task in this session, test first, followed by the required independent review.

**Goal:** Let each project choose its crew lanes and dispatch numbers in its existing rules record.

**Architecture:** Make policy.ts the source of seeded lanes and dispatch numbers. Existing indexed policy reads supply rules to command validation, task lane stamps, dispatch picks and liveness clocks; no policy transcript enters prompts or client state. Background dispatch honors each project's cadence, while work-change events still dispatch immediately.

**Tech Stack:** Existing TypeScript, Zod, Prisma/MongoDB and Vitest; no dependency, collection or index.

**Spec:** Task #3601; Dee 11-06: projects have different crews, including projects without mobile and projects with firmware.

## Global Constraints

- Seed lanes, in order: backend (backend/), CLI (cli/), Desktop (desktop/), mobile (mobile/), docs (docs/).
- Seed dispatch: everyMs 30000, maxHanded 3, nudgeAfterMs 7200000, returnAfterMs 10800000.
- crew.add and work.lane validate names case-insensitively against the target project's lanes; an empty new lane list disables named lanes. Existing access and Team boundaries hold.
- Legacy records missing dispatch numbers gain seed numbers; legacy empty unused lane tables retain the old five-lane behavior. New records explicitly storing dispatch and an empty list keep it empty. No production backfill.
- Commit failing tests before each implementation. Run affected checks only locally; full backend unit and integration suites belong to ready PR CI.
- No real CLI sign-out, production writes, process-name stops or cli/src/core changes. Temporary files only in mktemp folders.

## Design

- **Growth:** Reuse the 16 KiB policy record and its 50-revision retention. Four scalar numbers and the existing bounded lane list; no new persistent state. Background cadence memory is bounded and expires.
- **Concurrency:** Existing rules-revision transaction serializes saves. Automatic work.assign rereads the policy inside its assignment transaction, so a changed lane/cap cannot use a stale outside pick. A rules save refreshes loaded task lane stamps atomically with its record.
- **Read cost:** Existing newest-policy index (tabId/projectId/revision), no query shape/index change. Rare lane/crew/task-definition commands read one project's policy. Worker clock passes read relevant project policies once per pass (at most 100 projects); pure functions consume that lookup. No read computes lane labels from a global fixed table after a new stamp.
- **Scale:** Lists remain capped at 50 lanes/50 owned paths and 100 projects per Swarm. Validate bounds and measure indexed policy reads on loopback. The required read-only production environment is absent on this Team machine; production count/size/growth measurements are unavailable.
- **Compatibility:** Lane strings remain strings; crew's existing lowercase values keep working. Missing additive dispatch fields normalize to today's behavior. Old clients may still submit their old record shape; no new mandatory wire field.
- **Migration/rollback:** No schema migration or backfill; normalize old JSON on read/save. Rollback ignores numbers; old code resumes its fixed lanes. Saved custom lanes remain in the record for re-upgrade.
- **Audience/identity:** Preserve rules-save ownership/person-message checks and crew/work access checks. Rules cannot cross project/account boundaries. Invalid saved policy fails visibly rather than silently dispatching with defaults.
- **Failures/platforms:** Named unknown-lane refusals list that project's choices. Configured numbers appear in nudge/return text. Background cadence is checked on the existing 30-second host sweep (minimum 30 seconds); no new polling timer. Shared backend behavior for all platforms.

## Review Focus

- A second project must not inherit another project's lanes or dispatch numbers (Tasks 1/2).
- Removing a lane must prevent both new crew marks and work.lane, including case variants; old marks cannot keep receiving removed-lane work (Task 2).
- A lane/cap changed between planning and assignment must invalidate the pick (Task 2).
- Legacy empty lane records must keep their old behavior while a new explicit empty list stays empty (Task 1).
- Custom nudge/return times and periodic cadence must be used consistently; real waits and event-triggered dispatch retain their behavior (Task 3).

### Task 1: Seed and normalize project dispatch policy

**Files:** policy.ts, policyStore.ts, policy.test.ts; focused project-rules integration.
**Interfaces:** ProjectRules.dispatch {everyMs, maxHanded, nudgeAfterMs, returnAfterMs}; existing lanes list. Bounds: everyMs 30000–3600000, maxHanded 1–1000, nudgeAfterMs 60000–604800000, returnAfterMs at most 1209600000 and greater than nudgeAfterMs. Missing dispatch uses seed values.

- [x] Commit tests for exact seed behavior, custom firmware/no-mobile lists, duplicate/invalid names and invalid clock/cap ranges; old missing dispatch with empty lanes versus new explicit empty list.
- [x] Run affected policy tests and see missing seed/numbers failures.
- [x] Add schema/defaults and normalized indexed policy reads; keep history readable and size bounds intact.
- [x] Run policy tests and focused rules persistence/index integration, commit and push.

### Task 2: Validate and dispatch using each project's lanes

**Files:** dispatch.ts, crew.ts, model.ts, commands.ts, store.ts, read/views.ts; crew/dispatch tests and integration/crewDispatch.test.ts.
**Interfaces:** DispatchRules is the numeric policy plus lanes; stampLane(group, lanes), addCrew accepts string lanes validated against passed policy. CommandContext.projectRules carries the target project's current record. Store assignment revalidation reads currentRules in the transaction.

- [x] Commit command/store regressions: firmware lane works and dispatches; removed mobile refused on crew.add and work.lane; other project keeps seeded mobile; stale lane/cap pick refused; rules saves update labels.
- [x] Watch expected failures in affected tests.
- [x] Replace global enum validation with project validation; read the policy for relevant commands, stamping and dispatch; preserve crew lowercase compatibility and all access checks.
- [x] Run changed/importer tests, transactional dispatch integration and typecheck; commit and push.

### Task 3: Use project clocks and periodic cadence

**Files:** liveness.ts, dispatch.ts, store.ts; liveness/dispatch tests and integration/crewDispatch.test.ts.
**Interfaces:** DispatchLookup(projectId) returns the pass's validated DispatchRules; liveness entrypoints accept it with seeded defaults for pure callers. dispatchCrew(tabId, periodic=false) applies bounded per-project cadence only on periodic passes. Debounced event requests upgrade a pending periodic pass to immediate.

- [ ] Commit tests for custom nudge/return thresholds and wording, two projects with different clocks, configured periodic interval, and event requests bypassing/upgrading periodic gating.
- [ ] Run focused tests and confirm fixed-number behavior fails.
- [ ] Load project policy once per pass, thread the lookup through clock decisions, and use bounded expiry memory for periodic dispatch; no extra timer.
- [ ] Run affected unit/integration/typecheck and query-plan checks. Record limits, red/green and timings; mark ready for CI and independent review.

## Evidence

- Task 1 red: `6f5666e84` fails 2 policy tests (25 pass) and the focused stored-legacy integration. Green: all 27 policy tests and all 6 project-rules integrations pass, including the existing indexed history query and explicit empty list. Backend typecheck clean. No new query/index or backfill.
- Task 2 red: `deb068ac8` fails the custom crew test (8 pass) and all four new dispatch integrations (14 unrelated skipped). Green: 74 policy/crew/dispatch unit tests, 604 affected importer unit tests across seven files, all 18 crew-dispatch integrations and backend typecheck pass. Custom firmware, no mobile, updated stamps, old marks, and lane/cap changes between planning and transaction are covered.
