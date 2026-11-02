# A Step Waiting For Its Engineer Is Not Lost Implementation Plan

> **How this is worked:** by the project's instructions, task by task, each failing test committed before its code.

**Goal:** A Review or Test step that has spoken to its task's Engineer stays with its agent while the Engineer fixes, and is moved as before once a newer head is ready and it stays quiet for 30 minutes.

**Architecture:** `waitingForRevision` in `liveness.ts` already holds a step's quiet time, but only a failed `work.check` starts it, and Reviewers now give their verdict as a post. So a post from the step's agent to the Engineer records when it was made. It holds the step while the Engineer isn't waiting on a review, and the Engineer's next Ready ends it through `revisionReady`, which already restarts the quiet time.

**Tech Stack:** TypeScript, Vitest, real Mongo for the integration suite.

**Spec:** Task #2241 (Ken): project instructions revision 27 tell a Reviewer or Tester to stay Working while the Engineer fixes its findings; 35 lost attempts in a day came from the timer.

## Global Constraints

- The PR body starts with: `Requested by ken15@autonomous.ai through Harness.`
- Swarm code stays out of `cli/src/core`. No env switch.
- A stopped session, an offline machine, a usage limit and a failing model still lose the task at once.
- Full Super Tab integration suite (`npm run test:super-tabs`) at the final head. Reviewer: Cleo.

## Review Focus

1. A step whose agent never wrote to the Engineer is moved as before.
2. A post while the Engineer is waiting on a review holds nothing: "starting now" and then silence still moves. So does a verdict the Engineer doesn't pick up within 30 minutes.
3. The Engineer's own posts and heartbeats start nothing (review of #2487).
4. A named limit: a Reviewer that writes to an Engineer who is working, then hangs with a live session, isn't moved until that Engineer's next Ready or the task ends. The PM's 30-minute read of open tasks still shows it.

## Design

- **Growth:** one number on an assignment, which goes with it.
- **Concurrency:** written in the post's own command, on the group that command already locks.
- **Read cost:** N/A because it reads nothing new; the check uses what's loaded.
- **Scale:** N/A because it adds one comparison per active step in a sweep.
- **Compatibility:** N/A because no client reads the field. An attempt from before this has none and behaves as before.
- **Migration and rollback:** none. Rolling back leaves an unused field.
- **Audience:** N/A because it's server-only and exposes nothing.
- **Identity:** the post's actor must be the step's own assignee, as the server knows it.
- **Failure:** the step shows as waiting on a revision, the state that already exists, so a hold is visible.
- **Platforms:** N/A because this is server code.

---

### Task 1: A post to the Engineer holds the step

**Files:**
- Modify: `backend/src/superTabs/liveness.ts`, `backend/src/superTabs/model.ts`, `backend/src/superTabs/commands.ts`
- Test: `backend/src/superTabs/liveness.test.ts`, `backend/src/superTabs/steps.test.ts`

**Interfaces:**
- Produces: `Assignment.toldEngineerAt?: number`; `toldEngineer(state, group, agentId, recipients, now): void`.

- [ ] **Step 1: Write the failing tests:** through commands, a Reviewer's post to the Engineer with the Engineer working isn't lost past 30 minutes; the same step, after the Engineer's next Ready and 30 quiet minutes, is lost; a post while the Engineer waits on review holds nothing; a step that never wrote is lost; a post to someone else holds nothing; the Engineer's own post holds nothing; a stopped session is still lost at once.
- [ ] **Step 2: Run them:** `npm test -- src/superTabs/liveness.test.ts src/superTabs/steps.test.ts` in `backend`. Expected: the hold tests FAIL, and the moved-as-before tests pass on main.
- [ ] **Step 3: Implement** `toldEngineer`, call it where a post renews its task, extend `waitingForRevision` and clear the field in `revisionReady`.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit, run `npm run test:super-tabs`, mark the pull request ready** and ask Cleo.
