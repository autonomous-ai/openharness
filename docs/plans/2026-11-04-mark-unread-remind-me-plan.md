# Mark unread and Remind me Implementation Plan

> **For agentic workers:** Follow the project Engineer workflow: plan first in a draft PR; implement task by task with a committed failing test before its passing code; one independent review step on the pull request.

**Goal:** From a message's More menu, a person can mark the chat unread from that message, or ask to be reminded of it in 20 minutes, in 1 hour or tomorrow at 09:00, when it comes back in Activity under Reminders with a notification. Strengthens "Tell the PM what you want, and your crew ships it": an agent's question is never lost, and the person comes back to it.

**Architecture:** Mark unread lowers the person's stored read mark (`SuperTabReadMark`), the one write that may move it back, and marks the row as lowered, so every device of theirs takes the lower mark instead of keeping the higher one. Reminders are a new per-person collection, `SuperTabReminder`, read by the `(tabId, personId, dueAt)` index. A digest in the person's read says when their reminders changed; the client then reads its due list and the next due time, and wakes at that time.

**Tech Stack:** TypeScript, Fastify, Prisma on MongoDB, Vitest with mongodb-memory-server; Flutter/Dart Desktop (and its web build).

**Spec:** Task #2603 in Super Tab conversation 0c18b4e9c2ee941a15db17d7 (Huy, 2026-11-04; brief from River).

## Global Constraints

- Look (ASCII mockup for Huy):

  ```
  More menu (⋯ on a message's hover bar)
  ┌──────────────────────────────┐
  │ 🔗  Copy link to message      │
  │ ✉   Mark unread               │
  │ ⏰  Remind me               › │┌───────────────────────┐
  └──────────────────────────────┘│ In 20 minutes          │
                                   │ In 1 hour              │
                                   │ Tomorrow at 09:00      │
                                   └───────────────────────┘

  Activity
    Needs you
      ◎  Kestrel is waiting on you                       Open
    Reminders
      ⏰  Avocet: Should a reminder clear when opened?   10:42
    New replies
      ↩  Voice messages like Telegram                   2 new
  ```

  A reminder row is bold like the other new rows, says who wrote the message and its text, and ends with the time it
  was due. Opening it opens the message in its chat (its thread for a reply only in a thread) and clears it.
- Mark unread is offered on a message in the chat's main stream. A reply that lives only in its thread is read with
  its thread's own mark; it gets Remind me only.
- The mark goes to just before the message (its sequence − 1), never forward: a chat already unread from earlier stays
  as it is.
- After Mark unread in the open chat, it stays unread with the New messages line above the message until the person
  leaves the chat; reading it again (opening it, Mark all read, Esc) works as before.
- Remind me times are the person's local time. Setting a reminder again on the same message replaces its time.
- A due reminder shows once in Activity and fires one notification on Desktop (none on the web, as tags), and counts
  in Activity's number until it is opened.
- Tokens only, flat rows, colour never the only signal, no explanatory sentences (desktop/design/desktop-design-system.md).
- Desktop tests use a memory store and a fake sign-in. Never a test that signs the Mac out of the real CLI. No Swarm
  code in cli/src/core.
- PR body begins `Requested by phamngochuy.1989@gmail.com through Harness.`

## Design

- Growth: a read mark row stays one row (one more date field). A reminder row is deleted when it is opened; setting
  one again replaces it (one row per person and message); the hourly sweep deletes reminders due more than 30 days ago
  (`REMINDER_EXPIRY_MS`) by the `dueAt` index. At most `REMINDER_CAP` = 200 pending reminders per person and Swarm:
  one more is refused with `REMINDER_LIMIT`.
- Concurrency: one document per write. Mark unread is a single conditional update (`sequence > target`); a read on
  another device after it raises the mark as before. Set and clear of a reminder are an upsert and a delete by id.
- Read cost: the first load and each changes read already read the person's marks by `(tabId, personId, updatedAt)`;
  they read one more field. The reminders digest is one indexed read of at most `REMINDER_CAP` ids and due times by
  `(tabId, personId, dueAt)`. The reminders list reads due rows by the same index (`dueAt <= now`) and the next one
  after now (limit 1). Each query gets a plan test (IXSCAN on its index).
- Scale: at 10x people, rows grow per person and are capped; the first warning is the reminders read's latency in the
  query stats (`integration/queryStats.test.ts` coverage) and the reminder collection's size.
