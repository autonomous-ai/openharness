# Usage counters write once a minute — Plan

**Goal:** Cut `product_usage_totals` load: no read before write, and each counter written at most once a minute per pod.
**Architecture:** One in-memory accumulator per pod (`createRelayTotals`, already flushing relay connects every minute, with a receipt per batch) now also takes report totals; the hourly people rollup stops using Prisma `upsert` (find + update per counter) and sends one raw `$set` upsert command.
**Tech Stack:** Fastify backend, Prisma on MongoDB, `$runCommandRaw`, vitest.
**Spec:** Task #3052 (Ken, Watch Production: Atlas primary CPU ≤ 40% at peak).

## Global Constraints
- No new settings or switches. Counter names, meanings and UTC day boundary unchanged.
- A report's receipt still commits in its transaction; only its totals wait in memory (a dead pod loses < 1 minute).
- Totals are added to memory only after the transaction commits, never inside a retried attempt.

## Review Focus
- Double counting on transaction retry; flush on shutdown; the `Prisma upsert` fallback (compound unique) in the rollup.

## Tasks
- [ ] 1. `createRelayTotals.add(day, metric, value = 1)` (`backend/src/lib/productUsageRelay.ts`): test sums values, one write per key.
- [ ] 2. Report ingest counts in memory after commit (`backend/src/lib/productUsage.ts`): tests — N reports → zero `product_usage_totals` writes in the transaction, one write per counter at flush, day boundary splits, retry counts once.
- [ ] 3. Rollup writes one raw `$set` upsert command, no reads (`ProductUsagePeopleRollupService.ts`, `productUsageWrite.ts`): test — zero `upsert`/`find` on totals, chunks of 500.
