# Thread tags in the sidebar and replies line: Implementation Plan

> **For agentic workers:** Follow the Harness Engineer workflow in the project's instructions. This plan is implemented by the assigned Engineer; it does not use subagent-driven development.

**Goal:** Make an unread tag inside a project-chat thread visible in Activity and the relevant sidebar count, show `@ you` on that thread's reply line, and explain sidebar badge counts on hover.

**Architecture:** Desktop already loads unread tags and decisions centrally in `SuperTabAttention`; the sidebar currently calls `mentionsIn`, which excludes thread-scoped tags, while Activity has the unread/read rules for thread mentions. Expose per-conversation waiting tag and decision counts using the same read, muted and visibility rules as Activity; use that count for the sidebar badge and tooltip, and a per-thread unread-tag query for the replies line. Build the read/clear behavior on Diego's #2721 after it lands on main.

**Tech Stack:** Dart, Flutter, existing Super Tab attention and widget tests.

**Spec:** Task #2358 conversation `21754bfc76109e10c03d72db`; existing `desktop/lib/super_tabs/activity.dart` and `attention.dart` attention rules; #2721 read/answer clearing behavior.

**Agreed interaction sketch:**

```text
Project chat                                      [2]
  Proposal                                  2 replies · @ you

Hover badge: 1 tag, 1 decision waiting for you
```

## Global Constraints

- Do not change how tags or decisions are created, and do not add push notifications.
- Read the project's existing attention and Activity rules; the sidebar and Activity must agree on which tags are still waiting.
- A tag clears when its thread is opened or the reader replies, following #2721; an answered decision no longer counts.
- Use the existing Desktop memory store and fake sign-in in tests. Never run a test that signs the Mac out of the real CLI.
- Keep the implementation in Desktop attention, sidebar and message-row presentation unless the root-cause test proves a backend change is needed.
- Before Ready, add a failing test for each named behavior, record red/green evidence in a PR comment, and capture widget-test screenshots. The Super Tab integration suite is supplied by PR CI; do not run the full suite locally.
- Pull request body starts with `Requested by scholes@autonomous.ai through Harness.`

## Review Focus

- **Thread scope:** An unread tag in a reply is counted for the correct conversation and thread; tags in a different thread do not leak into the badge.
- **Read and answer clearing:** Opening the thread or replying removes the tag from the reply marker, sidebar badge and Activity count; a stale mention does not remain visible.
- **Activity parity:** Thread tags represented by Activity's New replies are not double-counted as Needs you; tags shown as Needs you match the sidebar's tag count.
- **Mixed counts:** Tags and open decisions produce the correct combined badge number and distinct tooltip labels, including singular and plural forms.
- **Project scope:** A collapsed project row and its workgroup rows count only the tags and decisions in the conversations each row represents; muted or inaccessible conversations do not add counts.

---

### Task 1: Count unread thread tags with the same rules as Activity

**Files:**
- Modify: `desktop/lib/super_tabs/attention.dart`
- Test: `desktop/test/super_tab_attention_test.dart`
- Test: `desktop/test/super_tab_activity_test.dart`

**Interfaces:**
- Consumes: `SuperTabMentions.waiting`, `SuperTabDecisions.open`, `SuperTabController.readMark`, `threadReadMark`, and the thread list Activity uses to distinguish New replies from Needs you.
- Produces: `tagsIn(String conversationId)`, `decisionsIn(String conversationId)`, and `mentionsIn(String conversationId)` whose total matches the tags and decisions Activity shows as Needs you for that conversation; `hasUnreadTagInThread(String conversationId, String threadId)` for the reply-line marker.

