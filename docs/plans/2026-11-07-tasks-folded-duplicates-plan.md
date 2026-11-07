# Tasks feed: duplicates leave it — Plan (task #4462)

**Goal:** A proposal or task closed as a duplicate of, or folded into, another task leaves the person's Tasks feed; the
real task stays; the closed one is kept and still readable, and names the real task.

**Architecture:** `work.cancel` takes an optional `intoConversationId`, the real task. The server stores it on the closed
conversation as `foldedInto`. The feed treats `foldedInto` as it already treats a merged proposal (`proposal.mergedInto`):
the row's indexed `feedIds` is empty, so no page reads it, and a change poll sends its id as removed. A task already
cancelled or archived without one (the existing duplicates, such as #4420 into #4421) takes the same command once: it records
the link and changes nothing else. No data is deleted.

**Why not `proposal.merge`:** it refuses every card on Review mode (`TASK_APPROVAL_REQUIRED`) and needs an undecided
proposal as its target, so the PM closed these with a plain cancel whose only trace of the real task is free text.

**Tech Stack:** TypeScript backend (`backend/src/superTabs`), vitest; the CLI's command help (`cli/src/superTabs/service.ts`).

**Spec:** task #4462's brief.

This plan is implemented test first by the Engineer, task by task (test-driven development); there is no execution
hand-off.

## Global Constraints

- Server-enforced audience unchanged: the target must be a task of the same project, and only who may cancel the task may
  fold it.
- Read only what changed: no new read; the change poll already carries the folded row, the page read never sees it.
- Never delete data: the folded conversation, its messages and its proposal stay; it stays in the archived list.
- Compatibility: the field is optional; older CLIs send no `intoConversationId` and cancel as before.

## Design

- growth: one id per conversation, deleted with it.
- concurrency: the conversation's own write, as `work.cancel` today.
- read cost: none added; `feedIds` is recomputed on the write the command already makes.
- scale: unchanged per Swarm; the feed reads fewer rows.
- compatibility: backend first; Desktop needs no change (it drops removed ids already); the command field is an extension.
- migration and rollback: no migration; the PM folds the existing duplicates with the command. Rollback leaves an unread field.
- audience: server checks the target is a readable task in the same project.
- identity: N/A because no login is involved.
- failure: a bad target is refused with a named error (`FOLD_TARGET`).
- platforms: backend (Linux) and the CLI's help text.

## Review Focus

- A folded task never appears in a page or a change poll; the real task still does.
- The already-closed path changes only `foldedInto` and adds one line, and is refused on live or done work.
- Target checks: same project, a task (not a chat, a step or a private conversation), not itself.

## Task 1: the feed leaves out a folded task

**Files:** `backend/src/superTabs/model.ts`, `backend/src/superTabs/read/feedIds.ts`, `backend/src/superTabs/read/personalTasks.ts`,
`backend/src/superTabs/read/personalTasks.test.ts`, `backend/src/superTabs/read/feedIds.test.ts`

**Interfaces:** `Conversation.foldedInto?: string`.

- [ ] Test: a row with `foldedInto` is removed from a change poll and has empty `feedIds`; the real task is still listed.
- [ ] Watch it fail.
- [ ] Code: `feedIdsOf` and `summary` treat `foldedInto` as `proposal.mergedInto`.
- [ ] Run `npx vitest run src/superTabs/read`.

## Task 2: `work.cancel` folds into the real task

**Files:** `backend/src/superTabs/commands.ts`, `backend/src/superTabs/commands.test.ts`, `cli/src/superTabs/service.ts`

**Interfaces:** `work.cancel { …, intoConversationId?: string }`.

- [ ] Tests: cancel with `intoConversationId` on an unassigned and on an assigned task sets `foldedInto` and names `#N` in
  its line; a task already cancelled or archived takes the link with nothing else changed; a live or done task, a missing,
  other-project, step or self target are refused; someone who may not cancel may not fold.
- [ ] Watch them fail.
- [ ] Code the schema, the checks and both paths; add the field to the CLI's command help.
- [ ] Run the commands tests for `work.cancel`.
