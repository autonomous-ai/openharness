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

- [x] Write and commit widget tests for title/search/filter counts, leading dots, owner badge, crew chips, 56pt rows and aligned disk bars, including stale readings and long names.
- [x] Run the new test file and record expected failures.
- [x] Implement theme roles and Manage presentation; preserve existing compact presentation and expansion/menu behavior.
- [x] Run new tests plus existing Machines tests and analyze changed Dart files; record red/green evidence.
- [x] Commit implementation and push.

## Task 2: Visual evidence and interaction coverage

**Files:** Modify `desktop/test/super_tab_machines_standard_shots_test.dart` and `desktop/test/super_tab_machines_mockups_test.dart`.
**Interfaces:** Capture the Manage screen using the existing screenshot helper with fake state; no production interface changes.

- [x] Add failing interaction assertions for combined search/filter, no matches, crew expansion and changing live status counts.
- [x] Run and record red; implement any remaining presentation behavior and run green.
- [x] Capture light/dark screens with realistic fixtures, compare side by side to attachments, and check the UI style gate.
- [x] Push final evidence, mark ready, hand off independent review/test through the Integrator.

## Validation

Affected widget files on macOS with Flutter 3.47.9; changed-file analysis; `python3 scripts/check-ui-style.py --only desktop/lib/super_tabs --against origin/main`; light/dark screenshots. Linux component suite comes from PR CI. Native Windows and Linux windows are not available on this Mac and must be reported as unverified.


## Results

Implemented the Manage-only presentation and regression coverage. Targeted macOS widget checks passed: 29 across mockups, standard, screenshots and Manage navigation; 81 existing Machines tests (110 total). Changed-file Flutter analysis, UI style gate and diff whitespace checks passed. Red tests were committed before implementation; replay against the original presentation produced the expected failures.

Light/dark captures and side-by-side reference comparisons are attached to task #3974. Fixture values and alphabetical ordering differ from the reference. Native Windows/Linux windows and OS accessibility/theme switching remain unverified; independent Team-account testing is offscreen.

Same 16-machine debug/offscreen redraw workload (100 updates): base median 2840µs / p95 4595µs; current median 3098µs / p95 4533µs. Reusing sorted views removed a repeated grouping pass. This is a widget microbenchmark, not native production latency; median increased 258µs while p95 decreased 62µs.

Final delivery goes through independent Integrator review/test and ready-PR Linux CI; no release is part of this task.


## Independent review fixes

- Restored local Team Set up / Restart / Retry in Manage's contextual menu, sharing the existing compact-row handler. Regression committed at 8a17a35e1, then observed red; fixture targeting refined before implementation at 85a42644e.
- Added the local endpoint port and monospace machine ID/port; b7b9ce375 failed before the implementation in 4b0b1ad74.
- Updated legacy Manage crew-line assertions to inspect crew chips, expanded asleep states and disk columns. Project-disk priority, missing-reading behavior and stale-reading age remain covered. Three legacy expectations were observed failing before adjustment.
- After these fixes: 33 passed across crew, Team machine, mockup and screenshot files; earlier affected Machines and account-move checks passed (81 + 6). Changed-file analysis and UI style gate passed. Regenerated light/dark captures include port 18473.
- The reported ci/required failure was the old draft run explicitly deferring validation until ready_for_review. No manual rerun was started; the final fix push uses automatic CI.
