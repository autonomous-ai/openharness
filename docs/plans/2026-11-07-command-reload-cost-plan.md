# Command read cost back to v1.4.25 (task #4213) Implementation Plan

> Written by the writing-plans way of working; the Engineer implements it task by task, test first.

**Goal:** A command reads each of its Swarm's machines, agents, members and progress once, as on v1.4.25, however many quiet
conversations it needs to add to its first load.

**Architecture:** `SuperTabStore.ensure` (store.ts) loads more named conversations or starts when the first load lacks them. It
did that by loading the whole Swarm again: head, members, agents, machines, progress, every awake conversation and the named
ones. v1.4.26 (task #3818, several Buddies) calls it on every command for the chats listed on a person's main Buddy chat, and
the proposal cards call it twice per pass. Once a person has a second Buddy and it goes quiet, every command in that Swarm
read the whole Swarm twice: Ken's 06:20 VN prod scan shows SwarmMachine, SwarmAgent and SwarmProgress whole-Swarm reads per
command at about 2.2x. `ensure` now reads only what is missing (the named conversations by key, the named agents' and
projects' conversations, the named starts) and adds them to what is loaded. A transaction reads one snapshot, so the result
is the one a whole reload gave.

**Tech Stack:** TypeScript, Prisma on MongoDB, vitest integration tests on a loopback replica set.

**Spec:** Task #4213's brief.

## Global Constraints

- Backend only; no schema or index change; no production write beyond the normal deploy.
- Every new read uses an index already listed in `parts/indexed.ts` (key, agents, project; starts by key or agent).

## Review Focus

- The merged parts equal what `loadActive` with the same names returns inside the same transaction.
- `allGroups` keeps the whole reload (a rare read across every live conversation).

## Task 1: a command with a quiet listed Buddy chat reads the Swarm once

**Files:** `backend/integration/superTabSwarmBuddy.test.ts`, `backend/src/superTabs/store.ts`,
`backend/src/superTabs/parts/load.ts`

**Interfaces:** `loadNamed(tx, tabId, named, loaded)` in `parts/load.ts`: the groups and starts `named` names that `loaded` lacks.

- [ ] Test: a person with two Buddies, the second quiet; a post in the project chat reads SwarmMachine, SwarmAgent,
      SwarmMember and SwarmProgress once each, and the quiet chat is still loaded (its name stays taken).
- [ ] Watch it fail: two reads each.
- [ ] `ensure` reads only the missing parts and merges them.
- [ ] Watch it pass, with the store's integration tests for Buddies, command loads and hot reads.
- [ ] Measure before and after with `integration/bench/v3ReadCost.ts` on a Swarm with a quiet second Buddy.
