# Lag-tolerant reads on the secondaries: implementation plan

> Implemented by the task's Engineer task by task, each failing test committed before its code (project instructions,
> Engineer). One independent review on the pull request.

**Goal:** At the 11-04 peak (05–10Z) the Atlas primary of the M20 cluster averaged 69% CPU while the two secondaries sat
at 19% and 15%, and the backend reads from the primary only (task #2970). Move the reads that tolerate a few seconds of
lag to the secondaries; everything that must see the latest write stays on the primary.

**Architecture:**
- `lib/databaseUrl.ts secondaryReadsUrl(url)`: the main `DATABASE_URL` with `readPreference=secondaryPreferred`,
  `maxStalenessSeconds=90` and `appName=autonomous-code-prod-secondary` set (each replacing the same option, matched
  case-insensitively, and every other option kept), then the pool defaults. No new connection string (Ken, 11-04):
  the `mongodb+srv` host already lists all three members.
- `lib/prisma.ts prismaSecondary`: a second Prisma client on that string, timed by `withQueryStats` under the label
  `secondary` so `db by shape` tells its reads apart. `DATABASE_SECONDARY_READS=off` (default `on`) makes it the main
  client itself: one setting, no code change, sends every moved read back to the primary.
- Moved reads take the client explicitly; nothing else changes client:
  - Older history pages (`SuperTabStore.messages` with a `before` cursor, chat and thread): the message batches, their
    reactions, receipts and thread summaries. A batch is read from the secondary only with its edge: one query
    `sequence <= edge` that must return the row the reader already holds. A secondary that does not hold it yet (lag)
    reads that batch from the primary, so lag never opens a gap in history.
  - Costs (`SuperTabStore.costSummary` → `costs/read.ts costRows`): a report over days of route decisions.
  - Leaderboard people names (`leaderboard/read.ts profileNames`). The board's groups stay on the read cache, which
    holds what it loads at the Swarm's stamp; a stale load there would stay stale until the next change.
  - Community search (`GET /api/community/harnesses?q=`): the feed page's unanchored text match.
  - Usage totals (`GET /api/analytics/overview`): the daily buckets, machine days and machine states.
- Kept on the primary: the change feeds (`changedAt`/`readAt $gt`), the newest page, `after` pages and exact messages,
  the Swarm load and every access check (`readLoad`, `actor`, `canReadGroup`), the hidden-copy and pointed-row checks
  that decide what a reader may see, status, sign-in, and every read inside a write's transaction.
- `scripts/atlas-snapshot.ts`: the summary table gains each secondary's process CPU next to the primary's.

**Tech Stack:** TypeScript, Prisma 5 on MongoDB (`aggregateRaw`), Vitest, mongodb-memory-server replica sets.

**Spec:** task #2970's brief and Ken's two follow-ups of 11-04 (derive the string from `DATABASE_URL`; one off switch).

## Global Constraints

- Only reads move. A moved read never runs inside a transaction (a transaction reads the primary).
- A failing test first for each change; red/green evidence in a PR comment; backend `npm test` before Ready. The Super
  Tab integration suite runs in PR CI.
- Swarm code stays out of `cli/src/core`. Temp files only in `mktemp -d` folders.

## Design

- growth: N/A because nothing new is stored.
- concurrency: N/A because only reads move; writes and their transactions stay on the primary.
- read cost: the same queries and indexes; the secondaries serve them. An older page's edge check reads one row more.
- scale: at 10x the moved reads grow with people scrolling and reporting, not with Swarm size. The first warning is
  the secondaries' process CPU, now in Ken's snapshot table, and `secondary:` rows in `db by shape`.
- compatibility: no response changes; clients see the same rows.
- migration + rollback: none to migrate. Rollback is `DATABASE_SECONDARY_READS=off` and a restart, no code change.
- audience: N/A because access checks stay on the primary and run before any moved read.
- identity: N/A because it uses the backend's own database login.
- failure: on a failover `secondaryPreferred` reads the primary by itself; an edge the secondary lacks reads the primary.
  Both show in `db by shape` as the moved shapes without the `secondary:` label.
- platforms: backend only.

## Review Focus

- Every moved read tolerates up to 90 s of lag, and none decides a write or an access.
- The edge check: an older page from the secondary can never skip a row the primary has before the edge.
- The off switch returns exactly the main client.

## Task 1: the secondary connection string and client

**Files:** `backend/src/lib/databaseUrl.ts`, `backend/src/lib/databaseUrl.test.ts`, `backend/src/lib/prisma.ts`,
`backend/src/lib/prisma.test.ts`, `backend/src/config/env.ts`, `backend/src/lib/queryStats.ts`,
`backend/src/lib/queryStats.test.ts`, `backend/src/server.ts`

**Interfaces:** `secondaryReadsUrl(url: string): string`; `readReplica(primary, url, reads: 'on' | 'off', make?)`;
`prismaSecondary: PrismaClient`; `withQueryStats(client, stats?, warn?, label?)`.

- [ ] Test: a URL without options, with options (an old `readPreference`, `appName`, other options kept), and an SRV URL
      without a path get the three options; the off switch returns the main client, on returns another client.
- [ ] Watch them fail.
- [ ] Implement; the server disconnects the second client on shutdown when it is one.
- [ ] Test: a labelled client's queries show as `secondary:Model.action` in `db by shape`; watch it fail; implement.

## Task 2: older history pages on the secondary

**Files:** `backend/src/superTabs/pageReads.ts`, `backend/src/superTabs/store.ts`, `backend/src/routes/superTabs.ts`,
`backend/integration/secondaryReads.test.ts`, `backend/vitest.super-tabs.config.ts`

**Interfaces:** `SuperTabStoreHooks.replica?: PrismaClient` (default: the store's own client); `heldPast(tx, at, edge,
limit): Promise<SuperTabMessage[] | null>` (null: the secondary does not hold the edge).

- [ ] Integration test on a single-node replica set, with the primary and secondary clients recorded apart: an older
      page reads its rows on the secondary and returns the same rows as the primary alone; the newest page, an `after`
      page, the Swarm change feed and the access checks read the primary only; a secondary without the edge (another
      database) reads the page from the primary and returns the same rows.
- [ ] Watch it fail.
- [ ] Implement `heldPast` and the store's older-page path; the production store passes `prismaSecondary`.

## Task 3: costs, leaderboard names, search and usage totals

**Files:** `backend/src/superTabs/store.ts`, `backend/src/superTabs/read/service.ts`, `backend/src/lib/communityFeed.ts`,
`backend/src/routes/community.ts`, `backend/src/routes/community.test.ts`, `backend/src/lib/analyticsQuery.ts`,
`backend/integration/secondaryReads.test.ts`

- [ ] Tests: costs read their decisions on the secondary and their access on the primary; the leaderboard's names come
      from the secondary; a community search reads its page through the secondary client and an unsearched feed does
      not; the analytics overview reads its buckets through the secondary client.
- [ ] Watch them fail.
- [ ] Implement.

## Task 4: secondary CPU in Ken's snapshot

**Files:** `backend/scripts/atlas-snapshot.ts`, `backend/integration/atlasSnapshot.test.ts`

- [ ] Test: a snapshot with a primary and two secondaries lists each secondary's process CPU (average, peak, latest)
      in `summary.md`, and `--compare` shows them; watch it fail.
- [ ] Implement.
