# Tasks feed history implementation plan

> Implemented natively by the task's Engineer, plan task by plan task, each failing test committed before its code; one
> independent review of the pull request.

**Goal:** The person's Tasks feed lists every task their own agents did, are doing or are about to do, the tasks they asked
for and their proposals, dormant and archived ones included, newest first, with a cursor for older pages (task #4203).

**Architecture:** Each stored conversation gets one indexed column, `feedIds`: the people and agents whose feed lists it,
computed from its data on every write (parts/write.ts `extracted`) and backfilled once at worker startup. A feed page is one
read of the `(tabId, feedIds, lastActivityAt, key)` index for the person and their own agents, newest activity first, 50
readable rows a page. First load sends the first page with an `olderCursor`; a new `GET /api/super-tabs/:tabId/personal-tasks`
pages older ones; change polls keep summarising only the parts that changed since the cursor, now without dropping dormant
or archived tasks.

**Tech Stack:** TypeScript backend, Prisma on MongoDB 7, vitest with mongodb-memory-server for real-store and plan tests.

**Spec:** task #4203's brief (anh Dee, 2026-11-07 06:20 VN), extending docs/plans/2026-11-07-v3-personal-tasks-plan.md.

## Global Constraints

- Backend only; ships as a backend hotfix with Desktop 1.3.88. Old clients keep working: `personalTasks` is only extended.
- Server-enforced audience: every row passes `canReadGroup` for the reader; a cursor names only a row the reader was sent.
- Own agents are the reader's by `contributorId` (as Desktop's My agents), never by machine owner; another person's Buddy is not.
- One index per query, read with explain in an integration test: IXSCAN on `feed`, documents examined close to returned.
- Bounded: 50 rows a page; at most 200 ids in the index's `$in` (the person and their 199 newest own agents).

## Review Focus

- A task of the person's agent in a project the person lost access to never reaches them, nor its id through a cursor.
- A stale membership's approval or proposal stays out, as today, even though its person id is in `feedIds`.
- A row written before this release (no `feedIds`) shows after the startup backfill, same ids as `extracted` would write.
- Paging across rows with the same `lastActivityAt` neither repeats nor skips a row.
- A dormant or archived task that changes stays in the feed on a poll; a deleted or merged one leaves it.

## Design

- Growth: one string array per conversation (≤ requester, approver, proposal senders, assignee, suggested agent: a few ids)
  and one index entry per id; deleted with the conversation (part tombstone purge). Prod 2026-11-07: 4,612 SwarmGroup rows,
  26.4 MB data, 3.8 MB in 15 indexes; this index adds about 2 entries a row (~0.3 MB).
- Concurrency: no new lock; the column is written in the same guarded part write as the data.
- Read cost: first load adds one indexed read of ≤ 50 rows; a page is the same; polls read only changed parts, as today.
- Scale: 10x is ~46k rows; a page still reads the 50 it returns. The first warning is the feed read's p95 in the read timing.
- Compatibility: `olderCursor` and the new row fields are additions; `at` becomes the last activity time (clients only sort by it).
  Clients from the last 30 days ignore what they don't read. Older backends never send `olderCursor`. Shape agreed with Desktop's Taskcards (#4204); Desktop picks project colours.
- Migration and rollback: `db push` adds the index; the worker's startup backfill sets `feedIds` on rows without it. A
  rollback leaves an unused column and index; nothing reads them.
- Audience: `canReadGroup` on every row before it counts toward a page; cursor from the last row sent.
- Identity: own agents by `contributorId`; the machine owner's login is never read.
- Failure: a bad cursor is `INVALID_CURSOR` (400, "Ask for the first page again."); the backfill logs how many it set.
- Platforms: backend (Linux); clients unchanged on every platform.

### Task 1: The feed column, its index and backfill

**Files:** Modify `backend/src/superTabs/read/personalTasks.ts` (add `feedIdsOf`), `backend/src/superTabs/parts/write.ts`
(`extracted`), `backend/prisma/schema.prisma`, `backend/src/superTabs/parts/indexed.ts` (`GROUP_INDEX.feed`),
`backend/src/superTabs/archive.ts` or a new `backend/src/superTabs/read/feedBackfill.ts`, `backend/src/worker.ts`.
Test: `backend/src/superTabs/read/personalTasks.test.ts`, `backend/integration/superTabPersonalTasksFeed.test.ts`.

**Interfaces:** Produces `feedIdsOf(group: Conversation): string[]` (unique ids; `[]` for a kind, audience or step);
`markFeedIds(db: PrismaClient): Promise<number>`; `GROUP_INDEX.feed = { tabId: 1, feedIds: 1, lastActivityAt: 1, key: 1 }`.

- [ ] Failing tests: `feedIdsOf` lists requester, approval person, suggested agent, proposal senders and assignee once each,
  and nothing for a buddy chat, private chat or step; the backfill gives an old row the same ids `extracted` writes.
- [ ] Run them; record red.
- [ ] Implement; run them green; commit.

### Task 2: Feed pages, first load and the older-page read

**Files:** Modify `backend/src/superTabs/parts/load.ts` (`loadFeed`), `backend/src/superTabs/read/personalTasks.ts`,
`backend/src/superTabs/read/service.ts`, `backend/src/superTabs/read/contract.ts`, `backend/src/routes/superTabs.ts`.
Test: `backend/integration/superTabPersonalTasksFeed.test.ts`, `backend/integration/superTabRead.test.ts`.

**Interfaces:** `loadFeed(tx, tabId, ids: string[], before?: { lastActivityAt: number; key: string }): Promise<Part<GroupData>[]>`;
`PersonalTasks.olderCursor?: string | null`; `SwarmReads.personalTasks(user, tabId, before?): Promise<PersonalTasks>`;
`GET /api/super-tabs/:tabId/personal-tasks?before=`.

- [ ] Failing tests: first load lists a dormant archived task of the person's own agent and their own proposal, newest first,
  with `olderCursor`; the next page continues with no repeat; another member's view and an outsider's never list it; a hidden
  project's task never shortens a page nor names the cursor; the read plan is IXSCAN `feed` with examined ≈ returned.
- [ ] Run them; record red.
- [ ] Implement; run them and the read tests green; commit.

### Task 3: Row fields and live updates

**Files:** Modify `backend/src/superTabs/read/personalTasks.ts`. Test: `backend/src/superTabs/read/personalTasks.test.ts`.

**Interfaces:** `PersonalTask` gains `requester: { id, name, avatar? } | null` and optional `pullRequestUrl` (newest linked);
`at` is `lastActivityAt` in ms.

- [ ] Failing tests: a poll keeps a dormant or archived own task and a task of the person's agent requested by someone else;
  removes deleted, merged and no-longer-own ones; rows carry requester, newest pull request and canApprove.
- [ ] Run them; record red.
- [ ] Implement; run them green; commit; mark the pull request ready.
