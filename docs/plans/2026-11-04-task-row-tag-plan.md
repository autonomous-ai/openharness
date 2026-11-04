# Task row tag Implementation Plan

> **For agentic workers:** Follow the project Engineer workflow: plan first in a draft PR; implement task by task with a committed failing test before its passing code; one independent review step on the pull request.

**Goal:** A task row in the project chat reads as its title alone, with `name  time · Task` above it, on phone and Desktop, older rows too. Strengthens "Tell the PM what you want, and your crew ships it": the chat reads as the crew's work, not a repeated phrase.

**Architecture:** The server posts the title alone and keeps marking the row by its source kind (`task-line`, `buddy-proposal`). Each client's `SuperTabMessage.fromJson` drops the old prefix from those two kinds, so every surface that reads a row's text (row, thread head, quote, Activity, link preview, copy) agrees. The row header adds ` · Task` to its time text when `postedForAuthor` is true. Both clients already read that field.

**Tech Stack:** TypeScript, Vitest; Flutter/Dart Desktop and phone.

**Spec:** Task #2552 in Super Tab conversation 99ff470b7cab4420ba3da737 (Dee, 2026-11-04).

## Global Constraints

- Look, as Dee agreed:

  ```
  (D)  dee  [PM]  10:05 · Task
       Offline drafts
  ```

  The role badge stays right after the name. ` · Task` is in the time's muted style. A plain message has no tag.
- Only a row whose source kind is `task-line` or `buddy-proposal` loses a leading `Let's build: `. A person's own message that says it keeps it.
- Source kinds and everything else on the row stay as they are. Stored rows are not rewritten.
- Desktop tests use a memory store and a fake sign-in. No build on a phone. No Swarm code in cli/src/core.
- PR body begins `Requested by dee@autonomous.ai through Harness.`

## Design

- Growth, concurrency, read cost, scale, audience, identity, failure: N/A because this changes the words of a row that is already posted, with no new data, query, lock or reader.
- Compatibility: an older client shows the new row's title alone, with no tag. A new client on an older backend strips the prefix and shows the tag. Stored rows keep the prefix, so the strip stays as long as those rows exist.
- Migration + rollback: no migration. Rolling back the backend posts the prefix again, and new clients strip it.
- Platforms: backend, CLI skill text; macOS, Linux, Windows and web through Desktop's shared Flutter code; iOS and Android through the phone app.

## Review Focus

- A task row must keep its tag when the same person posts twice within five minutes: rows group under one header there, so today a second task row would have no header and no mark at all. A task row stands on its own, on both sides, on both clients.
- The strip is limited to the two source kinds.

## Task 1: Backend posts the title alone

**Files:** `backend/src/superTabs/taskLine.ts`, `backend/src/superTabs/commands.ts`, `backend/src/superTabs/catchUp.ts` (comment), `backend/src/superTabs/taskLine.test.ts`, `backend/src/superTabs/buddies.test.ts`

**Interfaces:** the posted root's `text` is the title; `source` is unchanged.

- [ ] Change the tests to expect the title alone with the source unchanged; commit; watch them fail.
- [ ] Post the title alone; commit; watch them pass.

## Task 2: Desktop

**Files:** `desktop/lib/super_tabs/model.dart`, `desktop/lib/super_tabs/message_row.dart`, `desktop/test/super_tab_task_line_test.dart`, `desktop/test/super_tab_plain_work_shots_test.dart`

**Interfaces:** `SuperTabMessage.text` has no old prefix on the two kinds; the header's time text reads `<time> · Task`; `groupsWith` is false on either side of such a row.

- [ ] Write failing tests: header shows `· Task` after the time; an old row's prefix is not shown; a person's own "Let's build: x" keeps its words and has no tag; a plain message has no tag; a PM role badge stays after the name; a second task row by the same person keeps its header. Commit; watch them fail.
- [ ] Implement; commit; watch them pass.

## Task 3: Phone

**Files:** `mobile/lib/swarm/model.dart`, `mobile/lib/swarm/swarm_message_row.dart`, `mobile/lib/swarm/swarm_conversation_page.dart`, `mobile/test/swarm/swarm_task_line_test.dart`, `mobile/test/swarm/swarm_special_rows_test.dart`, `mobile/test/swarm/swarm_task_line_shots_test.dart`, `mobile/test/swarm/swarm_unread_line_test.dart`

**Interfaces:** as Desktop; `swarmGroupedMessages` leaves such a row out on either side.

- [ ] Write the same failing tests; commit; watch them fail.
- [ ] Implement; commit; watch them pass.

## Task 4: Skill text

**Files:** `cli/src/lib/swarmSkills.ts`

- [ ] Change the three lines that quote `Let's build: <title>` to say the Swarm posts the title. Copy only, so it needs no test of its own; run the skills' existing spec.

## Task 5: Screenshots and evidence

- [ ] Light and dark screenshots of the project chat on phone and Desktop from the shots tests, committed then removed, and embedded in the PR.
- [ ] Red/green evidence in a PR comment.
