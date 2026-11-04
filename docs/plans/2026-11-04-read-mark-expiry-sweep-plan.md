# Read-mark expiry sweep Implementation Plan

> Implemented by the task's Engineer, task by task, test first (project instructions, Engineer role). One independent
> review on the pull request.

**Goal:** Read marks untouched for 180 days are removed in production too, where the API's database user may not set the
`read_mark_expiry` index's expiry (collMod refused).

**Architecture:** `ensureIndex` answers whether the expiry was refused. Where `read_mark_expiry`'s was, the singleton
worker runs a sweep that removes one bounded chunk of marks older than `READ_MARK_EXPIRY_MS` every 30 s, by the existing
`{updatedAt}` index (`read_mark_expiry`), the way #2912/#2923 remove old usage receipts. The chunk removal (find ids by the
index, then delete exactly those by `_id`, range checked again) and the timer loop move out of
`productUsageReceiptSweep.ts` into one shared `lib/chunkSweep.ts` that both sweeps use. Where the expiry is set, nothing
runs.

**Tech Stack:** TypeScript, Prisma `$runCommandRaw` on MongoDB 7, vitest (unit fakes in `src/`, a loopback replica set in
`integration/`).

**Spec:** Task #2696 brief (Ken's prod scan 11-04, item 7): "when ensureIndex for read_mark_expiry reports that collMod
was refused, the API runs a sweep that deletes SuperTabReadMark rows whose updatedAt is older than READ_MARK_EXPIRY_MS, one
bounded chunk every 30 s, served by the existing {updatedAt} index, on one worker only if #2912 does so. Where the expiry
is set, nothing extra runs. Reuse #2912's sweep code rather than copying it."

## Global Constraints

- Chunk 500 marks, one chunk per pass, a pass every 30 000 ms (as `RECEIPT_SWEEP`).
- Runs only in the singleton worker (`src/worker.ts`), as `startReceiptSweep` does; never in the PM2 API cluster.
- Query by the `read_mark_expiry` index (`{updatedAt: 1}`), delete by `_id` (`hint: {_id: 1}`), as #2923 learned.
- No env switches. No production access. No schema or index change.
- The receipt sweep's behavior and log lines stay exactly as they are (`integration/productUsageReceipts.test.ts`).

## Design

- growth: this is what deletes read marks past 180 days where the TTL is refused.
- concurrency: one worker; a pass still running when the next is due skips it; each delete re-checks `updatedAt < cutoff`,
  so a mark moved between the find and the delete stays.
- read cost: one index range seek of ≤500 keys a pass; an empty pass reads one key.
- scale: 10x marks → 10x passes to catch up; the warning metric is the `[read-marks] pass` removed count staying at 500.
- compatibility: no data shape changes; old and new servers read marks alike.
- migration + rollback: none; a rollback stops the sweep and the marks simply stay, as today.
- audience / identity: N/A because no request path changes.
- failure: a refused expiry already warns once (`ensureIndex`); the sweep logs its start, each pass that removed marks, and
  each failed pass, then retries.
- platforms: backend only.

## Review Focus

1. A mark exactly 180 days old stays (`$lt`, not `$lte`) — integration test in Task 3.
2. A mark raised between the sweep's find and its delete stays — unit test in Task 2 (delete filter carries the range).
3. A set expiry starts no timer and runs no command — unit test in Task 3.
4. The sweep never stops by itself (marks keep ageing); an empty pass must stay one index seek — unit test in Task 3.
5. The receipt sweep's log lines and stop-when-done stay unchanged — the existing receipt integration tests, run in Task 2.

---

### Task 1: ensureIndex answers a refused expiry

**Files:**
- Modify: `backend/src/lib/db/indexes.ts` (`ensureIndex`)
- Modify: `backend/src/superTabs/readMarks.ts` (`ensureReadMarkExpiry`)
- Modify: `backend/src/lib/db/schemaRelease.ts` (`releaseSchema`)
- Test: `backend/src/lib/db/indexes.test.ts`, `backend/src/superTabs/readMarks.test.ts` (new)

**Interfaces:**
- Produces: `type IndexOutcome = 'ready' | 'expiry-refused'`; `ensureIndex(db, collection, index): Promise<IndexOutcome>`;
  `ensureReadMarkExpiry(db): Promise<boolean>` (true when the expiry is set); `releaseSchema(db?, target?):
  Promise<{ readMarkExpirySet: boolean }>`.

- [ ] **Step 1: Write the failing tests** — in `indexes.test.ts` the refused-collMod case resolves `'expiry-refused'` and
  the collMod case `'ready'`; in `readMarks.test.ts`, `ensureReadMarkExpiry` on a fake whose collMod throws code 13 resolves
  `false`, and on one whose index already has `expireAfterSeconds: 15_552_000` resolves `true`.
- [ ] **Step 2: Run** `npm test -- src/lib/db/indexes.test.ts src/superTabs/readMarks.test.ts` — expect FAIL (undefined).
- [ ] **Step 3: Implement** the return values; `releaseSchema` keeps its order and returns `ensureReadMarkExpiry`'s answer.
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit** test, then code.

