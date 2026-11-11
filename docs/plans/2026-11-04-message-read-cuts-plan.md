# Faster slow message reads (task #2966) Implementation Plan

> Worked by the project's Engineer role: plan first, then each task test first (failing test committed before its code),
> one review on the pull request. No execution handoff.

**Goal:** Cut the SuperTabMessage reads in Ken's 11-04 slow log: the `$expr` read on `_id`, the `$or`-over-threads range
reads, and the getMore that returns ~419 rows, without changing what any reader is answered.

**Architecture:** (1) The stored-notice check in `store.ts writeMessages` reads by a plain `{_id: {$in}}` through the id
index (`pageReads.ts storedMessages`) instead of Prisma's `id: { in }`, which Prisma sends as `$expr`. (2) The inbox's range
reads (`read/inbox.ts`: each unread chat's rows past its mark, and each thread's rows past or before a mark through
`newestInThreads`) are bounded above by the chat's newest sequence and kept in a per-process cache (`read/rangeCache.ts`)
keyed by the exact range and the chat's `reactionSeq`, which every edit and delete bumps; a re-read of an unchanged range
reads nothing. (3) `perRange` asks for all rows in its first reply (`READ_BATCH`, as `readBy`), so a 30-chat scan is one
operation, never an aggregate plus a getMore.

**Tech Stack:** TypeScript, Prisma `aggregateRaw` on MongoDB 7, vitest, mongodb-memory-server integration tests under the
profiler (`integration/plans.test-support.ts`).

**Spec:** task #2966's brief (Ken's slow-query data, 11-04).

## Global Constraints

- Optimizations ship on, with no on/off switches (Ken).
- Swarm code stays out of `cli/src/core`.
- Read-only production for checks only, shapes and totals, never documents.
- Every new or changed query has an integration test that reads its plan: IXSCAN on its index, docs examined close to
  returned (`backend/AGENTS.md` rule 3).
- Permissions are applied after the cache: it holds the stored rows of a range, the same for every reader, and each read
  still runs `readable()` on them.
- PR body first line: "Requested by 0xken15@gmail.com through Harness."

## Review Focus

1. A message deleted or edited in a cached range: the next inbox read must not show it (reactionSeq is in the key;
   test: delete a reply, re-read, it is gone).
2. A new reply in one chat: only that chat's ranges are read again, and the reply is counted (test).
3. Two Swarms or two chats with the same mark and sequence numbers never share an entry (tabId and conversationId in the
   key; test: second Swarm reads its own rows).
4. Memory: the cache is bounded by entries and rows, oldest first out (unit test).
5. A hidden row (recipients only) numbered past `lastMessageSequence`: the upper bound is the chat's `messageSeq`, so a
   range read holds exactly the rows it held before.

---

### Task 1: The stored-notice check reads by the id index

**Files:**
- Modify: `backend/src/superTabs/pageReads.ts` (add `storedMessages`)
- Modify: `backend/src/superTabs/store.ts` (`writeMessages`)
- Modify: `backend/src/superTabs/hotFilters.allowed.json` (drop `store.ts superTabMessage.findMany`)
- Test: `backend/integration/superTabNamedReads.test.ts`

**Interfaces:**
- Produces: `storedMessages(tx: Transaction, ids: string[]): Promise<Array<{ id: string; tabId: string; conversationId: string; source: unknown }>>`

- [ ] **Step 1: Failing tests.** `hotFilters.test.ts` fails once the allowed entry is removed (the Prisma `in` is still
  there). Integration: `storedMessages` of 101 stored rows profiles as one aggregate, IXSCAN `{ _id: 1 }`, no `$expr` in
  its filter, docsExamined = returned = 101; and a Lead poll's time check that keeps a stored notice sends no `$expr` read
  on SuperTabMessage.
- [ ] **Step 2: Run them, see them fail.** `npx vitest run src/superTabs/hotFilters.test.ts`;
  `npx vitest run --config vitest.super-tabs.config.ts integration/superTabNamedReads.test.ts -t "stored notices"`.
- [ ] **Step 3: Implement** `storedMessages` with `readBy(tx, 'SuperTabMessage', 'id', [{ $match: { _id: { $in: ids } } }, { $project: { tabId: 1, conversationId: 1, source: 1 } }])`; `writeMessages` uses it.
- [ ] **Step 4: Run the tests, see them pass. Commit.**

### Task 2: perRange reads in one operation

**Files:**
- Modify: `backend/src/superTabs/read/inbox.ts` (`perRange`)
- Test: `backend/integration/superTabInbox.test.ts`

- [ ] **Step 1: Failing test** "scans 30 unread chats in one operation, never a getMore": a person with THREAD_CHATS unread
  chats of 101 rows past the mark; profiling the inbox read shows no `getmore` on SuperTabMessage and the chat scan's
  aggregate returns every row (nreturned 30 × 101).
- [ ] **Step 2: See it fail** (a getmore with the 2,929 rows past the first 101).
- [ ] **Step 3: Implement:** `perRange` passes `options: { batchSize: READ_BATCH }` (parts/indexed.ts).
- [ ] **Step 4: Pass. Commit.**

### Task 3: Range cache for the inbox's re-reads

**Files:**
- Create: `backend/src/superTabs/read/rangeCache.ts`, `backend/src/superTabs/read/rangeCache.test.ts`
- Modify: `backend/src/superTabs/read/inbox.ts` (`threadsIn` chat scan, `newestInThreads`, `namedInThreads`)
- Test: `backend/integration/superTabInbox.test.ts`

**Interfaces:**
- Produces: `class RangeCache<T> { constructor(limits: { entries: number; rows: number; ttlMs: number }, now?: () => number); get(key: string): T[] | undefined; set(key: string, rows: T[]): void; clear(): void }`,
  `rangeKey(tabId: string, conversationId: string, thread: string | null, sequence: Record<string, number>, limit: number, version: number, namedBy?: string): string`,
  `chatTop(group: Conversation): number` (max of `messageSeq` and `lastMessageSequence`), `resetRangeCache(): void` (test seam).
- `ThreadRange` gains `version: number` (the chat's `reactionSeq ?? 0`); each caller bounds `$gt` ranges with `$lte: chatTop`.

- [ ] **Step 1: Failing unit tests** (`rangeCache.test.ts`): get after set answers a copy; the oldest entry goes past
  `entries` or past `rows`; an entry past `ttlMs` is gone.
- [ ] **Step 2: Failing integration tests** (`superTabInbox.test.ts`, "re-reading the inbox"): in bigScene, a second inbox
  read with nothing changed sends no SuperTabMessage range read (no `sequence` filter); after one reply in one chat, the
  range reads name only that chat and the reply is counted; after deleting a counted reply (reactionSeq bumps), the next
  read no longer counts it; numbers printed: docs examined, returned and bytes for cold and warm reads.
- [ ] **Step 3: See them fail. Commit the tests.**
- [ ] **Step 4: Implement** `rangeCache.ts` (Map in insertion order, entries 4,000, rows 200,000, TTL 10 minutes) and use
  it in `perRange` callers of `threadsIn` and in `newestInThreads` (misses only go to the batch read; each range's rows
  stored under its key, empty ranges too).
- [ ] **Step 5: Run inbox, followed threads and named reads integration files and the touched unit tests. Commit.**
