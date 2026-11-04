# Jump reads one window, the chat list stays small: Implementation Plan

> Implemented by the task's Engineer task by task, each failing test committed before its code (project instructions,
> Engineer). One independent review on the pull request.

**Goal:** A date pill Jump to (Last week, Last month, a day, The very beginning) reads the messages around that time in
one request, the chat shows that window, reads newer or older pages only as the reader scrolls, and drops rows far off
screen so the held list stays near 300 rows. Jump to latest goes back to the live end in one read. The chat's Jump to
menu comes back on top of it, with #2762's selection assertion checked against the new path (task #2911, Huy 11-04).

**Architecture:**

- Backend: `GET .../conversations/:id/messages?at=<ms>` (routes/superTabs.ts, store.ts `messages`). `sequenceAt`
  (pageReads.ts) finds the first sequence at or after the time by a binary search of point reads on the existing
  `(tabId, conversationId, sequence, id)` index (one key and one row each, about log2 of the conversation's last
  sequence reads, about 20). The page is then the 100 rows this reader may see before it plus the 100 from it, read with
  the same batches, filters, reactions, receipts and threads as every page. `next` is the older cursor as before; a new
  `newer` names the newest row when more come after it.
- Desktop controller: `jumpTo(id, from)` replaces what the conversation holds with that window in one read and returns
  the row to land on; `loadNewer(id)` reads the page after the newest held while the window is short of the end. The
  held list is capped at `_windowRows` (300) both ways: an older page drops the newest rows far below the reader, a newer
  page drops the oldest far above, never from the view's dividing row. Dropped newer rows set `hasNewer`, as a reader
  scrolled up already does; dropped older rows move the older cursor.
- Desktop view: the chat's `SuperTabStickyDay` gets `onJump` again; `_jumpToTime` calls `jumpTo` once and lights the
  row. A scroll ending near the bottom with `hasNewer` reads the next page (`_readNewerNearBottom`), as near the top
  reads the earlier one. Before a page that drops rows, the dividing row moves to the row at the top of the view, up or
  down, so nothing on screen moves.

**Tech Stack:** TypeScript, Fastify, Prisma 5 on MongoDB (`aggregateRaw` through `readBy`), Vitest with
mongodb-memory-server; Flutter 3.47.2 (Desktop and web share the chat code).

**Spec:** task #2911's brief. MongoDB's schema design and query optimization skills were read for the new read: it adds no
index and no field, and each probe is an equality-then-range-then-sort read the existing index serves (ESR).

## Design

- growth: N/A because nothing new is stored; the read returns at most 200 rows.
- concurrency: N/A because this is a read; a message written during the search lands after the window and is read by the
  next poll or `loadNewer`.
- read cost: one request for a jump instead of one per 100 rows back (a week of a busy chat was 30 to 50 requests); about
  20 one-key index reads plus two page reads. The client holds at most about 300 rows per conversation while reading back.
- scale: at 10x messages the search grows by about 3 probes (log2); `messages by reader` with cursor `at` logs batches and
  rows decoded per read and warns first.
- compatibility: old clients never send `at` and ignore `newer`. A new Desktop against a backend without `at` gets the
  strict query's 400: the jump says "Messages could not be read." and the chat stays as it was. The backend ships first.
- migration + rollback: N/A because no schema or data change; rolling back the backend removes `at`, which the new client
  reports as above.
- audience: the server enforces it: the window goes through the same read check and row filter as every page; the search
  reads only `sequence` and `createdAt` and returns no row it reads.
- identity: N/A because the read is the reader's own, as every page.
- failure: a failed jump shows a snack bar and keeps the list; a failed newer page keeps `hasNewer` and Jump to latest.
- platforms: Desktop on macOS, Linux and Windows, and the web build (shared chat code). The phone app is unchanged.

## Global Constraints

- Red first for every risk the brief names: a jump a week back is one read; scrolling loads pages both ways; far rows drop;
  Jump to latest is one read; the selection-assertion case from #2762.