### Task 2: one shared chunk sweep

**Files:**
- Create: `backend/src/lib/chunkSweep.ts`
- Modify: `backend/src/lib/productUsageReceiptSweep.ts` (`removeChunk`, `startReceiptSweep` use it)
- Test: `backend/src/lib/chunkSweep.test.ts` (new)

**Interfaces:**
- Produces:
  - `removeChunk(db: Pick<PrismaClient, '$runCommandRaw'>, chunk: { collection: string; filter: Record<string, unknown>;
    sort: Record<string, 1 | -1>; hint: string; chunk: number }): Promise<number>` — `find` with `filter`, `sort`, `hint`,
    `projection {_id: 1}`, `limit = batchSize = chunk`, `singleBatch`; then one `delete` of `{_id: {$in: ids}, ...filter}`
    with `hint {_id: 1}`, `limit 0`; throws on `writeErrors`; 0 without a delete when nothing was found.
  - `startChunkSweep(sweep: { label: string; everyMs: number; pass: () => Promise<{ removed: number; done: boolean }>;
    doneMessage?: string; log: Pick<typeof logger, 'info' | 'warn'>; handle?: (error: unknown) => boolean }): () => void`
    — runs `pass` now and every `everyMs` (unref'd), skips while one runs, logs `${label} pass` with `{ removed,
    removedSinceStart }` when it removed any, stops and logs `${label} ${doneMessage}` on `done`, and on an error not
    `handle`d logs `${label} pass failed; retrying next pass` with `{ error }`.

- [ ] **Step 1: Write the failing tests** — `removeChunk` sends a find with `limit` and `batchSize` both equal to `chunk`
  and the given hint, then a delete whose `q` is `{_id: {$in: ids}, ...filter}` with `hint {_id: 1}`; finds nothing → no
  delete; `startChunkSweep` skips an overlapping pass, stops after `done`, logs a failed pass and runs the next.
- [ ] **Step 2: Run** `npm test -- src/lib/chunkSweep.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `chunkSweep.ts` from #2912/#2923's code; the receipt sweep calls it with its own range, hint
  `product_usage_expiry`, label `[usage-receipts]`, done message `done: no old receipts left`, and a `handle` that turns
  `ReceiptRuleRefused` into its one warning and `withoutRule`.
- [ ] **Step 4: Run** `npm test -- src/lib/chunkSweep.test.ts` and `npx vitest run --config vitest.super-tabs.config.ts
  integration/productUsageReceipts.test.ts` — expect PASS, unchanged receipt behavior.
- [ ] **Step 5: Commit** test, then code.

### Task 3: the read-mark sweep

**Files:**
- Modify: `backend/src/superTabs/readMarks.ts` (`READ_MARK_SWEEP`, `sweepReadMarks`, `startReadMarkSweep`)
- Modify: `backend/src/worker.ts` (start and stop it)
- Test: `backend/src/superTabs/readMarks.test.ts`, `backend/integration/superTabReadMarks.test.ts`

**Interfaces:**
- Consumes: `removeChunk`, `startChunkSweep` (Task 2); `releaseSchema(...).readMarkExpirySet` (Task 1).
- Produces: `READ_MARK_SWEEP = { chunk: 500, everyMs: 30_000 }`; `sweepReadMarks(db, now: Date, chunk?: number):
  Promise<number>` (filter `{updatedAt: {$lt: now − READ_MARK_EXPIRY_MS}}`, sort `{updatedAt: 1}`, hint
  `read_mark_expiry`); `startReadMarkSweep(db, expirySet: boolean, settings?: Partial<{ chunk; everyMs; now: () => Date;
  log }>): () => void` — a no-op stop, with no command and no timer, when `expirySet`; otherwise logs its start once and runs
  `startChunkSweep` with label `[read-marks]`, never done.

- [ ] **Step 1: Write the failing tests** — unit: `startReadMarkSweep(fake, true)` runs no command; `(fake, false)` sends
  a find on `SuperTabReadMark` with hint `read_mark_expiry`, `limit 500`, and the cutoff `now − 180 d`, then a delete of
  the found ids; an empty find sends no delete. Integration (real Mongo): marks at 181 d, exactly 180 d and 179 d → one
  `sweepReadMarks` removes only the 181 d ones; 7 old marks with `chunk 3` → a pass removes 3 and leaves 4.
- [ ] **Step 2: Run** `npm test -- src/superTabs/readMarks.test.ts` and `npx vitest run --config
  vitest.super-tabs.config.ts integration/superTabReadMarks.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the sweep; `worker.ts` keeps `releaseSchema()`'s answer and calls `startReadMarkSweep(prisma,
  schema.readMarkExpirySet)` next to `startReceiptSweep`, stopping it on shutdown.
- [ ] **Step 4: Run** the Step 2 commands — expect PASS; then `npm test` (backend unit suite) once before Ready.
- [ ] **Step 5: Commit** test, then code.
