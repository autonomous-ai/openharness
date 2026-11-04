# One group read without the Swarm's change feeds: implementation plan

> Implemented by its Engineer task by task, test first (project instructions, Engineer role). No per-task review: the
> review steps on the pull request are the independent reviews.

**Goal:** `GET /api/super-tabs/:tabId/groups/:conversationId` reads that group by id and the few parts its permission check
needs, never the Swarm-wide changed-since feeds (task #2875). In Ken's report of 11-04 17:13–17:14 VN, ~1,500 of these
calls in two minutes each read `SwarmGroup {changedAt $gt}`, `SwarmMachine {readAt $gt}` and `SwarmProgress {changedAt $gt}`:
~1.33 GB and ~3,340 s of database time, Atlas CPU 93%, five pods to seven.

**Finding:** the route answers through `read/service.ts readGroup`, which runs the whole-Swarm read (`this.load`): the
cached base (`parts`, every active group, start and progress part) and the machines entry, each patched from the Swarm's
change feeds whenever its stamp moved (`cache.ts deltaFor`), then the reader's whole view (`readerView`) to pick one group
out. On the busiest Swarm (2,511 groups) a 30 s window of those feeds is ~54 KB of groups and ~189 KB of machine rows,
read again by every pod at every stamp a one-group read meets.

The CLI calls the route from two agent commands only (`cli/src/superTabs/service.ts readGroupAsAgent`): `task GROUP` for a
group that left the active set, and the route's history. A daemon's reconnect does not call it. ~1,500 calls in two minutes
of different groups is one agent reading many old tasks in a loop (the PM's sweeps, which revision 62 of the instructions
removed minutes later), so coalescing identical requests alone would not have helped: each call must be cheap.

**Architecture:**
- A cache entry `access` (`cachedReads.ts readAccess`) holds the Swarm's head, members and agents: what an actor and a
  group's read check need. Its patch rule reads its own kinds alone (`PatchRule.alone`): its delta is never widened to the
  group, machine and progress feeds of other entries, and theirs never include it.
- `oneGroup` reads the group by its key in one indexed read, its data only when its version moved since this process last
  read it (`parts/load.ts loadGroupUnless`, rows kept within 8 MB). For an agent reader it also reads its machine's
  account fields (`onTeamAccount`: host Mac and session kind) and, for an agent stored with no project (28 of 143 on
  prod), its active conversations, light (`agentProjectId`). No Lead conversation: `canReadGroup` never reaches
  `ledProject` here, since a group with an audience is a closed Chat with PM or a Buddy chat an agent reads only as its
  Buddy.
- From those parts it reassembles a state and runs the same checks the whole read runs: `author`, `canReadGroup`, the
  active path's known-kind and not-Leads filter, `groupForBuddy`, `groupView`, and for a person the served newest main row
  (`servedTops`). A task naming required machines (23 groups on prod) is answered by the whole read, as now: which machines
  its reader sees depends on every agent's project.
- Identical reads in flight on one pod (same Swarm, group, sign-in and agent) share one answer.

**Tech Stack:** TypeScript, Prisma `aggregateRaw`, the per-process read cache (`cache.ts`), MongoDB profiler in integration
tests, vitest.

**Spec:** task #2875 brief.

## Global Constraints

- Answers identical to today's for every reader and group: active, dormant, private, Buddy chat, Leads, closed Chat with
  PM, unknown kind, missing; refusals the same code and status.
- No index or schema change; no env switch. Swarm code stays out of `cli/src/core`.
- The cache's other entries and their deltas behave as before.

## Review Focus

- The read check runs on a state that holds every part it reads: head, members, agents, the group, the lead
  conversations, the agent's conversations, its machine. Anything else it reads would differ from the whole read.
- `PatchRule.alone`: a delta of its kinds only, shared only with entries of the same alone rule, and dropped on a bump.
- This changes the inputs of an access check: two security reviews (project rule).

## Design

- growth: N/A because nothing new is stored; the cache entry is one per Swarm, under the cache's byte budget.
- concurrency: N/A because it is a read; the cache's per-stamp single flight and the new in-flight sharing are per pod.
- read cost: one group by key (its data only when changed), the access entry (no read when current; a head/member/agent
  delta per stamp per process when stale), and for an agent one machine's account fields by id. No change feed of groups,
  machines or progress.
- scale: 10x calls is 10x single-row reads by index; 10x agents grows the access entry (~87 KB of agents on the busiest
  Swarm now). The first warning is `access` delta bytes in `swarm cache` stats.
- compatibility: N/A because the answer and the route are unchanged.
- migration + rollback: N/A because there is no data change; rollback restores the whole read.
- audience: the server enforces it with the same checks as the whole read, on the parts they read.
- identity: N/A (the caller's own sign-in and agent, checked as before).
- failure: a missing group or a refused reader is the same 404 as now; a cache without stamps reads Mongo directly.
- platforms: N/A (backend only).

## Task 1: Measure the one-group read's feeds (red)

**Files:** `backend/integration/superTabOneGroup.test.ts`, `backend/integration/bench/profile.ts`

- [x] After a write moves the stamp of a warm Swarm, profile one read of a dormant group as an agent and as a person:
      assert no `SwarmGroup`/`SwarmProgress` read by `changedAt` and no `SwarmMachine` read by `readAt`; record bytes
      (`responseLength`) and time. Watch it fail on main.
- [x] A burst: 1,000 reads of 100 groups by 10 agents, concurrent, with a write between every 100: total changed-since
      reads and bytes, before and after. Watch it fail on main.

## Task 2: Narrow cache entries (`PatchRule.alone`)

**Files:** `backend/src/superTabs/cache.ts`, `backend/src/superTabs/cachePatch.ts`, `backend/src/superTabs/cache.test.ts`

**Interfaces:** `PatchRule.alone?: true`; `accessRule` (kinds head, member, agent).

- [x] Failing unit test: a stale alone entry's delta asks for its kinds only, while a stale base entry is due; the base's
      delta does not take the alone entry's time.
- [x] Implement in `deltaFor` and `drop`.

## Task 3: The one-group read from its own rows

**Files:** `backend/src/superTabs/read/service.ts`, `backend/src/superTabs/cachedReads.ts`,
`backend/src/superTabs/parts/load.ts`, `backend/integration/superTabOneGroup.test.ts`

- [x] Equivalence test: for every reader and group of the full fixture, the answer equals the whole read's (first load's
      group, the dormant list's, or the same refusal).
- [x] Implement `readAccess`, `loadAccess` and the new `readGroup`; Task 1's tests pass.

## Task 4: Share identical reads in flight

**Files:** `backend/src/superTabs/read/service.ts`, `backend/integration/superTabOneGroup.test.ts`

- [x] Failing test: 50 identical concurrent reads make one group read.
- [x] Implement.