- [x] **Step 1: Add a failing attention test** named `counts_an_unread_tag_in_a_project_chat_thread_as_needs_you`. Use a waiting mention with a thread id and sequence after the thread read mark, on a thread not currently listed as New replies; expect one tag in the conversation and one Needs you item, while a different conversation remains at zero.
- [x] **Step 2: Run the focused test and confirm it fails** because `mentionsIn` currently filters for `threadId == null`.
- [x] **Step 3: Commit the failing test** as `test(desktop): cover unread thread tags in sidebar attention`.
- [x] **Step 4: Implement per-conversation tag and decision counts** in `attention.dart`, sharing the Activity unread and New replies exclusion rules so a thread mention is counted once.
- [x] **Step 5: Verify read clearing** with a test that advancing the thread read mark removes the tag from the conversation count and Activity; after #2721 is merged, also verify its reply action clears the mention.
- [x] **Step 6: Run the focused attention and Activity tests and commit the passing implementation** as `fix(desktop): count unread thread tags in sidebar attention`.

### Task 2: Mark a tagged thread on its replies line

**Files:**
- Modify: `desktop/lib/super_tabs/view.dart` to pass thread mention state from attention.
- Modify: `desktop/lib/super_tabs/message_row.dart` to render the marker.
- Test: `desktop/test/super_tab_thread_tags_test.dart` or the existing message-row widget test that owns thread lines.

**Interfaces:**
- Consumes: `SuperTabAttention.hasUnreadTagInThread(conversationId, threadId)` from Task 1.
- Produces: a `tagged` state on `SuperTabThreadLine`; when true, the line shows `@ you` beside its reply count and includes it in the accessible label.

- [x] **Step 1: Add a failing widget test** named `shows_you_on_a_thread_line_with_an_unread_tag` using a real thread line and unread mention; also prove the marker is absent after its read mark advances.
- [x] **Step 2: Run the focused widget test and confirm the marker is missing.**
- [x] **Step 3: Commit the failing test** as `test(desktop): specify tagged thread reply line`.
- [x] **Step 4: Pass the unread-tag state from `view.dart` to `SuperTabThreadLine` and render `@ you` in `message_row.dart`.**
- [x] **Step 5: Run the focused thread-tag widget test and commit the implementation** as `feat(desktop): mark tagged thread replies in the chat`.

### Task 3: Explain badge counts and verify the collapsed project view

**Files:**
- Modify: `desktop/lib/super_tabs/project_sidebar.dart`
- Test: `desktop/test/super_tab_sidebar_test.dart` and `desktop/test/super_tab_sidebar_shots_test.dart`.

**Interfaces:**
- Consumes: Task 1's per-conversation tag and decision counts.
- Produces: A tooltip for each sidebar attention badge that names its tag and decision counts, for example `1 tag, 1 decision waiting for you`; the badge number remains the sum of those waiting rows.

- [x] **Step 1: Add failing widget tests** for a collapsed project badge that includes a thread tag, the exact mixed tag/decision tooltip, singular/plural labels, and zero after all relevant rows clear.
- [x] **Step 2: Run the focused sidebar tests and confirm the thread-tag count and tooltip are missing.**
- [x] **Step 3: Commit the failing tests** as `test(desktop): specify sidebar attention badge details`.
- [x] **Step 4: Add the tooltip to each attention count badge and keep the row count equal to its visible Activity Needs you tags and decisions.**
- [x] **Step 5: Capture the updated screenshot, run the focused sidebar widget tests, and commit** as `feat(desktop): explain project attention badge counts`.

### Task 4: Validate and prepare review

**Files:**
- Update: this PR's validation comment and screenshots; no other product files unless a focused check fails.

- [x] Wait for #2721 to merge; merge the new `origin/main` into this branch before implementing clearing behavior.
- [x] Run affected Desktop tests and analyzer checks on macOS; use PR CI for the four Super Tab integration shards and other required Linux component checks (PR CI remains pending until Ready).
- [ ] Record red/green evidence for the attention count, read/reply clearing, reply-line marker, and tooltip/count parity tests in a PR comment.
- [ ] Attach screenshots from the widget tests, keep the head stable, and request the required review and Desktop test steps.
