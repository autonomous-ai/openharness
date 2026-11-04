# Teammates' work in a Mac owner's own account: plan (backend, PR 1)

**Goal:** a Mac's owner, and nobody else, can let teammates' agents run in their own macOS account on that Mac instead of
always moving to its Harness Team account (task #2806, Scholes, 11-04: the lampOS mobile team needs Flutter and phone
signing, which live in the owner's account on Gray's Mac). The Desktop menu and warning are PR 2 (#2813).

**Architecture:** `machine.ownAccountWork {machineId, allowed, askedIn?}`, shaped as `machine.projects`: the machine's owner
sends it, or the project's Lead passes on the owner's own chat message from the last day (`machineOwnerWord`). It sets
`ContributedMachine.ownAccountChoice = {allowed, by, at}` on the Mac's own entry; never on a Team account's entry, a
Buddy-only machine or one being removed. With `allowed`, `teamWorkRefusal` returns null for that entry (the owner's choice
wins over `SWARM_TEAM_ACCOUNT_REQUIRED` for that Mac only, River 11-04), `teamMachineFor` keeps a teammate's start on the Mac
(unless a Team agent wrote the code, audit H2), and `leadHost` runs a teammate's Product Manager on the Mac. A start still
moved to the Team account returns `moved`, one sentence. The machine reading's `teamWork.ownAccount` and the route's notes
say "<Mac> runs teammates' work in <owner>'s own account."

## Security
- Loosens a privacy guard: two independent security reviews.
- Who may change it: the owner (person session); a Lead only with the owner's own message. Refused: another person (the
  Swarm's owner included), any other agent, a Buddy (refused earlier by the Buddy write rule), a Harness Team account
  session (`store.ts teamCommand`).
- Default unchanged: absent means Team-account-only. `machine.contribute` keeps the choice on re-save (Desktop's join
  re-save included), but not over a removal, so a Mac removed and added again starts at the safe default.
- Agents already running are never moved.

## Design
- growth: one small object per machine entry; removed with the machine.
- concurrency: a command on the Swarm's state, as machine.projects.
- read cost: none new; the reading adds one string.
- compatibility: older clients ignore the new fields; older Desktops never send the command.
- migration + rollback: none; rolling back drops the field's effect (starts move to the Team account again).
- audience: the server checks the caller owns the machine; never trusts the command.
- identity: recorded as the owner's choice (`by`), whoever relayed it.
- failure: a moved start says why; refusals carry a reason.
- platforms: any machine with a Team account entry; Macs today.

## Tests (red first)
`backend/src/superTabs/ownAccountWork.test.ts`, `leadStart.test.ts`, `integration/superTabTeam.test.ts`,
`cli/src/superTabs/routeCommand.spec.ts`.
