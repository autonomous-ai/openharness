# 20 machines per person per Swarm Implementation Plan

> **For agentic workers:** Follow the project Engineer workflow: plan first in a draft PR; implement task by task with a
> committed failing test before its code; no per-task review, one independent review on the pull request. No execution
> handoff.

**Status:** Plan only. Tasks 1 to 4 start once every gate below is met (River, 2026-11-04).

**Goal:** A Swarm stops capping machines at 32 in total. Each person may contribute at most 20 machines to one Swarm, and
someone over that limit is told why.

**Architecture:** One helper in `machines.ts` replaces `machinesFull` in both places that add a machine, and counts by
`contributorId`. The refusal gets its own code. The server stops asking a host to join when the join would be refused,
which is what lets old CLIs stop cleanly. New CLIs also treat the new code as final.

**Tech Stack:** TypeScript and Vitest (backend, CLI), MongoDB in the integration suite, Flutter/Dart (Desktop tests).

**Spec:** Task #2637, Ken's machine-cap plan (2026-11-04). The 32 cap dates from when the whole Swarm was one 16 MB
document. Each machine is its own document now, so that reason is gone.

## Gates before building

| Gate | State on 2026-11-04 | How it's checked |
|---|---|---|
| Team entries out of the count (#2900) | Live in backend v1.3.96 | Commit is an ancestor of the tag |
| Host readings read only what changed (#2890, B3) | Live in backend v1.3.96 | Commit is an ancestor of the tag |
| The heartbeat out of the machine part (#2904, Kiln3) | Open | Merged and in a released backend |
| Clients ask for light changes | Not started: no client asks for `machines=light` yet | Released Desktop and phone send it |
| Baseline measured | Not done | Task 4, step 1 |

## Measured on production (2026-11-04, read-only login)

- 55 Swarms hold machines, 155 entries in all.
- The largest Swarm has 36 entries: 21 real, 15 Team accounts', from 18 people.
- The most machines one person has in one Swarm is 6. Nobody is over 20, and nobody has 10 or more. No existing machine
  becomes over the limit.
- A machine part averages 2.66 KB, 17.1 KB at most.
- 132 of the 155 parts were written within one 60-second window, as hosts report about every 15 seconds.

Not measured yet: `db by shape` reads and bytes. Those are in the pods' logs, which only an agent on Ken's Mac can read
(Task 4, step 1).

## Design

- **Growth:** `machine.remove` deletes a machine, and a Buddy-only machine goes with its last Buddy. Real machines are at
  most members × 20. Team entries are at most members × 20 too, because the same limit counts them separately. Without
  that, a Team entry whose Mac isn't in the Swarm would have no bound once the 64-entry check goes. The largest Swarm's
  18 people give at most 360 real machines and 360 Team entries.
- **Concurrency:** unchanged. Commands that add a machine already serialize on the Swarm's head, and the count is over
  `state.machines`, which the command has loaded.
- **Read cost:** the check adds no read. Host rows filter `state.machines` once per row they would add, over a list they
  already hold.
- **Scale at 10x (360 entries in one Swarm):** these are estimates from the measurements above, and Task 4 replaces them
  with measured numbers.

  | Path | Today (36 entries) | 10x | What it depends on |
  |---|---|---|---|
  | Changes, per polling reader, old client | 6.4 KB/s | 64 KB/s | Whole part per reading (2.66 KB ÷ 15 s) |
  | Changes, per polling reader, light client | Not live | About 2 KB/s | One short line per reading (#2904) |
  | `readMachines` on a cache miss | 96 KB | About 1 MB | Every live machine part |
  | Machine writes to one Swarm | 2.4/s | 24/s | One per reading |
  | Cache patch (`applyByKey`) | 36 per changed part | 360 per changed part | Scans and copies the list |
  | Host signature (`hostGroupsSignature`) | Unchanged | Unchanged | Its input is groups, not machines |
  | Assignment pick (`cli` route, `workerIndex`) | Per call | 10x per call | Walks machines and agents |

  What warns first: changes bytes on old clients, then `readMachines` result bytes in `db by shape`. This is why light
  clients are a gate: a 10x Swarm on light clients should cost a reader less than today's largest Swarm costs on old ones.
  There is no Swarm-wide count left, so the warning is `db by shape`, not a refusal. Review this design again when one
  Swarm passes 100 entries.
- **Compatibility:**
  - Old CLIs know only `MACHINES_FULL` as final, so the new code alone would make them retry for good, backing off to every
    30 minutes. Their host stops asking once its roster row stops asking (`host.spec.ts`: "stops after %s until the roster
    stops asking"), so the server leaves out `joinSwarm` and `joinTeam` when the join would be refused. Old and new CLIs
    both stop, with no version check.
  - A row can still race a refusal. An old CLI then retries with backoff until the row goes on its next read.
  - New CLIs against an older backend still meet `MACHINES_FULL`, so it stays in `JOIN_FINAL`. It can go 30 days after the
    release that removes it from the backend (ENGINEERING section 5).
  - Old Desktops show the server's message for any code (#2900's tests). Nothing else reads this code.
- **Migration + rollback:** nothing stored changes. Rolled back, a Swarm above 32 real machines refuses new machines until
  it's below again, and existing ones keep working.
- **Audience:** the server enforces it. The refusal speaks only of the person's own count and names no one else's machines.
- **Identity:** counted by the contributor the command already records (`actor.userId`, or the person adding a Buddy
  machine). Never the machine owner's login.
- **Failure:** the refused command writes `Swarm command refused` with its code and type (#2900), and Desktop shows the
  message. A host whose row was left out does nothing and says nothing, so an owner's Lead on a 21st machine keeps running
  outside the Swarm's machines. Adding that machine by hand shows the refusal. This only affects someone already at 20.
- **Platforms:** backend and CLI on macOS, Linux and Windows. Desktop on macOS, Linux and Windows shows the message, which
  the web build shares. The phone adds no machines.

## Global Constraints

- Failing test before its code, each in its own commit.
- Run only the tests of what changed locally. PR CI runs each touched component's whole suite and the Super Tab
  integration suite.
- Visible copy says Swarm and machine (`docs/naming-system.md`).
- No Desktop screen changes: tests guard the message.
- Swarm code stays out of `cli/src/core`.
- PR body's first line: `Requested by 0xken15@gmail.com through Harness.`

## Review Focus

- A person at 20 refused while another person in the same Swarm can still add.
- Saving a machine already in the Swarm at the limit, and a Buddy-only record becoming an ordinary machine, are never
  refused or left without a row.
- The row condition and the command's check can't disagree: both use the one helper.
- Team entries stay bounded, and a Mac's Team entry doesn't use up its owner's 20.
- Old CLI behaviour, in a test with the old `JOIN_FINAL`.
- Whether the numbers from Task 4 support going ahead.

## Task 1: Count machines per person

**Files:** `backend/src/superTabs/machines.ts`, `backend/src/superTabs/commands.ts`,
`backend/src/superTabs/machineCap.test.ts`, `backend/src/superTabs/buddyMachines.test.ts`,
`docs/design/2026-10-26-swarm-state-parts.md`.

**Interfaces:**
- `machineLimitReached(state, contributorId, { team }): boolean` replaces `machinesFull`.
- `MACHINE_LIMIT_MESSAGE`: "You have 20 machines in this Swarm, the most one person can add. Remove one before adding
  another."
- Refusal code `MACHINE_LIMIT_PER_PERSON`.

- [ ] Write failing tests:
  - A person with 20 real machines is refused, with the new code and message.
  - Another person in that Swarm can still add.
  - A Swarm with 33 real machines across people takes another.
  - A Team entry doesn't count toward its owner's 20.
  - A person's 21st Team entry is refused.
  - Saving a machine already there at 20 works.
  - A Buddy-only record becoming ordinary at 20 works.
  - A new Buddy-only machine at 20 is refused.
- [ ] Run them, watch them fail, commit.
- [ ] Add the helper, use it in `machine.contribute` and `addBuddyMachine`, and remove `MAX_MACHINES`,
  `MACHINES_FULL_MESSAGE` and `machinesFull`. Update question Q4 in the design doc.
- [ ] Run the tests of what changed, commit.

## Task 2: Stop asking a host to join when it would be refused

**Files:** `backend/src/superTabs/read/hostRows.ts`, its tests, `backend/integration/superTabRead.test.ts`.

- [ ] Write failing tests through the host read:
  - At the limit, `joinSwarm` is false and no `joinTeam` row is sent.
  - Below the limit, both are as today.
  - An owner's Lead on a Buddy-only record still gets `joinSwarm` at the limit.
  - Removing a machine brings the row back.
- [ ] Run them, watch them fail, commit.
- [ ] Use the helper in both row conditions.
- [ ] Run the tests of what changed, commit.

## Task 3: New CLIs stop on the new code, and Desktop shows it

**Files:** `cli/src/superTabs/host.ts`, `cli/src/superTabs/host.spec.ts`, `desktop/test/swarm_join_machine_test.dart`,
`desktop/test/super_tab_add_computers_test.dart`.

- [ ] Add `MACHINE_LIMIT_PER_PERSON` to the host spec's "stops after" cases for `joinSwarm` and `joinTeam`. Run them, watch
  them fail, commit.
- [ ] Add it to `JOIN_FINAL`, keeping `MACHINES_FULL` with the date it can go. Run them, commit.
- [ ] Add a CLI test that a host with the old `JOIN_FINAL` stops asking once the row goes.
- [ ] Add Desktop tests: joining and Add machine show the new message. They pass on today's code because they guard the
  check; say so in the PR. Commit.

## Task 4: Measure before and after raising

**Files:** `backend/integration/bench/` (a 360-entry Swarm), the PR's description.

- [ ] Before deploying, have an agent on Ken's Mac read `db by shape` for the machine reads, readings and changes, over one
  hour at the same time of day. Record reads, documents and result bytes. Compare it to the estimates above.
- [ ] Add a bench with 36 and 360 entries: `readMachines` on a miss, a reading's write and patch, a changes poll on old and
  light clients, and the route's pick. Put the numbers in the PR.
- [ ] If a 10x Swarm on light clients costs a reader more than today's largest Swarm on old clients, stop and ask the PM
  before building further.
- [ ] After the release, read the same `db by shape` window and post both in the PR.
