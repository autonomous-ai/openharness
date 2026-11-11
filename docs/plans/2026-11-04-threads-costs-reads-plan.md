# Threads, costs and project GitHub reads Implementation Plan

> Implemented by the task's Engineer task by task, each failing test committed before its code (project instructions,
> Engineer). One independent review on the pull request.

**Goal:** GET /:tabId/threads answers from the stored thread summaries instead of scanning each candidate thread's newest
100 messages, and GET /:tabId/costs and GET /:tabId/projects/:projectId/github read the Swarm through `readParts` and the
read cache instead of loading it in a transaction on every request (task #2596, Ken's DB plan, group B items 1 and 2).

**Architecture:** `readFollowedThreads` (read/followedThreads.ts) keeps its candidates and root checks and replaces its
`perRange` scan with one read of `SuperTabThread` by root id (pageReads.ts, as `pageThreads` already reads them for chat
pages), judging each thread from the summary rows `threadReplies` gives. Buddy chats keep the scan: their summaries cannot
tell a row of a project the chat's person lost (buddySessions.ts lostProjectRow). `costSummary` and `projectRepository`
(store.ts) switch from `transaction` + `load` to `readLoad`, as `messages` and `mentions` read.

**Tech Stack:** TypeScript, Prisma 5 on MongoDB (aggregateRaw), Vitest with mongodb-memory-server integration suites.

**Spec:** task #2596's brief (Ken's DB plan of 2026-11-04, group B1 and B2); no separate design (no stored data changes).

## Global Constraints

- Measure before and after each item: `db by shape` (per-route bytes and ms), `route latency`, the Atlas slow log; numbers
  in the PR, aggregates only, from the read-only production login's environment file, never printed.
- A failing test first for each fix; red/green evidence in a PR comment; backend `npm test` before Ready.
- Prisma sends `in` lists as N-branch `$or` and an empty list as `$or: []` (a full scan): raw `$match` only, never an
  empty `$in`.
- `$unionWith` branches ignore hints.
- Every thread summary the apps show stays as it is, the chat tag's ask state (#2867) included: summaries are only read.
- Swarm code stays out of cli/src/core.

## Design

- growth: N/A because nothing new is stored; `SuperTabThread` rows are removed with their Swarm (purge.ts).
- concurrency: N/A because these are reads; summaries are written in the reply's transaction as before.
- read cost: threads read one small summary per candidate (by `_id`), not up to 100 messages each; costs and GitHub read
  the parts the cache's stamp says changed.
- scale: at 10x threads per person the candidates stay capped (READ_CANDIDATES + TAGGED_THREADS); `db by shape` bytes for
  `http GET /api/super-tabs/:tabId/threads` warns first.
- compatibility: the response shape is unchanged. A thread longer than 100 rows now says its full reply count, as its chat
  page's reply line does, instead of stopping at 100.
- migration + rollback: none; a rollback returns to the scan.
- audience: unchanged checks (roots by `readable`, chats the person reads, `canReadGroup` in summaries, the same
  `actor`/`visibleState`/`canReadGroup` for costs and GitHub).
- identity: N/A because no machine login is used.
- failure: a Swarm not backfilled yet falls back to `threadFacet`, as pages do; nothing is silently dropped.
- platforms: backend only.

## Review Focus

1. A thread whose newest reply is agent-only, or a delivered Lead copy: it must neither count nor move "last reply" (Task 1
   test "skips what a person never reads").
2. A Swarm whose summaries are not backfilled yet: the answer must equal the backfilled one (Task 1 test "same answer").
3. A Buddy chat thread with a lost project's row: still judged by the scan (Task 1 test "Buddy chats keep the scan").
4. An unread reply after the person's thread mark, in a thread they replied in: still "more", not listed read (existing
   tests, run on the summary path in Task 1).
5. Costs for a group named by a decision but dormant: still loaded by name through the cache (Task 2 test "same answer").

