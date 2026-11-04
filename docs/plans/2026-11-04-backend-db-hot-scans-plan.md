# Backend DB, group A: three hot-path scans: implementation plan

The Engineer implements this plan task by task, test first, on one branch, and opens one pull request. Nobody is asked to
choose an execution mode. Steps use checkboxes.

**Goal:** Stop three reads from scanning whole collections: deliveries read without `tabId`, empty `in` lists, and the
operations read by Swarm and date.

**Architecture:** The delivery read becomes a plain `$match` with `tabId`, served by the existing `[tabId, messageId]` index.
Each Prisma `in` list on a hot path that can be empty is tested first and sends no query when empty. The empty-list check gets
the hole closed that let the two production cases through. One new index, built by the release's schema step.

**Tech Stack:** TypeScript, Prisma on MongoDB, Vitest, plan tests on `mongodb-memory-server`.

**Spec:** Ken's plan in the project chat (2026-11-04), group A, and task #2595's brief.

## Global Constraints

- Measure before and after; aggregates only; never print the read-only login.
- Ships with the next backend release; merges through the PM's batch.
- PR body first line: `Requested by 0xken15@gmail.com through Harness.`

## Review Focus

- A retry whose message is already stored: its deliveries are still written once, and never sent twice.
- A batch with some reports refused and some accepted: receipts are still read for the accepted ones.
- A person with no shares, no invitations or no Swarm: the same empty answer as before, with no query.
- A list built only of spreads (`[...new Set(ids)]`): the check must flag it unless tested. A spread of a constant passes.
- A shared machine whose billing refuses it: the owners read is skipped and the answer stays empty.

## Design

- **Growth:** no new collection. `SuperTabOperation` gains one index, removed with its rows by the 30-day TTL.
- **Concurrency:** N/A because reads and one index only; no write changes shape.
- **Read cost:** the point of the change. Numbers are in the pull request.
- **Scale:** at 10x (1.2M operations) the new index is about 15 MB; backend CPU and Atlas's slow log warn first.
- **Compatibility:** no API or client change. An old pod keeps its old reads until it is replaced.
- **Migration + rollback:** the release's schema step builds the index (`db push`). Nothing else is needed. Removing it from the
  schema drops it again on a later release.
- **Audience:** N/A because no data is exposed or newly stored.
- **Identity:** N/A because no account is involved.
- **Failure:** a skipped read returns the same empty answer; a failing index build fails the schema step and says so.
- **Platforms:** backend only.

## Left out

- `product_usage_totals {machineId, dayUtc}`: no row has that field, its model forbids it, and no backend code filters by it.
- `communityReports`, `confidential.ts`: not hot, or their lists are never empty in practice. Raw `$in: []` reads do not scan.

---

### Task 1: The delivery read carries tabId

**Files:** Modify `backend/src/superTabs/store.ts`, `backend/src/superTabs/hotFilters.allowed.json`. Test `backend/integration/superTabNoticeDigest.test.ts`.

**Interfaces:** none new.

- [x] Write a failing plan test on a real poll with a stored message: one read by `tabId` and `messageId`, `IXSCAN`, examining only its rows.
- [x] Watch it fail; commit.
- [x] Implement; watch it pass; commit.

### Task 2: Empty lists send no query

**Files:** Modify `backend/src/lib/productUsage.ts`, `backend/src/routes/harnessShares.ts`, `backend/src/routes/community.ts`, `backend/src/superTabs/store.ts`, `backend/src/superTabs/workspaceStore.ts`, `backend/src/lib/emptyInList.test-support.ts`. Test the matching test files and `backend/integration/superTabNamedReads.test.ts`.

**Interfaces:** `GUARDED_MODELS` gains the models fixed here.

- [x] Write failing tests for each read, and for the check on a spread-only list.
- [x] Watch them fail; commit.
- [x] Implement; watch them pass; commit.

### Task 3: The operations index

**Files:** Modify `backend/prisma/schema.prisma`. Test `backend/integration/superTabNamedReads.test.ts`.

**Interfaces:** the index `[tabId, createdAt]` on `SuperTabOperation`.

- [x] Write a failing plan test: a small Swarm's wide date range examines only its rows.
- [x] Watch it fail; commit.
- [x] Add the index; watch it pass; run `npm test`; post the numbers; mark the PR ready; add one review step.
