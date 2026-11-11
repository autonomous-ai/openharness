# A reply updates its thread summary without re-reading the thread Implementation Plan

> Implemented by the task's Engineer task by task, each failing test committed before its code (project instructions,
> Engineer). One review on the pull request, focused on concurrent replies and on edits and deletes.

**Goal:** A reply updates its thread's stored summary (`SuperTabThread`) from its own new rows, not by re-reading every row of
the thread, so a reply in a 500-reply thread examines a few documents instead of ~500 (task #2974, from Ken's slow-query data
of 2026-11-04: the `$match {tabId, conversationId, thread}` shape is 7% of slow message time at peak and 19% in the evening;
traced by task #2966 to `refreshThreads`).

**Architecture:** A summary is what `threadFacet`'s `$group` gives a thread's rows: per part (one author and one kind of row)
its count, oldest and newest row; per tagged person and part, the first tag. Each of those folds: count adds, oldest is a
min, newest a max, a first tag a min. So the send transaction reads the stored summaries of the threads it replies in by
`_id`, sums up only the rows it just inserted with the same `$group` (matched by `_id`), and writes the fold. A thread with no
stored summary yet (its first reply, or a Swarm not yet backfilled) is counted whole once, as today. Deletes keep the full
recount (`refreshThreads`), as do the backfill (repair) and a deleted root kept for its replies. An edit changes only a row's
text and `editedAt`, which no summary holds, so it writes nothing.

**Tech Stack:** TypeScript, Prisma 5 on MongoDB (raw aggregations and commands), Vitest (unit + mongodb-memory-server
integration).

**Spec:** task #2974's brief. MongoDB schema design skill (Computed pattern, "update on write") and query optimizer skill
(update examples) read 2026-11-04.

## Global Constraints

- Correctness first: after any reply, edit, delete or two concurrent replies, a thread's stored summary equals what
  `refreshThreads` would write from its rows (parts and tags, in any order).
- The fold runs in the send's transaction. Two replies at once both write the same summary document, so Mongo's write
  conflict makes one transaction run again (store.ts `transaction`), which re-reads the summary the other committed.
- Matched by `_id` through the `id` index (parts/indexed.ts readBy), never by `{tabId, conversationId, thread}`.
- Stored document shape unchanged: `{ _id, tabId, conversationId, parts, mentions, updatedAt }`, parts and tags as the `$facet`
  returns them. Integration tests pin it against the full rebuild.
- `refreshThreads` stays the full rebuild: the backfill (threadBackfill.ts) and deletes use it.
- Backend only. Swarm code stays out of cli/src/core.
- PR body first line: "Requested by Ken through Harness." (the brief's line).

## Design

- growth: no new data. One summary per thread with a reply, as now; deleted with its Swarm (purge) or when its last reply goes.
- concurrency: document level. Every reply writes its thread's summary in its transaction; a concurrent reply's write
  conflicts and its transaction runs again. Replies also write their conversation's group part (messageSeq), so they were
  already serialized per conversation.
- read cost: per reply, the thread's summary by `_id` (1 doc) and the new rows by `_id` (1 per new row). Before: every row of
  the thread.
- scale: 10x replies cost 10x a few documents. A summary grows with distinct (author, kind) parts and tagged people, not with
  replies. Warning metric: docs examined per `SuperTabMessage` aggregate in the slow-query log, and `SuperTabThread` document
  size.
- compatibility: older backends still recount whole and write the same shape; summaries they leave behind fold correctly. A
  reply an older release wrote without a summary update is repaired by the 15-minute backfill, as today.
- migration + rollback: none; same stored shape. A rollback recounts whole again.
- audience: unchanged; readers filter summaries as today (threadReplies).
- identity: N/A because no actor is read or written beyond the rows' own authors.
- failure: a fold's error aborts the send's transaction as any write does; nothing is half-written.
- platforms: backend only.

## Review Focus

- Two concurrent replies in one thread: both counted, newest is the later one.
- A reply whose part (author + kind) is new to the thread, and one whose part exists.
- Tags: a person first tagged in the new reply, and one tagged before.
- Deletes and edits after folded replies leave the rebuild's summary.

## Task 1: Cost — a reply reads a few documents, not the thread

**Files:** Test `backend/integration/superTabThreads.test.ts`. Modify `backend/src/superTabs/pageReads.ts`.

**Interfaces:**
- `foldReplies(tx, tabId, conversationId, roots: string[], ids: string[]): Promise<ThreadFacet>`: folds the rows `ids`, just
  inserted and replying in `roots`, into those threads' summaries; a root with no summary is counted whole
  (refreshThreads). Answers the threads' whole facets, as refreshThreads does.
- `refreshReplies` calls `foldReplies` instead of `refreshThreads`.

- [ ] Write a failing test: a backfilled 500-reply thread; one `message.send` reply, profiled. No `SuperTabMessage` read is
  matched by `thread`, and the reply's `SuperTabMessage` docs examined total at most a few. Print before/after numbers.
- [ ] Run it, watch it fail (~500 docs examined).
- [ ] Implement `foldReplies` (summaries by `_id`, new rows' `$group` by `_id`, fold, `$set`), and call it from
  `refreshReplies`.
- [ ] Run the thread and index integration tests.

## Task 2: Correctness — folds equal the full rebuild

**Files:** Test `backend/integration/superTabThreads.test.ts`, `backend/src/superTabs/pageReads.test.ts` (new, the pure fold).
Modify `backend/src/superTabs/pageReads.ts`.

**Interfaces:** `foldFacet(stored: ThreadFacet, added: ThreadFacet): ThreadFacet` (pure).

- [ ] Write failing unit tests for `foldFacet`: a new part, an existing part (count adds, oldest stays, newest moves), a new tag,
  an earlier tag kept, part keys compared by value whatever their field order.
- [ ] Write failing integration tests: replies of every kind in the scene (plain, note to an agent, route row, tag, Buddy
  session) leave the stored document equal to the full rebuild's (shape pinned); an edit leaves it unchanged; deleting the
  newest, the oldest and the only reply of a part, and the last reply, leave the rebuild's summary (or none); two concurrent
  replies, both past the summary read before either writes, leave both counted.
- [ ] Watch them fail, then make them pass.
- [ ] Run the thread, message edit, activity and index integration tests.
