# Right pane keeps several conversations in an avatar row — plan (task #3881)

**Goal:** The Desktop right pane beside the Board holds several conversations (anh Dee, 11-06 15:5x). A horizontal
avatar row across its top: the person's Buddies pinned on the left, a divider, then the card chats they opened, each
with an unread mark; hover shows the title and a close ×; + starts a new Buddy; about 7 or 8 fit, then +N opens the
rest. Clicking a card on the Board adds its chat to the row and opens it below; the Board never changes. The selected
conversation fills the pane below the row. Open card chats are kept per person across restarts.

**Architecture:** Per River’s updated direction, build on #3820 (PR #3386) now, then merge main once
#3386, #3399 (fixed layout) and #3398 (Buddy menu) land. The row replaces #3820's `SuperTabBuddyList` in `_boardChat` (`view.dart`); a new
`right_pane_row.dart` draws it from two lists: the reader's Buddies (`SuperTabController.buddies()`, default first) and
the open card chats, a small per-reader list kept in the local store (`LocalKeyValueStore`, key per account and Swarm).
Selecting an avatar selects that conversation (`c.select`); the pane below is the existing chat. #3864's Buddy ⋮ menu
(Rename, Restart, Remove) sits on the selected Buddy. The Board's card click (`onOpenTask`) adds the card to the row
instead of only selecting it.

**Tech Stack:** Flutter 3.47 (Desktop), `flutter_test` with `ConversationServer` (memory store, fake sign-in).

**Spec:** River's brief on task #3881 (anh Dee, 11-06); docs/plans/2026-11-06-buddy-board-final-spec.md (right pane).

This plan is written and carried out by its Engineer, test first; there is no execution handoff.

## Design

- Growth: the open card chats are at most 30 ids per reader and Swarm; closing one removes it, opening a 31st drops
  the oldest, and an id whose conversation is gone or archived is dropped on read.
- Concurrency: one window writes its own reader's list; the last write wins (it holds only ids, no shared state).
- Read cost: read once when the view opens; written only when the list changes.
- Scale: 10× cards open is bounded by the cap; the row shows 8 and +N for the rest.
- Compatibility: nothing on the server changes; a build without this ignores the stored key.
- Migration + rollback: N/A because the list is new and local; a revert leaves an unread key.
- Audience: the row lists only conversations the snapshot gives this reader; a card they can no longer read drops out.
- Identity: kept per signed-in account and Swarm, never the machine owner's.
- Failure: an unreadable or unwritable store leaves the row with the Buddies alone, as on a first start.
- Platforms: Desktop on macOS, Windows and Linux; no process is started (Windows: no window flash).

## Global Constraints

- The right pane only: the Board, left rail and fixed layout (#3863, no hide/show) are unchanged.
- Harness design language (`scripts/check-ui-style.py`), light and dark.
- Desktop tests use a memory store and a fake sign-in.

## Review Focus

- The Board in the middle never changes when a card's chat opens.
- Buddies always pinned first; closing a card chat never removes a Buddy.
- The stored list is per account and Swarm, and drops what the reader can no longer read.

## Tasks

### 1. The row: Buddies, divider, card chats, unread, close, + (`right_pane_row.dart`, `view.dart`)

- [ ] Failing test: the row shows the reader's Buddies first (default first), a divider, then open card chats; each
      card chat with unread messages carries a mark; hover shows its title and a close ×, which removes it; + opens
      New Buddy; the selected avatar's conversation fills the pane below; #3864's ⋮ menu is on the selected Buddy.
- [ ] Code.

### 2. A card click adds its chat to the row (`view.dart`)

- [ ] Failing test: clicking a Board card adds its chat to the row and opens it below, and the Board in the middle
      stays as it was; clicking it again does not add it twice.
- [ ] Code.

### 3. Overflow: +N past 8 (`right_pane_row.dart`)

- [ ] Failing test: with more than 8 avatars the row shows 8 and +N; +N opens a menu with the rest, and choosing one
      opens it.
- [ ] Code.

### 4. Kept across restarts (`right_pane_row.dart`)

- [ ] Failing test: open card chats come back in a new view for the same account and Swarm, not for another account;
      a card no longer in the snapshot is dropped; an unreadable store shows the Buddies alone.
- [ ] Code.

### 5. Pictures

- [ ] Light and dark screenshots of the row with Buddies, card chats, an unread mark and +N.

## Execution details (updated handoff)

The Engineer implements this plan task by task using test-driven development.

- Tasks 1 and 3 Files: create `desktop/lib/super_tabs/right_pane_row.dart`; modify
  `desktop/lib/super_tabs/buddy_list.dart` to expose the selected Buddy menu; tests in
  `desktop/test/super_tab_right_pane_row_test.dart`. Interface: `SuperTabRightPaneRow(controller, storage, app)`;
  controller supplies Buddies, selected chat and unread state; row selects via `controller.select`.
- Tasks 2 and 4 Files: `right_pane_row.dart`, `view.dart`, and the same widget test. Interface:
  row listens for selected conversations, remembers eligible non-Buddy chats using `LocalKeyValueStore`,
  and keeps a bounded, scoped ordered list. No new backend contract.
- Task 5 Files: same widget test, capture helpers in `test/support/capture.dart`.
- For every task: commit tests, run the named widget test and observe the expected failure; implement,
  rerun affected tests, commit and push. Capture the row in light and dark and match each acceptance item
  to its test in the PR.
- Before implementation, the row mockup in the task conversation is:
  `[Buddy] [Buddy] | [card•] [card] … [+N] [+]` with selected Buddy options below it and chat filling the rest.
- Store failure is visible as a compact persistence error while the in-memory chats remain usable; serialized
  writes preserve close/open ordering and a slow initial read cannot overwrite chats opened meanwhile.

### 6. Selected Buddy header and terminal access (River relaying Scholes)

**Files:** `desktop/lib/super_tabs/buddy_list.dart`, `buddies.dart`, `buddy_model.dart`,
`buddy_restart.dart`, `controller.dart`, `view.dart`; tests in
`desktop/test/super_tab_right_pane_board_test.dart` and `super_tab_right_pane_header_test.dart`.

**Interfaces:** `SuperTabRightPaneRow.onOpenTerminal(SuperTabAgent)` uses the view's existing terminal callback.
`SuperTabBuddyBar(compact: true)` preserves its status/recovery controls and uses a single truncating metadata line
with privacy in a tooltip. `BuddyModelLine(compact: true)` keeps the existing subscription picker, laid out within
available width. Existing full chat callers keep their layout.

- [ ] Commit and run failing tests: labelled Open terminal and the same menu item open the selected Buddy's
  terminal, with two Buddies whose agents differ; legacy name-click path remains.
- [ ] Implement the button beside ⋮, menu entry, and selected-conversation lookup for restart.
- [ ] Commit and run failing header tests at 280 and 600 px, light and dark: name first, actions aligned right,
  one metadata line, long machine and subscription ellipsized, privacy in tooltip; no overflow.
- [ ] Implement using shared typography, spacing and menu tokens; preserve subscription switching and offline states.
- [ ] Capture minimum and wide headers plus the Board with unread and overflow; run the style/icon checks and affected tests.
