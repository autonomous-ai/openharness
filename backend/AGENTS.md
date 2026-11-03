# The Harness backend: MongoDB rules

Read this before changing anything under `backend/` that stores data: `prisma/schema.prisma`, a collection, an index, a
query, an aggregation or a maintenance job. The repository-wide rules are in [../AGENTS.md](../AGENTS.md) and
[../ENGINEERING.md](../ENGINEERING.md). Read MongoDB's skills first, as the project's instructions say:
[schema design](https://raw.githubusercontent.com/mongodb/agent-skills/main/skills/mongodb-schema-design/SKILL.md) and
[query optimization](https://raw.githubusercontent.com/mongodb/agent-skills/main/skills/mongodb-query-optimizer/SKILL.md).

These five rules come from production. On 2026-11-03 four collections were growing with nothing removing them
(task #2488): operation receipts at 14k a day, route decisions at 21 KB a row, and 4M usage receipts whose sweep had been
waiting on a permission, quietly, for five days.

1. **Every collection names what removes it**, in its model's comment in `prisma/schema.prisma`: a TTL index, a sweep,
   a delete on write, or "kept forever" and why. A new model without that line is not done. Check the size of a row
   too: `SuperTabRouteDecision` doubled when the route started listing every engine on every machine. Keep what a reader
   reads (`routeRecord.ts storedRecord`).
2. **Receipt and log rows get a TTL index.** Declare it in Prisma with `map:` so `db push` keeps it, and make it with
   its expiry through `ensureIndex` (`src/lib/db/indexes.ts`). Production's app user may not run `collMod` (10-29), so a
   TTL index new to a collection that already exists is made *before* the push (`src/lib/db/schemaRelease.ts`,
   `superTabs/operations.ts`). A push would build it without its expiry, and `collMod` would then be refused.
   `integration/schemaRelease.test.ts` lists every expiry index and checks this.
3. **One index per query, checked with explain.** Each new or changed query gets an integration test that reads its plan:
   `IXSCAN` on the index meant for it, and documents examined close to documents returned
   (`integration/plans.test-support.ts`, `integration/workerIndexPlans.test.ts`). Prisma sends `in` and some filters as
   `$expr`, which no index bounds. Use a plain `aggregateRaw` `$match` for those (`superTabs/routeDecisions.ts
   recentDecisions`).
4. **A maintenance job that cannot run says so, loudly and every time it tries.** Log an error with what it waits on and
   what happens if nobody acts (`lib/productUsageReceiptSweep.ts`: every hour, with the date the receipts expire by
   themselves). A single warning at start is missed. A job that can never finish stops itself once its work is gone.
5. **Measure on the read-only production database before and after**, and put the numbers in the pull request: row
   count, data and index size, growth per day, and the size of a row's parts. Read it through its environment file only
   (`~/.harness-ro-prod-db`, loaded in the same command that reads it) and never print its address. A TTL index or any
   other index change is a production write made by the backend release's schema step. It ships with the release owner's
   go, in the day window, with backend CPU and latency watched before and after.
