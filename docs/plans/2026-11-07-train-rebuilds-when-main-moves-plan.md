# The merge train starts a fresh batch when main moves: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** When main moves under a batch, the train builds a fresh batch from the main it reads right before building, takes
the same pull requests while GitHub is still working out whether they merge, and tells each one left waiting why and when the
next batch starts (task #4379).

**Architecture:** `mergeTrain/train.ts` only. A pass reads main again right before it creates a batch branch, so it never
builds on the main it read at the start of a pass that took minutes. A code-lane candidate whose only problem is GitHub's
`mergeable: null` (not worked out yet, as GitHub answers for every open pull request just after main moves) goes into the
batch build, where the train's own merge into the batch branch is the conflict test; a conflict there is left out and told,
as now. After building, each member of a batch closed this pass because main moved that is in no new batch gets one line on
its task: the reason it waits and the next pass time.

**Tech Stack:** TypeScript backend, vitest, the fake GitHub of `mergeTrain/fakeTrainGitHub.ts`.

**Spec:** task #4379's brief. Evidence (GitHub, 11-07 UTC): batch #3488 closed "main moved" at 01:56:22, a minute after
#3484's hand merge (01:55:19), and that pass built nothing; batch #3496 was built at 02:29:42 on 3a393e7, 46 s after #3485 had
moved main to a89280b (02:28:56), so the next pass closed it again. On 11-06, 20 batches closed "main moved".

## Global Constraints

- No requester (crew reliability, opened by the PM): the PR body says so in its first line.
- Backend only; owns `backend/src/superTabs/mergeTrain/`.
- Never push to a `harness-train/` branch by hand. `mergeTrain.enabled` stays the kill switch. One train run at a time per
  project (unchanged: `startMergeTrain`).
- Same rules: ready, every step passed at the head, ci/required green, no conflict, no hold. `mergeable: false` still waits;
  the fast lane (merged straight on GitHub) still needs `mergeable: true`; the green re-read before a squash is unchanged.

## Review Focus

- `mergeable: null` that is a real conflict: the train's merge into the batch branch answers `conflict`; it is left out and
  its Engineer told, the rest batch.
- Main moving again while the pass reads candidates: the batch is built on the main read just before `createBranch`.
- A closed batch's member merged by hand (often why main moved): no longer open, so no line.
- A member that waits for a reason already told by its own line (conflict, reads, workflows): no second line.
- Another batch still open (a split red batch): the moved batch's members are told they wait for it.

### Task 1: build on the main read just before building

**Files:** Modify `backend/src/superTabs/mergeTrain/train.ts`, `fakeTrainGitHub.ts` (an `afterRead` hook); Test
`train.test.ts`.

- [ ] Test `builds the fresh batch on the main it reads right before building, not the main the pass began with`: main
  moves (hook on the first `files` read) after the pass read it; the new batch's body names the new main, and the next pass
  does not close it.
- [ ] Run `npx vitest run src/superTabs/mergeTrain/train.test.ts`: FAIL (body names the old main).
- [ ] Code: `main = await github.mainHead()` before the build loop, inside the fast-lane try, always.
- [ ] Run again: PASS. Commit.

### Task 2: rebuild while GitHub is still working out mergeability

**Files:** Modify `train.ts`; Test `train.test.ts`.

- [ ] Test `rebuilds a batch closed because main moved on the next pass, while GitHub still reads its members as not worked
  out`: batch of #7 and #8 in CI, main moves, both `mergeable: null`; the next pass closes it and builds one batch of both
  on the new main.
- [ ] Test `leaves out a member that now conflicts, with its reason, and rebuilds the rest`: as above, #8's head conflicts
  in the merge; the new batch holds #7; #8's task gets `train-conflict:<head>`.
- [ ] Test: a fast-lane pull request with `mergeable: null` is not merged.
- [ ] Run: FAIL (no batch built). Commit the tests.
- [ ] Code: in the candidate loop, a code-lane read whose `why` is `mergeable` joins the batch build.
- [ ] Run: PASS. Commit.

### Task 3: tell the waiting members of a batch closed because main moved

**Files:** Modify `train.ts` (`TrainRules.everyMinutes?: number`), `run.ts` passes it already (`set`); Test
`train.test.ts`.

**Interfaces:** `TrainRules { enabled: boolean; rules: ProjectRules; everyMinutes?: number }`. Tell key
`train-moved:<closed batch number>:<head>`.

- [ ] Test `tells a member left waiting after main moved why it waits and when the next batch starts, once`: batch of #7
  and #8, main moves, #8 gets a hold label; #8's task gets one line naming the hold and "in about 10 minutes"; #7 (rebuilt)
  gets none; a second pass adds nothing.
- [ ] Test: a member merged by hand meanwhile gets no line; a conflicting one gets only its conflict line.
- [ ] Run: FAIL. Commit the tests.
- [ ] Code: collect the batches closed for "main moved" this pass; record each candidate's wait reason (none where its own
  line went); after building, tell each closed member that is open, read, and in no new batch. With another batch still
  open, the reason is that batch.
- [ ] Run the mergeTrain tests and `npx tsc --noEmit -p .`: PASS. Commit.
