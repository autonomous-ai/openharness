# Quiet Swarm 1/6: sidebar, top bar and Manage Implementation Plan

> **Way of working:** by this project's instructions (Engineer role), not subagent-driven-development: each failing test committed and watched fail before its code, the branch pushed after each task, one independent review of the pull request. There is no Execution Handoff.

**Goal:** The design's sidebar, quieter top bar, Swarm switcher with only Swarms, and a Manage page holding Machines, Models, Devices and Swarm.

**Architecture:** The sidebar becomes a scrolling list with a Manage row pinned under it. Manage is a pane of the Swarm view, selected like Your devices is today and remembered by the controller. It hosts the existing machines list, models figures, devices view and delete and restore flows, each unchanged in what it does. The top bar drops Add Phone, Devices and the Store into the avatar menu, and tabs show names only.

**Tech Stack:** Flutter, `flutter_test`, in `desktop/`.

**Spec:** `docs/plans/2026-11-02-quiet-swarm-design.md`, screens 0, 1 (sidebar), 8, 10, 10b, 10c and 12. Task #2190 (Dee).

## Global Constraints

- The PR body starts with: Requested by dee@autonomous.ai through Harness.
- Build exactly the design's screens; anything it doesn't draw stays as it is.
- `desktop/design/desktop-design-system.md`: no new colors, icons or controls; one line per row; fewer words.
- The project-row red number is changed separately: its widget stays as it is.
- Desktop tests use a memory store and a fake sign-in; never a test that signs this Mac out of the real CLI.
- Swarm code stays out of `cli/src/core`. No on/off switch.
- Others build the other parts in parallel: stay in this task's files, and rebase on main often.
- Dee's look at the screenshots is the merge gate, never an acceptance check.

## Review Focus

- Every function that leaves a screen still has a way in: New project (the + beside Projects), Add Phone, Devices and the Store (avatar menu, and where a shortcut or the Harness menu already opens them), Delete and Restore (Manage › Swarm).
- A Personal Swarm, a viewer, and a member who doesn't own the Swarm each see the right Manage › Swarm: no Delete for a non-owner, no Leave for its owner or in Personal.
- The Threads row goes before part 4's Activity takes Threads in: said in the PR, so the two merge together or Threads stays reachable.
- A Swarm remembered as showing Devices or Manage opens there, and an account that lost it opens the chat.
- A Swarm with no Buddy yet, or a server without one Buddy for the Swarm, still has its Buddy row or Buddies section.
- Web on a phone keeps its compact bar: its Add Phone stays off, and the ☰ still opens the sidebar.

## Design

- **Growth, migration, audience, identity:** N/A because nothing new is stored on a server; Manage's choice is one more field in the tab's saved view, ignored by older builds.
- **Concurrency:** N/A because everything here runs on the UI thread and existing commands.
- **Read cost:** the machines list and models figures build only while Manage shows them, so their timers stop at rest, as the design asks.
- **Scale:** N/A because the lists are the ones shown today.
- **Compatibility:** a saved view from before opens as it did.
- **Failure:** delete, restore and leave keep their own errors, where they now show.
- **Platforms:** macOS, Linux, Windows and the web share this code; the title-bar variant keeps its own actions.

---

### Task 1: The sidebar

**Files:**
- Modify: `desktop/lib/super_tabs/project_sidebar.dart`, `desktop/lib/super_tabs/controller.dart` (`manageSelected`), `desktop/lib/super_tabs/view.dart` (its wiring only)
- Test: `desktop/test/super_tab_quiet_sidebar_test.dart`

**Interfaces:**
- Produces: `SuperTabController.manageSelected`, `openManage()`; `ProjectSidebar.onManage`, `manageSelected`.

- [ ] **Step 1: Write the failing tests:** Switcher, Activity, Buddy, Projects with +, the project rows, and Manage at the bottom, in that order; no New project, Your devices, Your models, Threads, Machines or Models row; + opens New project; Buddy opens the chat.
- [ ] **Step 2: Run to verify they fail.** Run: `flutter test test/super_tab_quiet_sidebar_test.dart`. Expected: FAIL.
- [ ] **Step 3: Implement.** A pinned Manage row under the list; the Buddy row moves above Projects.
- [ ] **Step 4: Run to verify they pass,** then the sidebar tests by the symbols changed.
- [ ] **Step 5: Commit** the test first, then the code; push.

### Task 2: The Manage page

**Files:**
- Create: `desktop/lib/super_tabs/manage_page.dart`
- Modify: `desktop/lib/super_tabs/machines.dart`, `desktop/lib/super_tabs/view.dart` (its pane)
- Test: `desktop/test/super_tab_manage_page_test.dart`

**Interfaces:**
- Consumes: `manageSelected`; `SuperTabMachines`, `leaderboardModelShares`, `showSwarmLocalModels`, the devices view, `DeletedSwarms`, the Swarm delete dialog, and `sharing.dart`'s leave.
- Produces: `SuperTabManagePage`, `SuperTabManageTab { machines, models, devices, swarm }`.

- [ ] **Step 1: Write the failing tests,** one per tab: Machines lists name, owner and status on one line, with Add machine; Models lists usage with Your models…; Devices shows the devices view; Swarm shows Name, Owner, People with Manage people, Delete Swarm… for its owner, Leave Swarm… for a member, restore rows.
- [ ] **Step 2: Run to verify they fail.** Run: `flutter test test/super_tab_manage_page_test.dart`. Expected: FAIL.
- [ ] **Step 3: Implement** the page, with `SuperTabMachines` given a one-line form.
- [ ] **Step 4: Run to verify they pass,** then `flutter test test/super_tab_machines_test.dart test/super_tab_devices_test.dart`.
- [ ] **Step 5: Commit** the test first, then the code; push.

### Task 3: The Swarm switcher holds only Swarms

**Files:**
- Modify: `desktop/lib/super_tabs/swarm_switcher.dart`
- Test: its own test file

- [ ] **Step 1: Write the failing test:** Personal, the Swarms, a line, New Swarm; no Delete or Restore row.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.** Delete and restore are reached from Manage › Swarm (Task 2).
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** the test first, then the code; push.

### Task 4: The top bar

**Files:**
- Modify: `desktop/lib/screens/swarm_screen.dart` (`_tabStrip`, `_showAccountMenu`), `desktop/lib/widgets/account_menu.dart`, `desktop/lib/widgets/desktop_workspace_tab.dart` if its count is there
- Test: `desktop/test/account_menu_test.dart` and the tab strip's test

**Interfaces:**
- Produces: `AccountMenuChoice.devices`, `.store`.

- [ ] **Step 1: Write the failing tests:** the bar has Search, Notifications and the avatar, and no Add Phone, Devices or Store; the avatar menu opens each; a tab shows its name alone, its ⌘ number only while ⌘ is held, no count, and is bold when something there needs you.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.** Keep the bar's width sums right, and the phone's compact bar as it is.
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Commit** the test first, then the code; push.

### Task 5: The narrow window, and screenshots

**Files:**
- Test: `desktop/test/super_tab_quiet_sidebar_test.dart`
- Create: the made-up-data screens for the browser build

- [ ] **Step 1: Write the failing test** for screen 12's ☰ where the window is narrow, if it isn't shown there yet; implement it if it isn't.
- [ ] **Step 2:** Capture screens 0, 1, 8, 10, 10b, 10c and 12 from a browser build on made-up data, and put them in the PR.
- [ ] **Step 3:** Run the Desktop tests affected, mark the PR ready and ask the Reviewer.
