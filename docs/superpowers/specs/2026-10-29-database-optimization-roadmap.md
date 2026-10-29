# Database optimization roadmap

Date: 2026-10-29 (v2, with Atlas data). Code read at `origin/main` (8e06c549e).

Evidence:
- Atlas, cluster `autonomous-code-prod`: 24 h of process metrics, the Performance Advisor slow-query log (14,975
  operations over 100 ms) and its suggested indexes.
- Collection and index sizes, read with the read-only user from a secondary.
- The backend's own CPU self-profile, 30 min (03:45–04:15 UTC, v1.3.63).
- A read of the code paths behind each finding.

Phases are ordered by priority, highest first. Each one is worth doing even if the later ones never ship.

Relation to the WebSocket roadmap: its Phase 2 (push instead of poll) cuts **how many** Swarm reads run. This roadmap
cuts **what each read and write costs**. Phase 2 below and WebSocket Phase 2 attack the same load from two sides.

## What we measured

**The cluster** is an M20 replica set: 3 nodes, 2 vCPUs and 4 GB each, MongoDB 8.0.

| Metric (primary, 24 h) | Average | Peak | Now (VN working hours) |
|---|---|---|---|
| Process CPU | 43% | 77% | 45% and rising |
| Queries / getMores / commands per s | 607 / 131 / 184 | 834 / 288 / 405 | 670 / 130 / 182 |
| Updates / inserts per s | 42 / 4.6 | 52 / 5.6 | 44 / 4.7 |
| Documents returned per s | 4,600 | 12,500 | 4,400 |
| Network out | 12.5 MB/s (about 1 TB/day) | 55 MB/s | 5.3 MB/s |
| Scanned per returned (query targeting) | 2.3 | 2.9 | 2.1 |
| Execution time, reads / writes | 1.0 / 1.5 ms | 5.9 / 7.6 ms | 0.3 / 0.5 ms |
| Memory available | about 1 GB of 4 GB | | 0.95 GB |
| Connections | 183 | 259 | 175 |

**Load comes from volume, not bad plans.** Plans are healthy now: 2.3 documents scanned per document returned, and
reads take under a millisecond on average. The CPU and the 1 TB/day sent out come from about 900 operations a second,
mostly Swarm polls, each returning whole documents. At the current shape, the cluster saturates at roughly 2× today's
peak. Under the Design rule in AGENTS.md (review when a limit is less than 10× away), this needs a design review now.

**The slow log shows one past incident and a quiet present:**
- **28 Oct, 04:00–07:00 UTC:** 17,300 s of slow operations. They were `$expr` reads on deliveries (50 M documents
  scanned for 220 k returned), native contexts and route decisions. The 28 Oct fixes ended it. Since 07:00 that day,
  slow operations total under 40 s an hour.
- **Since today's v1.3.63 deploy (2.5 h):** about 60 s of slow operations. They are:
  - large group reads (`SwarmGroup` getMore, 16 k documents returned);
  - the host poll's Swarm lookup (17 documents scanned per one returned);
  - hot-row updates on `product_usage_totals` (about 350 ms each);
  - reads with an empty id list. Prisma turns `in: []` into `$or: []`, which scans the whole collection; seen on
    `machines`, `users` and `SuperTab`;
  - ad-hoc and monitoring queries run on the primary: `createdAt` counts that scan whole collections, and one
    `product_usage_receipts` lookup by `userId` that scanned 3.7 M documents in 5.7 s.

**Data is small, apart from one collection.** 97 collections hold 364 MB of data and 243 MB of indexes.

| Collection | Documents | Data | Indexes |
|---|---|---|---|
| `product_usage_receipts` | 3,967,547 | 265 MB | **217 MB (89% of all index size)** |
| `SuperTabMessage` | 27,068 | 24 MB | 3 MB |
| `SuperTabRouteDecision` | 2,814 | 24 MB (8.8 KB each) | 0.5 MB |
| `SuperTabOperation` | 33,776 | 12 MB | 2 MB |
| `SuperTabDelivery` | 12,668 | 8 MB | 3 MB (7 indexes) |
| `SwarmGroup` | 961 | 4 MB | 1 MB (13 indexes) |

- **`product_usage_receipts`:** each document is only an id and an expiry, kept 19–36 days. Its `_id` index alone
  competes for the roughly 1 GB of free memory on each node.
- **Swarm sizes:** the openharness Swarm has 815 groups (3.9 MB), of which 147 are live (644 KB). A load of every
  live part is therefore about 0.7 MB.
- **Dead legacy state:** its `SuperTab` row still carries 882 KB of `legacyState`, and another Swarm's carries 309 KB.
  The 28 Oct migration made it dead weight, but those rows are still fetched by every host poll's lookup.

**Backend CPU** (self-profile): Swarm routes are about 73% of busy time.
- Desktop/web `changes` 23%, host `changes` 17%, messages 11%, machine report 7%, deliveries 6%.
- Prisma unpacking results is 35% of non-idle CPU, and deep copies of whole Swarm states are 14%.

## Phase 0 — Quick wins (highest priority, about a day, independent PRs)

