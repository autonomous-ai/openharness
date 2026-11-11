# Thread tag in the unread bar: implementation plan

> Way of working: the project's Engineer role (plan first, then each task test first, one review on the pull request).

**Goal:** When the chat you open holds an unread tag of you inside a thread, the chat says so at its top ("1 new reply
mentions you · Open"), and Open opens that thread at the reply, lit. The thread's root row says how many replies are new.
Reading it clears the row and the sidebar's red number. Today's main-chat unread bar is unchanged. (Task #2814, Lê Lộc.)

**Architecture:** The tags already reach Desktop (`SuperTabMentions.waiting`, with `threadId` and `messageSequence`), and
`SuperTabAttention.tagsIn` already counts those past the thread's read mark for the sidebar. A new
`SuperTabAttention.threadTagsIn` lists those tags in thread replies, oldest first. The chat draws a new
`SuperTabThreadTagBar` row above today's bar while that list is not empty. Open calls `openThread(root, at: reply)`; the
controller keeps the reply as the thread's target and the thread panel lights it once held. Opening the thread reads it
(`_seeThread`), which already moves the thread mark, so the tag stops counting in the bar and the sidebar. The thread
line takes the followed thread's `unreadReplies` as "N new".

**Tech stack:** Flutter (desktop/lib/super_tabs), widget tests with the memory `ConversationServer` fixture and a fake
sign-in. No backend change.

**Spec:** the task's brief (#2814) and the mockup posted to Lê Lộc in the project chat.

## Global constraints

- Desktop and web share this code; the phone app has its own chat code and is out of scope.
- Harness design language: flat row, words carry the meaning (never colour alone), tokens from `DesktopChrome`/`grid`.
- Desktop tests use the memory store and a fake sign-in; nothing signs the real CLI out.
- No backend or cli/src/core change.

## Review focus

- The bar counts exactly what the sidebar's red number counts for thread tags (same mark, same muted rule).
- Open lands on the oldest tag; the panel lights the reply once it is held, without following the end over it.
- A main-chat unread keeps today's bar, its Jump and Mark as read.

## Design

N/A because this stores, syncs and exposes no new data: it reads the tags and thread marks Desktop already holds.

## Task 1: thread tags of a chat, oldest first

**Files:** `desktop/lib/super_tabs/attention.dart`, `desktop/test/super_tab_thread_tag_bar_test.dart`

**Interfaces:** `List<SuperTabMention> SuperTabAttention.threadTagsIn(String conversationId)`

- [ ] Failing test: two thread tags in one chat list oldest first; one read past its thread mark drops out; a main-stream
      tag and a muted chat list nothing.
- [ ] Code that passes it.

## Task 2: the bar, and Open at the reply

**Files:** `desktop/lib/super_tabs/unread_line.dart`, `view.dart`, `controller.dart`, `thread_panel.dart`, the test above

**Interfaces:** `SuperTabThreadTagBar({count, onOpen})`; `SuperTabController.openThread(root, {shown, String? at})`;
`SuperTabController.threadTarget` (the reply to light, by root).

- [ ] Failing widget tests: a thread tag shows "1 new reply mentions you · Open"; Open opens the thread with the reply
      lit; the bar and the sidebar count go once read; two threads say "2 new replies mention you" and Open goes to
      the oldest first, then the bar says 1; a main-chat unread shows today's bar and no thread row.
- [ ] Code that passes them.

## Task 3: the thread row's new replies

**Files:** `desktop/lib/super_tabs/message_row.dart`, `view.dart`, the test above

**Interfaces:** `SuperTabThreadLine.fresh` (new replies, 0 for none)

- [ ] Failing test: an unread followed thread's row says "2 new"; once read it does not.
- [ ] Code that passes it.

## Task 4: screenshots and guard tests

- [ ] Light and dark screenshots of the chat with the bar and the row (`SUPER_TAB_THREAD_TAG_SHOTS=<dir>`).
- [ ] Desktop guard tests: `check-ui-style`, `laid_out_list_test`, the changed files' tests.
