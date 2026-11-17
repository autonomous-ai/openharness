// The Harness Pro's cable client: the daemon's framed JSON in, pro_app_* calls out; the few messages the Pro sends back.
// Only the messages Pod and the Max use are parsed (docs/cable.md); everything else is counted as unknown and ignored.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// The second byte pair of the frame names the product; this names it again in the hello (cable_frame.h).
#define CABLE_PRODUCT "harness"
#define CABLE_PROTO_VERSION 3   // 3: + question.close (a question answered on another client)

// Start the cable_link reader task and the hello task. Idempotent. Without a daemon the Pro just shows "Not connected".
void pro_cable_start(void);

// ---- sends Pod uses ----
bool pro_cable_send_open(const char *agent_id);    // agent.open: the person tapped an agent
// notif.read: this notification was read on the Pro. The daemon ignores one without a valid token, so a bad one is not sent (false).
bool pro_cable_send_notif_read(const char *agent_id, const char *read_token);
typedef enum { PRO_SCROLL_DOWN = 0, PRO_SCROLL_MOVE = 1, PRO_SCROLL_UP = 2 } pro_scroll_phase_t;   // the wire order
// Recap scroll echo. Never early-outs on dy 0: the two ends of a stroke are the point. `velocity` rides only on UP.
// Never waits (cable_link_send_nowait): it runs on the touch task, and a busy link loses the echo rather than the finger.
bool pro_cable_send_scroll(pro_scroll_phase_t phase, int dy, int velocity);
// player.library.get. `offset` 0..1000000. `request` is remembered: only the reply to the latest request is delivered.
// Never waits (the render task sends it); false when it could not go out, and pro_app asks again.
bool pro_cable_request_library(int offset, uint32_t request);

// Voice: begin sends voice.begin and remembers `upload_id` (<= 23 chars) to match the reply; pcm is a CABLE_TYPE_PCM
// frame (16-bit mono); end finishes the recording (the reply arrives as pro_app_voice_result); abort/cancel discard it.
bool pro_cable_voice_begin(const char *agent_id, const char *lang, int sample_rate, const char *upload_id);
bool pro_cable_voice_pcm(const uint8_t *pcm, size_t len);
bool pro_cable_voice_end(const char *upload_id);
bool pro_cable_voice_abort(const char *upload_id, const char *why);   // why may be NULL
bool pro_cable_voice_cancel(const char *upload_id);                   // voice.abort why:"discarded" (link-side cleanup)
// The next voice.begin is a spoken name for this form's field at this revision: it carries formId and formRevision and
// no agentId, and the reply arrives as pro_app_voice_form. NULL: an ordinary recording. Set before each pro_voice_begin.
void pro_cable_voice_form(const char *form_id, int revision);

// ---- answering and New Harness (the Max; the Pro sends none of these) ----
// `wait`: block for the port like a tap's agent.open (the touch task), or give up at once (the render task). Each
// returns false when the message is malformed or could not go out.
// question.read {agentId, requestId}: the open question whole, for answering it (pro_app_question_state replies).
bool pro_cable_question_read(const char *agent_id, const char *request_id, bool wait);
// answer.reviewed {agentId, token, requestId, choices}: one option mask per question, bit j for option j
// (pro_app_answer_receipt replies).
bool pro_cable_answer_reviewed(const char *agent_id, const char *token, const char *request_id, const uint8_t *choices,
                               int count, bool wait);
// answer {agentId, requestId, answers:{key: value}}: a daemon without question.review. `request_id` is the question's
// id; no reply comes.
bool pro_cable_answer(const char *agent_id, const char *request_id, const char *const keys[], const char *const values[],
                      int count, bool wait);
// form {requestId, formId, surface:"new", op, revision, delta}: New Harness on the cabled computer. op is open, state,
// move (delta -8..8, not 0), activate, back or close; formId is [A-Za-z0-9-]{1,48} (pro_app_form_state replies).
bool pro_cable_form(const char *form_id, const char *request_id, const char *op, int revision, int delta, bool wait);

// ---- state ----
bool pro_cable_connected(void);          // a welcome arrived and the daemon has not gone quiet
bool pro_cable_library_supported(void);  // welcome.features names player.library
bool pro_cable_supports(uint32_t feature);   // welcome.features names every CABLE_FEATURE_* bit in `feature`

const char *pro_cable_fw_version(void);

// ---- seams ----
// Messages dropped as malformed / ignored as unknown, cumulative (the heartbeat prints them; the host tests read them).
void pro_cable_counters(uint32_t *bad, uint32_t *unknown);
// Frames the daemon's `seq` numbering showed missing (each one asked for a resync), cumulative.
uint32_t pro_cable_seq_gaps(void);
// cable_link's callbacks (also what test_pro_cable.c feeds). on_frame runs on the cable_link task.
void pro_cable_on_frame(uint8_t version, uint8_t type, const uint8_t *payload, size_t payload_len, void *ctx);
void pro_cable_tick(void *ctx);

// Sound = !muted, from the app's per-device settings. The beep checks this.
bool pro_settings_muted(void);
