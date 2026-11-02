# Harness shares list index Implementation Plan

> **Way of working (project instructions, revision 23):** the Engineer implements this plan task by task, test first; one independent Review step on the pull request. No subagent-driven-development, no execution handoff.

**Goal:** The share list (`GET /api/harness-shares`) reads its rows through an index that also gives the `createdAt` order, so Mongo does no in-memory sort.

**Architecture:** Add `@@index([recipientEmail, autonomousEnv, revokedAt, createdAt, expiresAt])` to `HarnessShare`. The list filters the first two by equality, then `revokedAt`/`expiresAt`, and sorts by `createdAt` ascending with `take: 1000`. Equality fields first (`revokedAt: null` included, so the revoked-but-unexpired shares, about 1,084 of the busiest recipient's 1,116 in prod, are never fetched), then the sort field, lets Mongo walk one recipient's live shares in order and stop at 1000; `expiresAt` last drops an expired share from its key before the fetch. Lead's before numbers on the PR showed the sort is not the cost (32 rows); the fetches are. The existing `(recipientEmail, autonomousEnv, expiresAt)` index stays: nothing is dropped.

**Tech Stack:** Prisma (MongoDB), vitest with a loopback `MongoMemoryReplSet` (`integration/plans.test-support.ts`).

**Spec:** Task #2151 (Ken's prod DB profile, Atlas Performance Advisor item 5: `harness_shares {createdAt: 1}` for the recipientEmail share list, 7 calls, avg 237 ms).

## Global Constraints

- Creating or dropping a production index is a production write: it needs Ken's go before it runs.
- Before/after measurement on prod slow logs, same window length, through the read-only production login only; never print it.
- Full Super Tab integration suite before Ready (`npm run test:super-tabs`).
- Pull request body starts with: `Requested by ken15@autonomous.ai through Harness.`
- Optimizations ship on, with no on/off switch.

## Design

- Growth: one index entry per share row (five small fields). Rows leave with `superTabs/purge.ts` (`deleteMany` by `superTabId`) and when a share is removed; nothing new grows.
- Concurrency: building an index takes a brief exclusive collection lock; the collection is small (shares, not events). Inserts, deletes and a revoke (`revokedAt`) update one more index entry; a rename does not touch it.
- Read cost: the list reads only the recipient's shares, in order, and stops at 1000. Before: an index scan on `(recipientEmail, autonomousEnv, expiresAt)` that fetches every unexpired share of that recipient, revoked ones included, then sorts them.
- Scale 10x: reads stay bounded by one recipient's shares. The warning metric is the list's slow-log count and `docsExamined` per call.
- Compatibility: indexes are invisible to clients; old and new backends read the same rows.
- Migration + rollback: `prisma db push` builds the index; rollback is dropping it (the old index still serves the filter). Both are production writes needing Ken's go.
- Audience: unchanged; the filter is still the signed-in account's email and environment.
- Identity: unchanged.
- Failure: if the build fails, the list works as today through the old index.
- Platforms: backend only.

## Review Focus

- The list returns the same rows in the same `createdAt` order, including a revoked share and an expired share left out.
- Another recipient's shares, and the same email in another `autonomousEnv`, never appear.
- A recipient with more than 1000 shares still gets the oldest 1000 in order.
- A share whose `revokedAt` was never set (missing field) is still listed.
- The old `expiresAt` index is still declared, so no other reader of it loses its plan.

---

### Task 1: Index the share list by recipient, environment and creation time

**Files:**
- Create: `backend/integration/harnessSharesIndexPlan.test.ts`
- Modify: `backend/prisma/schema.prisma:881`
- Modify: `backend/vitest.super-tabs.config.ts` (add the test to `include`)

**Interfaces:**
- Consumes: `planDatabase`, `profiled`, `reads`, `plan` from `integration/plans.test-support.ts`; `harnessShareRoutes` from `src/routes/harnessShares.ts`.
- Produces: the index `HarnessShare_recipientEmail_autonomousEnv_revokedAt_createdAt_expiresAt_idx`.

- [ ] **Step 1: Write the failing test** — seed shares of several recipients (30 revoked but unexpired, one expired, one other environment, explicit `revokedAt: null` as the route writes it), call the list through the route, and expect the share-list read to plan as an `IXSCAN` on the new index and examine no more documents than the 5 it returns.
- [ ] **Step 2: Run it and watch it fail** — `cd backend && NODE_ENV=test npx vitest run --config vitest.super-tabs.config.ts integration/harnessSharesIndexPlan.test.ts`. Expected: FAIL, plan is the `expiresAt` index with a `SORT`.
- [ ] **Step 3: Commit the failing test.**
- [ ] **Step 4: Add `@@index([recipientEmail, autonomousEnv, createdAt])` after the existing index.**
- [ ] **Step 5: Run the test; expect PASS. Run `npm run test:sharing` and `npm run test:super-tabs`.**
- [ ] **Step 6: Commit the schema change.**

### Task 2: Measure on production and record

**Files:**
- Modify: this plan (results section)

- [ ] **Step 1: Before:** with the read-only login from its environment file, count the share-list slow ops over the profile's window length (1 h 48 min) and their average time. Nothing printed but counts.
- [ ] **Step 2: After:** only once Ken has said go, the release has built the index, and a same-length window has passed; same query. Record both in the pull request.
