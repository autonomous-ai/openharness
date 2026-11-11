# This Mac is added however its person joined: plan

> Way of working: test-driven, one Engineer, by the project instructions (Engineer role). No Execution Handoff.

**Goal:** a new collaborator's computer is added to the Swarm and offered the Harness Team account once, however they
joined: Desktop's join dialog, an invitation, a domain auto-join on the server, a Workspace-open join, or a join made on
the phone or the web first (task #3160, Scholes 11-05: about a dozen people had to add their machine by hand).

**Architecture:** the join auto-add (`AppNotifier.addMachineOnJoin`, `super_tabs/join_machine.dart`
`SwarmJoinMachine`) ran only from the two join paths in Desktop. Swarm discovery (`SuperTabs.refreshTabs` →
`onTabs`) already lists every Swarm the account is in, however it got there, so it becomes the second trigger. A new
`SwarmJoinSeen` (`super_tabs/join_seen.dart`) remembers, per account on this computer, the Swarms the add was already
decided for; discovery hands it the listed Swarms and gets back the ones new here. For each, the app reads the Swarm,
and when the person is a collaborator records it and runs the same add and Team offer as the join does. The join
paths record the Swarm too, so neither trigger runs it twice. The add's steps are unchanged.

**Tech stack:** Dart, Flutter, flutter_test.

**Spec:** task #3160.

## Global constraints

- The auto-add steps themselves (`SwarmJoinMachine.add`, `offerTeamAccount`) do not change.
- Viewers are never recorded and never added; an owner's Swarm is recorded and left alone.
- Tests use a memory store and a fake sign-in; nothing signs the real CLI in or out.
- Swarm code stays out of `cli/src/core` (nothing there changes).

## Design

- Growth: one Swarm id per Swarm the account belongs to, per account, on this computer. Each full discovery prunes the
  record to the Swarms still listed (plus any recorded in this session, which a list may not show yet).
- Concurrency: one app process owns the record; one pass at a time (a pass still running skips the next discovery),
  and the existing per-Swarm in-flight set keeps the join and discovery from adding at once.
- Read cost: nothing new is read for a Swarm already in the record. A new Swarm is opened once (its snapshot says the
  person's role and the machines in it).
- Scale: 10x Swarms per person is 10x ids in one small local value; the first warning is the pass's opens on a fresh
  install, one per collaborator Swarm, once.
- Compatibility: the first time this build keeps a record for an account, the Swarms already open or hidden on this
  computer are taken as seen, so updating never adds a long-time member's computer to Swarms they chose not to add it
  to. A fresh install has none, so a person who joined on the web first and then installs Desktop is added.
- Migration + rollback: a new local key (`swarm_join_seen.<account>`). An older build ignores it; rolling back leaves
  it unused.
- Audience: the server still decides who may add a machine (`machine.contribute`); the client only decides when to ask.
- Identity: the record and the add are per signed-in account; an account change mid-pass stops it.
- Failure: a step that fails after the person is known to be a collaborator shows the join note with what to do (add
  it from Machines, set up the Team account from Machines), not only a log line.
- Platforms: Desktop on macOS (the Team account is macOS only); on other systems the add stays as it is today.

## Review focus

- That it runs once per Swarm and person, never for a viewer, and never twice when the join dialog and discovery both
  see the same new Swarm.
- That an update does not add a long-time member's computer to Swarms it was never added to.
- That every failed step a collaborator meets ends in a note.

## Tasks

### Task 1: which Swarms are new on this computer

Files: `desktop/lib/super_tabs/join_seen.dart`, `desktop/test/swarm_join_seen_test.dart`.

- [ ] Failing test: the first pass takes the Swarms known here as seen and returns the rest; a recorded Swarm is never
  returned again, also after a restart (a new `SwarmJoinSeen` on the same store); records are per account; a Swarm no
  longer listed is pruned.
- [ ] Implement `SwarmJoinSeen`.

### Task 2: discovery runs the join's add once for a new collaborator Swarm

Files: `desktop/lib/state/app_state.dart`, `desktop/test/swarm_join_any_test.dart`.

- [ ] Failing test: a Swarm first seen through discovery (a domain auto-join) adds this Mac and offers the Team account
  once; a second discovery and a restart do nothing more; a viewer is neither added nor recorded; the join dialog's add
  then discovery adds once.
- [ ] Hook `SwarmJoinSeen` into `onTabs`; share one add path between the join and discovery.

### Task 3: a failed step shows the person a note

Files: `desktop/lib/super_tabs/join_machine.dart`, `desktop/lib/super_tabs/join_machine_note.dart`,
`desktop/lib/state/app_state.dart`, `desktop/test/swarm_join_any_test.dart`, `desktop/test/swarm_join_machine_test.dart`.

- [ ] Failing tests: reading the Swarm failing for a collaborator's join, and the Team offer not answering, each show a
  note saying what to do.
- [ ] Emit those notes; the note reads a Team offer that failed.
