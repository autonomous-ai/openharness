# Design: Swarm messages — read only what a page shows, receipts as deltas, and data that scales for years

Date: 2026-10-30. Code read at `origin/main` (cdf21a617). Spec 5 in the CPU series; it covers the WebSocket roadmap's
item 2.3 for messages and the database roadmap's Phase 5 for the message collections. Ken's decision (2026-10-30):
**message history is kept forever.**

## Why

`GET /api/super-tabs/:tabId/conversations/:conversationId/messages` is the backend's largest database reader.

**Prod, 2026-10-30 (60 min, 3 pods):** 298 requests per pod-minute. The `db by shape` log shows ~197 backward page reads
per pod-minute (`SuperTabMessage` `sequence $lt`, 12.6 MB), plus the threads aggregation (`$facet`, 3.4 MB) and
deliveries (`messageId $in`, 1.4 MB). That log keeps only each minute's top shapes (`lib/queryStats.ts`: 20 by bytes,
10 by count, 10 by time), so small reads (an empty `?after` poll) are undercounted and **who sends the backward reads is
not known**. Candidates, all in the code:
- Desktop and the web build (`desktop/lib/super_tabs/controller.dart _loadMessages`, shared by `desktop/lib/web`):
  after an empty `?after=<tail>` read, the whole last page again with `?before=<tail+1>`, to refresh receipts; scrolling
  back; "holding" reads.
- CLI agents (`cli/src/superTabs/service.ts:598`, the `messages` action): the latest page or a `before` page.
- **Continuation batches inside one read** (`store.ts messages`): a page reads batches of 101 rows until it holds 101 it
  may show. One hidden row in the first batch (an agent-only note to someone else, a route row, a delivered copy) makes
  it read a whole second batch of 101. On a local copy of prod's busiest Swarm (`c51479bd…`), the owner's latest page
  of the Lead chat decoded 202 rows to show 100.

**Cost:** on that local copy a whole-page read costs **15 ms of process CPU** (decoding ~100–200 messages, the thread
aggregation, deliveries); an `?after` read with nothing new **2.1 ms**.

**Growth (prod, Swarm data since 2026-10-19):**

| Collection | Now | Per day | In a year at this rate | Deleted today |
|---|---|---|---|---|
| `SuperTabMessage` | 43k docs, 41 MB | 5,471 | ~2 M docs, ~1.9 GB | never (and never will be: kept forever) |
| `SuperTabDelivery` | 19k, 13 MB, 6 indexes | 2,376 | ~870 k, ~600 MB | never; 0 open now |

At 10× users, 10× that. The M20 cluster has 4 GB of RAM per node with ~1 GB free; the first limit is indexes and
working set against memory. Message reads stay index-bounded however long the history.

## Goals

- Know, per minute, who reads messages how: reader kind, cursor kind, batches and rows read against rows shown.
- A page decodes about the rows it shows, never a whole extra batch for a few hidden rows.
- If the numbers confirm it: a Desktop/web poll with nothing new never reads a whole page; changed receipts come as a
  delta.
- Message history is kept forever with its receipts, and delivery rows stop growing without bound.

## Non-goals

- Deleting or archiving messages.
- Operation receipts' growth (`SuperTabOperation`, 7 k a day): native prompts and recoveries (`native.ts:178, 215`) and
  `agent.remove` retries (`store.ts:1117`) read old receipts, so its expiry needs its own decision. Follow-up.
- Materialized thread summaries (the per-page `$facet`): measure after this ships; 90% of threads are one message.
- `SuperTabRouteDecision` growth: DB roadmap Phase 5.
- Sharding. Message reads all name `tabId`; `SuperTabDelivery` also has machine-level indexes (`[machineId, status]`,
  `[status, id]`) and reads by `_id`, so it is not shard-ready, and that is not changed here.

## Anti-goals

- A row, receipt or thread line shown to a reader who may not see it today (`readable`, `shownTo`, Buddy rules,
  `deliveredCopies`).
- A receipt that reads differently after its delivery is compacted, or a notice re-sent because its deliveries were
  compacted.
- A host that cannot settle a delivery it holds because the row is gone.

## Design decided

### Phase A — measure, stop over-reading, read compacted receipts (one release)

