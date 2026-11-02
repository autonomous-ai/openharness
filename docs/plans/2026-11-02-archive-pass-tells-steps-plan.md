# Archive pass tells the steps it ends Implementation Plan

> **For agentic workers:** implement task by task, test first. No review per step: the Review step on the pull request is the one independent review.

**Goal:** When the archive pass ends a task's open step, the step's agent hears why, and the steps it archives keep no open deliveries.

**Architecture:** `archiveFinished` already calls `endSteps`, drops the steps it returns and cancels only the task's own deliveries. A new `steps.ts` helper builds the "was archived" rows; the command path and the archive pass both use it, and the pass writes them with its own line.

**Tech Stack:** TypeScript, Prisma on MongoDB, vitest integration suite (`npm run test:super-tabs`).

**Spec:** task #2134 (Diego's repro on main 2826547cb); `docs/plans/2026-11-02-task-steps-design.md`, "Archive and sleep".

## Global Constraints

- A cancelled step stays unarchived, so its row can still be delivered (`endSteps`).
- Only deliveries of steps archived in this write are cancelled.
- One plain delivery match per conversation: an `in` on this collection is sent as `$expr`, which no index bounds.
- Two security reviews before merge; full Super Tab integration suite before Ready.

## Review Focus

- A step whose agent has left the Swarm: the pass must still archive the task, and writes the row to nobody. A delivery to a missing agent would throw, and the task would never archive.
- A project with no Lead: `archiveLine` is null, and the step's agent must still hear.
- A step that finished before the pass: it is archived, its deliveries end, and no row goes to its agent.
- A step already archived before this write: its deliveries are not touched.
- A retried write: one row per step per pass, no second delivery.

## Design

- Growth: one row and one delivery per cancelled step; they go with the group.
- Concurrency: inside the pass's one transaction; a claim of a delivery conflicts with the write, as for the task's.
- Read cost: one more delivery update per archived step; no new reads.
- Scale: a task has a handful of steps. Warns first: the pass's skipped-group warning.
- Compatibility: old and new clients read an ordinary system row.
- Migration + rollback: none; nothing stored changes shape.
- Audience: the row goes only to the step's own assigned agent, in that step's conversation.
- Identity: written as the project's Lead, as the pass's own line, else as the agent told.
- Failure: a row to a missing agent is written to nobody, so it cannot stop the archive.
- Platforms: backend only.

---

### Task 1: The archive pass tells a working step's agent

**Files:**
- Modify: `backend/src/superTabs/steps.ts`, `backend/src/superTabs/commands.ts` (`endStepsOf`), `backend/src/superTabs/store.ts` (`archiveFinished`)
- Test: `backend/integration/superTabTidy.test.ts`

**Interfaces:**
- Produces: `stepEndedRows(state, cancelled: Conversation[], reason: string, author: Author | null, id: (step: Conversation) => string): MessageDraft[]` in `steps.ts`

- [ ] **Step 1: Write the failing tests:** the working step's agent gets a row and a queued delivery; a finished step is archived and its deliveries end; a step whose agent left does not stop the archive; no Lead still tells the agent.
- [ ] **Step 2: Run them to see them fail:** `npx vitest run --config vitest.super-tabs.config.ts integration/superTabTidy.test.ts`
- [ ] **Step 3: Add `stepEndedRows`, use it in `endStepsOf` and `archiveFinished`, and cancel the archived steps' deliveries.**
- [ ] **Step 4: Run them to see them pass,** then the unit tests for steps and commands.
- [ ] **Step 5: Run the full suite:** `npm run test:super-tabs`, and post the count.
