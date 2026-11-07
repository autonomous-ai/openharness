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

- [x] Test: the default is the person's Buddy (never a session's, an older membership's or another person's); there is
  always a chat; a notice goes to the sender while it is still theirs, else the default.
- [x] Watch it fail; commit.
- [x] Code (today's behaviour: the one Buddy); watch it pass; commit.

## Storage

- The person's **main Buddy chat** keeps today's derived id (`swarmBuddyChatId`), so every command can load it by id. It lists
  the person's other Buddy chats (`Conversation.buddyChats`, at most the cap), so they load with it (store.ts loads the
  person's Buddy chats through it wherever it loaded the one chat).
- A new Buddy's chat id is `stableId('buddy', 'swarm', person, generation, operationId)`: unique, never derived by others.
- The **default** chat carries `buddyDefault: true` (one per person). With none marked, the main chat is the default, so a
  person from before has their one Buddy as default with no migration.
- The **cap** is `SuperTabState.buddyCap` (default 5), set by the Swarm owner with `tab.buddyCap`, read by apps in the head.

## Task 2: several Buddies: create with a name, remove one, set the default, the cap

**Files:** backend/src/superTabs/{model.ts, buddies.ts, commands.ts, store.ts, read/views.ts, read/contract.ts,
parts/touches.ts}, backend/src/superTabs/buddies.test.ts, backend/integration/superTabSwarmBuddy.test.ts

**Interfaces:** `buddy.create { …, name?, conversationId? }` (a name and no chat: a new Buddy in a new chat; a chat: that
Buddy again; neither: as today on the default); `buddy.remove { conversationId? }` (that Buddy, else the default; the
default's role passes to the oldest remaining); `buddy.default { conversationId }`; `tab.buddyCap { cap }`; refusal
`BUDDY_CAP`. `defaultBuddy` reads the marked default.

- [x] Test: a second Buddy is created with its name in its own chat; the cap refuses one more; remove and default behave as
  above; only the person acts on their Buddies; a person with one Buddy sees no change.
- [x] Watch it fail; commit. Code; watch it pass; commit.

## Task 3: lines for a person go to their default Buddy; a proposal's news to its sender

**Files:** backend/src/superTabs/{commands.ts (person.tell, instructions notice, machine.moved, switch notice, proposalOf,
startOldChatBuddy, buddyDownLine), decisions.ts, othersWork.ts, buddyNews.ts, leaderboard/stats.ts, buddyModel.ts}

- [x] Test: with two Buddies and the second as default, a PM line, a delegated decision and a move notice go to the second's
  chat; a proposal's news goes to the Buddy that sent it, and to the default once it is removed; a model switch moves only
  the chosen Buddy and its own sessions.
- [x] Watch it fail; commit. Code; watch it pass; commit.

## Task 4: the CLI host with several Buddies

**Files:** cli/src/superTabs/{host.ts (session end's chat, model serve grouping), cards.ts (the dial's default)};
backend read/hostRows.ts and read/contract.ts (`buddyChatId` on a Buddy's host row), commands.ts (an older host's session end
naming the main chat finds the thread in another Buddy's chat).

Left out: the Buddy start prompt's "one Buddy" wording (start.ts), and the leaderboard's credit of a thread session's proposal
(leaderboard/stats.ts creditee), which still folds into the person's first Buddy.

- [x] Test: a second Buddy's thread session ends in its own chat; a model switch groups by the Buddy's chat; the dial shows
  the default Buddy.
- [x] Watch it fail; commit. Code; watch it pass; commit.
