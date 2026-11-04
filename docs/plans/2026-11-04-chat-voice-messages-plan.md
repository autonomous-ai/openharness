# Chat voice messages Implementation Plan

> **For agentic workers:** Follow the project Engineer workflow: plan first in a draft PR; implement task by task with a committed failing test before its passing code; one independent review step on the pull request.

**Goal:** The phone's mic records a voice message that is sent as audio, as Telegram does. People hear it on phone and Desktop, agents read its words. Strengthens "Tell the PM what you want, and your crew ships it": a person on the go tells the crew by speaking, and the crew gets the words.

**Architecture:** The phone records 16 kHz mono PCM WAV with the recorder it already has (`phone/voice_recorder.dart`) and uploads it as an ordinary chat file. Before sending, it asks the server to read the file as a voice message. The server transcribes the file once, with the existing Deepgram WAV path (`lib/deepgramWav.ts`) under the existing daily voice quota, and works out the clip's length and waveform from the bytes. It stores all three on the attachment row. `message.send` then carries them: the words become the message's text and the attachment gains `voice: { durationMs, waveform, transcribed }`. Deliveries are written in the same transaction as the message, so agents get the words at once. At claim time the delivered text is marked `Voice message (1:21): …`. Server previews say `Voice message (1:21)`. Both apps draw a voice bubble for an attachment that has `voice`, and play it with `video_player`.

**Tech Stack:** TypeScript, Fastify, Prisma on MongoDB, Vitest (backend); Flutter/Dart with `record` and `video_player` (phone); Flutter/Dart with `video_player` (Desktop).

**Spec:** Task #2584 in Super Tab conversation e18fc8a3f98dafce9bd0a53c (Dee, 2026-11-04; brief from River the same day).

## Why transcribe before send, not after

Chat messages are never changed after they are written. The message and its agent deliveries are written in one transaction (`store.ts writeMessages`), and a host types a message's text as it claims it. If the words came after the send, agents would get an empty message, unless the server added a message-edit path and a delivery hold for this one feature. Transcribing when the file arrives, before it can be sent, keeps message rows write-once. Deliveries stay as they are, and every reader, including old Desktop and CLI releases, sees the words as the message's text.

## Why WAV

The recorder already records PCM WAV, and Deepgram's WAV path is measured per language (`deepgramWav.ts`). The server can only charge a clip against the daily voice quota once it knows the clip's length, and for WAV the length follows from the header and the size (`wavDurationMs`). A compressed format would need a decoder or a client-stated length, and the caller would control what it is charged. The cost is 1.9 MB a minute, 19 MB at the 10:00 cap. Over 10 MB the upload goes up through the existing upload link.

## Global Constraints

- Phone recording row: `( X )   ● 0:14   ıllıllıııllıı.ılı           ( ↑ )`. Tony's composer card stays. X discards the take, the red dot shows the running time, the live waveform moves, and Send posts the take. Nothing goes into the text box.
- Voice bubble, phone and Desktop: `( ▶ )  ıllıllııılllıı.ılıı.ıll   1:21        →A`. It has play/pause, a waveform with the played part filled, the length, and →A. →A shows the words under the bubble, and a second tap hides them.
- A take stops at exactly 10:00 with Send ready. Locking the phone or leaving the chat stops the take and keeps it, with Send and X still there.
- The old path that dictated words into the box is removed: `swarm_dictation.dart`, its iOS channel and the recognizer branch of `swarm_voice.dart`. The keyboard's own dictation stays.
- Desktop plays voice messages and does not record them.
- The server transcribes each voice file once and stores the words with the message. The audio stays attached like any file.
- Agents receive `Voice message (M:SS): <words>` as the message's text. A file that could not be transcribed reaches them as `Voice message (M:SS), not transcribed.`
- Activity, tags, inbox and thread previews, and the phone's and Desktop's own reply quotes, say `Voice message (M:SS)`.
- Lengths are written `M:SS`, rounded down to the second: 81 s is `1:21`, 600 s is `10:00`.
- Transcripts never reach a log line, an error or telemetry. Audio is stored like any other attachment.
- Harness Design Language tokens on both apps; no hard-coded colours or sizes.
- Run `dart format` only on the files changed. Swarm code stays out of cli/src/core.
- Never run a test that signs the Mac out of the real CLI; Desktop tests use a memory store and a fake sign-in.

