# Own agent runs vs hosting Swarm agents: implementation plan

The Engineer implements this plan task by task, test first, on one branch, and opens one pull request. Nobody is asked to
choose an execution mode. Steps use checkboxes.

**Goal:** `people_working` and its returns count only agent turns a person's own sessions started. A Swarm agent's turn on
their Mac sets a separate hosting mark, counted once a day as `people_hosting`.

**Architecture:** A turn's agent is a Swarm agent when a live `SwarmAgent` row has the key `stableId(machineId, agentId)`,
or when the turn comes from a Mac's Team account, which runs only Swarm agents. `recordTurnStarted` picks the mark from
that, and `markActivity` writes it on the person's existing 10-day activity row. The rollup counts the new mark and keeps
it out of `worked`.

**Tech Stack:** TypeScript, Prisma on MongoDB, Vitest. Integration plans on `mongodb-memory-server`.

**Spec:** task #2574's brief.

## Global Constraints

- Same privacy as today: hashed subjects, 10-day expiry, staff kept apart, aggregates only.
- No change to presence or to the `active` mark.
- No migration: old rows simply have no hosting mark.
- Ships with the next backend release.
- PR body first line: `Requested by dee@autonomous.ai through Harness.`

## Review Focus

- A lookup that fails: credits neither mark, warns, and still counts the turn in the relay total.
- A removed Swarm agent's tombstone: reads as not a Swarm agent, since the session on the Mac is now only the owner's.
- The same session id on another machine: not a Swarm agent, since the key includes the machine.
- An old row with no `hosting` field: the rollup reads it as not hosting.
- A person with both kinds of turn in a day: marked for both, because the once-a-day memory keeps the two marks apart.

## Design

- **Growth:** one optional field on `product_usage_activity`, written only when true (about 13 bytes on an average 367-byte
  row). The existing 10-day TTL removes it, and `people_hosting` adds one row a day to `product_usage_totals`, which keeps
  its existing expiry. 1,255 activity rows and 461 KB in production on 2026-11-04.
- **Concurrency:** the same single-row upsert as every activity mark. Marks only ever set a field to true, so races agree.
- **Read cost:** one indexed `SwarmAgent` read by `[key, deleted]` per counted turn, returning one row. Team-account turns
  read nothing. Production has 10–12k turns a day, about 0.14 a second, and each already writes a relay total.
- **Scale:** at 10x, about 1.4 reads a second on an index of 1,374 rows. The metric that warns first is backend Mongo read
  latency. The rate cap per socket (`allowTurnWrite`) still bounds a looping machine.
- **Compatibility:** no client changes; the frame's `agentId` is what the backend already reads. Older pods during a rollout
  keep writing `worked`, which only prolongs today's behavior for those turns. `usage:daily` gains a `hosting` field.
- **Migration + rollback:** none needed. An old server ignores the field. Turns marked hosting while the new server ran stay
  uncounted as working for up to 10 days, and that is correct.
- **Audience:** aggregates only, read as the people totals are today. The mark carries no machine or agent.
- **Identity:** the mark is on the Mac's owner, as today, under the keyed pseudonym; hosting is the fact it now records.
- **Failure:** a failed lookup writes no mark for that turn and logs a warning without ids. The relay total still counts it.
- **Platforms:** backend only.

## Known limits

- Days marked before the release keep their inflated `worked`: old rows cannot be told apart. For 7 days after the release,
  returns compare an old cohort with a stricter later day, so working returns dip for a reason that is not behavior. Compare
  working returns only for cohorts that start after the release.
- A person's own session that they shared into a Swarm, and a Buddy, are live `SwarmAgent` rows, so their turns count as
  hosting. This errs toward a lower working number.
- A hosting-only row still counts in `people_active`, as the brief asks: no change to the active mark. In production, 3–7 rows
  a day have no surface at all, which bounds how many such people exist today.

---

### Task 1: The rollup counts hosting apart

**Files:**
- Modify: `backend/prisma/schema.prisma`, `backend/src/analytics/peopleCounters.ts`, `backend/src/analytics/dailyProductPeople.ts`, `backend/src/services/ProductUsagePeopleRollupService.ts`
- Test: `backend/src/analytics/peopleCounters.test.ts`, `backend/src/analytics/dailyProductPeople.test.ts`, `backend/src/services/ProductUsagePeopleRollupService.test.ts`

**Interfaces:**
- Produces: `ActivityMark.hosting?: boolean | null`, the metric `people_hosting`, and `hosting` on each `usage:daily` row.

- [x] Write failing tests: a hosting-only person is not working and counts in `people_hosting`; staff stay apart; a worked day followed by a hosting-only day is no D1 working return but is a D1 active return.
- [x] Run them and watch them fail; commit.
- [x] Add the field, the count, the rollup's select and the definitions; run them green; commit.

### Task 2: The mark and the turn path

**Files:**
- Modify: `backend/src/lib/productUsage.ts`, `backend/src/lib/dailyTracking.ts`, `backend/src/lib/adapterWs.ts`
- Test: `backend/src/lib/productUsage.test.ts`, `backend/src/lib/dailyTracking.test.ts`, `backend/src/lib/adapterRoutes.test.ts`, `backend/integration/workerIndexPlans.test.ts`

**Interfaces:**
- Consumes: the `hosting` field from Task 1.
- Produces: `markActivity(userId, now, { surface?, worked?, hosting? })`, `turnMark(machineId, agentId, team): Promise<{ worked: true } | { hosting: true }>`, `recordTurnStarted(userId, machineId, agentId, now, team = false)`.

- [x] Write failing tests for each Review Focus line, the Swarm-turn and own-turn cases, the adapter passing `team`, and the read's plan (`IXSCAN` on `key, deleted`).
- [x] Run them and watch them fail; commit.
- [x] Implement; run them green; commit.
- [x] Run `npm test`; post red/green in a PR comment; mark the PR ready; add one review step.
