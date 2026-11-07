# Only a person and their own agent post in their private chat: implementation plan

> Written by the task's Engineer by superpowers writing-plans, and implemented by the same Engineer task by task, test first
> (project instructions, Roles › Engineer). Task #4547; builds on #4525 (PR #3548).

**Goal:** anh Dee (11-07 18:28): River and Theo showed up in his private chat with his own agent. Only the person and their
own agent post in a person's Buddy chat; what needs the person lands in Decisions, progress on the card.

**Architecture:** One rule in the store's message write (`writeMessages`, and the native turn write): a row into a Buddy chat
is refused unless its author is that chat's person or their own Buddy. Every server path that wrote there as someone else
changes: a Lead's private line (`person.tell`) is refused with where to go instead (decision.ask, or the project chat); a
rule-approval notice goes to the project chat; proposal notices (decided, needs you, shipped, overdue), a delegated decision's
line, a direct ask's line and a task's shipped line stop (the card and Decisions already show them); a proposal question
(`proposal.ask`) also opens a Decision for the person asked, which answers the card's question; Swarm notices about the
person's own machines (others' work, PM switch, Buddy moved) are written as their own Buddy, and skipped when they have none.
Old rows stay in the history.

**Tech Stack:** TypeScript backend (vitest, MongoDB), CLI skill text.

**Spec:** the brief of #4547 (conversation a85df00ad2cc35f447b95db1).

## Global Constraints

- The rule is in the write path every message takes, so a new path cannot skip it.
- Nothing that needs the person is lost: a question becomes a Decision; a notice that needs nothing goes to the card or the
  project chat.
- Old notices stay; no migration.

## Review Focus

- No path writes into a person's Buddy chat as anyone but them or their own Buddy.
- A proposal question reaches Decisions and answering it there answers the card.

## Design

- growth: one Decision per proposal question (at most 20 per card, MAX_CARD_QUESTIONS), removed with the ledger's weeks.
- concurrency: the command's transaction; a decision answered on the card is closed in the same write.
- read cost: no new reads.
- scale: fewer rows (notices stop).
- compatibility: backend only; older Desktops show the new Decisions as any other. An older Lead skill still sends person.tell
  and is told what to use.
- migration and rollback: none; rolling back restores the notices.
- audience: the server enforces the rule at the write.
- identity: Swarm notices are written as the person's own Buddy, never as another account's agent.
- failure: a refused write fails its command with PRIVATE_CHAT, naming the source kind only.
- platforms: backend (Linux), CLI skill.

## Task 1: The rule at the write

**Files:** backend/src/superTabs/privateChat.ts (new), store.ts, native.ts, privateChat.test.ts

- [ ] Failing test: a row into a Buddy chat by a Lead, another person or another person's Buddy is refused; by the person or
  their own Buddy it passes; person.tell is refused with decision.ask and the project chat named.
- [ ] Code: `checkPrivateChat(state, drafts)`, called by writeMessages and the native write; person.tell refused.

## Task 2: Lead lines stop or move

**Files:** commands.ts, decisions.ts, proposalCards.ts, proposalClock.ts, releases.ts, buddyNews.ts and their tests

- [ ] Failing test: proposal decide/ask/merge/ship, the 30-minute overdue, a delegated or direct decision, a task shipped and a
  rule-approval write nothing into a Buddy chat; the rule-approval goes to the project chat.
- [ ] Code: remove those writes.

## Task 3: A proposal question is a Decision

**Files:** proposalCards.ts, decisions.ts, commands.ts, store.ts

- [ ] Failing test: proposal.ask opens a Decision for the person asked (its default as the option, a typed answer for any
  other, its deadline as the default time, required agreement as mustAgree); answering it answers the card; answering on the
  card closes it.
- [ ] Code.

## Task 4: Swarm notices as the person's own Buddy

**Files:** commands.ts, othersWork.ts, buddyModel.ts

- [ ] Failing test: others' work on your machine, a PM moved to your account and your Buddy moved are written as your own
  Buddy, and not at all without one.
- [ ] Code.

## Task 5: The Lead skill

**Files:** cli/src/lib/swarmSkills.ts and its spec

- [ ] Failing test: no skill tells an agent to send person.tell.
- [ ] Code.
