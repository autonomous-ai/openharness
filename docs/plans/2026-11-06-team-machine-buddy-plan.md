# One Buddy per person on a Team machine: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** A person with no machine of their own gets one Buddy on one of the Swarm's Harness Team machines. It acts as that
person, never as the machine's owner, and runs on the Team account's subscription until the person signs in their own (task
#3825, requested by Dee through Harness; spec docs/plans/2026-11-06-buddy-board-final-spec.md, "People without their own
machine"; it changes the 10-28 ruling that a Buddy runs only on its owner's own machine).

**Depends on:** #3818 (several Buddies, its cap and chats; PR #3383). Code starts once it is on main.

**Architecture.** Today two checks keep a Buddy off every machine but its owner's own: the server (commands.ts buddy.create
`notOwn`: owner, contributor, no host grant, no Team session) and the host (cli start.ts `buddyOnOwnMachine`: dispatched by its
own host, not a Team daemon, signed in as the Buddy's owner). Both stay for every other case. One new, narrow case:

1. **Server.** `buddy.create` with `teamMachine: true` and a `machineId` that is a Harness Team machine of this Swarm (its pool's
   `hostMachineId`, a `team` session): allowed only for a person who has no machine of their own contributed to the Swarm, at
   most one such Buddy per person (counted in #3818's cap), and recorded on the start and the agent (`buddyOnTeam: true`), with
   the person as `buddyOf` and the Team account as the machine's contributor. Everything it does, it does as its person: its
   commands authorize as the Buddy of that person (buddies.ts requireBuddyCommand), never as the machine's owner.
2. **Host.** A Team daemon launches such a start only when the server's record says so (`buddyOnTeam`, the person, the
   Team machine), in its own private folder under the Team account's home, on the Team account's engine sign-in. It is
   confidential: no observer, not the machine's owner either (the session-confidential rules of buddies.ts and projects.ts).
3. **Sign-in.** When the person contributes a machine of their own, or signs their own engine in, their Team-machine Buddy moves
   there (#3818's restart in a chat, on their machine), and the Team-machine one is removed: one Buddy per person on Team
   machines at most, and none once they have their own.

## Global Constraints

- Identity: the Buddy acts as its person; the machine owner's login, files and rights are never its, and the machine owner never
  watches its terminal.
- Projects not switched behave as today. Every other Buddy still runs only on its owner's own machine.
- Two independent security reviews (rights and identity change).

## Design

- growth: one Team-machine Buddy per person, inside the Buddy cap; removed when they have their own machine.
- concurrency: the Swarm's usual write on the person's chats, the start and the agent.
- read cost: none new.
- scale: Team machines' slots bound how many people can use one; the first warning is a Team machine at its agent cap.
- compatibility: an older host refuses the start (it is not its owner's machine) and says so; the start fails visibly.
- migration + rollback: none; rollback refuses new ones and the existing session keeps running until removed.
- audience: the Buddy's chat stays its person's alone; the server enforces who may create it.
- identity: the person, never the machine owner; the Team account's subscription pays until the person signs in their own.
- failure: no Team machine free, or the person has a machine: refused with what to do.
- platforms: backend; CLI host on macOS (Team accounts are a Mac's), Linux and Windows where Team daemons run.

## Review Focus

- No path lets a Team-machine Buddy act as, or read as, the machine's owner.
- The narrow case cannot be reached by a person who has a machine, or for a second Buddy.

## Task 1: the server allows one Team-machine Buddy for a person without a machine
- [ ] Test first: allowed for a person with no machine; a second refused; refused for a person with a machine; refused on a
  machine that is not the Swarm's Team machine; its commands act as its person.
- [ ] Code.

## Task 2: the Team host launches it, confidential, in its own folder
- [ ] Test first (cli start.spec): launches only with the server's record; nobody observes it; another person's start refused.
- [ ] Code.

## Task 3: it moves to the person's own machine once they have one
- [ ] Test first: contributing a machine, or signing in their own engine, moves the Buddy and removes the Team one.
- [ ] Code.
