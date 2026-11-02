# Personal Swarm lists all of the person's own machines: Implementation Plan

> Way of working: this project's instructions. The Engineer implements it task by task, each failing test committed before its code. Security Reviewers: Luna and Cleo.

**Goal:** Every machine the person owns and has linked is in their Personal Swarm, with offline ones listed as offline, never a Harness Team account's or anyone else's.

**Architecture:** A sync beside `PersonalProjects`, run by the same trigger: on each change of the person's own Personal Swarm. It adds machines one at a time by `contributeComputer`, as Add machine does, with the same wait on failure. A machine that is offline cannot be set up (its folder and engines come from it), so it is listed in the Machines section until it comes online, then added.

**Tech Stack:** Flutter, `test/support/super_tab_fixture.dart`.

**Spec:** Task #2181 (Dee).

## Global Constraints

- Only machines with `!isTeamAccount`, `!belongsToOtherAccount`, `!needsLink`.
- Only in Personal while it is the person's alone, as `PersonalProjects.eligible` says: never a Swarm anyone else is in.
- One request at a time; a failure waits as the projects sync does, doubling up to 5 minutes.
- No Team account is offered for a machine added this way.
- The server still decides: `machine.contribute` refuses anyone but the machine's owner.
- PR body starts: `Requested by dee@autonomous.ai through Harness.`
- Tests use a memory store and a fake sign-in. No real account or Mac is touched.

## Review Focus

- A person removes a machine from Personal: it must not come back by itself. Every machine this sync has seen in the Swarm is remembered per account, and a remembered one not in the Swarm is left out.
- Someone else joins Personal: nothing more is added, and the offline rows go.
- Access lost or sign-out during an add: its answer changes nothing, and the next account's machines are never read under the last one's list.
- A machine becoming shared or a Team account between the read and the add: the list is read afresh before each add; the server refuses anyone but the owner.
- A machine that keeps failing to set up: it does not hold back the others, and its failure shows on its row.

## Design

- **Growth:** one remembered id per machine per account, in `super_tab.machines.<account>`, swept with the account's other keys. Bounded by machines linked; a Swarm holds at most 32.
- **Concurrency:** one sync per account and Swarm; a change during one runs it again. `machine.contribute` is one operation per setup id, so another computer's sync adding the same machine ends in one record.
- **Read cost:** no new server read: machines come from what the app already reads, the Swarm from its snapshot. One set of prepare, read and contribute per machine, once.
- **Scale (10x):** up to the 32 machines the server allows. What warns first: `MACHINES_FULL`, shown on the row.
- **Compatibility:** old and new clients: an older client only adds its own computer, as now. No server change.
- **Migration + rollback:** none. Machines added stay in the Swarm after a rollback, and can be removed one by one.
- **Audience:** the server enforces ownership (`OWNER_REQUIRED`), and the client's filter keeps a shared or Team machine from being asked at all. Offline rows are the person's alone, drawn on their own client from their own list.
- **Identity:** the person's own sign-in; never a Team session.
- **Failure:** shown on the machine's row, and tried again after a wait. Nothing is dropped silently.
- **Platforms:** Desktop and web share this code; on the web there is no local machine, so all machines come by this path. Mobile unchanged.

---

### Task 1: The sync adds the person's own machines

**Files:**
- Create: `desktop/lib/super_tabs/personal_machines.dart`
- Modify: `desktop/lib/super_tabs/workspace.dart`, `desktop/lib/super_tabs/account_keys.dart`
- Test: `desktop/test/super_tab_personal_machines_test.dart`

**Interfaces:**
- Consumes: `contributeComputer`, `PersonalProjects.eligible`.
- Produces: `PersonalMachines.of(app).sync(c)`, `.waiting(c)`: rows `({String machineId, String name, String status})`.

- [ ] **Step 1: Commit the failing tests:** Personal opened on one Mac adds the person's other linked machines, one at a time; skips a Team machine, a teammate's and an unlinked one; adds nothing with someone else in it; a machine the person removed stays out; a failure waits and does not hold back the next.
- [ ] **Step 2: Watch them fail.**
- [ ] **Step 3: Commit the code.**

### Task 2: Offline machines are listed

**Files:**
- Modify: `desktop/lib/super_tabs/machines.dart`
- Test: `desktop/test/super_tab_personal_machines_test.dart`

**Interfaces:**
- Consumes: `PersonalMachines.waiting`.
- Produces: `ValueKey('super-personal-machine-<id>')` rows.

- [ ] **Step 1: Commit the failing tests:** an offline machine shows a row reading Offline; online, it is added and the row is gone; a failure shows on its row; no row with someone else in the Swarm.
- [ ] **Step 2: Watch them fail.**
- [ ] **Step 3: Commit the code. Mark the pull request ready, and message Luna and Cleo in their steps.**
