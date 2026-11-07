# v3 Desktop polish from the audit implementation plan

> Implemented natively, plan task by plan task, each failing test committed before its code; one independent review of
> the pull request. No execution handoff: the Engineer implements it.

**Goal:** Fix the eight Desktop findings task #4251 takes from the v3 audit (#4211: 5, 6, 8, 10, 12, 13, 14, 15) so
the Board fits, every agent has one face, small windows keep a usable middle, and the empty and personal moments feel
good.

**Architecture:** Each finding is a local change in `desktop/lib/super_tabs/`, tested through the widget a person sees
(widget tests with a memory store and fake sign-in). The four plan tasks touch disjoint files and run in parallel.

**Tech Stack:** Flutter/Dart, the existing Super Tab widgets and fixtures, `test/support/capture.dart` for light and
dark pictures.

**Spec:** the findings as posted in task #4211 (Auditdesk, 2026-11-07), and the brief of task #4251.

## Global Constraints

- Owns `desktop/lib/super_tabs/` only; no backend, contract or data change.
- Verify each finding on main first; a finding that does not reproduce says why in the pull request.
- Test first: each test fails on main and passes with the change; the commit history shows the order.
- Light and dark pictures of every changed screen, through `HARNESS_SUPER_TAB_CAPTURE`.
- Follow the desktop design system; names and copy per docs/naming-system.md; no new setting or switch.
- Never read or print a secret or a login; tests use the memory store and a fake sign-in.
- macOS, Linux and Windows share these widgets; nothing here starts a process.

## Review Focus

- Board at 1500 px with Proposal empty and many Shipped: no column cut mid-word at rest, and hidden columns are named.
- A column that fills while it is collapsed opens again at once (no stale slim lane).
- At the 880 px window minimum the middle keeps at least one whole Board column and the Tasks pane stays usable.
- @ in a shared project chat still offers people; only an agent's own private chat drops them.
- Leaderboard "You" follows the signed-in account after an org or account switch, never a name match.

## Design

N/A because nothing is stored, synced or exposed: each change reads the snapshot the widget already holds.

---

### Task 1: Board fits the middle (findings 5 and 13)

**Files:**
- Modify: `desktop/lib/super_tabs/tasks_view.dart` (`_boardView`, `_panel`, `_card`)
- Modify: `desktop/lib/super_tabs/task_card.dart` (`_mark`)
- Test: `desktop/test/super_tab_board_fit_test.dart`, shots in `desktop/test/super_tab_board_fit_shots_test.dart`

**Interfaces:**
- Produces: `SuperTabTasksView.slimColumnWidth` (an empty column's width); `SuperTabTaskCard.markLabel` (String?, the
  mark's tooltip).

- [ ] Write the failing test: an empty column draws as a slim lane (its name and 0, no "No tasks" panel) of
      `slimColumnWidth`; with the middle 860 wide, every column that starts on screen ends on screen (whole columns at
      rest), and a pill at the edge names the columns out of view with their counts and scrolls them in when pressed.
- [ ] Write the failing test: a card in review shows its mark with the tooltip "In review"; other states name theirs
      ("Waiting on a person", "Working", "Queued", "Blocked or agent lost", "Shipped", "Failed").
- [ ] Run them on main and watch them fail; commit the tests.
- [ ] Implement: empty columns become slim lanes; the rest share what is left, never under `minColumnWidth`, and when
      they overflow their width rounds so a whole number fits; the edge pill; the card mark's tooltip.
- [ ] Run the new tests and `test/super_tab_board_layout_test.dart`, `test/super_tab_board_cards_test.dart`,
      `test/super_tab_tasks_view_test.dart`; commit; light and dark pictures at 1500×860.

### Task 2: One face per agent, @ in a private chat (findings 6 and 12)

**Files:**
- Modify: `desktop/lib/super_tabs/buddy_rows.dart` (`SuperTabBuddyRow` takes the agent), `project_sidebar.dart`
  (`_agentRow` passes it)
- Modify: `desktop/lib/super_tabs/composer_tags.dart` (`superTabTagChoices`)
- Test: `desktop/test/super_tab_agent_face_test.dart`, `desktop/test/super_tab_private_mention_test.dart`

**Interfaces:**
- Produces: `SuperTabBuddyRow.agent` (SuperTabAgent?): when set, the row draws `SuperTabAvatar.agent` (its picture or
  pattern, no engine badge), the same face the chat, cards and Tasks pane draw.

- [ ] Write the failing test: an agent in My agents draws the same `SuperTabAvatarFace` (picture and pattern) as its
      chat's message avatar, not an initial.
- [ ] Write the failing test: in an agent's own chat (the conversation its `chatId` names) @ offers that agent and no
      people; in a project chat it still offers people, by display name.
- [ ] Run them on main and watch them fail; commit the tests.
- [ ] Implement both; run the new tests and the existing `super_tab_completions_test.dart`, `super_tab_avatar_test.dart`
      and sidebar tests; commit; light and dark pictures of the left pane and the @ list.

### Task 3: Small windows and the reject dialog (findings 8 and 10)

**Files:**
- Modify: `desktop/lib/super_tabs/pane_layout.dart` (a Board-layout middle minimum), `view.dart` (the Tasks pane's
  minimum becomes `rightWidth`)
- Modify: `desktop/lib/super_tabs/tasks/personal_tasks_pane.dart` (reject dialog, suggested-agent picker)
- Test: `desktop/test/super_tab_pane_minimums_test.dart`, `desktop/test/super_tab_reject_dialog_test.dart`

**Interfaces:**
- Produces: `SuperTabPaneLayout.boardCenterWidth` (560): what the Board layout's middle keeps before the side panes
  give back; the left pane gives back first (to 180), then the Tasks pane (340 to 280).

- [ ] Write the failing test: Board layout at 1100 and 900 (and the 880 window minimum): the middle is at least
      `boardCenterWidth` while the sides can give, the left pane narrows before the Tasks pane, and the Tasks pane is
      never under 280; at 1500 the sides keep 300 and 340.
- [ ] Write the failing test: Reject's dialog title names the task ("Reject “Add the project export”?") and the
      suggested-agent picker uses the row's text style.
- [ ] Run them on main and watch them fail; commit the tests.
- [ ] Implement both; run the new tests and `super_tab_pane_layout*`, `super_tab_personal_tasks*` tests; commit; light
      and dark pictures at 900 wide and of the dialog.

### Task 4: An empty Decisions that feels like a win, and you on the Leaderboard (findings 14 and 15)

**Files:**
- Modify: `desktop/lib/super_tabs/decisions_page.dart` (its empty state)
- Modify: `desktop/lib/super_tabs/leaderboard/person_row.dart`, `leaderboard/weekly_page.dart`,
  `leaderboard/format.dart` as needed
- Test: `desktop/test/super_tab_decisions_empty_test.dart`, `desktop/test/super_tab_leaderboard_you_test.dart`

- [ ] Write the failing test: with nothing to decide, Decisions shows a centred all-clear ("All clear" and "Your crew
      has what it needs") with how many tasks are moving, in place of the small line at the top.
- [ ] Write the failing test: the signed-in person's Leaderboard row is highlighted and says "You"; a zero streak
      reads "–", not "0d"; ranks 2 and 3 carry a medal mark as rank 1 carries its trophy.
- [ ] Run them on main and watch them fail; commit the tests.
- [ ] Implement both; run the new tests and the existing decisions and leaderboard tests; commit; light and dark
      pictures of both pages.
