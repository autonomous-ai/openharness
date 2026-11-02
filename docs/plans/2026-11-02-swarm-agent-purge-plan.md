# Swarm agents: a live-agent index and a purge of old tombstones Implementation Plan

Task #2150, asked for by Ken on 2026-11-02 from his production database profile (Atlas primary, 10:50-12:38 UTC, backend
v1.3.86). Written by the writing-plans skill, implemented by this project's Engineer in this session, test first; no
execution handoff.

**Goal:** `SwarmAgent` reads of a Swarm's live agents examine only live agents, and removed agents' tombstones stop
piling up.

**Architecture:** a `[tabId, deleted]` index serves `findMany({ tabId, deleted: false })` (parts/light.ts:88, load.ts,
read/host.ts). The hourly sweep deletes an agent tombstone past its `purgeAt` instead of compacting it for good, unless an
open conversation or a live start still names the agent; those are compacted and checked again a day later. An agent added
again after its tombstone is gone starts above its stored configuration revisions, so versions still never go back
(postmortem 2026-10-27 D6). A one-release startup step gives the tombstones compacted before this change a purge time.

**Tech Stack:** TypeScript, Prisma on MongoDB 7, vitest with a loopback `MongoMemoryReplSet` and Mongo's profiler.

**Spec:** the task brief (#2150): index `{tabId, deleted}`; purge deleted agents past `purgeAt` in batches, never one still
referenced by an open group or a record that needs it; tests for the read and the purge; prod slow logs before and after.

## Global Constraints

- Creating the production index is a production write: it runs only with Ken's go (the worker's schema step builds it
  when the release deploys).
- Measurements use the read-only production login only, from its environment file, never printed.
- The purge deletes data: two independent security reviews before merge.
- Full Super Tab integration suite (`npm run test:super-tabs`) before Ready.
- A tombstone is deleted only after `purgeAt` (removal + `RETENTION_MS`, 7 days): a change cursor that old reloads
  (read/cursor.ts), so no reader misses the removal.

## Review Focus

- Versions never go back (postmortem 2026-10-27 D6, design ruling 6). Agent tombstones were kept for good so a key
  added again continues above its old version: an agent's key is `stableId(machineId, harnessId)`, so a reopened session
  comes back under it. Deleting the tombstone loses that version. What stores and orders by it is
  `SuperTabConfiguration.revision` ("ordered by the agent part's version", store.ts); clients drop a removed part and
  merge by version only while they hold it (cli partsStore.ts), and a cursor older than the 7 days reloads. So an agent
  inserted with no row starts above its newest configuration revision (Task 2). Reviewers: check nothing else persists
  an agent's version across its removal.
- An agent added again while the sweep deletes its tombstone: the add must not reset its version or be lost. Pinned by the
  re-add test in Task 2 and the guarded delete in Task 3 (the same due match on the delete).
- A tombstone named by a conversation's Lead or assignee but not in `agentIds`: kept. Pinned in Task 3.
- A Swarm with no live agents or only tombstones: the read returns none and still uses the index. Pinned in Task 1.
- A tombstone kept for a reference must not be read every hour forever: its next check is a day later. Pinned in Task 3.
- Members' and machines' tombstones keep today's compaction. Pinned by the updated sweep plans test in Task 3.

## Design

- growth: agent tombstones go 7 days after removal (`purgeAt`); one named by an open conversation or a live start is
  compacted and checked again each day, so it goes once those end. Members and machines keep today's compacted tombstones.
- concurrency: no new lock. The delete repeats the due match (`deleted: true, purgeAt < now`), so a tombstone revived
  since the read stays; a revival that read the tombstone before the delete hits `PartConflict` and runs again on the
  new state.
- read cost: the live-agent read examines only live agents through `[tabId, deleted]` (before: 1,070 examined for 40
  returned in production). The sweep reads only due tombstones through the purge index, then for each Swarm with due
  ones its open conversations naming them (`dormancy` index) and its starts naming them (`[tabId, agentId]`).
- scale: at 10x agents per Swarm the read stays at its live count; the first warning is the read's examined/returned
  ratio in the slow log, and the sweep's `agentTombstones.kept` count in the worker log.
- compatibility: clients merge by version and drop a removed part (cli partsStore.ts); a re-added agent after a purge
  arrives as a new part. A cursor older than 7 days reloads, as for conversations.
- migration + rollback: the release builds one index; a rollback leaves it (harmless) and old code compacts the rest.
  Deleted tombstones do not come back: a re-added agent still starts above its configuration revisions.
- audience: N/A because no read or endpoint changes who sees what; the sweep runs in the singleton worker.
- identity: N/A because no login is used; the sweep acts as the worker.
- failure: the sweep logs its counts and any failure (`[swarm-sweeps]`); the startup step logs how many it queued.
- platforms: backend only.

---

### Task 1: The live-agent index

**Files:**
- Modify: `backend/prisma/schema.prisma` (model `SwarmAgent`)
- Create: `backend/integration/swarmAgentTombstones.test.ts`
- Modify: `backend/vitest.super-tabs.config.ts` (add the file)

**Interfaces:**
- Produces: index `@@index([tabId, deleted])` on `SwarmAgent`, Mongo key `{ tabId: 1, deleted: 1 }`.

- [ ] **Step 1: Write the failing test** `the live-agent read uses the [tabId, deleted] index`: a Swarm made by
  `SuperTabStore.create`, 40 live agents and 1,000 removed ones in it, 200 live in another Swarm. Profile
  `loadDeliveryParts(db, tabId, [], [])`; the `SwarmAgent` read's `planSummary` matches `IXSCAN { tabId: 1, deleted: 1 }`,
  `docsExamined` is 40, and the returned agents' keys are the 40 live ones. A second case: a Swarm of tombstones only
  returns none, through the same index.
