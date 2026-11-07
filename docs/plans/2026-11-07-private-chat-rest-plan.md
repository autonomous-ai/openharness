# #4547 after the hotfix: what the private-chat rule still needs — plan

> Written by the task's Engineer by superpowers writing-plans, and implemented by the same Engineer task by task, test first.
> No Execution Handoff. Task #4547; on main after hotfix #4558 (PR #3555), stacked on #3548 (task #4525).

**Goal:** anh Dee (11-07): only a person and their own agent post in their private chat, and nothing that needs the person is
lost. The hotfix (#4558) put the rule in code and stopped the Lead lines; this adds what it left out.

**Architecture:** On top of the hotfix's `refuseOthersInPrivateChat` (one rule, unchanged): a PM's proposal question
(`proposal.ask`) also opens a Decision for the person asked, and answering either settles the other; a task a verified release
holds says Shipped on its card; the agent skills and the PM's tools sheet stop teaching `person.tell`, which the server refuses.

**Tech Stack:** TypeScript backend and CLI (vitest), Flutter Desktop.

**Spec:** the brief of #4547; the hotfix's plan (docs/plans/2026-11-07-private-chat-hotfix-plan.md) for what is already done.

## Global Constraints

- One rule: the hotfix's. No second check.
- Old rows stay; backend first; older clients ignore the new fields.

## Review Focus

- A proposal question reaches the person's Decisions and its answer reaches the card, once.
- Shipped means a verified release, never a merge alone.

## Design

- growth: one Decision per proposal question (at most 20 per card), removed with the ledger's weeks; at the per-asker cap the
  question stays on its card only.
- concurrency: the command's transaction; an answer on the card closes its Decision in the same write.
- read cost: none new. scale: bounded as above.
- compatibility: an older Desktop lists the Decision like any other and ignores `shipped`. migration/rollback: none.
- audience: the Decision is the asked person's (answerable). identity: unchanged. failure: refusals are named.
- platforms: backend (Linux), CLI skill, Desktop card (macOS; same Flutter code elsewhere).

## Task 1: A proposal question is a Decision

**Files:** backend/src/superTabs/decisions.ts, commands.ts, store.ts, model.ts, proposalDecisions.test.ts

- [ ] Failing test: proposal.ask opens the person's Decision (default as the option, deadline as its time, agreement as
  mustAgree); answering it answers the card; answering on the card closes it.
- [ ] Code.

## Task 2: Shipped on the card

**Files:** backend/src/superTabs/read/personalTasks.ts and test; desktop tasks card and test; design doc

- [ ] Failing tests: the feed marks a released task shipped, not a merged one; the card says Shipped.
- [ ] Code.

## Task 3: No skill teaches person.tell

**Files:** cli/src/lib/swarmSkills.ts, swarmTools.ts, swarmToolSheets.ts and specs; backend processNotes.ts

- [ ] Failing test: no role's skill, the tools manual or a role sheet names person.tell.
- [ ] Code, with a PM what-changed note.
