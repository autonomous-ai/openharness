# Design: Swarm read cache by stamp (Stability Roadmap 2.2 + 2.6)

Every backend process keeps what it read of a Swarm's parts, keyed by that Swarm's stamp in Redis. A read with an
unchanged stamp does not ask MongoDB for the Swarm's parts. Code: `backend/src/superTabs/cache.ts` (stamps, cache,
bumps), `backend/src/superTabs/cachedReads.ts` (reads built from what the cache holds).

## How it works

- **Stamps.** Redis hash `swarm:stamp:{tabId}` with two counters:
  - `main` moves on any commit that changes the Swarm's parts.
  - `machine` moves when a machine part's own reading is the only change (a report every 15 s). What a machine's host
    hears of is unmarked by such a write (`parts/commit.ts hostMarker`), so nothing else depends on it. Such a write
    dates the part's `readAt`, not its `changedAt`. The change feed reads both. The Swarm's `lastChangedAt` (max
    `changedAt`) therefore no longer moves every 15 s for every machine. Clients keep the part with the higher
    version and never read `changedAt`.
  - Touches change no data and move nothing.
  - Each move sets the stamp to Redis's clock in microseconds, or one past its value if that is higher
    (`cache.ts BUMP`). A stamp is therefore its bump's time and never runs ahead of the clock, so Redis losing the
    key or coming back with an older value (a restart, a snapshot, a lagging replica) never hands out a stamp a
    process may still hold. Millisecond stamps could (review of #2456).
- **Bump after commit.** Every part write records its Swarm in the transaction (`parts/write.ts guardedWrite`,
  `parts/load.ts insertParts`). `swarmTransaction` bumps those Swarms after the commit, before the caller answers. Any
  read after the answer, on any process, therefore sees the change. This covers the store's commands, sweeps,
  migration and rollback. Each bump is also broadcast on the bus (`swarm-stamp`), so other processes free their
  entries early.
- **Read.** A read takes the stamps first, then serves what it holds at those stamps, or loads and holds the result
  under the stamps it read. A commit during the load moves the stamp, so the next read loads again.
- **What is held.** The stored state, the same for every reader:
  - the active parts, without machines (`main`);
  - the machine parts (`main` + `machine`);
  - quiet groups named by id or all of them (`main`);
  - the light selections the change and host reads use (`main`);
  - the change feed from 15 s before the cursor of the read that missed (`main` + `machine`);
  - `lastChangedAt`, computed by `parts/load.ts lastChangedAt` once per main stamp (`main`). It is not written to a
    stored field: a field every commit writes is the hotspot the parts design rejected (its section 3.7), and a write
    after the commit could be lost.
  - the host form's signature and state (`main`).
- **Permissions after the cache.** Every reader's view is built from the held state by `read/views.ts readerView`, the
  only path to a client, as before. Held values are frozen, so no reader can change what the next one reads.
- **Reassemble once.** A read reassembles its parts once, sharing the stored records (`reassemble(parts, { share: true })`),
  and `readerView` takes that state instead of reassembling again. Commands still copy what they load.
- **No transactions for reads.** Reads run outside interactive transactions. Only a miss's load of the base parts (or
  of a light selection, or the host state) runs in one read transaction, so it is one snapshot. Nothing is retried.

## Design

- **Growth:** the LRU's byte budget (`SWARM_CACHE_MB`, default 64 MB per process, counted as JSON size) drops the least
  recently used entries. Entries also expire after 60 s, and a bump drops the Swarm's entries on every process.
  Redis keys expire 30 days after a Swarm's last change.
- **Concurrency:** there are no locks. A read keeps its result under the stamps it read before loading. Concurrent
  misses of one entry share one load. Commands never read from the cache; they load in their own transaction as before.
- **Read cost:** a hit costs one Redis `HMGET` (a pipeline for a host's Swarms). A miss reloads only the entries whose
  stamps moved: a machine report reloads only the machine parts.
- **Scale:** at 10x Swarms or processes, Redis does one HMGET per read and one script call plus one publish per
  commit. The first warning would be the LRU's evictions (hit rate falling) and Redis CPU. Watch the miss logs and the
  roadmap 1.1 Mongo query rate.
- **Compatibility:** responses are unchanged, and old CLI, Desktop and phone clients read the same shapes. During a
  rolling deploy, old processes don't bump. An entry on a new process is then stale for at most 60 s after an old
  process's write. An old process also misses machine readings dated by `readAt` until the machine's next settings
  change. Recommended rollout: deploy with `SWARM_READ_CACHE=off`, then turn it on once every pod runs the release.
  Once every process is new, a commit is visible to the next read everywhere.
- **Migration + rollback:** nothing is stored outside Redis keys, which are disposable. Roll back by deploying the
  previous release, or with `SWARM_READ_CACHE=off`. Writes still bump with the switch off, so processes that keep the
  cache on stay right.
- **Audience:** the server applies every permission after the cache, from the same `readerView` and `visibleState` as
  before. The integration test reads a private conversation as two readers, in both orders, on one cache.
- **Identity:** stamps are per Swarm; nothing in the cache is keyed by, or sent as, the machine owner's login.
- **Failure:** Redis down or slower than 200 ms means reads go straight to MongoDB and nothing is held. A failed
  bump is logged. The process forgets the Swarm and retries the bump every second until Redis takes it. Other
  processes keep the old entry until then, at most 60 s. A process killed between commit and bump leaves other
  processes stale for at most 60 s.
- **Platforms:** backend only (Node, Linux pods). There is no client change.

## Measured

See the PR for the benchmark before and after (`npm run bench:swarm-state -- --cache redis://…`), against the
roadmap's KPIs.
