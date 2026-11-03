# Phone Activity rows land on their message Implementation Plan

> **For agentic workers:** This plan is implemented by the Engineer task by task, test first (project instructions, Engineer role), not by subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opening a row in the phone's Activity tab lands on its message: in the thread it lives in, or in the main chat, lit for 2 seconds.

**Architecture:** An Activity item says which thread (if any) its message is in and what the thread should land on (`SwarmThreadFocus`: one message, or the first unread). The chat route carries that focus through `SwarmOpenedChat` and `SwarmProjectPage` to `SwarmConversationPage`, which hands it to `SwarmThreadPage` when it opens the thread. The thread page reads earlier replies until the message is loaded, scrolls to it and lights it for 2 seconds, as the main chat's `_jumpTo` does.

**Tech Stack:** Flutter (mobile/), flutter_test widget tests with `FakeSwarm`.

**Spec:** Task #2126 brief (Tony) and the mockup posted in its conversation (message 5e649c9e). Evidence from code: `mobile/lib/swarm/swarm_activity_page.dart` `_reply`, `swarm_conversation_page.dart` `_jumpTo` / `_openThread`, `swarm_thread_page.dart`.

## Global Constraints

- Swarm code stays out of `cli/src/core`; this change is mobile only.
- Lit for exactly 2 seconds, as the main chat (`Duration(seconds: 2)`).
- Decisions stay answered in Activity: a decision row never opens a chat on a message.
- A row whose message is in the main stream (or also sent to the chat) keeps landing in the main chat as today.
- A thread whose message cannot be found (deleted, too old) opens at its top with no error and no loop.
- Never install a build on a phone; the Tester uses the simulator.
- PR body starts with "Requested by tony@autonomous.ai through Harness." and holds red/green evidence in a comment.

## Review Focus

- The target is further back than the thread's first pages (5 pages): earlier pages are read until it shows, with a bound.
- The first-unread landing reads the thread's read mark before the thread page marks the thread read.
- A thread with no unread replies lands on its newest reply.
- A reply also sent to the chat (not only in its thread) still lands in the main chat.
- The lit state ends after 2 seconds and does not return when the list rebuilds.
- Back from the thread returns to the chat, then Activity, as Threads does.

## Design

N/A because nothing is stored, synced or exposed: it changes where a tap navigates and scrolls on the phone, using reads the thread page already makes. The only new read is "Show earlier replies" pages, bounded by `SwarmThreadFocus.maxEarlierPages`.

---

### Task 1: Thread page lands on a focus

**Files:**
- Modify: `mobile/lib/swarm/swarm_thread_page.dart` (new `SwarmThreadFocus`, `focus` param, `lit` in `SwarmThreadRow`)
- Modify: `mobile/lib/swarm/swarm_conversation_page.dart` (`_threadRow` passes `lit`; `_openThread(c, root, {focus})`)
- Test: `mobile/test/swarm/swarm_thread_focus_test.dart`

**Interfaces:**
- Produces: `class SwarmThreadFocus { const SwarmThreadFocus.message(String id); const SwarmThreadFocus.firstUnread(); final String? messageId; bool get firstUnread; static const maxEarlierPages = 50; }`
- Produces: `SwarmThreadPage({..., SwarmThreadFocus? focus})`; `SwarmThreadRow` gains `required bool lit`.
- Produces: `SwarmConversationPage.threadFocus` (`SwarmThreadFocus?`), used when the chat opens `threadId`.

- [ ] **Step 1: Write the failing tests** in `swarm_thread_focus_test.dart` (harness copied from `swarm_thread_jump_test.dart`): a thread of 40 replies opened with `SwarmThreadFocus.message('m20')` shows `Reply 20.` on screen and `swarm-lit-m20` present, absent after `pump(Duration(seconds: 2))`; a thread with `older: true` where `m3` is only on the earlier page (route with `before=`) reads that page and lands on `m3`; `firstUnread` with mark 10 of 40 lands on `Reply 11.`; `firstUnread` with mark 40 lands on `Reply 40.`; a missing id leaves the thread at its top with no error text.
- [ ] **Step 2: Run** `flutter test test/swarm/swarm_thread_focus_test.dart` — expect compile failure (`SwarmThreadFocus` undefined).
- [ ] **Step 3: Implement** `SwarmThreadFocus` and the page's landing: after the first load, read `loadEarlier()` while the target is missing and `hasEarlier` (at most `maxEarlierPages`), then reveal as the chat's `_reveal` does (jump near by index until the row is built, then `Scrollable.ensureVisible(alignment: 0.5)`), then set `_lit` for 2 s. `firstUnread` resolves from the thread's read mark captured in `initState` (before `markRead` moves it): the first reply with `sequence` above it, else the newest.
- [ ] **Step 4: Run** the same file — expect PASS. Commit tests first (failing), then code.