**A1. Messages read log.** Every minute per pod, beside `db by shape`: request counts by reader kind (person, agent,
Buddy) × cursor kind (latest, `after`, `before`, `thread`, `messageId`) × caller (the harness session's kind as the
request's auth reads it: Desktop/web app vs CLI daemon), and for each: batches read, rows decoded, rows shown. No ids, no
text.

**A2. Continuation batches read what is missing.** After the first batch, a page reads only as many more rows as it
still needs to reach 101 it may show, plus a margin (the builder picks it from the hidden-row rate, e.g. twice the
hidden rows seen so far, at least 10), and loops while short. The page and its `next` cursor are unchanged. Applies to
`messages`, threads and `catchUp` where they use the same loop.

**A3. Compacted receipts are read.** A new collection `SuperTabReceipt` (one document per message: `_id` = message id,
`tabId`, `conversationId`, `receipts` by agent id, and `deliveryIds`, indexed with `tabId`, so a host's receipt read
finds a compacted delivery by its id) holds compacted deliveries (Phase C). A page read builds each
message's `deliveries` from that message's live delivery rows plus its compacted receipts (a live row wins for the same
agent), filtered by `shownTo` exactly as today. Receipts live in their own collection, never on the message: whole
message rows are spread or returned in several places (`messagesPast` rows, `deliver()`, `mentions.ts:257`), and a
receipt map there would bypass `shownTo` (security review 2 of #2178). Shipping this read before compaction is turned on
makes a later rollback safe.

### Phase B — receipt deltas (go only if A1 shows Desktop/web re-reads are at least 30% of whole-page reads)

- `SuperTabDelivery` gains the index `(tabId, conversationId, updatedAt)`. Every delivery write goes through Prisma's
  `update`, `updateMany`, `create` or `createMany`, which set `@updatedAt` (builder check, Prisma 5.22; the settle pass
  already relies on it).
- `messages` with `after` takes an optional `since` (the `serverTime` of the client's previous read). The reply adds
  `receipts: [{ messageId, deliveries }]` for messages not in `messages` whose delivery rows changed at or after
  `since − 5 s`: each changed message is read by id (`messagesById`), checked with `readable` and `deliveredCopies`, and
  its deliveries filtered with `shownTo`, as on a page. The reply also carries `serverTime`, taken before any read.
- A `since` older than 1 hour answers without `receipts`; the client falls back to its whole-page refresh once.
- **Old backends refuse unknown query fields** (`agentQuery` is `.strict()`, `routes/superTabs.ts:37,74`): Desktop and
  web send `since` only once a reply from this backend carried `serverTime`, and drop it again after a 400.
- Desktop and web (one `controller.dart`): an empty `?after` read no longer reads `?before=<tail+1>`; the reply's
  `receipts` are merged into the rows held. The whole-page read stays for a changed reaction (`reactionSeq`) and the first
  read after a saved page. Web's own policy (`quietPoll` 15 s, no `messagesWhenChanged`) gets the same change.

### Phase C — compact finished deliveries, keep receipts forever

- Only **final** deliveries are compacted: `answered`, `cancelled`, `superseded`. `delivered` and `confirmed` are not
  final (a reply or a `project.report` moves them to `answered`, `store.ts:1553, 1561`) and are never compacted; neither
  are open ones (`queued`, `claimed`, `uncertain`).
- A final delivery whose last update is over **14 days** old is moved into its message's `SuperTabReceipt` document
  (`$set receipts.<agentId>`, so concurrent compactions of one message keep each other's agents) and deleted, in one
  transaction per batch; a delivery that changed since it was read is skipped (filter on `updatedAt`). The compacted
  receipt keeps the page fields (`PageDelivery`) **and** the host fields `deliveryReceipt` authorizes with (`machineId`,
  `machineOwnerId`, `membershipGeneration`, `status`), never shown to readers.
- **Hosts:** `deliveryReceipt` (`store.ts:2749`, the CLI's `checkReceipts`) answers a compacted delivery from its
  receipt, so a host back after weeks offline still retires its journal entries. A host confirming it typed a cancelled,
  held delivery (`typedAsEnded`) reads the compacted receipt the same way.
- **Notices:** `writeMessages(keepStored)` (`store.ts:2048`) counts a compacted receipt as an existing delivery, so a
  re-written notice is never sent again.
- The job runs in the worker once an hour in bounded batches and logs how many it compacted and how many final
  deliveries over 14 days old remain (the warning metric). It is **on by default** (Ken, 2026-10-30), with
  `SWARM_DELIVERY_COMPACTION=off` as the kill switch. During the rolling deploy that ships it, pods still on the old
  release show no receipts for compacted (14-day-old) messages and answer a host's receipt read for one with 404 until
  they are replaced; the CLI retries.

## Left to the builder

- A1's log name and exact keys; A2's margin; reply field names in Phase B (old clients ignore new fields).
- Where the compaction job lives and its batch size.
- How Desktop keeps the last `serverTime` per conversation.

## Tests

- **A1:** one `before` read by an agent and one latest read by a person are counted under their kinds, with batches and
  rows; nothing names an id.
- **A2:** a page whose first 101 rows hold 1 hidden row decodes at most ~101 + margin rows, and returns the same page and
  `next` as today; a page with mostly hidden rows still fills; `catchUp` and threads unchanged.
- **A3:** a page's reply is deep-equal whether a message's deliveries are live, compacted, or half each; a live row wins;
  `shownTo` hides a compacted Buddy-news receipt as it hides a live one; no message read returns a `receipts` map.
- **B:** a delivery answered after the last read comes back in `receipts` on the next empty `?after`; one before does not;
  a hidden message's receipts never appear; Desktop sends `since` only after `serverTime` was seen, drops it after a 400,
  and no longer reads `?before=<tail+1>` after an empty `?after`; a reaction change still reads the page; the web policy
  behaves the same.
- **C:** only `answered`/`cancelled`/`superseded` over 14 days are compacted; two concurrent compactions of one message
  keep both agents; `deliveryReceipt` answers a compacted delivery with its final status and refuses another machine;
  `writeMessages(keepStored)` writes no delivery for a compacted one; a page is unchanged across compaction.
- Existing suites stay green: `integration/superTabRead.test.ts`, `superTabReadMarks`, `superTabHotReads`,
  `superTabNamedReads`, the store's delivery tests, the CLI host's receipt tests, Desktop's `super_tabs` tests.

## Measuring

- A1's log, before Phase B: whole-page reads by caller and cursor; rows decoded per row shown.
- The messages route's busy ms and bytes per pod-minute (`cpu by kind`, `db by shape`), before and after each phase.
- Weekly: `SuperTabDelivery` and `SuperTabReceipt` counts and index sizes.

**Done when** Phase A ships with A1's numbers reported and rows decoded per row shown under 1.2; Phase B (if it goes)
cuts Desktop/web whole-page reads by at least 5×; Phase C keeps `SuperTabDelivery` near 14 days of final deliveries plus
the non-final ones.

## Design (AGENTS.md rules)

- **Growth:** messages are kept forever (~5.5 k a day). Final deliveries move into `SuperTabReceipt` after 14 days (one
  small document per message with receipts); delivery rows hold ~14 days plus non-final ones.
- **Concurrency:** compaction writes receipts by field path in one transaction with the delete, skipping rows that
  changed since read. Delta reads take `serverTime` before reading.
- **Read cost:** a page decodes about the rows it shows; it reads live deliveries and compacted receipts for the page's
  messages by id (two indexed reads). An empty poll with Phase B reads the new messages (none) and the conversation's
  changed deliveries by the new index.
- **Scale:** at 10× messages reads stay index-bounded; the first warning is index size against node RAM (`$collStats`
  weekly) and the compaction backlog. Next steps are a larger tier, then a sharding design.
- **Compatibility:** new reply fields only. Old Desktop/web keep their whole-page refresh. New clients send `since` only
  to a backend that answered `serverTime`. Old CLIs read receipts through `deliveryReceipt`, which answers compacted ones.
- **Migration + rollback:** Phase A adds a collection and reads it. Compaction is on by default; before rolling back to a
  release older than Phase A, set `SWARM_DELIVERY_COMPACTION=off` (compacted receipts are then invisible to that old
  release until it is rolled forward again; nothing is lost). The new index comes with the schema push.
- **Audience:** every receipt is filtered per reader as on a page (`readable`, `deliveredCopies`, `shownTo`); compacted
  receipts are never returned whole.
- **Identity:** N/A because nothing here acts as or reads the machine owner's login.
- **Failure:** a failed compaction batch logs and retries next hour; an unusable `since` answers without `receipts` and
  the client falls back; a host asking about a compacted delivery gets its final status, not a 404.
- **Platforms:** backend; Desktop (macOS, Windows, Linux) and the web build for Phase B.
