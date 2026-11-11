# Swarm sidebar: a project's tasks in foldable groups — Implementation Plan

> **For agentic workers:** this plan is carried out by the task's Engineer, task by task, test first, as the project's
> instructions (Engineer role) say. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under each expanded project, the open tasks are listed in four foldable groups, in this order: Needs you,
Working, Waiting on others, The rest. Each heading has a count, The rest starts folded, and each group's fold is
remembered per project the way Closed is.

**Architecture:** A pure function sorts each open task into its group, using what the row already shows: the reader's
tags, the task's liveness (`waiting` on whom, `quiet`, `orphaned`), its assignment status, and the view's
`needsHuman`. `ProjectSidebar._workgroups` draws a heading row per non-empty group, then that group's rows newest first.
This replaces the "8 newest, then … N more" list (`_NewestConversations`). The controller keeps each fold in memory,
per project, like `closedOpenProjects`. `superTabSidebarOrder` lists tasks in the same group order, so
Option+Shift+Down/Up walks the sidebar top to bottom. The web app draws the same `ProjectSidebar`, so one change covers
Desktop and web.

**Tech Stack:** Flutter/Dart (desktop/, also built for the web), flutter_test.

**Spec:** Task #2309 brief (Super Tab conversation 315b5716849b495258977518), requested by phamngochuy.1989@gmail.com;
mockup in Huy's proposal thread (`▾ Needs you  1` headings above the existing two-line rows).

## Global Constraints

- PR body first line: "Requested by phamngochuy.1989@gmail.com through Harness."
- Out of scope: the project row, Buddy rows, Activity. Closed stays as it is.
- Harness design language. Headings are drawn like the Closed row: muted text, a chevron, 36 px minimum height. They
  are not `SuperTabSectionHeading`s; those are the sidebar's sections.
- Keyboard: each heading is a focusable button (Tab reaches it), and Enter or Space toggles its fold.
- Desktop tests use a memory store and a fake sign-in. Temp files go only in mktemp -d folders.

## Groups (the rule, in order; the first that applies wins)

