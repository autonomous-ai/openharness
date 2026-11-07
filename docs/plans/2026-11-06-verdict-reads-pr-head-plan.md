# A verdict reads the pull request's current head: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** A check verdict at the pull request's real head counts even when the Swarm's recorded head is stale; a verdict at
an older head still does not (task #3628, requested by Dee through Harness). On #3561 (PR #3293) a Yes at 316d374, the real
head, did not count twice because the record still said 3a82e08, then 189afb1: the minute PR watch had not read the push yet.

**Architecture:** The PR watch (pullRequestEvents.ts) stays the one writer of `Conversation.pullRequestHeads`
(store.ts `pullRequestSeen`). A new function, `readPullRequestsNow`, runs the watch's read for one task's chosen pull
requests at once: GitHub's pull request, its patch id when the head is new, whether it is git's own main merge, then
`pullRequestSeen`, which records the head and re-derives the checks of the task and its steps. The store calls it:

- before a `work.check` whose `head` (or `base`) is not the record's for the verdict's pull request, outside the command's
  transaction, as `pullRequestFilesFor` reads GitHub; the command then judges against the fresh record;
- after a task's Ready (`work.status` review) commits, for the pull requests the Ready names that the task links (else its
  newest link), so the record is current when its Reviewers start.

A new store hook, `pullRequestReader`, gives it the GitHub App reader the worker's watch uses (`appPullRequestWatch`).

GitHub sends the backend no push webhook (pullRequestEvents.ts header): "the GitHub push event" is the watch's minute read
of a new head, which already records it. The verdict-time read covers the minute between.

**Tech Stack:** TypeScript backend (vitest, Mongo integration suite).

**Spec:** task #3628 brief.

## Global Constraints

- Verdicts count only at the exact head on the base they name, or the same patch, or a carried main merge (#3218): unchanged.
  The read only makes the record GitHub's head; it never makes a head count that GitHub does not show.
- A read that fails, or no GitHub App, leaves the record as it is and the command runs as before; it is logged.
- No new refusal. Swarm code stays out of cli/src/core. Owns backend/src/superTabs/ and backend/src/github/.

## Design

- growth: N/A because nothing new is stored: the read writes the same `pullRequestHeads` the watch writes (kept by `keepHead`).
- concurrency: `pullRequestSeen` is its own transaction on the task, as the watch's; the command's transaction loads after it.
- read cost: one pull request read per `work.check` whose head differs from the record (none when it matches), plus a
  patch and merge read only for a new head; a Ready reads the pull requests it names (ETag reads, as the watch).
- scale: 10x checks means 10x reads only for mismatched heads; the warn line counts failed reads first.
- compatibility: old clients send no head: no read, as before. The hook is optional.
- migration + rollback: none; reverting the code returns to minute-only reads.
- audience: the read runs for a caller the Swarm load admits; the command still checks who may record a verdict.
- identity: the Harness GitHub App's read-only token per read, revoked after, as the watch's.
- failure: a failed read is logged (`[swarm-pr-head] not read`) and the verdict is judged on the record, as before.
- platforms: backend only.

## Review Focus

- A verdict at an old head never counts after the read (GitHub's head is newer).
- The read cannot move the record to a head GitHub does not report.
- Steps' checks are re-derived with the task's (dormant steps load).

## Task 1: a verdict at the real head counts when the record is stale

**Files:** backend/integration/superTabPullRequestEvents.test.ts, backend/src/superTabs/pullRequestEvents.ts,
backend/src/superTabs/store.ts, backend/src/routes/superTabs.ts

**Interfaces:** `readPullRequestsNow(db, store, reader, tabId, task, urls, now)`; hook `pullRequestReader?: () => PullRequestReader`.

- [x] Test: record at HEAD, GitHub at HEAD3, a Yes at HEAD3 counts on the task and its step, and the record is HEAD3.
- [x] Test: record at HEAD, GitHub at HEAD3, a Yes at HEAD2 (older, never recorded) does not count; the record is HEAD3.
- [x] Test: a failed read leaves the record and judges as before.
- [x] Watch them fail; commit.
- [x] Implement the read before `work.check`; watch them pass; commit.

## Task 2: Ready reads the head

**Files:** same.

- [x] Test: record at HEAD, GitHub at HEAD3, the Engineer's Ready leaves the record at HEAD3.
- [x] Watch it fail; commit (with Task 1's tests, same file).
- [x] Implement the read after Ready commits; watch it pass; commit.
