# Threads card: Show N more replies expands in place — Plan

**Goal:** On the Desktop Threads page, "Show N more replies" expands the same card to show every reply, loading older replies when the card holds only the newest page. The screen stays as it is: no chat opens, no Thread pane appears.
**Architecture:** `SuperTabThreadCards` (one per controller, `thread_cards.dart`) keeps each card's data. It gains an `expanded` flag and the older-page cursor (`next`) per card, and `expand(thread)` reads older pages of the thread (`?thread=ROOT&before=SEQ&beforeId=ID`, the thread pane's own paging) until it holds every reply. `_ThreadCard` shows all replies of an expanded card and drops the button. The title still opens the thread beside its chat.
**Tech Stack:** Flutter/Dart (Desktop), `flutter_test`, the `ConversationServer` fixture (`messagePage` makes a thread longer than one page).
**Spec:** Task #3619 (Tony, 2026-11-06).

## Design
- growth: replies of one expanded card are held in memory until the page closes (`clear`) or the thread leaves the list (`retain`); paging stops at 40 pages, so a runaway thread cannot loop.
- concurrency: single UI isolate; one older read per card at a time (joins a running one); answers for a closed page are dropped by the existing generation check.
- read cost: expanding reads only the older pages the card lacks; a card that already holds every reply reads nothing. Nothing polls.
- scale: a thread with thousands of replies takes pages until the cap; the button then keeps its count.
- compatibility: same read as the thread pane; an old server without `next` answers one page and the card shows what it holds.
- migration + rollback: none; revert the change.
- audience: the same reads the thread pane makes; the server enforces who may read.
- identity: unchanged.
- failure: a failed older read keeps the button, shows "Could not load earlier replies." and retries on the next tap.
- platforms: Desktop Dart only; no native or Windows-specific code.

## Global Constraints
- Out of scope: other ways to open a thread from the card, the Mentions and Decisions pages, the phone app.
- Tests use a memory store and a fake sign-in; nothing signs the real CLI in or out.
- Swarm code stays out of cli/src/core.

## Review Focus
- Expanding never calls `onOpenThread`.
- A card that reloads (a new reply arrives) keeps the older replies it loaded and stays expanded.
- The New line still sits above the first unread reply.

## Tasks

### Task 1: Test, then the data: expand loads every reply
**Files:** `desktop/test/super_tab_threads_page_test.dart`, `desktop/lib/super_tabs/thread_cards.dart`
**Interfaces:** `SuperTabThreadCard.expanded`, `.next`, `.loadingOlder`, `.olderError`; `SuperTabThreadCards.expand(SuperTabFollowedThread)`.
- [ ] Failing test: a card whose thread has more replies than one page shows every reply after Show N more replies, opens no pane.
- [ ] Failing test: a card that holds every reply already expands with no extra read.
- [ ] Failing test: a failed older read keeps the button and says so; the next tap loads.
- [ ] Failing test: a reload after expanding keeps the older replies.
- [ ] Implement `expand`, the `next` cursor and the merge on reload.

### Task 2: The card shows them
**Files:** `desktop/lib/super_tabs/threads_page.dart`
- [ ] The button calls `cards.expand`, not `onOpenThread`; an expanded card shows all replies and no button.
- [ ] Light and dark pictures of an expanded card (capture test).
