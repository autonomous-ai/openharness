# Decisions, leaderboard and mentions reads stop loading the whole Swarm each request: plan

> Way of working: this plan's Engineer implements it task by task, test first (test-driven-development), in one pull
> request. No subagents, no execution handoff.

**Goal:** The three reads Ken's prod scan (2026-11-04 12:00 VN, v1.3.98) found hot answer exactly as today with far fewer
Mongo reads per request: decisions reads no Swarm part at an unchanged stamp, the leaderboard reads no dormant group at an
unchanged stamp, and mentions reads its tagged messages by one plain `$in` on `_id`.

**Architecture:**
- `store.decisions` loads the Swarm in a transaction (`this.load`), so every request reads members, agents, machines,
  unfinished starts, progress and active groups (~540 ms each on prod). It moves to `this.readLoad` (the read cache), as
  `costSummary` and `projectRepository` did in #2889; `listDecisions` then reads only the quiet conversations its rows name.
- The leaderboard reads its parts through the cache already, but `recentDormantGroups` reads every dormant group of the
  kept weeks on each request (86,610 docs in 2 h on prod). It becomes a cache entry, `board:{floor}:{projects}`, of the
  projects' dormant groups since the Monday that starts the window, holding only the board's fields, patched from each change
  like the other dormant entries (cachePatch.ts). The read then keeps the exact window and the index's order.
- `listMentions` reads its messages with Prisma's `findMany({ id: { in } })`, which Prisma sends as an `$expr` OR of one
  branch per id (slow planning, up to 1,640 ms). It reads them with `readBy` and a plain `$in` on `_id`, as `taggedThreads`
  already does.

**Tech Stack:** Fastify, Prisma on MongoDB, the Swarm read cache (`cache.ts`, `cachePatch.ts`), vitest with
mongodb-memory-server.

**Spec:** Task #2674 (Ken's prod scan, via River).

## Global Constraints

- Backend only. Same answers: each read is compared with a read straight from Mongo (`readCache: null`).
- No env switch; ships on. No production access.
- Indexes unchanged: the board entry loads through the existing project index (`groupsBy 'project'`).

## Review Focus

- The board entry's patch keeps exactly what a fresh load holds: a group that goes dormant, wakes, moves project, is
  deleted or gets newer activity.
- Answer order: the board read returns groups in the index's order, as before.
- Decisions answered from cached parts still check access per reader (`actor`, `author`) on every request.

## Design

- growth: the board entry holds at most six weeks of one project set's dormant groups, board fields only; the cache's byte
  cap and max age (cache.ts) evict it. Its key changes each Monday, so the old week's entry ages out.
- concurrency: none added; cache entries load once per stamp per process (cache.ts loading map).
- read cost: at an unchanged stamp, decisions reads no part and the board no group; a change reads only the delta.
- scale: 10x groups: the board entry grows with dormant groups of the window; cache bytes (cache.ts metrics) warn first.
- compatibility: no wire or schema change.
- migration + rollback: none; rollback is the previous release.
- audience: unchanged checks per reader (actor, canReadGroup, readsRecordsIn) on every request.
- identity: reads stay the caller's own.
- failure: without stamps (Redis down) every get reads Mongo, as today.
- platforms: N/A because backend only.

## Task 1: decisions through the read cache

**Files:** `backend/src/superTabs/store.ts`; test `backend/integration/superTabRequestReads.test.ts`.
- [ ] Failing test: a second decisions read at an unchanged stamp reads part rows today; it must read none and answer as a
  direct read.
- [ ] `decisions` uses `readLoad`; `listDecisions` reads with `this.db`.

## Task 2: leaderboard's dormant groups from the read cache

**Files:** `backend/src/superTabs/leaderboard/read.ts`, `backend/src/superTabs/cachePatch.ts`,
`backend/src/superTabs/read/service.ts`; tests `backend/src/superTabs/cachePatch.test.ts`,
`backend/integration/superTabRequestReads.test.ts`.
- [ ] Failing tests: a second board read at an unchanged stamp reads dormant groups today; it must read none. After a group
  goes dormant, wakes or is deleted, the board answers as a direct read, every week and with all projects.
- [ ] `boardRule(projects, floor)` and the `board:` entry; the read keeps `lastActivityAt >= since` in index order.

## Task 3: mentions read their messages by a plain `$in`

**Files:** `backend/src/superTabs/mentions.ts`; test `backend/integration/superTabRequestReads.test.ts`.
- [ ] Failing test: the mentions read's message query is sent as an `$expr` OR today; it must be one `$in` on `_id`, one
  IXSCAN, with the same answer.
- [ ] `listMentions` reads with `readBy(tx, 'SuperTabMessage', 'id', …)`.
