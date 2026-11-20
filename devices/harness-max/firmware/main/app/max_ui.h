// Harness Max's screen in pure C: the pages model (docs/superpowers/specs/2026-11-18-harness-max-v2-design.md), fed from
// the cable's callbacks, drawn into a scene, and the finger turned into what the app must do. No ESP-IDF and no lock: max_app.c holds its own lock around every call, so the host
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

// A fresh model: link down (Ambient says so), no agents, an empty Inbox, no notice, no update.
void max_ui_reset(void);
// The scripted demo daemon drives the bar (linux/main.c --demo): each time the link comes up and its first ring has
// nothing at work or waiting, Ambient comes at once, and its first tap opens Apps (V3 restNow(wakeToApps)). The
// program's mode: set before the app starts, kept over max_ui_reset.
void max_ui_demo(bool on);

// ---- feeds (the cable_link task, through max_app.c) ----
bool max_ui_link(bool up, const char *machine, uint32_t now_ms);
bool max_ui_agents(const pro_agent_row_t *rows, int n, uint32_t now_ms);
bool max_ui_machines(const cable_machine_t *rows, int count, const char *selected);
// kind and text as pro_app_turn (pro_app_api.h).
bool max_ui_turn(const char *id, const char *kind, const char *text, int elapsed_s, uint32_t now_ms);
// An agent asks: `text` is the prompt, `items` the request's questions as pro_app_ask has them (n 0: the daemon's summary
// frame, its words alone). `permission`: the daemon marked it a permission prompt. `review`: the daemon offers
// question.review, so every question is read whole first (question.read) and answered by answer.reviewed; otherwise a
// question whole is answered by a plain `answer`, and one with no options only on the computer.
bool max_ui_question(const char *id, const char *request, const char *text, const pro_ask_item_t *items, int n,
                     bool permission, bool review, uint32_t now_ms);
// The same, filed quietly: a question the daemon told the bar before, back as a `tier: "list"` row. Its agent asks,
// with no Attention and no toast; its Inbox notice keeps its place and whether it was read.
bool max_ui_question_quiet(const char *id, const char *request, const char *text, const pro_ask_item_t *items, int n,
                           bool permission, bool review, uint32_t now_ms);
// Either, as pro_app_ask has it, with the frame's agent name: an agent off the ring is filed under it. A question of an
// agent off the ring waits for it (it asks quietly when it joins), its notice in Inbox meanwhile.
bool max_ui_question_from(const char *id, const char *name, const char *request, const char *text,
                          const pro_ask_item_t *items, int n, bool permission, bool review, bool quiet, uint32_t now_ms);
// notif.replace's rows, the drawer replaced whole. A question row makes its ring agent ask that question, quietly (one
// that asks keeps its own); one of an agent off the ring waits for it, as above; news rows file nothing (Inbox keeps
// the bar's own turns). `review` as max_ui_question.
bool max_ui_notices(const pro_notif_row_t *rows, int n, bool review, uint32_t now_ms);
bool max_ui_question_close(const char *id);
// The replies of the reviewed path, as pro_app_question_state and pro_app_answer_receipt.
bool max_ui_question_state(const char *id, const char *fetch, bool ok, const char *request, const char *token,
                           bool submitted, const char *error, const pro_ask_item_t *items, int n, uint32_t now_ms);
bool max_ui_answer_receipt(const char *id, const char *fetch, const char *token, bool ok, bool pending,
                           const char *error, uint32_t now_ms);
bool max_ui_summary(const char *id, const char *text, const char *recap, bool restore, pod_tier_t tier,
                    uint32_t now_ms);
// The computer's window moved to this agent. Not a person at the bar: the page shown stays.
bool max_ui_focus(const char *id);
// `apps` (pro_app_apps): the shown app and every app with agents. Before the ring it names. Harness is listed first, and
// added when it is shown and the list leaves it out (the window's tab). The computer turning the bar to another app
// shows "Following <App> on your Mac", unless it is the first list, the app picked here, or a person talks.
bool max_ui_apps(const char *shown, const pro_app_row_t *rows, int n, uint32_t now_ms);
// The person picked this app on Apps (MAX_ACT_PICK): the `apps` that shows it is their doing, not the computer's.
void max_ui_app_picked(const char *app);
// What rang since the last take, for the app's chime and wake: a question (one the bar was not told before), a failed
// turn, a loud finished turn. Quiet filings (a list row, the drawer's rows) ring nothing.
enum { MAX_NEWS_ASK = 1u << 0, MAX_NEWS_FAILED = 1u << 1, MAX_NEWS_DONE = 1u << 2 };
unsigned max_ui_take_news(void);

