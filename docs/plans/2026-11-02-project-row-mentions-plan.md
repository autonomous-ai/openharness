# A project's red number counts only what opening it shows Implementation Plan

> Implemented task by task in this session, test first, each failing test committed before its code.

**Goal:** Every red number on a project row clears by opening what it counts.

**Architecture:** `_row` in `project_sidebar.dart` shows `mentionsIn(the project's chat)` whether the project is collapsed or open, and stops adding the tags of the task conversations it hides. Those stay on the task's own row when expanded and in Activity. Landing and clearing are unchanged: a chat opens at its New line, and reading to its end moves the read mark past its tags.

**Tech Stack:** Flutter, Dart, `flutter_test`.

**Spec:** task #2189 (Dee, Slack's way).

## Global Constraints

- Desktop tests use a memory store and a fake sign-in.
- A row is still bold for anything new it hides; only the number changes.
- The unread filter still keeps a project whose hidden task tags the reader, so those stay reachable.
- No new look: the same badge, a smaller count.

```
Before                         After
> # openharness        (7)     > # openharness              bold: something is new
  opening shows none of them     Activity › Mentions still lists the 7
> # harness-pro        (3)     > # harness-pro        (3)   3 tags in its own chat
  opening clears nothing         opening lands on the New line; reading clears them
```

## Review Focus

1. A collapsed project whose only tags are in its task conversations: no number, still bold, still kept by the unread filter. Pinned in Task 1.
2. A tag in the project's chat, read to its end: the number goes. Pinned in Task 1.
3. A tag in a reply that lives only in a thread: on the Threads row, not the project's, since opening the chat cannot clear it. Pinned in Task 1.
4. An expanded project: its task rows keep their own numbers. Pinned in Task 1.
5. A muted project chat: no number, as today. Pinned in Task 1.

## Design

N/A because this stores, syncs and exposes nothing new: the row reads a count it already has.

## Limits

- The brief says "the project chat and its threads". A thread-only tag is not counted on the row: opening the chat cannot clear it, and "every number clears by opening what it counts" decides. It stays on the Threads row and in Activity.
- In a long chat the number clears on reading to the end, not on opening, as the main chat's read mark does today.

---

### Task 1: The row counts its own chat

**Files:**
- Modify: `desktop/lib/super_tabs/project_sidebar.dart`
- Test: `desktop/test/super_tab_project_row_mentions_test.dart`

**Interfaces:**
- Consumes: `SuperTabAttention.mentionsIn(String conversationId)`.

- [ ] **Step 1: Write the failing test and commit it.** A tag in a task conversation shows no number on the collapsed project row.
- [ ] **Step 2: Run it to verify it fails:** `flutter test test/super_tab_project_row_mentions_test.dart`.
- [ ] **Step 3: Implement it and commit.**
