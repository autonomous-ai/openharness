# Quiet Swarm 6/6: Zero Felt Latency Implementation Plan

> **How this is worked:** by the project's instructions, task by task, each failing test committed before its code.

**Goal:** Swarm chats open from what the device already has for the signed-in account, big answers decode off the UI thread, and nothing redraws on a timer while it's off screen.

**Architecture:** The saved view, already kept per account, also carries the last rows of the chats most recently read, so switching chat or project after a restart shows them at once and the read corrects them. `WsConn` decodes large frames in an isolate, in frame order. A small `State` mixin runs a panel's timer only while its subtree is on screen and the app is in front.

**Tech Stack:** Dart, Flutter 3.47.2, `flutter_test`.

**Spec:** `docs/plans/2026-11-02-quiet-swarm-design.md`, section "Speed: aim for zero felt latency". Task #2195 (Dee). Builds on #2617, and this branch includes it until it lands.

## Global Constraints

- Another account's cache is never shown. Rows live inside the per-account saved view, so its forgetting at sign-in covers them.
- No new colors, icons or controls, and nothing on screen changes but its speed.
- No on/off switch. Tests use a memory store and a fake sign-in.
- Swarm code stays out of `cli/src/core`.
- The PR body starts with: `Requested by dee@autonomous.ai through Harness.`
- Two security reviews: Reed and Orion.

## Review Focus

1. **A chat the reader lost access to:** its kept rows go when the first read answers, not only the selected chat's. A private chat's rows are never drawn for a chat the saved state doesn't list.
2. **Frame order:** a small frame after a large one still arrives second, so replies and pushes can't swap.
3. **A frame that won't decode in the isolate:** dropped as a bad frame is today, with the queue alive.
4. **The app behind other windows, and a panel on a tab that isn't showing:** no timer runs, and coming back draws at once, so the "2 min ago" text is never stale on screen.
5. **The kept view growing past its limit:** the older chats go first, so the selected chat's view is still kept.

## What's already there

A sent message already shows at once with a quiet sending mark (`outgoing`, `SuperTabOutgoingState.sending`), and no spinner. This task adds a test to hold that, and no code. The chat's messages already build lazily. The sidebar, Activity, Members and machine lists belong to the other parts of this design, whose Engineers are changing them now, so they are left to them.

## Design

- **Growth:** at most 5 other chats of 30 rows each in a saved view, inside its existing 512 KB limit, deleted with the view (7 days, 3 Swarms, sign-out).
- **Concurrency:** decoding joins the existing inbound queue, so frames stay in order.
- **Read cost:** none added. Fewer redraws and reads while off screen.
- **Scale:** at 10x rows, the view hits its byte limit first, and older chats drop. The log's `first open` line warns first.
- **Compatibility:** a view from before this has no extra chats and reads as today. An older build ignores the new key.
- **Migration and rollback:** none. Rolling back ignores the key.
- **Audience:** only this account's saved view holds these rows, and the server still decides at each read.
- **Identity:** the Harness account, never the machine owner's login.
- **Failure:** a bad row or chat in the view is skipped. A failed isolate spawn decodes on the UI thread as today.
- **Platforms:** the web has no isolates, and `compute` runs inline there, as today. The web's view has the same limits.

---

### Task 1: Timers only while on screen

**Files:**
- Create: `desktop/lib/super_tabs/visible_tick.dart`
- Modify: `machines.dart`, `roster.dart`, `leaderboard/reader.dart` callers, `pull_request_facts.dart` callers
- Test: `desktop/test/super_tab_visible_tick_test.dart`

**Interfaces:**
- Produces: `mixin VisibleTick<T extends StatefulWidget> on State<T>` with `visibleTick(Duration every, VoidCallback onTick)` and `onVisibleChanged(bool)`.

- [ ] **Step 1: Commit the failing tests:** under `TickerMode(enabled: false)`, or with the app hidden, a panel's timer doesn't fire and it doesn't rebuild; back on screen it redraws at once and ticks again; a board's refresh stops off screen; a pull request card stops watching off screen.
- [ ] **Step 2: Watch them fail,** then implement, run them and commit.

### Task 2: Large answers decode off the UI thread

**Files:**
- Modify: `desktop/lib/ws/ws_conn.dart`
- Test: `desktop/test/ws_conn_decode_test.dart`

**Interfaces:**
- Produces: `decodeFrame(String raw) -> Future<Map<String, dynamic>>`, in an isolate above `largeFrameChars` (256 KB, where its start stops costing more than it saves).

- [ ] **Step 1: Commit the failing tests:** a large frame goes to the isolate decoder and a small one doesn't; a small frame after a large one arrives second; a bad large frame is dropped and the next arrives; a failed spawn still decodes.
- [ ] **Step 2: Watch them fail,** then implement, run them and commit.

### Task 3: The last messages of each chat

**Files:**
- Modify: `desktop/lib/super_tabs/controller.dart`
- Test: `desktop/test/super_tab_saved_view_test.dart`, `desktop/test/super_tab_reading_client_test.dart`

- [ ] **Step 1: Commit the failing tests:** a saved view holds other chats' last rows, and opening again shows them at once on selecting; a chat the reader lost goes after the first read; a refused read clears all; another account's are never read; the limits hold, the selected chat is kept and older chats drop; a sent message shows before the server answers (holds what's there).
- [ ] **Step 2: Watch them fail,** then implement, run them and commit.

### Task 4: Timings and proof

- [ ] **Step 1: Measure** first open, project switch and send-to-shown, before and after, with the same held steps in a test, and post them in a PR comment. This Mac can't build the macOS app, so real numbers come from `first open` after the Desktop release.
- [ ] **Step 2: Run** the Swarm and WebSocket tests, mark the PR ready, and ask Reed and Orion.
