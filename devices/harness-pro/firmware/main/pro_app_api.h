// What pro_cable tells the app. pro_cable parses the daemon's messages and calls these; pro_app (Task 6) implements
// them, and test_pro_cable.c stubs them with a recorder.
//
// EVERY CALL RUNS ON THE cable_link TASK (STACK_CABLE_LINK, 12 KB). A pointer argument is valid only until the call returns:
// copy what must outlive it. A NULL string means "the daemon did not send that field" (an older daemon sends
// less); "" means it sent an empty one. None of these is ever called with a string longer than its stated cap, and
// every cut is on a UTF-8 boundary.
#pragma once
#include <stdbool.h>
#include <stdint.h>

#include "cable/cable_machines.h"   // cable_machine_t
#include "cable/cable_types.h"      // cable_swarm_t, cable_swarm_members_t, cable_tile_t

// ---- caps (bytes, NUL included) ----
#define PRO_VERB_BYTES     128   // turn.started / turn.activity `text`
#define PRO_ACTION_BYTES   192   // turn.activity `action` (the daemon sends at most 188 B)
#define PRO_STEP_BYTES     121   // turn.activity `step`: at most 120 B
#define PRO_RECAP_BYTES    2048  // summary text / recap / full: the Pod recap buffer
#define PRO_QUESTION_BYTES 240   // question prompt
#define PRO_TOAST_BYTES    160   // a toast's line

// ---- link ----
// The session came up (`welcome`) or went down (cable gone, 15 s of silence). `machine` is the cabled computer's name
// (never NULL when up; NULL when down). Called on the transition, and again if a welcome names another computer.
// A drop clears everything the daemon told us: pro_app must forget busy agents, abort a sweep and a recording.
void pro_app_link(bool up, const char *machine);

// ---- roster ----
// `host` is the agent's nearest app ("harness", "orca", ...; NULL when the daemon sent none) and `caps` what the device
// may do with it, the daemon's letters ("svfa": status, voice, focus, answer; "" none of them; NULL when left out,
// which reads as all four).
typedef struct { const char *id, *name, *engine, *machine_id, *machine, *host, *caps; } pro_agent_row_t;
// The complete agent list of the window's tab, once per `agents.end`. Ids are unique and shorter than ID_MAX; at most
// POD_AGENTS_MAX (32) rows; `name` falls back to the id. A list that ends without a begin is dropped.
void pro_app_agents(const pro_agent_row_t *rows, int n);

// ---- apps (the Max says appFilter "v1"; the Pro ignores these) ----
#define PRO_APPS_MAX 16        // the daemon's fixed set of apps
#define PRO_APP_ID_BYTES 17    // an app id: at most 16 bytes, as app.pick takes it
// One app the daemon lists: its id ("orca"), its name ("Orca"), its agents and how many of them wait on the person.
typedef struct { const char *id, *name; int count, waiting; } pro_app_row_t;
// `apps`, sent before each ring to a device that says appFilter: the app whose agents the ring holds (`shown`, "" with
// no agents) and every app with agents, at most PRO_APPS_MAX (extra ones are dropped).
void pro_app_apps(const char *shown, const pro_app_row_t *rows, int n);

// The tab list. `members` is NULL when no tab carried `agentIds` (an older daemon); otherwise members->count[i] and
// ->id[i][k] belong to items[i], and ->meta[i][k].has says whether `members` described that id. At most SWARMS_MAX
// items (extra ones are dropped). `tiles` are the selected tab's grid rectangles from the SAME frame (tile_n may be 0).
// `selected` is NULL when absent. Called for every swarms frame, changed or not.
void pro_app_swarms(const cable_swarm_t *items, int n, const cable_swarm_members_t *members,
                    const char *selected, const cable_tile_t *tiles, int tile_n);

// ---- library ----
// Same layout as pod_library_row_t (pod_glue.h). `machine` is the machine NAME ("" when the machine list does not
// hold the id), `status` one of idle working question finished failed paused offline.
typedef struct { const char *id, *name, *engine, *machine, *status; int32_t age_s; } pro_library_row_t;
// One page of the player library, only for the latest request pro_cable_request_library made (an older reply is
// dropped). A page the parser rejects is not delivered. count is 0..6.
void pro_app_library(const pro_library_row_t *rows, int count, int offset, int total);

// player.context. Parsed and delivered; pro_app ignores it for now (owner decision 4). Strings are "" when absent.
void pro_app_context(const char *id, const char *machine, const char *project, const char *branch, const char *engine);

// ---- turns ----
// kind is one of:
//   "started"  text = the daemon's status line ("" if none), elapsed_s 0
//   "verb"     text = the spinner word (non-empty), elapsed_s -1 (keep the model's)
//   "activity" text = the progress sentence ("" when the frame had only elapsedSeconds), elapsed_s 0..2592000 or -1
//   "step"     text = one tool card (non-empty, <= 120 B), elapsed_s -1
//   "done" / "error"  text "", elapsed_s 0
// `turn.activity` is delivered as verb, then activity, then step, each only when its field is present.
// kind "error": `text` is the failure message (may be ""); the failed turn is filed as an alert.
void pro_app_turn(const char *id, const char *kind, const char *text, int elapsed_s);
// turn.stats, once before turn.done: each count is 0..1000000, or -1 when the message left it out.
void pro_app_turn_stats(const char *id, int tests_passed, int tests_failed, int commits, int tokens_in, int tokens_out);

// `text` and `recap` are NULL when absent, `full` is NULL from a daemon without recap=long-v1.
// `tier`: how loud a live turn's end is (see pod_tier_t; a `restore` is never news, whatever it says): alert files an unread
// entry, shows the banner and beeps (one beep per POD_BEEP_COALESCE_MS), list only files the entry, silent files nothing.
// The recap itself is applied either way.
void pro_app_summary(const char *id, const char *text, const char *recap, const char *full, bool restore, pod_tier_t tier);

