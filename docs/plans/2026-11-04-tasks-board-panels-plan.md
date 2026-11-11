# Tasks board looks finished Implementation Plan

> Implemented by the task's Engineer task by task, each failing test committed before its code (project instructions,
> Engineer). One independent review on the pull request.

**Goal:** A project's Tasks Board reads as a finished board (task #2948, Huy, 2026-11-04): each column a neutral panel
with its name and count, each task an inset tile with up to three lines of title, an empty column saying No tasks, a
hover like a list row, and the task the reader had open shown selected. Desktop and web; drag and drop between columns
stays out.

**Architecture:** `_boardView` (desktop/lib/super_tabs/tasks_view.dart) lays the five columns in a horizontal scroll
view, each a fixed 280-point `DecoratedBox` of `AppCard.base` with an `AppCard.hair` rim at `AppCard.radius` (12), no
shadow; its heading keeps the name and count. A column with no cards shows `No tasks` in `DesktopChrome.metadata()`.
`SuperTabTaskCard` (task_card.dart) gains `tile` and `selected`: on the Board it is a tile of `AppCard.inset` with an
`AppCard.insetHair` rim at `AppCard.insetRadius` (8, concentric inside 12), title up to 3 lines; hover is
`AppSurface.hoverFill` as on list rows, and `selected` lays `AppSurface.selectedFill` over it (the sidebar's selected
row) and says Selected to a screen reader. The List keeps its rows, and shows the same selected fill. The view takes
`selectedId`: `SuperTabView` (view.dart) remembers the task last opened from the board, or the task chat the board was
opened from, and passes it in.

**Tech Stack:** Flutter (Desktop and web share this code), flutter_test widget tests with the Super Tab fixture's memory
store and fake sign-in.

**Spec:** task #2948's brief and the ASCII mockup sent to Huy in the task's chat. No stored data changes.

## Global Constraints

- Within desktop/design/desktop-design-system.md: concentric corners (12 outside, 8 inside), no shadows (floating
  content only), no new colored chips, color never the only signal (Needs you keeps its word, selection its fill and
  its semantics).
- Red first: each behavior below has a widget test committed failing before its code.
- Next up keeps its reorder (drag inside the column, ⌥↑ and ⌥↓); no drag between columns is added.
- No test signs the real CLI out: the fixture's `ConversationServer` only.
- Light and dark screenshots offscreen (`SUPER_TAB_TASKS_SHOTS`) for Huy before merge. Phone later.

## Design

- growth: N/A because nothing is stored; the selected task is view state, gone with the view.
- concurrency: N/A because it is UI state on the main isolate.
- read cost: N/A because no read is added; the board reads what the controller holds, as today.
- scale: a fixed column width scrolls sideways, so five columns fit any window; each column scrolls its own cards.
- compatibility: N/A because no wire or saved format changes.
- migration + rollback: N/A because nothing is stored; revert the commit.
- audience: N/A because the board shows what the reader may already read.
- identity: N/A because no login is used.
- failure: N/A because no new request is made; an empty column says so instead of showing blank.
- platforms: macOS, Linux, Windows and web (shared Flutter code).

## Review Focus

- The horizontal scroll and Next up's `ReorderableListView` inside it: a drag in Next up still reorders, a drop on
  another column still goes back.
- Selected versus keyboard focus: the selected fill is the sidebar's, not the blue keyboard selection.
- The List view: rows unchanged except for the selected fill.

## Task 1: columns are panels of a fixed width that scroll sideways

**Files:** desktop/lib/super_tabs/tasks_view.dart, desktop/test/super_tab_tasks_view_test.dart

**Interfaces:** `super-tasks-column-NAME` is the panel; `SuperTabTasksView.columnWidth` (280).

- [ ] Test: each column is 280 wide, drawn as an `AppCard.base` box with a hairline rim at radius 12 and no shadow;
  its heading shows its name and count.
- [ ] Test: at a window narrower than five columns, Shipped is off screen and is reached by scrolling sideways.
- [ ] Run the test, see it fail; commit.
- [ ] Build the panels and the horizontal scroll; the existing board, drag and List tests pass; commit.

## Task 2: tasks are inset tiles with up to three lines of title

**Files:** desktop/lib/super_tabs/task_card.dart, desktop/lib/super_tabs/tasks_view.dart,
desktop/test/super_tab_tasks_view_test.dart

**Interfaces:** `SuperTabTaskCard(tile: true)`.

- [ ] Test: a long title on the Board shows three lines (and is cut after them); in List it stays one line.
- [ ] Test: a Board card is an `AppCard.inset` tile at radius 8 with no shadow.
- [ ] Run, see it fail; commit. Build; commit.

## Task 3: an empty column says No tasks

**Files:** desktop/lib/super_tabs/tasks_view.dart, desktop/test/super_tab_tasks_view_test.dart

- [ ] Test: the Working column with no task shows `No tasks` in the caption style; a column with cards does not.
- [ ] Run, see it fail; commit. Build; commit.

## Task 4: the open task is selected

**Files:** desktop/lib/super_tabs/task_card.dart, desktop/lib/super_tabs/tasks_view.dart,
desktop/lib/super_tabs/view.dart, desktop/test/super_tab_tasks_view_test.dart

**Interfaces:** `SuperTabTasksView.selectedId`; `SuperTabTaskCard.selected`.

- [ ] Test: with `selectedId` naming a task, its card has the selected fill and says Selected; the others do not.
- [ ] Test (SuperTabView): open a task from the Board, come back to Tasks, and its card is selected.
- [ ] Run, see it fail; commit. Build; commit.

## Task 5: screenshots for Huy

**Files:** desktop/test/super_tab_tasks_shots_test.dart

- [ ] Light and dark of a full board with a selected task and an empty column, and List, written with
  `SUPER_TAB_TASKS_SHOTS`; posted in the task's chat and the pull request.
