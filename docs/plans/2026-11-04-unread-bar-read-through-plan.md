# Unread bar goes once the chat is read through Implementation Plan

> Implemented by the task's Engineer task by task, each failing test committed before its code (project instructions,
> Engineer). One independent review on the pull request.

**Goal:** The "N new messages · Jump" bar stops showing once the reader has read the chat through: seen its New
messages line and reached the bottom with nothing newer left to load. The line itself stays for the visit, so the
reader sees where they started. The bar gains a "Mark as read" button with an Esc hint, as Slack's does (task #2743,
Huy, 2026-11-04).

**Architecture:** `SuperTabUnreadLines` (desktop/lib/super_tabs/unread_line.dart) keeps a per-visit set of
conversations read through, beside the `_seen` set it already keeps. `offersBar` leaves out a conversation in it;
`placeAt` (Mark unread) takes it out again; `forget` and `reset` clear it. `_checkUnreadLine` (view.dart), which already
measures the line and the list's end on every scroll, calls it when the list is at its end (`extentAfter < 40`, the
same edge Jump to latest uses), no newer page waits (`!c.hasNewer`), no jump is landing, and the line was seen this
visit. A link that lands at the end without the line ever in view keeps the bar: those messages were skipped, not
read. `SuperTabUnreadBar` gets an `onMarkRead` callback drawn as a text button and an Esc key cap at its right end;
the view passes `_readAll`, the same path Esc takes.

**Tech Stack:** Flutter (Desktop and web share this code), flutter_test widget tests with the Super Tab fixture's
memory store and fake sign-in.

**Spec:** task #2743's brief. No stored data changes.

## Global Constraints

- Red first: each behavior below has a widget test committed failing before its code.
- Desktop and web are one Flutter screen; nothing platform-specific.
- No test signs the real CLI out: the fixture's `ConversationServer` only.
- Light and dark screenshots offscreen (`SUPER_TAB_UNREAD_SHOTS`) for Huy.
- Threads have no New messages line or bar today (thread_panel.dart), so nothing there can stay stuck; adding one is
  outside this task and goes to the PM.

## Design

- growth: N/A because nothing is stored; the set is per visit and cleared when the chat is left.
- concurrency: N/A because it is UI state on the main isolate.
- read cost: N/A because no read is added; the check runs in the scroll listener that already measures the line.
- scale: N/A because the set holds at most the open conversation.
- compatibility: N/A because no wire or saved format changes.
- migration + rollback: N/A because nothing is stored; revert the commit.
- audience: N/A because the read mark the button sends is the one Esc already sends, enforced by the server.
- identity: N/A because no login is used.
- failure: Mark as read uses `markRead(explicit: true)`, which already reports a failed save.
- platforms: macOS, Linux, Windows and web (shared Flutter code).

## Review Focus

- The read-through rule: seen line + at end + nothing newer + not landing. A link landing at the end keeps the bar.
- Tests that relied on the bar at the very end now scroll to a point past the line short of the end.
- The bar's tap target: the Jump area and the Mark as read button do not swallow each other's taps.

## Task 1: the bar goes once the chat is read through

**Files:** desktop/lib/super_tabs/unread_line.dart, desktop/lib/super_tabs/view.dart,
desktop/test/super_tab_new_messages_test.dart

**Interfaces:** `SuperTabUnreadLines.readThrough(String id)`; `offersBar` false for a conversation read through.

- [ ] Test: opened at the line, scrolled to the bottom, the bar is gone and the line is still there (above the view).
- [ ] Test: opened by a link at the end with the line never seen, the bar stays; jumped to the line and scrolled back
      to the bottom, it goes.
- [ ] Test: Mark unread after reading through brings the bar back once the new line is above.
- [ ] Existing tests that expect the bar scroll past the line short of the end.
- [ ] Run them red, commit; implement; run green, commit.

## Task 2: Mark as read on the bar, with its Esc hint

**Files:** desktop/lib/super_tabs/unread_line.dart, desktop/lib/super_tabs/view.dart,
desktop/test/super_tab_new_messages_test.dart, desktop/test/super_tab_new_messages_shots_test.dart

**Interfaces:** `SuperTabUnreadBar(onMarkRead: VoidCallback)`; button key `super-unread-mark-read`.

- [ ] Test: the bar shows "Mark as read" and an Esc key cap; a click clears the bar and the line and marks the chat
      read on the server, without jumping.
- [ ] Shots test: the bar partway down, then the end with the line above and no bar, light and dark.
- [ ] Run red, commit; implement; run green, commit.
