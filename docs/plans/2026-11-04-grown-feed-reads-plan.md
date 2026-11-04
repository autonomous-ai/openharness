# Starts and conversations reads stay one round trip as a Swarm grows — Implementation Plan

> Written by the writing-plans skill. The Engineer implements it task by task, test first (test-driven-development):
> each task's failing test is committed before its code. One review on the pull request.

**Goal:** Atlas ops per request stop growing with a Swarm's history (task #2839, Watch Production #2773: 928 → 1,226 ops/s
over four hours at flat traffic; SwarmStart getMore on `{tabId, changedAt}` 239 → 351 per 2 h, SwarmGroup getMore on
`{tabId, agentIds}` 28 → 42).

**Architecture:** measured on a grown bench Swarm (3,000 finished starts, 1,500 quiet Lead conversations,
`backend/integration/bench/grownFeedOps.ts`):

1. A host's poll after any change rebuilds the host signature (`read/hostInputs.ts hostInputs`, the `host:inputs` entry,
   no patch rule) by reading the key and change time of **every live start**, member and agent: 3,279 rows, a command and
   a getMore through `{tabId, changedAt}`, once per pod per change. Finished starts stay live for 7 days, so this grows
   with the Swarm's history. That is the SwarmStart getMore of the slow log.
2. Reads that return more than 101 rows take a getMore: Mongo's first batch is 101 documents. An agent's quiet
   conversations (`dormant:agent:{id}`, `light-dormant:agent:{id}`, loaded whole on a cold or aged cache entry) are
   hundreds for a Lead, so each load is a command plus getMores, more as the Lead's history grows. Prisma's `aggregateRaw`
   takes `options.batchSize`; with it the same read is one round trip (probe: 350 rows, one command, no getMore).

The fixes: every named-index read (`parts/indexed.ts readBy`, which all the hot part reads use) asks for one batch; the host
signature holds its member, agent and start stamps in a cache entry patched from each delta, so a change reads only what
changed. The signature stays byte-identical.

**Tech Stack:** TypeScript, Prisma on MongoDB (`aggregateRaw`), vitest; the bench on mongodb-memory-server.

**Spec:** task #2839's brief; [2026-11-02 poll cost](../superpowers/specs/2026-11-02-poll-cost-design.md) Part 1.3 (the host
signature's patched map, superseded then by `host:groups` for conversations only). Coordinates with #2976 (task #2783):
that PR fixes the delta and feed reads of `GET changes`; this one touches neither.

## Global Constraints

- Answers identical: the host signature equals today's for every write (equivalence test after seeded writes).
- No env switches. Red-first per task. Backend only. Temp files only in `mktemp -d` folders.
- Guard rows (GET changes p95, POST commands p95) not worse: one round trip is never slower than several.

## Review Focus

- The stamps rule: a removal drops the key, a revival or change sets it, a touch (version without `changedAt`) leaves it;
  the hash is built from the same values in the same order as today.
- `batchSize` on every named read: what the first reply may hold is bounded by Mongo's 16 MB reply limit either way.

## Design (AGENTS.md checklist)

- **Growth:** the new entry holds one `key → changedAt` per live member, agent and start of a Swarm (as the reads it
  replaces return), in the read cache's byte budget; it goes with the Swarm's entries.
- **Concurrency:** the cache's rules: one delta per Swarm and stamp, no locks.
- **Read cost:** a host poll after a change reads the delta, not every live start; a large read is one round trip.
- **Scale:** at 10x starts the host signature costs the same per change. First warning: `swarm cache` full loads of
  `host`, and SwarmStart/SwarmGroup getMore counts in the slow log.
- **Compatibility:** no API or stored shape change.
- **Migration + rollback:** nothing stored; roll back with the previous release.
- **Audience:** the signature is the host's own, as today.
- **Identity:** nothing keyed by or sent as the machine owner's login.
- **Failure:** an entry that cannot patch loads in full, as every cache entry does.
- **Platforms:** backend on Linux pods.

## Task 1: named reads are one round trip

**Files:** `backend/src/superTabs/parts/indexed.ts` (`readBy`), `backend/src/superTabs/parts/indexed.test.ts` or a new test,
`backend/integration/superTabGroupPlans.test.ts`.

**Interfaces:** `readBy` passes `options.batchSize: READ_BATCH` with or without a hint.

- [ ] Failing test: readBy sends a batch size (red today: options has only the hint).
- [ ] Implement; integration: an agent's quiet conversations past 101 rows come in one command, no getMore.

## Task 2: the host signature's stamps are patched, not read again

**Files:** `backend/src/superTabs/read/hostInputs.ts`, `backend/src/superTabs/cachePatch.ts` (`hostStampsRule`), tests in
`read/hostInputs.test.ts`, `integration/superTabHostGroups.test.ts`.

**Interfaces:** entry `host:stamps` (scope `main`, kinds member, agent, start): `{ member, agent, start }`, each
`key → { changedAt, version }`. `hostInputs` hashes it as today's rows.

- [ ] Failing test: after a held signature, a change reads no live start whose stamp did not move (red today: every live
      start is read).
- [ ] Implement; equivalence test against today's signature after seeded writes.

## Task 3: measure and hand over

- [ ] `grownFeedOps.ts` before (main) and after; numbers and red/green in the PR.
- [ ] `npm test`, typecheck; ready; review step.
