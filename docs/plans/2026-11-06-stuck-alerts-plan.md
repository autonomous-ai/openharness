# Stuck work is flagged at once to the PM and the people on the task: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** Within 5 minutes of a task getting stuck, its PM and its people (its requester, and the people who wrote in it)
hear it in one line in the task, which tags them, so it is in their Needs you. The cases: (a) its pull request's checks are
red at its head while its Engineer says review or done; (b) one of its steps lost its agent, or its agent could not start;
(c) its own agent went down and nobody has taken it after 10 minutes. One line per change; when it is fixed, the tags
resolve and one line says so; nothing repeats (task #3915, Tony 11-06: #3821 sat with red mobile-checks and a lost Test
step, and nobody told him).

**Architecture:**

- `stuck.ts` (new): `stuckOf(state, task, now)` is the task's one stuck reason now, or null, with its key and line; the
  first of: down (c), a step (b), red checks (a). `stuckAlerts(state, now)` compares each task's reason with the one recorded
  on it (`Conversation.stuck`: key, message id, people tagged) and writes the change: a new reason posts one line as the
  PM, to the PM, tagging the task's people; a reason gone posts one "No longer stuck" line and hands back the tags to
  resolve. The time checks run it (store.ts `runTimeChecks`, every Swarm at least every 5 minutes, timeChecks.ts
  QUIET_CHECK_MS), and now write the tags of the rows they write (`writeMentions`, as a command's rows do) and tell phones.
- (a) reads `Conversation.pullRequestChecks` (task #3827, written by the PR watch every minute, done tasks included) for
  the task's newest pull request: `red` with the assignment in review or done, or reopened to its Engineer by that red and not
  picked up yet.
- (b) a step whose assignment is lost, or whose liveness says its start failed.
- (c) the task's assignment lost for 10 minutes or more.
- The people: the requester and `Conversation.writers` (new): the people who posted in the task, newest last, at most 4,
  kept by message.send. Only people who can read the task are tagged (`canReadGroup`), at most MAX_MENTIONS, so members see
  only their own tasks' alerts.
- Cleared tags resolve by `resolveTags` (mentions.ts, new): `resolvedBy: 'fixed'`, on the `[tabId, conversationId, personId]`
  index, one update per person (at most 5).

**Tech Stack:** TypeScript backend (vitest).

**Spec:** task #3915 brief.

## Global Constraints

- No new chat lines but one per state change, in the task's own conversation; nothing in the project chat.
- Steps, chats and finished, cancelled or archived tasks are never flagged; a task that ends while flagged has its tags
  resolved and no line.
- Owns backend/src/superTabs/.

## Design

- growth: `stuck` is one small record per stuck task, removed when it is fixed; `writers` at most 4 ids per task. Both go
  with the task. One tag row per tagged person per change, under the mentions' 30-day expiry.
- concurrency: inside the time check's own Swarm write, as its other notices.
- read cost: loaded state only; the tag resolve is one indexed update per person when a reason clears.
- scale: one pass over the loaded tasks per time check, which already walks them; lines only on change.
- compatibility: new optional group fields, a new `resolvedBy` value `fixed` (clients read a resolved tag as resolved).
- migration and rollback: none; revert. Old groups have neither field.
- audience: tags only to people who can read the task, by the server.
- identity: N/A because nothing runs as anyone.
- failure: this is the failure being made seen.
- platforms: backend only.

## Review Focus

- One line per change and none repeated across passes or servers (the record is in the same write as the line).
- A member is tagged only in tasks they can read.

## Task 1: who wrote in a task

**Files:** model.ts, commands.ts (message.send), stuck.test.ts (new).

- [ ] Test: a person's post in a task records them in `writers`, newest last, at most 4; an agent's post does not.
- [ ] Watch it fail; code; watch it pass; commit.

## Task 2: the stuck reason and its line

**Files:** stuck.ts (new), stuck.test.ts.

- [ ] Tests, for each case (red checks with status review, a lost step, a down agent with no taker after 10 minutes): the
      PM and the requester are told once in one line, a second pass says nothing, and when it is fixed one line clears it
      and hands back the tags; red checks while working, or a down agent for 9 minutes, say nothing.
- [ ] Watch them fail; code; watch them pass; commit.

## Task 3: the time checks write it, and fixed tags resolve

**Files:** store.ts (runTimeChecks), mentions.ts (resolveTags), mentions.test.ts or stuck.test.ts.

- [ ] Test: `resolveTags` resolves only the given message's waiting tags for those people.
- [ ] Watch it fail; code (runTimeChecks writes the rows' tags, tells phones and resolves the cleared ones); watch it pass;
      commit.
