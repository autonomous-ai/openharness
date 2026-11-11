# The server writes the status card within each command's read budget: implementation plan

> This plan is carried out by the project's Engineer way of working (test first, task by task, one pull request), not
> subagent-driven-development. There is no execution handoff.

**Goal:** Keep #3302's server-written status card (task #3593) and fit #4368's per-command read budgets, unchanged. This is
task #4419.

**Architecture:** #3302 kept the whole card on the project chat's part and rewrote it whenever a line changed. Each write
moved the chat's version, so the next command read the chat whole again: 6–7 KB over budget on conversation.create,
work.assign, work.status and the dispatch pass.

Now each task keeps its own line on its own part, as `statusLine: { text, since }`. After a command, only a task whose
line changed is written. A task that ends keeps an empty, dated line, so a reader learns its line left the card. The
command that changes a line usually writes that task anyway.

Readers get the card put together from the tasks' lines, in the project's `status` text, as before (`visibleState`). A
change poll sends the head only with a task whose line moved since the reader's cursor (`read/changes.ts`), as #3302
did for the chat's card.

**Tech Stack:** TypeScript backend, vitest.

**Spec:** Task #4419's brief; #3302's plan (`docs/plans/2026-11-06-server-status-card-plan.md`).

## Global Constraints

- Backend only. No read budget is raised: #4368's tests pass unchanged.
- Old clients still read the card in `status.text`.
- Audience unchanged: the card goes only to readers of the project chat, and it holds only tasks that have no audience
  of their own.

## Review Focus

- A task that ends, is archived, or goes dormant drops off the card, and live readers see it drop.
- A message, progress note or terminal turn moves no line, so the task isn't written for the card.
- A card stored by #3302 on a chat is never read.

---

### Task 1: Each task keeps its own line

**Files:** `statusCard.ts`, `pulse.ts`, `model.ts`, `parts/light.ts`, `read/views.ts`, `read/changes.ts`, and their tests.

**Interfaces:**
- `noteTaskLines(state, project, now, today): void` writes `statusLine` on the tasks whose line changed.
- `projectCard(state, project): StatusCard` builds the lines from the tasks.

- [ ] **Step 1: Failing tests.**
  - #3302's card tests, read from the tasks' lines.
  - A command writes only the changed task's line, and never a card on the chat.
  - An ended task's line is empty and dated.
  - The change feed sends the head for a moved line, and not for a task change that left its line as it was.
  - #4368's budgets fail unchanged at the merge of main.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** those tests and `integration/superTabCommandReads.test.ts`, `superTabRead.test.ts`, `superTabs.test.ts`.
  Expected: PASS.
