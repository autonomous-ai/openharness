# Database retention: every growing collection names what removes it — implementation plan

> Worked by this project's instructions (Engineer role), by the writing-plans and test-driven-development skills: this
> plan is the pull request's first commit. Then each task is done test first (a commit with the failing test, then the
> commit that passes it), by one Engineer, with one Review step on the pull request against MongoDB's schema-design and
> query-optimizer skills. Steps use checkbox (`- [x]`) syntax.

**Goal:** the four collections Ken measured growing with nothing removing them each name what does: operation receipts
expire after 30 days, a route decision keeps about a third of what it keeps now, the stuck usage-receipt sweep says so
every hour until its receipts are gone, and backend/AGENTS.md holds the rules that keep the next collection from growing
the same way.

**Architecture:** a TTL index `operation_expiry` on `SuperTabOperation.createdAt` (30 days), made by the release's schema
step *before* `prisma db push`, so it is built with its expiry by `createIndexes`, which production's app user may run,
instead of built plain by the push and then refused its expiry by `collMod`, which it may not (10-29). A route decision is
trimmed where it is written (`routeDecisions.ts writeRouteEffects`, by a pure `storedRecord` in `routeRecord.ts`): only
the pick keeps its candidate label, and the exclusions are kept once per reason; every read (`decisionOf`) expands them
back, so each reader sees the shape it reads today. The usage-receipt sweep, while the database refuses its rule, logs an
error each hourly check with when its old receipts expire on their own, and stops once none are left.

**Tech Stack:** backend TypeScript, Prisma 5 on MongoDB 7, vitest (unit tests in `src/`, integration tests in
`integration/` on a loopback `mongodb-memory-server` replica set; the Super Tab suite runs in PR CI, four shards).

**Spec:** task #2488 brief (Ken, through the PM, 2026-11-03). Measured on the read-only production database at the start
(2026-11-03 13:15 UTC):

| Collection | Rows | Data | Index | Growth | Removed by |
| --- | --- | --- | --- | --- | --- |
| SuperTabOperation | 120,014 | 48.2 MB (401 B a row) | 6.0 MB | 14,037 in the last day | nothing |
| SuperTabRouteDecision | 5,518 | 67.6 MB (20.9 KB a row in the last 2 days) | 0.8 MB | 628 in the last day | delete past 90 days, on write |
| product_usage_receipts | 5,156,191 | 376.4 MB | 614.7 MB (`_id_` 576 MB) | ~275k a day, live 4 days | TTL `product_usage_expiry` (expireAfterSeconds 0) |

- Operations: oldest 2026-10-19; none older than 30 days, 235 older than 14 days. In the last 7 days 97,897 were agent
  commands, 4,932 person commands and 138 native terminal events.
- Route decisions (last 2 days, average bytes): record 20,018, of which candidate labels 5,360 (13 candidates, up to 31),
  candidate fits 2,147, exclusions 8,883 (47 entries a row, 4.8 distinct reasons; the distinct reasons are 578 bytes);
  run 202, evidence 255. Largest row 42.5 KB.
- Usage receipts: the TTL index is there and works (2 past expiry at the time of reading); 4,054,561 receipts carry no
  `life` (written while a receipt lived 36 days) and the last of them expires 2026-12-04. The collection has no rule
  (`options: {}`), so the sweep from #2145 has removed nothing: it waits on `collMod`, which the app user may not run.

## Global Constraints

- PR body first line: "Requested by 0xken15@gmail.com through Harness."
- Database work follows MongoDB's schema-design and query-optimizer skills; the Reviewer checks against them.
- Measure on the read-only production database before and after, through its environment file only, never printed.
- The TTL index is a production write made by the backend release's schema step: it ships only with Ken's go for that
  release, in the day window (09:00–18:00 VN), watching backend CPU and latency before and after. No forced bulk delete
  anywhere: the usage receipts expire by themselves.
- The full Super Tab integration suite runs in PR CI; nobody runs it locally. Merge goes through the PM's batch.
- Out of scope: messages (kept forever), finished deliveries (already compacted after 14 days).
- Swarm code stays out of cli/src/core. Temp files only in mktemp -d folders. Stop only processes I started, by id.

## Review Focus

- The order of the schema step: the new expiry index must exist, with its expiry, after a release run by a database user
  who may not run `collMod`; and a release with nothing changed must change no index (schemaRelease.test.ts).
