# Prisma engine CPU by query — plan (task #3041)

**Goal:** Name which queries burn the Prisma engine's CPU (45% of process CPU on v1.4.7, Ken's 11-05 `cpu by thread`
split), then move the top reads off the engine's heaviest path, so CPU per request reaches ≤ 38 ms and 3 pods hold peak.

**Architecture:** Step 1 measures. A sampler in the one query hook (`lib/queryStats.ts withQueryStats`) times the engine
threads' own CPU around queries that run alone, and a per-minute `prisma by query` line ranks operations by engine ms.
Step 2 moves the top reads, one group per pull request, chosen from that line. Step 3 reports before and after.

**Tech Stack:** Node 22, Prisma 5.22 (library engine, in-process tokio threads), MongoDB, Vitest.

**Spec:** the task's brief (#3041); Watch Production (#2773) thread of 11-05.

This plan is written and carried out by its Engineer, test first; there is no execution handoff.

## Why not Prisma's query events

The brief named Prisma's `query` events. They do not measure what we need, and turning them on costs what we measure:

- For MongoDB, an event's `duration` is the database call as the engine sees it (send, wait, reply). It does not include
  the engine's own work: building the query, converting BSON to its values and those to the JSON string the client
  parses. That is the CPU `cpu by thread` counts.
- The `query` log level makes the engine format every query as a string. It cannot be sampled: it is on for every query
  or for none.

What we measure instead: Linux keeps each thread's time on CPU in nanoseconds (`/proc/self/task/<tid>/schedstat`, first
field). When a query runs alone in the process, the engine threads' CPU between its start and its end is that query's
engine CPU. The sampler takes such a query at most every 100 ms, reads the engine threads before and after (two
directory reads and a few small file reads, tens of microseconds), and scales each operation's mean by how often it ran
in the minute. Where `schedstat` is missing it falls back to `stat`'s 10 ms ticks, unbiased over many samples; off Linux
the line says `unavailable`.

## Raw commands are still the engine

`$runCommandRaw` and `aggregateRaw` (resolveIds, the unfollow update, `parts/indexed.ts readBy`) run inside the same
engine: it still converts the command to BSON and every reply document to Extended JSON and then to a string. They skip
Prisma's query building and per-field result shaping, so they may cost less per document, but not nothing. The new line
measures raw commands too, so step 2 compares engine µs per document of a model read against a raw read on the same
collection before moving anything. If raw reads are about as costly, the fix is the plain `mongodb` driver for the top
reads; that is a second connection pool per pod against Atlas M20's connection limit and more memory, and it goes to the
PM with those costs before any code (River, 11-05).

## Design

- Growth: a log line per pod-minute, the top 25 keys; nothing stored. Logs rotate.
- Concurrency: none; one process, counters on the main thread.
- Read cost: at most 10 samples a second, each two `/proc` listings and the engine threads' `schedstat`; the line reports
  the sampler's own time (`costMs`) so its cost is measured, not assumed.
- Scale: at 10x queries the sample rate stays capped; keys stay capped (`maxKeys`, overflow into `other`).
- Compatibility: a new log line; no client, API or schema change.
- Migration + rollback: none; revert the commit.
- Audience: server logs only; ops and routes are patterns, never values or ids.
- Identity: N/A because nothing is read or written for a person.
- Failure: a sampler error never reaches a query; it is warned about once per process, and `/proc` missing says
  `unavailable` on every line.
- Platforms: Linux pods; macOS dev logs `unavailable`.

## Global Constraints

No behaviour change; no new settings or switches. Swarm code stays out of `cli/src/core`. Each moved query keeps its
results and its index, with an explain test (backend AGENTS.md rule 3). One pull request per group of queries.

## Review Focus

- The sampler's solo rule: a sample counts only if no other query was in flight at its start and none started before it
  ended; the in-flight count returns to zero after a failed query.
- Its cost bound (gap between samples) and that a failure inside it never changes a query's result.

## Tasks

### 1. Engine CPU reader and sampler (`backend/src/lib/engineCpu.ts`)

Files: `src/lib/engineCpu.ts`, `src/lib/engineCpu.test.ts`.
Interfaces: `readEngineCpuNs(root, pid)`, `createEngineCpu(options)` → `{ start(), end(sample, model, action, args,
result), flush() }`, `startEngineCpu(options)`, `activeEngineCpu()`.

- [ ] Failing tests: reads engine threads only, from `schedstat`, falling back to `stat`; a solo query is sampled and
      scaled by its count; an overlapped one is discarded; samples respect the gap; the line ranks by engine ms with op
      and route, reports totals and cost, and resets.
- [ ] Code that passes them.

### 2. The query hook feeds it (`backend/src/lib/queryStats.ts`)

Files: `src/lib/queryStats.ts`, `src/lib/queryStats.test.ts`, `src/server.ts`, `src/worker.ts`.

- [ ] Failing tests: every query, a failed one too, starts and ends one sample slot (in flight back to zero); a sampler
      that throws leaves the query's result alone.
- [ ] Code: `withQueryStats` calls the sampler; server and worker start it beside `startQueryStats`.

### 3. Read production, pick the first group (after the release)

- [ ] Read `prisma by query` beside `cpu by thread` at peak; post the top operations by engine ms, their engine µs per
      document, and raw against model reads.
- [ ] Open the next pull request for the top group behind GET changes and hosts readings/changes, with an explain test
      for each moved query, or bring the plain driver's costs to the PM.

### 4. Before and after

- [ ] After each move ships: Prisma engine ms/min and CPU per request from `cpu by thread` and `prisma by query`.