- Compatibility: an older client ignores `unreadMarks` and `remindersDigest`; it keeps the higher mark, so a chat
  marked unread elsewhere stays read there until it reads past it. A new client on an older backend gets 404 for the
  new routes: Mark unread still works on that device (its own mark), Remind me says it could not be set.
- Migration + rollback: no migration. `loweredAt` is optional; rows without it read as not lowered. Rolling back
  leaves `loweredAt` and the reminders collection unread; the sweep that deletes reminders goes with it, so a rollback
  of more than a day is followed by dropping `SuperTabReminder` (documented in the PR).
- Audience: the server enforces it. A reminder is read, set and cleared only by its person, as themselves (no agent,
  no Team session); the list keeps only messages they may still read (the chat by `canReadGroup`, the message as a page
  shows it, `read/inbox.ts readable`). Mark unread checks the chat as `markRead` does.
- Identity: the person is the signed-in user (`user.sub`), never a machine owner's login.
- Failure: a refused Mark unread or Remind me shows a snackbar naming it ("Couldn't mark unread", "Couldn't set the
  reminder"); a failed reminders read shows in Activity's error line with Retry, as tags. A sweep failure is logged by
  the sweep pass, as the others.
- Platforms: backend; macOS, Linux, Windows and web through Desktop's shared Flutter code. The phone app is not
  changed.

## Review Focus

1. A mark lowered on one device is taken by another device that holds a higher one, and an older mark arriving later
   never undoes a newer read (Task 1, Task 3 tests).
2. The open chat does not mark itself read straight after Mark unread (Task 3 widget test).
3. A reminder never shows to anyone but its person, nor for a message they can no longer read (Task 2 tests).
4. A due reminder shows once and notifies once, also when two reads race (Task 4 test).
5. A reminder set on another device wakes this one at its time without polling (Task 4 test).

---

### Task 1: Backend — Mark unread

**Files:**
- Modify: `backend/prisma/schema.prisma` (`SuperTabReadMark`: `loweredAt DateTime?`)
- Modify: `backend/src/superTabs/readMarks.ts` (`lowerReadMark`, `readMarkRows`)
- Modify: `backend/src/superTabs/read/service.ts` (`markUnread`; `unreadMarks` in first load and changes)
- Modify: `backend/src/superTabs/read/contract.ts` (`Derived.unreadMarks`)
- Modify: `backend/src/routes/superTabs.ts` (`POST /api/super-tabs/:tabId/conversations/:conversationId/unread`)
- Test: `backend/integration/superTabReadMarks.test.ts`

**Interfaces:**
- Produces: `POST …/conversations/:conversationId/unread` body `{ sequence }` (the message's sequence) → `{ sequence }`
  (the mark as stored). `Derived.unreadMarks?: Record<string, number>`: marks whose last move was a Mark unread
  (`loweredAt` equals `updatedAt`), in a first load all of them, in a changes read those moved since the cursor.

- [ ] Write failing tests: Mark unread at message 41 after a read to 60 stores 40 and the owner's next changes read
      carries `unreadMarks: { web: 40 }`; at 70 after a read to 40 keeps 40; a read to 60 afterwards raises it and
      the mark is no longer in `unreadMarks`; refused for an unreadable chat, a Team session and an agent.
- [ ] Run `npx vitest run integration/superTabReadMarks.test.ts` and see them fail (404 on the route).
- [ ] Implement, then run the same file and see it pass. Commit each step.

### Task 2: Backend — Reminders

**Files:**
- Modify: `backend/prisma/schema.prisma` (`SuperTabReminder`)
- Create: `backend/src/superTabs/reminders.ts` (`setReminder`, `clearReminder`, `listReminders`, `remindersDigest`,
  `sweepReminders`, `REMINDER_CAP`, `REMINDER_EXPIRY_MS`)
- Modify: `backend/src/superTabs/parts/indexed.ts` (the reminder indexes by name, for `readBy`)
- Modify: `backend/src/superTabs/read/service.ts` (`reminders`, `setReminder`, `clearReminder`; `remindersDigest` in
  the person's read), `backend/src/superTabs/read/contract.ts`, `backend/src/superTabs/read/views.ts`
- Modify: `backend/src/superTabs/sweeps.ts` (the hourly pass runs `sweepReminders`)
- Modify: `backend/src/routes/superTabs.ts`: `GET /api/super-tabs/:tabId/reminders`,
  `PUT|DELETE /api/super-tabs/:tabId/conversations/:conversationId/messages/:messageId/reminder` (PUT body `{ at }`)
- Test: `backend/integration/superTabReminders.test.ts`

**Interfaces:**
- Produces: `GET …/reminders` → `{ due: ReminderItem[], next: string | null }`; `ReminderItem = { id, conversationId,
  conversationTitle, projectName, messageId, messageSequence, threadId, author: { kind, id, name }, text, dueAt }`.
  `PUT …/reminder { at }` → `{ id, dueAt }`; `at` in the future and at most 30 days ahead. `DELETE …/reminder` →
  `{ cleared: boolean }`. `Derived.remindersDigest?: string`.

- [ ] Write failing tests: a reminder set for +20 min is not listed before then and `next` names its time; at its time
      it is listed once (two reads give the same one row); another person, an agent and a Team session never read,
      set or clear it; a message the person can no longer read drops out; setting again replaces the time; clear
      removes it; the cap refuses the 201st; the digest moves on set and clear; the sweep deletes rows due over 30 days
      ago; plan tests read IXSCAN on `(tabId, personId, dueAt)` and `dueAt`.
- [ ] Run `npx vitest run integration/superTabReminders.test.ts` and see them fail.
- [ ] Implement, run the file and see it pass. Commit each step.

### Task 3: Desktop — Mark unread

**Files:**
- Modify: `desktop/lib/super_tabs/message_more_menu.dart` (an action may hold a submenu)
- Modify: `desktop/lib/super_tabs/message_row.dart` (`onMarkUnread`, `onRemind`; the More menu shows with them even
  without a link)
- Modify: `desktop/lib/super_tabs/controller.dart` (`markUnread`, the hold until the chat is left)
- Modify: `desktop/lib/super_tabs/read_marks.dart` (`forget(key)` so a later read is sent again)
- Modify: `desktop/lib/super_tabs/parts.dart` (`unreadMarks` lower the held mark)
- Modify: `desktop/lib/super_tabs/view.dart` (wire the row; place the New messages line again)
- Test: `desktop/test/super_tab_mark_unread_test.dart`

**Interfaces:**
- Produces: `SuperTabController.markUnread(String conversationId, SuperTabMessage message)`.

- [ ] Write failing widget test: with a chat read to its end, More → Mark unread on the third-last message shows the
      New messages line above it, the chat counts unread in the sidebar, the POST names its sequence, and the line
      stays after the next poll while the chat is open; leaving and reopening reads it. A parts test: a changes read
      with `unreadMarks` lowers a higher held mark; a later `readMarks` raise wins again.
- [ ] Run `flutter test test/super_tab_mark_unread_test.dart` and see it fail.
- [ ] Implement, run it and see it pass. Commit each step.

### Task 4: Desktop — Remind me and Activity's Reminders

**Files:**
- Create: `desktop/lib/super_tabs/reminders.dart` (`SuperTabReminder`, `SuperTabReminders`: reads on the digest, wakes
  at `next`, `onArrived` once per reminder)
- Modify: `desktop/lib/super_tabs/activity.dart` (Reminders list and count), `desktop/lib/super_tabs/activity_view.dart`
  (Reminders section), `desktop/lib/super_tabs/notifications.dart` (`superTabReminderNotice`),
  `desktop/lib/super_tabs/model.dart` (`remindersDigest`), `desktop/lib/super_tabs/view.dart` (Remind me choices;
  opening a reminder opens its message and clears it), the place tags' notices are wired (`onArrived`)
- Test: `desktop/test/super_tab_reminders_test.dart`

**Interfaces:**
- Consumes: Task 2's routes. Produces: `SuperTabReminders.of(controller)`, `set(message, DateTime at)`, `open(reminder)`.

- [ ] Write failing tests: Remind me → In 20 minutes sends the time 20 minutes on (fake clock); Tomorrow at 09:00 sends
      the next day's 09:00 local; when the fake clock reaches `next` the list is read and the row shows once under
      Reminders with its time, the notice fires once, two reads racing still show one row; opening it clears it (DELETE)
      and opens its chat at the message.
- [ ] Run `flutter test test/super_tab_reminders_test.dart` and see it fail.
- [ ] Implement, run it and see it pass. Commit each step.

### Task 5: Evidence

- [ ] Light and dark before/after screenshots of the More menu and Activity (golden-style shot tests, as
      `super_tab_message_link_shots_test.dart`), attached to the PR.
- [ ] Desktop guard tests (`check-ui-style`, `laid_out_list_test`), Desktop's whole unit suite once, the backend unit
      suite (`npm test`) and typecheck once; red/green evidence in a PR comment.