- 30 days against every reader of an operation receipt (below): none needs one older than a waiting prompt.
- A trimmed route decision still answers every reader as before: start/assign matching (`startedAs`, `finalMatches`), the
  person's override, costs, Desktop's Details. Old rows (untrimmed) read unchanged.
- The sweep's error is loud but not a flood: once an hour, one line.

## Design

- **Growth — what deletes it:** operations: the TTL index, 30 days after `createdAt` (~14k a day → ~420k rows, ~170 MB
  data at steady state). Route decisions: still the 90-day delete on write (the costs report reads 90 days, `costs/read.ts
  MAX_DAYS`, so a 30-day prune would cut it), now at ~12.9 KB a row instead of ~24.5 KB (the trim applied to the last
  day's 622 production rows, read-only, 2026-11-03): ~0.7 GB at 90 days instead of ~1.35 GB. Usage
  receipts: their TTL; the 4.05M old ones are gone by 2026-12-04, sweep or not.
- **Concurrency — lock level:** the TTL monitor deletes as ordinary document deletes (document-level locks). The index
  build takes the collection's exclusive lock only to begin and to finish (Mongo 4.2+ hybrid build), over 120k rows of
  ~400 B (seconds). Every command reads its receipt in a transaction, which waits at most 5 ms for a lock: a command
  caught at either moment fails transiently and the store's `transaction()` retries it, as the 10-28 test of the schema
  step shows for Swarm reads. The route decision trim happens in the same write as today, no new lock.
- **Read cost — read only what changed:** no new read. The sweep's hourly stuck check reads one index key (the newest old
  receipt, by `product_usage_expiry`), never a count of millions.
- **Scale — 10x, and the metric that warns first:** at 10x operations (140k a day), 1.4M rows and ~1.7 GB at 30 days:
  the `SuperTabOperation` data size in dbStats warns first; the TTL deletes ~100 a minute, well within the monitor's pace.
  At 10x route decisions, 4 GB at 90 days: its collection size warns first; the next step is compacting rows older than
  N days (as deliveries are), not cutting the costs window.
- **Compatibility — old and new clients:** clients read decisions through the backend, which expands the stored form, so
  Desktop, the CLI and the phone see `record.excluded[]` and `record.candidates[]` as before; a non-pick candidate has no
  `label`, which Desktop already treats as optional (`route_row.dart`: `if (c['label'] case final String label)`), and the
  CLI never reads a stored label. Rows written before this keep their full form and read unchanged.
- **Migration + rollback:** no data migration; the TTL index is made by the release. Rolled back, an older backend reads a
  trimmed decision with no `excluded` (the Details of Desktop, `route_row.dart`, and the phone, `swarm_special_rows.dart`, then
  list no unavailable machines; nothing else reads it) and
  db push of the older schema drops `operation_expiry` (receipts then grow again, nothing breaks).
- **Audience — the server enforces it:** unchanged: decisions are read by the same readable-conversation filter.
- **Identity:** N/A because no identity is read or written.
- **Failure — nothing breaks without saying so:** if the index cannot be made, `createIndexes` fails the schema step as any
  index does today (loud). If an expiry change is refused, `ensureIndex` warns, as today. The stuck sweep logs an error
  every hour it cannot run, with the date its receipts expire by.
- **Platforms:** backend only (Linux containers); no client change.

### Who reads an operation receipt, and after how long

| Reader | Reads | Without a receipt older than 30 days |
| --- | --- | --- |
| Command replay (`store.ts` execute, agent and person) | its own receipt, by operation id | a request repeated 30 days later runs as new (an operation id is reused only to repeat an interrupted request) |
| Swarm create, sharing, join (`store.ts`) | same | same; a Swarm create repeated after 30 days fails on its existing id instead of answering it |
| Native terminal events (`native.ts append`) | the event's own receipt; an answer's prompt receipt | a prompt answered more than 30 days later is refused as missing (NATIVE_PROMPT_MISSING): the CLI then stops recording that terminal until someone reopens it from the conversation (`cli/src/superTabs/native.ts`) |
| Native recovery (`native.ts recovery`) | one per incident | an incident reported again after 30 days alarms again |
| Abandoned starts (`store.ts abandonedStarts`) | a start's receipt, for its time | an unknown time counts as old: a start 30 days old is abandoned, as it should be |
| Migration fingerprint (`migration/fingerprint.ts`) | a count, before and after, in one transaction | the snapshot is one transaction's, so a TTL delete between them does not show |

