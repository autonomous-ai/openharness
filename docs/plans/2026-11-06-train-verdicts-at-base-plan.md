# The merge train counts a review only at the version and base it read: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** The merge train counts a review or test verdict only through the shared verdict check (head and base, #3394), and
only while GitHub's live base for the pull request is the base the PR watch recorded, so a verdict read against another
branch never merges anything (task #3493, requested by Dee through Harness).

**Architecture:** `mergeTrain/plan.ts` drops its own head/patch match (`countsAt`) and calls `verdictCounts` from
`superTabs/checkVerdicts.ts` on the task's `pullRequestHeads`. `headReads` gains the live base: it reads nothing when the
watched head entry is missing, names another head, has no base, names another base than GitHub's live one, or either base
holds a control or format character. `train.ts` passes the live base it read. `github/train.ts` refuses a pull request whose
base or head branch name holds such a character.

**Tech Stack:** TypeScript backend, vitest, the fake GitHub of `mergeTrain/fakeTrainGitHub.ts`.

**Spec:** task #3493's brief; Verdict's notes in #3394 (base recorded per verdict; a patch id hashes its base) and Ledger's
retarget reproduction on #3218.

## Global Constraints

- PR body first line: "Requested by Dee through Harness."
- Owns `backend/src/superTabs/mergeTrain/` and `backend/src/github/train.ts`.
- Fail closed: `verdictCounts` counts any verdict on a task never watched; the train requires a watched entry first, and a
  verdict naming its pull request.
- The train stays off for every project (project rules) until a project switches it on.

## Design

- growth, concurrency, read cost, scale, migration: N/A because nothing new is stored or read: the same verdicts and heads,
  compared differently.
- compatibility: a head recorded before bases (no `base`) no longer lets the train merge until the watch reads it again.
- audience, identity: N/A because nothing new is exposed and nothing acts as a person.
- failure: a refused pull request is "not eligible" for that pass, as any other unverified one.
- platforms: backend only.

## Review Focus

- A retarget between the watch's last read and the train's pass: GitHub's live base differs from the watched one.
- The same patch on another base: the patch id differs, so it never counts.
- A base name with a zero-width or bidi character that reads as "main".

### Task 1: the shared check, at the live base

**Files:** `backend/src/superTabs/mergeTrain/plan.ts`, `plan.test.ts`

**Interfaces:** `headReads(task: TrainTask, url: string, head: string, base: string): number | null`.

- [ ] Test: a verdict at the same head and base counts; the same patch on a new base does not; a watched base other than
  the live base (retarget) does not; a verdict with no head never counts; a watched entry with no base does not; a base with
  a format character does not.
- [ ] Code: call `verdictCounts`, require `verdict.pullRequest === url`, delete `countsAt` and `MIN_PREFIX`.

### Task 2: the train reads at the live base

**Files:** `backend/src/superTabs/mergeTrain/train.ts`, `train.test.ts`, `backend/src/github/train.ts`, `github/train.test.ts`

- [ ] Test (train): Ledger's case: a review passed at head A against another branch, the PR retargeted to main before the
  watch's next pass: never batched.
- [ ] Test (GitHub): a pull request whose base or head branch name holds a control or format character reads as unreadable.
- [ ] Code.
