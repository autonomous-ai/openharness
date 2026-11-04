# Machine cap and refusal log Implementation Plan

> **For agentic workers:** Follow the project Engineer workflow: plan first in a draft PR; implement task by task with a committed failing test before its code; no per-task review, one independent review on the pull request.

**Goal:** A Mac's Harness Team account stops using up a Swarm's 32 machines, every refused command leaves one log line, and a person whose Mac is refused is told why.

**Architecture:** One helper in `machines.ts` answers whether a Swarm is full, for both places that add a machine. `SuperTabStore.execute`, the one way into a command, logs each refusal. Desktop already shows the server's message, so it only gains tests naming this refusal.

**Tech Stack:** TypeScript, Vitest, MongoDB in the integration suite; Flutter/Dart Desktop tests.

**Spec:** Task #2610 (Ken, 2026-11-04): the openharness Swarm holds 32 entries, 15 of them Team entries, and refuses a new collaborator's Mac.

## What the 32 protects

Nothing in the code, the design or #1436 (where it began) says why 32. `docs/design/2026-10-26-swarm-state-parts.md` Q4 records only that it is exact and guarded on the head.

Measured on the live Swarm on 2026-11-04: 32 entries, 15 of them Team entries, 1,647 to 3,021 bytes each, median 1,994; 67 KB of a 401 KB state.

- **Size:** an entry is one machine part. At 32 Macs and 32 Team entries the machines are about 134 KB of a first load, 67 KB more than now. Later reads carry only what changed.
- **Host polls:** each host reads per computer, and a Team account's host already runs and reads whether or not its entry counts.
- **Slots:** a Team entry shares its Mac's `maxAgents` (`commands.ts`, the copy at the end of `machine.contribute`).

Counting only real machines is the better fix. Raising the cap would keep charging a Mac twice, and it would lift the one limit on real machines, which do add hosts and slots.

## Design

- **Growth:** an entry goes with `machine.remove`. Limit per Swarm: 32 real machines. A Team entry is refused once the Swarm holds 64 entries, so Team entries stay bounded even for a Team machine whose Mac is not in the Swarm.
- **Concurrency:** unchanged: the head guards the count.
- **Read cost:** no new read. The count is over `state.machines`, already loaded.
- **Scale:** at 64 entries about 134 KB of machines in a first load. First warning: the new `MACHINES_FULL` log line.
- **Compatibility:** old clients show the server's message and see more machines, as they already can.
- **Migration + rollback:** nothing stored changes. Rolled back, a Swarm above 32 entries refuses new machines until it is below again.
- **Audience:** the server decides, as before.
- **Identity:** the same contributor checks as before.
- **Failure:** today's silent refusal becomes a log line, with the code and command type only.
- **Platforms:** backend. Desktop on macOS, Linux and Windows reads the same message.

## Global Constraints

- Failing test before its code, each in its own commit.
- A refusal's log line holds its code and command type, and no ids or text.
- Visible copy says Swarm and machine (`docs/naming-system.md`), never Super Tab.
- No Desktop screen changes: the check shows they already say why.
- Swarm code stays out of `cli/src/core`.

## Review Focus

- A Team entry joining at 32 real machines; a real machine refused at 32; Buddy-only entries still counted.
- The refusal log: one line per refused command, no values, no line for a command that succeeds.
- The 64-entry bound for Team entries.

## Task 1: Count only real machines

**Files:** `backend/src/superTabs/machines.ts`, `backend/src/superTabs/commands.ts`, `backend/src/superTabs/machines.test.ts` (or the file that holds machine commands' tests).

**Interfaces:** `machinesFull(state, team?: boolean): boolean`, `MACHINES_FULL_MESSAGE`.

- [ ] Write failing tests: 32 entries with 15 Team entries accept a new machine; 32 real machines refuse with the new message; a Team entry joins at 32 real machines; a Team entry is refused at 64 entries; a Buddy-only machine at 32 entries with 15 Team entries is accepted, and at 32 real ones refused.
- [ ] Run them, watch them fail, commit.
- [ ] Add the helper, use it in `machine.contribute` and `addBuddyMachine`.
- [ ] Run the tests of what changed, commit.

## Task 2: Log every refused command

**Files:** `backend/src/superTabs/store.ts`, an integration test in `backend/integration/superTabCommandLoads.test.ts`.

**Interfaces:** the log line `Swarm command refused` with `{ code, type }`.

- [ ] Write failing test: a refused command writes one line with its code and type and nothing else; a command that succeeds writes none.
- [ ] Run it, watch it fail, commit.
- [ ] Log in `SuperTabStore.execute`'s catch.
- [ ] Run the test and commit.

## Task 3: Desktop says why

**Files:** `desktop/test/swarm_join_machine_test.dart`, `desktop/test/super_tab_add_computers_test.dart`.

- [ ] Add tests with this refusal: the note after joining says it, and Add machine's row shows `failed` with it as the reason.
- [ ] Run them. They pass on today's code: they guard the check, they do not change behavior. Commit.
