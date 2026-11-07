# The Tasks board's six columns: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** The Desktop Tasks board reads Proposal → Next up → Working → Done → Merged → Shipped, Board and List alike, so each
column is one place where work waits (task #3812, requested by Huy through Harness; the columns are Ken's decision in the
spec "The Task Board", docs/plans/2026-11-06-buddy-board-final-spec.md).

**Architecture:** `task_groups.dart` already places every task for Board, List and the badge with one function,
`superTabTaskPlaceOf`, and one enum, `SuperTabTaskColumn`. The enum gets the six columns; the function places by them:
Waiting folds into Working (its captions stay as the one mark for where the task is), a task finished and waiting for its
merge is Done with how long it has waited, a merged task still releasing is Merged with the parts it waits on, and a
released one is Shipped with its version. `SuperTabConversation` reads the `released` record the server already sends
(`{at, tags}`, backend model.ts), which is where the version comes from. `tasks_view.dart` draws whatever columns the enum
lists, so Board and List follow with no new layout.

**Tech Stack:** Dart, Flutter widget and unit tests with the fake Swarm of `test/support/super_tab_fixture.dart`.

**Spec:** Task #3812's brief and its scope update; the Task Board table of the final spec.

## Global Constraints

- PR body first line: "Requested by phamngochuy.1989 through Harness."
- Desktop only, no backend change. Owns `desktop/lib/super_tabs/` and `desktop/test/`.
- Light and dark screenshots of the board posted to Huy in this task before merge.
- Desktop tests use a memory store and a fake sign-in. No fixed sleeps.

## Design

- growth, concurrency, read cost, scale, migration: N/A because nothing is stored; the same snapshot is placed differently.
- compatibility: a server that sends no `released` record (work shipped before it) shows the pull request number as today.
- audience, identity: unchanged; the same tasks the reader may read.
- failure: a task whose time is not known shows no waiting time, never a wrong one.
- platforms: Desktop and web, one Dart path.

## What is not built, and why

- "Merged: when the next release is due". The release window and pace are the project's rules on the server and are not sent
  to clients (backend read/views.ts strips them), so Desktop cannot say when. The Merged card shows the parts it waits on,
  as today. Showing a due time needs the server to send it: a proposal for the PM, not built here.
- "Done: the PR is green". CI state is read from GitHub on the reader's own computer for the live cards, not carried in the
  Swarm's state, so the board cannot tell a red PR from a green one. Done is what the Swarm records: review and test passed
  and the task set done. Working keeps its marks for review, changes requested, blocked and a person to decide; "CI red" and
  "testing" need the same data and are not marks here.

## Review Focus

- Every task lands in exactly one column, and Board, List and the red Tasks badge agree.
- Shipped keeps its seven-day window; work with no code that is Done stays Done, never Shipped.

## Task 1: the six columns and the places

**Files:** `desktop/lib/super_tabs/task_groups.dart`, `desktop/test/super_tab_task_columns_test.dart`,
`desktop/test/super_tab_releasing_test.dart`.

- [ ] Failing test: the columns read Proposal, Next up, Working, Done, Merged, Shipped; a task waiting on review, a person,
  a block, a machine or quiet is in Working with its caption; a task set done is in Done; a merged task still releasing is in
  Merged with its parts. Watch it fail. Commit.
- [ ] Change the enum and `superTabTaskPlaceOf`; keep the sorts (Done and Merged by number, newest first). Commit.

## Task 2: how long Done has waited

**Files:** the same, and `tasks_view.dart` for the caption.

- [ ] Failing test: a done task with a pull request reads "waiting to merge for 12 min" from its first Done; past an hour it is a
  warning (`needsAttention`), and a done task with no code reads "Done" and stays in Done.
- [ ] Place it with `shippedAt` (its first Done, before a merge is recorded) and render the warning with the existing tokens.

## Task 3: Shipped shows the version

**Files:** `desktop/lib/super_tabs/model.dart`, the same tests.

- [ ] Failing test: a task whose `released` tags are `v1.3.84_desktop` and `v1.4.20_backend` reads "Desktop 1.3.84, Backend 1.4.20"
  in Shipped; one with no record reads its pull request as before.
- [ ] Read `released` in `SuperTabConversation` and name the tags.

## Task 4: Board and List, screenshots

**Files:** `desktop/test/super_tab_tasks_view_test.dart`, `desktop/test/super_tab_tasks_shots_test.dart`.

- [ ] Widget test: a merged task waiting for its release is under Merged and not Waiting (no Waiting column) in Board and in List.
- [ ] Light and dark screenshots of the six columns, written when the capture directory is set; posted in the task for Huy.
