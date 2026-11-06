# A board card opens its side panel: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** A card on anh Dee's board opens a side panel over the board with the task's brief, its comments, its steps with
verdicts, its pull request and CI, and its history, and a person can comment on the task from it (task #3788, requested by
Dee through Harness; the board core is #3787).

**Architecture:** One new widget, `CardPanel(controller, taskId, onClose)`, in `desktop/lib/super_tabs/board/card_panel.dart`.
It reads what the Swarm already sends and the controller already holds: the task conversation (`SuperTabConversation`:
`task` goal/changes/constraints, `brief`, `checks`, `assignment`, `pullRequestUrls`), its steps (`superTabStepsOf`), its
thread (`controller.messages`, read by `loadGroup` and `loadMessages`), and the pull request's GitHub facts
(`SuperTabPullRequestFacts`, the same read the live cards use). A comment posts with `controller.command` as a
`message.send` to the task's own conversation, so the panel never selects the task or moves the reader off the board. It
reuses `superTabCardStatus`, `superTabCheckLabel`, `SuperTabChip` and the grid tokens; it adds no data and no setting.

**Tech Stack:** Flutter widgets and widget tests; the fake Swarm of `test/support/super_tab_fixture.dart` with a memory store
and a fake sign-in.

**Spec:** Task #3788's brief; the board design docs/plans/2026-11-06-board-view-design.md that #3787 carries (this piece is
built in its own files and wired in with one line once #3787 merges).

## Global Constraints

- PR body first line: "Requested by dee through Harness."
- Owns `desktop/lib/super_tabs/board/card_panel.dart` and `desktop/test/`. No edit to #3787's board files except the one wiring
  line after it merges.
- Harness design language, light and dark; Trello-like (a column of titled cards on a tinted panel). Desktop tests use a memory
  store and a fake sign-in. docs/windows-rules.md: the panel starts no process.
- No fixed sleeps in tests; a screenshot test per theme.

## Design

- growth: N/A because nothing is stored; the panel reads the held thread, newest page only, and a person's own `loadMessages`
  older-page button is not added.
- concurrency: a comment is one `message.send` under the controller's pending-command lock; a second post waits for the first.
- read cost: `loadGroup` and `loadMessages` for the one task; no step threads are read, only the step rows already in the Swarm.
- scale: a task with hundreds of comments shows the newest 50 with a count of the rest.
- compatibility: an older backend that sends no `task`, steps or `liveness` shows the brief text alone and no steps, never an
  error.
- migration + rollback: N/A because nothing is stored; removing the one wiring line removes the panel.
- audience: the server enforces it; `superTabGroupReadable` is checked, so a task the reader may not read shows nothing, and
  the comment box shows only to a person who `canWrite`.
- identity: a comment is posted as the signed-in person, never the machine owner's login.
- failure: a refused or unanswered post keeps the text in the box and says so; a task that is not there says so.
- platforms: Flutter desktop and web; no process, path or window.

## Review Focus

- A comment goes to the task's conversation and not to the selected one.
- A task the reader may not read, or one that does not exist, shows no brief or thread.
- Light and dark colours come from tokens, never frozen.

## Task 1: panel shell, brief and checks

**Files:** `desktop/lib/super_tabs/board/card_panel.dart` (new), `desktop/test/super_tab_card_panel_test.dart` (new).

**Interfaces:** `class CardPanel extends StatefulWidget { CardPanel({required SuperTabController controller, required String taskId, required VoidCallback onClose, SuperTabPullRequestFacts? facts}) }`.

- [ ] Failing test: a task with a number, priority, goal, changes, constraints and two checks shows each, with the status chip
  (`superTabCardStatus`) and each check's `superTabCheckLabel`; a close button calls `onClose`.
- [ ] Watch it fail (no `CardPanel`). Commit.
- [ ] Build the header and the brief sections. Commit.
- [ ] Failing test: a task the reader may not read, or one that does not exist, shows "This task is not available" and none of its text.
- [ ] Guard on `superTabGroupReadable`. Commit.

## Task 2: steps with verdict chips, pull request and CI

**Files:** the same two.

- [ ] Failing test: a task with a review step (Reviewer, passed check at a head) and a test step (not verified) shows each step's
  name, agent, status and verdict chip; the task's pull request shows its number, state and CI counts from the facts.
- [ ] Build the Steps and Pull request sections from `superTabStepsOf`, `superTabCheckLabel` and `SuperTabPullRequestEntry`
  (`label`, `checksLabel`), watching and unwatching the facts. Commit.

## Task 3: comments and the comment box

**Files:** the same two.

- [ ] Failing test: the task thread's person and agent messages show with the author's name and time, in order, system rows not
  among them; typing a comment and pressing Post sends a `message.send` to the task's conversation (the fake server records it),
  the box empties, and the comment shows; a refused post keeps the text.
- [ ] Failing test: a viewer who cannot write sees no box.
- [ ] Build the thread list and the box (`controller.command`). Commit.

## Task 4: history

**Files:** the same two.

- [ ] Failing test: the thread's system rows (assignments, status moves, pull request links) show as a history, newest first,
  each with its time, apart from the comments; a task with none says "No moves recorded yet."
- [ ] Build the History section. Commit.

## Task 5: light and dark screenshots

**Files:** `desktop/test/super_tab_card_panel_test.dart`.

- [ ] A screenshot test per theme of a full task (brief, steps, PR, comments, history), written when
  `HARNESS_CARD_PANEL_CAPTURE_DIR` is set; checks no overflow at 440 px wide.
- [ ] Red/green evidence and the PNGs in the pull request and the task thread.
