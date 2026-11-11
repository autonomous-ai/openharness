# People list: a no-machine mark Implementation Plan

> Written by the Engineer of task #2699 by the project's way of working (Engineer role, instructions revision 58): test
> first, one pull request, its review step the one independent review. No execution handoff: the Engineer implements it.

**Goal:** In the Desktop People list, a person with no machine shared in this Swarm shows a small muted no-machine mark
after their name, with "No machine shared yet" on hover, so it is clear at a glance who has not shared one (Scholes,
2026-11-04: 32 people, 21 machines).

**Architecture:** `LeaderboardPersonRow` (desktop/lib/super_tabs/leaderboard/person_row.dart) takes a `noMachine` flag
and puts the mark after the name, where number one's crown sits. The roster (roster.dart `_personRow`) sets it from the
Swarm's machines: a person has a machine when any listed machine names them as its contributor. A machine that is only
offline is still listed, so it still counts; one added drops the mark on the next state.

**Tech Stack:** Flutter Desktop, flutter_test widget tests with the Super Tab fixture (memory store, fake sign-in).

**Spec:** task #2699 brief and the mockup posted in its conversation (2026-11-04).

## Global Constraints

- The existing icon `AppIcons.monitorOff`, at the metadata size, in the muted token (`DesktopChrome.metadata()`'s
  colour); nothing hard-coded.
- The rest of the row is unchanged: name hover card, crown, points.
- No backend or wire change. The phone app is out of scope.

## Review Focus

1. A person with no machine shows the mark; one whose machine is offline (no reading) does not.
2. The mark goes when the person adds a machine.
3. The mark says "No machine shared yet" on hover and to a screen reader.

## Design

- growth, read cost, scale, migration, identity: N/A because nothing is stored, read or sent that is not already.
- audience: N/A because it reads only the machines this reader is already sent. A reader who sees only the Swarm-wide
  machines (no access to the Lead project) sees the mark for someone whose only machine is kept for a project they
  cannot read; that machine is not theirs to know about either.
- failure: N/A because no new call.
- platforms: Desktop (macOS, Linux, Windows) and the web build, which share this list.

## Task 1: The no-machine mark

**Files:**
- Modify: `desktop/lib/super_tabs/leaderboard/person_row.dart`, `desktop/lib/super_tabs/roster.dart`
- Test: `desktop/test/super_tab_no_machine_mark_test.dart`, `desktop/test/super_tab_no_machine_mark_shots_test.dart`

**Interfaces:** `LeaderboardPersonRow({..., bool noMachine = false})`; the mark keyed `super-person-no-machine-{id}`.

- [ ] Step 1: Failing widget tests: the mark shows for a person with no machine, not for one whose machine is offline,
  says "No machine shared yet", and goes away once they add a machine.
- [ ] Step 2: Run them; expect FAIL. Commit.
- [ ] Step 3: Implement the flag and the mark; the roster sets it.
- [ ] Step 4: Run the tests and the People list's own tests; expect PASS. Light and dark screenshots offscreen. Commit.
