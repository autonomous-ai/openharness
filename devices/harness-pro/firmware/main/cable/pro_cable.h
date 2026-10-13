// The Harness Pro's cable client: the daemon's framed JSON in, pro_app_* calls out; the few messages the Pro sends back.
// Only the messages Pod uses are parsed (docs/cable.md); everything else is counted as unknown and ignored.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "cJSON.h"

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

// ---- state ----
bool pro_cable_connected(void);          // a welcome arrived and the daemon has not gone quiet
bool pro_cable_library_supported(void);  // welcome.features names player.library

const char *pro_cable_fw_version(void);

// ---- seams ----
// Host-test only (nothing on the device reads them): messages dropped as malformed / ignored as unknown.
void pro_cable_counters(uint32_t *bad, uint32_t *unknown);
// cable_link's callbacks (also what test_pro_cable.c feeds). on_frame runs on the cable_link task.
void pro_cable_on_frame(uint8_t version, uint8_t type, const uint8_t *payload, size_t payload_len, void *ctx);
void pro_cable_tick(void *ctx);

// Sound = !muted, from the app's per-device settings. The beep checks this.
bool pro_settings_muted(void);
