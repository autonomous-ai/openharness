# Swarm v3: remove Team accounts: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** Team accounts go (task #4120, anh Dee's Swarm v3 spec, 2026-11-07): no new agent ever starts in a Mac's Harness Team
account, nothing routes or hands work to one, and the agents already there finish what they hold. Team agents are stopped only
after the 09:00 VN release is out and verified, with their work pushed first (the stop list is in the pull request). This pull
request merges last of the v3 pull requests.

**Architecture:** one gate per way work arrives, each refusing a Team account's entry (`ContributedMachine.hostMachineId`)
with `TEAM_ACCOUNTS_REMOVED`:

- a start: `machines.ts admitMachineStart`, which every start passes (agent.start, a PM's start through leadHost, a crew
  move through crewKeep, a Buddy start), so none lands on a Team account's entry;
- the move into one: `teamMachineFor`, `teamStartRequest`, `ownAccountTeamEntry` and `movedToTeamAccount` are deleted, so a
  start stays on the machine it names; leadHost no longer offers a Team account first;
- routing: route.record's `candidateRefusal` excludes a candidate on a Team account, new or member, with the reason;
- new work: `work.assign` refuses an agent on a Team account, and the dispatch (`freeCrew`) and step picks
  (`reviewerCandidates`) skip it. Its current work stays with it.

Two calls are the PM's (asked in the task, defaults at 02:00 VN): where a teammate's work runs once no Team account takes it,
and who may take a task whose code a Team agent pushed. Each is its own plan task below, done once answered.

What only reads an existing Team account's entry (its privacy check, its readings, its slots) stays until the last Team agent
is stopped; a follow-up removes it then, with the entries.

**Tech Stack:** TypeScript backend (vitest). **Spec:** task #4120 brief (docs/specs/2026-11-07-swarm-v3.md once #V3-backend
writes it).

## Global Constraints

- Never stop or move a Team agent's current work in this pull request; never read a login or credential.
- Identity is the person's own, never the machine owner's.
- Owns backend/src/superTabs/.

## Design

- growth: N/A because nothing new is stored.
- concurrency: inside each command's own write, as the refusals it sits beside.
- read cost and scale: one check of the loaded machine list per start, route candidate and pick.
- compatibility: a new refusal code; a host from before keeps working, and its Team account's entry simply takes no new work.
  The Team-account code that only reads existing entries is removed with them, after the release.
- migration and rollback: none; revert. No data is changed.
- audience and identity: the server enforces it; nothing runs under a new login.
- failure: each refusal says Team accounts are gone and to start on the person's own computer.
- platforms: backend only.

## Task 1: no new work in a Team account

**Files:** machines.ts, commands.ts, leadStart.ts, dispatch.ts, reviewerPick.ts, teamAccountsRemoved.test.ts (new); the
tests that pin the removed moves (teamRouting, leadStart, ownAccountWork, teamWritten) change with them.

- [ ] Tests: agent.start and a PM's start naming a Team account's entry are refused; a teammate's start on a Mac with a Team
      account is never moved there; route.record excludes a Team-account candidate; work.assign refuses a Team-account agent
      and the dispatch and step picks skip it; its current task stays with it.
- [ ] Watch them fail; code; watch them pass; commit.

## Task 2 (the PM's call 1): where a teammate's work runs

- [ ] Tests and code once answered.

## Task 3 (the PM's call 2): a task a Team agent wrote

- [ ] Tests and code once answered.
