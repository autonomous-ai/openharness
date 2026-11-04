# GET changes reads only what moved, once per pod — Implementation Plan

> Written by the writing-plans skill. The Engineer implements it task by task, test first (test-driven-development):
> each task's failing test is committed before its code. One review on the pull request.

**Goal:** `GET /api/super-tabs/:tabId/changes` costs a fraction of today's database time and bytes per poll (task #2783,
Watch Production #2773: 32% of DB time, 30% of DB bytes after v1.4.1; all part reads bursting to ~570 ms together).

**Architecture:** the poll already reads parts through the per-pod read cache (`cache.ts`, `cachedReads.ts`): a bump marks
entries stale and one shared delta per Swarm and stamp patches them. Measured on the bench (below), three things in that
path make every poll's refresh read far more than moved, and one makes slower pollers read alone:

1. The change feed (`feed`, `cachedReads.ts readChanged`) holds all seven kinds under the `all` scope, so every machine
   reading (every 15 s per machine) makes the pod's next delta read all seven part collections. A reading moved one
   machine part.
2. The shared delta (`cache.ts deltaFor`) reaches back to the oldest stale entry of the Swarm refreshed in the last two
   minutes (`DELTA_MAX_GAP_MS`), whether or not anyone is reading it. One first load's dormant entries drag every later
   delta back: on the bench, ~190 whole conversations (1.2 MB) per machine reading.
3. Each delta reads every part changed in its window (30 s overlap and more) with its whole data, though the pod received
   most of them, at the same versions, in the delta before.
4. A cursor older than the feed's start reads the change collections itself, one poller at a time.

The fixes, one per task: the feed splits by stamp scope; a delta joins only entries refreshed recently; a delta reads keys
and versions first and whole rows only for versions the pod has not held; the feed starts far enough back for slow pollers.
Answers stay identical: every change is checked against today's loaders.

**Tech Stack:** TypeScript, Fastify, Prisma on MongoDB (`aggregateRaw`), vitest; the bench on mongodb-memory-server.

**Spec:** task #2783's brief; [2026-11-02 poll cost](../superpowers/specs/2026-11-02-poll-cost-design.md) Part 1 (the feed
rule) and [2026-11-02 cache delta](../superpowers/specs/2026-11-02-swarm-cache-delta-design.md), whose rules stay.

## Global Constraints

- Answers identical: every changed read equals what today's loader returns (`integration/superTabCacheDelta.test.ts`
  equivalence after seeded writes; unit tests per rule).
- No env switches: everything ships on. No production access: Ken's numbers and the bench.
- Red-first: each task commits its failing test before its code.
- Backend only; nothing in `cli/src/core`. Temp files only in `mktemp -d` folders.

## Review Focus

- `deltaFor`'s join window: an entry left out of a shared delta must still be refreshed correctly on its own read.
- The version-gated delta: a part is reused from memory only at the same kind, key and version; every part whose version
  the pod has not held is read whole. The memo is bounded and per Swarm.
- The split feed: a reply's parts are the same set, in kind order, as the single feed's.
- The integration plan test for the by-id read (backend AGENTS.md rule 3).

## Design (AGENTS.md checklist)

