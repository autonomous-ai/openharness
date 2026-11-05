# Project settings: each row's value, and Delete set apart: Implementation Plan

> This plan follows the project's own way of working (project instructions, Engineer): each plan task commits its
> failing test before its code, and the pull request's one review step is the independent review. There is no
> execution handoff; the Engineer implements it.

**Goal:** Task #3194 (Diego, 11-05, reshaped by the PM under anh Dee's 10-29 rule: improve a working screen in place).
Desktop's Project settings dialog keeps its rows, order, actions and conditions, and adds:
- the project's name and its Swarm under the title;
- each row's current value on the right, in the quieter metadata role;
- Delete Project in the destructive ink, set apart by a rule.

**Architecture:** `showProjectSettings` (desktop `super_tabs/project_options.dart`) takes rows of
`({String label, String? value, VoidCallback action, bool danger})` instead of `(String, VoidCallback)`, and puts
`'<project> · <Swarm>'` in `SuperTabDetailDialog.detail`. `_projectSettings` (`super_tabs/view.dart`) gives each row its
value from what the controller already holds:
- Rename: the name.
- Project details: `repository.repositoryUrl`, else `repository.cwd`, else `Not set` (as Project details shows).
- Switch PM: the PM's name, else `Starting…` (as Project details shows).
- Archived: `N conversation(s)` only when the archived list is read to its end (`dormantLoaded && !hasEarlierDormant`),
  otherwise no value, so it never starts a read.
- Delete: no value; `danger: true` draws it in `colorScheme.error`, below a hairline (as `AppMenuItem.danger` and
  `AppMenuDivider` set a destructive menu row apart).

**Tech Stack:** Flutter desktop, widget tests in `desktop/test/super_tab_project_menu_test.dart` and
`desktop/test/super_tab_switch_pm_test.dart`; light/dark pictures with the suite's capture helper.

**Spec:** Swarm task #3194's brief.

## Design

- growth, concurrency, read cost: nothing new is stored, written or read; values come from the snapshot already held.
- compatibility, migration, audience, identity: N/A because this is a client-only change to one dialog.
- failure: no value is shown when one isn't known; the row still works.
- platforms: Desktop macOS/Linux/Windows and web share this dialog; the phone's row height (`kFingerTarget`) stays.

## Global Constraints

- Same dialog, rows, order, actions and conditions. No new controls, no editing in place, no backend change.
- Desktop design system only; `scripts/check-ui-style.py --only desktop/lib/super_tabs` passes. Light and dark, text
  scaling, keyboard order unchanged.

## Review Focus

- A value appears only on a row offered today; Archived never triggers a read.
- Delete's ink is the theme's destructive role in both themes, and it is still a plain row (same tap, same keyboard).

---

### Task 1: Each row shows its value, the title names the project and Swarm, Delete is set apart

**Files:** Modify `desktop/lib/super_tabs/project_options.dart`, `desktop/lib/super_tabs/view.dart`. Test
`desktop/test/super_tab_project_menu_test.dart`, `desktop/test/super_tab_switch_pm_test.dart`.

- [ ] Failing tests: the detail line; Rename's value; Project details' value with and without a repository; Archived's
  count only once read to its end; Switch PM's value; no values for rows not offered; Delete in the error ink below
  a rule.
- [ ] Implement; run those two files and `check-ui-style.py`.

### Task 2: Pictures

- [ ] Light and dark screenshots of the dialog in the PR.
