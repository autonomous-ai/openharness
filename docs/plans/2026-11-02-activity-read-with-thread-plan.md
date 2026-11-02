# Activity rows clear when their thread or chat is read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Activity badge stops counting replies the person already read in their thread or chat, and a Buddy session ending adds no Activity row.

**Architecture:** Each reply Activity row remembers its message `sequence` and whether the reply is `alsoInChat`. When a person's thread mark (or chat mark) moves, one `updateMany` sets `readAt` on that person's unread reply rows in that thread (or chat, for rows also sent to the chat) at or below the stored mark. The Activity digest is computed from unread rows, so it moves with them and every device sees the rows cleared. `writeReplyActivity` skips `buddy-session-ended` notices.

**Tech Stack:** TypeScript, Fastify, Prisma on MongoDB, vitest with `mongodb-memory-server-core`.

**Spec:** Task #2110 brief (Diego): evidence at `backend/src/superTabs/activity.ts` `writeReplyActivity` / `markActivityRead`, `backend/src/superTabs/read/service.ts` `markRead` / `markThreadRead`, `buddySessions.ts` `endSessionEntry`.

## Global Constraints

- Swarm code stays out of `cli/src/core`.
- Reactions rows are left as they are (only `kind: 'reply'` rows clear with a read).
- A client reads Activity again only when the digest moves, never on a timer (activity.ts header).
- An older backend reads and writes a tab that has the new fields; rows without `sequence` keep today's behavior (cleared by opening Activity).
- PR body starts with "Requested by diego@autonomous.ai through Harness." Full Super Tab integration suite before Ready.

## Review Focus

- A thread mark only clears rows of that person, that conversation and that thread, at or below the stored mark (a lower mark than the held one never clears more).
- A chat mark clears only rows also sent to the chat; a reply only in its thread stays unread until that thread is read.
- Another person's rows, and reaction rows, never clear.
- Old rows without `sequence` stay unread and are not an error.
- A Buddy-session-ended line writes no row, while a normal Buddy session answer still does.

## Design

- growth: rows still expire after 30 days (sweepActivity); the two new fields add a number and a boolean per row.
- concurrency: `updateMany` on rows only sets `readAt` where it is still unset; two devices marking at once are idempotent. No lock.
- read cost: the update matches by the new index `(tabId, personId, conversationId, threadId)`, touching only that thread's rows.
- scale: 10x the rows per person is still bounded by the 30-day expiry and that index; the metric to watch is mark request latency.
- compatibility: old rows have no `sequence` (never match `lte`), old backends ignore the new fields; old clients are unchanged (the digest and `read` flag are the same shape).
- migration + rollback: none to run (optional fields, `db push` builds the index); rolling back leaves extra fields that nothing reads.
- audience: the server writes `readAt` only on the marking person's own rows after the existing read checks of `markRead` / `markThreadRead`.
- identity: the person is the signed-in user (`user.sub`), as for read marks.
- failure: a failed Activity update fails the mark request, which the client retries as it does a mark; nothing is skipped silently.
- platforms: backend only; Desktop already reads the digest.

---

### Task 1: Store sequence on Activity rows and skip session-ended lines

**Files:**
- Modify: `backend/prisma/schema.prisma` (SuperTabActivity: `sequence Int?`, `alsoInChat Boolean?`, index)
- Modify: `backend/src/superTabs/activity.ts` (`writeReplyActivity`)
- Modify: `backend/src/superTabs/store.ts` (pass `sequences` to `writeReplyActivity`)
- Test: `backend/integration/superTabActivity.test.ts`

**Interfaces:**
- Produces: `writeReplyActivity(tx: Tx, tabId: string, messages: MessageDraft[], sequences: ReadonlyMap<string, number>, now: number): Promise<void>`; rows carry `sequence` and `alsoInChat`.

- [ ] **Step 1: Write the failing test** `a buddy-session-ended line writes no Activity row` (an ended line replying in a person's thread: no row; a normal reply: a row with `sequence` and `alsoInChat` set).
- [ ] **Step 2: Run it:** `cd backend && npx vitest run --config vitest.integration.config.ts integration/superTabActivity.test.ts -t "session-ended"`; expected FAIL.
- [ ] **Step 3: Implement** the schema fields and index, then skip `source.kind === SESSION_ENDED_KIND` and write `sequence` / `alsoInChat` in `writeReplyActivity`.
- [ ] **Step 4: Run it again;** expected PASS.
- [ ] **Step 5: Commit.**

### Task 2: A thread or chat mark clears the person's reply rows

**Files:**
- Modify: `backend/src/superTabs/activity.ts` (`markActivityThreadRead`, `markActivityChatRead`)
- Modify: `backend/src/superTabs/read/service.ts` (`markRead`, `markThreadRead`)
- Test: `backend/integration/superTabActivity.test.ts`

**Interfaces:**
- Consumes: `writeThreadMark` / `writeReadMark` return the stored mark.
- Produces: `markActivityThreadRead(db, { tabId, personId, conversationId, threadId, sequence, now }): Promise<number>` and `markActivityChatRead(db, { tabId, personId, conversationId, sequence, now }): Promise<number>`, each one `updateMany` of unread `kind: 'reply'` rows with `sequence <= mark` (chat: also `alsoInChat: true`).

- [ ] **Step 1: Write the failing tests:** (a) root by the owner, two worker replies, thread read past them: both rows read and the digest back to its value before the replies; another person's digest unchanged; (b) a thread mark below a reply leaves that reply unread; (c) a reply also sent to the chat clears by the chat mark, a thread-only reply does not; (d) a reaction row stays unread after both marks.
- [ ] **Step 2: Run them;** expected FAIL on main behavior.
- [ ] **Step 3: Implement** both functions and call them in `markThreadRead` and `markRead` with the stored mark.
- [ ] **Step 4: Run them;** expected PASS.
- [ ] **Step 5: Run the full Super Tab integration suite and typecheck;** expected PASS.
- [ ] **Step 6: Commit, push, open the pull request (draft until the suite passes).**
