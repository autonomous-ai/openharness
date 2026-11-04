# Composer Mic Dictation (Desktop and Web) Implementation Plan

> **For agentic workers:** The assigned Engineer implements this plan task by task in this session, test first, by the project's instructions (plan first in a draft PR; each failing test committed before its code; one independent review step on the pull request). No subagents: the tasks share the dictation seam.

**Goal:** On macOS and the web, tapping the Swarm composer's mic (main chat and thread) dictates live into the message box with the platform's own speech recognition, as the Claude app does: words stream in as editable text; tap again or Enter stops. Press and hold sends today's voice message (#2665), once anh Dee's answer (or its default, yes at 10:00 on 11-05) stands. The phone is its own task (River, 11-04).

**Architecture:** `voice_dictation.dart` adds a recognizer seam, `SuperTabDictation` (`available`, `listen`, `stop`, `cancel`), with `SuperTabSystemDictation` over `speech_to_text` 7.5: SFSpeechRecognizer on macOS, the Web Speech API in the browser. `dictation_session.dart` holds one dictation, as `SuperTabVoiceTake` holds one take: it remembers the caret, replaces its own words as partial results arrive, and keeps the final ones. The person can edit them, and typing stops the dictation. A browser with no Web Speech API (Firefox) falls back to today's record-and-transcribe: the take's WAV goes to `POST /api/voice/stt` (`ApiClient.transcribeVoice`), and its words go into the box. The view owns one session per Swarm view, like the take, and the mic's tap starts or stops it. Press and hold starts today's voice take.

**Tech Stack:** Flutter (Desktop, web build of the same code), `speech_to_text` ^7.5.0, flutter_test widget tests with the `ConversationServer` fixture (memory store, fake sign-in) and fake recognizers.

**Spec:** Swarm task #2888, conversation 8c076dc7cd88d85b1f640749 (Huy, 11-04; River's brief; phone split agreed 11-04).

## Global Constraints

- Dictated words go into the box at the caret, a space apart from the text around them, and stay editable; nothing is sent by itself.
- The mic's tooltip says what it does (Huy, 11-04): "Tap to dictate" while only tap is built, "Tap to dictate · Press and
  hold to record" once press and hold ships (Task 5). "· Right-click for microphone settings" is added only by the
  follow-up task that builds that menu. A listening mic shows the accent colour and the tooltip "Stop dictation". Tap again or Enter stops; the first Enter while listening only stops, the next one sends.