- **Growth:** the delta memo holds each Swarm's parts seen in its last deltas, pruned to the reach of the next delta
  (everything older than the earliest live entry's refresh, less the overlap) and to `DELTA_MAX_PARTS` per Swarm; dropped
  with the Swarm's entries. The feed's earlier start adds at most two minutes of changes to a held feed.
- **Concurrency:** no locks, as the cache today: one delta per Swarm and stamp, joined by every entry it covers.
- **Read cost:** a machine reading reads machine parts only; a delta reads keys and versions, then whole rows only of what
  moved since the pod's last delta.
- **Scale:** at 10x pollers per pod the part reads stay per bump, not per poll. First warning: the `swarm cache` minute
  log's patch bytes and full loads per entry, and `route latency` for changes.
- **Compatibility:** no API or stored shape changes; old and new pods share Redis stamps as today.
- **Migration + rollback:** none stored; roll back with the previous release.
- **Audience:** permissions still apply after the cache (`read/views.ts readerView`, `read/changes.ts changesFor`).
- **Identity:** nothing keyed by or sent as the machine owner's login.
- **Failure:** a delta or by-id read that fails loads the entry in full, as a failed delta does today.
- **Platforms:** backend on Linux pods.

## Measuring

`backend/integration/bench/changesPollCost.ts`: the bench's seeded Swarm (200 groups, 6 machines, 20 workers) on one
backend process, 18 person windows and 20 agents polling; rounds where all poll at once after nothing, one machine
reading, every machine reading and one post. Per poll: operations, part reads, MongoDB bytes out, profiler ms, wall ms,
reply bytes; per round: operations and bytes by collection. Run before (main) and after, and with `--light`.

## Task 1: machine readings refresh only the machine part of the feed

**Files:** `backend/src/superTabs/cachedReads.ts` (`readChanged`), `backend/src/superTabs/cachePatch.ts` (`feedRule` →
by kinds), `backend/src/superTabs/parts/load.ts` (`loadChanged` takes kinds already), tests in
`cachedReads.test.ts`, `cachePatch.test.ts`.

**Interfaces:** `feedRuleOf(kinds)`; entries `feed` (scope `main`, the six non-machine kinds) and `feed:machines` (scope
`all`, kind `machine`). `readChanged` returns the same parts as before, the six kinds then machines.

- [ ] Failing test: after a machine-only bump, a feed read asks the delta for `machine` only, and its answer equals
      `loadChanged` (red today: the delta asks for all seven kinds).
- [ ] Split the feed; keep the direct path when the cursor is older than either part's start.
- [ ] Run `cachedReads.test.ts`, `cachePatch.test.ts`, `cache.test.ts`, `read/*.test.ts`.

## Task 2: a shared delta joins only entries refreshed recently

**Files:** `backend/src/superTabs/cache.ts` (`deltaFor`, new `DELTA_JOIN_MS`), `cache.test.ts`.

**Interfaces:** an entry joins another's delta only when it was refreshed at most `DELTA_JOIN_MS` (15 s, Desktop's
background cadence) before the entry being refreshed. A cold entry, read later, gets its own delta from its own time.

- [ ] Failing test: an entry refreshed 60 s ago and not read since does not move a hot entry's delta back (red today: the
      delta starts at the cold entry's time less the overlap); read later, it is still patched right.
- [ ] Implement; existing "entries refreshed together still share one delta" stays green.
- [ ] Run `cache.test.ts`, `cachedReads.test.ts`.

## Task 3: a delta reads whole rows only for versions the pod has not held

**Files:** `backend/src/superTabs/parts/load.ts` (`loadDelta` in two steps: keys and versions, then whole rows by `_id`),
`backend/src/superTabs/cachedReads.ts` (`readDelta` with a per-Swarm memo), tests in `cachedReads.test.ts`, the plan in
`backend/integration/` (rule 3).

**Interfaces:** `loadDelta(tx, tabId, since, kinds, held?)`: `held(kind, key, version)` returns a part the pod holds at
that version, or none; the answer is the same `SwarmDelta`. The memo keeps each Swarm's delta parts, pruned by time.

- [ ] Failing test: a second delta over the same window reads no whole row it already read (red today: it reads every
      row again), and its answer equals a fresh `loadDelta`.
- [ ] Implement; by-id read is a plain `$match` on `_id` with `tabId`.
- [ ] Integration test of the by-id read's plan (IXSCAN on `_id`).
- [ ] Run `cachedReads.test.ts`, `cache.test.ts`, `parts/*.test.ts`.

## Task 4: slower pollers share the pod's feed

**Files:** `backend/src/superTabs/cachedReads.ts` (`readChanged`, `FEED_REACH_MS`), `cachedReads.test.ts`.

**Interfaces:** a feed loaded on a miss starts at the earlier of its reader's cursor less 15 s and two minutes before the
read, so a phone (5 s), a background window (15 s) or a CLI reading a minute later reads the held feed.

- [ ] Failing test: a cursor 60 s older than the poller that loaded the feed reads no collection (red today: it reads all
      seven itself).
- [ ] Implement.
- [ ] Run `cachedReads.test.ts`.

## Task 5: measure and hand over

- [ ] Bench before (main) and after, plain and `--light`; numbers and red/green evidence in a PR comment.
- [ ] `npm test` (backend unit suite) and typecheck; PR ready; review step.
