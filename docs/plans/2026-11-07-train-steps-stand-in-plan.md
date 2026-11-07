# The merge train never waits on an acceptance check nobody can record (#4561) Implementation Plan

> Written by the writing-plans skill and carried out by its Engineer, task by task, test first (project instructions,
> Roles › Engineer).

**Goal:** A Done task whose every step says Yes at its pull request's head, with green ci/required, merges by the train,
and the train says so on the task; a builder's own verdict never passes its task's check.

**Architecture:** Of the brief's two options this takes the smaller: the train's readiness read (mergeTrain/plan.ts
`headReads`) lets a Done task's steps stand in for its own acceptance checks, instead of a new path to record a check
after Done. It stops counting the task's builders on the task's own checks, as it already ignores them on steps. The pass
(mergeTrain/train.ts) tells the task, once per head, when it merged on its steps alone.

**Tech Stack:** TypeScript, vitest. Backend only.

**Spec:** the brief of task #4561 (River, 19:20 VN: #3540 and #3545 held with every step Yes and CI green).

## Global Constraints

- A builder never passes its own check: its verdicts on its task's checks count for nothing, as on its steps.
- A task check with a failed verdict that counts at the head still holds the pull request, Done or not.
- The steps stand in only for a Done task, and only when every step is done, passed at the head and a Review step passed.

## Review Focus

1. A task not Done, with only its builder's pass on its check: waits (it merged before this change).
2. A Done task whose check a reviewer failed at the head: still waits.
3. A Done task with a step not passed at the head: still waits.
4. A task whose check someone other than its builder passed: unchanged, merges without the line.
5. The line is said once per head, not on every pass.

---

### Task 1: The steps stand in for a Done task's own checks (plan.ts)

**Files:** Modify `backend/src/superTabs/mergeTrain/plan.ts`; Test `backend/src/superTabs/mergeTrain/plan.test.ts`.

**Interfaces:** Produces `standsIn(task: TrainTask, url: string): string[]`: the descriptions of the task's checks that
count only through its steps (no independent pass at the head, no failure); `headReads` counts them for a Done task.

- [ ] Failing tests: a Done task with an unpassed check and every step Yes reads as reviewed; not Done, it names the check;
  the builder's own pass on the task check no longer counts; a non-builder's failure at the head holds a Done task; a
  step not passed holds it; `standsIn` names the checks.
- [ ] Run `cd backend && npx vitest run src/superTabs/mergeTrain/plan.test.ts`: FAIL. Implement; PASS. Commit test, then code.

### Task 2: The train says so on the task when it merges on its steps (train.ts)

**Files:** Modify `backend/src/superTabs/mergeTrain/train.ts`; Test `backend/src/superTabs/mergeTrain/train.test.ts`.

- [ ] Failing test: merging a Done task whose check stood in by its steps tells the task once, naming the head and that
  every step said Yes and ci/required was green; a task whose check was passed tells nothing.
- [ ] FAIL, implement, PASS, commit.
