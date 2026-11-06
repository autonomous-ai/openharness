# Manage drops the Backlog view Implementation Plan

> Worked by this project's Engineer flow: the plan is the pull request's first commit, then each task's failing test
> before its code, one review on the pull request.

**Goal:** Desktop Manage no longer has a Backlog tab; the team works from the project's Board (task #3885, Scholes).

**Architecture:** Remove the `backlog` value of `SuperTabManageTab`, its pill, its page case and `SuperTabBacklogView`
(`backlog_view.dart`). Remove what only that view used: `SuperTabBacklogGroup`, `superTabBacklogGroupOf`,
`superTabBacklogTasks` (`backlog.dart`), and the controller's `syncedAt` and `closedShippedFailed`. Everything the Board,
the sidebar and the pulse strip share in `backlog.dart` (priority, shipped, releasing, project tasks, the 7-day shipped
window) stays. No other screen opens the Backlog, so no link needs to move to the Board.

**Tech Stack:** Flutter (Desktop), flutter_test widget tests with the memory store and fake sign-in already used by
`super_tab_manage_page_test.dart`.

**Spec:** task #3885's brief.

## Global Constraints

- No change to the Board or the other Manage tabs.
- Desktop tests use a memory store and a fake sign-in.
- Light and dark: the remaining tabs are unchanged; no new screen.

## Review Focus

- The Board still lists closed tasks shipped in the last 7 days: `readClosedShipped` and `closedShipped` stay, as
  `tasks_view.dart` and `task_groups.dart` read them.
- Devices still falls back to Machines where the build has no devices pane (view.dart), unaffected by the enum change.

---

### Task 1: Manage has no Backlog tab

**Files:**
- Modify: `desktop/lib/super_tabs/manage_page.dart`, `desktop/lib/super_tabs/backlog.dart`,
  `desktop/lib/super_tabs/controller.dart`
- Delete: `desktop/lib/super_tabs/backlog_view.dart`, `desktop/test/super_tab_backlog_test.dart`,
  `desktop/test/super_tab_backlog_shots_test.dart`
- Test: `desktop/test/super_tab_manage_page_test.dart`; trim the Backlog parts of `super_tab_releasing_test.dart`,
  `super_tab_releasing_shots_test.dart`, `super_tab_task_priority_test.dart`

**Interfaces:**
- Produces: `enum SuperTabManageTab { machines, models, devices, swarm, scorecard }`; `SuperTabManagePage` without
  `onOpenConversation` and `facts`.

- [ ] **Step 1: Write the failing test** `'no Backlog tab: the Board shows the work'` in
  `super_tab_manage_page_test.dart`: `find.text('Backlog')` finds nothing, `SuperTabManageTab.values.map((t) => t.name)`
  does not contain `'backlog'`, and the four tabs (Machines, Models, Devices, Swarm) and Scorecard still show.
- [ ] **Step 2: Run it to see it fail**: `flutter test test/super_tab_manage_page_test.dart`, FAIL on `Backlog`.
- [ ] **Step 3: Commit the failing test.**
- [ ] **Step 4: Remove the tab, its view, its tests and the code only they used** (Architecture above).
- [ ] **Step 5: Run the touched tests**: `flutter analyze` on the touched files, then
  `flutter test test/super_tab_manage_page_test.dart test/super_tab_releasing_test.dart
  test/super_tab_releasing_shots_test.dart test/super_tab_task_priority_test.dart test/super_tab_tasks_view_test.dart`,
  all pass.
- [ ] **Step 6: Commit and push.**
