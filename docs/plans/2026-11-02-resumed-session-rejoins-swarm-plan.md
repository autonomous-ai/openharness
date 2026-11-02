# A reopened session rejoins the Swarm Implementation Plan

> **Way of working:** by this project's instructions: each failing test committed before its code, then one independent review of the pull request.

**Goal:** When an agent removed because its session closed has that session reopened on its machine, it is listed again with its groups, role and configuration, by that machine's host alone.

**Architecture:** The removal keeps a record in the machine's own part. Only that machine's host sees which sessions are recorded, in its roster row. It lists a recorded session that runs again in its machine report, and that report's write restores the agent. The report is already authenticated as this machine's contributor, so no person or agent has a way to send this.

**Tech Stack:** TypeScript, Fastify, Prisma on MongoDB, Vitest integration tests with a real replica set.

**Spec:** Task #2131, a follow-up to #2569 (`docs/plans/2026-11-02-closed-agents-leave-list-plan.md`).

## Global Constraints

- PR body starts with: Requested by phamngochuy.1989@gmail.com through Harness.
- Two security reviews (who may add an agent): Cleo and Luna.
- Full Super Tab integration suite before Ready.
- Swarm code stays out of `cli/src/core`.
- A new field in a machine part goes through `parts/shape.ts` both ways, or it vanishes on load.
- Old hosts keep working: they send nothing new and their sessions simply don't rejoin by themselves.

## Departure from the brief

The brief says "a host-only command". This uses the machine report instead. A command goes through `applyCommand`, where every actor check would need an exception, and the report already proves the machine and its contributor, carries a generation, and writes that machine's part. There is less to attack, and nothing new to authorize.

## What #2569's close order means here

The removal also orders the host to close the session. A session reopened before that close is restored and the order dropped, as a person's add does. A session its Team account is held for is never restored, and the hold stands until its host confirms. A session that read a private chat keeps no record at all.

## Review Focus

- A person left the Swarm or rejoined, the machine's share was revoked, or the contribution is new: the record is dropped and nothing is restored.
- A private chat or a dormant, archived or deleted group in the record: the agent doesn't come back into it.
- A session someone asked to stop, or a confidential or Team-held one: no record, so it can't come back.
- The same session added by hand, or registered in another Swarm, in the meantime: no second agent, no restore.
- A report that lists a recorded session and is refused or retried: nothing half-restored, and a report never fails because a restore can't happen.

---

### Task 1: The removal keeps a record, on the machine's part

**Files:**
- Modify: `backend/src/superTabs/closedAgents.ts`, `model.ts`, `parts/types.ts`, `parts/shape.ts`, `migration/verify.ts`, `machines.ts`, `commands.ts`
- Test: `backend/integration/superTabLiveness.test.ts`, `backend/src/superTabs/parts/shape.test.ts`

**Interfaces:**
- Produces: `SuperTabState.removedSessions?: RemovedSession[]`, with `RemovedSession = { machineId; harnessId; agent: Agent; groupIds: string[]; leadOf: string[]; removedAt: number }`, and `REMOVED_KEPT = 50` per machine, `REMOVED_KEEP_MS = 30 days`.

- [ ] **Step 1: Write the failing tests:** `shape.test.ts` round-trips `removedSessions`; the record is not in any person's read of the Swarm; a stopped-by-request or confidential agent keeps none.
- [ ] **Step 2: Run to verify they fail.** Run: `npm test -- src/superTabs/parts/shape.test.ts`. Expected: FAIL, the field vanishes.
- [ ] **Step 3: Implement.** `removeClosedAgents` writes the record. Strip it in `model.ts`'s read copy, as `closingSessions` is. Drop a machine's records where its reservations go when it leaves.
- [ ] **Step 4: Run to verify they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 2: A report that lists a recorded session restores it

**Files:**
- Modify: `backend/src/superTabs/closedAgents.ts`, `store.ts` (`fullReading`), `read/hostRows.ts`, `read/contract.ts`
- Test: `backend/integration/superTabLiveness.test.ts`

**Interfaces:**
- Consumes: `RemovedSession` from Task 1.
- Produces: `restoreSessions(state, machineId, runningHarnessIds, now, elsewhere): Agent[]`, and the host row field `removedHarnessIds: string[]`.

- [ ] **Step 1: Write the failing tests:** `a removed agent whose session resumes is listed again with its group and role`; `another machine's report can't restore it`; each Review Focus refusal; `the record goes after 30 days`.
- [ ] **Step 2: Run to verify they fail.** Run: `npx vitest run --config vitest.super-tabs.config.ts integration/superTabLiveness.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `restoreSessions` and load the record's groups in `fullReading`, as the closed agents' are.
- [ ] **Step 4: Run to verify they pass, then** `npm run test:super-tabs`. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 3: The host lists a recorded session that runs again

**Files:**
- Modify: `cli/src/superTabs/machines.ts`
- Test: the spec beside it

**Interfaces:**
- Consumes: the row's `removedHarnessIds`.

- [ ] **Step 1: Write the failing test:** `a recorded session that runs again is listed running; a stopped or gone one isn't, and neither is one the row doesn't name`.
- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run src/superTabs/machines`. Expected: FAIL.
- [ ] **Step 3: Implement** in the report pass, next to `running`.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit.**

## Design

- **Growth:** at most 50 records per machine, oldest first. Deleted on restore, after 30 days, or when the machine leaves.
- **Concurrency:** in the report's own transaction, on the machine part it already writes, so a retry reads the record again.
- **Read cost:** none on a report with no recorded session running. Otherwise one read of the record's groups and one of other Swarms' registrations.
- **Scale:** at 10x the machine part's size warns first; 50 records at about 1 KB each.
- **Compatibility:** an old host ignores the new row field. An old backend sends none.
- **Migration and rollback:** none. A rollback ignores the field and shape drops it.
- **Audience:** the server restores only into open groups of the agent's own project, never a private chat; the record is left out of every person's read.
- **Identity:** the report is authenticated as the machine's contributor, and the record must match that contributor, membership generation, machine owner and share grant.
- **Failure:** a restore that can't happen drops the record and logs its reason by code; the report still succeeds.
- **Platforms:** all that report machines.
