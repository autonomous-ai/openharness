# Machines mockup alignment implementation plan

> Implement natively, task by task, with failing tests committed before implementation and one independent PR review.

**Goal:** Match the agreed Machines light/dark mockups without changing global navigation.
**Architecture:** Keep the existing Machines controller, row subscriptions, menus and expansion. Give Manage its own full-width presentation, with search and status filters applied locally. Put the screen's design roles in a theme file; leave compact embedded rows intact.
**Tech Stack:** Flutter / Dart, flutter_test, existing in-memory ConversationServer.
**Spec:** Task #3974 attachments: machines_light.png, machines_dark.png, harness-design-standard.md.

## Global Constraints

- Desktop Machines only; preserve current navigation and Backlog removal.
- 56pt rows; status, name, crew, disk and menu share aligned columns.
- Light and dark use the same widgets with theme tokens.
- No real account sign-in or persistence in tests.
- No data contract changes. Design: growth, locking, migration, audience and identity N/A because only local presentation changes; reads reuse the existing machine subscriptions. Platforms: macOS, Linux, Windows, shared web rendering.

## Review Focus

- Long names and narrow content truncate without overflow.
- Search combines with status filters; empty matches remain recoverable.
- Offline/stale readings stay visible and carry their age.
- Crew expansion and keyboard/context menus remain reachable.
- Live status changes update filter counts and grouping.

## Task 1: Full-width Machines presentation

**Files:** Modify `desktop/lib/super_tabs/machines.dart`; create `desktop/lib/super_tabs/machines_manage.dart` and `desktop/lib/shared/theme/machines_style.dart`; test `desktop/test/super_tab_machines_mockups_test.dart`.
**Interfaces:** Consume existing `_MachineView`, `_groups`, `_machine`, `toggleMachineExpanded`, `_menu`; produce Manage-only screen, toolbar and fixed-height row widgets. No public API changes.

- [ ] Write and commit widget tests for title/search/filter counts, leading dots, owner badge, crew chips, 56pt rows and aligned disk bars, including stale readings and long names.
- [ ] Run the new test file and record expected failures.
- [ ] Implement theme roles and Manage presentation; preserve existing compact presentation and expansion/menu behavior.
- [ ] Run new tests plus existing Machines tests and analyze changed Dart files; record red/green evidence.
- [ ] Commit implementation and push.

## Task 2: Visual evidence and interaction coverage

**Files:** Modify `desktop/test/super_tab_machines_standard_shots_test.dart` and `desktop/test/super_tab_machines_mockups_test.dart`.
**Interfaces:** Capture the Manage screen using the existing screenshot helper with fake state; no production interface changes.

- [ ] Add failing interaction assertions for combined search/filter, no matches, crew expansion and changing live status counts.
- [ ] Run and record red; implement any remaining presentation behavior and run green.
- [ ] Capture light/dark screens with realistic fixtures, compare side by side to attachments, and check the UI style gate.
- [ ] Push final evidence, mark ready, hand off independent review/test through the Integrator.

## Validation

Affected widget files on macOS with Flutter 3.47.9; changed-file analysis; `python3 scripts/check-ui-style.py --only desktop/lib/super_tabs --against origin/main`; light/dark screenshots. Linux component suite comes from PR CI. Native Windows and Linux windows are not available on this Mac and must be reported as unverified.
