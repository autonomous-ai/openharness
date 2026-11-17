// Harness Max's screen in pure C: the lanes model, fed from the cable's callbacks, drawn into a scene, and the finger
// turned into what the app must do. No ESP-IDF and no lock: max_app.c holds its own lock around every call, so the host
// tests drive it with a fake clock.
//
// The glass is 1920 x 480, landscape (HT_WIDTH x HT_HEIGHT; the 11.9" demo bar's 1480 x 320 is drawn at 1920 x 415 and
// scaled). Strings passed in are copied; a NULL string is "absent". A feed returns true when the screen changed and
// must be drawn again.
//
// What the bar sends goes through an outbox: the feeds, the finger and the clock queue messages, and the app takes them
// (max_ui_take) under its lock and sends them after releasing it.
#pragma once
#include <stdbool.h>
#include <stdint.h>

#include "cable/cable_machines.h"   // cable_machine_t
#include "cable/cable_types.h"      // ID_MAX, pod_tier_t
#include "pro_app_api.h"            // pro_agent_row_t
#include "terminal.h"               // ht_scene_t

// A fresh model: link down, no agents, nobody in the room, no notice, no update.
void max_ui_reset(void);

// ---- feeds (the cable_link task, through max_app.c) ----
bool max_ui_link(bool up, const char *machine, uint32_t now_ms);
bool max_ui_agents(const pro_agent_row_t *rows, int n, uint32_t now_ms);
bool max_ui_machines(const cable_machine_t *rows, int count, const char *selected);
// kind and text as pro_app_turn (pro_app_api.h).
bool max_ui_turn(const char *id, const char *kind, const char *text, int elapsed_s, uint32_t now_ms);
// An agent asks: `text` is the prompt, `items` the request's questions as pro_app_ask has them (n 0: none the daemon's
// inbox would hold, so only the computer can answer). `permission`: the daemon marked it a permission prompt.
// `review`: the daemon offers question.review, and the answer goes that way (read, then answer.reviewed); otherwise as
// a plain `answer`.
bool max_ui_question(const char *id, const char *request, const char *text, const pro_ask_item_t *items, int n,
                     bool permission, bool review, uint32_t now_ms);
bool max_ui_question_close(const char *id);
// The replies of the reviewed path, as pro_app_question_state and pro_app_answer_receipt.
bool max_ui_question_state(const char *id, const char *fetch, bool ok, const char *request, const char *token,
                           bool submitted, const char *error, const pro_ask_item_t *items, int n, uint32_t now_ms);
bool max_ui_answer_receipt(const char *id, const char *fetch, const char *token, bool ok, bool pending,
                           const char *error, uint32_t now_ms);
bool max_ui_summary(const char *id, const char *text, const char *recap, bool restore, pod_tier_t tier,
                    uint32_t now_ms);
// The computer's window moved to this agent: the room shows it. Not a person at the bar.
bool max_ui_focus(const char *id);

// ---- New Harness ----
// The welcome offers `form`: New shows under the pager. Read on every tick: a daemon restarted inside a session
// may differ.
bool max_ui_offers(bool form);
// Open the desktop's New Harness form under `form_id` ([A-Za-z0-9-]{1,48}, the app's random name: MAX_ACT_NEW).
bool max_ui_form_open(const char *form_id, uint32_t now_ms);
// form.state and voice.form, as pro_app_form_state and pro_app_voice_form.
bool max_ui_form_state(const char *request, const char *form_id, bool ok, const pro_form_page_t *page, uint32_t now_ms);
bool max_ui_voice_form(const char *form_id, bool ok, const pro_form_page_t *page, uint32_t now_ms);

