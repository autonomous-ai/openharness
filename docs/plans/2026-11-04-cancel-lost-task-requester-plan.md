# Requester and Project Owner Cancel a Lost or Stopped Task Implementation Plan

> **For agentic workers:** The assigned Engineer implements this plan task by task in this session, test first, by the project's instructions. No subagents: one handler and its tests.

**Goal:** The person who asked for a task, and the owner of its project, can cancel it with a reason once it is lost or stopped, so it then archives; nobody gains a way to cancel live work.

**Architecture:** `work.cancel` in `backend/src/superTabs/commands.ts` keeps today's check (`projectAgent` or the Swarm owner) for every attempt, and also accepts a person who is the task's `requesterId` or its project's `ownerId` when the attempt is `lost` or `stopped`, the two states `tidy.ts unfinishedWork` holds back from archiving and which have no worker left to tell. The refusals that stay (`FORBIDDEN` on cancel, `WORK_UNFINISHED` on archive) name who can cancel.

**Tech Stack:** TypeScript, Vitest (`backend/src/superTabs/commands.test.ts`).

**Spec:** Swarm task #2639, conversation 7f54fe5584fdafeea5c394e8 (Diego, 2026-11-04; regression from #1903).

## Global Constraints

- Only `lost` or `stopped` attempts widen; `working`, `review`, `blocked`, `needs_human` and `reconciling` stay as today.
- Only the task's requester or its own project's owner widen, as a person; a viewer is still refused before the handler (READ_ONLY), and a person who can no longer read the task is still refused (readConversation).
- The unassigned and ended-step paths of `work.cancel` are unchanged.
- Two independent security reviews by two different Reviewers.
- PR body first line: "Requested by diego@autonomous.ai through Harness."
- Swarm code stays out of cli/src/core.

## Review Focus

- A collaborator who did not ask for a lost task cannot cancel it.
- The owner of another project cannot cancel a lost task in this one.
- The requester cannot cancel their own task while its agent is still working (live work stays the project's agents' and the Swarm owner's).
- After the requester cancels and archives, nobody is tagged; after the project owner cancels and the requester did not archive, the requester is still tagged as today.
- A retry of the requester's cancel changes nothing (the existing `cancelled` early return).

---

### Task 1: Requester and project owner cancel a lost or stopped task

**Files:**
- Modify: `backend/src/superTabs/commands.ts` (`work.cancel`, `conversation.archive`'s WORK_UNFINISHED message)
- Test: `backend/src/superTabs/commands.test.ts` (`archiving unfinished work`)

**Interfaces:**
- Consumes: `groupProject(state, group).ownerId`, `group.requesterId`, `Actor` person `userId`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests** in `describe('archiving unfinished work')`, using its `task()` fixture (Peer invited by `f.invite()` and named requester):
  - Peer cancels a lost task and a stopped task with a reason; each then archives and tags nobody.
  - Peer, owning a second project (not the Swarm owner), cancels a lost task in that project that the Swarm owner asked for.
  - Peer, a collaborator who is not the requester, still cannot cancel a working task, nor a lost one, and the refusal names who can.
  - Peer, the requester, cannot cancel the task while it is working; the owner of another project cannot cancel a lost task here.
- [ ] **Step 2: Run them and watch them fail**

Run: `cd backend && npx vitest run src/superTabs/commands.test.ts -t 'archiving unfinished work'`
Expected: the allow cases FAIL with FORBIDDEN; the deny cases' message assertions FAIL on the old wording.

- [ ] **Step 3: Commit the failing tests**
- [ ] **Step 4: Implement** in `work.cancel`: after the stale-assignment check, `allowed || (lost/stopped && person && (userId === group.requesterId || userId === project.ownerId))`; the FORBIDDEN text names who can cancel each kind of task; the archive's WORK_UNFINISHED text names who can cancel.
- [ ] **Step 5: Run the same tests and the `work.cancel` tests and watch them pass**

Run: `cd backend && npx vitest run src/superTabs/commands.test.ts src/superTabs/tidy.test.ts`
Expected: PASS

- [ ] **Step 6: Commit the fix**
