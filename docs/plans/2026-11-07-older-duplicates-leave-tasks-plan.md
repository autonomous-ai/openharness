# Every duplicate leaves Tasks, however old its real task — Plan (task #4480)

**Goal:** A task cancelled as a duplicate of, or folded or split into, another task of its project leaves people's Tasks
whatever the real task's age, the ones cancelled before this ships included, and tapping it in the project's Archived
conversations opens the real task.

**Architecture:** #4462 (PR #3534) links a cancel to the tasks its reason names (`foldedInto`), but a command holds only
awake conversations, so a real task quiet for a day is never found. A task's number becomes an indexed column
(`SwarmGroup.number`, `@@index([tabId, number])`), set on every write. `work.cancel` reads the tasks its reason names by
that index (store.ts `moreNamed`), so `goesOnIn` sees them dormant or not. At worker start, a one-time pass sets the column
on older rows and links each older cancel whose reason names a task (`linkOlderDuplicates`): its reason is the cancelled
assignment's result, or the "cancelled this task:" line of a task nobody was assigned. Each link is one store write
(`store.linkFolded`) that checks it as `work.cancel` does and posts a line in the duplicate saying where its work goes on,
so nothing is hidden silently. Only the agreed phrases link: "Duplicate of #N", "Being done inside #N", "Split into #N…",
"Folded into #N". Desktop reads `foldedInto` and the Archived row opens its first task.

**Tech Stack:** TypeScript backend (`backend/src/superTabs`), Prisma on MongoDB, vitest with mongodb-memory-server;
Flutter Desktop (`desktop/lib/super_tabs`), flutter_test.

**Spec:** task #4480's brief, and River's follow-up in its conversation (only the agreed phrases link).

This plan is implemented test first by the Engineer, task by task (test-driven development); there is no execution
hand-off.

## Global Constraints

- Audience is server-enforced: only a task of the same project, never a chat, a step or a private conversation, is linked;
  only who may cancel work links by command.
- Never delete data: the duplicate, its messages and its archived place stay.
- Read only what changed: the cancel reads at most 10 rows by an index; the start pass runs once per row.
- Desktop tests use a memory store and a fake sign-in.
- Builds on PR #3534 (`tasks-folded-4462`); rebased on main once it merges.

## Design

