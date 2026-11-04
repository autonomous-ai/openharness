# No "machine left the Swarm" lines in chats: plan

> Way of working: the project's Engineer role. Plan first, then each task test first (writing-plans, test-driven-development).

**Goal:** anh Dee (11-04, #lamp-gtm on the phone): "remove these messages". These are the lines
"<machine> left the Swarm: its host confirmed its cleanup." and "... it is offline. It cleans up when it next connects.",
posted in every project chat as the machine's owner. New ones are no longer written. The ones already stored disappear from every
chat, preview and unread count.

**Architecture:** all on the backend. `machines.ts removalEnded` writes the lines (source kind `machine-left`). It goes away,
and removals end exactly as before, without a line. Every read decides per row kind who may see a stored row, at read time
(`model.ts NOTICE_READERS` through `agentOnly`: pages, the inbox's latest preview, Activity, mentions, deliveries). With
`machine-left` read by nobody (`agent`; these rows have no recipients), the stored rows are hidden from Desktop, web and
every phone build already installed, with no app release. One catch: a chat whose newest main row is such a line keeps
`lastMainSequence` at it. An app marks read only up to the newest row it sees, so that chat would stay unread on the phone
(which counts by `lastMainSequence`). `SwarmReads.markRead` therefore reads through hidden rows: a mark up to the newest
row the person can see moves on to `lastMainSequence` when no main row they can read lies between.

**Tech Stack:** TypeScript backend (vitest unit tests, MongoDB integration tests).

**Spec:** task #2742 brief. One change from it, said in the task's chat: old lines are hidden by the backend rather than by
each app, so no app code changes. The `machine-removed` rows ("<machine> left the Swarm with its owner, and "X" with it. Its
task has no agent now.") stay. They go only to the groups whose agents went, and say which task lost its agent.

## Global Constraints

- Nothing else about machine removal changes: cleanup records, the 30-minute fallback, offline removal, Team accounts.
- Read cost: `markRead` reads extra rows only when the mark it is given stops short of `lastMainSequence`. Then it reads at
  most `LATEST_SCAN` rows of that chat by its (tabId, conversationId, sequence) index, as the inbox already does.
- No data migration: stored rows stay, hidden at read time. Rollback: an older backend shows them again.

## Review Focus

- That no reader, an agent included, still gets a stored `machine-left` row (pages, inbox, Activity, deliveries).
- That `markRead` never moves a mark past a main row the person can read, nor past `lastMainSequence`.

## Design

- growth: no new data; the lines are no longer written.
- concurrency: unchanged; `moveChatMark` keeps its own guarded write.
- read cost: see Global Constraints.
- scale: the extra scan runs only on a mark short of the chat's newest main row, at most `LATEST_SCAN` rows.
- compatibility: older apps get the same pages, without these rows; nothing in the API changes.
- migration + rollback: none / an older backend shows the stored rows again.
- audience: the server enforces it (read-time `agentOnly`).
- identity: N/A because nothing is written as anyone.
- failure: N/A because nothing new can fail; a removal still ends.
- platforms: backend only, so every client gets it.

## Task 1: removals end without a line

**Files:** `backend/src/superTabs/machines.ts`, `backend/src/superTabs/commands.ts`, `backend/src/superTabs/store.ts`,
`backend/src/superTabs/commands.test.ts`, integration tests that read the lines (`superTabTeam`, `superTabBuddyProbes`).

**Interfaces:** `expireRemovals(state, now): void` (was `MessageDraft[]`); `removalEnded` removed.

- [ ] Change the unit tests of confirmed, offline and 30-minute-fallback removals to expect no `machine-left` line. Run
  them and see them fail.
- [ ] Remove `removalEnded` and its calls. Run the tests and see them pass.

## Task 2: stored lines are read by nobody, and a mark reads through them

**Files:** `backend/src/superTabs/model.ts`, `backend/src/superTabs/read/service.ts`, `backend/integration/superTabInbox.test.ts`,
`backend/integration/superTabBuddies.test.ts`.

- [ ] Integration test: a stored `machine-left` line is missing from the chat's page and from the inbox's latest preview,
  and a mark up to the newest visible row moves on to the line's sequence. Control: a readable main row after the mark
  stops it. Run it and see it fail.
- [ ] `NOTICE_READERS['machine-left'] = 'agent'`, and `markRead` reads through hidden rows. Run it and see it pass.
