# Fixed project order implementation plan

> Implement natively, task by task with test-driven development and one independent pull request review.

**Goal:** Keep phone Home and Desktop/web projects alphabetically ordered despite new activity.
**Architecture:** Sort existing phone sections by case-insensitive project name, ignoring a leading #. Preserve explicit existing newest/unread opt-ins and section membership. Apply the same name comparison to Desktop rows and keyboard navigation, without changing their appearance.
**Tech Stack:** Dart, Flutter, flutter_test.
**Spec:** Swarm task #3353, conversation 045fdf04dee8ca86c98e72fd.

## Global Constraints

- Requested by dee through Harness.
- Preserve the current layout, bold names and unread dots; no backend or CLI changes.
- Use memory stores and fake sign-in; never sign the Mac out.
- Run affected phone and Desktop tests and check-ui-style before Ready; CI supplies full component suites.
- Record failing and passing test evidence in a PR comment. One independent review and UI test step.

## Review Focus

- New activity and unread changes must not reorder the default project list.
- Leading # and mixed case must not distort A–Z order.
- Equal normalized names must have a deterministic order independent of input order.
- Pinned and quiet sections retain existing membership and explicit newest mode retains its behavior.
- Desktop keyboard navigation follows the displayed order.

## Task 1: Phone Home ordering

**Files:** Modify `mobile/lib/swarm/swarm_home_list.dart`; test `mobile/test/swarm/swarm_home_list_test.dart` and `mobile/test/swarm/swarm_home_view_test.dart`.
**Interfaces:** Consume `swarmHomeLists`; preserve its signature and return sections.

- [x] Add regressions for A–Z mixed-case/hash names, activity/unread updates, equal names and pinned/quiet sections; update old default-order expectations.
- [x] Run the named phone tests, observe ordering failures and commit tests.
- [x] Replace default activity comparison with normalized name ordering and deterministic key tie-break; preserve explicit newest/unread choices.
- [x] Run affected phone tests; commit and push.

## Task 2: Desktop/web sidebar ordering

**Files:** Modify `desktop/lib/super_tabs/project_sidebar.dart`; test `desktop/test/super_tab_sidebar_test.dart`.
**Interfaces:** Preserve `ProjectSidebar` and `superTabSidebarOrder` APIs.

- [x] Add widget regression for hash/mixed-case project names and unchanged positions after new activity; verify navigation order too.
- [x] Run that test, observe the ordering failure and commit tests.
- [x] Normalize names and use deterministic ties in row/navigation sorting.
- [x] Run affected Desktop tests and `python3 scripts/check-ui-style.py`; commit and push.

## Validation scope

Dart-only list comparisons; no schema, persistence, process, platform or dependency changes. Run the affected home list/view/row/widget tests and sidebar/navigation tests with two workers and 60-second per-test limits on macOS. Full component suites run in PR CI. Independent Tester verifies light/dark UI and activity update behavior with fake state. No release is authorized for the Engineer.