// ---- notifications ----
// notif.replace: the whole unread list (the daemon sends it on greeting; at most 8 items, one per agent). Strings are never
// NULL ("" when absent); token is "" without one (and only ever a valid readToken, [A-Za-z0-9_-]{1,63}). No banner, no beep.
typedef struct { const char *agent_id, *name, *summary, *token; } pro_notif_row_t;
void pro_app_notif_replace(const pro_notif_row_t *rows, int n);
// notif.seen: read elsewhere. token is NULL without one.
void pro_app_notif_seen(const char *id, const char *token);

// request is the question's request id: with the prompt it tells a re-sent question from a new one.
void pro_app_question(const char *id, const char *request, const char *text);
void pro_app_question_close(const char *id);

// ---- answering on the device (the Max answers; the Pro ignores these) ----
#define PRO_ASK_ITEMS    4     // questions in one request: the daemon's inbox takes 1..4
#define PRO_ASK_OPTIONS  6     // options of one question: 1..6
#define PRO_OPTION_BYTES 96    // an option as shown; the reviewed answer names it by its index, never by its words
#define PRO_KEY_BYTES    256   // a question's key, the Dial's cap: the plain answer echoes it, so it is kept only whole
#define PRO_TOKEN_BYTES  64    // a request id or an answer token: the daemon refuses a requestId over 64
// One question of a request, as the daemon's inbox takes it: a key, a prompt and 1..6 non-empty options. `key` is NULL
// when longer than PRO_KEY_BYTES - 1. `whole`: the key and every option arrived uncut, so a plain answer can echo them.
typedef struct {
    const char *key, *q;
    const char *options[PRO_ASK_OPTIONS];
    int option_count;
    bool multi, whole;
} pro_ask_item_t;
// The same `question` as pro_app_question, right after it, with its questions. n is 0 when the request is not one the
// daemon's inbox would hold (no questions, more than 4, one without a key, a prompt or options, a key twice).
// permission: the daemon marks it a permission prompt (`permission: true`), answered by approving or denying.
void pro_app_ask(const char *id, const char *request, const char *text, const pro_ask_item_t *items, int n,
                 bool permission);
// question.state, the reply to pro_cable_question_read. `fetch` is the requestId that read sent. ok: `request` and
// `token` are under PRO_TOKEN_BYTES and n is 1..4; submitted: an answer is in already. Not ok: `error` is the daemon's
// words (NULL when it sent none, or the reply was malformed), and request, token and items are NULL.
void pro_app_question_state(const char *id, const char *fetch, bool ok, const char *request, const char *token,
                            bool submitted, const char *error, const pro_ask_item_t *items, int n);
// answer.receipt, the reply to pro_cable_answer_reviewed. pending: taken, not yet confirmed by the terminal. Not ok:
// `error` is the daemon's words (NULL when none).
void pro_app_answer_receipt(const char *id, const char *fetch, const char *token, bool ok, bool pending,
                            const char *error);

// ---- New Harness (the Max opens the desktop's form; the Pro ignores these) ----
// A page of the form, as the desktop bounds it. Strings are never NULL ("" when absent). When `active`, revision,
// position and total are 0..INT32_MAX and busy and enabled were sent; otherwise the numbers are 0.
typedef struct {
    const char *title, *label, *detail, *previous, *next, *error, *status, *action, *query;
    int32_t revision, position, total;
    bool active, busy, enabled, can_query;
} pro_form_page_t;
// form.state, the reply to pro_cable_form. ok && !active: the form closed (started, or backed out of).
void pro_app_form_state(const char *request, const char *form_id, bool ok, const pro_form_page_t *page);
// voice.form, the reply to a recording pro_cable_voice_form aimed at a form's field.
void pro_app_voice_form(const char *form_id, bool ok, const pro_form_page_t *page);
// toast: a line the daemon wants shown (an answer it could not take, say).
void pro_app_toast(const char *text);

// The daemon's surface moved to this agent.
void pro_app_focus(const char *id);

// ---- voice ----
enum { PRO_VOICE_OK = 0, PRO_VOICE_ERROR = 1 };
// The reply to the recording pro_cable_voice_begin started (a reply for another upload id is dropped).
// PRO_VOICE_OK: `text` is the agent id it was routed to ("" if none). pro_cable already sent voice.confirm when the
// daemon asked for one. PRO_VOICE_ERROR: `text` is the daemon's message ("" if none). Either ends the voice state.
void pro_app_voice_result(int kind, const char *text);

// ---- machines ----
// The machine list as applied (after `machines.end` or a `machine.updated` that changed a row), only when it
// differs from the last one; count 0 with selected "" when the session ends. `selected` is never NULL.
void pro_app_machines(const cable_machine_t *rows, int count, const char *selected);

// ---- settings ----
// Put a brightness (0..255, what config_store keeps) on the panel. The caller stores it.
void pro_app_set_brightness(uint8_t level);

// ---- firmware update (pro_cable -> pro_app) ----
// The offer's "busy" decision and the updating flag in one step, atomic with respect to a voice start: false when a voice
// start or recording is open (decline the offer), else true with voice held off from now on. Pair a refusal that left
// nothing in flight with pro_app_end_update_gate (no screen, no notice).
bool pro_app_begin_update_gate(void);
void pro_app_end_update_gate(void);
// After fw_confirm_*: if this boot is the first of an update, say "Updated to X.Y.Z" once the cable is up.
void pro_app_note_update(void);
