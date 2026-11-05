# What each machine can reach, phase 1 — Implementation Plan

> Task #3047. Worked by the project's Engineer way of working (project instructions, Engineer): each plan task test first,
> its failing test committed before its code; one independent review per review step on the pull request. Desktop (Task 5)
> shares no files with Tasks 1–4 and runs in parallel by its own subagent.

**Goal:** Each machine in a Swarm keeps a short Access list ("Lamp", "Fusion 360", "Email (dee@)") per macOS account; a
task names the access it needs; the route and the backend's start check send the work only to a machine and account that
has it, and say why when not.

**Architecture:** The list rides on the Mac's own contribution (`ContributedMachine.access`, backend), changed one entry at a
time by a new command `machine.access`. Who may see `note` and `check` is enforced in `visibleState`. Placement and refusal
are one helper (`machineAccess.ts`) used by the start (`teamMachineFor`, `admitMachineStart`) and the route-decision check
(`candidateRefusal`); the CLI route applies the same rule to the machine records it already reads. Desktop adds an Access
section to Configure and an Access line to the expanded machine row.

**Tech Stack:** TypeScript (backend, zod, vitest; CLI, node test runner), Flutter/Dart (Desktop).

**Spec:** [docs/design/2026-11-05-machine-access.md](../design/2026-11-05-machine-access.md) (PR #3030), phase 1 of its
section 7, with open questions decided by River (11-05): one list per machine per Swarm; per-entry teammates sharing ships
now behind the own-account warning; a Team account's MCP server comes only through the owner's Configure copy (phase 3,
with suggestions); case-insensitive exact names, the route suggests the closest; entries per machine.

## Global Constraints

- At most 32 entries per machine per Swarm; `name` 1 to 60 characters; `note` and `check` at most 200 characters.
- `account` is `own` or `team`; `team` only on a Mac that has a Harness Team account in this Swarm.
- `state` is `ok` or `unconfirmed` in phase 1 (`notWorking` is phase 2). Only `ok` counts for routing and starts.
- An `unconfirmed` entry is removed 7 days after it was added.
- A name or note that looks like a secret is refused: anything `findCredentials` finds, `-----BEGIN`, `user:pass@`, the
  prefixes `sk-`, `ghp_`, `gho_`, `ghs_`, `github_pat_`, `xox?-`, `AKIA`, or a run of 20+ key-like characters
  (`[A-Za-z0-9+=_-]`) that mixes letters and digits.
- `teammates` is set to true only from the owner's own session (a person actor), never by an agent; an agent never turns
  `production` off.
- `check` is read only by the machine's owner. `note` only by the owner and by agents running on that machine in that
  entry's account (the Mac for `own`, its Team account pool for `team`).
- Names match case-insensitively, trimmed.
- Copy (route and start refusals), exact:
  - `No ${name} here.` + ` Did you mean ${closest}?` (route only, when a close name exists)
  - `${name} on ${machine} is waiting for ${owner} to confirm.`
  - `${name} is in ${owner}'s own account, not shared with teammates.`
  - `${name} is in the Harness Team account on ${machine}, which runs only teammates' work.`
- Swarm code stays out of `cli/src/core`. Desktop tests use a memory store and a fake sign-in.

## Review Focus

1. A teammate's task needing an own-account entry with `teammates` on, on a Mac with a Team account: the start must stay on
   the Mac (not move to the Team account), and the route must offer the Mac, not the Team account. (Task 3, Task 4 tests.)
2. Team-written code needing an own-account entry: it still goes to the Team account, and is refused there for the
   missing entry, never run in the owner's account. (Task 3 test.)
3. An agent of the owner (`machineOwnerId` = owner) on another machine reads no `note`: owner rights are the owner's own
   session only. (Task 2 test.)
4. Saving the contribution again (Desktop's re-save) keeps the list; removing the machine drops it. (Task 1 test.)
5. A task's `requires.access` with a different case or spacing ("  lamp ") matches "Lamp". (Task 3, Task 4 tests.)

---

### Task 1: The list and `machine.access`

**Files:**
- Create: `backend/src/superTabs/machineAccess.ts`
- Modify: `backend/src/superTabs/machines.ts` (`ContributedMachine.access`), `backend/src/superTabs/commands.ts` (schema,
  handler, kept on `machine.contribute`, prune), `backend/src/superTabs/store.ts` (askedIn loaded, refused for Team
  sessions, prune on readings)
- Test: `backend/src/superTabs/machineAccess.test.ts`

**Interfaces:**
- Produces:
  - `interface AccessEntry { id: string; name: string; account: 'own' | 'team'; state: 'ok' | 'unconfirmed'; teammates?: true;
    production?: true; check?: string; note?: string; addedBy: string; addedAt: string; saidBy?: string;
    askedIn?: { conversationId: string; messageId: string } }`
  - `ContributedMachine.access?: AccessEntry[]`
  - `secretLike(text: string): boolean`, `sameAccessName(a: string, b: string): boolean`, `expireAccess(state, now): void`,
    `MAX_ACCESS = 32`, `UNCONFIRMED_ACCESS_MS = 7 * 86_400_000`
  - Command `{ type: 'machine.access', machineId, action: 'add' | 'change' | 'confirm' | 'remove', entryId?, name?,
    account?, teammates?, production?, note?: string | null, check?: string | null, askedIn? }`; result `{ entryId }`.

- [ ] Step 1: failing tests: the owner adds (state ok, addedBy owner, 16-hex id); 33rd refused `ACCESS_FULL`; duplicate name
  in the same account (any case) refused `ACCESS_EXISTS`; `team` on a Mac without a Team account refused; on a Team
  account's own pool `NOT_FOUND`; secret-looking name and note refused `ACCESS_SECRET` (`ghp_…`, `sk-…`, `user:pass@host`,
  `-----BEGIN`, `AKIA…`, a 24-char random run) while "connection info in ~/.argocd/config" and "Email (dee@)" pass; a
  teammate, the Swarm's owner, a Buddy and a Team session refused; the Lead passing on the owner's message from the last
  day in a chat it leads adds `ok` with `askedIn`; the Lead passing on someone else's message, an owner's message older
  than a day, or one in a chat it does not lead adds `unconfirmed` with `saidBy`; with no `askedIn` an agent is refused;
  the PM can never set `teammates: true` (`OWNER_SESSION_REQUIRED`) nor turn `production` off; confirm by the owner (or
  the Lead with the owner's word) sets ok; the Lead removes an unconfirmed entry without the owner's word, but no ok one;
  an unconfirmed entry 7 days old is gone after the next command; re-saving the contribution keeps the list.
- [ ] Step 2: run `cd backend && npx vitest run src/superTabs/machineAccess.test.ts` — FAIL (`machine.access` unknown).
- [ ] Step 3: implement; commit.

### Task 2: Who reads what

**Files:** Modify `backend/src/superTabs/model.ts` (`visibleState`); Test `backend/src/superTabs/machineAccess.test.ts`.

**Interfaces:** Consumes `AccessEntry`. Produces `visibleAccess(state, pool, actor): AccessEntry[]` in `machineAccess.ts`.

- [ ] Step 1: failing tests: the owner's read has `check` and `note`; another member's read has neither; an agent on the
  Mac reads the own entry's note but not the team entry's, an agent on the Team account the reverse; an agent of the owner
  on another machine reads no note and no check; the entries' names, account and state reach every member who sees the
  machine.
- [ ] Step 2: run — FAIL. Step 3: implement; commit.

### Task 3: `requires.access` and the start check

**Files:** Modify `backend/src/superTabs/model.ts` (`TaskRequirement.access`), `commands.ts` (task schema; `agent.start`
and `candidateRefusal` pass the task's access), `machines.ts` (`teamMachineFor`, `teamWorkCheck`, `teamWorkRefusal`
take `access`; `admitMachineStart` refuses); Test `backend/src/superTabs/machineAccess.test.ts`.

**Interfaces:**
- Produces: `accessRefusal(state, machineId, project, needed: string[], ownerName?: string): TeamWorkRefusal | null`
  (code `ACCESS_MISSING`), `sharedOwnAccess(pool, needed): boolean`, `taskAccess(group): string[]`.

- [ ] Step 1: failing tests: a task with `requires: { access: ['Lamp'] }` is stored; a start of an older CLI (no
  `needs.access` anywhere in its request) on a machine without Lamp is refused `ACCESS_MISSING` "No Lamp here."; a
  teammate's start where Lamp is an unshared own entry is refused "… not shared with teammates" and the Team account never
  counts the own entry; with `teammates` on, the teammate's start stays on the Mac, as the owner; Team-written code still
  goes to the Team account and is refused; an unconfirmed entry refuses "… waiting for … to confirm"; the owner's own task
  needing a Team-account entry is refused; "  lamp " matches "Lamp"; a start with no requirement is unchanged.
- [ ] Step 2: run — FAIL. Step 3: implement; commit.

### Task 4: `needs.access` in the route (CLI)

**Files:** Modify `cli/src/superTabs/route.ts` (`Needs.access`, parse), `cli/src/superTabs/routeCommand.ts`
(`taskRequirement().access`, per-candidate refusal, fold, closest name); Test `cli/src/superTabs/routeCommand.spec.ts`.

**Interfaces:** Consumes the machine records' `access` (Task 1 shape, after Task 2's stripping) and `teamWork.ownAccount`.
Produces `accessReasons(pool, macPool, projectOwner, needed, people): string[]` in `routeCommand.ts`.

- [ ] Step 1: failing tests: `needs.access: ["Lamp"]` and a task's `requires.access` both leave out a machine without it
  with "No Lamp here."; "Desk lamp" elsewhere gives " Did you mean Desk lamp?"; a teammate's task is offered the Team
  account's Lamp and not the owner's unshared own Lamp; with `teammates` on the Mac itself is offered (not folded); an
  unconfirmed entry is left out with its line; members on a machine without it are left out too; `startRequirements`
  gains no `access` key (older hosts' strict schema).
- [ ] Step 2: run `cd cli && npx tsx --test src/superTabs/routeCommand.spec.ts` — FAIL. Step 3: implement; commit.

### Task 5: Desktop — Configure's Access and the expanded row

**Files:** Create `desktop/lib/super_tabs/machine_access.dart`; modify `desktop/lib/super_tabs/machines.dart` (Configure
dialog section, expanded row line); Test `desktop/test/super_tab_machine_access_test.dart`.

**Interfaces:** Consumes the pool map's `access` list (Task 1 shape) and sends `machine.access` (Task 1 command) as the
owner, as `machine.ownAccountWork` is sent today.

- [ ] Step 1: failing widget tests (memory store, fake sign-in): the expanded row shows "Access" with "Gray's account: …"
  and "Team account: …", "not working"/"waiting for …" states, "(production)"; a non-owner sees no Configure Access
  section; the owner's Configure lists entries by account with the note under its entry, Add access… opens the add dialog
  (Name, Where, Production system) and sends `machine.access` add; "Teammates may use" asks "Let teammates' work run in
  your account?" naming the entry before sending `teammates: true`, and Cancel sends nothing; Confirm / Not right on an
  unconfirmed entry send confirm / remove; remove sends remove.
- [ ] Step 2: run `cd desktop && flutter test test/super_tab_machine_access_test.dart` — FAIL. Step 3: implement.
- [ ] Step 4: light and dark screenshots of Configure and the expanded row (golden-style screenshot run); commit.