- Before and after numbers on a chat of 5,000 messages over two weeks: reads, wall time to land, rows held and the frame
  build time of the landing, from one measuring test run on main's code and on this branch.
- Desktop tests use a memory store and a fake sign-in; nothing signs the Mac out of the real CLI.
- Swarm code stays out of cli/src/core. Temp files only in mktemp -d folders.
- The thread pane's pill keeps showing the day only: a thread reads whole, and its jump is not in this task.

## Review Focus

- `sequenceAt`'s loop ends, finds the first row at or after the time, and every probe is an `IXSCAN` with one key examined.
- The window passes the same read check as every page (hidden rows, Buddy rows, session threads).
- The controller's drops never cut the view's dividing row or a row on screen, and `hasNewer` / `hasOlder` stay true for
  what was dropped.
- Moving the dividing row up keeps the rows on screen in place.

## Task 1: Backend window read

**Files:** `backend/src/superTabs/pageReads.ts`, `backend/src/superTabs/store.ts`, `backend/src/routes/superTabs.ts`,
`backend/src/superTabs/messageReadStats.ts`, `backend/integration/superTabMessagePages.test.ts`.

**Interfaces:** `sequenceAt(tx, tabId, conversationId, at: Date, upTo: number): Promise<number>`;
`store.messages(..., { at?: number })` answers `{ messages, next, newer, threads, reactionSeq }`.

- [ ] Write the failing tests: a 5,000-row chat over two weeks, `at` a week back answers the 100 rows before and the 100
      from that time in one read, with `next` and `newer`; `at` 0 answers the first 100 and `next` null; a time after
      everything answers the newest 100 and `newer` null; hidden rows never shorten either half; each probe's plan is an
      `IXSCAN` on the sequence index with one key examined; `at` with another cursor is refused.
- [ ] Run them and watch them fail.
- [ ] Implement `sequenceAt`, the `at` page and the query field; count the read under cursor `at`.
- [ ] Run the file's tests; commit.

## Task 2: Controller window, pages both ways and drops

**Files:** `desktop/lib/super_tabs/controller.dart`, `desktop/test/support/super_tab_fixture.dart` (the fake server answers
`at` and `newer`), `desktop/test/super_tab_jump_window_test.dart`.

**Interfaces:** `Future<String?> jumpTo(String id, DateTime? from)`, `Future<void> loadNewer(String id)`.

- [ ] Write the failing tests: `jumpTo` a week back is one read and holds the window; `loadNewer` appends one page and
      clears `hasNewer` at the end; older pages past 300 rows drop the newest and set `hasNewer`; newer pages past 300 drop
      the oldest and keep `hasOlder`; `showLatest` after a jump is one read and ends at the live end.
- [ ] Run them and watch them fail.
- [ ] Implement.
- [ ] Run them and the controller's paging tests; commit.

## Task 3: The chat's Jump to, paging near the bottom, the dividing row both ways

**Files:** `desktop/lib/super_tabs/view.dart`, `desktop/test/super_tab_day_jump_test.dart`,
`desktop/test/super_tab_jump_window_test.dart`.

- [ ] Write the failing tests: choosing Last week in the chat's pill lands on and lights that day's first message after one
      read; scrolling to the bottom reads the next page, to the top the earlier one, with the rows on screen in place; the
      list stays at most about 300 rows; Jump to latest lands at the end in one read; text selected in the chat, then a
      jump, pages both ways and drops, raises no exception and leaves no error widget (#2762).
- [ ] Run them and watch them fail.
- [ ] Implement.
- [ ] Run them with the chat, chat scroll, chat edge, jump to latest, day pill, unread and thread scroll tests; commit.

## Task 4: Numbers and screenshots

- [ ] One measuring test (`SUPER_TAB_JUMP_NUMBERS=1`) on a 5,000-message chat: the jump the old way (pages read until that
      day) on main's code, then `jumpTo` on this branch; reads, wall time, rows held, build time of the landing frame.
- [ ] Light and dark screenshots of the pill's menu and the landed chat for Huy.
