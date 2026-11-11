# A project's red number counts only its chat's tags — Implementation Plan

> This plan follows the project's Engineer workflow (test first, one pull request, one independent review); the
> Engineer implements it task by task.

**Goal:** A project row's red number counts only the reader's unread tags in that project's main chat, and opening
the chat clears it, on Desktop, the phone and the web (task #2927, anh Dee, 2026-11-04).

**Architecture:** Desktop's project row (`project_sidebar.dart` `_row`) today adds `mentionsIn(lead)` (chat tags,
tags in the chat's threads, decisions asked there) and `_ProjectReading.needsYou` (tasks waiting on the reader, task
tags included). It will read a new `SuperTabAttention.chatTagsIn(id)`: main-stream tags only, past the chat's read
mark, nothing when muted or access is gone. The phone and the web (one Flutter app, `mobile/`) already count only
main-stream tags of the project chat but add decisions asked there while the chat is unread; `swarmProjectNews` will
count tags only. Activity's number already counts every unread tag and every decision (#2887), and the menu bar lists
the same decisions and unread tags (`status_menu.dart`), so they stay as they are.

**Tech Stack:** Flutter / Dart (Desktop `desktop/`, phone and web `mobile/`), flutter_test widget tests with the
in-memory Super Tab fixture.

**Spec:** the task's brief (#2927): "A project row's red number counts only tags of the reader in that project's main
chat, and opening the chat clears it (Slack's channel badge). Tags in tasks and threads, decisions and tasks waiting
on the reader show only in Activity and its own count."

## Global Constraints

- Desktop tests use a memory store and a fake sign-in; never sign the Mac out of the real CLI.
- Swarm code stays out of cli/src/core. No backend change.
- The row's bold stays its own chat's (task #2638); the unread filter keeps a project with any unread work or tag
  (`_hasUnread`) as before.
- Buddy chat rows and task cards keep their counts; only project rows change.

## Review Focus

1. A tag in the project chat's thread (a reply that lives only in its thread): no number on the row; it stays in
   Activity and on the thread.
2. A decision asked in the project chat: no number on the row, even while the chat is unread; Activity counts it.
3. A muted project chat: no number, as before.
4. A tag from a server that does not say where it is (no sequence): it still counts on the row until answered, as
   `tagsIn` does today.
5. The unread filter still keeps a project whose only news is a task tag or a decision.

---

### Task 1: Desktop project row counts only main-chat tags

**Files:**
- Modify: `desktop/lib/super_tabs/attention.dart` (add `chatTagsIn`)
- Modify: `desktop/lib/super_tabs/project_sidebar.dart` (`_row`, `_ProjectReading.unread`, drop `needsYou`)
- Modify: `desktop/lib/super_tabs/task_groups.dart` (doc of `superTabTasksNeedingYouIn`)
- Test: `desktop/test/super_tab_attention_test.dart`, `desktop/test/super_tab_task_groups_test.dart`

**Interfaces:**
- Produces: `int SuperTabAttention.chatTagsIn(String conversationId)`: unread tags of the reader in the
  conversation's main stream (`threadId == null`), past `readMark`; 0 when muted or access is revoked.

- [ ] Step 1: rewrite the project-row tests to the new rule: a tag in the project chat shows 1 and opening the chat
  clears it; a task tag, a tag in a project-chat thread and a decision in the project chat show no number on the row
  while Activity's count holds them; the tooltip says "1 tag"; a task waiting on the reader adds nothing.
- [ ] Step 2: run them; they fail (the row shows the old sums).
- [ ] Step 3: add `chatTagsIn`; the row's number and tooltip read it; the row's bold reads it; remove
  `_ProjectReading.needsYou`.
- [ ] Step 4: run `flutter test` on the sidebar, attention, task groups, quiet polish and attention shots tests;
  they pass.
- [ ] Step 5: commit.

### Task 2: Phone and web project number counts only main-chat tags

**Files:**
- Modify: `mobile/lib/swarm/swarm_unread.dart` (`swarmProjectNews`)
- Test: `mobile/test/swarm/swarm_unread_test.dart`

**Interfaces:**
- Consumes: nothing new. `SwarmProjectNews.tags` becomes main-stream tags of the project chat only.

- [ ] Step 1: add a test: a decision asked in the project chat while it is unread leaves the project's number at 0
  and the project bold; the project chat's own row and Activity still count it.
- [ ] Step 2: run it; it fails (the number is 1).
- [ ] Step 3: `swarmProjectNews` counts the project chat's tags without decisions.
- [ ] Step 4: run `flutter test test/swarm/swarm_unread_test.dart test/swarm/swarm_chat_notify_test.dart`; pass.
- [ ] Step 5: commit.

### Task 3: Evidence

- [ ] Light and dark screenshots of the Desktop left bar before and after opening a project chat (offscreen widget
  shots with the memory store), and of the phone's project list; red/green test output in a PR comment.
