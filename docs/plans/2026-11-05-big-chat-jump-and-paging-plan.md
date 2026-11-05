# Big chats: Jump to latest and smooth scrolling up — plan

**Goal:** In a chat with a very large history (the openharness project chat, ~4,100 messages in 42
pages), Jump to latest always shows the newest messages at once, and scrolling far up reads older
pages without the reader waiting at the top (task #3049, Huy, 2026-11-05).

**Architecture:** The Swarm chat is one `CustomScrollView` split at a dividing row: older pages
grow upward in one `SliverList`, newer rows downward in another (`desktop/lib/super_tabs/view.dart`).
A `SliverList` of rows of unknown height can only reach a row by laying out every row between,
so a jump from the top of 4,000 rows to the end lays out all of them in one frame. It then jumps to
an extent estimated from rows of very different heights, lands thousands of pixels past the real
end, and on the Mac's bouncing scroll the list shows no row while it springs back. The fix restarts
the list at the newest rows instead of travelling there: the dividing row moves to the newest rows,
both slivers are rebuilt empty under a new key, and the view starts at the dividing row, so the
jump lays out only the rows below it. Reading older pages starts while the reader is still a few
screens below the top, and keeps going while the rows read stay within that distance.

**Tech Stack:** Flutter 3.47 (Desktop), `flutter_test` widget tests with `ConversationServer`.

**Spec:** task #3049 brief (conversation a3ea0edbcbc1bf1d891250be).

This plan is implemented by its Engineer task by task, test first, as the project instructions say.

## Global Constraints

- Owns `desktop/lib/super_tabs/view.dart`, `desktop/lib/super_tabs/chat_scroll.dart` and their tests.
  No backend or CLI change; Swarm code stays out of `cli/src/core`.
- Desktop tests use a memory store and a fake sign-in; none signs the Mac out of the real CLI.
- Measured with the real openharness chat's pages replayed headless (`flutter test`, debug, Mac
  scroll physics) before and after; the replay and the chat's data stay local and are never committed.

## Review Focus

- The restart keeps nothing on screen from the old position: no row is anchored across it, and a
  later poll still cuts the held rows above the new dividing row.
- Jump to latest from near the end is unchanged (no restart, no rebuilt rows).
- Prefetching older pages during a drag never jumps the view (the anchored position keeps it).

## Task 1: Jump to latest restarts the list at the newest rows

**Files:** `desktop/lib/super_tabs/view.dart`, `desktop/lib/super_tabs/chat_scroll.dart`,
`desktop/test/super_tab_big_chat_jump_test.dart`

**Interfaces:** `SuperTabChatScroll.restart()` puts the view at the dividing row and forgets the
place it kept; the view's `_restartAtEnd(id)` moves the dividing row to the newest rows and rekeys
both slivers.

- [ ] Failing test: a 1,500-row chat with rows of the real chat's heights, scrolled to its top on
      Mac physics; after Jump to latest every frame shows a row and the newest row shows at the end.
- [ ] Failing test: the same after more than a page arrived while scrolled up (the latest page read).
- [ ] Code: `_jumpToLatest` restarts when more than a screenful of rows lies below the view or newer
      pages wait; `_followEnd` jumps again when it landed past the end.

## Task 2: Older pages are read before the reader reaches the top

**Files:** `desktop/lib/super_tabs/view.dart`, `desktop/test/super_tab_big_chat_jump_test.dart`

**Interfaces:** `_readEarlierNearTop` takes scroll updates too, within `_readAhead` of the top.

- [ ] Failing test: scrolling up steadily without stopping, the next page is read while the reader
      is still more than a screen below the top.
- [ ] Failing test: a page that brings few rows (most are thread replies) reads the next one by itself
      while the rows stay within the distance.
- [ ] Code: read on scroll updates within the distance; after a page lands, read the next while
      still within it.

## Task 3: Measure again

- [ ] The same replay as before the change; numbers and a screenshot to Huy in the task.
