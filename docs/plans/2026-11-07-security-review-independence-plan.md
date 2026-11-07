# A reviewer of one security review never gets the other — Plan (task #4534)

**Goal:** A security review step is never assigned, by any path, to an agent that holds or gave a verdict on the task's other
security review, nor to the task's builder; a step stuck on such a reviewer moves to an eligible one without a cancel.

**Architecture:** The candidate filter (reviewerPick.ts `reviewerCandidates`) excludes a verdict only at the current head and
a step only while it is worked, so a reviewer who finished Security review 2 at an older head was a candidate for Security
review 1 at the next (#3542, #3545). `otherSecurityReviewers(state, task, stepId)` names the agents holding, done with or with a
verdict on any security step of the task other than `stepId`. `reviewerCandidates` takes the step it fills and leaves them out
of a security step; `stepCandidates` (dispatch, liveness) passes its step; the Ready's `openReviewSteps` passes the step it
fills. `assignRefusal`, which every `work.assign` and the Ready pass through, refuses such an agent (`REVIEW_NOT_INDEPENDENT`)
and the task's builder (`STEP_BUILDER`) on a step, naming who is eligible now. In `work.assign`, a step blocked or
needing a human whose holder is not independent ends that attempt (cancelled, its holder told) and goes to the agent named.

**Tech Stack:** TypeScript backend (`backend/src/superTabs`), vitest.

**Spec:** task #4534's brief.

This plan is implemented test first by the Engineer, task by task (test-driven development); there is no execution
hand-off.

## Global Constraints

- Backend only. No change to who may review otherwise: the rule applies to security steps (independence) and to every step
  (its builder), as the candidate filter already does for the builder.
- Read cost: only the task's step rows the assignment already reads (`stepsOf`).

## Design

N/A because nothing new is stored, synced or exposed: a refusal and a reassignment use existing fields.

## Review Focus

- A reviewer re-asked for its own security step at a new head still may take it.
- A blocked step whose holder is independent stays refused (`WORK_ACTIVE`), as today.
- A step cancelled and reopened at a new head never goes to the other step's reviewer.

## Task 1: the candidate filter and every assignment path

**Files:** `backend/src/superTabs/reviewerPick.ts`, `backend/src/superTabs/commands.ts`; Tests
`backend/src/superTabs/reviewerPick.test.ts`, `backend/src/superTabs/reviewSteps.test.ts`.

**Interfaces:** `otherSecurityReviewers(state, task, stepId): Set<string>`; `reviewerCandidates(..., os?, stepId?)`.

- [ ] Tests: `stepCandidates` for Security review 1 leaves out the agent done with Security review 2, and offers it Security
  review 2 again; a Ready after Security review 1 was cancelled never gives it to Security review 2's reviewer;
  `work.assign` of that reviewer, or of the builder, to a step is refused naming who is eligible.
- [ ] Run `npx vitest run src/superTabs/reviewerPick.test.ts src/superTabs/reviewSteps.test.ts`: fail. Code it. Pass. Commit.

## Task 2: a stuck step moves without a cancel

**Files:** `backend/src/superTabs/commands.ts`; Test `backend/src/superTabs/reviewSteps.test.ts`.

- [ ] Test: Security review 1 held by Security review 2's reviewer, who reports it blocked: the builder's `work.assign` to a
  free Reviewer moves it, the old holder is told and freed; a blocked step whose holder is independent is still refused.
- [ ] Run: fails. Code it. Pass. Commit.
