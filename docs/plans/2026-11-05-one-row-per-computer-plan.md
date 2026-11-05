# One row per computer — Plan

Written by the writing-plans skill's format; implemented by its Engineer task by task, test first (project instructions,
Engineer). No Execution Handoff.

**Goal:** A computer shows once in a Swarm's Machines, under the account signed in on it now. When another account signs
in there, the computer's entry moves to that account: the old account's entry, its agents and its Team entry leave, the old
owner is told, and the new entry says "Was kelvin until 5 Nov". Existing duplicates are cleaned once. A Mac whose Harness
Team account still serves the old account says so, and Set up repairs it.

**Architecture:** Account rows (`Machine`) are per account and computer (`MachineService.resolveOrCreateForComputer`); the
computer is `Machine.computerId`, a random id minted once in `~/.harness/computer-id` and stamped on every connect
(`lib/adapterWs.ts`). A connect that is not a Team session tells the Swarm code, as a rename does (`machineRenames.ts`
→ `store.machineRenamed`): new `computerMoves.ts` → `store.computerSignedIn`. The store finds the other accounts' live rows
on that computer (new index), the Swarms each is in (`machineSwarms`), and in each runs the store-only command
`machine.moved` as that entry's old owner, with `context.computerMove` it read itself. The one-time cleanup runs the same
store call for the newest-connected row of every computer that has rows of two or more accounts.
The Team half: Desktop's row already gets `TEAM_ACCOUNT_REQUIRED` from the server for the new account's Mac while the
local daemon answers `exists` (its Team account serves the old account). That pair now reads "Harness Team on this Mac
works for another account" with Repair, which runs `harness team setup --json --sign-in-again` behind the system's
administrator prompt: the Team account signs in for the account here, the old Team sign-in is ended, and the row updates
when its new Team entry reports.

**Tech Stack:** Fastify backend, Prisma on MongoDB, vitest; Flutter Desktop (widget tests, memory store, fake sign-in);
CLI TypeScript (node:test specs).

**Spec:** Task #3122 (Scholes, 11-05; #3118 folded in).

## Global Constraints

- One way: the move reuses the removal of agents and Team entries `machine.remove` does (`removeMachine` in
  commands.ts), never a second copy of it.
- Nothing from a client decides a move: which entries share a computer, who owns each and whether one is online are
  read by the store from account rows and the Swarm's own readings. `machine.moved` sent by a client is refused.
- An entry with a fresh reading is never moved (two live accounts on one computer id is no switch).
- Nothing granted to the old owner carries over: projects, own-account choice, Lent ledger, engine failures, the week
  told, shares (per machine id already). The new entry is Team-account-only (teammates' work only through a Team account
  whose privacy check passed), as Desktop's join adds a computer.
- A moved entry records no removal of the person's (`removedMachines`) and no folder cleanup for the old host: the
  computer and its Swarm folders stay; the new account's host serves them.
- Production write: the cleanup script is dry-run by default; `--write` only in the release Ken says go for.
- Swarm code stays out of `cli/src/core`. Desktop tests use a memory store and a fake sign-in; nothing signs the Mac out.

## Review Focus (two security reviews)

- Who can take over a computer's entry: a member who connects with another person's computer id. The id is local
  (`~/.harness/computer-id`), never in a Swarm read; a move needs the old entry offline; the old owner is told in their
  Buddy chat; their next connect on that computer moves it back. Reviewers judge whether that bound is enough.
- Whether the old owner's agents, Team entry, grants or Team sign-in survive a switch.
- That `machine.moved` cannot be sent from outside the store.

## Design (feature design rules)

- **Growth:** `previousOwner` is one `{ personId, until }` per entry, replaced by the next move, gone with the entry. The
  new index has one key per account row, deleted with it.
- **Concurrency:** one Swarm transaction per move, through `executeOnce` (revision check and retry), as renames go one
  Swarm at a time.
- **Read cost:** a connect reads one indexed query (`machines` by `computerId`); only when another account's row is
  there, the Swarm index by machine id (`machineSwarms`, capped at 500); only those Swarms load.
- **Scale (10x):** rows per computer stay a handful. First warning: the per-Swarm failure log line
  (`[swarm] a computer move did not reach a Swarm`), and connect time, which does not wait for the move.
- **Compatibility:** `previousOwner` is a new optional field; older clients ignore it. Older Desktops still show one
  row once the move happens. `--sign-in-again` exists in released CLIs; Desktop sends the new `signInAgain` flag only to
  a daemon that reports it understands it (the flag is ignored by older daemons, which answer `exists` as today).
- **Migration + rollback:** the index is created by `db push` in the release; rolling back leaves an unused index
  (harmless) or drops it. The cleanup prints every entry it moves as JSON; rollback is the owner's Add machine, or
  restoring those entries from that output.
