# Quiet Swarm polish pass Implementation Plan

> Worked by the project instructions (Engineer, revision 27): each plan task commits its failing test, then its code. No subagents; one Review on the pull request.

**Goal:** Every Quiet Swarm screen matches its design, with before/after browser screenshots for Dee's morning look.

**Architecture:** Small fixes in `desktop/lib/super_tabs`, found by walking a no-login browser build (`desktop/tool/super_tab_quiet_review.dart`) on made-up data. No new colors, icons or controls.

**Tech Stack:** Flutter, widget tests with a memory store and a fake sign-in, a headless browser for pictures.

**Spec:** `docs/plans/2026-11-02-quiet-swarm-design.md`, `desktop/design/desktop-design-system.md`.

## Global Constraints

- PR body starts: Requested by dee@autonomous.ai through Harness.
- No new colors, icons or controls; fewer words; nothing removed without a home.
- Desktop tests use a memory store and a fake sign-in; never a test that signs this Mac out of the real CLI.
- Swarm code stays out of `cli/src/core`. Owns `desktop/lib/super_tabs` and its tests only.

## Review Focus

- Older agent in a project chat with no coordinator: Open terminal shows that agent, and group terminals still show the coordinator alone.
- A project row that is both private and mentioned: the number and lock still fit on one line.
- A long task name beside its word, wide and narrow.
- Activity at midnight and across days: a row's time reads as the chat's does.
- Members open when moving to Activity, Manage or Buddy: it can still close.

---

### Task 1: Project rows say one thing

**Files:** Modify `project_sidebar.dart`. Test `desktop/test/super_tab_quiet_polish_test.dart` (new).

- [ ] Failing tests: a project waiting on a person shows no `?` (Activity holds it); a task's row keeps it; a project's red number ends where Activity's does.
- [ ] Implement, tests pass, commit test first, then code.

### Task 2: The header has only what its screen needs

**Files:** Modify `view.dart`.

- [ ] Failing tests: Manage's title is plain text, not the project menu; no Members button on Activity, Manage or the one Buddy; the one Buddy's title reads Buddy and its header has no Chat or Pull requests.
- [ ] Implement, commit test first, then code.

### Task 3: A task's name lines up with messages

**Files:** Modify `task_line.dart`.

- [ ] Failing test: a task line's name starts where a message's text does; a proposal's too.
- [ ] Implement with the avatar column's width for the mark. Commit test first, then code.

### Task 4: Activity reads like the chat

**Files:** Modify `activity_view.dart`.

- [ ] Failing tests: marks are the app's icons, as task lines' are; today's time reads as the chat's (8:09 PM); a heading sits nearer its rows than the section above; hovering a thread shows Unfollow, and pressing it unfollows.
- [ ] Implement, commit test first, then code.

### Task 5: A thread's pane lines up with the chat

**Files:** Modify `thread_panel.dart`, `task_line.dart`.

- [ ] Failing tests: the header's rule meets the chat's; its reply box has the composer's margin.
- [ ] Implement, commit test first, then code.

### Task 6: Manage starts where its heading does

**Files:** Modify `manage_page.dart`, `view.dart` if the page's column centres the tabs.

- [ ] Failing tests: tabs start under the heading; Swarm's facts and foot actions share one left and right edge with the Machines rows.
- [ ] Implement, commit test first, then code.

### Task 7: Open terminal opens that agent

**Files:** Modify `controller.dart`.

- [ ] Failing test: an older agent held only in a project chat gets its own pane from `selectTerminal`; group terminals stay the coordinator's.
- [ ] Implement, commit test first, then code.

### Task 8: Pictures and suites

- [ ] Screens in light from the browser build, before and after, in the PR. Web top bar checked from `tool/web_ux_fixture.dart`.
- [ ] `flutter test test/super_tab_*_test.dart`, `check-ui-style`, `laid_out_list_test`; list what is left and why.
