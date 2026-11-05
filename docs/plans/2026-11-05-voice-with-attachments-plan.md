# Voice with attachments implementation plan

> Implement task by task in this Engineer session, test first, with one independent review of the pull request.

**Goal:** Send the composer's attached images/files and recorded clip as one message.
**Architecture:** Snapshot each composer's existing files, append the clip, upload all, then send one ordered attachment list. Keep typed text in the composer and retain existing outbox retry behavior.
**Tech Stack:** Flutter/Dart; existing Swarm upload and message APIs.
**Spec:** Swarm task #3354, conversation f2f09555de1e552303361d78.

## Global Constraints

- Voice messages play only; no transcript controls. No backend/protocol changes.
- Phone and Desktop chat and thread composers behave alike. Simulator only for phone acceptance.
- Preserve attachments on upload/read failure; consume only the snapshot when a send enters the outbox.
- Respect the existing ten-file message limit, counting the clip.

## Design

- Growth: existing attachment storage/lifetime and outbox cleanup; no new stored data.
- Concurrency: existing upload/send lane; snapshot files before awaiting and leave files added later alone.
- Read cost/scale: at most ten uploads per message; no new polling or reads. Existing upload error/progress is the first warning.
- Compatibility: existing ordered attachmentIds contract, understood by old clients.
- Migration/rollback: no migration; revert client changes.
- Audience/identity: existing authenticated upload/send endpoints enforce both.
- Failure: no send after failed upload or voice read; existing outbox handles uncertain delivery.
- Platforms: iOS/Android and Desktop/web, shared Dart send code.

## Review Focus

- Chat and thread files must stay isolated.
- A failed upload or voice read must keep composer files.
- A file added during upload belongs to the next message.
- Ten attachments plus a clip must be refused before upload.
- Pending combined messages must retain their voice bubble.

### Task 1: Phone send paths

**Files:** mobile/lib/swarm/swarm_conversation.dart, swarm_thread.dart, swarm_new_message_sheet.dart; mobile/test/swarm/swarm_voice_send_test.dart and new-message widget tests.
**Interfaces:** Existing sendVoice(VoiceTake, String) and SwarmOutgoingFiles; no signature changes.

- [ ] Add chat/thread tests asserting one command contains image, document, clip in that order; typed text remains, sent files leave the composer. Cover failed upload/read, concurrent additions, and file limit. Existing clip-alone test remains.
- [ ] Run the focused tests and commit failing tests.
- [ ] Snapshot composer files plus clip; read voice using the clip's final ID; remove only submitted files. Copy new-message sheet files into its chat before sending voice.
- [ ] Run focused phone tests and commit the fix.

### Task 2: Desktop send paths

**Files:** desktop/lib/super_tabs/voice_send.dart; desktop/test/super_tab_voice_send_test.dart.
**Interfaces:** Existing SuperTabController.sendVoice and attachments/threadAttachments.

- [ ] Add tests for ordered image/document/clip in one send, thread isolation, failed upload/read preservation, concurrent additions, and max count; retain clip-alone coverage.
- [ ] Run focused tests and commit failing tests.
- [ ] Upload a snapshot of the appropriate composer's files with the clip; consume only that snapshot once command owns the send.
- [ ] Run focused Desktop tests and commit the fix.

### Task 3: Pending phone presentation and acceptance

**Files:** mobile/lib/swarm/swarm_conversation_page.dart; mobile/test/swarm/swarm_chat_voice_test.dart.
**Interfaces:** Existing SwarmPost.files and voice; the appended final file is the recorded clip.

- [ ] Add a widget regression proving a pending combined post retains a voice bubble and file chip; run red and commit.
- [ ] Render each file in order, rendering the final recorded clip as voice; run green and commit.
- [ ] Run affected caller/widget tests and static analysis; record red/green evidence and exact revisions in the PR.
- [ ] Hand ready PR to independent review and simulator acceptance through Swarm steps; do not merge.
