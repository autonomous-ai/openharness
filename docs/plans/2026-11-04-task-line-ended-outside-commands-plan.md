# A task ended outside any command says so in its thread Implementation Plan

> **For agentic workers:** Follow the project Engineer workflow: plan first in a draft PR; implement task by task with a committed failing test before its passing code; one independent review step on the pull request.

**Goal:** A task lost to the liveness sweep, a machine's report or its Lead's poll, or stopped by its host's stop receipt, posts its one `Stuck` or `Not building this` reply in its project-chat thread, as a task that moves in a command does. Today these thread replies are the only task state the chat shows (#2704), so the thread kept saying `On it: Kai is building it` for hours, then jumped to the next builder. Fix to what ships (Diego, 2026-11-04, task #2693).

**Architecture:** `syncTaskLines` (taskLine.ts) compares the state before and after each command, so a status set outside any command is never seen: by `loseTask` (liveness.ts), called from the machine report and the 30 s sweep (store.ts `fullReading`) and the Lead's poll (store.ts `fullDeliveries`, `sweepForLead`), and by `store.stopped()`. A new `endedReply(state, group, id, fallback)` in taskLine.ts writes the reply where the status is set: same thread, author (the project's coordinator) and `system` source as the command path's replies, words shared with `progress()`. `loseTask` returns it with its two work-lost rows; `stopped()` writes it with its Stopped notice. The `lost` case leaves `progress()`, so `agent.alert`, the one command that loses a task, posts once. Each store path loads the task's project chat when its load left it out (`taskLineChats`), so the reply has somewhere to go.

**Tech Stack:** TypeScript, Vitest (backend unit tests); the Super Tab integration suite (Mongo memory replica set) for `stopped()`.

**Spec:** Swarm task #2693 (Diego; Buddy's proposal with the evidence on main 6368bf6b0).

## Global Constraints

- One reply per loss or stop, never two: a stable id from the assignment and the loss (a resumed task can be lost again), or the assignment for a stop.
- Replies wake nobody (`recipients: []`), as every task-line reply.
- A task with no line (a step, a private chat, the project chat) gets none. A task whose project chat no longer exists gets none.
- Swarm code stays out of cli/src/core. PR body begins `Requested by diego@autonomous.ai through Harness.`

## Design

- Growth: one message per lost or stopped attempt, in the chat that already holds the task's line; deleted with that chat's messages.
- Concurrency: inside the transactions that already set the status (the report, the Lead's poll, the stop receipt).
- Read cost: no new read when the project chat is loaded, which it is on every path today (loadObserved and a full load read every project chat). Otherwise one read by key for the missing chats.
- Scale: one row per loss; 10x tasks lost is 10x rows, the same as the work-lost rows beside them.
- Compatibility: an ordinary thread reply with the existing `system` source; old and new apps read it already.
- Migration + rollback: none. Rolling back stops new replies; written ones stay.
- Audience: the project chat's own readers, as for every task-line reply (a private project's chat is read only by its readers).
- Identity: written as the project's coordinator, else the task's worker for a loss or the stopped worker, never the machine owner.
- Failure: a missing chat writes nothing, and the task's own conversation still holds its work-lost rows or Stopped notice.
- Platforms: backend only.

## Review Focus

- `agent.alert` posts exactly one Stuck reply (the `lost` case is gone from `progress()`, and `loseTask` posts it).
- The reply's id is stable, so a retried report or poll transaction writes it once.
- Every path that sets `lost` or `stopped` outside a command has its project chat loaded before it writes.

---

### Task 1: A loss says Stuck in its thread

**Files:** `backend/src/superTabs/taskLine.ts`, `backend/src/superTabs/liveness.ts`, `backend/src/superTabs/store.ts` (`fullReading`, `fullDeliveries`), `backend/src/superTabs/liveness.test.ts`

**Interfaces:** `endedReply(state: SuperTabState, group: Conversation, id: string, fallback?: Author): MessageDraft[]`; `taskLineChats(state: SuperTabState): string[]`.

- [x] Failing tests (stepsFixture): a task lost by `sweepLiveness` after 120 quiet minutes has exactly one row in the project chat, in `cards.line.messageId`'s thread, `Stuck: <worker> stopped. Next: another engineer takes it over.`; the same through `sweepForLead`; `agent.alert` still posts exactly one. Commit; watch them fail.
- [x] Implement `endedReply`; return it from `loseTask`; drop `lost` from `progress()`; load missing line chats in `fullReading` and `fullDeliveries`. Commit; watch them pass.

### Task 2: A host's stop says Not building this in its thread

**Files:** `backend/src/superTabs/store.ts` (`stopped`), `backend/integration/superTabTaskLines.test.ts`

- [x] Failing test: a stop receipt for an assigned task posts one `Not building this: The execution host confirmed that this harness stopped.` reply in the task's thread, and a repeated receipt adds none. Commit; watch it fail.
- [x] Write `endedReply` in `stopped()` with its Stopped notice; load a missing line chat. Commit; watch it pass. Then the full backend unit suite.