Small changes with measured payoff.

1. **Shrink `product_usage_receipts`** (`lib/productUsage.ts:134-141`).
   - Today a receipt only stops a report from being counted twice, but it is kept as long as the totals
     (`PRODUCT_USAGE_DAYS + 1`).
   - Keep it only as long as a client can resend a report (for example 2 days). The TTL then removes about 95% of the
     4 M documents and of the 217 MB index, and frees memory on every node.
   - Done when the collection is under 300 k documents and its index under 20 MB.
2. **Drop the dead `legacyState`.** Run `migration/dropLegacy.ts` on prod, so the rows the host poll fetches lose 1.2 MB of dead state.
3. **Never query with an empty id list.** `in: []` becomes `$or: []` and a collection scan that returns nothing.
   Return early in the callers seen in the slow log (machines, users, `SuperTab`), and add a lint or helper so new code
   cannot do it.
4. **Batch `product_usage_totals` updates.** The per-connect upserts all hit the same `(dayUtc, metric)` rows, about
   350 ms each when they collide. Count in memory and flush once a minute, as `productUsageBatch.ts` already does for
   HTTP reports. Also cache the per-user preference read that runs on every connect.
5. **Keep ad-hoc and monitoring queries off the primary.**
   - Prod-watch and investigation scripts ran collection-scanning counts on the primary.
   - Use the read-only URL with `readPreference=secondary`, and count by indexed fields only.
   - Atlas's suggested `userId` indexes (receipts, messages, route decisions) come from those one-off lookups. Do not
     add them.

## Phase 1 — Measure per query shape (high priority, about a day, can run beside Phase 0)

Atlas logs only operations over 100 ms. The load lives in the roughly 900 fast operations a second, which nothing
attributes today: Prisma has no query hook (`lib/prisma.ts:8`), and Fastify has no request log (`server.ts:55`).

1. A Prisma `$extends` hook that records, per minute and pod, for each `model.action` and route: count, total ms and
   result bytes. It also logs any query over 200 ms with the shape of its filter.
2. Per-route p50/p95 latency, logged next to the existing `cpu by kind` line.
3. A script that saves the Atlas numbers above (metrics, slow log, sizes) for before/after comparison.
4. Atlas alerts: process CPU over 70% for 10 min, query targeting over 100, slow operations over 60 s/min, and
   network out over 30 MB/s.

Done when the top 20 query shapes by count × bytes are known, with the route that issues each one.

## Phase 2 — Read less per request (high priority, the largest win)

Goal: cut documents returned and bytes sent by at least 5×, which brings cluster CPU under 20% at today's peak.

1. **Commands load every live part of the Swarm** inside their transaction (`store.ts:903-904`,
   `parts/load.ts:45-64`). That is about 0.7 MB for openharness and about 25 round trips. A dormant named group loads
   it all again (`store.ts:520-527`), and a conflict retries the whole thing up to 8 times (`retry.ts:6`). Load the
   head, the actor's own part and the named groups only.
2. **The Lead's delivery poll loads the Swarm twice** (`store.ts:2154-2240`): once cached, once in the transaction.
   Then it checks each sender's grant one by one, an N+1 of up to 100 deliveries (`store.ts:2242-2250`). Load once, and
   read each sender's grant once.
3. **The Desktop/web `changes` cache is per person** (`cachedReads.ts:64-65`): its key includes the person's
   mentioned conversations, and every Swarm write drops it. Cache the shared read once, and add each person's mentions
   and decisions on top.
4. **`lastChangedAt` runs 7 aggregates over every part, dormant and deleted included** (`parts/load.ts:162-174`),
   after every write. Keep the newest change on the head document, set in the same commit.
5. **Machine reports (15 s per machine) and delivery claim/ack read every member and agent whole**
   (`store.ts:1937-1996`, `parts/light.ts:78-103`). Project to the fields they use.
6. **Deep copies:** each reader's view clones the whole state before filtering it (`model.ts:509`), and commands
   clone it before applying (`commands.ts:486`, `store.ts:696`). That is 14% of backend CPU. Filter from the frozen
   cached state, and copy only what changes.
7. **Non-Swarm:**
   - Every signed-in request and web-ws upgrade reads the same user twice (`ssoAuth.ts:290`, `UserService.ts:87`).
     Read once, and cache it for a few seconds.
   - `GET /api/machines` returns whole machine documents, api keys included, with no limit (`MachineService.ts:549`).
     Project and bound it.
   - Each web socket re-reads its device bindings every 30 s (`webWs.ts:79, 274, 291`). Push on change instead.
8. **Option:** for the 3–4 hottest reads, raw `aggregateRaw` with a projection skips most of Prisma's per-row cost.
   The repo already uses it where Prisma plans badly.

Done when, against the Phase 1 baseline, documents returned per second and network out fall at least 5×, and the
backend's Prisma share of CPU halves.

## Phase 3 — Make the next `$expr` incident impossible (medium-high priority)

The 28 Oct incident came from Prisma sending `in` and `has` filters as `$expr`, which the planner can only bound by
their first field. Plans are fine today, but these reads are still exposed:

