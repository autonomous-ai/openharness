# A Late Coordinator Start Never Joins Implementation Plan

> **How this is worked:** by the project's instructions, task by task, each failing test committed before its code.

**Goal:** A coordinator start that finishes after a person set another coordinator never joins the project chat, says why and leaves a row. The PM switch keeps working.

**Architecture:** `agent.started` for a start with `leadFor` checks the project chat once the start's identity checks have passed. With a live coordinator there, it creates no agent, fails the start with the reason, forgets the placement and writes a system row. The command succeeds so the row is kept (a refusal rolls its write back), and its result says `refused`. The host closes the session it just created.

**Tech Stack:** TypeScript, Vitest, real Mongo for the integration suite.

**Spec:** Task #2248 (Ken), named by both security reviews of #2636 (Luna, Echo).

## Global Constraints

- The PR body starts with: `Requested by ken15@autonomous.ai through Harness.`
- Two security reviews: Luna and Echo. Full Super Tab integration suite before Ready.
- Never test a PM switch live on River's project: tests only.
- Swarm code stays out of `cli/src/core`. No env switch.

## Review Focus

1. A forged or stale report can't remove anyone: the check runs after the start's grant checks, and it only ever refuses the start.
2. A coordinator that left the chat doesn't block: a start takes over, as before.
3. The session the host closes is the one this start's own create returned, and nothing else.
4. A replayed `agent.started` after the refusal fails as any failed start does, and writes no second row.
5. The row names a machine, so a Buddy reads it without the name (`store.ts withoutMachineNames`).

## Design

- **Growth:** N/A because it adds one row per refused start, and a start can only be refused once.
- **Concurrency:** written in the start's own command on the project chat's group. A hand-set racing it retries on fresh state, and whichever lands second sees the first.
- **Read cost:** N/A because it reads only what the command has loaded.
- **Scale:** N/A because a project has at most one coordinator start at a time.
- **Compatibility:** an older CLI gets a success with no agent, leaves the session idle with no access to the Swarm, and reports nothing wrong. Only a newer CLI closes it.
- **Migration and rollback:** none. Rolling back restores the second agent.
- **Audience:** the server enforces it; no client decides.
- **Identity:** the host's grant for this start, as today.
- **Failure:** a failed close leaves the session idle, and the host says so in its answer. Its worktree stays until the machine's cleanup.
- **Platforms:** N/A beyond the close, which uses the same daemon call on all platforms.

---

### Task 1: The server refuses the late join

**Files:**
- Modify: `backend/src/superTabs/leadStart.ts`, `backend/src/superTabs/commands.ts`
- Test: `backend/src/superTabs/leadStart.test.ts`

**Interfaces:**
- Produces: `leadOvertaken(state, start, home): string | null`; `agent.started` result `refused?: string`.

- [ ] **Step 1: Write the failing tests:** a start finishing after a person set a coordinator makes no agent, keeps the chat's coordinator and members, leaves one row, and fails the start with the reason; the placement is gone; a replay fails and adds no row; a start after the coordinator left still takes over; a first start still joins; `lead.switch` still works on the coordinator.
- [ ] **Step 2: Run them:** `npm test -- src/superTabs/leadStart.test.ts` in `backend`. Expected: the refusal tests FAIL, and the others pass.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 2: The host closes the session

**Files:**
- Modify: `cli/src/superTabs/start.ts`
- Test: its spec

**Interfaces:**
- Consumes: `refused` from Task 1.

- [ ] **Step 1: Write the failing test:** a join answered `refused` closes that session and returns the reason, with no model switch; a normal join closes nothing.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit, run `npm run test:super-tabs`, mark the pull request ready** and ask Luna and Echo.
