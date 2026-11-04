# Machines take agents as memory allows — plan

> Written by the Swarm Engineer (Kiln5) for task #2860, by the project's way of working: plan first, each task test
> first, one review step on the pull request.

**Goal:** A machine's Agents setting is As memory allows unless its owner picked At most N. Joining no longer holds a
machine to the suggested 16; a start is refused only for real lack of free memory, and says so (Dee, 11-04: "remove the
limit"). Mac 3 refused Milo's engineer at 16 of 16.

**Architecture:** Backend only in this pull request (smallest safe change, River 11-04). `ContributedMachine.agents`
(`memory` | `atMost`) is the explicit setting; `machine.contribute` takes it optionally. A row without it (every row
today, and every join from today's clients) is read by `agentLimit`: a stored count equal to the old join suggestion
(16, or one per 4 GiB of the machine's memory) or at least Desktop's old As memory allows maximum (one per 2 GiB, at
least 4) is As memory allows; any other number is the owner's own At most N. Read time, no migration. Admission
(`admitByRoom`) checks the owner's count or, as memory allows, the last reading's free memory against the start's memory
requirement; the host still checks free memory and disk at launch. `availableSlots` (route, plan, Desktop) counts room by
free memory (one per 2 GiB) when memory allows. A Team account copies its Mac's setting.

**Tech Stack:** TypeScript, zod, vitest (backend).

**Spec:** task #2860 brief.

## Global Constraints
- Old clients keep working: `maxAgents` stays a stored number; `agents` is optional on the command.
- Rollback: an older backend ignores `agents` and reads `maxAgents` as before.
- No database change (machines live in the Swarm state document).
- CLI `set-agents` and Desktop's settings dialog sending `agents` follow in a later pull request, after this backend ships
  (an older server refuses the unknown key).

## Design
- growth: one optional enum per machine row, removed with the row. concurrency: the Swarm state's existing write lock.
- read cost: computed from the row in memory. scale: unchanged per read. compatibility and migration: above.
- audience: only the owner's own session contributes (unchanged). identity: N/A, no login used.
- failure: a refused start says the machine is out of free memory, with the numbers. platforms: every host.

## Review Focus
- An owner's own At most N stays a limit; only the old suggestion and the old maximum read as memory allows.
- The memory refusal uses the reading's free memory, not the count.

## Task 1: Agents setting and memory admission
**Files:** `backend/src/superTabs/machines.ts`, `backend/src/superTabs/commands.ts`, `backend/src/superTabs/read/views.ts`,
`backend/src/superTabs/store.ts`, test `backend/src/superTabs/teamRouting.test.ts`.
**Interfaces:** `agentLimit(pool)`, `availableSlots(pool, used)`, `admitByRoom(pool, used, memoryBytes)`, `freeMemoryBytes(pool)`.
- [ ] Failing tests: join stores no fixed count; an old suggested 16 reads as memory allows; an owner's At most N is kept;
      a start refused for memory says so; the route counts room by free memory; a Team account follows its Mac.
- [ ] Watch them fail.
- [ ] Implement; run `npm test -- src/superTabs/teamRouting.test.ts` and the tests of the files that import the changed code.
