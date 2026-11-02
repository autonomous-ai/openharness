# Thread mark scan implementation plan

> Implement task by task in this Engineer session, test first, then independent Swarm review and testing.

**Goal:** Reading a busy chat preserves unread thread-only answers beyond 500 notices or replies.

**Architecture:** Filter thread replies before limiting the ascending seed scan. Return a safe chat sequence alongside the seeded count, and advance the chat and Activity only through that boundary. Preserve existing privacy and thread membership checks.

**Tech Stack:** TypeScript, Prisma MongoDB aggregation, Vitest and MongoMemoryReplSet.

**Spec:** Swarm task 4e9b31f04972fd891e0cfced (busy-chat thread read marks).

## Global Constraints

- No env switch; other chats and existing behavior below the cap stay unchanged.
- Full Super Tab integration suite before Ready, plus backend typecheck and unit suite.
- PR starts: Requested by diego@autonomous.ai through Harness.
- No production writes or release; PM owns merging.

## Review Focus

- Hidden notices and main messages must not exhaust reply slots.
- A full reply batch must not let a chat mark pass an unexamined reply.
- Early returns (own replies, hidden replies, existing marks) must retain the safe boundary.
- Repeated reads must progress and preserve previously seeded thread marks.
- Thread-count overflow must not discard unseeded threads when the chat advances.

## Design

Growth: no new collection; existing mark lifecycle. Concurrency: existing monotonic conditional mark writes, per person/chat or thread. Read cost: one bounded reply result batch; filtering may examine main rows in its indexed range. Scale: 10x traffic keeps result and write caps; examined documents and latency warn first. Compatibility: existing API shape; capped reads report the stored partial sequence. Migration/rollback: none; old servers retain the known overflow risk. Audience: existing server checks. Identity: authenticated person. Failure: seed failure prevents chat advancement. Platforms: backend, all clients.

### Task 1: Preserve replies across scan overflow

**Files:** Modify `backend/src/superTabs/read/threadMarkSeeds.ts`, `backend/src/superTabs/read/service.ts`; test `backend/integration/superTabInbox.test.ts`.

**Interfaces:** Consume `seedThreadMarks(db, SeedInput)`; produce `{ marked: number; sequence: number }`, with sequence no greater than the fully processed reply boundary.

- [ ] Add regressions for SEED_SCAN hidden notices before an answer; more than SEED_SCAN replies with a late thread; repeated reads; update the existing bounded-range fixture to use replies.
- [ ] Commit tests; run targeted inbox integration tests and observe the expected unread/sequence failures.
- [ ] Filter replies before limit; return the safe sequence on every path; use it for writeReadMark. Preserve threads omitted by SEED_THREADS by bounding advancement before the omitted range.
- [ ] Run inbox integration tests and commit the passing implementation.
- [ ] Push task commits; run backend typecheck, unit tests and full Super Tab integration suite with time bounds. Record exact red/green evidence in a PR comment.
- [ ] Mark Ready, create independent review/test steps and route requests directly; resolve findings, then record passed checks and done for PM.
