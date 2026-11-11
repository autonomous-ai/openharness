# Desktop and Web Swarm Composer Like the Phone's Implementation Plan

> **For agentic workers:** The assigned Engineer implements this plan task by task in this session, test first, by the project's instructions. No subagents: the two composers share their new buttons.

**Goal:** The Desktop and web Swarm composer, in the main chat and in a thread, is the phone's: one rounded box with the text on top and one row under it holding + (attach), @ Tag, the New session chip, a mic slot and send; Also send is a small checkbox under the box, in threads only.

**Architecture:** The main chat's `_composerLayout` (`view.dart`) gives every width the two-row layout a phone already has (field on top, actions below), keeping only the squeezed one-row layout for a phone with too little height. `SuperTabReplyBox` (`reply_box.dart`) takes the same row. The row's new buttons live in `composer_actions.dart`: an @ Tag button that types `@` at the caret, so the existing tag list opens, and a mic that starts a take on a `SuperTabVoiceRecorder` (`voice_recorder.dart`). No recorder is given yet, so no mic shows (River, 11-04: recording, the `record` package and the macOS microphone entitlement are a follow-up task). The thread's Also send leaves the send row for its own line under the box, always, so its width is no longer measured.

**Tech Stack:** Flutter (Desktop, web build of the same code), flutter_test widget tests with the `ConversationServer` fixture (memory store, fake sign-in).

**Spec:** Swarm task #2662, conversation 6a9ff95c03fa38a4851f6cc7 (Huy and Scholes, 11-04; River's split, 11-04).

## Global Constraints

- Harness Design Language: tokens only (`grid.AppDesktop`, `DesktopChrome`, `AppIcons`), no hard-coded colours or sizes, nothing explanatory added.
- Icons only through `AppIcons`, weight 400 (`audit-icons.py`, `icon_catalog_render_test`, `lucide_weight_test`).
- Enter sends, Shift+Enter adds a line; every button is reachable with Tab, in the row's order.
- No formatting toolbar: Desktop has none today, and none is added.
- Kept from Scholes, 11-03: send stays at the bottom-right of the box however many lines are typed (#2763); New session and Also send are square checkboxes with their full wording (thread composer).
- The mic never shows without a recorder: no button that does nothing.
- `NewHarnessAttachButton` keeps its paperclip in the New harness form; only the Swarm composers pass +.
- Before and after screenshots, light and dark, offscreen on a Team account.
- PR body first line: "Requested by phamngochuy.1989@gmail.com through Harness."

## Review Focus

- A five-line message: the row stays under the last line, send at the bottom-right, nothing overlapping the text.
- The Swarm Buddy chat with New session on: the project picker fits in the row beside New session at the narrowest Desktop width.
- @ Tag after a word ("hi|") types " @", at the start "@"; the tag list opens and Enter picks from it, not send.
- A thread with its own session (no Also send) and one that starts a session: the line under the box keeps its place, so the box does not move as New session is toggled.
- Phone-width web keeps fitting 320x568 with the keyboard up (the squeezed row below 320 px of room).

---

### Task 1: The main chat composer's row

**Files:**
- Create: `desktop/lib/super_tabs/composer_actions.dart`, `desktop/lib/super_tabs/voice_recorder.dart`
- Modify: `desktop/lib/super_tabs/view.dart` (`_composerLayout`, the composer row, `SuperTabView.voiceRecorder`), `desktop/lib/super_tabs/composer_tags.dart` (`superTabTagPrompt`), `desktop/lib/widgets/new_harness_attachments.dart` (`icon`), `desktop/lib/shared/theme/app_icons.dart` (`atSign`, `mic`)
- Test: `desktop/test/super_tab_composer_row_test.dart`; update `super_tab_composer_chips_bottom_test.dart`

**Interfaces:**
- Produces: `abstract interface class SuperTabVoiceRecorder { Future<void> start({required String conversationId, String? root}); }`; `TextEditingValue superTabTagPrompt(TextEditingValue value)`; `SuperTabComposerTagButton({Key? key, required VoidCallback? onPressed})`; `SuperTabComposerMic({Key? key, required VoidCallback? onPressed})`; `SuperTabView(voiceRecorder: SuperTabVoiceRecorder?)`.

- [ ] **Step 1: Write the failing tests** at 1280x720 in the reader's Buddy chat: the field is above `super-message-composer-actions`; the row reads +, @, New session left to right, then send at its right end, all under the field; no `super-composer-mic` without a recorder; with a fake recorder the mic sits left of send and a tap starts one take for the chat; @ Tag after "hi" makes "hi @" and opens `super-composer-completions`; Tab from the field reaches +, @, New session, mic, send in that order; Enter sends and Shift+Enter breaks the line from the new layout.
- [ ] **Step 2: Run them and watch them fail** — `flutter test test/super_tab_composer_row_test.dart` (the row and its buttons are missing).
- [ ] **Step 3: Commit the failing tests**
- [ ] **Step 4: Implement** the row, the buttons and the seam; update `super_tab_composer_chips_bottom_test.dart` to the new layout (send at the bottom-right, under the last line).
- [ ] **Step 5: Run** `super_tab_composer_row_test`, `super_tab_composer_chips_bottom_test`, `super_tab_composer_layout_test`, `super_tab_phone_composer_test`, `super_tab_phone_targets_test`, `super_tab_composer_newline_test`, `super_tab_completions_test` and the tests that find `new-harness-attach`.
- [ ] **Step 6: Commit**

### Task 2: The thread composer's row and Also send under the box

**Files:**
- Modify: `desktop/lib/super_tabs/reply_box.dart`, `desktop/lib/super_tabs/thread_panel.dart`, `desktop/lib/super_tabs/view.dart` (pass the recorder)
- Test: `desktop/test/super_tab_composer_row_test.dart` (thread group); update `super_tab_reply_box_test.dart`

- [ ] **Step 1: Write the failing tests**: the thread's row reads +, @, New session, then send at its right end; Also send (`super-thread-also-send`) is always on its own line under the box (`super-thread-also-line`), reading "Also send to #openharness" in the project chat and "Also send to the main chat" elsewhere; the main chat has no Also send; with a fake recorder the thread's mic starts a take for that thread's root.
- [ ] **Step 2: Run them and watch them fail**
- [ ] **Step 3: Commit the failing tests**
- [ ] **Step 4: Implement**; remove `_alsoBelow` and its measuring; update `super_tab_reply_box_test.dart`.
- [ ] **Step 5: Run** the thread tests (`super_tab_reply_box_test`, `super_tab_thread_composer_test`, `super_tab_thread_tags_test`, `super_tab_threads_test`, `super_tab_buddy_sessions_test`) and the guards: `python3 scripts/check-ui-style.py --only desktop/lib/super_tabs`, `python3 desktop/scripts/audit-icons.py`, `icon_catalog_render_test`, `lucide_weight_test`, `laid_out_list_test`.
- [ ] **Step 6: Commit**, then the before (main) and after screenshots, light and dark, from `super_tab_composer_row_shots_test.dart`.