- Typing or switching chat while listening stops the dictation and keeps what was heard.
- macOS: `NSSpeechRecognitionUsageDescription` in Info.plist; the microphone entitlement (#2665) is already there. Refused speech recognition shows one line under the box: "Harness can't use speech recognition · Open System Settings" (Privacy ▸ Speech Recognition). macOS always has a recognizer, so a refusal is not a reason to fall back, which would go around the person's choice.
- Web with no recognizer: record-and-transcribe, in the computer's language (`/api/voice/stt` falls back to English for one it does not serve). The native app has no fallback path: the local CLI forwards no `/api/voice/stt`, and macOS always has a recognizer.
- The language is the computer's own (`PlatformDispatcher.locale`), as #2665; no picker.
- Mic only on macOS and the web (#2665's `superTabVoiceRecorder()`); Linux and Windows unchanged.
- Press and hold = today's voice message. This ships only once anh Dee's answer, or its default, stands: the PR stays a draft before then.
- Harness Design Language tokens only; icons through `AppIcons` at weight 400.
- Never run a test that signs the Mac out of the real CLI; Desktop tests use a memory store and a fake sign-in.
- PR body first line: "Requested by phamngochuy.1989@gmail.com through Harness."

## Design

- **Growth:** nothing stored; a fallback take is in memory until transcribed (at most 5 minutes, under 10 MB).
- **Concurrency:** one dictation per Swarm view; a voice take and a dictation never run together (starting one ends the other).
- **Read cost:** none in the browser and none on macOS (the OS recognizer); the fallback makes one `/api/voice/stt` call per take, under the person's daily voice quota.
- **Scale:** N/A because the recognizer runs on the person's machine or browser; the fallback is bounded by the existing voice quota.
- **Compatibility:** no server change; `/api/voice/stt` exists today.
- **Migration + rollback:** N/A because nothing is stored.
- **Audience:** the person's own words go into their own box; `/api/voice/stt` checks the signed-in user.
- **Identity:** the signed-in person's own voice quota.
- **Failure:** every failure is one line under the box and keeps the text typed so far: refused recognition (with the setting), no speech heard, a recognizer error, a fallback upload refused or over the limit.
- **Platforms:** macOS (SFSpeechRecognizer) and browsers with the Web Speech API (Chrome, Edge, Safari); other browsers fall back. Linux and Windows show no mic.

## Review Focus

1. Partial results replace only the dictation's own words: what was typed before and after the caret is never lost or duplicated.
2. Enter while listening stops and does not send; Enter again sends.
3. A dictation and a voice take never run at once, and switching chat stops the dictation into the right box.
4. macOS: the speech usage text and a release prepare run (signing and notarization).
5. The fallback sends the take to `/api/voice/stt` only in a browser with no recognizer.

---

### Task 1: The recognizer seam and the dictation session

**Files:** Create `desktop/lib/super_tabs/voice_dictation.dart`, `desktop/lib/super_tabs/dictation_session.dart`; modify `desktop/pubspec.yaml`/`pubspec.lock` (`speech_to_text`); test `desktop/test/super_tab_dictation_session_test.dart`, `desktop/test/support/fake_dictation.dart`.

**Interfaces:** `abstract interface class SuperTabDictation { Future<SuperTabDictationReady> available(); Future<void> listen({required void Function(String words, bool done) onWords, required void Function(String error) onError}); Future<void> stop(); Future<void> cancel(); }`; `enum SuperTabDictationReady { ready, refused, none }`; `class SuperTabDictationSession extends ChangeNotifier` with `state` (`off`, `starting`, `listening`, `transcribing`), `conversationId`, `root`, `notice`, `refused`, `start({conversationId, root, text: TextEditingController})`, `stop()`, `cancel()`.

- [ ] **Step 1: Failing tests** with a fake recognizer: start listens and shows listening; partial words stream into the box at the caret, replacing only their own earlier partials; final words stay, and the session ends listening when the recognizer is done; stop ends it and keeps the words; typing while listening stops it; text before and after the caret is kept with single spaces; a refused recognizer sets `refused` and listens to nothing; no recognizer falls back to a fake recorder plus transcriber whose words land in the box; a fallback failure keeps the box as it was and says why.
- [ ] **Step 2: Watch them fail. Step 3: Commit the failing tests.**
- [ ] **Step 4: Implement. Step 5: PASS. Commit.**

### Task 2: The fallback's transcription call

**Files:** Modify `desktop/lib/api/api_client.dart` (`transcribeVoice`); test `desktop/test/api_client_transcribe_test.dart`.

- [ ] Failing test with a fake Dio adapter: a multipart POST to `/api/voice/stt?lang=vi` with one `file` part named `dictation.wav` (`audio/wav`), answering `transcript`; a refusal is a `SuperTabFailure`-style error with the server's message. Then the code.

### Task 3: The composer's mic dictates

**Files:** Modify `desktop/lib/super_tabs/view.dart`, `thread_panel.dart`, `reply_box.dart`, `composer_actions.dart` (listening state), `voice_row.dart` (the dictation notice), `workspace.dart` (passes `superTabDictation()` and the web's transcriber); test `desktop/test/super_tab_composer_dictation_test.dart`.

- [ ] Failing widget tests at 1280x720 with a fake recognizer: tapping the mic streams words into the chat's box and the mic shows listening; tap again stops; Enter while listening stops and does not send, and the next Enter sends; switching chat stops and keeps the words in the first chat's draft; the thread's mic dictates into the thread's box; refused recognition shows the line with Open System Settings; the mic's tooltip is "Tap to dictate"; no mic on Linux and Windows. Then the code.

### Task 4: macOS speech permission

**Files:** `desktop/macos/Runner/Info.plist`; test `desktop/test/macos_microphone_permission_test.dart` (adds the speech usage text).

- [ ] Failing test, then the key.

### Task 5: Press and hold sends a voice message (after anh Dee's answer)

**Files:** `composer_actions.dart`, `view.dart`, `reply_box.dart`; test `super_tab_composer_mic_test.dart` (the #2665 tests move from tap to press and hold).

- [ ] Failing tests: a long press starts today's voice take and its row; a tap no longer does; the tooltip reads "Tap to dictate · Press and hold to record". Then the code.

### Task 6: Evidence

- [ ] Light and dark screenshots of the listening mic with streamed words, and the refused line (`super_tab_composer_row_shots_test.dart`); red/green comment; `make release-desktop ARGS="--prepare"` at the final head; a person line to Huy.
