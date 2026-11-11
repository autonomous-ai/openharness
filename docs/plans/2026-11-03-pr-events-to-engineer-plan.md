# Pull request events reach the task's Engineer Implementation Plan

> Worked by this project's instructions (Engineer role): plan first in a draft pull request, then each task test first
> (failing test committed before its code), one independent Review step on the pull request. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** A GitHub event on an open task's pull request (CI failed, CI passed, a review or comment, a merge conflict) lands
once, within about a minute, as a plain message in that task addressed to its current Engineer.

**Architecture:** There is no GitHub webhook receiver today, and the app's webhook is not configured, so this polls. It
works the way the archive pass does (`superTabs/archive.ts`): a pass in the singleton worker, every 60 s, reads the open
task groups that link pull requests and asks GitHub about each pull request through the Harness GitHub App. The token is
read-only (`pull_requests`, `checks` and `metadata` read, all of them permissions the app already holds:
`TOKEN_PERMISSIONS`). Conditional requests (ETag, `If-None-Match`) keep idle pull requests at 304s, which GitHub does not
count against the rate limit. A pure function turns what GitHub says into events, each with a stable key. A store write
then posts the events the group has not seen, to the task's owner (`steps.ts ownerOf`), and records their keys on the
group, all in one transaction, so a retry or a second worker pass posts nothing twice.

**Tech Stack:** TypeScript, Prisma/MongoDB, vitest (unit, and integration with mongodb-memory-server), the existing
`GitHubApp` and `fakeGitHub`.

**Spec:** Task #1891 brief (Dee, part 1; River, 2026-11-03), in the pull request body.

## Global Constraints

- No new GitHub App permissions without Ken's go: only `pull_requests: read`, `checks: read`, `metadata: read`, all already granted to the app.
- One message per event per head: no repeats on retries.
- Messages in plain words, with the pull request link and the failing job name.
- None when the task has no live Engineer. Merges stay in the PM's 30-minute batch: nothing here merges.
- PR body first line: "Requested by dee@autonomous.ai through Harness."
- Before Ready: a test that fails without the fix for every risk named, red/green evidence in a PR comment, the full Super Tab integration suite.
- Swarm code stays out of cli/src/core.

## Design