## Design

- **Growth:** the voice fields live on the `SuperTabAttachment` row and on the message's `attachments` JSON. They are deleted with their row: an unsent file's row by the unsent-file sweep after 24 h, a sent message's copy with its message. One clip is at most 10:05 (19.3 MB) and its waveform at most 48 numbers.
- **Concurrency:** one attachment row. The first call claims it with a conditional write on a `voiceSince` date (`voice` not set, and `voiceSince` not set or stale). A second call made while the first runs gets `VOICE_TRANSCRIBING`, 409, and the phone retries it after a second, at most 30 times. A claim older than 2 minutes counts as lost, and the next call takes it over. The quota reservation is keyed by `voice:<attachmentId>`, so a retake is never charged twice.
- **Read cost:** the transcription request reads the file's own bytes once, at most 19.3 MB, held within the existing process-wide voice memory budget (`reserveVoice`). `message.send` reads the `voice` field alongside the attachment fields it already loads. Message pages get one more small field per voice attachment.
- **Scale:** at 10× (hundreds of voice messages a day), Deepgram calls and bucket reads grow linearly. The voice memory budget refuses work beyond what the process can hold, with `VOICE_BUSY`. The first warning is the `super-tab voice` log line's `ms` and `outcome` counts.
- **Compatibility:** old Desktop and CLI releases ignore `voice`. They show the words as the message text plus a `Voice message.wav` file chip, and agents of an old CLI get the words with the file. New clients against an old server (the backend ships first, so only briefly): the voice route answers 404, and the phone keeps the take, sends nothing and says "Voice messages need a newer server". Messages without `voice` render as today.
- **Migration + rollback:** two new optional fields on `SuperTabAttachment`: `voice` (Json) and `voiceSince` (DateTime). MongoDB needs no migration. After a rollback the old server keeps the field and ignores it, and sent messages keep their text and file.
- **Audience:** the voice route allows only the actor that uploaded the file, while that actor may still post in its conversation, and only for an unused file with no `purpose`. A sent message's words are read through the same message reads as its text, under the existing guards. Buddies get the row through `rowForBuddy` as today.
- **Identity:** transcription is charged to the uploading person's own daily voice quota (`voiceQuotaService.reserveForUser`). Only people send voice messages: an agent caller (`asAgentId`) is refused.
- **Failure:** every failure is named, and the message still sends. Over the daily voice limit: `transcribed: false` with `failure: 'limit'`, the phone says "Today's voice limit is used; sent without words", and agents read "not transcribed". Deepgram down: `failure: 'failed'`, final like the limit (once per file), and the message sends without words. Not WAV, or over 10:05: refused with 415 or 413. A log line carries the outcome, the size and the length, never the words.
- **Platforms:** recording on iOS and Android. Playback on iOS, Android, macOS and web with `video_player`. On Linux and Windows, `video_player` has no implementation, so the bubble's play button opens the file in the system's player, as a file chip does today.

## Review Focus

1. **A take that hits 10:00 while the phone is locked** stays held, with Send ready, when the app comes back: no auto-send, nothing lost. Test in Task 6.
2. **Sending the same take twice** (a retry after a lost answer) makes one message and one charge. Test in Task 2 (once per file) and Task 3 (the second `message.send` of a used file is refused, as today).
3. **A voice message replied to or quoted** shows `Voice message (1:21)`, not an empty quote. Test in Tasks 8 and 10.
4. **A transcript with a credential in it** is redacted like typed text before it becomes the message's text. Test in Task 3.
5. **A link that expires during a long playback.** The player plays from a local copy of the file, never from the signed link. Tests in Tasks 8 and 10 check that it plays a file path.

---

### Task 1: Voice clip facts (backend)

**Files:**
- Create: `backend/src/lib/wav.ts` (`wavDurationMs` moves here from `routes/voice.ts`; the route imports it)
- Create: `backend/src/superTabs/voiceMessages.ts`
- Test: `backend/src/superTabs/voiceMessages.test.ts`