// ---- New Harness ----
// The welcome offers `form`: Apps shows "+ New". Read on every tick: a daemon restarted inside a session
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
// The recorder's state, read by the app on every tick and after every voice call. Entering RECORDING starts the
// recording's clock and its listening (max_ui_level).
bool max_ui_talk(max_talk_t state, uint32_t now_ms);
// The daemon's reply to a send, as the Pro's pro_app_voice_result. ok: the words went to agent_id ("" none known),
// which shows Working until its turn speaks (or MAX_SENT_WAIT_MS); its page stays on the SEND scene until that turn
// begins. Not ok: the page lets the send go at once (the app puts the daemon's words up). True when the screen changed.
bool max_ui_voice_result(bool ok, const char *agent_id, uint32_t now_ms);
// The local wall clock, once a tick: known false where the device has none (an ESP32 the daemon never set). Hour 0..23,
// minute 0..59, weekday 0..6 from Sunday, day of the month 1..31, month 0..11. True when the minute shown changed.
bool max_ui_wall(bool known, int hour, int min, int wday, int mday, int mon);
// The mic's envelope while recording, 0..4 (pro_rec_level), once a tick: the band's waveform and the listening.
bool max_ui_level(unsigned level, uint32_t now_ms);
// A firmware update in progress: pct 0..100, or -1 when there is none. `to` is the version being installed.
bool max_ui_update(int pct, const char *to);

// ---- the clock (render task) ----
// True when something drawn depends on the time and has changed (an elapsed counter, a notice that ran out).
bool max_ui_tick(uint32_t now_ms);
// How long the render task may sleep before max_ui_tick has something to do (bounded, at least 1).
uint32_t max_ui_next_wake_ms(uint32_t now_ms);

// ---- the glass at rest (render task) ----
// What a motion the finger can start next will paint, painted ahead off the glass while App Detail's row rests (no
// finger on it, no overlay over it, nothing of it moving): the open agent's close first, then each agent's open from
// its cell or sliver, every one's first frames first, so whichever comes first starts warm. Under the lock, a frame of
// one a call (a fraction of the glass's frame), painting nothing: what it needs is made by max_ui_warm_paint. Leaves
// the model as it was and draws nothing on the glass. True while there is more to paint: call max_ui_warm_paint, then
// this again, while the render task has nothing else to do.
bool max_ui_warm(uint32_t now_ms);
// Out of the lock (it reads none of the model), on the render task: the image, layer or pet frame's bake the last
// max_ui_warm needs made a band of rows at a time while go_on() says so (at least one band). False when nothing was
// owed (then max_ui_warm is next).
bool max_ui_warm_paint(bool (*go_on)(void));
// Under the lock: whether the row rests, so painting ahead may go on (max_ui_warm_paint's work waits while it moves:
// the glass's own frames come first).
bool max_ui_warm_rests(uint32_t now_ms);

// ---- drawing (render task) ----
// Draw the model into `scene`, which the caller has cleared. Keeps the hit areas for max_ui_touch.
void max_ui_render(ht_scene_t *scene, uint32_t now_ms);
// Its blurs (the pets and edges of App Detail's moving agents) kept from max_ui_render for the frame path to share
// between its cores (true) or done in it (false, the default). Shared, each task that paints the scene's strips calls
// max_ui_work (0 the render task, 1 the other) before it paints any: it takes the next blur nobody has until none is
// left, then returns once the other task's last is done too. A scene shown before its blurs are done shows garbage.
void max_ui_share(bool on);
void max_ui_work(int worker);

// ---- the finger (touch task), landscape glass coordinates ----
typedef enum {
    MAX_ACT_NONE,
    MAX_ACT_OPEN,       // bring agent_id up on the computer: send agent.open (no recording)
    MAX_ACT_TALK,       // record for agent_id (its page is up already)
    MAX_ACT_SEND,       // finish the recording and send it (agent_id: the recording's, "" for the form's)
    MAX_ACT_NEW,        // New Harness: name a form and open it (max_ui_form_open)
    MAX_ACT_SAY,        // the form's Say: record a spoken name for form_id at revision
    MAX_ACT_CANCEL,     // stop the recording and send nothing
    MAX_ACT_OPEN_TALK,  // a cell's one tap: agent.open for agent_id; max_ui_talk_due records for it a moment later
    MAX_ACT_PICK,       // an app was picked on Apps: send app.pick for `app`
} max_act_kind_t;
typedef struct {
    max_act_kind_t kind;
    char agent_id[ID_MAX];
    char form_id[MAX_FORM_ID_BYTES];
    int revision;
    char app[PRO_APP_ID_BYTES];
} max_act_t;
// One contact at a time: down with the first point, then moves, then up (down false). A tap acts on the lift; a
// sideways swipe scrolls App Detail's row of cells, or moves the form. Returns what the app must do (most calls:
// MAX_ACT_NONE); a tap on an answer or the form queues its message in the outbox instead.
// Every lift is a person at the bar (idle_from: Ambient waits for them).
max_act_t max_ui_touch(bool down, int x, int y, uint32_t now_ms);
void max_ui_touch_cancel(void);

// What the clock owes the recording (render task, every tick while recording, or while a cell's tap waits to open the
// mic: MAX_ACT_TALK MAX_TALK_DELAY_MS after it, its page still up): MAX_ACT_SEND at MAX_TALK_MAX_MS (to Overview, as a
// tap on the page), never for the quiet after speech; MAX_ACT_CANCEL when nothing was heard in MAX_HEAR_MS (the page
// stays and says the mic closed), or when its agent left the ring, heard or not; else MAX_ACT_NONE. A finger on the
// glass then acts on nothing. The app acts on it as on the finger's.
max_act_t max_ui_talk_due(uint32_t now_ms);

// The agent page's (or Attention's) agent id, or NULL when neither is up.
const char *max_ui_selected(void);
