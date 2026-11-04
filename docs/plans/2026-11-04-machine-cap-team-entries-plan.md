# Machine cap and refusal log Implementation Plan

> **For agentic workers:** Follow the project Engineer workflow: plan first in a draft PR; implement task by task with a committed failing test before its code; no per-task review, one independent review on the pull request.

**Goal:** A Mac's Harness Team account stops using up a Swarm's 32 machines, every refused command leaves one log line, and a person whose Mac is refused is told why.

**Architecture:** One helper in `machines.ts` answers whether a Swarm is full, for both places that add a machine. `SuperTabStore.execute`, the one way into a command, logs each refusal. Desktop already shows the server's message, so it only gains tests naming this refusal.

**Tech Stack:** TypeScript, Vitest, MongoDB in the integration suite; Flutter/Dart Desktop tests.

**Spec:** Task #2610 (Ken, 2026-11-04): the openharness Swarm holds 32 entries, 15 of them Team entries, and refuses a new collaborator's Mac. Ken first decided on a cap of 128, then replaced it: for now only Team entries leave the count, and the cap stays 32 real machines until the read-cost fixes ship (host readings read only what changed, the heartbeat out of the machine part).

## Design

- **Growth:** an entry goes with `machine.remove`. Limit per Swarm: 32 real machines. A Team entry is refused once the Swarm holds 64 entries, so Team entries stay bounded even for one whose Mac is not in the Swarm.
- **Concurrency:** unchanged: the head guards the count.
- **Read cost:** no new read. The count is over `state.machines`, already loaded. At most 64 entries, up from 32: the numbers are in the pull request.
- **Scale:** first warning: the new `MACHINES_FULL` log line.
- **Compatibility:** old clients show the server's message and list more entries.
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

- A Team entry joining at 32 real machines; a real machine refused at 32; Buddy-only entries still counted; saving an entry already in the Swarm at the limit still works.
- The refusal log: one line per refused command, no values, no line for a command that succeeds.
- The 64-entry bound for Team entries.

## Task 1: Count only real machines

**Files:** `backend/src/superTabs/machines.ts`, `backend/src/superTabs/commands.ts`, `backend/src/superTabs/machineCap.test.ts`, `backend/src/superTabs/buddyMachines.test.ts`, `docs/design/2026-10-26-swarm-state-parts.md`.

**Interfaces:** `machinesFull(state, team?): boolean`, `MACHINES_FULL_MESSAGE`.

- [ ] Write failing tests: 32 entries, 15 of them Team, take a new machine; 32 real machines refuse with the new message; a Team entry joins at 32 real machines and is refused at 64 entries; saving an entry already there works; a Buddy-only machine follows the same limit.
- [ ] Run them, watch them fail, commit.
- [ ] Add the helper, use it in `machine.contribute` and `addBuddyMachine`.
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