- **Audience:** the server derives every fact; only the store sets `context.computerMove`.
- **Identity:** each account's work runs only under its own login; the moved entry is the new account's own machine.
- **Failure:** a Swarm that fails is logged and retried by the next connect; groups whose agents left say so; the old
  owner is told; a Repair that fails says why on the row.
- **Platforms:** backend (Linux); Desktop on macOS (row, Repair); CLI on macOS, Linux and Windows (Team sign-in again).

## Tasks

### 1. Index and lookup of a computer's other accounts
**Files:** `backend/prisma/schema.prisma`, `backend/src/superTabs/computerMoves.ts` (new), its test, integration plan
test.
**Interfaces:** `otherAccountsOnComputer(db, { computerId, ownerId, autonomousEnv }) → Array<{ machineId, userId }>`
(live, remote, not Team rows).
- [ ] Failing test: rows of another account on the same computer are found; the owner's own, Team rows, deleted rows,
  other computers and other environments are not.
- [ ] Code + `@@index([computerId])`; integration test reads the plan: IXSCAN on it.

### 2. `machine.moved`: one Swarm's entry moves (backend commands)
**Files:** `backend/src/superTabs/commands.ts`, `machines.ts` (`previousOwner` on `ContributedMachine`),
`computerMoves.test.ts`.
- [ ] Failing tests:
  - another account's sign-in leaves exactly one entry, the new account's, with `previousOwner` naming the old owner and
    the time; its name, folder, engines, slots and pause carried; Team-account-only;
  - the old owner's agents on it and on its Team entry are removed, their groups told, a task with no agent says so, a
    pending start fails; the old owner gets one line in their Buddy chat;
  - none of the old owner's grants carry over (projects, own-account choice, Lent, told week);
  - an entry with a fresh reading is not moved; an entry being removed is not moved;
  - a new account that is not in the Swarm: the old entry goes, nothing is added; a machine the new account took out
    (`removedMachines`) is not added; the per-person machine limit holds;
  - sent by a client (no store context), it is refused; run twice, the second changes nothing.
- [ ] Code: the command, reusing `removeMachine` (no cleanup record, no `removedMachines`).

### 3. Connect tells the Swarms (backend store + adapter)
**Files:** `backend/src/superTabs/computerMoves.ts`, `store.ts` (`computerSignedIn`), `routes/superTabs.ts`
(listener), `lib/adapterWs.ts` (one call after the connect write, not awaited, never for a Team session).
- [ ] Failing test (store, memory DB): kelvin's entry in two Swarms, ttkhoahcmus connects on the same computer → each
  Swarm has one entry, ttkhoahcmus's, and kelvin is told in each; a second connect changes nothing.
- [ ] Code.

### 4. One-time cleanup of existing duplicates
**Files:** `backend/scripts/swarm-computer-moves/run.ts` (new), its test.
- [ ] Failing test: a Swarm with the three entries of the reported Mac (kelvin, ttkhoahcmus, kelvin's Team entry) ends
  with ttkhoahcmus's alone; run again, nothing changes; dry run writes nothing.
- [ ] Code: computers with rows of two or more accounts (aggregation on the new index), newest `lastSeenAt` wins,
  `store.computerSignedIn` for it.

### 5. Desktop: history note, and a Team account serving another account
**Files:** `desktop/lib/super_tabs/machines.dart`, `desktop/lib/super_tabs/model.dart` if needed, tests in
`desktop/test/super_tab_team_machine_test.dart` and a machines row test.
- [ ] Failing widget tests: a row with `previousOwner` says "Was kelvin until 5 Nov"; a row the server marks
  `TEAM_ACCOUNT_REQUIRED` whose daemon says `exists` reads "Teammates' agents paused: Harness Team on this Mac works for
  another account" with Repair; Repair asks the daemon to sign the Team account in again; after it the row reads the new
  status.
- [ ] Code. Light and dark screenshots for the pull request.

### 6. CLI: Set up signs the Team account in again when asked
**Files:** `cli/src/superTabs/service.ts` (`teamSetup` action takes `signInAgain`), `cli/src/team/autoSetup.ts`
(`offer` runs setup with `--sign-in-again` when the account exists), specs.
- [ ] Failing spec: a manual offer with `signInAgain` on an existing account runs `team setup --json --sign-in-again`
  and answers `started`; without it, `exists` as today.
- [ ] Code.

### 7. Old account's sessions on the computer
**Files:** `cli/src/superTabs/host.ts` if needed.
- [ ] Check whether Swarm sessions of the previous account survive another account's sign-in (the daemon restarts). If
  they do, failing spec then code: the host stops the Swarm sessions of a machine id that is not its own.

## Evidence for the pull request

Red/green per task in a pull request comment; backend unit suite in CI; CLI team specs and Desktop widget tests on macOS
run locally; screenshots of the changed rows in light and dark.
