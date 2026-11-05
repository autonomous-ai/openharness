# Reviews open by themselves from the changed files: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** When a task's pull request is handed (its Engineer's Ready for review), the server opens the task's review steps
from a table of path rules (one read by default; two security reviews for sign-in, tokens, crypto, access, the Buddy guard,
device links and deletion; a test step where the change runs) and assigns each to a free reviewer it picks by rule: never the
engineer, never a grid model, at least as strong as the engineer, no verdict yet at this head. Nothing is refused: a step
nobody is free for stays open and the PM is told once. A batch asks for a combination read only when two of its pull
requests touch the same file (task #3401, requested by Dee through Harness).

**Architecture:** A new `reviewTable.ts` holds the table as data (`REVIEW_TABLE`, the one place its numbers live until the
project rules record, #3393, carries it) and turns a pull request's changed files into the steps it needs (`reviewPlan`), and
says which files two pull requests of a batch share (`sharedFiles`). A new `reviewerPick.ts` ranks the free agents for a step
(`reviewerCandidates`). In `commands.ts`, `work.assign`'s checks and its writes split into two closures (`assignRefusal`,
`assignTo`) so the server's own assignment runs the very same checks and writes; `work.status` `review` on a task (not a
step) calls `openReviewSteps`, which opens each missing step as `conversation.create` with `reviewOf` and `step` would, and
assigns it to the first candidate `assignRefusal` lets through. The files come in the command's context
(`pullRequestFiles`), read by the store outside the transaction from GitHub, as `pushOrigin` is for the same command.

**Tech Stack:** TypeScript backend (vitest unit tests on `applyCommand`).

**Spec:** task #3401 brief (conversation 09910149766fbfb592f7e48f); siblings #3393 (rules record: its `reviews` section),
#3394 (verdict `head`), #3399 (`handed` state).

## Global Constraints

- PR body first line: "Requested by Dee through Harness."
- Owns `backend/src/superTabs/`; outside it only wiring: `backend/src/routes/superTabs.ts` (the hook), the new integration
  test and its line in `vitest.super-tabs.config.ts`. The GitHub read is #3394's `pullRequestFiles` (agreed in its task),
  not a second one; until #3394 lands the app has none, the hook reads nothing, and Ready is as before.
- No new refusal: `removedRefusals.test.ts` stays green. The server's open never fails the Engineer's Ready.
- Old clients: an Engineer that opens its own steps first keeps them: a step of the same name is reused, never doubled.
- Fail safe: files GitHub cannot read (no app, an error, over 3,000 files) plan as the strictest table: one read and two
  security reviews, and the step's brief says the files were not read.
- Swarm code stays out of cli/src/core.

## Design

- growth: steps are groups that archive with their task (steps.ts endSteps); at most 4 per task per round, reused next round.
- concurrency: the steps and their assignments are written in the Ready's own transaction (one command), so two Readies race
  on the task's part as any two commands do; the GitHub read is outside it and only feeds the plan.
- read cost: one GitHub read (`GET /pulls/N` head + `GET /pulls/N/files`, at most 30 pages of 100) per Ready of a task with
  a pull request; nothing on any other command or read.
- scale: 10x Readies is 10x that read; GitHub's rate limit warns first, logged by the hook on failure.
- compatibility: old clients see ordinary steps; an Engineer still may open or assign a step itself.
- migration + rollback: none; rolling back leaves the opened steps as ordinary steps.
- audience: the files are the server's GitHub App read of the project's own repository, never a client's word; picks are
  within the task's project and pass every check `work.assign` makes.
- identity: the steps and their briefs are written by the Engineer's own Ready, as its other rows are; never as the
  machine owner.
- failure: a step nobody is free for stays open, with one notice to the PM naming it and why; a file read failure plans the
  strictest steps and says so in the brief.
- platforms: backend only.

## Review Focus

- A security-sensitive path always gets two security reviews by two different agents, neither the engineer.
- The pick never names the engineer, a grid model, a weaker model, or an agent with a verdict at this head.
- A second Ready reuses the same steps (Workflow 3), and adds only what the new files need.

---

### Task 1: the review table and its plan

**Files:** Create `backend/src/superTabs/reviewTable.ts`, test `reviewTable.test.ts`.

**Interfaces:** `REVIEW_TABLE: ReviewTable` = `{ defaultReads: 1, rows: [{ area, reads, paths: glob[] }], test: [{ where,
paths: glob[] }] }`; `globMatch(glob, path)`; `reviewPlan(files: string[] | null, table?) => PlannedStep[]` where
`PlannedStep = { name: 'Review' | 'Security review 1' | 'Security review 2' | 'Test', kind: 'review' | 'security' | 'test',
areas: string[], where?: string[] }`; `sharedFiles(pulls: Array<{ url, files }>) => Array<{ file, urls }>`.

- [x] Test: a docs-only change plans one Review; a sign-in change (`backend/src/lib/auth*`, `backend/src/routes/auth*`,
  `cli/src/**/login*`) plans Review + Security review 1 + 2 naming "Sign-in"; a Desktop change adds Test "Desktop on a Mac";
  unread files plan the strictest; `sharedFiles` names only files in two pull requests.
- [x] Code.

### Task 2: who may review

**Files:** Create `backend/src/superTabs/reviewerPick.ts`, test `reviewerPick.test.ts`.

**Interfaces:** `builtBy(task) => Set<agentId>` (assignee and every run's agent); `strengthOf(agent) => number | null`
(catalog.ts); `reviewerCandidates(state, task, kind, head, index) => Agent[]`, best first.

- [x] Test: never the engineer or an earlier builder; never a grid model; never weaker than the engineer; never an agent
  with a verdict at this head (a verdict's `head`, #3394; without one, any verdict since the task's Ready); never one
  holding another open step of this task; never busy, a Lead or a Buddy; the step's role (Reviewer / Tester) first.
- [x] Code.

### Task 3: steps open on handed

**Files:** Modify `backend/src/superTabs/commands.ts` (assign split, `openReviewSteps` on `work.status` review),
`backend/src/superTabs/model.ts` (context type), test `reviewSteps.test.ts`.

- [x] Test (acceptance): a PR touching sign-in code opens two security reviews and a read, each assigned to a different free
  Reviewer, never the Engineer; a docs PR opens one read; a second Ready reuses the steps; with nobody free the step stays
  open and the PM gets one notice; the Ready itself is never refused.
- [x] Code.

### Task 4: the files reach the command

**Files:** Create `backend/src/superTabs/pullRequestFiles.ts` (the read, over #3394's app method), modify
`backend/src/superTabs/store.ts` (hook, context, reach read for the Ready), `backend/src/routes/superTabs.ts` (wiring); tests
`pullRequestFiles.test.ts`, `integration/superTabReviewSteps.test.ts`.

- [x] Test: the hook reads the task's own-repository pull requests only, returns `null` files on any failure; the store
  passes them to the Ready's context.
- [x] Code.

### Task 5: the template says so

**Files:** `backend/src/superTabs/instructionsTemplate.ts`, `instructions.test.ts`.

- [x] Test: Workflow 2 says the server opens a ready pull request's steps, and the Engineer opens them only where it opened none.
- [x] Code.

The combination read: `sharedFiles` is the batch's question (task #3402, the merge train, calls it); no batch code runs on
the server before that task lands.