- growth: one integer column per conversation, deleted with it; `foldedInto` stays at most 10 ids.
- concurrency: the conversation's own guarded write (the command's, or `linkFolded`'s transaction).
- read cost: a cancel naming tasks adds one indexed read of at most 10 rows; no read path changes.
- scale: 10x conversations is 10x index entries of one int; the first warning is the start pass's duration, logged.
- compatibility: backend only adds a column and a field clients already read (`foldedInto`, PR #3534); older Desktops
  ignore it.
- migration and rollback: the start pass sets `number` where it is missing and links older duplicates once; rollback
  leaves an unread column and the links, which an older backend ignores in commands and honours in the feed.
- audience: unchanged, server-enforced (`goesOnIn`).
- identity: N/A because no login is involved; the line is the project's Lead's, as the Swarm's own lines are.
- failure: a link the pass cannot write is logged by conversation and skipped; the PM can still re-cancel it.
- platforms: backend (Linux); Desktop on macOS, Windows, Linux and web (one Dart change, no platform code).

## Review Focus

- A cancel naming a task of another project, a private chat or a step links nothing, by command or by the start pass.
- The start pass never re-links, never touches a task already linked, and a second start does nothing.
- A task nobody was assigned keeps its reason only in its cancel line: a later message must not hide it.
- A loose mention ("will look into #4421", "Part of the cause is #4421") never links.
- The Archived tap on a duplicate whose real task the reader holds no row for still opens it (`select` reads it).

## Task 1: only the agreed phrases link

**Files:** Modify `backend/src/superTabs/commands.ts` (`tasksNamedIn`); Test `backend/src/superTabs/commands.test.ts`.

- [ ] Test: `tasksNamedIn` returns `[]` for each of 'will look into #4421 later', 'Part of the cause is #4421',
  'Inside #4421', 'Same as #4421', 'Covered by #4421', 'Replaced by #4421', 'Superseded by #4421', 'Dup #4421',
  'Duplicates #4421'; and `[4465, 4466, 4468]` for 'Accepted and split into #4465, #4466 to #4468'.
- [ ] Run `npx vitest run src/superTabs/commands.test.ts -t "naming where"`: fails.
- [ ] Code: the phrase is one of `duplicate of`, `being done inside`, `split into`, `folded into`.
- [ ] Run again: passes. Commit.

## Task 2: a cancel links a real task however old

**Files:** Modify `backend/prisma/schema.prisma` (`number Int?`, `@@index([tabId, number])`),
`backend/src/superTabs/parts/write.ts` (`extracted`), `backend/src/superTabs/parts/indexed.ts` (`GROUP_INDEX.number`),
`backend/src/superTabs/parts/load.ts` (`loadGroupKeysByNumber`), `backend/src/superTabs/store.ts` (`moreNamed`);
Test `backend/integration/superTabPersonalTasksFeed.test.ts`, `backend/integration/superTabGroupPlans.test.ts`.

**Interfaces:** Produces `loadGroupKeysByNumber(tx, tabId, numbers: number[]): Promise<string[]>` (live groups' keys, read
through `number`); `goesOnIn` exported from commands.ts.

- [ ] Test (feed): a real task done and quiet for two days, a duplicate cancelled "Duplicate of #<real>": the duplicate leaves
  the owner's feed and its view names the real task; one cancelled "Duplicate of #<other project's task>" is refused with
  FOLD_TARGET and stays.
- [ ] Test (plans): a cancel naming a quiet task reads it through the `number` index and reads only what it returns.
- [ ] Run `npx vitest run --config vitest.super-tabs.config.ts integration/superTabPersonalTasksFeed.test.ts`: fails.
- [ ] Code it. Run both files: pass. Commit.

## Task 3: older duplicates leave at worker start

**Files:** Create `backend/src/superTabs/read/olderDuplicates.ts` (`linkOlderDuplicates`); Modify
`backend/src/superTabs/store.ts` (`linkFolded`), `backend/src/worker.ts`; Test
`backend/integration/superTabPersonalTasksFeed.test.ts`.

**Interfaces:** `linkOlderDuplicates(db: PrismaClient, store: Pick<SuperTabStore, 'linkFolded'>): Promise<number>` (links
made); `store.linkFolded(tabId: string, groupId: string, reason: string): Promise<boolean>`.

- [ ] Test: with rows stored as before (no `number` column, no `foldedInto`): an assigned task cancelled "Duplicate of
  #<old real>", an unassigned one whose cancel line says "Being done inside #<old real>" followed by a later message, one
  naming another project's task, and one "Waiting on #<real>". After the pass the first two leave the feed, each with one
  line naming the real task; the others stay; every row has `number`; a second pass links nothing.
- [ ] Run: fails. Code it; worker runs it after `markFeedIds`, logging the count or the error. Run: passes. Commit.

## Task 4: the Archived row opens the real task

**Files:** Modify `desktop/lib/super_tabs/model.dart` (`SuperTabConversation.foldedInto`), `desktop/lib/super_tabs/view.dart`
(`_archived`); Test `desktop/test/super_tabs/archived_duplicate_test.dart`.

- [ ] Test: a memory store with a project, an archived duplicate whose `foldedInto` names a dormant real task and a plain
  archived task, and a fake sign-in; open Archived conversations, tap the duplicate: the real task is selected; tap the plain
  one: it is selected.
- [ ] Run `flutter test test/super_tabs/archived_duplicate_test.dart`: fails. Code it. Run: passes. Commit.
