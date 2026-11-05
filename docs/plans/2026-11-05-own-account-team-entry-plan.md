# Own-account work never lands in the Team account by its entry: implementation plan

> Written by the Engineer by superpowers:writing-plans and implemented by it, test first
> (superpowers:test-driven-development). No execution handoff.

**Goal:** When a Mac's owner has turned on "teammates' work runs in my own account", a teammate's work that a Harness
Team agent did not write never lands in that Mac's Harness Team account, whether the route offers it or a start names
the Team account's entry directly; and a Team account's entry never goes by the same name as its Mac. Task #3060
(Scholes, from lamp's PM Faye).

**Cause (11-04, 10:51:00Z):** a lamp start named Gray's Team account entry directly. Both of Gray's entries were named
`Gray.local`. The owner's choice (`ownAccountChoice`) is read only on the Mac's own entry (`teamMachineFor` returns
the named machine when it is the Mac with own-account work on), and nothing checked a start that named the Team entry
itself, so the server placed it as named, with no note. The route also still folded the Mac into its Team account for a
teammate's project, offering the Team entry even with the choice on.

**Architecture:**
- Backend `machines.ts`: `ownAccountTeamEntry(state, machineId, project, teamWritten)` answers the Mac's own entry when
  [machineId] is a Team account's entry whose Mac (same contributor) has own-account work on, the project is not the
  contributor's own and the code is not Team-written; else null. `TEAM_ENTRY_LABEL` (` · Team account`) and
  `teamEntryName(pool)`.
- Backend `commands.ts` `agent.start`: a start naming such a Team entry is refused (`OWN_ACCOUNT_WORK`, 409) with a
  pointer to the Mac's own entry (its name and id). Refused rather than moved: moving puts the work into a person's own
  account, with its files and sign-ins, when the start named the isolated account; a refusal changes no account
  silently and the starter picks the own entry knowingly, where the route already notes own-account work.
- Backend `model.ts` `visibleState`: every read shows a Team account's entry as `<Mac> · Team account`; the stored name
  stays the Mac's, which renames and every backend sentence read.
- CLI `routeCommand.ts`: for a teammate's project whose Mac has own-account work on (the server's `teamWork.ownAccount`)
  and whose task is not Team-written, the Team entry is folded and the Mac's own entry offered. Team-written work keeps
  the Team entry. The Team entry's own name from the read is shown, so route rows say `· Team account`.
- Desktop: rows already read the pool's `name`; the Machines list folds a Team account into its Mac's row and shows the
  Mac. Desktop needs a test only where it shows a Team entry's name by itself.

**Tech Stack:** TypeScript (backend, vitest), TypeScript (CLI, vitest), Dart/Flutter (Desktop).

**Spec:** task #3060 brief.

## Global Constraints

- Team account routing is an access boundary: two independent security reviews.
- Team-written work always goes to the Team account (audit H2); nothing here may move it to the own account.
- The owner's own project on their Mac is unchanged.
- No stored name changes: `followAccountName`/`renamedBy` keep Team entries named as their Mac.

## Review Focus

- That no path places a teammate's non-Team-written start on the Team entry while own-account work is on, and that
  Team-written work still never reaches the own account (the route fold, `agent.start`).
- That the read-time name changes no backend decision (backend reads stored names only).

## Tasks

### Task 1: a start naming the Team entry is refused with a pointer (backend)

**Files:** `backend/src/superTabs/machines.ts`, `backend/src/superTabs/commands.ts`, `backend/src/superTabs/ownAccountWork.test.ts`

- [ ] Failing tests: with own-account work on, a teammate's start naming `gray-team` is refused with `OWN_ACCOUNT_WORK`
      naming the Mac's entry; Team-written work naming `gray-team` still starts there; the owner's own project naming
      `gray-team` is unchanged; with the choice off, a start naming `gray-team` starts as before.
- [ ] Implement `ownAccountTeamEntry` and the refusal in `agent.start`.

### Task 2: the route offers the Mac's own entry (CLI)

**Files:** `cli/src/superTabs/routeCommand.ts`, `cli/src/superTabs/routeCommand.spec.ts`

- [ ] Failing tests: with `teamWork.ownAccount` on the Mac, a teammate's task offers `m1` for new agents and not
      `m1-team`; a Team-written task (`teamWritten` on the group) still offers `m1-team` and not `m1`.
- [ ] Implement the fold change.

### Task 3: a Team entry shows a distinct name (backend read, route)

**Files:** `backend/src/superTabs/model.ts`, `backend/src/superTabs/machines.ts`, a backend read test,
`cli/src/superTabs/routeCommand.spec.ts`

- [ ] Failing tests: `visibleState` shows `gray-team` as `Gray's Mac · Team account` and `gray-mac` as `Gray's Mac`;
      the stored name is unchanged; the route's row title for a Team entry ends with `· Team account`.
- [ ] Implement.
