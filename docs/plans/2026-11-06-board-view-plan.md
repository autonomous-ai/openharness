# The project board replaces the project chat — plan (task #3787)

**Goal:** Desktop shows three panes: the left rail (Swarms, projects, Decisions, Mentions, Threads), the selected
project's board in the middle (Proposed, To do, Doing, Review, Shipped), and the person's Buddy chat on the right. The
board replaces the project chat. Both side panes hide and show, remembered. Then: a card side panel, the PM's ruling on
proposals and a release banner. Design: `docs/plans/2026-11-06-board-view-design.md`.

**Architecture:** The Swarm view already has a Tasks board (`SuperTabTasksView`, `task_groups.dart` columns and
placement, `task_card.dart`), fed by the live conversations, the 7-day shipped read and the proposals read. The first
part reshapes it to the design's five columns and makes it the middle pane: selecting a project shows its board, and
the chat column on the right shows the person's Buddy chat (the selected conversation is the Buddy's), so the existing
chat view is reused whole. The second part adds three new widgets in their own files, built in parallel: the card
side panel (`task_panel.dart`), the proposal ruling (`proposal_ruling.dart`, on the commands the backend has), and
the banner (`board_banner.dart`, from the project's ship messages until the backend has release records).

**Tech Stack:** Flutter 3.47 (Desktop), `flutter_test` widget tests with `ConversationServer` (memory store, fake
sign-in), screenshot captures with `HARNESS_SUPER_TAB_CAPTURE`.

**Spec:** River's brief on task #3787 and anh Dee's order: first the board, the panes and the hide/show icons; then
the side panel, the ruling and the banner; released today.

This plan is written and carried out by its Engineer, test first; independent tasks run as parallel subagents, each
test first; there is no execution handoff.

## Design

The design doc's Design rules section stands. For this client change: no new stored data except two local booleans
(left rail and Buddy pane hidden), kept in the existing local store; no new server reads in part one (the board uses
the reads the Tasks view already makes); older clients keep the project chat (the server is unchanged).

## Global Constraints

- Cards move only from the task's real state; nobody drags them except the PM's ruling on Proposed.
- Harness design language (`scripts/check-ui-style.py`), light and dark.
- Desktop tests use a memory store and a fake sign-in. Windows: no new process starts (no window flash).
- Backend items marked "for Ken" in the design are not in this task.

## Review Focus

- A task sits in exactly one column, the one its state gives; blocked, needs a person, lost and stalled are badges.
- Selecting a project never shows the project chat on Desktop; the Buddy chat keeps working on the right.
- Hide/show state survives a restart.

## Tasks

### 1. Five columns (`task_groups.dart`, tasks view tests)

- [ ] Failing test: Proposed, To do, Doing, Review, Shipped; review and ready-to-merge go to Review; blocked and needs a
      person stay in Doing with a badge; releasing goes to Shipped.
- [ ] Code.

### 2. The board in the middle, the Buddy chat on the right (`view.dart`, `project_sidebar.dart`)

- [ ] Failing test: selecting a project shows its board (`super-tasks-board`) and no project chat; the right pane is the
      Buddy chat; the left rail has no Buddy entry.
- [ ] Code.

### 3. Hide and show the side panes (`view.dart`)

- [ ] Failing test: each pane's icon hides and shows it, and a new view starts as it was left.
- [ ] Code. Light and dark screenshots of the board, a card and the Buddy pane.

### 4. The card side panel (`task_panel.dart`, parallel)

- [ ] Failing test: a card opens a panel with the brief (goal, changes, constraints, checks), steps with verdicts, PRs,
      the task thread, and its history; it closes with Escape.
- [ ] Code; screenshots.

### 5. The PM's ruling on a proposal (`proposal_ruling.dart`, parallel)

- [ ] Failing test: a person with the PM's rights rules Accept, Later or No (with a reason) on a Proposed card, using the
      commands the backend has; others see no ruling.
- [ ] Code; screenshots.

### 6. The release banner (`board_banner.dart`, parallel)

- [ ] Failing test: the project's latest ship notice of the last day shows as a thin banner with a link, and hides
      after a day or when closed.
- [ ] Code; screenshots.
