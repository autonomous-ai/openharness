# Remove Team-account leftovers: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** Swarm v3 has no Team accounts (anh Dee, 2026-11-07; #4120 stopped new work reaching one). Task #4221 removes
what still offers, runs or describes one: nothing offers to set up a Team account, an existing Team account's boot daemon
stops for good on update once no agent runs in it, and the agents' manual, skills and Desktop stop telling people work runs
in one.

**Architecture:**

- Owner's daemon (cli/src/superTabs/service.ts): the four `teamSetup*` actions, `teamAccountsIn` and `sharedSwarm` go, and
  with them cli/src/team/autoSetup.ts, which only they used. A Desktop from before asks them, gets an error, and its own
  catch already treats that as "nothing to offer" (app_state.dart `offerTeamAccount`, `teamSetupProgress`). The read's
  `teamAccounts` flag (swarmReads.ts, readContract.ts, the read fixtures) goes: the backend never sends `false` since the
  allowlist went (#2505), which is why the offer ran in every Swarm.
- `harness team setup` refuses with `TEAM_ACCOUNTS_REMOVED` before it asks for an administrator. `harness team remove`
  stays: it is how a person deletes the account and its home when they choose to.
- The Team account's own daemon (cli/src/superTabs/inCore/teamRetire.ts, new, wired in core/main.ts): when the Team
  config names this OS user (team/config.ts `isTeamAccount`), it stops for good the first time the core has no active
  agent session, checked as it starts and whenever the session list changes. It stops with the core's existing
  stop-for-good exit (`forGood`, a new reason `retired`), so launchd (`KeepAlive.SuccessfulExit false`), systemd
  (`Restart=on-failure`) and the Windows task leave it stopped until the next boot, where it starts, finds no agent and
  stops again. Its files are root's: removing them needs an administrator prompt, which nothing opens unasked
  (AGENTS.md, Windows); `harness team remove` removes them. A computer signed in with `harness team on` is not a Team
  account and is untouched.
- Agents' manual and skills (cli/src/lib/swarmTools.ts, swarmToolSheets.ts, swarmSkills.ts): the Team-account lines go.
- Desktop (desktop/lib): the startup and contribution offers, the setup lock, the Team setup screen
  (super_tabs/team_account_setup.dart) and every Set up button go; copy that says work runs in a Team account is fixed.
  Copy about an existing Team account's machine (offline, refusing a person's own request) stays while such machines exist.

**Tech Stack:** TypeScript CLI (vitest), Flutter Desktop (flutter test). **Spec:** task #4221 brief; anh Dee's Swarm v3
decision (project instructions, PM notes 2026-11-07); docs/plans/2026-11-07-remove-team-accounts-plan.md.

## Global Constraints

- Never delete a person's data: no account, home folder, worktree or session file is removed by an update.
- Stop only what Harness installed: only the Team account's own daemon stops, and only itself.
- Never stop a Team daemon while an agent session is active in it (#4120: Team agents finish what they hold).
- Never read or print a secret or login.
- Owns cli/src/ and desktop/lib/.

## Design

- growth: N/A because nothing new is stored; the Team setup decision file stops being written.
- concurrency: N/A because the stop is one process deciding about itself.
- read cost: one count of the core's in-memory active sessions per session change.
- scale: N/A because no server or query changes.
- compatibility: no backend change. A Desktop from the last 30 days asks the removed actions, gets an error, and offers
  nothing (its existing catch). A Team daemon from before keeps running until it updates to this release.
- migration and rollback: none; revert. A rolled-back Team daemon starts again at its next boot.
- audience: N/A because nothing is exposed.
- identity: N/A because nothing runs under a new login.
- failure: the Team daemon logs `[team] Swarm v3 has no Team accounts: no agent runs here, stopping for good` before it
  stops; `harness team status` says it is stopped and that `harness team remove` removes it.
- platforms: macOS, Linux, Windows (the CLI); macOS, Linux, Windows Desktop. Tested on macOS; CI runs Linux.

## Review Focus

1. A Team daemon with an agent still active is never stopped (an agent reattached after a restart counts).
2. The owner's own daemon on a Mac that has a Team account never stops (the config names another user).
3. A `harness team on` computer (a Team sign-in, no Team config for this user) never stops.
4. A Desktop from before against the new daemon offers nothing and never locks.
5. No Desktop path still opens the Team setup screen (the machine row, the import dialog, the startup ask).

---

### Task 1: the owner's daemon offers no Team account; `harness team setup` refuses

**Files:** Modify cli/src/superTabs/service.ts, swarmReads.ts, readContract.ts, fixtures/read/index.ts, team/command.ts;
delete team/autoSetup.ts and its spec. Test: superTabs/service.spec.ts, team/command.spec.ts.

**Interfaces:** Produces the refusal code `TEAM_ACCOUNTS_REMOVED` (team/command.ts).

- [ ] Test: `teamSetupCheck` for `startup`, `contribute`, `join` and `manual`, with a read that fails, runs no setup and
      answers an error; `teamSetup` and `teamSetupStatus` the same.
- [ ] Test: `harness team setup` answers `TEAM_ACCOUNTS_REMOVED` and runs no administrator script.
- [ ] Watch both fail; commit.
- [ ] Remove the actions, `teamAccountsIn`, `sharedSwarm`, autoSetup.ts and the `teamAccounts` read flag; make setup refuse.
- [ ] Watch them pass with the touched specs (service, swarmReads, team/command); commit.

### Task 2: a Team account's daemon stops for good once no agent runs in it

**Files:** Create cli/src/superTabs/inCore/teamRetire.ts and its spec; modify superTabs/inCore.ts, core/main.ts
(`forGood` and the wiring), team/command.ts (status line).

**Interfaces:** Produces `retireTeamDaemon(deps: { teamAccount: boolean; active: () => number; onChange: (listener: () =>
void) => void; stop: (reason: 'retired') => void; log: (line: string) => void }): void`.

- [ ] Test: a Team account with 0 active stops once with `retired`; with 2 it waits and stops when the count reaches 0;
      a later change does not stop it twice; not a Team account never stops.
- [ ] Test (core): `retired` is a stop for good (the supervised exit is `CORE_EXIT_STOP`).
- [ ] Test: `harness team status` with the daemon installed and not loaded says `harness team remove` removes it.
- [ ] Watch them fail; commit; implement; watch them pass; commit.

### Task 3: the agents' manual and skills say nothing of Team accounts

**Files:** cli/src/lib/swarmTools.ts, swarmToolSheets.ts (lines and their hashes), swarmSkills.ts. Test:
lib/swarmTools.spec.ts.

- [ ] Test: the manual, every role's sheet and every role skill contain no "Team account" or "Team agent".
- [ ] Watch it fail; commit; remove the lines; watch the swarm tool, sheet and skill specs pass; commit.

### Task 4: Desktop offers no Team account and says no work runs in one

**Files:** desktop/lib/state/app_state.dart, app_shell.dart, screens/swarm_screen.dart, super_tabs/machines.dart,
add_computers.dart, import_agent_dialog.dart, import_agent.dart, core/permission_modes.dart, state/new_harness.dart;
delete super_tabs/team_account_setup.dart. Tests: desktop/test/team_account_offer_test.dart (rewritten to the new
rule), team_account_lock_test.dart and team_setup_background_test.dart (deleted with what they pin).

- [ ] Test: at startup and after adding this Mac to a Swarm, Desktop sends no `teamSetup*` request and never locks; the
      machine row and the import dialog show no Set up.
- [ ] Watch it fail; commit; remove the offers, the lock, the screen and the buttons; fix the copy; watch the touched
      tests pass; commit.
