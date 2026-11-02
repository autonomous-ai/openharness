# Quiet Swarm 4/6: Activity takes in Threads Implementation Plan

> **For agentic workers:** Work this plan task by task, test first: each failing test is committed before its code (project instructions, Engineer). The header names this way of working, not subagent-driven-development, and there is no execution handoff.

**Goal:** Activity becomes the one place for everything new for the reader: Needs you, New replies, Done today, one line per row, a number that counts only Needs you; the Threads row and view go.

**Architecture:** `SuperTabActivity` (activity.dart) stops being a feed of replies and reactions and becomes three derived lists over data Desktop already holds: open decisions, agents waiting and unanswered tags (Needs you); the followed threads with unread replies, taken from `SuperTabAttention` (New replies); and tasks shipped today (Done today). `SuperTabActivityView` draws them as one-line rows; the Threads view (threads_view.dart) and the parts of attention.dart only it used are deleted. Done today needs the time a task shipped, which the server keeps in the group's ledger and does not send, so the conversation read adds `shippedAt`.

**Tech Stack:** Flutter/Dart (desktop/), TypeScript (backend/src/superTabs/read/views.ts, one field).

**Spec:** docs/plans/2026-11-02-quiet-swarm-design.md (rules "Activity is the one place…", screens 6 and 11b; "What moves where": Activity with 36, and the Threads view).

## Global Constraints

- "Activity is the one place for everything new for you: Needs you, New replies (the old Threads view), Done today. No filter pills; every row one line."
- "Activity's number counts only what needs you."
- "Something new makes a row bold, with no dot."
- "More words: no. Headings, names and one status word; reasons go in tooltips." No new colors, icons or controls outside desktop/design/desktop-design-system.md.
- Keep #2618's rule: leaving Activity marks read only what the visit showed.
- No on/off switch: it ships on. Swarm code stays out of cli/src/core. Tests use a memory store and a fake sign-in.
- Screen 6 rows: `◐ <question>  Answer`, `◐ <agent> is waiting on you  Open`, `@ <author> mentioned you in # <project>  <time>`, `<thread>  N new`, `✓ <task>  <time>`. Screen 11b: "You're all caught up."

## Review Focus

- The Activity number must not count New replies, Done today or reactions; it must clear as the reader answers.
- A thread that is read while the view is open stays bold until the view is left (no row vanishing under the pointer).
- Leaving Activity must send no read mark for rows it did not show (reactions, other threads, older pages).
- A very long question, thread or task name stays on one line (ellipsis); the time never wraps.
- Work finished yesterday, a private task and a task with no ship time never appear in Done today.
- An older server that does not send `shippedAt`: Done today is empty, the rest works.

---

### Task 1: Done today needs the time a task shipped

**Files:**
- Modify: `backend/src/superTabs/read/views.ts:64` (send `shippedAt` from the ledger)
- Modify: `desktop/lib/super_tabs/model.dart` (`SuperTabConversation.shippedAt`)
- Test: `backend/src/superTabs/read/views.test.ts` (or the nearest existing view test), `desktop/test/super_tab_activity_test.dart`

**Interfaces:**
- Produces: conversation row `shippedAt: number | undefined` (ms since epoch; `ledger.shipPostedAt ?? ledger.shippedAt`); Dart `DateTime? SuperTabConversation.shippedAt`.

- [ ] **Step 1: Failing test** — a group whose ledger has `shipPostedAt` reads back `shippedAt`; one with only `shippedAt` reads that; one with neither has no key; a private group's row is unchanged for readers outside its audience.
- [ ] **Step 2: Run it** — `cd backend && npx vitest run src/superTabs/read` fails.
- [ ] **Step 3: Implement** in `views.ts` next to the ledger strip; parse `shippedAt` in `SuperTabConversation.fromJson` (num → `DateTime`, absent → null).
- [ ] **Step 4: Run** the backend tests and the Super Tab integration suite, then the Dart model test.
- [ ] **Step 5: Commit.**

### Task 2: Activity is three lists and a count

**Files:**
- Modify: `desktop/lib/super_tabs/activity.dart` (drop the replies/reactions feed, filter and its read mark; add the lists)
- Test: `desktop/test/super_tab_activity_test.dart` (rewritten), `desktop/test/super_tab_backend_transport_test.dart` (feed cases removed)

