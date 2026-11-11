# Swarm machine names follow the account name Implementation Plan

> Worked by this project's instructions (Engineer role): plan first in a draft pull request, then each task test first,
> one independent Review step on the pull request. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Swarm machine list shows the name the machine's owner gave it in Machines, follows a rename within one
refresh, and a never-renamed machine keeps its computer name (clients already drop `.local`).

**Architecture:** The Swarm's machine record (`ContributedMachine.name`) is stamped by the server from its contributor's
own account row (`Machine.name`), never from what a client sends. Two places write it: `machine.contribute` (join and
settings saves) and every host reading (the 15 s heartbeat), which the server already authenticates against that same
account row (`MachineHost.owned`). A reading whose pool name differs from the account name takes the full path and
renames the pool and its Mac's Harness Team account pools; the next reading is fast again. Clients keep reading
`machines[].name`; none keeps a copy.

**Tech Stack:** TypeScript, Prisma/MongoDB, vitest with mongodb-memory-server (backend); Flutter 3.47.2 (Desktop).

**Spec:** Task #2308 brief (Dee, 2026-11-03), in the pull request body.

## Global Constraints

- Owner's own machine names only: a teammate's machine shows the name its owner gave it, never anything private.
- The Team account entry keeps its '· Team' suffix after the new name (its account row; in the Swarm a Team pool shows its Mac's name).
- PR body first line: "Requested by dee@autonomous.ai through Harness."
- Before Ready: a test that fails without the fix for every risk, red/green evidence in a PR comment, the full Super Tab integration suite.
- Swarm code stays out of cli/src/core. Desktop tests use a memory store and a fake sign-in.

## Design

- growth: none; one string per Swarm machine record, replaced in place.
- concurrency: the machine part's guarded write, as every reading takes.
- read cost: none added; the account row is already read once per report call (`machineHost`).
- scale: a rename costs one full reading per Swarm the machine is in, then fast again; metric: `machineReportLine` full share.
- compatibility: old clients send a name in `machine.contribute`; the server ignores it when the account row has one. Old hosts unchanged.
- migration + rollback: none; stale names correct themselves on the next heartbeat. Rollback leaves the stamped names, which are correct.
- audience: the name comes from the contributor's own row (`userId = reporter`), so only the owner's choice is shown; Buddies still read no machine names.
- identity: never the machine owner's login; only their machine's display name.
- failure: an account row with no name keeps the pool's current name; nothing fails.
- platforms: Desktop, web and phone read `machines[].name`; no client change.

## Review Focus

- A Team account's reading must not rename its pool to its own row's "<host> · Team" name: it follows its Mac. (Task 2 test.)
- An account row whose name was cleared (null) or is blank keeps the Swarm's current name, never empties it. (Task 1 and 2 tests.)
- A shared (lent) machine reports under its owner; the name is the owner's, never the borrowing contributor's. Covered by the reporter check: `owned` is the reporter's own row.
- The fast path must not keep a stale name forever: a differing name forces the full path once. (Task 2 test checks paths.)
- A renamed Mac's Team pool in the same Swarm shows the new name too. (Task 2 test.)

---

### Task 1: `machine.contribute` takes the account's name

**Files:**
- Modify: `backend/src/superTabs/machines.ts` (add `accountMachineName`)
- Modify: `backend/src/superTabs/store.ts:947-975` (`contribution` returns `machineName`)
- Modify: `backend/src/superTabs/commands.ts:397` (context type), `:1700` (pool name)
- Test: `backend/integration/superTabMachineNames.test.ts` (new; add to `vitest.super-tabs.config.ts`)

**Interfaces:**
- Produces: `accountMachineName(row: { name: string | null } | null | undefined): string | null` — the trimmed name, or null when none.
- Produces: `context.contribution.machineName?: string` — set when the account row has a name.

- [ ] **Step 1: Write the failing test** `a machine joins under its account name, not the name Desktop sent`: account row
  `name: 'Mac 3', hostname: 'Macs-Mac-Studio-2.local'`; `machine.contribute` with `name: 'Macs-Mac-Studio-2'`; the read's
  `machines[0].name` is `'Mac 3'`. And `a never-renamed machine joins under its computer name`: row `name: 'Macs-Mac-Studio-2.local'`
  → `'Macs-Mac-Studio-2.local'` (clients drop `.local`). And a row with `name: null` keeps the sent name.
- [ ] **Step 2: Run** `npx vitest run --config vitest.super-tabs.config.ts integration/superTabMachineNames.test.ts`; expect the first to FAIL with `'Macs-Mac-Studio-2'`.
- [ ] **Step 3: Implement**: `contribution()` adds `machineName` from `accountMachineName(machine)`; the pool's name is `mac?.name ?? context.contribution.machineName ?? command.name`.
- [ ] **Step 4: Run** the same command; PASS.
- [ ] **Step 5: Commit** test, then code.

### Task 2: a reading renames the pool and its Team pools

**Files:**
- Modify: `backend/src/superTabs/machines.ts` (add `followAccountName`)
- Modify: `backend/src/superTabs/store.ts` `fastReading` and `fullReading`
- Test: `backend/integration/superTabMachineNames.test.ts`

**Interfaces:**
- Produces: `followAccountName(state: SuperTabState, pool: ContributedMachine, name: string | null): boolean` — sets
  `pool.name` and each `teamPoolsOf(state, pool)` name to `name`; false (and nothing changed) when `name` is null, the
  pool is a Team pool (`hostMachineId`), or the names already match.

- [ ] **Step 1: Write the failing tests**: `a rename after joining shows on the next reading` — contribute with row name
  'Macs-Mac-Studio-2.local', set the row's name to 'Mac 3', one `observeMachine`; the read's name is 'Mac 3', and the
  swarmChanged push includes the owner. `a renamed Mac's Team pool follows it`: a Team account row (`sessionKind: 'team'`,
  `hostMachineId`, name 'Macs-Mac-Studio-2 · Team') contributed after its Mac; rename the Mac; the Mac's reading renames
  both pools to 'Mac 3'; the Team account's own reading leaves its pool 'Mac 3'. `a cleared name keeps the Swarm's name`:
  set row name null; a reading leaves 'Mac 3'. `the next reading is fast again`: after the renaming reading, `settle` ends 'fast'.
- [ ] **Step 2: Run**; expect FAIL with the old name.
- [ ] **Step 3: Implement**: `fastReading` returns null when `accountMachineName(host.owned)` differs from a non-Team pool's
  name; `fullReading` calls `followAccountName(state, pool, accountMachineName(owned))` before saving.
- [ ] **Step 4: Run** the file, then the whole Super Tab integration suite (`npm run test:super-tabs`) and `npx tsc --noEmit`; PASS.
- [ ] **Step 5: Commit** test, then code.

### Task 3: Desktop's New Project menu shows the Swarm's name

**Files:**
- Test: `desktop/test/super_tab_launch_test.dart`

- [ ] **Step 1: Write the test** `New Project shows a renamed machine by its new name after a refresh`: own pool 'm' named
  'Macs-Mac-Studio-2.local' while this computer's Machine row is also that; the menu row shows 'Macs-Mac-Studio-2'; the
  server's pool becomes 'Mac 3' and the form refreshes (`leadMachinesOf` of a fresh read); the menu row shows 'Mac 3' and no
  'Macs-Mac-Studio-2'. Desktop reads the Swarm's name already, so this pins it rather than failing first; the red/green
  evidence for the fix is Tasks 1–2.
- [ ] **Step 2: Run** `flutter test test/super_tab_launch_test.dart --plain-name 'renamed machine'`; PASS.
- [ ] **Step 3: Commit.**

### Task 4 (review of #2717): a rename in Machines reaches the Swarms at once, and the Team rows

**Files:**
- Create: `backend/src/superTabs/machineRenames.ts` (`onMachineRenamed`, `machineRenamed(rename: MachineRename): Promise<void>`)
- Modify: `backend/src/services/MachineService.ts` `rename`; `backend/src/superTabs/store.ts` (`machineRenamed`); `backend/src/routes/superTabs.ts` (wires the store)
- Test: `backend/src/services/MachineService.rename.test.ts`, `backend/integration/superTabMachineNames.test.ts`

- [x] Failing tests: an offline machine's rename shows in every Swarm with no reading, its Team pool too, members pushed; a cleared name keeps the Swarm's; another person's call changes nothing; the Mac's Team rows become "<name> · Team" (a 40-character name kept whole: the suffix runs past it, as the CLI's does after a 60-character hostname); a cleared name leaves them; a Swarm that cannot be told is logged and the rename still succeeds.
- [x] Implement: the store reads the owner's row itself (never a name passed in) and renames by `followAccountName`; the heartbeat stays the backstop.