## File Structure

- `backend/prisma/schema.prisma` — declare `@@index([createdAt], map: "operation_expiry")` on SuperTabOperation; name what
  removes each of the three collections in its model comment.
- `backend/src/superTabs/operations.ts` (new) — `OPERATION_EXPIRY_MS` and `ensureOperationExpiry(db)`.
- `backend/src/lib/db/schemaRelease.ts` — run the expiry indexes of collections that exist before their index (today:
  operations) *before* `ensureSchema`.
- `backend/src/superTabs/routeRecord.ts` — `storedRecord(record)` and `readRecord(stored)`.
- `backend/src/superTabs/routeDecisions.ts` — write `storedRecord`, read through `readRecord` in `decisionOf`.
- `backend/src/lib/productUsageReceiptSweep.ts` — the loud refusal and the self-stop.
- `backend/AGENTS.md` (new) — the five MongoDB rules; `backend/CLAUDE.md` imports it, as `cli/` and `desktop/` do.
- Tests: `backend/integration/schemaRelease.test.ts`, `backend/integration/workerIndexPlans.test.ts`,
  `backend/src/superTabs/routeRecord.test.ts`, `backend/integration/superTabCosts.test.ts` (it records routes through the
  store and reads them back; `superTabRouteDecisions.test.ts` writes rows directly),
  `backend/integration/productUsageReceipts.test.ts`.

## Task 1: operation receipts expire after 30 days

**Files:** `backend/prisma/schema.prisma`, `backend/src/superTabs/operations.ts`, `backend/src/lib/db/schemaRelease.ts`,
`backend/integration/schemaRelease.test.ts`, `backend/integration/workerIndexPlans.test.ts`.

**Interfaces:**

```ts
// backend/src/superTabs/operations.ts
/** A command's receipt is kept this long: long enough for a prompt waiting on its answer, and for any repeat of an interrupted request. */
export const OPERATION_EXPIRY_MS = 30 * 24 * 60 * 60_000
/** Run by the release's schema step before db push, so the index is built with its expiry (createIndexes) rather than given it later (collMod). */
export async function ensureOperationExpiry(db: PrismaClient): Promise<void>
// = ensureIndex(db, 'SuperTabOperation', { key: { createdAt: 1 }, name: 'operation_expiry', expireAfterSeconds: OPERATION_EXPIRY_MS / 1000 })
```

- [x] In `schemaRelease.test.ts`, add `['SuperTabOperation', 'operation_expiry', { createdAt: 1 }, 30 * DAY]` to `EXPIRY`,
  and add the test "gives an existing collection its new expiry index when the database user may not run collMod (prod
  10-29)": release with the schema as it was (the declared `operation_expiry` line removed, by `schemaWith`), insert an
  operation, then release the current schema through a client whose `$runCommandRaw` refuses `collMod` with Mongo's code
  13 (as `productUsageReceipts.test.ts` does); expect `operation_expiry` with `expireAfterSeconds` 2,592,000, and
  `indexChanges` to be exactly `['createIndexes SuperTabOperation operation_expiry']` (built once, by the worker).
- [x] In `workerIndexPlans.test.ts`, add "the operation expiry reads receipts by their age": seed operations a day and 40
  days old, `explain` the TTL monitor's shape `find({ createdAt: { $lt: cutoff } })` and expect `IXSCAN { createdAt: 1 }`
  on `operation_expiry`, with docsExamined equal to the old rows.
- [x] Run both files; watch them fail (no such index). Commit "test: operation receipts expire after 30 days (red)".
- [x] Add `operations.ts`, the schema line with its comment, and `ensureOperationExpiry` first in `releaseSchema`, before
  `ensureSchema`, with a comment saying why. Run both files and `npm test -- src/lib/db`; green. Commit.

## Task 2: a route decision keeps the pick's label and each exclusion reason once

**Files:** `backend/src/superTabs/routeRecord.ts`, `backend/src/superTabs/routeDecisions.ts`,
`backend/src/superTabs/routeRecord.test.ts`, `backend/integration/superTabCosts.test.ts`.

**Interfaces:**

