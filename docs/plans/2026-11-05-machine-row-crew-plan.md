# Machine rows show crew sessions, free disk and idle hours (task #3412) Plan

> Worked by the project's own way: plan first, then each task test first (failing test committed before its code), one
> pull request, one review. No subagent-driven development and no execution handoff.

**Goal:** On each machine row in Manage → Machines, a short line says how many crew members the machine runs, how many
are asleep and its free disk ("3 crew · 1 asleep · 42 GB free"). The row's details list each member with awake or
asleep and its idle hours, so people can see when to clean up crew agents.

**Architecture:** Desktop only. The server (task #3398, plan Task 4) puts on each machine entry of the Swarm state
`crew: [{ name, asleep, idleHours }]` and `diskFreeBytes`. `superTabMachineCrew` reads them into a small value; the
machine view carries it; `_MachineLine` draws the line under the name, `_MachineReadings` a Crew section first.

**Tech Stack:** Flutter (desktop/lib/super_tabs/machines.dart), flutter_test widget tests with the in-memory
`ConversationServer` fixture and a fake sign-in.

**Spec:** task #3412's brief; docs/plans/2026-11-05-crew-sleep-wake-move-plan.md, Task 4 (the field contract).

## Global Constraints

- Owns `desktop/lib/` (and its tests). No backend change; Swarm code stays out of `cli/src/core`.
- No crew list from the server (older server, or a machine with no crew): the row is exactly as today.
- Free disk: the server's `diskFreeBytes` first, else the row's own reading; left out while the machine's readings are
  stale (offline, out of reach, refreshing), as the row's other numbers are.
- Harness design language: the line is the row's metadata style, like "Was kelvin until 5 Nov"; the section uses the
  details panel's own section heading. Light and dark screenshots.
- Tests use the memory store and a fake sign-in; nothing signs the Mac out of the real CLI.

## Review Focus

1. A malformed entry (missing name, idleHours not a number) is skipped, never a crash.
2. A stale machine never shows an old disk figure as current.
3. Nothing changes for machines without crew.

---

### Task 1: The crew line and the Crew section

**Files:** `desktop/lib/super_tabs/machines.dart`; test `desktop/test/super_tab_machine_crew_test.dart`.

**Interfaces:** `SuperTabMachineCrew? superTabMachineCrew(Map<String, dynamic>? pool, {double? diskFree})` with
`members` (name, asleep, idleHours) and `line`; keys `super-machine-crew-<machineId>` (line) and
`super-machine-crew-member-<machineId>-<index>` (section rows).

- [ ] Write the failing widget test: a machine entry with three crew members (one asleep) and `diskFreeBytes` 42 GB
      shows "3 crew · 1 asleep · 42 GB free" under the name; expanded, each member's line with awake or asleep and
      "idle N h", sorted by idle hours; a machine with no crew shows no line; offline drops the disk figure.
- [ ] Run it and watch it fail; commit.
- [ ] Implement `superTabMachineCrew`, the view field, the line and the section; run the test and the other machine
      row tests (`super_tab_machines_test.dart`, `super_tab_computer_move_test.dart`); commit.
- [ ] Light and dark screenshots of the row and its details from a golden-style capture test (not committed as
      goldens), attached to the pull request.
