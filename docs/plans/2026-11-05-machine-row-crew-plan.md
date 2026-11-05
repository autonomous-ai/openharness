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

## Design

Read-only view of data the Swarm state already carries (docs/feature-design-rules.md Rule 1). It stores, syncs and
writes nothing; the rows it reads belong to #3397 (`crew`) and #3398 (`asleep`, `movedTo`), whose own Design sections
answer for them.

1. **Growth:** N/A: no new record. What it shows leaves with the agent (removal) or its crew mark (`crew.remove`), as
   #3397/#3398 define. Per machine the view holds one list of that machine's crew, rebuilt each draw.
2. **Concurrency:** N/A: no write. It reads one snapshot per draw, so the line and the details always agree.
3. **Read cost:** no new read, request, field or poll. It uses the agents and machine readings Desktop already has
   (the change reads; nothing polls whole state).
4. **Scale (10x):** O(agents on the machine) to pick the crew, plus a sort of the crew (a handful), once per machine per
   draw. Measured with `MACHINE_CREW_BENCH` (below): at 10 machines and 100 (10x) with every row expanded. The first
   warning at 10x is the expanded details' draw time, which grows with the crew rows shown (one text row each).
5. **Compatibility:** an older server sends no `crew`/`asleep`/`movedTo`: no line, no section, the row as today. An
   older Desktop ignores the fields. A `asleep` without a number `since` reads asleep with no hours.
6. **Migration and rollback:** none; reverting the PR removes the line and the section only.
7. **Audience:** who already sees the machine row sees its agents' names today (Manage → Machines, the agents
   count); the line adds counts and states of those same agents, nothing from other projects the reader cannot read.
8. **Identity:** N/A: no action, no account; display names as the Swarm state gives them.
9. **Failure:** a stale machine (offline, unreachable, refreshing) drops its free disk figure instead of showing an old
   one; crew counts stay, since they come from the Swarm, not the machine. Malformed records are read defensively.
10. **Platforms:** Desktop on macOS, Windows and Linux, and the web build: one Flutter widget, no platform code.

## Measurements

`MACHINE_CREW_BENCH=1 flutter test test/super_tab_machine_crew_bench_test.dart`: Manage → Machines, every row expanded,
4 crew (2 asleep) and 2 other agents per machine, 200 redraws, median and p95 in a debug widget test (relative only).
The same file on the code before (#3222 base d2694b5c) and after; two rounds each, numbers in the pull request.
Desktop at rest (PRODUCT.md: ≤ 1% of one core): no timer, listener or animation is added; idle hours advance on the
next redraw the Swarm causes, not by a clock.

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