```ts
// backend/src/superTabs/routeRecord.ts
/** The record as stored: a label on the pick only, and exclusions grouped by reason. */
export interface StoredRouteRecord extends Omit<RouteRecord, 'excluded'> { excluded?: RouteRecord['excluded']; unavailable?: Array<{ reason: string; titles: string[] }> }
export function storedRecord(record: RouteRecord): StoredRouteRecord
/** Either form back to the record readers get: `unavailable` expanded into `excluded` (grouped order: by first appearance of
 *  each reason, then the titles in their order). A record with `excluded` (written before) is returned as it is. */
export function readRecord(stored: StoredRouteRecord | RouteRecord): RouteRecord
```

- [x] `routeRecord.test.ts`: a record with 3 candidates (pick `c1`) and 6 exclusions of 2 reasons: `storedRecord` keeps
  `label` on `c1` only, every other candidate field intact; `unavailable` has 2 entries; `readRecord(storedRecord(r))`
  equals `r` with the non-pick labels removed and the exclusions in grouped order (the read record is not checked
  against the input schema, which requires every label: nothing parses a stored record with it); `readRecord` of an old record returns it
  unchanged; a record with no exclusions stores none.
- [x] `superTabCosts.test.ts`: record a route of 13 candidates and 47 exclusions of 5 reasons, sized like
  production's (labels of ~540 characters, reasons of ~100, titles of ~80); the stored record's `$bsonSize` is under 60%
  of the record sent, the decision read by `GET /route-decisions/:id` lists all 31 candidates and all 47 exclusions with their titles
  and reasons, and starting the pick still links to it (`final` set, no override).
- [x] Run both; watch them fail. Commit the red tests.
- [x] Implement `storedRecord` and `readRecord`; write `storedRecord(effect.record)` in `writeRouteEffects`, read
  `readRecord(row.record)` in `decisionOf`. Run both, `npm test -- src/superTabs/routeRecord.test.ts`, and the route and
  costs integration files; green. Commit.

## Task 3: the stuck usage sweep says so every hour, and stops once nothing is left

**Files:** `backend/src/lib/productUsageReceiptSweep.ts`, `backend/integration/productUsageReceipts.test.ts`.

**Interfaces:**

```ts
// backend/src/lib/productUsageReceiptSweep.ts
/** The newest old receipt's expiry (one index key by product_usage_expiry), or null when none is left. */
export async function lastOldReceipt(db: PrismaClient, now: Date): Promise<Date | null>
// startReceiptSweep's log gains `error`; while refused, each hourly check:
//   null  → stop; info '[usage-receipts] done: no old receipts left'
//   date  → error '[usage-receipts] stuck: the database user may not install the receipt rule (collMod); nothing is removed. The old receipts expire by themselves by <ISO date>; grant collMod to finish sooner.'
```

- [x] Change the existing refusal test ("a database user that may not install the rule gets one warning…") to expect one
  error line per hourly check (two after an hour), naming 2026-… the newest old receipt's expiry, and none between checks;
  add "a refused sweep stops by itself once its old receipts have expired": no old receipt left → one `done` line, no
  further `collMod` tries.
- [x] Run the file; watch them fail. Commit the red tests.
- [x] Implement. Run the file and `npm test -- src/lib`; green. Commit.

## Task 4: backend/AGENTS.md

**Files:** `backend/AGENTS.md` (new), the three model comments in `backend/prisma/schema.prisma`.

- [x] Write the five rules, short, each with its reason and an example from this task: (1) every collection names what
  removes it, in its model comment (a TTL, a sweep, a delete on write, or "kept forever: why"); (2) receipt and log rows get
  a TTL index, made by the schema step before db push (`ensureIndex`, the operations example); (3) one index per query,
  checked with explain in an integration test (`plans.test-support.ts`); (4) a maintenance job that cannot run says so,
  loudly and repeatedly, with what it is waiting on; (5) measure on the read-only production database before and after
  (its environment file only, never printed), and put the numbers in the pull request.
- [x] Docs need no test; check that each model of the three names what removes it. Commit.

## After the tasks

- [ ] Push; mark Ready; post red/green evidence (each red commit's failing run, each green run) and the before numbers in a
  PR comment; add the Review step (a Reviewer by Routing, against MongoDB's two skills).
- [ ] After Ken's go and the release, measure again on the read-only production database: the `operation_expiry` index and
  its expiry, operations older than 30 days (0 once the monitor has run), the average size of route decisions written since,
  and the sweep's hourly line in the worker log; put the after numbers in the PR.
