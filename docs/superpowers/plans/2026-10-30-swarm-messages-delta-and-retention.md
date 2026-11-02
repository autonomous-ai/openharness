# Swarm messages: read what a page shows, receipt deltas, receipts kept forever — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the messages route's database reads and CPU, and keep message receipts forever while delivery rows stop growing.

**Architecture:** Phase A (one release): a per-minute messages read log, continuation batches that read only what is missing, and a `SuperTabReceipt` collection that page reads merge. Phase B (only if A's log says so): receipt deltas on `?after` reads, used by Desktop and web. Phase C: a worker job (on by default) that moves final deliveries older than 14 days into `SuperTabReceipt`. Phase D: a `SuperTabThread` collection holding each replied thread's `$facet` result, refreshed when a reply is inserted, read by id instead of aggregating on every page.

**Tech Stack:** TypeScript, Fastify, Prisma 5.22 on MongoDB, vitest + `mongodb-memory-server`; Flutter (Desktop and web share `desktop/lib/super_tabs/controller.dart`).

**Spec:** `docs/superpowers/specs/2026-10-30-swarm-messages-delta-and-retention-design.md`

## Global Constraints

- Messages are kept forever; nothing here deletes a message.
- Compact only `answered`, `cancelled`, `superseded`; never `delivered`, `confirmed`, `queued`, `claimed`, `uncertain`.
- Compact after **14 days** since the delivery's `updatedAt`; delta slack **5 s**; a `since` older than **1 hour** answers without `receipts`.
- Phase B goes only if Task 1's log shows Desktop/web re-reads are **at least 30%** of whole-page reads. Record the decision in the PR.
- Compaction is **on by default** (Ken, 2026-10-30); env `SWARM_DELIVERY_COMPACTION=off` is the kill switch. Set it to `off` before rolling back to a release older than Phase A, whose page reads do not read `SuperTabReceipt`.
- Receipts are never stored on a message document and never returned whole; every receipt shown goes through `shownTo`.
- Do not commit or push until Ken asks; each task ends with a diff checkpoint. Remove dead code.
- Backend commands from `backend/`: unit `npx vitest run <file>`; integration `npx vitest run --config vitest.super-tabs.config.ts <file>`. Desktop: `flutter test <file>` from `desktop/`.

## Review Focus

1. A host offline for more than 14 days asks `GET …/deliveries/:id` for a delivery that was compacted: it gets the final status, not 404 — Task 5 test.
2. A notice re-written with `keepStored` after its deliveries were compacted is not delivered again — Task 5 test.
3. A Buddy-news row's compacted receipt is hidden from everyone but that Buddy, as a live one is — Task 3 test.
4. A conversation whose first 101 rows are mostly hidden (an agent reading a Lead chat full of notes to others) still fills its page — Task 2 test.
5. A new Desktop talking to a backend without `since` (400 on unknown field) keeps polling — Task 7 test.

---

### Task 1: Messages read log (A1)

**Files:**
- Create: `backend/src/superTabs/messageReadStats.ts`
- Modify: `backend/src/superTabs/store.ts` (`messages`, `catchUp`), `backend/src/server.ts` (start beside `startQueryStats`)
- Test: `backend/src/superTabs/messageReadStats.test.ts`

**Interfaces:**
- Produces: `type MessageReadKey = { reader: 'person' | 'agent' | 'buddy'; cursor: 'latest' | 'after' | 'before' | 'beforeId' | 'thread' | 'messageId' | 'catchUp' }`; `recordMessageRead(key: MessageReadKey, batches: number, decoded: number, shown: number): void`; `startMessageReadStats(options?: { everyMs?: number; log?: (message: string, context: Record<string, unknown>) => void }): () => void` logging `'messages by reader'` each minute with `{ windowMs, rows: Array<MessageReadKey & { n, batches, decoded, shown }> }`.
- `before` without `beforeId` is `'before'` (Desktop's refresh of the page it shows); with `beforeId` is `'beforeId'` (scrolling back).

- [ ] **Step 1: Write the failing test** `'counts reads per reader and cursor, with batches and rows, and names nothing'`: record two `{person, before}` reads (2 batches, 202 decoded, 100 shown) and one `{agent, latest}` (1, 101, 100); run with `everyMs: 50`; expect one log row `{reader: 'person', cursor: 'before', n: 2, batches: 4, decoded: 404, shown: 200}` and one for the agent, and `JSON.stringify(context)` matching no id pattern.
- [ ] **Step 2: Run** `npx vitest run src/superTabs/messageReadStats.test.ts` — FAIL, module missing.
- [ ] **Step 3: Implement** the module (a `Map` keyed by `reader|cursor`, flushed per window) and call `recordMessageRead` once per `messages`/`catchUp` call with the batches, rows decoded (every row a batch returned) and rows shown; reader is `'buddy'` when `isBuddyReader(state, actor)`, else the actor's kind.
- [ ] **Step 4: Run** the test and `npx vitest run src/superTabs` — PASS.
- [ ] **Step 5: Checkpoint** `git diff --stat`.

### Task 2: Continuation batches read what is missing (A2)

**Files:**
- Modify: `backend/src/superTabs/store.ts` (the `for (let edge = start; rows.length <= 100;)` loop in `messages`, and the same loop shape in `catchUp` if it pages the same way), `backend/src/superTabs/pageReads.ts` (`messagesPast` already takes `limit`)
- Test: `backend/integration/superTabRead.test.ts` (new `describe('a page reads about the rows it shows (spec 5 A2)')`)

**Interfaces:**
- Consumes: Task 1's `recordMessageRead` counts, used by the test to read rows decoded.
- Produces: no new export. Batch size after the first: `Math.max(MIN_BATCH, 101 - rows.length + 2 * hiddenSoFar)` with `MIN_BATCH = 10`.

- [ ] **Step 1: Write the failing tests:**
  - `'a page with one hidden row in its first 101 decodes at most 101 + 10 rows and returns the same page and next as before'`: a conversation of 300 messages, one agent-only note to another agent among the newest 101; read the latest page as a person; expect `decoded <= 111`, the 100 rows and `next` equal to the page the old loop returns (compute it in the test by reading 202 rows directly and filtering).
  - `'an agent reading a chat where most rows are notes to others still gets a full page'`: 400 messages, 3 of every 4 agent-only notes to someone else; expect 100 rows shown and `next` set.
- [ ] **Step 2: Run** `npx vitest run --config vitest.super-tabs.config.ts integration/superTabRead.test.ts -t "rows it shows"` — first test FAILS on `decoded` (202).
- [ ] **Step 3: Implement** the batch size above in each loop; keep the stop rule (`rows.length > 100` or a short batch).
- [ ] **Step 4: Run** `integration/superTabRead.test.ts`, `integration/superTabNamedReads.test.ts`, `integration/superTabHotReads.test.ts` — PASS.
- [ ] **Step 5: Checkpoint** `git diff --stat`.

### Task 3: `SuperTabReceipt` and page reads that merge it (A3)

**Files:**
- Modify: `backend/prisma/schema.prisma` (new model), `backend/src/superTabs/pageReads.ts` (`pageDeliveries`)
- Test: `backend/integration/superTabRead.test.ts`

**Interfaces:**
- Produces: model
  ```prisma
  model SuperTabReceipt {
    id             String @id @map("_id") // the message id
    tabId          String
    conversationId String
    receipts       Json   // { [agentId]: CompactedReceipt }
    deliveryIds    String[] // the compacted deliveries' ids, so a host's receipt read finds one by id
    @@index([tabId, conversationId])
    @@index([tabId, deliveryIds])
  }
  ```
  `type CompactedReceipt = Omit<PageDelivery, 'id' | 'messageId'> & { deliveryId: string; machineId: string; machineOwnerId: string | null; membershipGeneration: string }` exported from `pageReads.ts`; `pageDeliveries(tx, tabId, messageIds)` keeps its signature and returns live rows plus compacted ones (one `PageDelivery` per agent, `id` = the receipt's `deliveryId`; a live row wins). The host fields are never put into a `PageDelivery`.
- [ ] **Step 1: Write the failing tests:**
  - `'a page reads the same whether its deliveries are live, compacted or half each'`: answer three deliveries; read the page; move two into a `SuperTabReceipt` by hand and delete their rows; read again; deep-equal.
  - `'a live row wins over a compacted one for the same agent'`.
  - `'a compacted Buddy-news receipt is shown only to that Buddy'` (Review Focus 3).
  - `'no message read returns a receipts map'`: `JSON.stringify` of `messages`, `catchUp`, the inbox and mentions replies has no `"receipts"` key.
- [ ] **Step 2: Run** them — FAIL (model missing).
- [ ] **Step 3: Implement** the model (schema push creates it) and the merge in `pageDeliveries` (one `findMany` by `_id $in` on `SuperTabReceipt` beside the deliveries read; `hotFilters.allowed.json` gains the entry if the lint asks).
- [ ] **Step 4: Run** `integration/superTabRead.test.ts`, `src/superTabs/hotFilters.test.ts` — PASS.
- [ ] **Step 5: Checkpoint** `git diff --stat`. **Phase A ends here: ship it, then read Task 1's log for a weekday before Tasks 6–7.**

### Task 4: Compaction job (C)

**Files:**
- Create: `backend/src/superTabs/deliveryCompaction.ts`
- Modify: `backend/src/worker.ts` (start beside `startDeliverySettle` unless `env.SWARM_DELIVERY_COMPACTION === 'off'`), `backend/src/config/env.ts` (default `'on'`)
- Test: `backend/integration/superTabDeliveryCompaction.test.ts` (add to `vitest.super-tabs.config.ts` `include`)

**Interfaces:**
- Consumes: Task 3's model and `CompactedReceipt`.
- Produces: `FINAL_DELIVERY = ['answered', 'cancelled', 'superseded'] as const`; `COMPACT_AFTER_MS = 14 * 86_400_000`; `compactDeliveries(db: PrismaClient, now: number, batch = 500): Promise<{ compacted: number; remaining: number }>`; `startDeliveryCompaction(db: PrismaClient, everyMs = 3_600_000): () => void` logging `'[swarm-deliveries] compacted'` with both numbers. Each hourly run calls `compactDeliveries` until it compacts nothing or 20 batches ran (up to 10 k per run; prod finishes ≤ 3.4 k deliveries a day), so the first runs also clear the backlog: no separate data migration.
- Per batch, one transaction: read final deliveries with `updatedAt < now - COMPACT_AFTER_MS`, upsert each message's `SuperTabReceipt` with `$set: { 'receipts.<agentId>': … }` and `$addToSet: { deliveryIds: <id> }` (raw `updateOne` with `upsert`, field-path sets), delete those deliveries with `updatedAt` equal to what was read.
- [ ] **Step 1: Write the failing tests:** only final deliveries over 14 days are compacted (a `delivered`, a `confirmed`, a `queued` and a 13-day `answered` stay); two concurrent `compactDeliveries` calls on one message keep both agents; a delivery updated between read and delete is skipped; a page is deep-equal before and after; `remaining` counts final deliveries still over 14 days.
- [ ] **Step 2: Run** — FAIL (module missing).
- [ ] **Step 3: Implement** the module and the worker wiring (on unless the switch says `off`; a test that `off` starts nothing).
- [ ] **Step 4: Run** the new file and `integration/superTabRead.test.ts` — PASS.
- [ ] **Step 5: Checkpoint** `git diff --stat`.

### Task 5: Hosts and notices read compacted receipts (C)

**Files:**
- Modify: `backend/src/superTabs/store.ts` (`deliveryReceipt` ~2749, `delivery()` `typedAsEnded` ~2820, `writeMessages` `keepStored` ~2048)
- Test: `backend/integration/superTabDeliveryCompaction.test.ts`

**Interfaces:**
- Consumes: Task 3's `SuperTabReceipt`, Task 4's `compactDeliveries`.
- Produces: `compactedDelivery(tx, tabId, agentId, deliveryId): Promise<(CompactedReceipt & { messageId: string }) | null>` in `pageReads.ts`, found by `{ tabId, deliveryIds: deliveryId }` (index `[tabId, deliveryIds]`), then its `receipts[agentId]` with that `deliveryId`; `deliveryReceipt` and `typedAsEnded` fall back to it when no row exists, authorizing with its `machineOwnerId`/`machineId`/`membershipGeneration` exactly as with a row; `writeMessages(keepStored)` treats a message's compacted agent as an existing delivery. A plan test pins the lookup to `[tabId, deliveryIds]`.
- [ ] **Step 1: Write the failing tests:** `deliveryReceipt` answers `{ id, status: 'answered' }` for a compacted delivery and refuses another machine owner (403) (Review Focus 1); a host confirming it typed a compacted cancelled-with-hold delivery gets the same answer as before compaction; `writeMessages(keepStored)` re-writing a notice whose deliveries were compacted creates no delivery (Review Focus 2).
- [ ] **Step 2: Run** — FAIL (404 / re-delivered).
- [ ] **Step 3: Implement** the three fallbacks through `compactedDelivery`.
- [ ] **Step 4: Run** the file, the store's delivery suites (`integration/superTabs.test.ts -t deliver`) and the CLI host receipt tests (`cd ../cli && npx vitest run src/superTabs/host.spec.ts`) — PASS.
- [ ] **Step 5: Checkpoint** `git diff --stat`.

### Task 6: Receipt deltas on `?after` (B — only if the 30% gate passes)

**Files:**
- Modify: `backend/prisma/schema.prisma` (`SuperTabDelivery` gains `@@index([tabId, conversationId, updatedAt])`), `backend/src/routes/superTabs.ts:74` (`messageQuery` gains `since: z.coerce.number().int().nonnegative().safe().optional()`), `backend/src/superTabs/store.ts` (`messages`)
- Test: `backend/integration/superTabRead.test.ts`

**Interfaces:**
- Produces: `messages(user, tabId, conversationId, cursor: { …; since?: number }, asAgentId?)` replies with `serverTime: number` (taken before any read) always, and `receipts?: Array<{ messageId: string; deliveries: PageDelivery[] }>` when `after` and `since` are given and `now - since <= 3_600_000`: messages not in `messages` whose deliveries have `updatedAt >= since - 5_000`, read by `messagesById`, kept only if `readable` and not a delivered copy, deliveries filtered by `shownTo`, compacted receipts merged as in Task 3.
- [ ] **Step 1: Write the failing tests:** an answer after the last read appears in `receipts` on the next empty `?after`; one before does not; a hidden message's receipts never appear; `since` older than an hour gives no `receipts`; every reply has `serverTime`; an index plan test that the delta read uses `(tabId, conversationId, updatedAt)` (`integration/superTabHotReads.test.ts` style).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `integration/superTabRead.test.ts`, `integration/superTabHotReads.test.ts` — PASS.
- [ ] **Step 5: Checkpoint** `git diff --stat`.

### Task 7: Desktop and web use the delta (B — only with Task 6)

**Files:**
- Modify: `desktop/lib/super_tabs/controller.dart` (`_query`, `_loadMessages`: the "No new text: refresh delivery receipts" branch)
- Test: `desktop/test/super_tab_new_messages_test.dart` (or `super_tab_message_paging_test.dart`, whichever holds the receipt-refresh case)

**Interfaces:**
- Consumes: Task 6's `serverTime` and `receipts`.
- Produces: per conversation, the last `serverTime` seen; `since` is added to `?after=` only once a reply from this backend carried `serverTime`, and dropped for the session after a 400.
- [ ] **Step 1: Write the failing tests:** an empty `?after` read with `receipts` makes no `?before=<tail+1>` request and updates the held rows' deliveries; a reaction change still reads the page; a backend whose replies have no `serverTime` gets no `since` and keeps the old refresh; a 400 on `since` drops it and the next poll succeeds (Review Focus 5); the web reading policy behaves the same.
- [ ] **Step 2: Run** `flutter test test/super_tab_new_messages_test.dart` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file and `flutter test test/super_tab_*` — PASS (compare failures with a clean `main`, which has known reds).
- [ ] **Step 5: Checkpoint** `git diff --stat`.

### Task 8: Thread summaries written with each reply (D)

**Files:**
- Modify: `backend/prisma/schema.prisma` (new model), `backend/src/superTabs/pageReads.ts` (split `pageThreads` into the `$facet` read and the post-processing), `backend/src/superTabs/store.ts` (`writeMessages`), `backend/src/superTabs/native.ts:235`
- Test: `backend/integration/superTabThreads.test.ts` (new; add to `vitest.super-tabs.config.ts` `include`)

**Interfaces:**
- Produces: model
  ```prisma
  model SuperTabThread {
    id             String   @id @map("_id") // the root message id
    tabId          String
    conversationId String
    parts          Json     // the $facet's `parts` for this one thread, as pageThreads reads them today
    mentions       Json     // the $facet's `mentions` for this one thread
    updatedAt      DateTime
    @@index([tabId, conversationId])
  }
  ```
  In `pageReads.ts`: `threadFacet(tx, tabId, conversationId, roots: string[]): Promise<{ parts: FacetPart[]; mentions: FacetMention[] }>` (today's query, unchanged); `threadReplies(tx, tabId, facet): Promise<ThreadReply[]>` (today's post-processing, unchanged); `pageThreads` = `threadReplies(threadFacet(...))` until Task 9; `refreshThreads(tx, tabId, conversationId, roots: string[]): Promise<void>` upserts one `SuperTabThread` per root whose facet holds a reply (skips lone roots).
- [ ] **Step 1: Write the failing tests:** a reply inserted through `store.execute` (`message.send` with `replyTo`) leaves a `SuperTabThread` whose `parts`/`mentions` deep-equal `threadFacet` for that root; a native reply (`native.ts`) does too; a lone root has no document; a reply that fails its transaction leaves no document.
- [ ] **Step 2: Run** `npx vitest run --config vitest.super-tabs.config.ts integration/superTabThreads.test.ts` — FAIL.
- [ ] **Step 3: Implement** the split (no behaviour change) and call `refreshThreads` for the distinct roots of inserted rows whose `thread` is set and not their own id, after the insert, in the same transaction, in both insert sites.
- [ ] **Step 4: Run** the new file and `integration/superTabRead.test.ts` — PASS.
- [ ] **Step 5: Checkpoint** `git diff --stat`.

### Task 9: Backfill, per-Swarm switch, and reads from the collection (D)

**Files:**
- Create: `backend/src/superTabs/threadBackfill.ts`
- Modify: `backend/src/superTabs/pageReads.ts` (`pageThreads`), `backend/src/worker.ts` (run after `releaseSchema`, before jobs start), `backend/prisma/schema.prisma` (marker model)
- Test: `backend/integration/superTabThreads.test.ts`

**Interfaces:**
- Consumes: Task 8's `threadFacet`, `threadReplies`, `refreshThreads`.
- Produces: model `SuperTabThreadBackfill { id String @id @map("_id") /* tabId */; through DateTime }`; `backfillThreads(db: PrismaClient, now: number): Promise<{ swarms: number; threads: number }>` — for each Swarm, refreshes every thread with a reply created after `marker.through - 3_600_000` (all of them when no marker), then sets `through = now`; `pageThreads(tx, tabId, conversationId, roots)` reads `SuperTabThread` by `_id $in roots` when the Swarm's marker exists (cached per process for 60 s), else `threadFacet` as today, and in both cases returns `threadReplies(...)`. A root without a document contributes what `threadFacet` gives for a lone root; prove it equal, or drop lone roots if `threadSummaries` ignores them.
- [ ] **Step 1: Write the failing tests:** for a scene with lone roots and replied threads of every visibility class (agent-only notes to others, route rows, a Buddy session thread, mentions) and readers (owner, collaborator outside a private project, Buddy, agent), each reader's page `threads` deep-equals the `$facet` path; a Swarm without a marker reads through `threadFacet`; after backfill the page reads no `SuperTabMessage` aggregation for threads (count by the profiler); a reply written while the marker was stale (insert it with `refreshThreads` skipped, as an older release would) is counted after the next `backfillThreads`.
- [ ] **Step 2: Run** them — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file, `integration/superTabRead.test.ts`, `integration/superTabHotReads.test.ts` — PASS.
- [ ] **Step 5: Checkpoint** `git diff --stat`.

### Task 10: Checks and measurement

- [ ] **Step 1:** `npm run typecheck` in `backend/`; `flutter analyze` in `desktop/` if Task 7 ran.
- [ ] **Step 2:** `npm run test:super-tabs` and `npm test` in `backend/` — only failures already on clean `main`, listed in the PR.
- [ ] **Step 3:** After Phase A's release, one weekday (07:00–16:00 VN) of `'messages by reader'` logs: whole-page reads by reader and cursor, decoded per shown (target < 1.2). Write the Phase B go/no-go into the PR with the numbers.
- [ ] **Step 4:** After Phase C is switched on: the hourly `compacted`/`remaining` log, and weekly `SuperTabDelivery`/`SuperTabReceipt` counts and index sizes.
- [ ] **Step 5:** After Phase D: the `$facet` shape under the messages route in `db by shape` (today ~100 a pod-minute, 3.4 MB) gone, replaced by a `SuperTabThread` read by id.
