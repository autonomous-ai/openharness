# The server writes the status card from task state: plan (task #3593)

> Way of working: the Engineer implements this plan task by task, test first (project instructions, Engineer). No Execution Handoff.

**Goal:** The project's status card is built by the server from task, step, pull request and release state, one line per active task (where it is, what it waits on, owner, time). The PM is no longer woken every 15 minutes to reread task messages and rewrite it. `project.report` stays for the PM's extra lines only.

**Architecture:** Mirror `pulse.ts`. `recordPulse` already runs after every command where every open group is loaded, and writes only on a change, onto the project's chat part (not the head). A new `statusCard.ts` builds the card's lines and `recordPulse` keeps them on the chat as `card`. `visibleState` shows readers `status.text` = the generated lines plus the PM's extra text, so no client changes. The wake-up (`projectUpdateRequest`, the dirty marking in `noteWorkChanges`) is removed.

**Tech Stack:** TypeScript, vitest, `backend/src/superTabs/`.

**Spec:** anh Dee 11-06, Inventory Table A #2 (rules to code). Acceptance: the card has one line per active task with state, last change, what it waits on, owner and time, with no PM call; no card wake-up is sent to the PM.

## Global Constraints
- Swarm code stays out of cli/src/core. No new client contract: `status.text` keeps its meaning (the whole card, at most 2,000 characters).
- A card is written only when its text changes; a progress note, a message or a terminal turn changes no line.
- A project.report with `through` and `text` still works (older PM hosts): it acknowledges and sets the PM's extra text.

## Review Focus
- The sleep sweep and archive still work with nothing marked dirty (`sweeps.ts`, `commands.ts` archive).
- A task's "since" is the time its line last changed, kept by the card, not a message's time.
- The PM's extra text survives a regenerated card and is bounded.
- Readers who cannot read the project chat never get the card or its lines.

## Design
- growth: one line per active task, at most 50 lines and 2,000 characters; a task's line leaves when it ends. The card lives on the project chat part.
- concurrency: the chat part only, as the pulse; no head write per task move.
- read cost: computed after a command from the loaded groups, written only on a change; reads get the stored lines.
- scale: 10x tasks is the 50-line cap; the metric is the card's truncation count (`more` in the last line).
- compatibility: old clients read `status.text` as before; an old PM host's `project.report` still works; stored `dirty` progress is ignored.
- migration + rollback: none to run; the card appears at the next command of each project. Rollback restores the wake-up code; stored cards are ignored.
- audience: the server enforces it in `visibleState` (the card goes only to readers of the project chat).
- identity: no login is read; owners are agent display names.
- failure: a card that cannot be built leaves the last one; nothing else fails.
- platforms: N/A, server text.

### Task 1: build the card lines (`statusCard.ts`)
**Files:** create `backend/src/superTabs/statusCard.ts`, `statusCard.test.ts`.
**Interfaces:** `cardLines(state, project, index, previous, now): CardLine[]` with `CardLine = { id, text, since }`; `cardText(lines, extra): string`.
- [ ] Failing tests: a line per active task with state, what it waits on, owner; steps and merged PRs shown; ended tasks gone; `since` kept while the text is unchanged and moved when it changes; cap.
- [ ] Code.

### Task 2: keep it on the chat and show it
**Files:** `pulse.ts` (recordPulse), `model.ts` (Conversation.card, visibleState), `parts/light.ts` (field list), `commands.ts` (project.report keeps `extra`).
- [ ] Failing tests: the card is on the chat after a command, changes only with a line; readers get `status.text`; the PM's extra text is appended; a reader without the chat gets none.
- [ ] Code.

### Task 3: stop the wake-up
**Files:** `projectUpdates.ts`, `store.ts`, `projectStatus.test.ts`.
- [ ] Failing tests: no update request is ever made, however the work changes; a group archived goes dormant.
- [ ] Code: remove the dirty marking and `projectUpdateRequest` with its store wiring; keep `summarize` for older hosts.