- [ ] **Step 2: Run it and watch it fail:** `npx vitest run --config vitest.super-tabs.config.ts integration/swarmAgentTombstones.test.ts`;
  expected: another index, ~1,040 examined.
- [ ] **Step 3: Add `@@index([tabId, deleted])` to `SwarmAgent`**, with a `///` line naming the reads it serves.
- [ ] **Step 4: Run it and watch it pass.**
- [ ] **Step 5: Commit** the test first, then the schema.

### Task 2: A re-added agent starts above its configuration revisions

**Files:**
- Modify: `backend/src/superTabs/parts/write.ts` (`guardedWrite`, insert with no prior row)
- Test: `backend/integration/swarmAgentTombstones.test.ts`

**Interfaces:**
- Produces: an agent inserted with no row starts at `max(write.first ?? 1, newest SuperTabConfiguration.revision of
  (tabId, agentId) + 1)`.

- [ ] **Step 1: Failing test** `an agent added again after its tombstone is gone starts above its configuration revisions`:
  configuration rows for agent `a` at revisions 500 and 900, no `SwarmAgent` row; `guardedWrite` an insert with `first: 1`
  in a transaction; the stored version is 901. An agent with no configuration rows starts at `first`.
- [ ] **Step 2: Watch it fail** (version 1).
- [ ] **Step 3: Implement**: for `kind === 'agent'`, read the newest revision with an `aggregateRaw` `$match { tabId,
  agentId }`, `$sort { revision: -1 }`, `$limit 1` (the `[tabId, agentId, revision]` index).
- [ ] **Step 4: Watch it pass.** **Step 5: Commit** test, then code.

### Task 3: The hourly sweep purges agent tombstones

**Files:**
- Create: `backend/src/superTabs/agentTombstones.ts`
- Modify: `backend/src/superTabs/sweeps.ts` (`compactTombstones` leaves agents; `sweepSwarms` adds `agentTombstones`)
- Modify: `backend/integration/swarmSweepPlans.test.ts` (agents are no longer compacted)
- Test: `backend/integration/swarmAgentTombstones.test.ts`

**Interfaces:**
- Produces: `purgeAgentTombstones(db: PrismaClient, now: number): Promise<{ purged: number; kept: number }>` and
  `AGENT_RECHECK_MS = 86_400_000`; `sweepSwarms(...).agentTombstones`.

- [ ] **Step 1: Failing tests:**
  - `purges only agent tombstones past their purge time`: due unnamed tombstones are gone; a not-yet-due one keeps its data
    and purge time; live agents are untouched; another Swarm's due one goes too.
  - `keeps a tombstone an open conversation or a live start names`: named in `agentIds`, as `leadId`, as the assignee, and
    by a live start: kept with `data: {}` and `purgeAt = now + AGENT_RECHECK_MS`; named only by a dormant or removed
    conversation, or a removed start: purged. A second sweep at the same time reads none of the kept ones.
  - `reads due tombstones by the purge index`: the profiled `SwarmAgent` read is `IXSCAN { purgeAt: 1 }` and examines only
    due rows; the conversation read names the `dormancy` index.
  - `swarmSweepPlans`: `tombstonesCompacted` counts members and machines only (4) and `agentTombstones.purged` is 2.
- [ ] **Step 2: Watch them fail.**
- [ ] **Step 3: Implement** in batches of 500 by the purge index (`readBy(db, 'SwarmAgent', 'purge', ...)`), grouped by
  Swarm; named keys from `groupsBy(db, 'dormancy', [{ $match: { tabId, deleted: false, dormant: false, $or: [agentIds,
  data.leadId, data.assignment.agentId in keys] } }])` and live starts by `readBy(db, 'SwarmStart', 'agents', ...)` on
  `{ tabId, agentId: { $in }, deleted: false }` (a new named index: unnamed, Mongo planned it on `[deleted, finishedAt]`). Delete the rest with `delete` repeating the due match; compact the named ones with `update`, same match.
- [ ] **Step 4: Watch them pass.** **Step 5: Commit** tests, then code.

### Task 4: Tombstones compacted before this change get a purge time

**Files:**
- Modify: `backend/src/superTabs/agentTombstones.ts` (`requeueCompactedAgents`)
- Modify: `backend/src/worker.ts` (run once at startup, logged; "remove in the release after the one that runs it")
- Test: `backend/integration/swarmAgentTombstones.test.ts`

**Interfaces:**
- Produces: `requeueCompactedAgents(db: PrismaClient, now: number): Promise<number>`.

- [ ] **Step 1: Failing test** `gives tombstones compacted before the purge a purge time`: compacted agent tombstones
  (`deleted: true, purgeAt: null`) get `purgeAt = now`; live agents and member tombstones are untouched; the next sweep
  purges the unnamed ones. The update reads each agent at most once (no index leads with `deleted`; about 1,300 agents in
  prod), once per worker start for one release.
- [ ] **Step 2: Watch it fail.** **Step 3: Implement** one `update` `{ deleted: true, purgeAt: null }`. **Step 4: Watch it pass.** **Step 5: Commit.**

### Measurement

Before (now, v1.3.86) and after (the release with this change, once Ken creates the index), the same window length: the
slow log's `SwarmAgent` operations (count, seconds, examined per returned) and the collection's count of deleted rows,
through `scripts/atlas-snapshot.ts` and the read-only login. Results go in a PR comment.