---

### Task 1: Followed threads from the stored summaries

**Files:**
- Modify: `backend/src/superTabs/pageReads.ts` (new `threadRows`, `pageThreads` on it)
- Modify: `backend/src/superTabs/read/followedThreads.ts`
- Test: `backend/integration/superTabFollowedThreads.test.ts`

**Interfaces:**
- Produces: `threadRows(tx: Transaction, tabId: string, threads: ReadonlyArray<{ conversationId: string; root: string }>):
  Promise<ThreadReply[]>`: every named thread's summary rows (threadReplies), oldest first, from `SuperTabThread` by `_id`
  in one read when the Swarm is backfilled (a stored row counts only in the conversation named for it), else from
  `threadFacet` per conversation. `pageThreads(tx, tabId, conversationId, roots)` returns `threadRows` of those roots.

- [ ] **Step 1: Write the failing tests** in the "GET /threads" profile describe:
  - "reads the candidates' summaries, never their messages, once the Swarm is backfilled": the existing long-thread scene,
    `backfillThreads(db, Date.now())`, then under the profiler: no `SuperTabMessage` read on the thread index
    (`planSummary` without `thread`), `SuperTabMessage` docsExamined ≤ 70 (roots by id), one `SuperTabThread` read with
    IXSCAN on `_id`, and `read` has 30 threads with `more: true`; a long thread says its full count (301).
  - "gives the same answer from summaries as from the thread rows": a scene with own replies, tags, an agent-only reply
    and an unread reply past the mark; `threads()` before and after `backfillThreads` are equal.
- [ ] **Step 2: Run** `npx vitest run --config vitest.super-tabs.config.ts integration/superTabFollowedThreads.test.ts`;
  expected FAIL: the thread index read is present and the long count is 100.
- [ ] **Step 3: Implement** `threadRows` and use it in `readFollowedThreads` for candidates outside Buddy chats; the
  existing scan stays for Buddy chats. Judge each thread from its rows: `replies` = rows other than the root, newest first;
  `inIt` on those rows; `seen` and the unread check from the newest own and non-own rows; the summary from
  `threadSummaries(state, group, rows)`.
- [ ] **Step 4: Run** the same command; expected PASS, with the rest of the file.
- [ ] **Step 5: Commit** test, then code.

### Task 2: Costs and project GitHub through the read cache

**Files:**
- Modify: `backend/src/superTabs/store.ts` (`costSummary`, `projectRepository`)
- Test: `backend/integration/superTabCache.test.ts`

**Interfaces:**
- Consumes: `SuperTabStore.readLoad(user, tabId, named?)` (exists).

- [ ] **Step 1: Write the failing tests** in "reads through the cache":
  - "answers costs and a project's GitHub access from the cache when the stamp did not move": with one pod, a first
    `costSummary(owner, tabId, 7)` and `projectRepository(owner, tabId, 'lead')`, then the second of each reads 0 part
    documents (`partReads`), and each answer equals a cache-off pod's.
- [ ] **Step 2: Run** `npx vitest run --config vitest.super-tabs.config.ts integration/superTabCache.test.ts`; expected FAIL:
  the second reads read parts.
- [ ] **Step 3: Implement**: both methods read `this.readLoad(...)` (costs with its decisions' `groupIds`) and
  `this.actor(this.db, ...)`, outside any transaction.
- [ ] **Step 4: Run** the same command and `integration/superTabCosts.test.ts`, `integration/superTabGithub.test.ts`;
  expected PASS.
- [ ] **Step 5: Commit** test, then code.

### Task 3: Evidence

- [ ] `npm test` and `npm run typecheck` in backend.
- [ ] Before/after numbers in the PR: the local profiler (docs examined, bytes returned) for both items, and production's
  `db by shape` / `route latency` / Atlas slow log for the two routes before and after the release.
- [ ] Red/green evidence in a PR comment.
