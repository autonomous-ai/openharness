# Hotfix #4558: only the person and their own agent post in their private chat — Plan

> Written by the Engineer and implemented by it, task by task, test first. No Execution Handoff.

**Goal:** A Lead (River, Theo) or any agent other than a person's own agent never posts in that person's private chat with
their own agent. Ships as a backend hotfix ahead of the full fix #4547.

**Architecture:** One server rule in `applyCommand` (backend/src/superTabs/commands.ts): every row a command writes into a
Buddy chat (`isBuddyChat`) must come from the chat's own person or an agent that is their Buddy, else the command is refused
with `PRIVATE_CHAT`, naming the project chat or the task's chat as the place to post. Each path that wrote another agent's row
there stops or moves, so no working command meets the refusal.

**Tech Stack:** TypeScript backend, vitest.

**Spec:** Task #4558 brief; anh Dee in project chat 19:05, 11-07: "I don't want River or Theo to show up in this chat".

## Global Constraints

- Backend only. Nothing the person needs is lost: a proposal's decision, question and shipping show on its card; a decision
  asked of them waits in their Needs you list.
- No schema or stored-data change; old rows stay as they are.

## Review Focus

- No path writes another agent's row into a person's private chat; the person's own agent still posts there.
- The refusal names where to post instead.

## Tasks

### 1. The rule
Files: `backend/src/superTabs/buddies.ts`, `backend/src/superTabs/commands.ts`, `backend/src/superTabs/privateChat.test.ts`
- [ ] Failing test: a Lead's private line (`person.tell`), another project's Lead's line, and an agent's `message.send` into a
      person's Buddy chat are refused with `PRIVATE_CHAT`; the person's own Buddy still posts there.
- [ ] Code: `refuseOthersInPrivateChat` checked over every command's rows in `applyCommand`; `person.tell` from a PM refuses.

### 2. Proposal notices
Files: `backend/src/superTabs/proposalCards.ts`, `proposalClock.ts`, `releases.ts`, `commands.ts`, `store.ts`, `proposalMetrics.ts`
- [ ] Failing test: a Lead's accept, ask, merge, the 30-minute overdue clock and a verified release write no row outside the card.
- [ ] Code: `proposalNotices` and its callers go; the store's delivery exception for them goes.

### 3. The other Lead lines
Files: `backend/src/superTabs/commands.ts`, `decisions.ts`
- [ ] Failing test: a rule-override notice goes to the project chat tagging the person; a decision asked or delegated writes
      nothing in the Buddy chat; the PM-switch and others'-work notices to a machine owner are written by that owner's Buddy.
- [ ] Code: as the test says.
