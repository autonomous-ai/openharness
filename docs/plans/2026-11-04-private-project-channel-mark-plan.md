# Private Project Channel Mark Implementation Plan

> **For agentic workers:** The assigned Engineer implements this plan task by task in this session, test first. No subagents are needed for this small, connected UI change.

**Goal:** Show a private project's lock in the channel mark position wherever Desktop draws its project channel name, keeping the sidebar's right edge for notifications.

**Architecture:** Reuse the existing project privacy flag and `AppIcons.lock`. Keep `#` for public projects. Inline project channel labels that are currently strings use the same lock widget where an icon must appear; a composer hint keeps the project name without a textual `#`.

**Tech Stack:** Flutter, Dart, existing Super Tab widgets and widget tests.

**Spec:** Swarm task #2568, conversation 1458f891eef26458eb128229.

## Global Constraints

- Keep the change small and leave phone UI untouched.
- A private sidebar row has a leading lock, no trailing lock, and retains the “Private project” tooltip and screen-reader label.
- Public rows retain `#`; mention badges and muted bells remain at the right.
- Show light and dark sidebar screenshots with public and private projects and a mention badge.
- Use the Desktop memory store and fake sign-in in tests.
- Run Desktop `check-ui-style` and `laid_out_list_test` before Ready.
- List every changed project-label surface in the PR; first body line: `Requested by dee@autonomous.ai through Harness.`

## Review Focus

- Public projects must retain the existing `#` mark.
- Private projects must not retain a second lock at the row's trailing edge.
- Notification badges and muted bells must remain the only project-row trailing marks.
- Header, project menu, Activity, Buddy detail, and legacy Notifications/Decisions channel references must identify private projects with a lock.
- Accessibility labels and composer hints must still name the project clearly.

---

### Task 1: Private project channel marks

**Files:**
- Modify: `desktop/lib/super_tabs/project_sidebar.dart`
- Modify: `desktop/lib/super_tabs/view.dart`
- Modify: `desktop/lib/super_tabs/private_project_lock.dart`
- Modify: `desktop/lib/super_tabs/buddies.dart`
- Modify: `desktop/lib/super_tabs/activity.dart`
- Modify: `desktop/lib/super_tabs/activity_view.dart`
- Modify: `desktop/lib/super_tabs/decisions_view.dart` and `desktop/lib/super_tabs/notifications.dart`
- Test: `desktop/test/super_tab_sidebar_test.dart`, `desktop/test/super_tab_view_test.dart`, `desktop/test/super_tab_activity_view_test.dart`, `desktop/test/super_tab_buddies_test.dart`, `desktop/test/super_tab_private_legacy_channel_test.dart`, and `desktop/test/super_tab_quiet_polish_test.dart`
- Test: `desktop/test/super_tab_project_rows_shots_test.dart`

**Interfaces:**
- Consumes: `SuperTabProject.isPrivate`, `AppIcons.lock`, existing Desktop typography and row composition.
- Produces: visible private-project lock marks at the same position as public `#` marks; notification marks remain trailing.

- [x] Write failing widget tests for private leading lock/no trailing lock, public `#`, and right-side mention badge/muted bell.
- [x] Run the focused sidebar test and confirm the new assertions fail against the current placement.
- [x] Write failing view, Activity, Buddy, and legacy Notifications/Decisions tests for private channel marks; ensure the composer hint has no textual `#`.
- [x] Run the focused tests and confirm they fail because private project labels still use `#`.
- [x] Move the sidebar lock into the leading mark column, retaining its tooltip and semantics; remove the trailing lock.
- [x] Render lock marks for private labels in the header, project menu, Activity, Buddy detail, and legacy Notifications/Decisions; keep composer hint text descriptive.
- [x] Capture light and dark sidebar screenshots showing private and public rows with a mention badge.
- [x] Run focused private legacy-channel and quiet-polish widget tests, `check-ui-style`, and `laid_out_list_test`; record red/green evidence and screenshots in the PR.
- [x] Commit the implementation and tests.
