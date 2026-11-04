# Activity Mentions stay unread until read Implementation Plan

> Implemented by the task's Engineer task by task, each failing test committed before its code (project instructions,
> Engineer). One independent review on the pull request.

**Goal:** In Activity > Mentions, a tag the reader never opened looks unread, even after the server resolved it because
they answered someone or posted in a chat. Mentions opens on Unreads only, an unread row reads like an unread thread row,
and a Threads row names a person by the name the Swarm shows, not their email (task #2887, Diego, 2026-11-04, a
follow-up to #2929).

**Architecture:** `SuperTabActivity.mentionUnread` (activity.dart) read any resolved tag as read. The backend resolves a
waiting tag as `reply` (any post by the reader in that chat), `answer` (any post to the agent that tagged them, which a
Buddy's automated posts sent as the reader count as), `worker` (a held tag whose task got a worker), `read` (a read mark
passed it) or `done` (Mark read) (backend/src/superTabs/mentions.ts). Only `read` and `done` mean the reader saw it.

- `mentionUnread` changes: `read` and `done` are read. Any other tag, waiting or resolved, is unread until the reader's
  chat mark passes its message (the thread mark for a reply that lives only in its thread). A tag from a server that
  does not send `messageSequence` keeps today's rule: unread until resolved.
- The red number, the badges and the menu bar are unchanged. They read the server's waiting tags (`mentions.waiting`,
  attention.dart, `_tags`), and a waiting tag has no `resolvedBy`, so the new rule only matters for Earlier.
- Mark read on a row (and Mark all read) sends `mention.done` for each tag that still waits, as now. For each tag the
  server resolved that is still unread, it moves the read mark through that message:
  `SuperTabController.markThreadRead` for a thread reply, and a new `SuperTabController.markReadThrough(id, sequence)`
  for the chat. `markRead(id, through:)` can't be used: it stops at the chat's loaded messages (a transcript passes
  what it displayed), and Activity marks chats that aren't open. The new call stops at the chat's newest message.
- Mentions starts with Unreads only on.
- `_ActivityRow`: an unread row's preview is in the foreground colour (it was muted, close to a read row's faint). The
  dot and the semibold foreground name are unchanged. A read row stays regular weight, with a muted name and a faint
  preview. Mention and thread rows share the row, so both read the same.
- A Threads row's root author and replier are named from the snapshot: a person by `shownName`, an agent by
  `agentName`, else the server's recorded name (an email becomes its local part, as the chat does).

**Tech Stack:** Flutter (Desktop and web share this code), widget tests on `ConversationServer` (memory store, fake
sign-in).

**Spec:** task #2887's brief.

## Global Constraints

- Red first for each of the four points.
- Activity's red number, the chat badges and the menu bar keep counting the server's waiting tags.
- Mentions in chats missing from the snapshot are out of scope.
- Desktop tests use a memory store and a fake sign-in; screenshots offscreen, light and dark.

## Design

- growth: N/A because nothing new is stored; Mark read moves existing read marks.
- concurrency: N/A because it is UI state on the main isolate; read marks keep their existing server write.
- read cost: N/A because no read is added.
- scale: N/A because it is one comparison per listed tag (at most the server's page).
- compatibility: a server without `messageSequence` keeps today's rule; no wire format changes.
- migration + rollback: N/A because nothing is stored; revert the commit.
- audience: the server lists the reader's own tags and keeps their own read marks.
- identity: N/A because no login is used.
- failure: a read-mark write that fails keeps this device's mark and retries as other read marks do.
- platforms: macOS, Linux, Windows and web (shared Flutter code).

## Review Focus

- `reply`, `answer` and `worker` tags read as unread until the reader reads past them; `read` and `done` read as read.
- Mark read on a resolved unread row moves the right mark (the thread's for a reply that lives in a thread) and sends no
  `mention.done` for it.
- `markReadThrough` never moves a mark back and never past the chat's newest message.

## Task 1: Mentions opens on Unreads only

**Files:** desktop/lib/super_tabs/activity_view.dart, desktop/test/super_tab_activity_view_test.dart

- [ ] Test: Mentions shows the unread row and hides the read one at first; turning Unreads only off shows both.
- [ ] Run red, commit; set the default; run green, commit.

## Task 2: a tag stays unread until read past or marked read

**Files:** desktop/lib/super_tabs/activity.dart, desktop/lib/super_tabs/activity_rows.dart,
desktop/lib/super_tabs/activity_view.dart, desktop/lib/super_tabs/controller.dart,
desktop/test/super_tab_activity_view_test.dart

**Interfaces:** `SuperTabController.markReadThrough(String id, int sequence)`.

- [ ] Test: tags resolved by `reply`, `answer` and a thread reply resolved by `answer`, none read past, show unread (dot);
      ones resolved by `read` and `done` show read; one by `answer` that the reader read past shows read.
- [ ] Test: Mark read on the `answer` row moves the chat mark to its message and sends no `mention.done`; on the thread
      row it moves the thread mark; both rows then read as read.
- [ ] Run red, commit; implement; run green, commit.

## Task 3: unread rows look like unread thread rows

**Files:** desktop/lib/super_tabs/activity_view.dart, desktop/test/super_tab_activity_view_test.dart

- [ ] Test: an unread mention row has the dot, a semibold foreground name and a foreground preview; a read row has no
      dot, a regular muted name and a faint preview.
- [ ] Run red, commit; implement; run green, commit.

## Task 4: Threads rows name people by their shown name

**Files:** desktop/lib/super_tabs/activity_view.dart, desktop/test/super_tab_activity_view_test.dart

- [ ] Test: a thread rooted by a person recorded with their email shows the name they set in the preview and avatar,
      and never the email.
- [ ] Run red, commit; implement; run green, commit.

## Finish

- [ ] Run super_tab_activity_*, super_tab_mentions_test and super_tab_quiet_polish_test.
- [ ] Light and dark screenshots of Mentions and Threads to Diego, with a person line.
