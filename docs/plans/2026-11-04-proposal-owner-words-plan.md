# Proposals post the owner's own words Implementation Plan

> Implemented by the task's Engineer task by task, each failing test committed before its code (project instructions,
> Engineer). Two independent security reviews on the pull request (Buddy guard).

**Goal:** A Buddy's proposal is its owner's own message, delivered (anh Dee, 11-04, task #2926). The project chat shows
the owner's words, or the one line the Buddy showed them and they okayed, in full and posted as the owner. There is no
title cut at 80 characters and no Buddy reply with Goal/Scope under it. The goal, scope and priority stay with the
proposal for the PM and become the task's brief when the PM opens it without one.

**Architecture:**

- `buddy.propose` takes `text`: the words to post, as long as any chat message (32,000 characters). The server posts
  them unchanged as the root of the proposal, authored by the owner. The goal, scope and priority go in the root's
  source (`kind: 'buddy-proposal'`, beside `personId`, `buddyId` and `ownerMessageId`). The root is delivered to the
  PM, as the Buddy's details reply was. No details reply is written.
- The server checks the words. They must be the owner's own, inside the owner's message that asked, or the Buddy's
  own shown line: inside one of the Buddy's messages in the same chat lane (main chat or the same thread). That message
  must come after the owner's previous message and before the ask. Whitespace is collapsed and NFKC applied; nothing
  else is relaxed. Anything else is refused (`PROPOSAL_UNSHOWN`), and the refusal tells the Buddy to show the line
  and wait for the ok. So the Buddy cannot post words its owner never saw, and nothing else from the private chat
  reaches the project chat. The store reads the shown lines from the 50 newest rows of the Buddy chat, the same read
  that already finds the owner's newest message (`store.ts`, `buddy.propose` context). No new query.
- A Buddy on an older CLI sends `title` and no `text`. The server refuses it (`PROPOSAL_TEXT`), naming the new field
  and the show-then-post step, so the Buddy can retry correctly.
- `conversation.create` with `proposalMessageId` and neither `task` nor `brief` takes the proposal's goal, scope and
  priority as its brief. A brief the PM writes wins.
- Old rows still read. A proposal stored before keeps "Let's build: " (`proposals.ts ROOT_PREFIX`, the apps'
  `_oldTaskRootPrefix`) and its details reply (`commands.ts proposalNamed`). Both stay.
- The CLI host adds a new proposal's goal, scope and priority (from its source) to the PM's delivery, so the PM reads
  them without opening the message.
- The Buddy skill (`cli/src/lib/swarmSkills.ts`) and the CLI's command help (`cli/src/superTabs/service.ts`) describe
  the show-then-post step and the owner's voice. The brief mentions a "Desktop byte-for-byte copy" of the skill: there is
  none in `desktop/` (searched for the skill's name and text), so there is nothing to copy.

**Tech Stack:** TypeScript, the backend's Vitest unit and integration suites, the CLI's Vitest specs.

**Spec:** task #2926's brief.

## Global Constraints

- The Buddy still posts only after its owner's ok in its chat: the ask checks (`ownerMessageId`, newest or within the
  hour, once per ask) stay as they are.
- Nothing from the private Buddy chat goes into the project chat except the okayed line. The goal and scope are written
  by the Buddy from what the owner agreed to send, as before, and are readable by the project's readers, as the details
  reply was.
- Swarm code stays out of `cli/src/core`. No schema or index change.

## Design

- growth: N/A because no new rows: a proposal writes one row in place of two.
- concurrency: as today: the command runs in the tab's write with its touched parts.
- read cost: no new read. The shown lines come from the 50 rows the propose context already reads, now with their text.
- scale: N/A because the check reads at most 50 rows of one Buddy chat, once per proposal.
- compatibility: an older Buddy (no `text`) is refused with the steps to fix it. Old rows read as before. Older apps show
  the root's text like any message. Older PM CLIs get the root delivered and read its source with `message`.
- migration + rollback: no migration. A rollback brings back the title-and-reply proposals. Rows written in between
  carry their goal and scope in their source, and older servers ignore it.
- audience: the server checks the words against the owner's messages and the Buddy's own messages in the owner's chat.
- identity: the root is authored by the Buddy's owner at their membership, as today. No login is used.
- failure: each refusal says what to do. No proposal is half-posted, because the command writes or fails as one.
- platforms: N/A because this is backend and CLI text only.

One side effect, stated here: the chat's "✋ Proposal" tag came from the thread summary, which only existed because
the Buddy's reply was in the thread. A proposal now has no reply until someone answers it, and the PM's answer marks it
answered. So the tag no longer shows in the main chat. The Tasks view's Proposals column still lists every open
proposal (`proposals.ts`, which counts a root with no reply as open).

## Review Focus

- `PROPOSAL_UNSHOWN`: can a Buddy get words its owner never saw into the project chat? Look at another thread's line,
  a line shown after the ok, another Buddy's or the PM's line in the chat, or a system row.
- The root is still authored by the owner only after every ask check passes.
- The delivery: the PM, and only the PM, is woken by the root.

## Task 1: a proposal posts the owner's okayed words in full, with no Buddy reply

**Files:** `backend/src/superTabs/commands.ts`, `backend/src/superTabs/buddies.ts`, `backend/src/superTabs/store.ts`,
`backend/src/superTabs/buddies.test.ts`, `backend/src/superTabs/proposals.test.ts`, the Buddy integration tests.

**Interfaces:** `buddy.propose { text }`. `CommandContext.proposalAsk.{ text, shown }`. `okayedWords(text, ask)` in
`buddies.ts`.

- [ ] Red: a proposal with text over 80 characters posts that text unchanged as its owner, delivered to the PM, with
      goal, scope and priority in its source and no second row in the project chat.
- [ ] Red: words not in the owner's ask and not in a line the Buddy showed before it are refused. Lines in another
      lane, lines after the ask, lines before the owner's previous message and other authors' lines don't count.
- [ ] Red: a proposal with no `text` (an older Buddy) is refused with the new step.
- [ ] Red: an old "Let's build: " root still reads as a proposal without its prefix, and a long new one reads in full.
- [ ] Code: schema, store context, the check, the root, no details row.
- [ ] Run the changed unit tests. Update the integration tests that propose.

## Task 2: the proposal's goal and scope become the task's brief

**Files:** `backend/src/superTabs/commands.ts`, `backend/src/superTabs/buddies.test.ts`.

- [ ] Red: `conversation.create` naming the proposal with no task and no brief gets the goal, scope and priority as its
      brief. A brief the PM writes is kept.
- [ ] Code.

## Task 3: the PM's delivery carries the details, and the skill says show, then post

**Files:** `cli/src/superTabs/host.ts` and its spec, `cli/src/lib/swarmSkills.ts` and its spec,
`cli/src/superTabs/service.ts`.

- [ ] Red: a delivered `buddy-proposal` root shows its goal, scope and priority after the text.
- [ ] Red: the Buddy skill tells the Buddy to show the exact line ("I'll post this as you: …") and wait for the ok.
      It says the words go as the owner's own, in full, and that no reply is posted.
- [ ] Code. Run the changed specs.

## Task 4: close a proposal by hand (River, 11-04, added to this task)

Of 47 proposals listed as open, 43 were long built or answered: 25 before threads existed, 14 opened as tasks without
the proposal's link. The open rule can't see either.

**Files:** `backend/src/superTabs/commands.ts`, `proposals.ts`, `store.ts`, `model.ts`, their tests,
`backend/integration/superTabBuddies.test.ts`, `cli/src/lib/swarmTools.ts` and its spec.

**Interfaces:** `proposal.close { projectId, messageId, reason }` (reason 1 to 200 characters). Allowed for the project's
coordinator or a person who reads the project, as `note.remove` is. `CommandEffects.closedProposal`.
`proposals.ts closeProposal`.

- [ ] Red: the command closes only a Buddy's proposal in that project's chat. It posts nothing and is refused to
      another project's PM and to a Buddy.
- [ ] Red: a closed root is left out of the read, the seed's scan included. Its row (sequence -2, `closed` with reason,
      by and at) is never forgotten or seeded open again.
- [ ] Code. The swarm tools skill lists the command.

Design for this task: growth is one kept row per closed proposal, removed with its Swarm. The only new read is the
seed's check by `_id`, once per chat. Compatibility: an older server ignores the closed row (sequence -2 is below what
it lists). The chat's "✋ Proposal" tag on an old proposal with a Buddy reply stays: clearing it would take a post in
its thread.
