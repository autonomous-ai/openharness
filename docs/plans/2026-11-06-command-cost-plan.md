# POST commands cost what they did on 11-05: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** Bring POST commands p95 back under 475 ms and person reach p95 under 3 s (task #3661, requested by Ken through
Harness). Ken's 10:45 VN scan on v1.4.20: commands p95 683 ms (11-05: 374), person reach p95 4.2 s (11-05: 3.0), Atlas
primary 46.8%; top slow shapes SwarmGroup aggregateRaw on POST commands.

**Architecture:** Measured locally (no production read-only login on this machine; the PM went ahead without it) with a
profiler on a Swarm of production's busiest size (150 awake, 1,500 dormant groups, 20 workers), main against v1.4.16 (the
11-05 build), every MongoDB operation per command:

| Command | SwarmGroup reads per command, main | v1.4.16 |
|---|---|---|
| message.send, work.status working, work.check, agent.alert, message.react | ~4 | ~4 (same documents) |
| conversation.create (opens a task) | 6, plus a full dispatch load after it | 5 |
| work.assign (production hooks) | 10 (3 Swarm loads) | fewer: 2 of its pre-reads are new |
| work.status review (Ready, production hooks) | 12 (4 Swarm loads) + a dispatch load | fewer |

The common commands do the same work as on 11-05. What grew is the tail: each pre-read added since (repository reach
#3266, review files #3401, push origin) opens its own transaction and loads the Swarm before it knows whether it has anything
to read, and every freeing write starts a dispatch pass that loads the whole Swarm on the primary even when nobody is free
for a task. Three changes:

1. The pre-reads of one command share one Swarm load (`store.ts preReads`), taken only when one of them needs it.
2. A freeing write schedules the crew dispatch only when its committed state has a pick (`dispatch.ts dispatchPlan`), as
   the 30-second sweep already decides.
3. `commands by type` (superTabs/commandStats.ts): every minute, per command type, the count, p50, p95, max, how many
   retried their transaction and how many were refused, so the next scan splits POST commands by type.

**Tech Stack:** TypeScript backend, Prisma on MongoDB, vitest with mongodb-memory-server.

**Spec:** task #3661 brief; the PM's go on the recommendation (per-type latency and retries, the dispatch gate).

## Global Constraints

- No query shape changes and no index changes: the same reads, fewer of them. The command's own load stays in its
  transaction; the pre-reads stay outside it, as before.
- A pre-read that cannot load (refused, gone) reads as before: nothing.
- A dispatch the gate skips is one the pass would have found nothing for; the 30-second sweep still runs.
- Swarm code stays out of cli/src/core. Temp files only in `mktemp -d` folders.

## Design

- growth: the stats keep a bounded sample per type for one minute, then clear (as `message reach latency`); nothing stored.
- concurrency: unchanged; the shared pre-read load is one read-only transaction, as each was.
- read cost: work.assign 3 Swarm loads to 2, Ready 4 to 2; no dispatch load when nobody is free.
- scale: 10x commands: the stats are O(1) per command; the log line lists at most 40 types.
- compatibility: no API or stored-data change.
- migration + rollback: none; reverting the code restores the old reads.
- audience: N/A because nothing new is exposed; the log carries types and numbers only, never ids or words.
- identity: N/A because no new reads as anyone.
- failure: a failed pre-read returns nothing as before; a stats failure cannot fail a command.
- platforms: backend only.

## Review Focus

- Each pre-read decides exactly as before from the shared state.
- The gate never skips a pass the pass would assign in.

## Task 1: Pre-reads share one Swarm load

**Files:** backend/src/superTabs/store.ts, backend/integration/superTabCommandLoads.test.ts

- [ ] Test: with the production hooks, work.assign and a Ready load the Swarm at most twice (head reads), today 3 and 4.
- [ ] Watch it fail; commit.
- [ ] Code: a per-command lazy load the pre-reads share; watch it pass; commit.

## Task 2: Dispatch only when there is a pick

**Files:** backend/src/superTabs/store.ts, backend/integration/crewDispatch.test.ts

- [ ] Test: a freeing write with nobody free, or nothing to hand out, schedules no pass; one with a pick does.
- [ ] Watch it fail; commit.
- [ ] Code: the gate; watch it pass; commit.

## Task 3: Commands by type

**Files:** backend/src/superTabs/commandStats.ts (+ test), backend/src/superTabs/store.ts, backend/src/server.ts

- [ ] Test: the line lists each type's count, p50, p95, max, retried and refused; empty windows log nothing.
- [ ] Test: a command through the store is recorded with its type and one attempt.
- [ ] Watch them fail; commit.
- [ ] Code; watch them pass; commit.
