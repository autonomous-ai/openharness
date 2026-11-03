# A Hidden Thread Pane Marks Nothing Read Implementation Plan

> **How this is worked:** by the project's instructions, task by task, each failing test committed before its code.

**Goal:** A thread left open beside the chat marks its replies read only while its pane is on screen; hidden, it marks nothing until it is shown again, then marks through the newest reply.

**Architecture:** `SuperTabController._seeThread` is already the single gate for the open thread's read mark, and it returns early while `_threadUnshown` is true. Today only a thread restored open sets that flag; nothing sets it when the pane goes off screen, so every poll that brings a reply (`_keepThreads` → `_seeThread`) sends the thread's read mark while the app is in the background or another Swarm is in front. The controller gains `threadPaneHidden()`, which sets the flag. The view tells it by the rule the main chat already reads by (`_viewIsVisible`): hidden at once whenever that turns false, and `threadPaneShown()` after the frame that shows the pane again.

**Tech Stack:** Flutter 3.47.2 (Dart), flutter_test.

**Spec:** Task #2298 (Diego): "Desktop: a thread left open beside the chat marks replies read only while it is on screen".

## Global Constraints

- The PR body starts with: `Requested by diego@autonomous.ai through Harness.`
- Desktop tests use a memory store and a fake sign-in; never run a test that signs this Mac out of the real CLI.
- Swarm code stays out of `cli/src/core`. Temp files only in `mktemp -d` folders.
- Owned paths: `desktop/lib/super_tabs/controller.dart`, `desktop/lib/super_tabs/view.dart`, `desktop/test`.
- `_seeThread` stays the single gate for the thread read mark.

## Review Focus

1. A poll landing while the pane is hidden: the flag must be set at the moment the view goes away, not on its next frame, since the poll runs in the controller with no frame in between.
2. A Swarm switched away: the view is disposed (the workspace builds only the active Swarm), while the controller keeps reading every 15 s. Dispose must hide.
3. The app sent to the background with the window unchanged: lifecycle and `app.foreground` change without a build of the view.
4. Shown again with no new message: the pane must still be marked through its newest reply, once.
5. A thread opened by hand stays read as before (`openThread` clears the flag); a thread whose conversation is not the selected one has no pane and counts as hidden.

---

### Task 1: The controller marks nothing read for a hidden pane

**Files:**
- Modify: `desktop/lib/super_tabs/controller.dart:867-877`
- Test: `desktop/test/super_tab_thread_composer_test.dart` (the group 'a thread that opened again')

**Interfaces:**
- Produces: `void threadPaneHidden()` on `SuperTabController`: the open thread's pane is off screen; nothing counts as read until `threadPaneShown()`.

- [ ] **Step 1: Write the failing test** 'a hidden thread pane marks no new reply read until it is shown again': open `message-1` by hand, `threadPaneShown()`, clear `server.threadMarkPosts`, `threadPaneHidden()`, append a reply from another member in the thread, `refresh()` → `server.threadMarkPosts` is empty and `threadUnread` is true; `threadPaneShown()` → exactly one mark, at the reply's sequence, and `threadUnread` is false.
- [ ] **Step 2: Run it and watch it fail** (`threadPaneHidden` is not defined).
- [ ] **Step 3: Implement `threadPaneHidden()`**, setting `_threadUnshown`; update the field's doc to say it covers a pane hidden since, not only one restored.
- [ ] **Step 4: Run the test and the thread composer suite**: all pass.
- [ ] **Step 5: Commit.**

### Task 2: The view says when the pane leaves the screen

**Files:**
- Modify: `desktop/lib/super_tabs/view.dart` (`initState`, `didChangeAppLifecycleState`, `didUpdateWidget`, `dispose`, `_readVisibleTailAfterFrame`, `build`)
- Test: `desktop/test/super_tab_thread_composer_test.dart`

**Interfaces:**
- Consumes: `threadPaneHidden()`, `threadPaneShown()`.

- [ ] **Step 1: Write the failing widget tests**, each mounting the real view with the thread open and shown (one mark), clearing the marks, hiding, then appending a reply and refreshing:
  - 'a pane sent to the background marks no new reply, and marks once it is back': lifecycle → `inactive`; no mark; `resumed` → one mark.
  - 'a pane put offstage marks no new reply, and marks once it is shown': remount with `hidden: true`; no mark; `hidden: false` → one mark.
  - 'a view let go marks no new reply': unmount the view; no mark.
  - 'an app no longer in front marks no new reply': with an `AppNotifier`, `foreground.value = false`; no mark; `true` → one mark.
- [ ] **Step 2: Run them and watch them fail** (a mark is sent while hidden).
- [ ] **Step 3: Implement `_syncThreadPane()`** in the view: with a thread open, when the pane is not on screen (`openedThread.conversationId != selectedId` or `!_viewIsVisible`) call `threadPaneHidden()` at once; otherwise call `threadPaneShown()` after the frame, if still visible. Call it from `build`, from `didChangeAppLifecycleState` (every state), from a listener on `widget.app?.foreground` (moved with the app in `didUpdateWidget`) and from `_readVisibleTailAfterFrame` in place of its own `threadPaneShown` call. `dispose` and a controller replaced in `didUpdateWidget` call `threadPaneHidden()` on the controller being left.
- [ ] **Step 4: Run the new tests, the thread composer suite and the Super Tab view suites**: all pass.
- [ ] **Step 5: Commit.**