1. Host poll Swarm lookup, once a second per host (`read/host.ts:62-64`): `machineIds has` OR
   `cleanupMachineIds has`, sorted by `updatedAt`, which has no index. The slow log shows 17 documents scanned per
   document returned.
2. Owner's grid Swarms, every minute per daemon (`store.ts:1912`): filters on `ownerId`, which has no index on
   `SuperTab`.
3. Swarm list, `memberIds has` (`store.ts:677`, `read/service.ts:139`).
4. An agent's open deliveries (`store.ts:189-190`), `status in` plus a sort.
5. `loadChanged` with up to 500 `tabId` values, and the message scroll-back cursor `OR` (`store.ts:1758`).
6. Sweeps:
   - `compactTombstones` has no `purgeAt` index on members, agents or machines;
   - `expireStarts` has no index leading on `finishedAt`;
   - `expireInvitations` reads every head whole.
7. The hourly people rollup scans by `dayUtc` with no index (`ProductUsagePeopleRollupService.ts:13`). The billing
   sync's index leaves its middle key unconstrained (`MachineBillingWorkerService.ts:82`).

Use the repo's existing pattern for each one: a raw match that names its index (`invitedSwarms.ts`, `pageReads.ts`),
with a plan test (`integration/superTabHotReads.test.ts`). Then make it a rule, enforced by a lint or a test
helper: no Prisma `in` or `has` on the hot Swarm collections outside the named-index helpers.

Done when each read has a plan test, and Phase 1's alerts show no query-targeting spike for a week.

## Phase 4 — Write less and conflict less (medium priority)

1. **Touches:** every command bumps its actor's part and its named group (`parts/touches.ts:37-48`). Two commands on
   one group conflict, and each retry reloads the Swarm. Measure the conflict rate and `SWARM_BUSY` 503s first, then
   touch only what correctness needs.
2. **A post rewrites the whole group document** (`parts/write.ts:128`). Keep hot fields (activity, digest, counters)
   apart from cold ones (brief, task, checks).
3. **Indexes cost writes:** `SwarmGroup` has 13 indexes for 961 documents, and `SuperTabDelivery` has 7. Use
   `$indexStats` to drop the unused ones, such as `SuperTabOperation [tabId]`, which nothing reads.
4. **One machine write per adapter connect, not two** (`adapterWs.ts:290`, `dailyTracking.ts:30`).
5. **Machine-report sweeps run once, not once per pod** (`store.ts:1927-1934`).

## Phase 5 — A deletion path for every collection (medium-low priority; needs owner decisions)

Data is small today (364 MB), so this is about the trend, not the current size. Collections with no deletion path:
- **Swarm:**
  - `SuperTabMessage`, finished deliveries, `SuperTabOperation` (one receipt per command);
  - attempts, native contexts, stop receipts, attachments;
  - dormant groups (815 groups in openharness, only 147 of them live);
  - `releasedTabIds`, which is only ever pushed to.
- **`SuperTabRouteDecision`:** 8.8 KB per decision, 24 MB for 2,814 decisions. It is pruned per conversation but
  unbounded overall. Store less per decision.
- **Others:** soft-deleted machines, checkout attempts, community notifications, revoked or expired harness shares,
  harness links, Agent Messages collections.

Decide a TTL for each one, declared in `schema.prisma` so the schema push keeps it. Then watch weekly sizes.

## Phase 6 — Capacity and safety (lower priority)

1. **Size the cluster after Phase 2, not before.** If Phase 2 brings CPU under 20%, the M20 has 10× headroom again.
   If it does not, move to M30 (8 GB).
2. **Connections:** PM2 runs one process per core, each with a pool of 20 (`ecosystem.config.cjs`,
   `databaseUrl.ts:10`). Today's 183–259 connections are fine. Set the pool size per process before adding pods.
3. **A failed schema push is ignored** (`lib/db/migrate.ts:44-46`), and the TTL step then rebuilds indexes over whole
   collections. Fail the release instead.
4. **Time limits:** set `maxTimeMS` on reporting reads and unbounded reads.
5. **Secondaries:** send lag-tolerant reads (leaderboard, rollups, analytics) to a secondary.

## Order of work and rough size

| Phase | Priority | Size | Risk | Measured payoff |
|---|---|---|---|---|
| 0 Quick wins | Highest | About a day | Low | About 200 MB of index out of memory; collision and scan spikes gone |
| 1 Measure per query shape | High | About a day | None | Needed to steer Phase 2 |
| 2 Read less | High | 1–2 weeks | Medium: projections must keep every field a caller uses | DB CPU and 1 TB/day out ÷5 |
| 3 No more `$expr` incidents | Medium-high | 3–5 days | Low | Prevents a repeat of 28 Oct (17,300 s of slow operations in 3 h) |
| 4 Write less | Medium | 1 week | Medium: touches guard correctness | Fewer retries and 503s |
| 5 Retention | Medium-low | 2–4 days after decisions | Low–medium: deleting needs sign-off | Flat growth |
| 6 Capacity and safety | Lower | 2–3 days | Low | Cluster size picked on data |
