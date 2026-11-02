# Inbox thread ranges: one hinted read instead of a planned union Implementation Plan

> **Way of working:** by this project's instructions: each failing test committed before its code, then one independent review of the pull request.

**Goal:** The inbox's and the mark-read seed's reads of up to 100 thread ranges stop racing two query plans per range, with the same answers.

**Architecture:** A new `newestInThreads` reads one batch of thread ranges in one aggregate: a `$or` of the ranges, hinted to the thread index, each thread's newest rows kept by `$topN`. A batch that would read more rows than a cap falls back to today's union, which bounds each thread by its own limit.

**Tech Stack:** TypeScript, Prisma `aggregateRaw` on MongoDB 8, Vitest integration tests with a real replica set.

**Spec:** Task #2148, from Ken's production profile of 2026-11-02, 10:50-12:38 UTC.

## What production showed (read-only login, 100 busiest threads of one Swarm)

| | Union of 100 (today) | One hinted `$or` |
|---|---|---|
| Plans rejected | 100, one per range | 0 |
| Planning time in explain | 200 ms (Ken's slowest: 201 ms) | 3 ms |
| Execution time in explain | 112 ms | 30 ms |
| Median time on the primary, less the round trip | about 265 ms | about 55 ms |
| Rows read, rows answered | 1706, 175 | 1706, 175, the same rows |

A hint on the aggregate reaches only its first pipeline, never a `$unionWith` branch, so the union can't be hinted. Naming `thread` in the `$sort` changes nothing: the planner drops a field the filter fixes. The largest thread in production has 69 rows, so the limit of 100 per thread does not bind today.

## Global Constraints

- PR body starts with: Requested by ken15@autonomous.ai through Harness.
- No production write. No index is created: the thread index exists.
- The read-only production login comes only from its environment file, and no ids or content are printed.
- Full Super Tab integration suite before Ready.

## Design

- **Growth:** nothing is stored.
- **Concurrency:** N/A because these are reads, outside any transaction, as before.
- **Read cost:** one aggregate per 100 ranges, as today. It reads each thread's rows in its range, up to a cap for the batch of a quarter of what its ranges' limits allow (at least one limit), and then keeps each thread's newest rows. Only a batch over the cap pays again: at most 1.25 times what the union alone can read for 4 or more ranges, and up to twice for fewer.
- **Scale:** at 10x thread length, more batches pass the cap and take the union, which costs what it costs today. The fallback log line (info level, one per batch) is the first sign, as a rate in the logs; nothing alerts on it.
- **Compatibility:** N/A because no client or stored shape changes; the answers are the same rows in the same order.
- **Migration and rollback:** none; reverting restores the union.
- **Audience:** unchanged. Every row still goes through `readable`, and the caller has checked the person reads the chats.
- **Identity:** the person's id is passed as a literal to the look-back's filter, as a value and never as a field path.
- **Failure:** a missing index reads without the hint, as `readBy` does and says. An index removed since the last listing fails once and reads again.
- **Platforms:** backend only.

## Review Focus

- The answers: a thread longer than its limit, a tag older than the limit, ranges bounded above and below, a batch over the cap.
- Row order: the callers take `rows.slice(0, UNREAD_SCAN)` newest first.
- The filter in `$filter` against the old `$match`: author and mentions.

---

### Task 1: Pin the answers and the read's shape

**Files:**
- Test: `backend/integration/superTabInbox.test.ts`

**Interfaces:**
- Consumes: `newestInThreads(db, tabId, ranges, limit, namedBy?)`, `perRange(db, pipelines)`.

- [ ] **Step 1: Write the failing tests:** the same rows as one pipeline per thread, in every case above; one operation, hinted, with no `$unionWith`.
- [ ] **Step 2: Run to verify they fail.** Run: `npx vitest run --config vitest.super-tabs.config.ts integration/superTabInbox.test.ts`. Expected: FAIL, `newestInThreads` does not exist.
- [ ] **Step 3: Commit.**

### Task 2: One hinted read per batch

**Files:**
- Modify: `backend/src/superTabs/read/inbox.ts`, `backend/src/superTabs/read/threadMarkSeeds.ts`

- [ ] **Step 1: Implement `newestInThreads`,** and use it for the inbox's thread reads and the seed's look-back. `followedThreads.ts` is outside this task and keeps the union.
- [ ] **Step 2: Run to verify they pass.** Same command. Expected: PASS.
- [ ] **Step 3: Run the full suite.** Run: `npm run test:super-tabs`.
- [ ] **Step 4: Commit.**
