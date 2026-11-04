# Machine cap and refusal log Implementation Plan

> **For agentic workers:** Follow the project Engineer workflow: plan first in a draft PR; implement task by task with a committed failing test before its code; no per-task review, one independent review on the pull request.

**Goal:** A Swarm can hold 128 machines, every refused command leaves one log line, and a person whose Mac is refused is told why.

**Architecture:** One limit and one message in `machines.ts`, used by both places that add a machine. `SuperTabStore.execute`, the one way into a command, logs each refusal. Desktop already shows the server's message, so it only gains tests naming this refusal.

**Tech Stack:** TypeScript, Vitest, MongoDB in the integration suite; Flutter/Dart Desktop tests.

**Spec:** Task #2610 (Ken, 2026-11-04): the openharness Swarm holds 32 entries, 15 of them Team entries, and refuses a new collaborator's Mac. Ken decided: raise the cap to 128, and every entry counts. That replaces leaving Team entries out of the count.

## What the 32 protected

Nothing in the code, the design or #1436 (where it began) says why 32. `docs/design/2026-10-26-swarm-state-parts.md` Q4 records only that it is exact and guarded on the head.

Measured on the live Swarm on 2026-11-04: 32 entries, 15 of them Team entries, 1,647 to 3,021 bytes each, median 1,994; 67 KB of a 401 KB state.

The numbers at 128 (the host readings route, the host signature, the poll, a first load) are measured at 32 and 128 entries on this branch and go in the pull request.

## Design

- **Growth:** an entry goes with `machine.remove`. Limit per Swarm: 128 entries, Team entries included.
- **Concurrency:** unchanged: the head guards the count.
- **Read cost:** no new read. The count is over `state.machines`, already loaded. What grows with the count is measured in the pull request.
- **Scale:** this is the 10x step for the machine count. First warning: the new `MACHINES_FULL` log line, and reading times.
- **Compatibility:** old clients show the server's message and see more machines.
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

- Every entry counts: Team and Buddy-only entries too; saving an entry already in the Swarm at the limit still works.
- The refusal log: one line per refused command, no values, no line for a command that succeeds.
- The numbers at 128.

## Task 1: 128 machines

**Files:** `backend/src/superTabs/machines.ts`, `backend/src/superTabs/commands.ts`, `backend/src/superTabs/machineCap.test.ts`, `backend/src/superTabs/buddyMachines.test.ts`, `docs/design/2026-10-26-swarm-state-parts.md`.

**Interfaces:** `machinesFull(state): boolean`, `MACHINES_FULL_MESSAGE`.

- [ ] Write failing tests: 127 entries, 15 of them Team, accept a new machine; 128 refuse with the new message, a Team entry included; saving an entry already there at 128 works; a Buddy-only machine follows the same limit.
- [ ] Run them, watch them fail, commit.
- [ ] Add the limit and message, use them in `machine.contribute` and `addBuddyMachine`.
- [ ] Run the tests of what changed, commit.

## Task 2: Log every refused command

**Files:** `backend/src/superTabs/store.ts`, `backend/integration/superTabCommandLoads.test.ts`.

**Interfaces:** the log line `Swarm command refused` with `{ code, type }`.

- [ ] Write failing test: a refused command writes one line with its code and type and nothing else; a command that succeeds writes none.
- [ ] Run it, watch it fail, commit.
- [ ] Log in `SuperTabStore.execute`'s catch.
- [ ] Run the test and commit.

## Task 3: Desktop says why

**Files:** `desktop/test/swarm_join_machine_test.dart`, `desktop/test/super_tab_add_computers_test.dart`.

- [ ] Add tests with this refusal: the note after joining says it, and Add machine's row shows `failed` with it as the reason.
- [ ] Run them. They pass on today's code: they guard the check, they do not change behavior. Commit.

## Task 4: The numbers at 128

- [ ] With a throwaway test (not committed) at 32 and 128 entries, measure: a machine's reading (fast and full), the host signature, the host poll's size, a person's first load.
- [ ] Put them in the pull request, with what each costs across the Swarm per minute.
