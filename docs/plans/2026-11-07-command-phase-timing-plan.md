# P0 #4560 step 1: a slow Swarm command logs its time by phase — Plan

> Written by the Engineer and implemented by it, task by task, test first. No Execution Handoff.

**Goal:** Name where the ~3.5 s wait inside some Swarm commands goes (Ken's 17:20 VN scan on v1.4.32: POST commands p95 3,574 ms,
p50 245 ms, ~23 ms DB and ~140 ms main-thread CPU per command, the event loop not blocked), so the next prod scan names the phase.

**Architecture:** `commandTiming.ts` keeps a command's phases in an AsyncLocalStorage on the store's clock. The store's `execute`
times each command; the GitHub reads before the transaction and the head read after it, `swarmTransaction` (connection wait
before the body, the body, the commit, the cache stamps), `retryTransient` (attempts, backoff) and the after-commit work each add
their phase. A command over 1 s logs one `Swarm command slow` line: Swarm id, command type, total, phases, whether an agent sent it.

**Tech Stack:** TypeScript backend, node:async_hooks, vitest.

**Spec:** Task #4560 brief, step 1.

## Global Constraints
- Names and milliseconds only: no command words, message text or secrets in the line.
- Hot path: the timing's own cost is measured per command.
- Ships as a backend hotfix as soon as it is green; steps 2 and 3 follow from the numbers.

## Review Focus
- Every phase the brief lists is named; the line carries nothing but names and numbers.

## Tasks

### 1. Phase timing
Files: `backend/src/superTabs/commandTiming.ts`, `commandTiming.test.ts`, `transaction.test.ts`
- [ ] Failing test: phases add on the command's clock, a read's inner transaction counts only as that read, a failed command still reports; a transaction's pool, body, commit, attempts, backoff, stamps and after-commit are timed.
- [ ] Code: `commandTiming.ts`; phases in `cache.ts swarmTransaction`, `retry.ts`, `store.ts transaction`.

### 2. The slow-command line
Files: `backend/src/superTabs/store.ts`, `backend/integration/superTabCommandReads.test.ts`
- [ ] Failing test: a command over 1 s logs its type, total and phases without its words; a fast one logs nothing.
- [ ] Code: `execute` times the command; each read before and after the transaction is its own phase; `slowCommand` logs.
