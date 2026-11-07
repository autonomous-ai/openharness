# A POST command reads only the Swarm parts it touches: implementation plan

> This plan is carried out by the project's Engineer way of working (test first, task by task, one pull request), not
> subagent-driven-development. There is no execution handoff.

**Goal:** A common command (post, react, work.status, work.assign, conversation.create) and the crew dispatch pass it
schedules read no Swarm part collection whole, within per-command query and byte budgets on a prod-sized store (task #4368).

**Architecture:** Three causes, measured on a prod-sized store (60 machines, 60 agents, 200 conversations) with the
Mongo profiler. (1) Every command load (`parts/load.ts loadActive`) reads every live member, agent, machine and progress
part whole; only awake groups go through the held parts (`parts/held.ts`, #3146). (2) Before the command's own load,
`work.assign` and a Ready `work.status` load the whole Swarm again, once per GitHub pre-read (`pushOriginFor`,
`repositoryReachFor`, `pullRequestFilesFor`, `headsReadNow`), only to find one conversation and its project. (3) A write
that frees or opens work schedules `dispatchCrew`, which loads the whole Swarm too, billed to the POST route. The fix:
the held parts cover members, agents, machines and progress, listed from a covering index and read whole only when
changed; the pre-reads read the head and the named conversations alone; the dispatch pass's load is a command load, so
(1) fixes it.

**Tech Stack:** TypeScript, Prisma on MongoDB 7, vitest with mongodb-memory-server.

**Spec:** Task #4368's brief (Ken's prod scan 09:20 VN 2026-11-07: 28.2 queries, 1,156 KB, 1,274 ms DB time per POST
command; POST p95 1,080 ms against ≤ 475; Atlas CPU 45.8% against ≤ 40%).

## Global Constraints

- Backend only; ships as a backend hotfix.
- No production access: Ken's numbers and a local real store.
- Audience stays server-enforced: a narrower read never shows a person or agent more than before.
- No stale read that loses a write: a command works on exactly what a whole read in its transaction would return.
- Every query uses an index; a listing names its index (`parts/indexed.ts readBy`).

## Review Focus

- A part another server changed between two commands here: the next command sees the change (held compares version,
  changedAt and readAt in the command's own snapshot).
- A machine whose reading alone moved (`readAt`, not `changedAt`): read whole again, never served from what was held.
- A part removed and its key made again (version back to 1): `changedAt` differs, so it is read whole.
- A database without the new indexes yet (the release's schema step runs after a server starts): the listing runs
  without the hint and is still correct (`readBy` falls back).
- The held cap (32 MB per process): a Swarm let go reads cold, as before.

---

### Task 1: Per-command read budgets on a prod-sized store

**Files:**
- Create: `backend/integration/superTabCommandReads.test.ts`
- Modify: `backend/vitest.super-tabs.config.ts` (include it)

**Interfaces:**
- Produces: `wholeReads(entries: ProfileEntry[]): Record<string, number>` (a read of a part collection filtered on the
  Swarm alone that examines documents) and `measured(entries)` → `{ queries, kb, whole }`.

- [ ] **Step 1: Write the failing tests.** A Swarm of 60 machines, 60 agents, 200 conversations (a third dormant), on a
  store with prod's GitHub pre-read hooks answering at once. After one warm-up command, each of post, react,
  work.status, work.assign, conversation.create and a dispatch pass is profiled: `whole` is `{}`, and queries and KB
  stay within the budgets the PR records.
- [ ] **Step 2: Run** `npx vitest run --config vitest.super-tabs.config.ts integration/superTabCommandReads.test.ts`.
  Expected: FAIL, every command reading SwarmAgent, SwarmMachine, SwarmMember and SwarmProgress whole; work.assign three
  times.
- [ ] **Step 3: Commit** the failing test.

### Task 2: The GitHub pre-reads read the head and the named conversations alone

**Files:**
- Modify: `backend/src/superTabs/parts/load.ts` (new `loadGroupsByKey`)
- Modify: `backend/src/superTabs/store.ts` (`pushOriginFor`, `repositoryReachFor`, `pullRequestFilesFor`, `headsReadNow`)

**Interfaces:**
- Produces: `loadGroupsByKey(tx, tabId, keys: string[]): Promise<SwarmParts>`: the head and the live groups with these
  keys, dormant ones too; no other part.
- Produces: `SuperTabStore.factsLoad(tx, user, tabId, groupIds): Promise<Loaded>`: the Swarm row check `load` makes, then
  `loadGroupsByKey`, with each loaded step's task added the same way.

- [ ] **Step 1: Run Task 1's work.assign test.** Expected: FAIL with three whole reads of each kind.
- [ ] **Step 2: Implement.** Each pre-read loads through `factsLoad` with the conversation it names; what it computes
  (the repository URL, the task's and step's pull requests) is unchanged. They authorize nothing, before or after: the
  command's own load does.
- [ ] **Step 3: Run Task 1's tests and `integration/superTabGithub.test.ts`, `superTabReviewSteps.test.ts`,
  `superTabPullRequestEvents.test.ts`.** Expected: work.assign reads each kind whole once; the others pass.
- [ ] **Step 4: Commit.**

### Task 3: Held parts for members, agents, machines and progress

**Files:**
- Modify: `backend/prisma/schema.prisma` (a covering index per kind)
- Modify: `backend/src/superTabs/parts/indexed.ts` (`NAMED_INDEX.<collection>.held`)
- Modify: `backend/src/superTabs/parts/held.ts` (`HeldRead.machines` becomes `HeldRead.parts(tx, kind)`)
- Modify: `backend/src/superTabs/parts/load.ts` (`assemble`, `loadActive`, `loadObserved`)
- Modify: `backend/src/superTabs/store.ts` (`ensure`: its `allGroups` branch has no caller and goes)
- Test: `backend/integration/superTabHeldParts.test.ts`

**Interfaces:**
- Produces: `HeldRead.parts(tx, kind: 'member' | 'agent' | 'machine' | 'progress'): Promise<PartRow[]>`: the live parts
  of that kind, as `findMany({ where: { tabId, deleted: false } })` returns them, in key order.
- Indexes: `[tabId, deleted, key, version, changedAt]` on SwarmMember, SwarmAgent (replacing `[tabId, deleted]`, its
  prefix) and SwarmProgress; `[tabId, deleted, key, version, changedAt, readAt]` on SwarmMachine.

- [ ] **Step 1: Write the failing tests** in `superTabHeldParts.test.ts`: an agent another server changed, and a machine
  whose reading alone moved, are seen by the next command; the listing of each kind is an IXSCAN on its `held` index
  examining no document.
- [ ] **Step 2: Run them.** Expected: FAIL (the listing reads documents whole).
- [ ] **Step 3: Implement.** `loadActive` (allGroups too) lists each kind through the held read; groups as before. An
  `allGroups` read keeps the awake groups held and reads the dormant ones whole.
- [ ] **Step 4: Run Task 1's tests, `superTabHeldParts`, `superTabCommandLoads`, `superTabMachineReports`,
  `superTabIndexes`, `crewDispatch`.** Expected: PASS, no whole read on any common command.
- [ ] **Step 5: Commit.**