**Interfaces:**
- Produces: `wavDurationMs(audio: Buffer): number | null` (unchanged behaviour); `voiceWaveform(wav: Buffer, bars = 48): number[]` (each 0–31, the RMS of its slice on the dB scale of the phone's `pcm16Level`); `voiceLength(durationMs: number): string` (`M:SS`); `voiceLabel(durationMs: number): string` (`Voice message (1:21)`); `MAX_VOICE_MS = 605_000`.

- [ ] Step 1: write failing tests: `voiceLength(81_000) === '1:21'`, `voiceLength(600_000) === '10:00'`, `voiceLength(999) === '0:00'`; `voiceLabel(81_000) === 'Voice message (1:21)'`; a WAV of silence gives 48 zeros, a WAV whose second half is a loud tone gives low first bars and high last bars, and a WAV shorter than 48 samples still gives 48 bars.
- [ ] Step 2: run `npx vitest run src/superTabs/voiceMessages.test.ts` and expect a FAIL on a missing module.
- [ ] Step 3: implement. `routes/voice.test.ts` still passes with the moved function.
- [ ] Step 4: run both tests and expect a PASS. Commit.

### Task 2: Transcribe a voice file once (backend)

**Files:**
- Modify: `backend/prisma/schema.prisma` (`SuperTabAttachment.voice Json?` and `voiceSince DateTime?`, documented)
- Modify: `backend/src/superTabs/store.ts` (`readVoice`, beside `completeUpload`)
- Modify: `backend/src/routes/superTabs.ts` (`POST /api/super-tabs/:tabId/attachments/:attachmentId/voice`, empty body)
- Test: `backend/src/superTabs/voiceMessages.store.test.ts` (memory store, mocked `transcribeWavWithDeepgram` and `voiceQuotaService`)

**Interfaces:**
- Produces: `store.readVoice(user, tabId, attachmentId, env): Promise<{ attachment: Attachment & { voice: VoiceFacts } }>` where `VoiceFacts = { durationMs: number; waveform: number[]; transcribed: boolean; failure?: 'limit' | 'failed' }`. The stored row adds `transcript: string | null`, which is never returned by this route.

- [ ] Step 1: write failing tests:
  - A WAV upload answers `durationMs`, 48 `waveform` values and `transcribed: true`, and calls Deepgram once.
  - A second call answers the same and calls Deepgram no more.
  - Two calls at once: one transcribes and the other gets `VOICE_TRANSCRIBING`.
  - A claim older than 2 minutes is taken over.
  - Another actor's file, a used file and a pending upload each give `ATTACHMENT_UNAVAILABLE`.
  - A non-WAV file gives `UNSUPPORTED_AUDIO`, 415.
  - A clip over 10:05 gives `VOICE_TOO_LONG`, 413.
  - Quota exceeded gives `transcribed: false, failure: 'limit'` and no Deepgram call.
  - A Deepgram error gives `failure: 'failed'`, with the quota released, and a later call answers the same.
  - `asAgentId` is refused.
  - No log line contains the transcript (spy on the logger).
- [ ] Step 2: run them and expect FAIL.
- [ ] Step 3: implement. Read the bytes with `direct.head(objectKey, size)` under `reserveVoice`. Reserve the quota under the id `voice:<id>` and call `transcribeWavWithDeepgram(bytes, 'audio/wav', lang)`, both through an injected `SuperTabStoreHooks.voice`, so tests fake them; the production store wires the real ones in `routes/superTabs.ts`. Then store `{ durationMs, waveform, transcribed, failure?, transcript }`. Language: the phone passes its picked voice language as `?lang=` (`pickWavLang`), and it is `en` when none is given.
- [ ] Step 4: run them and expect PASS. Commit.

### Task 3: A voice file sends as a voice message (backend)

**Files:**
- Modify: `backend/src/superTabs/attachments.ts` (`Attachment.voice?`)
- Modify: `backend/src/superTabs/store.ts` (the attachments loaded for `message.send` carry `voice` and `transcript`)
- Modify: `backend/src/superTabs/commands.ts` (in `message.send`)
- Test: `backend/src/superTabs/commands.test.ts` (`describe('voice messages')`)

**Interfaces:**
- Produces: a message whose one attachment has `voice: { durationMs, waveform, transcribed }`, and whose `text` is the stored transcript, or `''` when there is none.

- [ ] Step 1: write failing tests:
  - Sending a transcribed voice file stores its words as the text, and the attachment carries `voice` without `transcript`.
  - A voice file with other files or with typed text gives `VOICE_ALONE`, 400.
  - A file still transcribing gives `VOICE_TRANSCRIBING`, 409.
  - An untranscribed file sends with an empty text.
  - A credential in the words is redacted.
- [ ] Step 2: run them and expect FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: run them and expect PASS. Commit.

### Task 4: Agents read the words; previews say "Voice message" (backend)

**Files:**
- Modify: `backend/src/superTabs/store.ts` (the claim's row mapping, beside `rowForBuddy`)
- Modify: `backend/src/superTabs/activity.ts`, `read/inbox.ts`, `read/followedThreads.ts`, `mentions.ts`, `catchUp.ts`, `noticeDigest.ts` (each preview text goes through `previewText`)
- Modify: `backend/src/superTabs/voiceMessages.ts` (`previewText(message: { text: string; attachments?: unknown }): string`, `agentText(...)`)
- Test: `backend/src/superTabs/voiceMessages.test.ts` and each reader's existing test file

- [ ] Step 1: write failing tests:
  - A claimed delivery of a voice message has `Voice message (1:21): hello team` as its text.
  - An untranscribed one has `Voice message (1:21), not transcribed.`
  - A Buddy's claim is marked the same way.
  - Activity, inbox, followed-thread, tag and catch-up previews of a voice message say `Voice message (1:21)`.
  - A plain message's preview is unchanged.
- [ ] Step 2: run them and expect FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: run them and the tests of what imports the changed code, and expect PASS. Commit.

### Task 5: The model and the API (phone)

**Files:**
- Modify: `mobile/lib/swarm/model.dart` (`SuperTabVoice { int durationMs; List<int> waveform; bool transcribed }`, `SuperTabAttachment.voice`, parsed defensively, with a bad value read as no voice)
- Modify: `mobile/lib/swarm/swarm_outgoing_files.dart` (`wav` → `audio/wav`)
- Modify: `mobile/lib/swarm/swarm_request.dart`, `mobile/lib/state/app_state.dart`, `mobile/lib/services/api_client.dart` (`readSwarmVoice(tabId, attachmentId, lang)`)
- Create: `mobile/lib/swarm/voice_length.dart` (`swarmVoiceLength(Duration) → 'M:SS'`, `swarmVoiceLabel(Duration) → 'Voice message (M:SS)'`)
- Test: `mobile/test/swarm/swarm_voice_model_test.dart`

- [ ] Steps: failing tests for parsing, a bad `voice` value, the length and the label (the same cases as Task 1); then the implementation. Commit both.

### Task 6: Recording a voice message (phone)

**Files:**
- Rewrite: `mobile/lib/swarm/swarm_voice.dart` (`SwarmVoice` records takes; `SwarmVoiceRow` draws X, the dot with the time, the wave and Send)
- Delete: `mobile/lib/swarm/swarm_dictation.dart`, the dictation channel in `mobile/ios/Runner/AppDelegate.swift`, its `Info.plist` speech-recognition entry, and `test/swarm/swarm_dictation_test.dart`, `swarm_chat_dictation_test.dart`
- Modify: `mobile/lib/swarm/swarm_session.dart`, `mobile/lib/phone/phone_shell.dart` (`SwarmHost.voice` makes a `VoiceRecorder`; the `dictation` lookup goes)
- Test: rewrite `mobile/test/swarm/swarm_chat_voice_test.dart`

**Interfaces:**
- Produces: `SwarmVoice({required VoiceRecorder Function() recorder, required Future<void> Function(VoiceTake take) send})` with `tap()`, `discard()`, `send()`, `stop()`, `hide()` (stops and keeps the take), `state` (`off | recording | held | sending`), `elapsed`, `level`. `SwarmVoice.maxTake = Duration(minutes: 10)`.

- [ ] Step 1: write failing tests:
  - A tap records; Send calls `send` with the take and leaves the text box as it was.
  - X discards the take and sends nothing.
  - At 10:00 (fake async) the take stops by itself, Send stays, and nothing is sent.
  - `hide()` and the app being paused stop the take and keep it.
  - A refused microphone shows the existing notice.
  - A second tap while recording stops the take and holds it.
- [ ] Step 2: run them and expect FAIL.
- [ ] Step 3: implement. Keep `SwarmVoiceWave` and the composer card; the row is the mockup's.
- [ ] Step 4: run them and expect PASS. Commit.

### Task 7: Sending a take (phone)

**Files:**
- Modify: `mobile/lib/swarm/swarm_conversation.dart`, `swarm_thread.dart` (`sendVoice(VoiceTake take)`: upload `Voice message.wav`, `readSwarmVoice`, then `message.send` with that one file)
- Modify: `mobile/lib/swarm/swarm_conversation_page.dart`, `swarm_thread_page.dart`, `swarm_new_message_sheet.dart` (wire `send`)
- Test: `mobile/test/swarm/swarm_chat_voice_test.dart`, `swarm_thread_voice_test.dart`

- [ ] Step 1: write failing tests:
  - A sent take posts `message.send` with the uploaded file id and empty text, after one voice read.
  - `VOICE_TRANSCRIBING` is retried.
  - A 404 from an old server keeps the take, sends nothing and says "Voice messages need a newer server".
  - `failure: 'limit'` shows "Today's voice limit is used; sent without words".
  - The draft in the box stays.
- [ ] Step 2: run them and expect FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: run them and expect PASS. Commit.

### Task 8: The voice bubble (phone)

**Files:**
- Create: `mobile/lib/swarm/swarm_voice_bubble.dart` (`SwarmVoiceBubble({required SuperTabAttachment file, required String words, SwarmFileRef fileRef})`)
- Modify: `mobile/lib/swarm/swarm_message_row.dart` (an attachment with `voice` draws the bubble; the message's text is not drawn as text; reply quotes use `swarmVoiceLabel`), `swarm_conversation_page.dart` `_Pending` (a pending take draws the bubble from its local take)
- Test: `mobile/test/swarm/swarm_voice_bubble_test.dart`; screenshots in `mobile/test/render/swarm_voice_render_test.dart`

- [ ] Step 1: write failing tests:
  - A voice message shows play, the waveform, `1:21` and →A, and no text.
  - →A shows the words and a second tap hides them.
  - Play loads the cached local file into the player (a fake player factory) and shows pause.
  - The played fraction fills the bars.
  - A reply to a voice message quotes `Voice message (1:21)`.
  - An untranscribed message's →A says "No words: not transcribed".
- [ ] Step 2: run them and expect FAIL.
- [ ] Step 3: implement with `VideoPlayerController.file` behind a factory the tests replace.
- [ ] Step 4: run them and expect PASS. Light and dark screenshots of the row and the bubble. Commit.

### Task 9: The model and previews (Desktop)

**Files:**
- Modify: `desktop/lib/super_tabs/model.dart` (`SuperTabVoice`, `SuperTabAttachment.voice`)
- Create: `desktop/lib/super_tabs/voice_length.dart`
- Modify: `desktop/lib/super_tabs/message_link_preview.dart`, `message_row.dart` (reply quote), `view.dart` (composer "Replying to")
- Test: `desktop/test/super_tab_voice_message_test.dart`

- [ ] Steps: failing tests for parsing, the label, and each of the three quotes saying `Voice message (1:21)`; then the implementation. Commit both.

### Task 10: The voice bubble and playback (Desktop)

**Files:**
- Modify: `desktop/pubspec.yaml` (`video_player`, with the reason in its comment: AVPlayer on macOS, `<audio>`/`<video>` on the web, first-party, with a Swift package)
- Create: `desktop/lib/super_tabs/voice_bubble.dart`
- Modify: `desktop/lib/super_tabs/attachment_chips.dart` (a third bucket for an attachment with `voice`), `message_row.dart` (no text block for a voice message)
- Test: `desktop/test/super_tab_voice_message_test.dart`; screenshots in `desktop/test/super_tab_voice_message_shots_test.dart` (`captureWindow`, light and dark)

- [ ] Step 1: write failing tests:
  - The bubble shows play, the waveform, `1:21` and →A, with no text block.
  - →A toggles the words.
  - Play reads the file through `readAttachment` to a temporary file and plays it (a fake player factory).
  - On Linux and Windows, play opens the file the way a chip does.
- [ ] Step 2: run them and expect FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: run them and expect PASS. Light and dark screenshots. Commit.

### Task 11: Evidence

- [ ] Locally: the changed tests, `npx tsc --noEmit`, and `flutter analyze` on the touched files of both apps. No whole suite runs locally (project instructions, revision 56): the PR's CI runs each touched component's suite once it is marked ready, and its green run is the suite evidence.
- [ ] A PR comment with red/green per task, and the screenshots in the PR body.