- **Events and keys** (head = the pull request's head SHA, short form in text):
  - `ci-red:<head>`: the first latest-per-name check run on the head that concluded `failure`, `timed_out`, `cancelled`,
    `action_required` or `startup_failure`. This one message covers both "a failed check" and "CI finished red": it goes
    as soon as one job fails, without waiting for the rest, and names every job failed so far.
  - `ci-green:<head>`: every check suite on the head that has check runs is `completed`, and every latest check run
    concluded `success`, `neutral` or `skipped`.
  - `review:<id>`: a submitted pull request review (any state) by someone other than the app's bot. Its inline comments
    belong to it, so they make one message.
  - `comment:<id>`: a conversation comment on the pull request by someone other than the app's bot.
  - `conflict:<head>`: `mergeable === false`. A `null` (GitHub still computing) says nothing this pass.
- **Drafts:** no CI event while the pull request is a draft (this repo's drafts skip checks and fail `ci/required` by
  design). The first pass that sees a head as ready records `ready:<head>:<ms>`. Failed runs that completed before that
  time are the draft's and are ignored, so a stale draft failure never reads as red once the PR is marked ready.
- **First sight:** the first time a group's pull request is read, every current key is recorded as seen and nothing is
  posted, except a conflict. Deploying this, or linking a PR, never replays old reviews or CI. A conflict is still
  something to act on, so it posts.
- **Who hears:** the task group itself (never a step), open (`workFinished: false`, not archived, not deleted), active in
  the last 7 days, linking at least one PR. The message goes to `ownerOf(state, task)`. With no owner, the keys are
  recorded and nothing is posted. Author: the project's Lead agent, else the owner itself (as `stepEndedRows`).
  `source: { kind: 'system' }`, so clients draw it as a system line.
- **Storage:** `Conversation.pullRequestEvents?: Record<url, string[]>`, the newest 50 keys per URL.
- **growth:** at most 50 short keys per linked PR per open task. They go with the group's data when it archives.
- **read cost:** one aggregate per pass on `[workFinished, archived, lastActivityAt]`, projecting a few fields. Per PR:
  pull, check runs, check suites, reviews and comments, conditional. 304s are free.
- **concurrency:** the write loads the group in a transaction and recomputes what is new from the stored keys, so two
  passes, or a retry, post once. One pass runs at a time per worker (as the archive's does).
- **failure:** a PR GitHub cannot read (app not installed, error) is skipped this pass, logged once per pass. One group's
  failed write never stops the pass.
- **compatibility:** no schema change, and no client change (a system line with a link, delivered like any message).
- **rollback:** remove the pass. The stored keys are inert.
- **audience:** the message goes to the task's own Engineer in the task's own chat. Review and comment text is the
  public PR's, quoted up to 300 characters.

## Standards (ENGINEERING.md, MongoDB skills)

- **4, push over polling: broken on purpose.** No GitHub webhook reaches the backend, and the app has no webhook URL or
  secret configured. Adding them is an app change that needs Ken's go. What replaces push: one pass a minute, conditional
  reads, so an unchanged pull request costs a free 304 and posts nothing. It reads only open tasks active this week, and
  at most `WATCH_GROUPS` (200) of them, the most recently active first. To be replaced by the app's `pull_request`,
  `pull_request_review`, `issue_comment` and `check_suite` webhook events once Ken approves; the pass then goes.
- **4, every query served by an index; nothing grows without a bound.** The pass's one read is an aggregate on
  `[workFinished, archived, lastActivityAt]`: equality, equality, then the range, with `$sort` on the range field and
  `$limit` (Equality, Sort, Range; the sort comes from the index). `data.*` and `deleted` filter the fetched documents.
  A plan test pins IXSCAN and the documents examined (`integration/workerIndexPlans.test.ts`). No new index. Keys
  stored: at most 50 per linked pull request, on the group, gone with it.
- **MongoDB schema design:** the keys are embedded in the group's data, as the skill's rule for a bounded array read and
  written with its parent: the store write already loads the group, and an event and its key change in one write.
- **6, failures are seen.** A pull request GitHub cannot read is counted, and each pass that could not read one, or
  posted something, logs one `[swarm-pr-events] pass` line with `groups`, `pulls`, `unreadable` and `posted`. Every
  GitHub call has the app's request timeout. A write runs once per event, however often it is retried.
- **8, measurable:** that same line is the measure.
- **10, platforms:** backend only (the worker). Clients draw the messages as any system line.

## Review Focus

- A draft PR's stale failed `ci/required` must not post "CI failed" in the minute after the PR is marked ready, before the new runs exist. (Task 1 test `ignores a draft's failure on the same head`.)
- A force-push (new head) must post that head's CI and conflict once, even when the old head's were already posted. (Task 1 test `a new head is news again`.)
- A worker restart, or two passes at once, must not post again: dedup lives in the group, not in memory. (Task 3 test `a second pass and a retried write post nothing`.)
- The app's own comments (the Engineer's red/green comment pushed with the app's token) must not wake the Engineer. (Task 1 test `skips the app's bot`.)
- A task whose Engineer left must post nothing, and must not flood a new Engineer later with what happened before them. (Task 3 test `no Engineer: recorded, not posted`.)

---

### Task 1: events from what GitHub says

**Files:**
- Create: `backend/src/superTabs/pullRequestEvents.ts`
- Test: `backend/src/superTabs/pullRequestEvents.test.ts`

**Interfaces:**
- Produces:
  - `interface PullRequestWatch { url: string; number: number; state: 'open' | 'closed'; draft: boolean; head: string; base: string; mergeable: boolean | null; checkRuns: Array<{ name: string; status: string; conclusion: string | null; completedAt: number | null }>; checkSuites: Array<{ status: string; runs: number }>; reviews: Array<{ id: number; login: string; state: string; body: string; url: string }>; comments: Array<{ id: number; login: string; body: string; url: string }> }`
  - `interface PullRequestEvent { key: string; text: string }`
  - `pullRequestEvents(watch: PullRequestWatch, seen: readonly string[], botLogin: string | null, now: number): { events: PullRequestEvent[]; keys: string[] }`: `keys` is the new full seen list (newest 50), including the `ready:` mark. `events` are the ones to post (empty on first sight, `seen` empty, except a conflict).

- [ ] **Step 1: Write the failing tests:**
  - `posts CI failed with the failing job names`: a check run failed → one event `ci-red:<head>`, its text `CI failed on your pull request #12 (head abc1234): build (ubuntu), ci/required. <url>`.
  - `posts CI passed once every suite is done`: suites all completed, runs all success → `ci-green:<head>`, with text `CI passed on your pull request #12 (head abc1234). <url>`. With one suite `in_progress` → nothing.
  - `posts a review once`, `posts a comment once`, `skips the app's bot`.
  - `posts a merge conflict`: text `Your pull request #12 has a merge conflict with main (head abc1234): merge main into its branch and push. <url>`.
  - `first sight records and posts nothing but a conflict`.
  - `a draft posts no CI`, `ignores a draft's failure on the same head` (ready mark newer than the failed run's completedAt → no red), `a new head is news again`.
  - `keeps the newest 50 keys`.
- [ ] **Step 2: Run** `npx vitest run src/superTabs/pullRequestEvents.test.ts`. Expect FAIL (module missing).
- [ ] **Step 3: Implement** `pullRequestEvents` as designed above. Review text: `<login> asked for changes on|approved|reviewed your pull request #12: "<body, 300 chars>" <url>`. Comment text: `<login> commented on your pull request #12: "<body, 300 chars>" <url>`.
- [ ] **Step 4: Run** the same command. PASS.
- [ ] **Step 5: Commit** the test, then the code.

### Task 2: the GitHub read

**Files:**
- Modify: `backend/src/github/app.ts` (add `PULL_WATCH_PERMISSIONS`, `watchPullRequest`, conditional GETs)
- Modify: `backend/src/github/fakeGitHub.ts` (pulls with head, draft and mergeable; check runs; check suites; reviews; comments; ETag and 304)
- Test: `backend/src/github/app.test.ts`

**Interfaces:**
- Consumes: `PullRequestWatch` (Task 1).
- Produces:
  - `PULL_WATCH_PERMISSIONS = { pull_requests: 'read', checks: 'read', metadata: 'read' } as const`
  - `GitHubApp.watchPullRequest(repository: GitHubRepository, number: number, token: string): Promise<PullRequestWatch | null>`: null when GitHub cannot say. Remembers each path's ETag and body (at most 2,000 paths) and sends `If-None-Match`. A 304 reuses the body.

- [ ] **Step 1: Write the failing tests:** `watchPullRequest reads the pull, its head's check runs and suites, reviews and comments`; `asks again with If-None-Match and reuses a 304's body`; `a failed read is null`; `the watch token holds only pull_requests, checks and metadata read`.
- [ ] **Step 2: Run** `npx vitest run src/github/app.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** Paths: `/pulls/{n}`, `/commits/{head}/check-runs?per_page=100`, `/commits/{head}/check-suites?per_page=100`, `/pulls/{n}/reviews?per_page=100`, `/issues/{n}/comments?per_page=100`. `call` takes optional extra headers and returns the `etag`.
- [ ] **Step 4: Run.** PASS.
- [ ] **Step 5: Commit** the test, then the code.

### Task 3: the store write and the worker pass

**Files:**
- Modify: `backend/src/superTabs/model.ts` (`Conversation.pullRequestEvents?: Record<string, string[]>`)
- Modify: `backend/src/superTabs/store.ts` (`pullRequestSeen`)
- Modify: `backend/src/superTabs/pullRequestEvents.ts` (`watchPullRequests`, `startPullRequestWatch`, `appPullRequestWatch`)
- Modify: `backend/src/worker.ts` (start it next to the archive pass)
- Test: `backend/integration/superTabPullRequestEvents.test.ts` (new; added to `vitest.super-tabs.config.ts`)

**Interfaces:**
- Consumes: `pullRequestEvents`, `PullRequestWatch` (Task 1), `watchPullRequest` (Task 2).
- Produces:
  - `SuperTabStore.pullRequestSeen(tabId: string, groupId: string, watch: PullRequestWatch, botLogin: string | null): Promise<number>`: messages posted.
  - `interface PullRequestReader { watch(url: string): Promise<PullRequestWatch | null>; botLogin(): Promise<string | null>; done(): Promise<void> }`
  - `watchPullRequests(db: PrismaClient, store: Pick<SuperTabStore, 'pullRequestSeen'>, reader: PullRequestReader, now: number): Promise<number>`
  - `startPullRequestWatch(db, store, reader: () => PullRequestReader, everyMs = 60_000): () => void`

- [ ] **Step 1: Write the failing tests** (a Swarm with a Lead, a task assigned to a worker agent, the PR linked by its `work.status`, and a fake reader):
  - `CI red, CI green, a review and a conflict each post one message to the Engineer`: after a first pass (baseline), each change posts one message, to `recipientIds: [worker]` in the task, with the PR link and the job name.
  - `a second pass and a retried write post nothing`.
  - `no Engineer: recorded, not posted` (agent removed), and a later Engineer hears only new events.
  - `a step, a finished task and an archived task are not read`.
- [ ] **Step 2: Run** `npx vitest run --config vitest.super-tabs.config.ts integration/superTabPullRequestEvents.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** The pass's aggregate: `{ workFinished: false, archived: false, deleted: false, lastActivityAt: { $gte: now - 7 days }, 'data.reviewOf': { $not: { $type: 'string' } }, 'data.pullRequestUrls.0': { $exists: true } }`. It reads each URL once per pass. The write loads the group (`loadRow` with `groupIds`), skips a group that has ended, computes `pullRequestEvents`, writes the rows (`numberMessages`, `writeMessages`) and saves the keys. Nothing is saved when the keys did not change.
- [ ] **Step 4: Run** the file, then `npm run test:super-tabs`, `npx vitest run src/superTabs src/github` and `npx tsc --noEmit`. PASS.
- [ ] **Step 5: Commit** the test, then the code.
