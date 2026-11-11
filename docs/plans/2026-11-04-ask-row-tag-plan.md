# Ask row tag Implementation Plan

> **For agentic workers:** Follow the project Engineer workflow: plan first in a draft PR; implement task by task with a committed failing test before its passing code; one independent review step on the pull request.

**Goal:** The project chat shows one row per ask, with its state after the time: `✋ Proposal`, `● On it` or `✓ Shipped`. "Let's build:" is gone, older rows included. Strengthens "Tell the PM what you want, and your crew ships it": a person sees where their ask stands without opening anything.

**Architecture:** The server marks each reply it posts for a task with what that reply means for the task (`source.ask`), and the thread summary every chat page already carries gains `ask`, worked out from those marks and from who replied. Clients draw the tag from the summary. Summaries arrive with each reply, so the tag moves without a new read or poll.

**Tech Stack:** TypeScript, MongoDB aggregation, Vitest; Flutter/Dart Desktop and phone.

**Spec:** Task #2552 in Super Tab conversation 99ff470b7cab4420ba3da737 (Dee, 2026-11-04; updated brief from River the same day).

## Why a server field

The brief asks for server fields only if the apps lack the data. They lack it: a finished task leaves the set of groups the apps hold (it archives 30 minutes after going quiet, and goes dormant within a day), so a client lookup would drop `✓ Shipped` soon after the merge. A plain message or proposal row also names no task, and only the task names the row.

## Global Constraints

- Look, as Dee approved:

  ```
  (D) diego  06:36  ✋ Proposal
      Desktop chat: in a task with steps, your next message reads as the step agent's

  (R) River PM  02:15  ● On it
      I'm fixing the CI check that timed out on every batch tonight.

  (S) scholes  05:10  ✓ Shipped
      Backlog: Mine shows nothing and doesn't say why
  ```

  The tag is in the time's muted style. What follows the name stays: the role badge on the phone, the engine mark on Desktop. A message that is no ask has no tag.
- States of a row:
  - `✋ Proposal`: a Buddy proposal with no task's reply in its thread, until the PM replies. After a PM reply with no task (a No or a Later), no tag.
  - `● On it`: a task's reply is the newest mark in its thread, and the task is open.
  - `✓ Shipped`: the task's pull request merged.
  - No tag: the task was cancelled or stopped, or finished with no pull request.
- A task opened from someone's own message tags that message. No new row (already so: `cards.line` names it, and its replies go in its thread).
- Only a row whose source kind is `task-line` or `buddy-proposal` loses a leading `Let's build: `. A person's own message that says it keeps it.
- A tagged row keeps its header: it never groups under the message before it, and nothing groups under it.
- Desktop tests use a memory store and a fake sign-in. No build on a phone. No Swarm code in cli/src/core.
- PR body begins `Requested by dee@autonomous.ai through Harness.`

## Design

- Growth: one short word on replies the server already posts, and on the thread summary they already refresh. Both go with their message.
- Concurrency: written in the command's existing transaction, as the replies are.
- Read cost: no new query. The thread facet groups by one more key, adding at most three parts to a task's thread. A page's summaries read as before.
- Scale: 10x tasks means 10x marks on the same rows; the first warning is the thread facet's time, which the existing read measures watch.
- Compatibility: an older client ignores both fields and shows the title alone with no tag. A new client on an older backend shows no tag. Stored summaries without the key read as unmarked until their thread's next reply rewrites them.
- Migration + rollback: no migration, and stored rows are not rewritten. An older row has no marks, so it shows no tag, except a Buddy proposal the PM has not answered. An open task's row gains its tag at its next reply. Rolling back leaves the extra source field unread.
- Audience: the summary is computed for rows the reader may already see; hidden replies are skipped before it, as they are for the reply count.
- Identity: a mark is written by the server only; no command takes `source` from a sender.
- Failure: a merge recorded with no card used to post no reply, which would leave a row at `● On it`. It now posts the Merged reply. A task that finishes with its pull request closed unmerged has no reply, so its row stays `● On it`; cancelling the task clears it.
- Platforms: backend, CLI skill text; macOS, Linux, Windows and web through Desktop's shared Flutter code; iOS and Android through the phone app.

## Project chat's own rows

Checked for the brief's item 4: the Swarm has written no ship row since plain chat (`ship.ts`: "No longer written"), and a task's route lines and notices go in the task's own conversation. What the project chat still gets at the top level (the digest, overlap alerts, machine removals, review capacity, instructions and routing lines) is about the project, not one task's shipping, so nothing moves.

## Review Focus

- `threadSummaries`' state rules, including a thread with more than three authors and hidden replies.
- `✓ Shipped` holds after the task archives, since it reads only the thread.
- The strip is limited to the two source kinds.

## Task 1: Backend posts the title alone (done)

- [x] Tests, then `taskLine.ts` and `commands.ts`.

## Task 2: Backend marks a task's replies

**Files:** `backend/src/superTabs/taskLine.ts`, `backend/src/superTabs/taskLine.test.ts`

**Interfaces:** every reply `moved` posts has `source: { kind: 'system', ask: 'on-it' | 'shipped' | 'closed' }`. A first recorded merge with no card posts the Merged reply.

- [x] Write failing tests; commit; watch them fail.
- [x] Implement; commit; watch them pass.

## Task 3: Thread summaries carry the state

**Files:** `backend/src/superTabs/threads.ts`, `backend/src/superTabs/threads.test.ts`, `backend/src/superTabs/pageReads.ts`

**Interfaces:** `ThreadSummary.ask?: 'proposal' | 'on-it' | 'shipped'`; `ThreadReply` gains `kind` and `ask`; the facet's part key gains `ask`.

- [x] Write failing tests for each state, the PM's reply, a hidden reply and a plain thread; commit; watch them fail.
- [x] Implement; commit; watch them pass.

## Task 4: Desktop draws the tag

**Files:** `desktop/lib/super_tabs/model.dart`, `desktop/lib/super_tabs/message_row.dart`, `desktop/lib/super_tabs/view.dart`, their tests. Drops the interim `· Task`.

**Interfaces:** `SuperTabThread.ask` and `askTag`; `consecutiveUpdates` and `groupsWith` take a `tagged` test.

- [x] Write failing tests: each state; no tag after a PM reply (no `ask` in the summary); a plain message; the engine mark unchanged; a tagged row keeps its header. Commit; watch them fail.
- [x] Implement; commit; watch them pass.

## Task 5: Phone draws the tag

**Files:** `mobile/lib/swarm/model.dart`, `mobile/lib/swarm/swarm_message_row.dart`, `mobile/lib/swarm/swarm_conversation.dart`, `mobile/lib/swarm/swarm_conversation_page.dart`, their tests. Drops the interim `· Task`.

**Interfaces:** as Desktop; `_sameThread` compares `ask`, so a moved tag redraws.

- [x] Write the same failing tests, with the role badge in place of the engine mark; commit; watch them fail.
- [x] Implement; commit; watch them pass.

## Task 6: Skill text (done)

- [x] The Buddy and PM skills say the Swarm posts the title.

## Task 7: Screenshots and evidence

- [x] Light and dark screenshots of the project chat on phone and Desktop, committed then removed, and embedded in the PR.
- [x] Red/green evidence in a PR comment.
