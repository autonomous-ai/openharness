# A person can have several Buddies (part 1: many Buddies, a default, a cap): implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** A person creates, names and removes several Buddies in a Swarm, one is their default, and a per-Swarm cap bounds
how many (task #3818, requested by Dee through Harness; spec docs/plans/2026-11-06-buddy-board-final-spec.md, "Many
Buddies", approved by Ken and anh Dee 11-06). Sleep and wake, a Buddy on a Team machine, and agents' asks to the default
Buddy are separate tasks (proposed split, in the task's chat).

**Architecture:** Today a person has one Swarm Buddy, and its chat's id is derived from the person alone
(buddies.ts swarmBuddyChatId). Each Buddy gets its own chat; the person's first chat keeps today's id, so their existing
Buddy and history are their first Buddy and default. Every place that wrote to "the" Buddy chat writes to the default
Buddy's chat instead, through three helpers (buddies.ts): `defaultBuddy`, `defaultBuddyChat`, `buddyFor`. Task #3817
(proposal cards) uses `buddyFor` for its notices. The cap is a Swarm setting with a default, set by the Swarm owner.

**Tech Stack:** TypeScript backend and CLI host, vitest.

**Spec:** docs/plans/2026-11-06-buddy-board-final-spec.md ("Many Buddies", "Design").

## Global Constraints

- A person with one Buddy sees no change: same chat, same Buddy, same name.
- The server enforces every right: only the person creates, names, removes or picks the default of their own Buddies.
- Swarm code stays out of cli/src/core. Temp files only in `mktemp -d` folders.

## Design

- growth: Buddies per person per Swarm are capped (default 5); a removed Buddy's chat is archived and its lines go to the
  default. No new collection.
- concurrency: Buddy writes are the Swarm's usual write on the person's chats and agents.
- read cost: unchanged; a Buddy chat is a conversation like any other, read by its owner and its Buddy only.
- scale: 10x people at the cap is 50 Buddies each per Swarm at most; the first warning is machine load, which part 2 (sleep)
  bounds.
- compatibility: an older app sees the person's first Buddy chat as today; a new Buddy's chat appears to it as another chat
  of theirs. An older CLI host starts each Buddy by its start request as today.
- migration + rollback: none: the first chat keeps its id. Rolled back, extra Buddies' chats stay and read as chats.
- audience: a Buddy chat is read by its person and its Buddy only, as today (projects.ts readsRecordsIn).
- identity: a Buddy runs on its person's own machine under their login, as today.
- failure: a refused create (cap, name) says why; a line for a person always has a chat (`defaultBuddyChat`).
- platforms: backend and CLI host (macOS, Linux, Windows); Desktop's list is its own task.

## Review Focus

- No place still writes to a person's Buddy chat by the person alone, except through the helpers.
- The cap and the rights hold on the server.

## Task 1: the default-Buddy helpers (for #3817)

**Files:** backend/src/superTabs/buddies.ts, backend/src/superTabs/buddyDefault.test.ts

**Interfaces:** `defaultBuddy(state, personId): Agent | undefined`; `defaultBuddyChat(state, person): Conversation`;
`buddyFor(state, person, senderBuddyId | null): { agent?: Agent; chat: Conversation }`. None throws.

- [ ] Test: the default is the person's Buddy (never a session's, an older membership's or another person's); there is
  always a chat; a notice goes to the sender while it is still theirs, else the default.
- [ ] Watch it fail; commit.
- [ ] Code (today's behaviour: the one Buddy); watch it pass; commit.

## Task 2: several Buddies, each with its own chat; default; cap

To be detailed once the inventory of one-Buddy assumptions is in (this plan's next commit).
