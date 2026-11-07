# Tasks feed: duplicates leave it — Plan (task #4462)

**Goal:** A proposal or task closed as a duplicate of, or folded or split into, another task leaves the person's Tasks
feed; the real task stays; the closed one is kept and still readable, and names the real task.

**Architecture:** The rule is the PM's own words (River, in the task): a task cancelled with a reason that says its work
goes on in another task ("Duplicate of #4421", "Being done inside #4445", "split… #4465 … #4468") points there.
`work.cancel` reads those numbers from its reason (`tasksNamedIn`: only after a phrase such as duplicate, inside, into,
split, folded, merged; never the task itself or "PR #N"; at most 10), keeps those that are tasks of the same project the
Swarm holds now (`goesOnIn`: not a chat, a step or a private conversation; a mistyped number links nothing), and stores their
ids as `foldedInto`. The feed treats `foldedInto` as it already treats a merged proposal (`proposal.mergedInto`): the row's
indexed `feedIds` is empty, so no page reads it, and a change poll sends its id as removed. History is the project's
archived list, which reads by project, not by the feed's keys: it still lists the task, and its view carries `foldedInto`
for a client to open the real task. A task cancelled before this ships (the existing duplicates, such as #4420 into #4421)
is cancelled again by the PM with a reason naming the real task: it takes the link and nothing else changes. No data is
deleted. A cancel whose reason names no task stays.

**Limits:** a command holds only the Swarm's awake conversations, so a real task already quiet (done or cancelled and idle
for a day) cannot be checked and links nothing; the task then stays in Tasks, as today. Opening the real task from the
archived list is a Desktop change, proposed separately (this machine has no Flutter to test it).

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

- growth: at most 10 ids per conversation, deleted with it.
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
