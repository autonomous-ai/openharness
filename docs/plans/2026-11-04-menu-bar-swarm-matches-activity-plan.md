# Menu bar Swarm section matches Activity Implementation Plan

> Worked by the project's Engineer workflow: plan first, then each task test first (failing test committed, then
> the code that passes it), one review step on the pull request. No execution handoff.

**Goal:** The menu bar's Swarm section lists exactly what Activity lists for the reader, in Activity's order, with
the same number, and a row read, opened or marked read in either place leaves both at once (task #2914, Diego).

**Architecture:** `SuperTabActivity` gains one list, `notices`: Needs you (due reminders, agents waiting on the
reader, decisions newest first) then every unread tag (#3005's `mentionUnread`, newest first). Its length is
`count` once the lists are read. Activity's Needs you and Mentions draw from it; `statusMenuSwarmEntries` maps it
row for row, with no filter of its own. The Swarm client tells the app when that list changes, so the menu redraws
when a read mark, a reminder or a tag moves.

**Tech Stack:** Flutter/Dart (desktop/lib), flutter_test with the Super Tab fixture (memory store, fake sign-in).

**Spec:** task #2914's brief (conversation 957f7daf2e1ce5fc9333cb95), building on #3005 (`docs/plans/2026-11-04-activity-mentions-unread-plan.md`).

## Global Constraints

- Ready (this Mac's terminal questions and finished agents) stays its own section; the badge stays Ready + Swarm rows.
- The Swarm section count equals Activity's red number for that Swarm.
- A tag in a conversation the snapshot does not hold (quiet, archived) is in both lists or neither: both, as #3005
  counts it until resolved.
- Desktop tests use a memory store and a fake sign-in. Swarm code stays out of cli/src/core.
- No new native control: the menu's Swarm rows open; Mark read stays Activity's (reading the opened tag clears it).

## Review Focus

- A tag answered elsewhere but unread (`earlier`, resolved `answered`): listed in both; opening it from the menu opens it.
- A read mark moved locally (Mark read on an answered tag) must redraw the menu even though no server count moved.
- A reminder coming due or opened must redraw the menu (reminders notify separately from the controller).
- Lost access (visibility epoch moves): both lists empty at once, as before.
- Before the lists are read Activity's number uses the server's counts; the menu shows only rows it can name.

---

### Task 1: One notices list in SuperTabActivity, drawn by the menu

**Files:**
- Modify: `desktop/lib/super_tabs/activity.dart` (add `SuperTabNoticeKind`, `SuperTabNotice`, `notices`)
- Modify: `desktop/lib/state/status_menu.dart` (`statusMenuSwarmEntries` maps `notices`)
- Test: `desktop/test/super_tab_menu_bar_notices_test.dart`

**Interfaces:**
- Produces: `enum SuperTabNoticeKind { reminder, agent, decision, mention }`;
  `class SuperTabNotice { kind, id, conversationId, at, reminder?, need?, mention? }` where `id` is the raw id
  (reminder id, conversation id for an agent, decision id, mention id);
  `List<SuperTabNotice> get SuperTabActivity.notices`.
- Menu row `kind` is the enum's name; `id` the notice's `id`.

- [ ] Failing tests: rows equal Activity's `notices` in order (reminder, agent, decision, tag); row count equals
      `activity.count`; a quiet-conversation tag is in both; an answered-unread tag is in both.
- [ ] Run `flutter test test/super_tab_menu_bar_notices_test.dart`: FAIL (menu lacks reminder, agent, quiet, earlier).
- [ ] Implement `notices`; `statusMenuSwarmEntries` maps it (titles: `<asker> asks you`, `<author> tagged you`,
      `<agent> is waiting on you`, `Reminder` / author).
- [ ] Run again: PASS. Commit.

### Task 2: Activity draws the same list

**Files:**
- Modify: `desktop/lib/super_tabs/activity_view.dart` (`_needsYou`, `_mentions` read `notices`)
- Test: `desktop/test/super_tab_menu_bar_notices_test.dart`

- [ ] Failing test: the Activity rows' keys on Needs you then Mentions, unfolded, equal the menu rows in order.
- [ ] Implement; PASS; commit.

### Task 3: Either place clears the other at once

**Files:**
- Modify: `desktop/lib/super_tabs/client.dart` (`onNotices` hears `SuperTabActivity` when its notice ids change)
- Modify: `desktop/lib/super_tabs/view.dart` (`_takeNotice` opens `earlier` tags, reminders and agent rows)
- Test: `desktop/test/super_tab_menu_bar_notices_test.dart`

- [ ] Failing tests: Mark read in Activity on an answered-unread tag and on a quiet-conversation tag tells the app
      and empties both; opening a tag from the menu reads it and it leaves both; a reminder or agent row from the
      menu opens its message or chat.
- [ ] Implement; PASS; run the Activity and menu tests (`super_tab_activity*_test.dart`, `status_menu_test.dart`,
      `super_tab_menu_bar_notices_test.dart`) and the Desktop guard tests; commit.
