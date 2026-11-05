# Voice messages play only Implementation Plan

> Implemented by the task's Engineer, test first, task by task (project instructions: Engineer). No Execution Handoff.

**Goal:** A voice message is a play-only bubble on the phone, Desktop and web: play, the waveform and the length, with
no →A, no "Show words" and no transcript under it (anh Dee, 2026-11-04 and 2026-11-05). A voice message just sent plays
on the phone.

**Architecture:** Both bubbles lose their words toggle and the text they showed. Their `words` input goes, and so does
the `words` the callers passed in (`swarm_message_row.dart`, `swarm_conversation_page.dart`, `attachment_chips.dart`,
`message_row.dart`). A voice message's text stays hidden on both apps, as it is now. Playback on the phone already keeps
the clip as `.wav` since #3027 (merged in #3053 on 11-05 00:21); a test pins that for a message the phone just sent.

**Tech Stack:** Flutter (mobile/ and desktop/), flutter_test, video_player.

**Spec:** Task #3335; project instructions, Product decisions (anh Dee): "Voice messages play only, as Telegram draws
them: no transcript, no →A or Transcribe option, on any app."

## Global Constraints

- Phone and Desktop (web shares Desktop). No backend change: the server still stores the words, agents still read them.
- Simulator only; nothing installed on anyone's phone.
- Phone tests, Desktop tests and `scripts/check-ui-style.py` before Ready.

## Review Focus

- No path left that shows a voice message's words or offers to show them, on either app.
- The bubble's layout without the toggle (right padding, narrow phone column).

## Task 1: Phone bubble plays only

**Files:** `mobile/lib/swarm/swarm_voice_bubble.dart`, `mobile/lib/swarm/swarm_message_row.dart`,
`mobile/lib/swarm/swarm_conversation_page.dart`; tests `mobile/test/swarm/swarm_voice_bubble_test.dart`,
`mobile/test/swarm/swarm_chat_voice_test.dart`, `mobile/test/render/swarm_voice_render_test.dart`.

**Interfaces:** `SwarmVoiceBubble({file, voice, fileRef})`; `words`, `swarmVoiceNoWords` and `swarmVoiceNoWordsLimit` go.

- [ ] Test: a voice bubble has no →A, no "Show words", and never shows the message's words; a chat's voice message
      shows no words either. Run, watch it fail.
- [ ] Remove the toggle and the words. Run, watch it pass.
- [ ] Test: a voice message the phone just sent plays from a `.wav` copy, served with the headers the backend's
      direct upload stores.

## Task 2: Desktop bubble plays only

**Files:** `desktop/lib/super_tabs/voice_bubble.dart`, `desktop/lib/super_tabs/attachment_chips.dart`,
`desktop/lib/super_tabs/message_row.dart`; tests `desktop/test/super_tab_voice_message_test.dart`,
`desktop/test/super_tab_voice_message_shots_test.dart`.

**Interfaces:** `SuperTabVoiceBubble({file})`; `SuperTabAttachments` loses `words`.

- [ ] Test: no →A, no "Show words" tooltip, no words under the bubble. Run, watch it fail.
- [ ] Remove the toggle and the words. Run, watch it pass.
