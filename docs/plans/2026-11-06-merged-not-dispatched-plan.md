# A task with a recorded merge is never handed out again: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** A task whose own merge is recorded is never handed out again; the server sets it done and closes its open steps
(task #4032, Stepos 11-06: #3819 was handed out 9 minutes after PR #3384 merged and #3818 52 minutes after PR #3383, each an
agent spent only to set the task done; their steps were revived the same way).

**Architecture:** `mergedTasks.ts` (new): `ownMerge(task)`, the task's own code pull request whose merge is recorded (a card
with a merge on one of its code links, never one only a merge record linked, `cards.recorded`), read from what every task
already stores, so tasks merged before this change are covered. `closeMerged` sets done with the merge as its result and ends
its open steps, working and lost, with "Its task merged". Used by: `dispatch.ts openTasks` (no merged task, no step of one),
`liveness.ts sweepLiveness` (`closeMergedLost`: a lost task with its own merge is set done, as its PM), and
`commands.ts conversation.merged`'s existing close when the builder is gone (#3510), which now closes the steps too.

**Tech Stack:** TypeScript backend (vitest). **Spec:** task #4032 brief.

## Global Constraints

- Never close a task whose own merge isn't recorded; a merge of another task's pull request closes nothing (Aster, #3259).
- A live builder still closes its own task in review: only lost work is closed by the sweep.
- Owns backend/src/superTabs/.

## Design

- growth, read cost, scale: N/A because nothing new is stored; one pass over the loaded tasks the sweep already reads.
- concurrency: inside the sweep's and the command's existing writes.
- compatibility, migration and rollback: no field or contract changes; revert.
- audience, identity: N/A because no new reader or actor; rows are written as the project's PM.
- failure: the close writes a Done line in the task and a line in each closed step.
- platforms: backend only.

## Task 1: merged work is finished work

**Files:** mergedTasks.ts (new), dispatch.ts, liveness.ts, commands.ts, mergedTasks.test.ts (new).

- [ ] Tests: a lost task with its own merge recorded is not offered and the sweep sets it done, closing its working and lost
      steps, once; the merge record's close ends the steps; a merged task in review never revives its lost step; an unmerged
      lost task is still handed on; a task whose only merge is another task's pull request is never closed.
- [ ] Watch them fail; code; watch them pass; commit.