**Interfaces:**
- Produces:
  - `List<SuperTabNeed> SuperTabActivity.needsYou` — decisions asked of the reader (`SuperTabNeedKind.decision`), agents waiting on them (`agent`: a task whose status waits on a person and is not already an open decision), tags waiting on them (`mention`); newest first.
  - `List<SuperTabFollowedThread> SuperTabActivity.newReplies` — `SuperTabAttention.unread` plus threads read during this visit.
  - `List<SuperTabConversation> SuperTabActivity.doneToday` — tasks (no steps, no Buddy chats) whose `shippedAt` is today in the reader's time zone, newest first.
  - `int count` = `needsYou.length`; `bool unread` = `needsYou.isNotEmpty || newReplies.isNotEmpty`.
  - `opened()` / `closed()` keep their names; `closed()` sends no read request.

- [ ] **Step 1: Failing tests** (names are the assertions): `count counts only Needs you` (a reply, a reaction, a done task add nothing); `Needs you lists a decision, a waiting agent and a tag, newest first, a decision's agent once`; `New replies lists the followed threads with unread replies`; `Done today lists what shipped today, not yesterday, not a step, not a private task of someone else's`; `unread is bold for new replies alone`; `leaving sends no read request`.
- [ ] **Step 2: Run** `flutter test test/super_tab_activity_test.dart` — fails (no `needsYou`).
- [ ] **Step 3: Implement** the lists as getters over `decisions.open`, the snapshot's waiting tasks, `mentions.waiting`, `SuperTabAttention.of(controller)` and `doneToday`; delete `items`, `filter`, `_markShownRead`, the `/activity` reads and their digest handling.
- [ ] **Step 4: Run** the file, `flutter analyze`.
- [ ] **Step 5: Commit.**

### Task 3: The Activity view

**Files:**
- Modify: `desktop/lib/super_tabs/activity_view.dart`
- Test: `desktop/test/super_tab_activity_view_test.dart` (new), `desktop/test/super_tab_activity_shots_test.dart` (pictures of screens 6 and 11b)

**Interfaces:**
- Consumes: Task 2's lists.
- Produces: `SuperTabActivityView({activity, onOpenMention, onOpenThread(conversationId, rootId), onOpenConversation(conversationId), now})`.

- [ ] **Step 1: Failing widget tests**: three headings in order and no filter pills; every row is one line at 480 px wide and with long names (no wrap, ellipsis); a decision row says `Answer` and opens its card inline; an agent row says `Open`; a tag row shows `<author> mentioned you in # <project>` and its time; a thread row shows `N new`; a done row shows `✓` and the time; rows with something new are bold, others not; empty is `You're all caught up.` with no headings; a thread read during the visit stays bold until the view is left.
- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement** with the existing `DesktopChrome`/`grid` tokens: one `_row` of a single `Row` (leading mark, `Expanded` ellipsised title, trailing word or time); section headings via `SuperTabSectionHeading`; decision rows expand `SuperTabDecisionCard`.
- [ ] **Step 4: Run** the new tests and the pictures (`ACTIVITY_SHOTS=<dir>`).
- [ ] **Step 5: Commit.**

### Task 4: The Threads row and view go

**Files:**
- Delete: `desktop/lib/super_tabs/threads_view.dart`, and the tests that only drew it (`super_tab_threads_test.dart`, `super_tab_threads_shots_test.dart`)
- Modify: `desktop/lib/super_tabs/view.dart` (no `_showThreads`, no `SuperTabThreadsView`, Activity gets `onOpenThread`/`onOpenConversation`, the catch-up card's counts open Activity), `desktop/lib/super_tabs/project_sidebar.dart` (no Threads row or its params), `desktop/lib/super_tabs/attention.dart` (drop what only the Threads view used: own replies, new-reply reads, Follow toggles), their tests
- Test: `desktop/test/super_tab_attention_test.dart`, `super_tab_catch_up_test.dart`, `super_tab_one_buddy_test.dart`

- [ ] **Step 1: Failing tests**: the sidebar has an Activity row and no Threads row; the red number on a project row still counts tags in its chat (unchanged); the catch-up card's decision and tag counts open Activity; a thread row opens that thread in its chat.
- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement** the deletions and wiring; keep `mentionsIn`, `threadMentions` and the unread-thread read that the sidebar and Activity use.
- [ ] **Step 4: Run** every test file that mentions Activity, attention, threads or the sidebar, and `flutter analyze`.
- [ ] **Step 5: Commit.**

### Task 5: Pictures and the PR

- [ ] Screens 6 and 11b from a browser build on made-up data in the PR; red/green and the suites in PR comments; rebase on main.
