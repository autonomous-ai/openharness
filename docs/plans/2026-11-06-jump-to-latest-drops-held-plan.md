# Jump to latest drops the held older window — plan (task #3630)

**Goal:** In a very large chat (the openharness project chat: 4,819 messages, 2,720 of them thread replies), Jump to
latest from far up always lands on the newest messages with nothing missing and never an empty list (Huy, 11-05 and
11-06).

**Architecture:** Today, Jump to latest from far up with nothing newer waiting keeps every row read on the way up
(here, the whole history) and rebuilds the list around its newest 40 rows (#3049). The held rows stay until a later
poll cuts them. The fix follows the brief: from far up, Jump to latest always asks the controller for the latest page,
which replaces what is held (the existing latest read, `_latestWanted`). The rows on screen stay until that page
lands, so the list is never empty, and then the list restarts at its newest rows as before. A jump from near the end is
unchanged: no read, no rebuilt rows.

**Tech Stack:** Flutter 3.47 (Desktop), `flutter_test` widget tests with `ConversationServer` (memory store, fake
sign-in).

**Spec:** River's brief on task #3630 (conversation 1bcd2e7b75220952e3c693b2).

This plan is written and carried out by its Engineer, test first; there is no execution handoff.

## Global Constraints

- Owns `desktop/lib/super_tabs/`. No backend or CLI change.
- Desktop tests use a memory store and a fake sign-in; none runs the real CLI.
- The real project chat replayed headless stays local and is never committed.

## Review Focus

- The list shows rows in every frame between the press and the newest page landing.
- Nothing newer than the newest held is missed: the latest page is read whole.
- Jump to latest from near the end reads nothing and rebuilds nothing.

## Tasks

### 1. From far up, Jump to latest replaces the held window with the latest page

Files: `desktop/lib/super_tabs/controller.dart`, `desktop/lib/super_tabs/view.dart`,
`desktop/test/super_tab_big_chat_jump_test.dart`.
Interfaces: `SuperTabController.showLatest(id, {bool replace = false})`.

- [ ] Failing test: a 1,500-message chat scrolled to its start; Jump to latest shows the newest message, every frame
      shows rows, and afterwards the chat holds one page (100), not 1,500, with older history still readable.
- [ ] Failing test: the same with the server slow to answer: rows stay on screen while the page is on its way.
- [ ] Test (guard): Jump to latest from near the end reads no messages.
- [ ] Code: `showLatest(replace: true)` asks for the latest page whole; the view calls it when far from the end.
