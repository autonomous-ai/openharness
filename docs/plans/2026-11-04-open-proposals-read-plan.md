# Open proposals read by id: implementation plan

Way of working: the Engineer implements this plan itself, task by task, test first (project instructions, Engineer). No
Execution Handoff.

**Goal:** The Tasks view's open-proposals read (`GET /api/super-tabs/:tab/proposals`, polled every minute by Desktop)
stops walking the whole project chat. Its query count, and the rows it examines, stay the same however long the chat
grows, and its answers stay the same (task #2777, Ken's prod scan 11-04, index suggestion 3).

**Architecture:** A small collection, `SuperTabOpenProposal`, holds a project chat's proposal roots that have not been
seen answered. One row per root (id = the root message's id), written in the transaction that inserts the root
(`store.ts writeMessages`). The read lists the rows newest first by `{tabId, conversationId, sequence}` and reads those
roots by `_id`. It reads their threads as today (`pageThreads`) and applies today's rule (`threads.ts askOf`). A root it
finds answered, or whose message is gone, it deletes from the set: an answer is permanent under that rule (a task's mark
never reverts to a proposal; a lead's reply stays in the thread). A chat with no seed mark yet (every chat at release)
runs today's scan once and stores its open roots and a seed mark (`seeded:<tab>:<chat>`, sequence -1). For 30 minutes
after the mark, reads run the scan again, so a proposal an older pod wrote during the rolling release (without a row)
still gets one.

**Tech Stack:** TypeScript, Prisma (MongoDB), vitest, mongodb-memory-server integration tests.

**Spec:** task #2777 brief (keep the open set where proposals are written, read by id, one-time seed on first read per
project, no separate backfill, same answers).

## Design

- growth: a row per proposal root that is open or not yet seen answered, plus one seed mark per project chat. The read
  deletes a root once it finds it answered or gone; the Swarm's purge deletes the rest (`purge.ts PURGED_BY_TAB_ID`).
  Open proposals today are under 10 per project.
- concurrency: no locks. The write inserts in the root's own transaction. Seeds are idempotent upserts (`$setOnInsert`),
  and deletes are by id. A seed racing a prune may re-add an answered root, and the next read prunes it again.
- read cost: after the seed, 1 seed-mark read + 1 set page + 1 roots-by-id read + the thread summaries of those roots
  (+1 delete when something was answered). None depends on the chat's length.
- scale: at 10x proposals per project, the set stays the open ones. The first warning metric is the read's
  docsExamined on the set's index, held to rows returned in the integration test.
- compatibility: the endpoint and its answer are unchanged. Old pods during the rollout write roots without rows; the
  30-minute re-seed window covers them.
- migration + rollback: none to run. The schema push creates the collection and index. A rollback leaves the
  collection unused, and a later re-release re-seeds within 30 minutes of each chat's mark (or not at all for marks
  older than that: write-path rows keep them current).
- audience: unchanged. The store checks the reader may read the project chat before the read (`proposalChat`).
- identity: N/A because nothing here acts as a person.
- failure: a failed set write fails the proposal's transaction (it is retried, as any write); a failed read fails the
  request as today.
- platforms: server only.

## Global Constraints

- Answers equal today's for every chat (seed path is today's algorithm; set path applies the same rule to the same roots).
- Production: no access; the collection and its index come with the release's schema push (no TTL index, so no
  pre-push step).
- Backend rules (backend/AGENTS.md): the model names what removes it; the new query gets an integration plan test (IXSCAN
  on its index, docs examined close to returned).
- Swarm code stays out of cli/src/core. Temp files only in mktemp -d folders.

## Review Focus

- The prune is sound: an answer under `askOf` never becomes a proposal again (marks, lead replies). The one edge is a lead
  agent replaced: today a proposal its old lead answered would read as open again; with the set it stays answered.
- The write path inserts a row only for a proposal root (`source.kind` `buddy-proposal`, own thread).
- The seed window covers proposals written by old pods during the rolling release.

## Task 1: the read over the open set (`backend/src/superTabs/proposals.ts`)

**Files:** `backend/src/superTabs/proposals.ts`, `backend/src/superTabs/proposals.test.ts`

**Interfaces:**
```ts
export const SEED_SETTLE_MS = 30 * 60_000
export interface ProposalReads {
  seededAt(): Promise<number | null>
  seed(roots: Array<{ id: string; sequence: number }>): Promise<void>
  listed(before: number | undefined, take: number): Promise<Array<{ id: string; sequence: number }>>
  rootsById(ids: string[]): Promise<ProposalRoot[]>
  roots(before: number | undefined, take: number): Promise<ProposalRoot[]>   // the seed's chat scan
  threads(rootIds: string[]): Promise<ThreadReply[]>
  forget(ids: string[]): Promise<void>
}
export function openProposals(state, chat, reads, now?: number): Promise<OpenProposal[]>
```

- [ ] Failing tests (fake reads): unseeded chat → today's answer, open roots seeded, mark set; seeded chat → the same
  answer from the set with no chat scan, whatever the chat's length (scan calls 0, set and root reads constant); a new
  proposal in the set is listed; one answered by the PM or marked by a task is not listed and is forgotten; a root
  whose message is gone is forgotten; within the settle window the scan runs again.
- [ ] Watch them fail.
- [ ] Implement; tests pass.

## Task 2: the database side (schema, write path, reads, purge)

**Files:** `backend/prisma/schema.prisma`, `backend/src/superTabs/proposals.ts` (`databaseProposalReads`,
`openProposalRows`), `backend/src/superTabs/store.ts` (`writeMessages`), `backend/src/superTabs/parts/indexed.ts`
(`NAMED_INDEX.SuperTabOpenProposal.open`), `backend/src/superTabs/purge.ts`,
`backend/integration/superTabProposals.test.ts`, `backend/integration/superTabBuddies.test.ts`.

- [ ] Failing integration tests: the store's proposal write adds the root to the set; the read lists it, and drops it
  once the PM answers in its thread; after the seed, the read's operations are the same for a 30-row and a 3,000-row
  chat and the set's read is an IXSCAN on its index with docs examined equal to returned; a purged Swarm leaves no
  rows.
- [ ] Watch them fail.
- [ ] Implement; tests pass. Backend unit tests of what changed; the PR's CI runs the suites.
