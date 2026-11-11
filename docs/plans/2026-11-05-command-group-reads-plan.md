# Commands stop reading every awake conversation: plan

> Written by the task's Engineer (Linden) and implemented by it, task by task, test first. Task #3146.

**Goal:** Bring `POST commands` p95 back under its 475 ms guard at peak by taking the whole-conversation read off every
command, making the unread-activity digest read only what it returns, and keeping the receipt sweep's deletes short.

**Architecture:** Every command loads its Swarm in a transaction (`store.ts loadRow` → `parts/load.ts loadActive`). That
load reads every awake conversation whole through the `dormancy` index: 180 documents of about 5.6 KB in production's
busiest Swarm, about 1 MB a command, to find the one or two that changed. Machine reports already avoid this with held
parts (`parts/held.ts`, #2597): list each part's version columns, and read whole only the parts whose columns moved. The
command load uses the same mechanism through its own `HeldParts` (so the reports' and commands' selections do not evict
each other), and a new index holds every column the listing reads, so the listing reads no document at all.

**Tech Stack:** TypeScript, Prisma 5 on MongoDB 7/8 (`aggregateRaw` with a named index hint), Vitest, mongodb-memory-server.

**Spec:** Task #3146 (Ken's 13:20 VN production scan in Watch Production #2773).

## Global Constraints

- No new settings or switches; optimizations ship on.
- Production: read-only login, explain() and `$planCacheStats` only. Each index build is stated with its size and build
  time and needs Ken's go; the backend release's schema step builds it.
- A hinted index the database lacks is never named (`parts/indexed.ts readBy` lists indexes first), so a pod running before
  the schema step, or after a rollback, reads as before.
- Swarm code stays out of `cli/src/core`. Temp files only in `mktemp -d` folders.

## Review Focus

- A command must load exactly what it loaded before: held records are frozen with the parts (`store.ts loadedFrom`) and
  are only reused at an unchanged version, changedAt and dormancy.
- The listing must be covered: no `FETCH` for the awake-conversation listing.
- The activity digest returns the same ids in the same order as the Prisma read it replaces.
- The receipt sweep removes at the same rate, in shorter deletes.

## Measured before (production, read-only, 2026-11-05 ~13:40 VN)

| Shape | Plan | Examined | Returned | Time |
|---|---|---|---|---|
| A command's awake conversations (busiest Swarm) | IXSCAN `tabId_dormant_changedAt`, FETCH | 180 docs (~1 MB) | 180 | every command |
| Unread activity digest, Prisma `$expr` (busiest person) | IXSCAN `tabId_personId_createdAt`, FETCH | 865 keys, 865 docs | 26 | 23 ms |
| Same, plain `$match` | same index | 865 / 865 | 26 | 5 ms |
| Dormant page of a project | IXSCAN `tabId_projectId_dormant_lastActivityAt_key` | 50 / 50 | 50 | 41 ms |
| Quiet conversations since Monday (board, on a cache miss) | same index | 1,779 / 1,779 | 1,779 | 12 ms |
| Receipt sweep delete | `_id` | 500 docs a delete | | max 5.8 s in Atlas |

## Task 1: Commands list awake conversations from a covering index

**Files:** `backend/src/superTabs/parts/held.ts`, `backend/src/superTabs/parts/load.ts`,
`backend/src/superTabs/parts/indexed.ts`, `backend/prisma/schema.prisma`, `backend/integration/superTabCommandLoads.test.ts`

**Interfaces:** `GROUP_INDEX.held = { tabId: 1, dormant: 1, deleted: 1, key: 1, version: 1, changedAt: 1 }`;
`loadActive(tx, tabId, opts, held = COMMAND_HELD)`; `HeldRead.groups` lists groups with `{ key, version, changedAt, dormant }`.

- [ ] Failing test: a warm command in a Swarm with 150 awake conversations examines at most a few SwarmGroup documents
  (today: every awake one), and its listing is `PROJECTION_COVERED`.
- [ ] Failing test: after every kind of conversation write, a command's load through held parts equals a load holding nothing.
- [ ] Code: the index, the group columns without `readAt`, `loadActive` through `COMMAND_HELD`.

## Task 2: The unread-activity digest reads only unread rows

**Files:** `backend/src/superTabs/activity.ts`, `backend/src/superTabs/parts/indexed.ts`, `backend/prisma/schema.prisma`,
`backend/integration/superTabActivity.test.ts`

**Interfaces:** `NAMED_INDEX.SuperTabActivity.unread = { tabId: 1, personId: 1, readAt: 1, createdAt: 1 }`;
`activityDigest(tx, tabId, personId, now)` unchanged.

- [ ] Failing test: with 300 read rows and 3 unread, the digest examines at most the unread rows, through `unread`.
- [ ] Code: `activityDigest` as a plain `aggregateRaw` `$match` (`readAt: null` matches a missing field too), named index.

## Task 3: The receipt sweep deletes in small spaced chunks

**Files:** `backend/src/lib/productUsageReceiptSweep.ts`, `backend/src/lib/productUsageReceiptSweep.test.ts`

**Interfaces:** `RECEIPT_SWEEP = { chunk: 50, chunks: 10, pauseMs: 2_000, everyMs: 30_000 }`.

- [ ] Failing test: one pass sends no delete of more than 50 receipts, waits between deletes, finishes inside its 30 s
  period, and still removes 500 a pass.
- [ ] Code: the new constants.

## Task 4: Evidence

- [ ] Red/green and the before/after explain() of each shape in a PR comment; the index sizes and build times for Ken.
