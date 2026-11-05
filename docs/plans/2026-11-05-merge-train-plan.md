# Merge train Implementation Plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No per-task review: the pull request's review steps are the independent
> reviews. No Execution Handoff.

**Goal:** Every 10 minutes the server merges approved pull requests in batches through the Harness GitHub App, so nobody
merges routine work by hand (task #3402, requested by Dee through Harness).

**Architecture:** A new module `backend/src/superTabs/mergeTrain/` runs one pass per project in the singleton worker
(worker.ts), like the pull request watch. The pass is a pure planner (`plan.ts`: who is eligible, which lane, how a red batch
splits) driven by `train.ts` against two narrow interfaces: `TrainGitHub` (the repository, through the App, `github/train.ts`)
and `TrainSwarm` (the Swarm store: candidates, recording a merge, telling an owner). The train keeps no state of its own: an
open batch is an open pull request on a `harness-train/` branch whose body lists its members and their heads, so a restart,
a second worker or a hand merge never leaves a stale record behind.

**Tech Stack:** TypeScript backend, vitest, GitHub REST (git data, merges, pulls, check runs) through the existing App.

**Spec:** task #3402's brief (conversation a8d3e85bda1c45e0e8fe9f33): anh Dee's Swarm redesign, approved 2026-11-05.

## Global Constraints

- PR body first line: "Requested by Dee through Harness."
- Owns `backend/src/superTabs/`, `backend/src/worker.ts`, `backend/src/github/`, `AGENTS.md`.
- Fail closed on every read: a GitHub answer that is not exactly what the train expects means no write for that batch or
  pull request this pass (no merge, no close, no tell); the pass logs one line.
- Re-fetch every member's head and main's head immediately before the squash merge; any difference aborts and rebuilds.
- Train branches never mark tasks Team-written: the batch pull request is never linked to a task (never in a Swarm
  message, result or `pullRequestUrls`), and no ref the train writes ever points at a member's own commit.
- Kill switch and interval live in the project rules record (task #3393, `rules.mergeTrain.enabled/everyMinutes`). Until
  it lands, `TRAIN_DEFAULTS = { enabled: true, everyMinutes: 10 }` in `mergeTrain/config.ts` is the one place they live.
- People can still merge by hand; the train sees it as main moving or a member closing, and rebuilds.
- Two security reviews before merge: this is the first server write to main.
- Swarm code stays out of cli/src/core. Temp files only in mktemp -d folders.

## Design

- growth: no stored train record. Batch branches are deleted when their batch merges or closes; a branch the train finds
  with no open pull request is deleted on the next pass. Train keys on a task (`train-*:<head>` in `pullRequestEvents`)
  are bounded by the existing `SEEN_KEPT`.
- concurrency: one pass at a time per worker (`running` guard, as the PR watch); the singleton worker is the only writer.
  Two passes racing anyway meet GitHub's own guards: creating an existing ref is 422, a squash with a stale `sha` is 409;
  both read as "skip this pass".
- read cost: per pass and project, one main ref read, one open-PR list, then per candidate the PR, its check runs and its
  files, each with the ETag cache the watch uses; per open batch its PR and its check runs.
- scale: 10x PRs is 10x candidate reads per pass, still under the App's 5,000/h at 10-minute passes; the pass's log line
  (`candidates`, `unreadable`, `merged`, `split`) warns first. Batches hold at most `TRAIN_MAX_BATCH = 8` members.
- compatibility: old clients see the merges as before (task cards, "Merged <url>" lines); nothing new on the wire.
- migration + rollback: none. Rolling back stops the worker pass; open batch PRs stay open and can be closed by hand.
- audience: only tasks of a project whose repository is approved for the App (github/projectAccess.ts); the train never
  quotes PR text from outside the repository's people into the Swarm.
- identity: every write is the App's installation token, never a person's login or the machine owner's.
- failure: a failed pass logs why; a red batch tells each failing PR's owner in its task; a conflict tells its owner
  "merge main once"; GitHub refusing a merge leaves the batch open and logs it.
- platforms: backend only.

## Review Focus

- A member whose head moved after its verdicts (a push after review): never merged; the batch rebuilds without it until
  its verdicts are at the new head (Task 3 test "verdict not at head").
- A member pushed between the batch's green CI and the merge: the re-fetch catches it (Task 4 test "moved before merge").
- A batch PR link reaching a task: never, so push-origin reads of tasks never see the bot's branch (Task 4 test).
- GitHub answering 5xx/403/malformed on any read: nothing written (Task 4 test "fail closed").
- Kill switch off mid-batch: no merge and no new batch; an open batch is left as it is (Task 4 test).

---

### Task 1: Eligibility and lanes (pure)

**Files:** Create `backend/src/superTabs/mergeTrain/plan.ts`, `mergeTrain/config.ts`; Test `mergeTrain/plan.test.ts`

**Interfaces:**
- Produces: `TrainCandidate { url; number; taskId; ownerId|null; head; draft; base; mergeable; labels; files; ciRequired: 'success'|'failure'|'pending'|null }`,
  `verdictAtHead(state, task, url, head): boolean`, `eligible(candidate, verdictOk): { ok: true } | { ok: false; why }`,
  `laneOf(files): 'fast' | 'code'`, `componentOf(files): string`, `splitRed(members): Member[][]`.
- `verdictAtHead` reads #3394's verdict fields (`CheckVerdict.head`, `.patch`, `.stale`, `Conversation.pullRequestHeads`):
  every check of the task and of each step not cancelled has a passing verdict that counts at [head]; a verdict with no
  head never counts here (fail closed). At least one review step.

- [ ] Test: open, ready, base main, verdicts at head, ci/required success, mergeable true, no `hold` label → eligible.
- [ ] Test: each failing condition alone (draft, verdict at an older head, verdict without head, a step not passed, ci
  pending/failed, mergeable null/false, `hold` label, base not main) → not eligible with its reason.
- [ ] Test: files all in `docs/`, `*.md`, `scripts/` → lane `fast`; any other → `code`.
- [ ] Test: `splitRed` of members over two components → one group per component; one component of 4 → halves; 1 → [].
- [ ] Code; commit.

### Task 2: The App's train calls

**Files:** Create `backend/src/github/train.ts`, `github/train.test.ts`; Modify `github/app.ts` (one `installationCall`)

**Interfaces:**
- Produces: `TrainGitHub` with `mainHead()`, `openPulls()`, `pull(n)`, `files(n)`, `checkRuns(sha)`, `createBranch(name, sha)`,
  `mergeInto(branch, sha, message)` → `{ sha } | 'conflict'`, `openBatch(branch, title, body)`, `squash(n, sha, title, message)`
  → `{ sha }`, `close(n, comment)`, `deleteBranch(name)`. Every unexpected status throws `TrainReadError`.
- `mergeInto` refuses (throws) when GitHub answers 204 (nothing merged) or a result equal to a member's head: the train's
  ref never points at a member's commit.

- [ ] Test (fake fetch): each call's path, method, token permissions (`contents: write, pull_requests: write, checks: read`).
- [ ] Test: 500, 403, malformed bodies throw `TrainReadError`; `mergeInto` 409 → `'conflict'`; 204 throws.
- [ ] Code; commit.

### Task 3: One pass builds batches

**Files:** Create `mergeTrain/train.ts`, `mergeTrain/fakeTrainGitHub.ts` (tests only), `mergeTrain/train.test.ts`

**Interfaces:**
- Consumes: Task 1, Task 2's `TrainGitHub`.
- Produces: `trainPass(project, github, swarm, now, rules): Promise<TrainPassLine>`; `TrainSwarm { candidates(): TaskPull[];
  merged(taskId, url, mergedAt, commit): Promise<void>; tell(taskId, key, text): Promise<void> }`.

- [ ] Test: two eligible code PRs, no open batch → one `harness-train/` branch from main with both merged in, one batch PR
  whose body lists `#N@head` per member.
- [ ] Test: a conflicting PR drops out, the rest batch, and its owner is told "merge main once" once per head.
- [ ] Test: verdict not at head → not in any batch.
- [ ] Test: a fast-lane PR merges on its own green ci/required, no batch.
- [ ] Code; commit.

### Task 4: One pass finishes batches

**Files:** `mergeTrain/train.ts`, `mergeTrain/train.test.ts`

- [ ] Test: green batch → re-fetch heads, squash with `sha`, originals closed with a comment naming the batch and merge
  commit, `merged` recorded on each task with the original's URL, batch branch deleted, no task links the batch PR.
- [ ] Test: red batch of two components → closed, two split batches open; red batch of one → its owner told, PR not
  batched again at that head.
- [ ] Test: main moved (by anything but docs) → batch closed and rebuilt from the new main.
- [ ] Test: a member pushed after green → no merge, rebuilt without it.
- [ ] Test: kill switch off → no write at all; any read failure → no write for that batch.
- [ ] Code; commit.

### Task 5: Wiring and docs

**Files:** `backend/src/superTabs/store.ts` (`trainCandidates`, `trainMerged`, `trainTell`), `backend/src/worker.ts`
(`startMergeTrain`), `AGENTS.md` (merge section), `superTabs/pullRequestEvents.ts` (keep `train-*` keys)

- [ ] Test (store): `trainMerged` records the merge like `conversation.merged` with the original URL and marks no task
  Team-written; `trainTell` posts once per key to the task's Engineer.
- [ ] Code; AGENTS.md says the train merges routine work, how to hold a PR (`hold` label), the kill switch, and that hand
  merges still work. Commit.