### Task 2: The chat route carries the focus

**Files:**
- Modify: `mobile/lib/swarm/swarm_project_page.dart` (`swarmChatRoute`, `SwarmOpenedChat`, `SwarmProjectPage` take `threadFocus`)
- Modify: `mobile/lib/swarm/swarm_conversation_page.dart` (`threadFocus`, `_jumpTo` passes it; a thread reply found in the chat opens its thread with `SwarmThreadFocus.message(messageId)`)
- Test: `mobile/test/swarm/swarm_thread_focus_test.dart` (group "opened from a link")

**Interfaces:**
- Consumes: Task 1's `SwarmThreadFocus`.
- Produces: `swarmChatRoute({..., SwarmThreadFocus? threadFocus})`.

- [ ] **Step 1: Write the failing test**: `SwarmConversationPage(messageId: 'm1', threadId: 'm1', threadFocus: SwarmThreadFocus.message('m20'))` shows the thread with `Reply 20.` lit; and a link with only `messageId: 'm20'` (a thread-only reply) opens its thread at `Reply 20.` lit.
- [ ] **Step 2: Run it** — expect FAIL (`threadFocus` is not a parameter).
- [ ] **Step 3: Implement** the pass-through; forget `threadFocus` with `_threadId` once the chat has shown it (swarm_project_page.dart where `_messageId = _threadId = null`).
- [ ] **Step 4: Run** — PASS. Commit.

### Task 3: Activity rows choose their landing

**Files:**
- Modify: `mobile/lib/swarm/swarm_activity.dart` (`SwarmActivityItem.threadId`, `.threadFocus`)
- Modify: `mobile/lib/swarm/swarm_activity_page.dart` (`_reply` builds the route from them)
- Test: `mobile/test/swarm/swarm_activity_landing_test.dart`

**Interfaces:**
- Produces: `String? SwarmActivityItem.threadId` (the thread root when the message lives only in a thread, else null) and `SwarmThreadFocus? SwarmActivityItem.threadFocus`. Reply and reaction server rows with `entry.threadId`, mentions with `mention.threadId`, a phone-built reaction on a thread-only message: focus on that message. `SwarmActivityThread`: `threadId` the root, `SwarmThreadFocus.firstUnread()`. A decision or work need and any main-stream row: both null.
- Route from a row: `messageId: threadId ?? messageId`, `threadId`, `threadFocus`.

- [ ] **Step 1: Write the failing tests** (harness from `swarm_activity_page_test.dart`): tapping each row type opens the right place — a server reply in a thread, a server reaction on a thread message, a tag in a thread, and each one with the message only on an earlier page of the thread (too far back to be loaded at first): `SwarmThreadPage` is up and the message is lit and on screen; a Threads row lands on its first unread, or the newest when all read; a main-chat reply, tag and reaction still land in the chat, lit, no thread page; a decision row still opens in Activity.
- [ ] **Step 2: Run** — the thread cases FAIL on main (no thread opens; the chat is shown at the root).
- [ ] **Step 3: Implement** the item getters and the route in `_reply`.
- [ ] **Step 4: Run** `flutter test test/swarm/` for the files touched plus `swarm_activity_*_test.dart`, `swarm_threads_*_test.dart`, `swarm_thread_*_test.dart`; then `flutter analyze`. Commit.

### Task 4: Evidence

- [ ] Run each new test against `origin/main`'s lib (stash the lib change) and record the failures; post red/green in a PR comment.
- [ ] Add the Tester step (phone simulator on this Mac) with the task's "Done when": each row type landing, with screenshots.
