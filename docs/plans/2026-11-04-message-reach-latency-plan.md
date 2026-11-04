# Message reach latency log — plan

> Worked by the project's Engineer way of working: this plan first, then each task test first (failing test committed,
> then the code that passes it), one pull request, one independent review. No Execution Handoff.

**Goal:** Task #2840 (Watch Production #2773). Ken's guard "how fast a message reaches its reader" has no measurement in
any production log, so the load work cannot show it got no worse. Log it per pod per minute, in the style of the logs Ken
already reads (`cpu by kind`, `route latency`, `messages by reader`).

**Architecture:** A new in-memory module, `superTabs/messageReachStats.ts`, like `messageReadStats.ts`: callers record one
duration per message reaching one reader, keyed by the reader's kind and the way it reached them. Every minute it logs
`message reach latency` with the pod, the window and, per key, the count, p50, p95 and max in ms (a bounded reservoir
sample per key, as `route latency` keeps). A message that reaches its reader late (a read over a minute old: an app brought
back or opened; a delivery over 10 minutes old, which includes the time its agent was busy) is counted as `late`, outside the
percentiles (review of #2995). A person's reads count per reading app: Desktop and the phone both open count a message
twice. Two places record:

1. **An agent:** its host's acknowledgement that a delivery was typed (`store.ts delivery`, `ack` not uncertain, the first
   time the row gets `deliveredAt`): now − the delivery's creation, which is written with its message. Recorded after the
   transaction commits, so a retried transaction records once. Reader `agent` or `buddy`, way `delivery`.
2. **A person:** a read of new messages (`store.ts messages` with an `after` cursor, which every app uses after a push or
   poll says the conversation moved): now − each returned message's creation, for messages the reader did not write.
   Reader `person`, way `read`. A latest page, a thread or a scroll back is a re-read, not the message reaching them.

**Tech Stack:** backend TypeScript (Fastify, Prisma on MongoDB), vitest.

**Spec:** task #2840's brief.

## Global Constraints

- No message text, ids or emails in the log: reader kinds, ways and numbers only.
- In memory per pod, nothing stored; no new database read or write.
- The guard rows (`GET changes` p95, `POST commands` p95) must not get worse: the hooks add only arithmetic on rows
  already in memory. Measured per call before and after on a seeded Swarm.
- Red-first tests; backend `npm test`; the Super Tab suite runs in PR CI.

## Design

- **Growth:** nothing stored; the window is cleared each minute. Memory: at most a few keys × 2,000 samples.
- **Concurrency:** single-threaded per pod; recorded after commit, so a retried transaction records once.
- **Read cost:** none added: the rows are those the call already read.
- **Scale:** at 10x messages, the per-minute samples stay capped (reservoir); count and max stay exact.
- **Compatibility:** server-only log; no client change.
- **Migration + rollback:** none; rolling back removes the log line.
- **Audience:** operators reading the pod logs; the line carries no personal data.
- **Identity:** N/A because no identity is logged or used beyond the reader's kind.
- **Failure:** recording cannot throw into the request: plain arithmetic on numbers; a stopped module records nothing.
- **Platforms:** backend only.

## Review Focus

1. Each message reaches each reading app or agent once in the count: no double count from retried transactions, re-reads or
   the reader's own messages.
2. No id, text or email can reach the line.
3. No added reads or awaits on the hot paths.

## Task 1: the stats module

**Files:** `backend/src/superTabs/messageReachStats.ts` (new), `backend/src/superTabs/messageReachStats.test.ts`,
`backend/src/server.ts` (start and stop beside `messages by reader`).
**Interfaces:** `recordMessageReach({ reader, via }, ms)`, `startMessageReachStats({ everyMs, pod, maxSamples, random, log })`,
`LATE_MS`.

- [x] Failing tests: the minute line's shape and percentiles, late rows, silent empty minutes, bounded samples, stop.
- [x] Code.

## Task 2: an agent's delivery receipt records

**Files:** `backend/src/superTabs/store.ts` (`delivery`), test `backend/integration/superTabs.test.ts`.

- [x] Failing test: an ack records once with the delivery's age; a second ack, an uncertain ack and a claim record nothing.
- [x] Code: `afterCommit` on the first `deliveredAt`.

## Task 3: a person's read of new messages records

**Files:** `backend/src/superTabs/store.ts` (`messages`), test `backend/integration/superTabs.test.ts`.

- [x] Failing test: an `after` read records each returned message others wrote; the person's own message, a latest page and
      an agent's read record nothing.
- [x] Code.

## Task 4: measure

- [x] Per call before/after on a seeded Swarm: an `after` read and a delivery ack, timed over many calls on main and on the
      branch. A sample log line in the PR.
