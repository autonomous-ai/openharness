# The project board replaces the project chat — plan (task #3787)

**Goal:** Opening a project on Desktop shows its Board by default; the Board looks and feels like Trello; the left
pane has no Buddy entry under Projects; the right pane is the person's Buddy chat instead of the Thread panel (a thread
still opens from a card or a mention); the left and right panes hide and show, remembered. anh Dee's scope cut of
11-06: no redesign, same columns and data. The design doc stays as the record of where this goes next.

**Architecture:** The Swarm view already has the Board (`SuperTabTasksView`: Proposals, Next up, Working, Waiting,
Shipped) behind the header's Tasks button. Selecting a project now opens it instead of the project chat. The cards and
columns get Trello's look in `task_card.dart` and `tasks_view.dart` (softer column backgrounds, roomier rounded cards,
title first then one small lane/priority/person line, smooth scroll); data and placement are unchanged. The right pane,
where the Thread panel sits, shows the Buddy's chat when no thread is open; opening a thread shows it there as today,
and closing it returns to the Buddy. Two local booleans remember the hidden panes.

**Tech Stack:** Flutter 3.47 (Desktop), `flutter_test` widget tests with `ConversationServer` (memory store, fake
sign-in), screenshot captures with `HARNESS_SUPER_TAB_CAPTURE`.

**Spec:** River's brief on task #3787 as cut by anh Dee (11-06, 13:3x): items 1 to 5; the card panel, the ruling and
the banner are cancelled.

This plan is written and carried out by its Engineer, test first; the Board's look runs as a parallel subagent in its
own files; there is no execution handoff.

## Design

N/A beyond two local booleans (left and right pane hidden) in the existing local store: no new server reads, no data,
no migration; older clients are unaffected (the project chat stays on the server).

## Global Constraints

- Same columns, data and placement as today's Board.
- Harness design language (`scripts/check-ui-style.py`), light and dark.
- Desktop tests use a memory store and a fake sign-in. No new process starts (Windows: no window flash).

## Review Focus

- Selecting a project shows its Board, never the project chat; the Buddy chat on the right keeps working.
- A card or a mention still opens its thread; closing it returns to the Buddy.
- Hide/show state survives a new view.

## Tasks

### 1. A project opens its Board (`view.dart`)

- [ ] Failing test: tapping a project row shows `super-tasks-board` and no project chat.
- [ ] Code.

### 2. The Board looks like Trello (`task_card.dart`, `tasks_view.dart`; parallel)

- [ ] Screenshot test of the Board, light and dark; widget tests unchanged in behaviour.
- [ ] Code.

### 3. No Buddy entry under Projects (`project_sidebar.dart`)

- [ ] Failing test: the left pane lists no Buddy row or Buddies section.
- [ ] Code.

### 4. The Buddy chat on the right (`view.dart`)

- [ ] Failing test: with no thread open, the right pane shows the Buddy chat; a card or a mention opens its thread
      there; closing it shows the Buddy again.
- [ ] Code.

### 5. Hide and show the side panes (`view.dart`)

- [ ] Failing test: each pane's icon hides and shows it, and a new view starts as it was left.
- [ ] Code. Light and dark screenshots of the three panes.