1. **Needs you**: the reader is tagged in it (`attention.mentionsIn > 0`); or its liveness is `waiting`/`person` on the
   reader, or on no one named; or, with no liveness, `needsHuman > 0` (a question in its agent's terminal).
2. **Waiting on others**: liveness `waiting` on another person, or on `review`, `revision`, `blocked` or `queued`;
   or `quiet`/`orphaned` (stuck: waits on the PM).
3. **Working**: liveness `waiting`/`starting`; or no liveness and assignment status `working` or `planned`.
4. **The rest**: everything else (no work, finished but still open, unknown states).

## Review Focus

- The open conversation sits in a folded group: its row still shows under that heading, so the reader never loses it.
- With the unread filter on, groups list only the rows the filter keeps, counts count those rows, and a group left
  empty has no heading.
- A project with no open tasks still reads "No workgroups yet", with no headings.
- Folding a group in one project leaves the same group in another project as it was. Collapsing and expanding the
  project keeps the fold.
- A task changing state (Working to Waiting on others) moves under its new heading on the next state read, with no
  stale fold.

---

### Task 1: Which group a task is in

**Files:**
- Create: `desktop/lib/super_tabs/task_groups.dart`
- Test: `desktop/test/super_tab_task_groups_test.dart`

**Interfaces:**
- Produces: `enum SuperTabTaskGroup { needsYou, working, waitingOnOthers, rest }` with a `label` getter
  (`'Needs you'`, `'Working'`, `'Waiting on others'`, `'The rest'`), declared in display order, and
  `bool get foldedByDefault` (true only for `rest`).
- Produces: `SuperTabTaskGroup superTabTaskGroupOf(SuperTabConversation group, {required String readerId, int mentions = 0, int needsHuman = 0})`.

- [ ] **Step 1: Failing tests**, one per rule line above: tagged → needsYou; waiting/person on `readerId` → needsYou,
  on no one → needsYou, on `'other'` → waitingOnOthers; review/revision/blocked/queued → waitingOnOthers;
  quiet and orphaned → waitingOnOthers; starting → working; working/planned with no liveness → working;
  `needsHuman: 1` with no liveness → needsYou; `needsHuman: 1` with a person wait on `'other'` → waitingOnOthers;
  no assignment → rest; done → rest; a tag beats a wait on another person (needsYou).
- [ ] **Step 2:** `flutter test test/super_tab_task_groups_test.dart`: fails (no such library).
- [ ] **Step 3:** Implement `task_groups.dart`.
- [ ] **Step 4:** Tests pass. Commit the tests first, then the code.

### Task 2: The sidebar draws the groups

**Files:**
- Modify: `desktop/lib/super_tabs/project_sidebar.dart` (`_workgroups`, remove `_NewestConversations` and `_moreRow`,
  add `_taskGroupHeading`, `superTabOpenWorkgroups` unchanged)
- Modify: `desktop/lib/super_tabs/controller.dart` (fold memory, beside `closedOpenProjects`)
- Test: `desktop/test/super_tab_task_groups_test.dart`; update the tests that relied on "… N more" or on a
  no-work task being listed while The rest starts folded.

**Interfaces:**
- Consumes: Task 1.
- Produces: `bool SuperTabController.taskGroupFolded(String projectId, SuperTabTaskGroup group)` and
  `void toggleTaskGroup(String projectId, SuperTabTaskGroup group)` (in memory, not saved, like `toggleClosed`).
- Keys: heading `super-task-group-<projectId>-<group.name>`; rows keep `super-group-<id>`.

- [ ] **Step 1: Failing widget tests** (1300×1600, `pmChatSwarm`-style fixture with one task per group, plus two in Working):
  - Headings in order `Needs you`, `Working`, `Waiting on others`, `The rest`, each with its count (`1`, `2`, `1`, `1`).
    Each task's row sits between its heading and the next one, and the two Working rows are newest first.
  - The rest starts folded: its heading shows and its row doesn't. A tap shows it, and a second tap hides it.
  - Folding Working in project A leaves project B's Working open. Collapsing and expanding A keeps Working folded.
  - The open conversation in a folded The rest still shows under its heading.
  - Unread filter on: only unread rows are listed; counts are of those rows; a group with none has no heading.
  - Tab from the project row reaches the first heading, and Enter folds it.
  - A phone-width (390 px) layout, as the web app draws it on a phone, shows the same headings.
- [ ] **Step 2:** Run: fails (no headings).
- [ ] **Step 3:** Implement. Group `superTabOpenWorkgroups(...).where(_keptByFilter)` by `superTabTaskGroupOf`, using
  `controller.accountId`, `attention?.mentionsIn` and `needsHuman`. For each non-empty group, draw a heading (chevron
  in the icon column, label, count; `Semantics(button, expanded)`), then its rows. A folded group shows only the open
  conversation's row, if it is in that group.
- [ ] **Step 4:** Run the new tests and the whole `test/super_tab_*` suite. Update the tests that assumed the old
  list, each with its reason in the commit.
- [ ] **Step 5:** Commit the tests, then the code.

### Task 3: Option+Shift+Down/Up follows the groups

**Files:**
- Modify: `desktop/lib/super_tabs/project_sidebar.dart` (`superTabSidebarOrder`)
- Modify: `desktop/lib/super_tabs/view.dart` (`_jumpUnread` passes `needsHuman`)
- Test: `desktop/test/super_tab_task_groups_test.dart`

**Interfaces:**
- Produces: `List<String> superTabSidebarOrder(SuperTabController controller, {int Function(SuperTabConversation)? needsHuman})`.
  Each project's chat comes first, then its tasks in group order, each group newest first; tags are read with
  `SuperTabAttention.of(controller)`.

- [ ] **Step 1: Failing test:** with one task per group, the order is
  `[lead, needsYou-task, working-task, waiting-task, rest-task]`, whatever their numbers.
- [ ] **Step 2:** Fails (newest-first order).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Passes; `test/super_tab_activity_test.dart` still passes. Commit the test, then the code.

### Task 4: Pictures for Huy

- [ ] Add the groups to `test/super_tab_sidebar_shots_test.dart` (written only with `SUPER_TAB_SIDEBAR_SHOTS`), at
  desktop width and at phone width, light and dark. Attach the pictures to the PR, along with red/green evidence and
  the full Desktop test run.
