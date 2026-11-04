# Desktop and Web Composer Mic Implementation Plan

> **For agentic workers:** The assigned Engineer implements this plan task by task in this session, test first, by the project's instructions (plan first in a draft PR; each failing test committed before its code; one independent review step on the pull request). No subagents: the tasks share the recorder seam.

**Goal:** On macOS and the web, the Swarm composer's mic (main chat and thread) records a voice message and sends it as audio through #2887's path: people hear it, agents read its words. Linux and Windows show no mic. A refused microphone says so in one short line, with a way to the system setting.

**Architecture:** `voice_recorder.dart` becomes the phone's recorder seam (`allowed`, `start`, `stop`, `cancel`, `dispose`, `level`), with `SuperTabMicRecorder` over the `record` package streaming 16 kHz mono PCM16, wrapped in a WAV header (`voice_wav.dart`, the phone's `wavFromPcm16` and `pcm16Level`). `voice_take.dart` holds one take, as the phone's `SwarmVoice` does (off, starting, recording, held, sending; at most 10:00, then held with Send ready). `voice_send.dart` sends a take as the phone's `sendVoice` does: `uploadFile` of `Voice message.wav`, `POST …/attachments/:id/voice?lang=` (retrying `VOICE_TRANSCRIBING`), then `message.send` with empty text, the file, and the thread's root as `replyTo`. While a take is under way, `voice_row.dart` takes the place of the composer's row: `[X]  ● 0:14  ıllıllıııllıı.ılı  [↑]`. The view gets a recorder factory only where recording works (`superTabVoiceRecorder()`: macOS and the web), so Linux and Windows draw no mic (the #2918 rule: no mic without a recorder).

**Tech Stack:** Flutter (Desktop, web build of the same code), `record` ^7.1.1 (as the phone), flutter_test widget tests with the `ConversationServer` fixture (memory store, fake sign-in) and a fake recorder.

**Spec:** Swarm task #2665, conversation 359ddf4db0057d3048910c4d (River, 11-04; Huy and Scholes' composer #2918, Dee's voice messages #2887).

## Global Constraints

- The take is never sent by itself and nothing goes into the text box. What is typed stays in the box.
- A take stops at exactly 10:00 and is held with Send ready. Changing chat or thread stops and holds the take for its own chat; its row shows only in that chat. A mic tap in another chat discards a held take first.
- X discards the take; Send stops it (when recording) and posts it; a failed send keeps the take with its notice.
- Microphone refused: one line under the box. macOS: "Harness can't use the microphone · Open System Settings", the link opening `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone`. Web: "This site can't use the microphone · allow it in your browser's site settings" (no page can open a browser's settings).
- The language the words are heard in is the computer's own language (`PlatformDispatcher.locale.languageCode`); the server falls back to English for one it does not serve. No picker (beyond the brief).
- macOS: `com.apple.security.device.audio-input` in both entitlements (the app runs with the hardened runtime, which needs it for the microphone), and `NSMicrophoneUsageDescription` in Info.plist.
- Harness Design Language: tokens only (`grid.AppDesktop`, `DesktopChrome`, `AppIcons`), icons through `AppIcons` at weight 400, no hard-coded colours or sizes, nothing explanatory added.
- Every button is reachable with Tab, X and Send in the row's order.
- Never run a test that signs the Mac out of the real CLI; Desktop tests use a memory store and a fake sign-in.
- A real microphone can't be tested on a Team account: the PR says so; the Desktop release candidate check covers it.
- PR body first line: "Requested by phamngochuy.1989@gmail.com through Harness."

## Design

- **Growth:** a take lives in memory (1.9 MB a minute, 19 MB at 10:00) until it is sent or discarded; the uploaded file is #2887's attachment row, deleted by the unsent-file sweep or with its message.
- **Concurrency:** one take per composer; the recorder serializes its operations as the phone's does. The voice read's claim is the server's (#2887).
- **Read cost:** one upload, one voice read, one send per take; nothing new is polled.
- **Scale:** N/A because it is one person's clip at a time; the server's voice quota and memory budget (#2887) bound it.
- **Compatibility:** an old server answers 404 to the voice read: the take is kept and the row says "Voice messages need a newer server". Old clients see #2887's fallback (the words as text, a file chip).
- **Migration + rollback:** N/A because nothing is stored; rolling back removes the mic.
- **Audience:** the server's voice route (#2887) allows only the uploader, in a conversation it may post in.
- **Identity:** the signed-in person's own upload and voice quota, as on the phone.
- **Failure:** every failure is a line beside the take, which is kept: refused mic, a mic that could not start, nothing recorded, upload or read failed, old server, over the daily voice limit (sent without words, said).
- **Platforms:** macOS (AVFoundation through `record_macos`) and the web (`record_web`, getUserMedia, HTTPS only). Linux and Windows get no recorder and show no mic.

## Review Focus

1. A take recording while the person switches chat: it is held for its own chat, never sent into the newly opened one.
2. Send pressed twice, or a send whose answer was lost: one message (the file is used once; the second send is refused by the server, as today).
3. The microphone refused on macOS: the line names the setting and opens it; the mic stays usable after access is given (the next tap asks again).
4. The entitlement and usage text pass the Desktop release's signing and notarization (prepare run linked in the PR).
5. Linux and Windows: no mic, and the build still compiles with the `record` package.

---

### Task 1: The recorder seam and the take

**Files:**
- Modify: `desktop/lib/super_tabs/voice_recorder.dart` (the seam, `SuperTabMicRecorder`, `superTabVoiceRecorder()`)
- Create: `desktop/lib/super_tabs/voice_wav.dart`, `desktop/lib/super_tabs/voice_take.dart`
- Modify: `desktop/pubspec.yaml` (`record: ^7.1.1`), `desktop/pubspec.lock`
- Test: `desktop/test/super_tab_voice_take_test.dart`

**Interfaces:**
- Produces: `typedef SuperTabVoiceClip = ({Uint8List wav, Duration length})`; `abstract interface class SuperTabVoiceRecorder { Future<bool> allowed(); Future<void> start(); Future<SuperTabVoiceClip?> stop(); Future<void> cancel(); Future<void> dispose(); ValueListenable<double> get level; }`; `SuperTabVoiceRecorder Function()? superTabVoiceRecorder({bool web, TargetPlatform platform})`; `class SuperTabVoiceTake extends ChangeNotifier` with `state`, `conversationId`, `root`, `notice`, `denied`, `length`, `level`, `start({conversationId, root})`, `hold()`, `discard()`, `send()`; `SuperTabVoiceTake.maxTake = Duration(minutes: 10)`.

- [ ] **Step 1: Write the failing tests**: with a fake recorder, start records (state recording, for its chat and root); send stops then posts the clip once and returns to off; discard cancels the recorder and posts nothing; a failed post keeps the take held with its notice; refused mic sets `denied` and the notice, posts nothing; at 10:00 (fake clock) the take is held with Send ready, nothing posted; `hold()` while recording keeps the take; `superTabVoiceRecorder` gives a recorder for macOS and the web, none for Linux and Windows; `wavFromPcm16` writes a 44-byte header with the rate and length.
- [ ] **Step 2: Run** `flutter test test/super_tab_voice_take_test.dart` and watch it fail (missing files).
- [ ] **Step 3: Commit the failing tests.**
- [ ] **Step 4: Implement**; `flutter pub get`.
- [ ] **Step 5: Run** the test file; expect PASS. Commit.

### Task 2: Sending a take through #2887's path

**Files:**
- Create: `desktop/lib/super_tabs/voice_send.dart` (`extension SuperTabVoiceSend on SuperTabController { Future<SuperTabVoicePosted> sendVoice(...) }`)
- Test: `desktop/test/super_tab_voice_send_test.dart`

**Interfaces:**
- Consumes: `SuperTabController.uploadFile`, `request`, `command`, `oneBuddy`.
- Produces: `typedef SuperTabVoicePosted = ({bool sent, String? notice})`; `Future<SuperTabVoicePosted> sendVoice({required String conversationId, String? root, required Uint8List wav, required String lang})`.

- [ ] **Step 1: Write the failing tests** against the `ConversationServer` fixture: a take uploads `Voice message.wav`, reads it at `…/voice?lang=vi`, and sends `message.send` with text '', the file and `replyTo` = the thread's root; `VOICE_TRANSCRIBING` is asked again; a 404 keeps the take with "Voice messages need a newer server"; over the limit sends and says "Sent without words: today's voice limit is used".
- [ ] **Step 2: Run and watch them fail. Step 3: Commit.**
- [ ] **Step 4: Implement. Step 5: Run; PASS. Commit.**

### Task 3: The composer's mic, the recording row and the refused line

**Files:**
- Create: `desktop/lib/super_tabs/voice_row.dart` (`SuperTabVoiceRow`, `SuperTabVoiceRefused`)
- Modify: `desktop/lib/super_tabs/view.dart` (`voiceRecorder` becomes a factory; one `SuperTabVoiceTake` for the main composer; `_composerLayout` takes the row), `desktop/lib/super_tabs/reply_box.dart` (`voiceRow`, `voiceNotice`), `desktop/lib/super_tabs/thread_panel.dart` (its own take), `desktop/lib/super_tabs/composer_actions.dart`, `desktop/lib/super_tabs/workspace.dart` (passes `superTabVoiceRecorder()`), `desktop/lib/shared/theme/app_icons.dart` if a new icon is needed
- Test: `desktop/test/super_tab_composer_mic_test.dart`; update `super_tab_composer_row_test.dart`

- [ ] **Step 1: Write the failing tests** at 1280x720 with a fake recorder: tapping the mic shows `super-voice-row` in place of the row (X, red dot, time, wave, send) and leaves the typed text; X returns the row and posts nothing; Send posts one voice message to the chat (and to the thread's root from the thread's mic); switching chat holds the take and the other chat shows its normal row; a refused mic shows `super-voice-refused` with "Open System Settings" on macOS; closing a thread holds its take.
- [ ] **Step 2: Run and watch them fail. Step 3: Commit.**
- [ ] **Step 4: Implement. Step 5: Run** the new file, `super_tab_composer_row_test`, `super_tab_reply_box_test`, `super_tab_composer_layout_test`, `super_tab_phone_composer_test`, `super_tab_voice_message_test`, and the guards (`python3 scripts/check-ui-style.py --only desktop/lib/super_tabs`, `python3 desktop/scripts/audit-icons.py`, `icon_catalog_render_test`, `lucide_weight_test`, `laid_out_list_test`). Commit.

### Task 4: macOS microphone permission

**Files:**
- Modify: `desktop/macos/Runner/Release.entitlements`, `desktop/macos/Runner/DebugProfile.entitlements`, `desktop/macos/Runner/Info.plist`
- Test: `desktop/test/macos_microphone_permission_test.dart` (reads the plists: both entitlements carry `com.apple.security.device.audio-input` true; Info.plist carries `NSMicrophoneUsageDescription`)

- [ ] **Step 1: Write the failing test. Step 2: Watch it fail. Step 3: Commit.**
- [ ] **Step 4: Add the keys. Step 5: PASS. Commit.**
- [ ] **Step 6:** light and dark screenshots of the recording row and the refused line (`super_tab_composer_mic_shots_test.dart`), red/green evidence comment, `make release-desktop ARGS="--prepare"` on the pushed branch, linked in the PR.
