# Machine rows show crew sessions, free disk and idle hours (task #3412) Plan

> Worked by the project's own way: plan first, then each task test first (failing test committed before its code), one
> pull request, one review. No subagent-driven development and no execution handoff.

**Goal:** On each machine row in Manage → Machines, a short line says how many crew members the machine runs, how many
are asleep and its free disk ("3 crew · 1 asleep · 42 GB free"). The row's details list each member with awake or
asleep, how long it has slept, and whether it is moving, so people can see when to clean up crew agents.

**Architecture:** Desktop only, built on Keeper's #3222 branch (its agent model's crew fields). The server adds no
machine fields (Heron, #3398 plan Decisions): everything is in the Swarm state already.
- Crew sessions: the agents on that machine with a crew record (`crew`); name: display name, else name.
- Asleep: the agent has `asleep`; idle hours: now minus `asleep.since`, while asleep. An awake member shows none.
- Moving: the agent has `movedTo`.
- Free disk: the machine observation's `resources.projectDiskFreeBytes`, else `resources.diskFreeBytes` (what the
  row's SSD reading already uses).

`SuperTabAgent` gains `crewAsleepSince` and `crewMoving`; `superTabMachineCrew` builds the line and members; the machine
view carries it; `_MachineLine` draws the line under the name, `_MachineReadings` a Crew section first.

**Tech Stack:** Flutter (desktop/lib/super_tabs/machines.dart), flutter_test widget tests with the in-memory
`ConversationServer` fixture and a fake sign-in.

**Spec:** task #3412's brief; docs/plans/2026-11-05-crew-sleep-wake-move-plan.md, Task 4 and Decisions (#3229).

## Global Constraints

- Owns `desktop/lib/` (and its tests). No backend change; Swarm code stays out of `cli/src/core`.
- No crew member on a machine (or an older server): the row is exactly as today.
- Free disk is left out while the machine's readings are stale (offline, out of reach, refreshing), as the row's other
  numbers are.
- Harness design language: the line is the row's metadata style, like "Was kelvin until 5 Nov"; the section uses the
  details panel's own section heading. Light and dark screenshots.
- Tests use the memory store and a fake sign-in; nothing signs the Mac out of the real CLI.

## Review Focus

1. A malformed `asleep` (no number `since`) still reads asleep, with no idle hours, never a crash.
2. A stale machine never shows an old disk figure as current.
3. Nothing changes for machines without crew.

---

### Task 1: The crew line and the Crew section

**Files:** `desktop/lib/super_tabs/model.dart`, `desktop/lib/super_tabs/machines.dart`; test
`desktop/test/super_tab_machine_crew_test.dart`.

**Interfaces:** `SuperTabAgent.crewAsleepSince` (DateTime?), `SuperTabAgent.crewMoving` (bool);
`String? superTabMachineCrewLine(List<SuperTabAgent> crew, {double? diskFree})`; keys `super-machine-crew-<machineId>`
(line), `super-machine-crew-member-<machineId>-<index>` and `super-machine-crew-state-<machineId>-<index>` (section).

- [ ] Write the failing widget test: three crew agents on a machine (one asleep for 5 h, one moving) and a reading of
      42 GB free show "3 crew · 1 asleep · 42 GB free" under the name; expanded, a Crew section lists each member
      (awake first, asleep by time asleep) with "awake", "moving" or "asleep · idle 5 h"; non-crew agents are not
      counted; a machine with no crew shows no line and no section; offline drops the disk figure.
- [ ] Run it and watch it fail; commit.
- [ ] Implement `superTabMachineCrew`, the view field, the line and the section; run the test and the other machine
      row tests (`super_tab_machines_test.dart`, `super_tab_computer_move_test.dart`); commit.
- [ ] Light and dark screenshots of the row and its details from a golden-style capture test (not committed as
      goldens), attached to the pull request.
