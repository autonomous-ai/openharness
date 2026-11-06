# Right pane keeps several conversations in an avatar row — plan (task #3881)

**Goal:** The Desktop right pane beside the Board holds several conversations (anh Dee, 11-06 15:5x). A horizontal
avatar row across its top: the person's Buddies pinned on the left, a divider, then the card chats they opened, each
with an unread mark; hover shows the title and a close ×; + starts a new Buddy; about 7 or 8 fit, then +N opens the
rest. Clicking a card on the Board adds its chat to the row and opens it below; the Board never changes. The selected
conversation fills the pane below the row. Open card chats are kept per person across restarts.

**Architecture:** Builds on main once #3820 (the Buddies list, PR #3386), #3863 (fixed layout, PR #3399) and #3864
(Buddy ⋮ menu, PR #3398) are in. The row replaces #3820's `SuperTabBuddyList` in `_boardChat` (`view.dart`); a new
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
