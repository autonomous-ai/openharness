# Board card opens its task; the left pane lights one row: plan

Task #4441. Findings 1 and 5 of the Desktop 1.3.89 audit (#4436, `docs/audits/2026-11-07-desktop-1.3.89.md` on #3526).

**Goal:** clicking a Board card opens its task in the middle, as a Tasks card does; the left pane lights exactly one row,
the one for what the middle shows.

**Architecture:** both are in the Swarm view's navigation (`desktop/lib/super_tabs/view.dart`) and the left pane
(`project_sidebar.dart`). With the Tasks pane on the right, a Board card's chat has no place beside the Board, so the
card takes the Tasks card's path (`_openPersonalTask`). The left pane is told which project's Board the middle shows;
while one does, only that project's row is lit, and otherwise a chat chosen in My agents lights its agent's row and not
also its project's.

**Tech Stack:** Flutter widget tests with the in-memory conversation server and a fake sign-in.

**Spec:** the audit's findings 1 and 5 and their proposed tasks:
- 1: "Clicking a Board card shows the task under its header, as a Tasks card does; a widget test clicks a card and
  finds the task's chat."
- 5: "A Board lights its project row and not Buddy; a PM lights one row; tests for both."

This plan is implemented test first by its Engineer, task by task; the pull request's review is the one review.

## Global Constraints

- Desktop only; no server change.
- Reuse the existing middle chat (`_middleChat`), task header and row styles; no new widget.
- Tests use the memory store and a fake sign-in; nobody signs in.
- Shared Flutter code: the same on macOS, Windows and Linux.

## Review Focus

- The layout without the Tasks pane (an older backend) keeps a Board card's chat on the right.
- Every other way into a chat (a link, a notice, the Tasks pane, the Chat tab) still lights a row.

## Task 1: a Board card opens its task in the middle

**Files:** `desktop/lib/super_tabs/view.dart`; test `desktop/test/super_tab_board_navigation_test.dart`.

**Interfaces:** `_openTask(id)` goes to `_openPersonalTask(id)` while the Tasks pane holds the right.

- [ ] Test: in the v3 layout, tap the Board card of a task; the middle shows `super-middle-chat` with the task
      selected, and the Board's tabs are gone. Watch it fail (the Board stays).
- [ ] Code: `_openTask` takes the Tasks card's path when the Tasks pane is on the right.
- [ ] Run the new test and `super_tab_personal_tasks_middle_test.dart`.

## Task 2: the left pane lights one row

**Files:** `desktop/lib/super_tabs/project_sidebar.dart`, `desktop/lib/super_tabs/view.dart`; same test file.

**Interfaces:** `ProjectSidebar.boardProjectId`: the project whose Board the middle shows.

- [ ] Tests: clicking `# web-project` lights its row and not Buddy; clicking the PM Orion lights Orion's row and not
      `# web-project`. Watch both fail.
- [ ] Code: pass the Board's project to the left pane; with a Board shown, only its project row is lit; a chat that is
      one of My agents' lights that agent's row alone.
- [ ] Run the new tests and the left-pane tests (`super_tab_v3_left_shots_test.dart`, `super_tab_sidebar_pages_test.dart`,
      `super_tab_one_buddy_shots_test.dart`, `super_tab_workspace_test.dart`).
- [ ] Light and dark screenshots of both findings for the pull request.
