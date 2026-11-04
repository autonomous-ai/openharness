# Asks stay people's own messages Implementation Plan

> Written by the project's Engineer by writing-plans, implemented by the same Engineer task by task, test first
> (project instructions, Engineer). Task #2925.

**Goal:** A person only ever sees rows they wrote in the project chat: a task posts no row of its own, tasks hang in the
thread of the message that asked for them, and the task's agent reacts 👀 when it starts and ✅ when it merges, in place of
the On it / Shipped label.

**Architecture:** The server stops posting a task-line root for a task that has no asking message (no `requestMessageId`
and no Buddy proposal); such a task lives in Backlog and its own conversation. A task with an asking message names itself
once in that message's thread, and every task under the same message does the same. `syncTaskLines` (taskLine.ts) adds
reactions to the command's effects, written by the store like a `message.react` of the agent; the "On it: X is building
it." reply goes, since 👀 says it. Thread summaries stop carrying `on-it` / `shipped`, so even an older app draws no label;
Desktop (and the web build of it) and the phone stop drawing them too.

**Tech Stack:** TypeScript backend (vitest, Prisma on MongoDB), Flutter Desktop and phone apps (flutter_test).

**Spec:** Task #2925's brief; the ASCII agreed with anh Dee in his "bot messages" thread (11-04 19:15–19:45 VN): rows are
people talking, reactions under them, the thread line unchanged. Project instructions rev 66, "Talking in the project chat".

## Global Constraints

- PR body first line: "Requested by dee@autonomous.ai through Harness."
- Old task-line rows stay in history as they are: nothing rewrites or deletes stored rows.
- Backlog, Activity and the status card still find every task.
- One 👀 and one ✅ per task, from the task's agent; a repeat of either changes nothing.
- Swarm code stays out of cli/src/core. Desktop tests use a memory store and a fake sign-in.
- Temp files only in mktemp -d folders. Stop only processes I started, by id.

## Design

- growth: no new collection. Reactions are rows of SuperTabReaction, at most two per task, deleted with their message
  (store.ts writeDelete) and the Swarm's purge, as every reaction is.
- concurrency: the reaction is written in the command's own transaction, by its derived id (upsert), as `message.react`
  writes it; the group's `reactionSeq` moves in the same state commit.
- read cost: nothing new is read. Reactions arrive on the page reads that already carry reaction counts, moved by
  `reactionSeq` on the project chat.
- scale: 10x tasks means 10x reaction rows, two per task; the reaction index by message already serves them. The first
  metric to warn is the reaction count per chat page, unchanged in shape.
- compatibility: an old app gets no `on-it` / `shipped` from thread summaries and so draws no label; it already draws 👀
  and ✅ (reactions.ts REACTIONS). A new app on an old server would still get the old summary field and now ignores it.
- migration + rollback: none. Rolling back brings back roots for new tasks only; rows written meanwhile stay valid.
- audience: the reaction is on the asking message in its project chat; only that chat's readers read it (page reads
  check the audience as for every reaction).
- identity: the reactor is the task's assigned agent, never the machine owner or the PM.
- failure: a task with no asking message has nothing to react on and posts nothing; its Buddy's Shipped news still goes.
- platforms: backend; Desktop on macOS, Windows, Linux and web; phone on iOS and Android.

## Review Focus

1. A task created by the PM with a requester but no asking message: no row under that person's name, and their Buddy
   still hears it shipped.
2. Two tasks under one person's message: both named in its thread, two 👀 only if two agents, one ✅ per merged task.
3. A task handed to a second agent after a loss: no second 👀 for the same task.
4. A merge recorded twice, or a second pull request merged for the same task: one ✅.
5. A proposal thread: the ✋ Proposal tag still shows until the PM answers; On it / Shipped never shows.

---

### Task 1: No row for a task without an asking message; tasks named in their asking thread

**Files:**
- Modify: `backend/src/superTabs/taskLine.ts` (`moved`)
- Test: `backend/src/superTabs/taskLine.test.ts`, `backend/integration/superTabTaskLines.test.ts`

**Interfaces:**
- Produces: a task's `cards.line` is set only from `requestMessageId` (commands.ts) or its proposal; no `task-line` row is
  written for any new task.

- [ ] Step 1: tests — `conversation.create` with no request posts no project-chat message and leaves `cards.line` unset;
  with a request it posts one thread reply, the task's title, under that message and no top-level row; two tasks naming
  the same message both get their line and their title reply in its thread; a task with no line still yields its Buddy's
  shipped notice on merge.
- [ ] Step 2: run them, see them fail.
- [ ] Step 3: `moved`: with no line and no proposal, post nothing in the chat (keep the Shipped news); with a request's
  line new in this command, reply with the title.
- [ ] Step 4: run `taskLine.test.ts` and the tests that import taskLine (grep), and the integration file; commit.

### Task 2: The agent reacts 👀 on start and ✅ on merge; no "On it" reply

**Files:**
- Modify: `backend/src/superTabs/model.ts` (`CommandEffects.reactions`), `backend/src/superTabs/taskLine.ts`,
  `backend/src/superTabs/store.ts` (write them)
- Test: `backend/src/superTabs/taskLine.test.ts`, `backend/integration/superTabTaskLines.test.ts`

**Interfaces:**
- Produces: `CommandEffects.reactions?: Array<{ conversationId: string; messageId: string; agentId: string; emoji: Reaction }>`.

- [ ] Step 1: tests — first `work.assign` yields 👀 by the assigned agent on the line's message and bumps the chat's
  `reactionSeq`; a reassignment yields none; the first merge yields ✅ by the task's agent; a repeated merge yields none;
  no "On it:" reply; through the store, the asking message's page shows 👀 then ✅ by the agent, and its author gets the
  reaction in Activity.
- [ ] Step 2: run, see them fail.
- [ ] Step 3: push reactions in `moved`; the store upserts each by `reactionId` for the agent actor and writes its
  Activity row, as `writeReaction` does.
- [ ] Step 4: run the touched tests; commit.

### Task 3: Thread summaries carry no On it / Shipped

**Files:**
- Modify: `backend/src/superTabs/threads.ts` (`askOf`)
- Test: `backend/src/superTabs/threads.test.ts`

- [ ] Step 1: test — a thread with task marks has no `ask`; a proposal with no PM reply is still `proposal`.
- [ ] Step 2: fail; Step 3: `askOf` returns only `proposal`; Step 4: pass; commit.

### Task 4: Desktop and web draw no On it / Shipped

**Files:**
- Modify: `desktop/lib/super_tabs/model.dart` (`askTag`)
- Test: `desktop/test/super_tab_task_line_test.dart`

- [ ] Step 1: test — a thread whose `ask` is `on-it` or `shipped` draws no tag on its row; `proposal` still does.
- [ ] Step 2: fail; Step 3: drop the two cases; Step 4: pass; commit.

### Task 5: The phone draws no On it / Shipped

**Files:**
- Modify: `mobile/lib/swarm/model.dart` (`askTag`)
- Test: `mobile/test/swarm/swarm_task_line_test.dart`

- [ ] Same steps as Task 4 for the phone.

### Task 6: Screenshots

- [ ] Light and dark main chat on Desktop and phone with a person's ask carrying 👀 / ✅ and its thread line, from the
  apps' screenshot tests; send them to anh Dee in the task before merge.
