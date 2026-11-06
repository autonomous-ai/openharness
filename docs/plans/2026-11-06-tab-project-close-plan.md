# A closed tab's Personal project: deleted when empty, archived otherwise: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** One server command, `project.closeTab { projectId, tabOperation }`, that the person's Desktop sends when a no-repo tab closes
(#3903): in the caller's own Personal Swarm, a tab's project is deleted if none of its conversations has a message at that
moment, and archived (read-only, out of the sidebar) otherwise. Anything else is refused (task #3929, requested by Diego
through Harness).

**Architecture:** A tab's project is created with the operation id `personal-tab-<hash>` (desktop personal_projects.dart
`personalProjectOperation`), which becomes its id (commands.ts `project.create`). The command:

- **Who and what:** a person, the Swarm's owner, in their own Personal Swarm (`deletion.ts isPersonalSwarm`); a project with no
  repository whose id is the one `project.create` made from `tabOperation` (a `personal-tab-…` request) and this caller. A
  project's id is a hash of the Swarm, its sender and the request, so this proves it is the caller's tab's project, with no
  marker stored, and covers tab projects made before. A repo project (`personal-repo-`, or any with a repository), another
  Swarm, another person, or an agent: refused, in the words a missing project gets.
- **Empty:** every conversation of the project, dormant ones loaded (the command names its project, as `project.delete`
  does), has `lastMessageSequence` 0. Then it is deleted exactly as `project.delete` deletes (its agents, starts, machines'
  lists). Otherwise the project is marked `archived: true` and each of its conversations archived, its Lead chat included,
  and its agents leave; posts there are then refused (store.ts: an archived conversation is not written).
- **Atomic:** the check and the delete are one write. A message written meanwhile changes the same conversation part, so the
  two writes conflict and the command runs again on the new state, which archives instead.
- **Idempotent:** Desktop sends it under one operation id from every computer: the receipt replays the first answer
  (`result.outcome`: `deleted` or `archived`).

**Tech Stack:** TypeScript backend, vitest, Mongo integration.

## Global Constraints
- Never a repo project, never another person's Swarm or project, never a project with a message: the server decides.
- Two independent security reviews (it deletes data).

## Design
- growth: removes data; an archived project stays, as before closing, and leaves the sidebar.
- concurrency: the project's conversation parts and the head, in the Swarm's usual write; a concurrent message conflicts.
- read cost: the project's own groups, dormant ones included, by its id, as `project.delete` reads them.
- scale: one command per closed tab; no scan.
- compatibility: a new command; older apps never send it; an archived project reads as a project with `archived` set.
- migration + rollback: none. Rollback leaves archived projects archived; nothing is read differently.
- audience: the Personal Swarm's owner alone, enforced by the server.
- identity: the person's own command; no agent may send it.
- failure: a refusal says the project is not there; a race archives rather than deletes.
- platforms: backend; Desktop's #3903 sends it.

## Review Focus
- No path deletes a project with any message, a repo project, or one outside the caller's own Personal Swarm.

## Task 1: the command
- [x] Test first (unit): an empty tab project is deleted; one with a message is archived (project and conversations, read-only);
  a repo project, another person, an agent and a Swarm that is not Personal are refused.
- [x] Test first (integration): a message sent during the call archives it instead; the same operation id twice is a no-op.
- [x] Code.
