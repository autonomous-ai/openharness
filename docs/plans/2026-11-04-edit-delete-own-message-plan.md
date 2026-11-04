# Edit and delete your own message Implementation Plan

> Implemented by the task's Engineer task by task, each failing test committed before its code (project instructions,
> Engineer). Tasks 2 and 3 share no files with each other and run in parallel once Task 1's contract is pushed. Two
> independent security reviews on the pull request (it changes who may change a stored message).

**Goal:** A person can edit and delete their own chat messages from the message's More menu on Desktop, web and phone, as
in Slack: an edited message shows "(edited)"; a deleted one shows "This message was deleted." when it has replies and
disappears otherwise (task #2746, mia via anh Dee's notifications thread, 2026-11-04).

**Architecture:** Two new Swarm commands, `message.edit` and `message.delete`, follow `message.react`: the store reads the
named row in the command's transaction (`messageChangeTarget`), the pure command (`messageEdits.ts`) decides who may change
it and bumps the conversation's `reactionSeq`, and the store writes the row. Every reader already re-reads the shown page
when `reactionSeq` moves (that is how reactions reach them), so older apps pick up the new text and the removed row with no
change; new apps also draw "(edited)" and the deleted line. Desktop and web share `desktop/lib/super_tabs`; the phone is
`mobile/lib/swarm`.

**Tech Stack:** TypeScript, Prisma 5 on MongoDB, Vitest (unit + mongodb-memory-server integration); Flutter (Desktop, web,
phone) with widget tests.

**Spec:** task #2746's brief; the ASCII mockup posted in the task thread (2026-11-04 08:08 UTC); River's go (same thread):
say what agents see, and test that a Buddy cannot change its owner's messages.

## Global Constraints

- Only the author changes a message: a person (`actor.kind === 'person'`), whose id is the row's `author.id` with
  `author.kind === 'person'`, on a plain post (`source` null). Agents (a Buddy included), other people, viewers and
  system rows are refused. Team sessions are never the person already (lib/teamSession.ts).
- No edit history is stored or served: an edit overwrites `text` and sets `editedAt`; a delete clears `text`, files and
  mentions.
- Replies keep their thread: a deleted root with replies stays as a tombstone; its replies stay under it.
- Nothing about who can read a message changes: the target is found with the same checks as `reactionTarget`.
- Copy: "Edit message", "Delete message", "(edited)", "This message was deleted.", dialog "Delete message?" /
  "This can't be undone." / Cancel / Delete. Harness Design Language for every new surface.
- Desktop tests use a memory store and a fake sign-in; never the real CLI login. Swarm code stays out of cli/src/core.
- PR body first line: "Requested by dee@autonomous.ai through Harness."

## Design

- growth: nothing new grows. A delete removes the row (or leaves one tombstone per deleted root with replies), its
  reactions, its Activity rows, and marks its files for the hourly attachment sweep (lib/attachmentSweep.ts) to remove.
  Tombstones go with their Swarm (purge.ts).
- concurrency: conversation level. Each change bumps the group's `reactionSeq`, so it writes the group part, as
  `message.send` does (`messageSeq`); a reply racing a delete of its root conflicts on the group and runs again, then
  finds the root gone (refused) or a tombstone (kept as a reply). A reply delete also rewrites its thread summary
  (`refreshThreads`), which a concurrent reply writes too.
- read cost: one row by primary key, plus one `findFirst` for "has a reply" on a root delete (index
  `[tabId, conversationId, thread, sequence]`). Readers re-read only the page they show, as for a reaction.
- scale: 10x edits cost 10x single-row writes; the warning metric is the `message page` read count per poll
  (`recordMessageRead`), which `reactionSeq` re-reads move.
- compatibility: older apps re-read the page on `reactionSeq` and show the new text; a tombstone's stored text is the
  words "This message was deleted." so every older app, the CLI and inbox previews show it right. Older backends ignore
  the two new optional row fields. Older apps never send the new commands.
- migration + rollback: no migration (two optional fields). A rollback leaves `editedAt`/`deletedAt` unread and a
  tombstone shows its words; edits stay edited.
- audience: the server enforces it (commands.ts `messageEdits.ts` + store target lookup); the apps only hide the menu
  items.
- identity: the actor is the signed-in person; a Buddy or any agent is refused by kind; never the machine owner's login.
- failure: refusals say why (NOT_FOUND "This message is unavailable.", FORBIDDEN "Only its author can change this
  message.", MESSAGE_DELETED "This message was deleted."); the apps show the refusal as a snackbar and keep the old text.
- platforms: backend; Desktop (macOS, Windows, Linux) and web from one Flutter code base; phone (iOS, Android).

What agents see (River): an edit or delete does not re-deliver to an agent that already read the message; a delivery
not yet claimed is cancelled on delete and reads the new text on edit (it reads the row when claimed). A deleted
message's files are removed for everyone.

## Wire contract (Task 1 produces it, Tasks 2 and 3 consume it)

- `{ "type": "message.edit", "conversationId": ID, "messageId": ID, "text": string }`: `text` trimmed, at most 32,000;
  empty only when the message has files. Result `{ "changed": boolean }` (false when the text is the same).
- `{ "type": "message.delete", "conversationId": ID, "messageId": ID }`. Result `{ "changed": true, "kept": boolean }`
  (`kept`: it stays as "This message was deleted." because it has replies).
- Message rows in pages gain optional `editedAt` (ISO string) and `deletedAt` (ISO string). A tombstone has
  `deletedAt`, `text: "This message was deleted."`, no attachments, no mentions, no reactions.
- The conversation's `reactionSeq` moves on every change.

## Review Focus

1. Another person, a viewer, an agent, the author's own Buddy: each refused for edit and delete (Task 1 tests "only the
   author", "a Buddy cannot").
2. A message hidden from the actor (agent-only notice, another conversation's id): refused as unavailable, never as
   "not yours", so a refusal tells nothing (Task 1 test "hidden reads as unavailable").
3. A deleted root with replies: the replies still read in its thread and the summary still counts them; a deleted reply
   leaves the summary's count and last reply right (Task 1 integration "replies keep their thread").
4. No old text after an edit or delete anywhere a reader can reach: the page, one message by id, the inbox preview
   (Task 1 integration "no history").
5. The chat does not stay unread for a deleted newest message (Task 1 test "counters step back").

---

### Task 1: Backend commands

**Files:**
- Create: `backend/src/superTabs/messageEdits.ts`, `backend/src/superTabs/messageEdits.test.ts`,
  `backend/integration/superTabMessageEdits.test.ts`
- Modify: `backend/src/superTabs/commands.ts` (schema, context, apply), `backend/src/superTabs/store.ts` (target read,
  writes), `backend/prisma/schema.prisma` (`editedAt`, `deletedAt` on SuperTabMessage), `backend/src/superTabs/buddies.ts`
  only if its command list needs the refusal, `hotFilters.allowed.json` for new filters.

**Interfaces:**
- Produces: `MessageChangeTarget { messageId; authorKind; authorId; plain: boolean; deleted: boolean; hasFiles: boolean;
  hasReplies: boolean }`; `editMessage(group, actor, command, target): boolean`; `deleteMessage(group, actor, command,
  target): { kept: boolean }`; `DELETED_TEXT = 'This message was deleted.'`.

- [ ] Step 1: unit tests in messageEdits.test.ts (fail: module missing): only the author edits/deletes; another person,
  a viewer, an agent and the owner's Buddy get FORBIDDEN/READ_ONLY; a sourced row FORBIDDEN; a missing target
  NOT_FOUND; a tombstone MESSAGE_DELETED; empty text without files refused; same text → changed false; each change bumps
  `reactionSeq`; delete with replies → kept.
- [ ] Step 2: implement messageEdits.ts and wire commands.ts; tests pass; commit.
- [ ] Step 3: integration tests (fail): edit then page/message-by-id/inbox show only the new text with `editedAt`; delete
  without replies removes the row, its reactions, Activity and cancels open deliveries; its files are marked for the
  sweep; delete of a root with replies keeps a tombstone and the thread reads whole; delete of a reply refreshes the
  summary; deleting the newest message steps `lastMainSequence`/`lastPersonSequence`/`lastMessageSequence` back; a
  Buddy acting as an agent is refused; an agent-only row reads as unavailable.
- [ ] Step 4: implement store target read and writes; integration and unit tests pass; `npm test`; commit.

### Task 2: Desktop and web

**Files:**
- Modify: `desktop/lib/super_tabs/model.dart` (`editedAt`, `deletedAt` on SuperTabMessage), `controller.dart`
  (`editMessage`, `deleteMessage` sending the commands, re-reading the page), `message_row.dart` (More menu items for own
  plain messages, in-place editor, "(edited)", tombstone line), the row's callers to pass the callbacks.
- Test: `desktop/test/super_tabs/message_edit_test.dart` (new).

- [ ] Step 1: widget tests (fail): own message's More menu lists Edit message and Delete message after a divider; an
  agent's or another person's does not; Edit opens the field with the text, Enter sends `message.edit`, Esc cancels;
  Delete asks "Delete message?" and sends `message.delete` on Delete only; an `editedAt` row shows "(edited)"; a
  `deletedAt` row shows "This message was deleted." in faint italic with no hover actions but its reply line.
- [ ] Step 2: implement; tests pass; screenshots light and dark; commit.

### Task 3: Phone

**Files:**
- Modify: `mobile/lib/swarm/model.dart`, `swarm_reactions.dart` (sheet items), `swarm_message_row.dart` ("(edited)",
  tombstone), `swarm_conversation.dart` (send the commands, re-read).
- Test: `mobile/test/swarm/swarm_message_edit_test.dart` (new).

- [ ] Step 1: widget tests (fail): own message's long-press sheet shows Edit message and Delete message under Copy link
  to message; others' do not; Edit opens a text sheet prefilled, Save sends `message.edit`; Delete confirms then sends
  `message.delete`; "(edited)" and the tombstone line render.
- [ ] Step 2: implement; tests pass; screenshots light and dark; commit.
