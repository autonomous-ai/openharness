# Tasks feed: duplicates leave it — Plan (task #4462)

**Goal:** A proposal or task closed as a duplicate of, or folded or split into, another task leaves the person's Tasks
feed; the real task stays; the closed one is kept and still readable, and names the real task.

**Architecture:** The rule is the PM's own words (River, in the task): a task cancelled with a reason that names another
task number ("Duplicate of #4421", "Being done inside #4445", "split… #4465 … #4468") goes on there. `work.cancel` reads
those numbers from its reason (`tasksNamedIn`: not the task itself, not "PR #N", at most 10) and stores them on the
conversation as `foldedInto`. The feed treats `foldedInto` as it already treats a merged proposal (`proposal.mergedInto`):
the row's indexed `feedIds` is empty, so no page reads it, and a change poll sends its id as removed. A task cancelled
before this ships (the existing duplicates, such as #4420 into #4421) is cancelled again by the PM with a reason naming the
real task: it takes the link and nothing else changes. No data is deleted. A cancel whose reason names no task stays.

**Why numbers, not ids:** a command loads only the conversations it names; the real task may be quiet and unloaded, and the
reason already names it by number, as people do. A number needs no lookup.

**Why not `proposal.merge`:** it refuses every card on Review mode (`TASK_APPROVAL_REQUIRED`) and needs an undecided
proposal as its target, so the PM closed these with a plain cancel.

**Tech Stack:** TypeScript backend (`backend/src/superTabs`), vitest; the CLI's command help (`cli/src/superTabs/service.ts`).

**Spec:** task #4462's brief and River's rule in its conversation.

This plan is implemented test first by the Engineer, task by task (test-driven development); there is no execution
hand-off.

## Global Constraints

- Server-enforced audience unchanged: only who may cancel the task marks it; nothing new is exposed.
- Read only what changed: no new read; the change poll carries the marked row, the page read never sees it.
- Never delete data: the conversation, its messages and its proposal stay; it stays in the archived list.
- Compatibility: no new command field; older CLIs and clients work as before.

## Design

- growth: at most 10 numbers per conversation, deleted with it.
- concurrency: the conversation's own write, as `work.cancel` today.
- read cost: none added; `feedIds` is recomputed on the write the command already makes.
- scale: unchanged per Swarm; the feed reads fewer rows.
- compatibility: backend first; Desktop needs no change (it drops removed ids already).
- migration and rollback: no migration; the PM cancels the existing duplicates again with the real task named. Rollback
  leaves an unread field, and those cards show again.
- audience: unchanged, server-enforced.
- identity: N/A because no login is involved.
- failure: a reason naming no task leaves the task as it was; a closed one stays refused as before (`ARCHIVED`).
- platforms: backend (Linux) and the CLI's help text.

## Review Focus

- A marked task never appears in a page or a change poll; the real task still does.
- The already-closed path changes only `foldedInto` and adds one line (not a cancel row, so the scorecard counts no second
  close), is idempotent, and is refused on done work and for whoever may not cancel.
- `tasksNamedIn` false positives: "PR #N" and the task's own number name nothing.

## Task 1: the feed leaves out a marked task

**Files:** `backend/src/superTabs/model.ts`, `backend/src/superTabs/read/feedIds.ts`, `backend/src/superTabs/read/personalTasks.ts`,
`backend/src/superTabs/read/personalTasks.test.ts`, `backend/src/superTabs/parts/light.ts`

- [x] Test: a row with `foldedInto` is removed from a change poll and has empty `feedIds`; the real task is still listed.
- [x] Watch it fail; code `feedIdsOf` and `summary` to treat `foldedInto` as `proposal.mergedInto`; run `src/superTabs/read`.

## Task 2: `work.cancel` reads where the work goes on

**Files:** `backend/src/superTabs/commands.ts`, `backend/src/superTabs/commands.test.ts`, `cli/src/superTabs/service.ts`

- [x] Tests: `tasksNamedIn`; an unassigned and an assigned cancel naming a task are marked, one naming none is not; a task
  cancelled before takes the link once with nothing else changed; done work and someone who may not cancel are refused.
- [x] Watch them fail; code it; say it in the CLI's command help; run the commands, read and parts tests.