// ---- the outbox ----
#define MAX_OUTBOX 8                // queued messages; a take hands out at most this many
#define MAX_FORM_ID_BYTES 49
#define MAX_FETCH_BYTES 16
// One option's words, or a multi-select's options joined by ", " (the daemon's own join).
#define MAX_VALUE_BYTES (PRO_ASK_OPTIONS * PRO_OPTION_BYTES)
typedef enum {
    MAX_OUT_READ,       // question.read {agentId: agent, requestId: fetch}
    MAX_OUT_REVIEWED,   // answer.reviewed {agentId: agent, token, requestId: fetch, choices[count]}
    MAX_OUT_ANSWER,     // answer {agentId: agent, requestId: request, answers}: the keys and values are in max_answer_t
    MAX_OUT_FORM,       // form {requestId: fetch, formId: form, op, revision, delta}
} max_out_kind_t;
typedef enum { MAX_FORM_OPEN, MAX_FORM_STATE, MAX_FORM_MOVE, MAX_FORM_ACTIVATE, MAX_FORM_BACK, MAX_FORM_CLOSE } max_form_op_t;
typedef struct {
    max_out_kind_t kind;
    char agent[ID_MAX];
    char fetch[MAX_FETCH_BYTES];
    char request[PRO_TOKEN_BYTES];
    char token[PRO_TOKEN_BYTES];
    uint8_t choices[PRO_ASK_ITEMS];
    int count;
    char form[MAX_FORM_ID_BYTES];
    max_form_op_t op;
    int revision, delta;
} max_out_t;
typedef struct {
    char keys[PRO_ASK_ITEMS][PRO_KEY_BYTES];
    char values[PRO_ASK_ITEMS][MAX_VALUE_BYTES];
    int count;
} max_answer_t;
// The form op's wire name ("open", "move"...).
const char *max_form_op_name(max_form_op_t op);
// Run what the clock owes (a read again, a form's poll, a reply that never came), then hand out up to `cap` queued
// messages, oldest first. An MAX_OUT_ANSWER's keys and values go to `answer` (at most one per take). Returns how many.
int max_ui_take(max_out_t *out, int cap, max_answer_t *answer, uint32_t now_ms);
// A message max_ui_take handed out did not go out: an answer is back to be sent again, a form command failed.
bool max_ui_unsent(const max_out_t *out, uint32_t now_ms);

// ---- the app's own state ----
#define MAX_NOTICE_MS 3000u   // the notice line, as long as the Pro's
// The notice line, for `duration_ms`; NULL or "" clears it.
bool max_ui_notice(const char *text, uint32_t duration_ms, uint32_t now_ms);
typedef enum { MAX_TALK_IDLE, MAX_TALK_RECORDING, MAX_TALK_SENDING } max_talk_t;
bool max_ui_talk(max_talk_t state);
// A firmware update in progress: pct 0..100, or -1 when there is none. `to` is the version being installed.
bool max_ui_update(int pct, const char *to);

// ---- the clock (render task) ----
// True when something drawn depends on the time and has changed (an elapsed counter, a notice that ran out).
bool max_ui_tick(uint32_t now_ms);
// How long the render task may sleep before max_ui_tick has something to do (bounded, at least 1).
uint32_t max_ui_next_wake_ms(uint32_t now_ms);

// ---- drawing (render task) ----
// Draw the model into `scene`, which the caller has cleared. Keeps the hit areas for max_ui_touch.
void max_ui_render(ht_scene_t *scene, uint32_t now_ms);

// ---- the finger (touch task), landscape glass coordinates ----
typedef enum {
    MAX_ACT_NONE,
    MAX_ACT_OPEN,    // a lane was tapped: the room now shows it; send agent.open for agent_id
    MAX_ACT_TALK,    // the room's pet was tapped: record for agent_id (the room's agent)
    MAX_ACT_SEND,    // Send while recording: finish and send (agent_id: the recording's, "" for the form's)
    MAX_ACT_NEW,     // New, under the pager: name a form and open it (max_ui_form_open)
    MAX_ACT_SAY,     // the form's Say: record a spoken name for form_id at revision
    MAX_ACT_CANCEL,  // Cancel while recording: stop and send nothing
} max_act_kind_t;
typedef struct {
    max_act_kind_t kind;
    char agent_id[ID_MAX];
    char form_id[MAX_FORM_ID_BYTES];
    int revision;
} max_act_t;
// One contact at a time: down with the first point, then moves, then up (down false). A tap acts on the lift; a
// sideways swipe turns the page of lanes, or moves the form. Returns what the app must do (most calls: MAX_ACT_NONE);
// a tap on a card's button or the form queues its message in the outbox instead. While a recording is up only its Send
// and Cancel act. Every lift is a person at the bar: for MAX_QUIET_MS no question takes the room.
max_act_t max_ui_touch(bool down, int x, int y, uint32_t now_ms);
void max_ui_touch_cancel(void);

// The room's agent's id, or NULL when there are no agents.
const char *max_ui_selected(void);
