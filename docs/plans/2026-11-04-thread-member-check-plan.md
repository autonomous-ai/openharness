# Thread member check from summaries: implementation plan

> Implemented by its Engineer task by task, test first (project instructions, Engineer role). No per-task review: the
> review step on the pull request is the one independent review.

**Goal:** The threads route (GET /api/super-tabs/:tabId/threads) and the inbox stop reading each candidate thread's
history to learn whether the person is in it, so their cost no longer grows with thread length and count (task #2768,
Ken's production scan of 11-04: the `$or` of `{tabId, conversationId, thread, sequence: {$lte}}` branches, 762 slow
in 2 h, and the per-thread `$unionWith` fallback, 70 slow).

**Finding:** the slow shape is not `pageReads.ts threadFacet` or `threadsAcross`. It is `read/inbox.ts
newestInThreads` called with `sequence: {$lte: mark}` and `namedBy`: the member check. It runs in `threadsIn` (the
inbox, which the threads route reads first) for every unread thread the person is not visibly in, and in
`read/threadMarkSeeds.ts moveChatMark` when a chat read moves the mark. Each call reads up to `max(100, 100 × N / 4)`
history rows in one `$or` of N branches, and past that cap it reads again with one `$unionWith` branch per thread.

**Architecture:** a new `inbox.ts namedInThreads` answers "which of these threads did the person write in or get tagged
in, in rows a page shows them" from the threads' summaries (`pageReads.ts threadsAcross`): one read of
`SuperTabThread` by `_id`, one small row per thread, whatever its length. A summary keeps each author's newest row and
every person's first tag, with what each reader skips marked (`agentOnly`), so the answer is the old one without the
100-row look-back. A Swarm Buddy chat's threads keep the message scan, as followed threads do: its summary cannot tell
a row of a project its person lost (`buddySessions.ts lostProjectRow`). A Swarm not backfilled yet falls back to
`threadFacet`, as pages do, until the worker marks it.

**Tech Stack:** TypeScript, Prisma `aggregateRaw`, MongoDB profiler in integration tests, vitest.

**Spec:** task #2768 brief.

## Global Constraints

- No production access: Ken's numbers are the before; local profiler counts are in the pull request.
- No index change: `SuperTabThread` is read by `_id`.
- No env switch. Audience unchanged: the candidates, roots and their checks are the same; only how membership is
  learned changes.
- Answers: identical, except a thread the person wrote in or was tagged in more than 100 rows before their mark now
  counts as one they are in (the look-back cap), as the Threads view's read threads already do since #2889.

## Review Focus

- The membership answer: own rows and tags in rows a page shows the person, agent-only and delivered copies left out.
- The Swarm Buddy chat exception, and the not-yet-backfilled fallback.
- The profiler test's bounds and that it fails on main.

## Design

- growth: N/A because nothing new is stored.
- concurrency: N/A because it is a read.
- read cost: one `SuperTabThread` read by `_id` for at most CANDIDATE_THREADS (inbox) or SEED_THREADS (mark seeds)
  roots, in place of up to 100 rows per thread plus a union.
- scale: 10× threads is 10× small summary rows by `_id`; the first warning is docs examined on `SuperTabThread`.
- compatibility: N/A because the answer shape is unchanged.
- migration + rollback: N/A because there is no data change; rollback restores the scan.
- audience: the server enforces it: membership only decides which readable threads are listed.
- identity: N/A.
- failure: a missing summary counts as not in the thread, as a thread with no rows did.
- platforms: N/A (backend only).

## Task 1: Member check from summaries

**Files:** `backend/src/superTabs/read/inbox.ts`, `backend/src/superTabs/read/threadMarkSeeds.ts`,
`backend/integration/superTabFollowedThreads.test.ts`

- [ ] Failing integration test: a chat of 60 threads, 10 of them 300 rows long, where the person wrote or was tagged
  in some and not others, each with an unread reply past the chat mark: the threads read lists the same threads as
  before, reads no message by the thread index, and reads the summaries once by `_id`.
- [ ] Failing test: a person who replied 150 rows back is in the thread.
- [ ] Implement `namedInThreads`; use it in `threadsIn` and `moveChatMark`; run the followed threads, threads, inbox
  and read-mark integration tests and the backend unit suite.
