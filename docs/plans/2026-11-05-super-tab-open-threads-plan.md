# Super Tab Open Threads Implementation Plan

> **For agentic workers:** This plan is implemented task by task in this session, test first. Each task's test and implementation are committed separately.

**Goal:** Keep each conversation's open thread through project switches, Back/Forward navigation, and Desktop restarts, while ignoring threads the user cannot read.

**Architecture:** Keep open thread roots in the controller's local view state, keyed by conversation id, and expose the selected conversation's entry through the existing open-thread behavior. Serialize that map with the existing Desktop saved view and validate restored entries against data the client can read. The existing singular saved entry remains readable for older locally saved views.

**Tech Stack:** Flutter, Dart, `SuperTabController`, `SuperTabView`, existing in-memory Super Tab test server.

**Spec:** Harness task #3311 in conversation `f2000ab7ea79ed44c9d40db6`.

## Design

1. Growth: one root per conversation in the existing per-tab local view; removing a conversation prunes its entry, and closing its thread deletes its entry. The view keeps the newest 500 conversation roots, in step with its thread-read marks; the saved-view byte cap is a second bound.
2. Concurrency: the controller owns the map and updates it synchronously on select, open, and close; the existing serialized local saved-view writer persists snapshots.
3. Read cost: no added network reads or polling. Existing thread reads load only the selected, visible thread; the existing local view read supplies the saved map.
4. Scale: storage grows by one conversation/root pair per open thread; the saved-view byte cap is the first limit and already evicts older chat state.
5. Compatibility: newly written views add an optional map; older clients ignore it. New clients read the old singular entry when the new map is absent.
6. Migration + rollback: no database migration; rollback uses the old singular entry retained in each new saved view for the currently selected open thread.
7. Audience: local account-scoped Desktop state only; no server endpoint or cross-device exposure changes.
8. Identity: the existing account-scoped view key and owner guard remain unchanged.
9. Failure: malformed, removed, or unreadable conversations/threads restore closed; storage failures retain the existing best-effort saved-view behavior.
10. Platforms: Desktop macOS, Linux, and Windows. No web or phone behavior changes.

## Global Constraints

- Desktop only; no server change, no syncing across devices, and no visible new UI.
- Closing a thread still closes it for that chat.
- A thread that no longer exists or cannot be read opens nothing.
- Desktop tests and `python3 scripts/check-ui-style.py --only desktop` pass before Ready.
- Do not run a test that signs the Mac out of the real CLI.

## Review Focus

- Switching among chats must keep each conversation's thread independent; test opening two threads and returning to the first.
- Back/Forward must restore each recorded chat/root, including a place without a thread; test stepping both directions.
- Restart restoration must keep the correct conversation/root and mark it read only after its pane is shown; test saved-state round trip and read marking.
- A deleted or unreadable thread must not leave a blank/error thread pane; test absent conversation and missing root restoration.
- Closing a thread must remove only the selected conversation's saved root; test closing one while another remains open.

## Tasks

### Task 1: Persist open threads per conversation

**Files:**
- Modify: `desktop/lib/super_tabs/controller.dart`
- Test: `desktop/test/super_tab_thread_composer_test.dart`

**Interfaces:**
- Consumes: existing `selectedId`, `openedThread`, `_localState`, and constructor `initial` saved state.
- Produces: per-conversation open thread state serialized as `openThreads: {conversationId: root}` and restored into the controller; existing `openedThread`, `openThread`, and `closeThread` continue to represent the selected conversation.

- [x] **Step 1: Write failing tests** for two conversations retaining separate roots across selection, local-state restart round trip, closing only the selected entry, legacy `openThread` restoration, missing/unreadable roots restoring closed, and the 500-entry bound.
- [x] **Step 2: Run focused tests** and confirm the switching, missing-root, and unreadable-root assertions fail before implementation.
- [x] **Step 3: Implement the per-conversation map** in `controller.dart`; save/restore it with the existing local state, switch the active open entry with `_moveView`, and remove entries when closed or when the conversation is removed.
- [x] **Step 4: Validate restored roots** using the selected conversation's readable thread data; keep the pane closed when the root is absent or no longer readable.
- [x] **Step 5: Rerun the focused test file** and confirm all 54 tests pass.
- [x] **Step 6: Commit** the failing tests first, then the passing implementation.

### Task 2: Cover project switches and Back/Forward places

**Files:**
- Modify: `desktop/lib/super_tabs/view.dart` only if the controller contract requires a view adjustment.
- Test: `desktop/test/super_tab_pages_test.dart` or `desktop/test/super_tab_sidebar_test.dart` (use the existing Super Tab view fixture).

**Interfaces:**
- Consumes: Task 1 selected-conversation thread restoration and existing `SuperTabPlaces` records.
- Produces: widget-level evidence that project/sidebar selection and Back/Forward display the expected root and read it only while shown.

- [x] **Step 1: Add widget tests** that open a thread in one conversation, switch to another, return, and step Back/Forward between a thread and a no-thread place.
- [x] **Step 2: Run the widget tests**; both pass using the controller's per-conversation state, so no additional view wiring is needed.
- [x] **Step 3: Commit** the tests and implementation in their task commits.
