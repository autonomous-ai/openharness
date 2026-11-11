# CPU by thread: name where the backend's CPU goes (Watch Production gap 2) Implementation Plan

> Way of working: written by the Engineer from the task's brief (task #2801), implemented by the same Engineer task by
> task, each failing test committed before its code. One independent review on the pull request.

**Goal:** Every minute, each backend process logs where its CPU went, by thread: the main thread (with its GC pauses and
reply JSON), the Prisma query engine, the libuv pool (zlib, fs, crypto) and V8's helper threads (concurrent GC, JIT),
so ≥ 80% of process CPU has a name. Ken's Watch Production numbers (#2773, 11-04 15:35): 43.9 s of process CPU per
pod-minute, 15.3 s named by kind, ~40% off the main thread with nothing splitting it.

**Architecture:** One always-on module, `backend/src/lib/cpuStats.ts`, started in `server.ts` beside the other
per-minute logs. Once a minute it reads `/proc/self/task/*/stat` (one small file per thread, ~30 threads) and groups
each thread's CPU by the thread's name. Linux names them for us (measured on Node 22.23, Prisma 5.22, arm64 Ubuntu):
the main thread's tid is the pid; `tokio-runtime-w` and `opentelemetry-e` are the Prisma engine's (library engine,
in-process); `libuv-worker` is the libuv pool; `node` (not the main tid) and `DelayedTaskSche` are V8's platform workers.
On the main thread it adds two counters: GC pause time from a `gc` PerformanceObserver, and reply JSON time from a
timed `JSON.stringify` reply serializer. Nothing is done per request beyond two `performance.now()` calls and three
additions. Off Linux (a developer's Mac) the per-thread part says `unavailable` and the rest still logs.

**Tech Stack:** Node 22 (`node:fs`, `node:perf_hooks`), Fastify 5 `setReplySerializer`, Vitest.

**Spec:** task #2801's brief (no separate design doc).

## Global Constraints

- Always on; no env switch (Ken: optimizations ship on). Logs carry thread names and numbers only, no user data.
- No per-request work beyond counters. The `/proc` read runs once a minute, synchronously (~30 tiny reads, well under a
  millisecond).
- Never silent: a route that declares a response schema would lose that schema's serializer to the timed one, so
  registration refuses it at startup (no route has one today).
- Backend only; Swarm code stays out of `cli/src/core`. Red-first tests.

## Design

- growth: N/A because nothing is stored: one log line a minute per pod, kept by the log store's own retention.
- concurrency: N/A because per-process counters on one thread, no shared state.
- read cost: one `/proc` read per thread per minute; per request, two clock reads.
- scale: 10x pods → 10x lines a minute, as the other per-minute logs; 10x threads (a bigger node) → 10x tiny reads a
  minute. The first warning is `exitedMs` growing (threads that came and went between reads, uncounted by name).
- compatibility: a new log message (`cpu by thread`); no existing log changes.
- migration + rollback: none; revert the commit.
- audience: logs only, read by the team through the log store.
- identity: N/A because no user identity is involved.
- failure: a `/proc` read that fails logs `threads: unavailable` with the reason, every minute, instead of dropping it.
- platforms: Linux pods get the full split; macOS/Windows dev runs get process, main-thread busy, GC and reply JSON.

## Review Focus

- Thread-name buckets match what the pods run (Node 22 bookworm image, Prisma 5.22 library engine).
- The reply serializer gives the same bytes as Fastify's default for every route without a response schema.
- The overhead figure: per-request cost of the serializer wrapper and per-minute cost of the read.

## Task 1: Read and bucket thread CPU

**Files:** `backend/src/lib/cpuStats.ts`, `backend/src/lib/cpuStats.test.ts`

**Interfaces:**
- `parseThreadStat(text: string): { name: string; cpuMs: number }` — comm between the first `(` and the last `)`,
  utime + stime (fields 14 and 15) at USER_HZ 100.
- `threadBucket(name: string, tid: number, pid: number): 'main' | 'prismaEngine' | 'libuvPool' | 'v8Workers' | 'other'`
- `readThreads(root?: string): Array<{ tid: number; name: string; cpuMs: number }>` (throws when unreadable)

- [ ] Failing test: a stat line whose comm holds spaces and `)` parses; buckets for each measured name and an unknown one.
- [ ] Failing test (Linux only, skipped elsewhere): the real `/proc/self/task` has this process's main thread, with CPU.
- [ ] Code that passes them.

## Task 2: The per-minute window and its log

**Files:** `backend/src/lib/cpuStats.ts`, `backend/src/lib/cpuStats.test.ts`

**Interfaces:**
- `startCpuStats(options?: { everyMs?; log?; threads?; cpuUsage?; now?; observeGc? }): CpuStats` with
  `{ replyJson(ms: number, bytes: number): void; flush(): void; stop(): void }`.
- Log `cpu by thread`: `windowMs, processCpuMs, mainMs, prismaEngineMs, libuvPoolMs, v8WorkersMs, otherThreadsMs,
  exitedMs, namedPct, gc { pauseMs, count, majorMs }, replyJson { ms, count, kb }, loopBusyPct, otherNames`.

- [ ] Failing test: two fake reads a window apart give each bucket's delta; a thread new in the window counts in full;
  a thread gone counts in `exitedMs` (process CPU minus the threads read); `namedPct` is the four named buckets over
  process CPU.
- [ ] Failing test: GC entries sum into `gc`; reply JSON sums into `replyJson`; counters reset each window.
- [ ] Failing test: an unreadable `/proc` logs `threads: 'unavailable'` with its reason, every window.
- [ ] Code that passes them.

## Task 3: Time reply JSON and start it in the server

**Files:** `backend/src/lib/cpuStats.ts`, `backend/src/lib/cpuStats.test.ts`, `backend/src/server.ts`

**Interfaces:** `registerReplyJsonTiming(app: FastifyInstance, stats: Pick<CpuStats, 'replyJson'>): void`

- [ ] Failing test: a Fastify route returning an object replies the same bytes as `JSON.stringify`, and the stats get
  one reply with its size; a route declaring a response schema makes registration fail at startup.
- [ ] Code that passes it; `server.ts` starts the stats beside the other per-minute logs and stops them on close.

## Task 4: Measure on a seeded load, rank the top three

**Files:** `backend/integration/bench/routeCost.ts`

- [ ] Run the route-cost bench on Linux (a local Lima VM, Node 22) with `cpu by thread` every 15 s; record coverage
  (`namedPct`) and each bucket.
- [ ] Overhead: per-call cost of the timed serializer and per-read cost of `/proc`, against process CPU per minute.
- [ ] PR body: the top three buckets and the change that would cut each.
