# A thread reply survives a Swarm switch and a quit Implementation Plan

> Implemented task by task in this session, test first, each failing test committed before its code.

**Goal:** A thread reply being written comes back after switching Swarms or quitting, as the main chat draft does.

**Architecture:** `SuperTabController._localState` saves each thread draft with its conversation and tags, and the open thread; the constructor restores them, and `setThreadDraft` schedules a save. Pasted files are bytes and are not saved: the client hands them from the released controller to the next one, in memory, so they survive a switch but not a quit, as the main chat's do.

**Tech Stack:** Flutter, Dart, `flutter_test`.

**Spec:** task #2144; repro on main `680b3224a`.

## Global Constraints

- Desktop tests use a memory store and a fake sign-in, and never drive the real app on this Mac.
- A draft goes when its conversation goes for this reader, as a chat draft does.
- Saved state stays small: at most 500 thread drafts, as `threadSeen`.
- Saved state from an older client, with no thread drafts, still loads.
- Files never reach another account: the client's in-memory hand-over ends with the account.

## Review Focus

1. A conversation removed for this reader while its thread draft is saved: the text is gone from memory and from the next save. Pinned in Task 1.
2. A saved entry that is malformed, or from another account: ignored without breaking the load. Pinned in Task 1.
3. Sending or clearing a reply: no old text comes back on the next start. Pinned in Task 1.
4. A restored open thread in a conversation no longer readable: the pane does not open. Pinned in Task 2.
5. Another account signing in, or access lost, before a Swarm is opened again: its files are not handed on. Pinned in Task 3.

## Design

- **Growth:** the newest 500 thread drafts are kept; a sent or emptied draft leaves at once. Files in memory are kept for the newest 8 Swarms let go, and end with the account or when their conversation goes.
- **Concurrency:** saves already run one after another (`_persist`); this adds fields only.
- **Read cost:** read once at the controller's start; a save writes the state it already writes.
- **Scale:** 10x threads is capped at 500 drafts. Saved state's size warns first.
- **Compatibility:** old state has no such key and loads with none; an older client ignores the new keys.
- **Migration and rollback:** none; an older client drops the keys on its next save.
- **Audience:** the state is this account's on this computer, checked by `tabId` and `accountId` as today. A removed conversation's draft goes.
- **Identity:** the account id of the signed-in reader, as today.
- **Failure:** a save that fails says so as a chat draft's does.
- **Platforms:** all Desktop platforms; the same code path.

## Limits

- Files do not survive a quit: they are bytes, kept in memory only, as the main chat's are.
- After access is revoked, saved text stays on this computer as a chat draft's does.

---

### Task 1: Thread drafts are saved and restored

**Files:**
- Modify: `desktop/lib/super_tabs/controller.dart`, `desktop/lib/super_tabs/thread_panel.dart`, `desktop/lib/super_tabs/threads_view.dart`
- Test: `desktop/test/super_tab_thread_composer_test.dart`

**Interfaces:**
- Produces: `setThreadDraft(String root, String text, {String? conversationId})`; state key `threadDrafts`.

- [ ] **Step 1: Write the failing test and commit it.** Set a draft and a tag, flush, dispose, build from what was saved: both are there.
- [ ] **Step 2: Run it to verify it fails:** `flutter test test/super_tab_thread_composer_test.dart`.
- [ ] **Step 3: Implement it and commit.**

### Task 2: The open thread reopens

**Files:**
- Modify: `desktop/lib/super_tabs/controller.dart`
- Test: `desktop/test/super_tab_thread_composer_test.dart`

**Interfaces:**
- Produces: state key `openThread`.

- [ ] **Step 1: Write the failing test and commit it.**
- [ ] **Step 2: Run it to verify it fails.**
- [ ] **Step 3: Implement it and commit.**

### Task 3: Pasted files survive a release

**Files:**
- Modify: `desktop/lib/super_tabs/controller.dart`, `desktop/lib/super_tabs/client.dart`
- Test: `desktop/test/super_tab_reading_client_test.dart`

**Interfaces:**
- Produces: `SuperTabKeptFiles get keptFiles`; `void adoptFiles(SuperTabKeptFiles kept)`.

- [ ] **Step 1: Write the failing test and commit it.**
- [ ] **Step 2: Run it to verify it fails.**
- [ ] **Step 3: Implement it and commit.**
