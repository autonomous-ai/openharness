# Tasks Activity Marks Implementation Plan

> Implement task-by-task with test-driven development, following the project's Engineer workflow.

**Goal:** Replace Tasks board/list notification dots with the existing activity vocabulary and keep unread titles bold.

**Architecture:** Board and List share `SuperTabTaskCard` in `task_card.dart`, populated by `tasks_view.dart` (not the separate Backlog). Derive presentation activity from the existing task entry without changing grouping, persistence, or wire contracts. Reuse `ActivityMark` so its shared clock and Reduce Motion behavior remain authoritative.

**Tech Stack:** Flutter/Dart, existing widget test fixtures, shared activity widgets.

**Spec:** Swarm task #3007 and River's approved ASCII mockup in the project chat, November 5, 2026; `desktop/design/desktop-design-system.md` and `desktop/design/icon-design-system.md`.

## Global Constraints

- One top-right status cell: queued ◌, working Braille spinner, person ?, blocked/lost ⊘, shipped ✓, failed ✗.
- Unread is a bold title with no dot. “Needs you” is caption content only for the reader.
- Shipped cards omit unavailable agents; preserve actual known agent names.
- Preserve Board/List layout, selection, navigation, grouping and column counts.
- No sidebar or theme edits, new dependencies, data storage, or backend changes.
- Fake sign-in/memory stores only. Stop only owned processes; temporary output uses mktemp directories.

## Review Focus

- Shipped tasks with pending reader attention need ? rather than losing that attention under ✓.
- Blocked/lost and failed assignments must not display a working spinner.
- Another person's decision needs ? but never “Needs you”.
- Queued and unassigned proposals must not imply active execution.
- Long/wrapped unread titles keep the mark aligned at the top right; Reduce Motion freezes working marks.

## Task 1: Activity marks and captions

**Files:** Modify `desktop/lib/super_tabs/task_card.dart`, `desktop/lib/super_tabs/tasks_view.dart`; add regression coverage in `desktop/test/super_tab_task_activity_test.dart`; adjust affected existing Tasks fixtures only as needed for live animation.

**Interfaces:** Consume existing `SuperTabTaskEntry`, `HarnessActivity`, `ActivityMark`; add an activity argument to the shared card. No controller or server API changes.

- [x] Commit failing widget tests for the six marks, unread/no dots, caption attention, shipped unavailable agents, stable status placement and Reduce Motion.
- [x] Run those tests and record expected failures before production edits.
- [x] Implement minimal shared-card presentation and activity mapping.
- [x] Run affected Tasks view/group/column/header and activity tests, analyzing only changed Dart files; record red/green evidence.

## Task 2: Visual verification and handoff

**Files:** Existing `desktop/test/super_tab_tasks_shots_test.dart` screenshot fixture; no new production interfaces.

- [x] Run `python3 scripts/check-ui-style.py --only desktop/lib/super_tabs`, `desktop/test/laid_out_list_test.dart`, and icon audit.
- [x] Capture and inspect light/dark Board and List screenshots; attach them to task #3007 and notify Dee with a person line.
- [ ] Record validation timings, commands, toolchain and screenshots in the PR; mark Ready after required local checks.
- [ ] Add independent Review and Test steps, route their agents, and request both in parallel. Complete the task only after both verdicts pass; merge/publication belong to the PM.

## Validation Scope

Deterministic checks cover changed Dart files and their Tasks widget callers with the repository lockfile and installed pinned Flutter/Dart SDK. Targeted tests and Desktop guards run locally on macOS; PR CI supplies the Desktop VM suite. No second local full suite. Capture test-fixture rendering timing before/after on the same fixture; native user testing is an independent Tester step. No backend, CLI, mobile or release checks are affected. Track implementation, validation, review/CI waiting, merge and publication separately; this task does not authorize a release.

### Local Evidence (November 5, 2026)

- Source: implementation `c724e90976a69042d40e78ac7ef81e460b849225`, based on `7802e5756`; Flutter 3.47.2 / Dart 3.13.2 on macOS arm64, unchanged `pubspec.lock`.
- Red: final 31 activity regression tests all fail against the unchanged production files from the base. Initial failing tests were committed before implementation; the concise reader-caption regression separately failed twice before its fix.
- Green: `flutter test --no-pub` with `super_tab_task_activity_test.dart`, `super_tab_tasks_view_test.dart`, `super_tab_task_groups_test.dart`, `super_tab_task_columns_test.dart`, `super_tab_tasks_header_test.dart`, `super_tab_tasks_shots_test.dart`, `harness_activity_test.dart`, `laid_out_list_test.dart`: 91 passed, 7.89 seconds wall time. This is affected coverage, not a full Desktop suite.
- Analyze: both production files, new activity tests, screenshot and header fixtures: no issues (7.5 seconds). The changed existing Tasks view test file has a pre-existing single-cascade lint at line 102, outside these edits; it was reported, not fixed as unrelated cleanup.
- Guards: UI style checker passed; icon audit passed (953 Dart files, 181 catalogue symbols, 853 references); `git diff --check` passed. LaidOutList guard is included in the 91 passing tests.
- Screenshots: four 1900×900 fixture renders, Board/List in light/dark, inspected and attached to task #3007; Dee also received a person line. System SF Mono and Apple Symbols are explicitly loaded in the macOS screenshot fixture so activity glyphs are real glyphs rather than Ahem boxes. Runtime/native verification remains a separate Test step, not claimed by widget screenshots.
- Rendering measurement: identical 300-task Board mount workload, 2 warmups and 20 samples, real fonts, Reduce Motion enabled, same machine/toolchain. Base median 53.523 ms / p95 74.708 ms; implementation median 55.238 ms / p95 85.439 ms. These are whole test-fixture mount costs, not native frame latency. ENGINEERING §4 exception: adding a status cell to previously unmarked cards costs 1.715 ms median in this workload (+3.2%); the replacement criterion is bounded mount cost with no new reads/polling and animation confined to the existing lifecycle-aware shared repaint boundary. Do not call this a speedup or claim unchanged performance; independent runtime review must judge responsiveness.
- Clock: task requested at 02:00:27 UTC; implementation committed at 02:17:47 UTC (17m20s including inspection, test-first cycles and local validation). Validation time is recorded separately above and overlaps implementation. Independent review/test and CI waiting start afterward; merge and publication have not happened and belong to the PM.

## Design

N/A for growth, locks, incremental reads, 10x data scale, migration/rollback, audience and identity: presentation-only, no stored or exposed data added. Compatibility and failure: existing task fields stay unchanged; explicit failed/lost marks remain visible. Platforms: shared Flutter desktop/web presentation; macOS local widget/screenshots and independent runtime testing, Linux VM coverage in PR CI.
