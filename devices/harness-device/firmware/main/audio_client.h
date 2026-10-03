// Touch-driven voice capture: 16kHz PCM streamed over the existing USB cable session.
#pragma once

#include <stdbool.h>
#include <stddef.h>

// Reserve audio buffers (and Habitat's capture/sender workers) once at boot.
void audio_client_init(void);

// Which slash command (if any) the backend should put in front of this utterance's transcript. The
// device picks it from the Overview mode select; the backend prepends "/goal " or "/loop " and the
// machine-adapter strips whatever the target engine cannot take.
typedef enum { VOICE_CMD_NONE = 0, VOICE_CMD_GOAL, VOICE_CMD_LOOP } voice_cmd_t;

/**
 * Start a voice turn: capture on the dial, stream over the cable, let the daemon transcribe.
 *
 * ONE entry point, where there used to be five. The old ones differed by what the BACKEND needed told — a
 * project id, a session id, an autonomy mode, whether the router should pick — and none of that is this
 * device's business any more.
 *
 * `agent_id` NULL or "" = spoken from the Overview: the daemon decides from the words which agent they
 * belong to. `cmd` is the one modifier a person can express by how they hold the button.
 */
void audio_client_start_cable(const char *agent_id, voice_cmd_t cmd);
// Habitat's deliberate quote-and-speak flow. No selected text is held on the device.
void audio_client_start_form(const char *id, unsigned revision);
void audio_client_copy_form(char *out, size_t capacity, unsigned *revision);
void audio_client_start_selection(const char *agent_id, const char *selection_id, unsigned revision);
void audio_client_start_carry(const char *agent_id, const char *carry_id);
void audio_client_copy_carry(char *out, size_t capacity);
void audio_client_copy_selection(char *out, size_t capacity, unsigned *revision);

void audio_client_stop(void);

// Quota rejection: stop recording/uploading and discard the utterance without drain/retry/finalize.
void audio_client_abort(void);

bool audio_client_active(void);

// True when `upload_id` belongs to the current or just-finished utterance. Used to accept a final
// quota verdict after voice_end while ignoring delayed frames once a newer utterance has started.
bool audio_client_upload_matches(const char *upload_id);
void audio_client_copy_upload_id(char *out, size_t capacity);

// True only while capturing mic PCM (false once the clip is uploading). Used by the UI to switch its
// indicator to "Sending…" when capture ends.
bool audio_client_recording(void);

// Coarse energy estimate, not a reliable speech detector: quiet speech may never cross this gate.
// Habitat recording stays under explicit user control; this estimate must not discard its audio.
bool audio_client_heard_voice(void);
// 0..4 measured mic envelope for local visual feedback; not speech recognition/VAD.
unsigned audio_client_input_level(void);

void audio_client_start_question(const char *id, const char *token, unsigned index);
void audio_client_copy_question(char *out, size_t capacity, unsigned *index);

void audio_client_request_review(void);
bool audio_client_review_requested(void);
void audio_client_start_draft(const char *id, unsigned revision, bool append);
void audio_client_copy_draft(char *out, size_t capacity, unsigned *revision, bool *append);

void audio_client_start_search(const char *agent_id, const char *selection_id, unsigned revision);
void audio_client_copy_search(char *out, size_t capacity, unsigned *revision);
