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

- [ ] Commit failing widget tests for the six marks, unread/no dots, caption attention, shipped unavailable agents, stable status placement and Reduce Motion.
- [ ] Run those tests and record expected failures before production edits.
- [ ] Implement minimal shared-card presentation and activity mapping.
- [ ] Run affected Tasks view/group/column/header and activity tests, analyzing only changed Dart files; record red/green evidence.

## Task 2: Visual verification and handoff

**Files:** Existing `desktop/test/super_tab_tasks_shots_test.dart` screenshot fixture; no new production interfaces.

- [ ] Run `desktop/scripts/check-ui-style.sh`, `desktop/test/laid_out_list_test.dart`, and icon audit.
- [ ] Capture and inspect light/dark Board and List screenshots; attach them to task #3007 and notify Dee with a person line.
- [ ] Record validation timings, commands, toolchain and screenshots in the PR; mark Ready after required local checks.
- [ ] Add independent Review and Test steps, route their agents, and request both in parallel. Complete the task only after both verdicts pass; merge/publication belong to the PM.

## Validation Scope

Deterministic checks cover changed Dart files and their Tasks widget callers with the repository lockfile and installed pinned Flutter/Dart SDK. Targeted tests and Desktop guards run locally on macOS; PR CI supplies the Desktop VM suite. No second local full suite. Capture test-fixture rendering timing before/after on the same fixture; native user testing is an independent Tester step. No backend, CLI, mobile or release checks are affected. Track implementation, validation, review/CI waiting, merge and publication separately; this task does not authorize a release.

## Design

N/A for growth, locks, incremental reads, 10x data scale, migration/rollback, audience and identity: presentation-only, no stored or exposed data added. Compatibility and failure: existing task fields stay unchanged; explicit failed/lost marks remain visible. Platforms: shared Flutter desktop/web presentation; macOS local widget/screenshots and independent runtime testing, Linux VM coverage in PR CI.
