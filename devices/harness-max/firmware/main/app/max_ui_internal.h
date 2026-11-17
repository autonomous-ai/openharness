// What the max_ui_*.c files share: the one model, the layout and the helpers. Private to them and their host tests.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "max_ui.h"

// The lanes the screen can hold: pro_app_agents sends at most POD_AGENTS_MAX (32) rows.
#define MAX_AGENTS 32
#define MAX_STEPS 3                 // the tool steps a lane shows, newest first
#define MAX_VERB_BYTES 48           // the spinner word stands in for "Working": one short word
#define MAX_ACTIVITY_BYTES PRO_ACTION_BYTES
#define MAX_STEP_BYTES PRO_STEP_BYTES
#define MAX_QUESTION_BYTES PRO_QUESTION_BYTES
#define MAX_NOTE_BYTES 512          // a failure's message or a summary's text: six lane rows of Vietnamese
#define MAX_NOTICE_BYTES PRO_TOAST_BYTES   // a toast is the longest line the daemon asks the bar to show
#define MAX_ERROR_BYTES 180               // the daemon's words for a refusal (the form's error is its longest)
#define MAX_VERSION_BYTES 24
#define MAX_DONE_MS 60000u          // how long a finished turn's summary stays on its lane
#define MAX_WAKE_MS 60000u          // the render task's longest sleep when nothing drawn depends on the time
#define MAX_QUIET_MS 20000u         // a tap or swipe this recent means a person is at the bar: a new question waits
#define MAX_TOAST_MS 5000u          // a question that waits is announced this long, as the Pro's toast

// The glass, 1920 x 480 at about 225 ppi (8.86 px a mm), or the demo bar's 1920 x 415. Columns, left to right: the
// rail (the machines), the room (one agent, large) and the lanes (the others, up to four a page sharing their width,
// MAX_LANE_GAP apart). The room and the lanes stand on one row; the band under the lanes holds the page dots. Heights
// are drawn for 480 and scaled by MAX_Y; the text keeps its size.
#define MAX_Y(px) ((px) * HT_HEIGHT / 480)
enum {
    MAX_RAIL_X = 22, MAX_RAIL_W = 220,                                  // rail 22..242
    MAX_ROOM_X = 260, MAX_ROOM_W = 800,                                 // room 260..1060
    MAX_LANE_X = 1074, MAX_LANES_W = HT_WIDTH - MAX_RAIL_X - MAX_LANE_X,   // lanes 1074..1898
    MAX_LANES = 4, MAX_LANE_GAP = 14,
    MAX_CARD_Y = MAX_Y(20), MAX_CARD_H = MAX_Y(440),                    // the room and the lanes: 20..460 (17..397 at 415)
    MAX_BAND_Y = MAX_CARD_Y + MAX_CARD_H,                               // the page dots under the lanes
    MAX_TAP_SLOP = 24,                       // px, as the Pro's POD_TAP_SLOP: farther from the DOWN is a drag
    MAX_SWIPE_PX = 80,                       // a sideways drag this long turns the page
    MAX_BUTTON_H = MAX_Y(80),                // a button: 80 px at 480 (9 mm), 69 at 415
};

// ---- a question being answered (max_ui_ask.c) ----
// How it is answered: on the computer only (no questions the inbox holds, or words too long to echo), in the agent's
// own app (a shown-only permission prompt), with a plain `answer`, or read whole and answered by reviewed choices.
typedef enum { MAX_PATH_NONE, MAX_PATH_SHOWN, MAX_PATH_PLAIN, MAX_PATH_REVIEWED } max_path_t;
// READING: question.read sent, its state awaited; READY: the person chooses; SENDING: the answer is out, its receipt
// awaited; SENT: taken (pending, or in already); FAILED: `note` says why.
typedef enum { MAX_ASK_READING, MAX_ASK_READY, MAX_ASK_SENDING, MAX_ASK_SENT, MAX_ASK_FAILED } max_phase_t;
#define MAX_READS 3                 // question.read tries, MAX_READ_MS apart, before the card says there was no reply
#define MAX_READ_MS 2000u
#define MAX_RECEIPT_MS 10000u       // an answer.reviewed's receipt: longer, and the card says so
typedef struct {
    char key[PRO_KEY_BYTES];        // "" when too long to echo: then no plain answer
    char q[MAX_QUESTION_BYTES];
    char options[PRO_ASK_OPTIONS][PRO_OPTION_BYTES];
    uint8_t option_count;
    bool multi, whole;
} max_item_t;
typedef struct {
    char agent[ID_MAX];             // "" = a free slot
    char request[PRO_TOKEN_BYTES];  // the question's id
    max_item_t items[PRO_ASK_ITEMS];
    uint8_t count, step;            // the questions; the one on the card
    uint8_t choices[PRO_ASK_ITEMS]; // an option mask per question
    max_path_t path;
    max_phase_t phase;
    bool permission;                // the daemon marked it a permission prompt: approve or deny
    char app[CABLE_NAME_MAX];       // SHOWN: the app to answer it in ("" when the prompt did not say)
    char token[PRO_TOKEN_BYTES];    // REVIEWED: question.state's, for the answer
    char fetch[MAX_FETCH_BYTES];    // REVIEWED: our requestId for the read and the answer
    uint32_t due;                   // READING: the next read; SENDING (reviewed): the receipt's deadline
    uint8_t reads;
    char note[MAX_ERROR_BYTES];     // FAILED: why; SENT: what the daemon said
} max_ask_t;

// ---- New Harness (max_ui_form.c), after the Dial's form.c ----
#define MAX_FORM_WAIT_MS 3500u      // a command's reply; the desktop gives up at 2 s
#define MAX_FORM_POLL_MS 1000u      // the page read again while it is up; MAX_FORM_BUSY_MS while the desktop works
#define MAX_FORM_BUSY_MS 300u
#define MAX_FORM_MOVES 8            // the desktop's largest move
typedef struct {
    char title[80], label[160], detail[384], previous[96], next[96], error[MAX_ERROR_BYTES], status[96], action[32],
         query[240];
    int32_t revision, position, total;
    bool active, busy, enabled, can_query;
} max_page_t;
typedef struct {
    char id[MAX_FORM_ID_BYTES];     // "" = no form
    max_page_t page;
    bool pending, failed;           // a command awaits its reply; the form ended in an error (page.error)
    max_form_op_t pending_op;
    uint32_t serial, request, deadline, poll;
    int queued;                     // moves asked for while a command was out, -8..8
} max_form_t;

// ---- what the finger can hit, besides the lanes ----
typedef enum {
    MAX_HIT_OPTION,      // arg: the option on the card's question
    MAX_HIT_SEND,        // a multi-select's Send (or Next before the last question)
    MAX_HIT_STEP_BACK,   // the question before
    MAX_HIT_RELOAD,      // read the question again after a failure
    MAX_HIT_DISMISS,     // a finished or failed turn's card
    MAX_HIT_NEW,         // New Harness, on the rail
    MAX_HIT_FORM_MOVE,   // arg: -1 the choice before, +1 the one after
    MAX_HIT_FORM_PICK,   // the focused choice, or the action button: activate
    MAX_HIT_FORM_BACK,
    MAX_HIT_FORM_CLOSE,
    MAX_HIT_FORM_RETRY,  // a failed form: open a new one
    MAX_HIT_TALK,        // the room's pet and its Tap to talk: record for the room's agent
    MAX_HIT_TALK_SEND,   // the room's Send while recording
    MAX_HIT_TALK_CANCEL, // the room's Cancel while recording: nothing is sent
    MAX_HIT_TOAST,       // the toast: the room opens its agent (toast_id)
    MAX_HIT_FORM_SAY,    // the form's Say, while max_form_can_say(): a spoken name for its field
} max_hit_kind_t;
typedef struct {
    int16_t x, y, w, h;
    uint8_t kind;
    int8_t arg;
} max_hit_t;
#define MAX_HITS 16

typedef enum { MAX_IDLE, MAX_WORKING, MAX_ASKING, MAX_DONE, MAX_FAILED } max_state_t;

typedef struct {
    char id[ID_MAX], name[CABLE_NAME_MAX], engine[12], machine_id[MACHINE_ID_MAX], machine[CABLE_NAME_MAX];
    max_state_t state;
    // The turn's elapsed time: clock_s seconds at clock_ms while the turn runs (working or asking), the final count
    // once it ended. clock: known (a turn.started or an activity with elapsedSeconds was seen).
    bool clock;
    uint32_t clock_s, clock_ms;
    char verb[MAX_VERB_BYTES], activity[MAX_ACTIVITY_BYTES];
    char steps[MAX_STEPS][MAX_STEP_BYTES];
    uint8_t step_count;
    char question[MAX_QUESTION_BYTES];
    uint32_t ask_key;                // the open question's request, prompt and questions: a re-sent one is no change
    uint32_t ask_since;              // when the open question arrived: the room takes the oldest first
    char note[MAX_NOTE_BYTES];       // FAILED: the error; DONE: the summary's text, shown until note_until
    uint32_t note_until;
    bool card;                       // a failure opens a card until dismissed; an alert's summary, until it runs out
} max_agent_t;

typedef struct {
    int16_t x, y, w, h;
} max_box_t;

typedef struct {
    bool link;
    char computer[CABLE_NAME_MAX];
    max_agent_t agents[MAX_AGENTS];  // roster order
    int count;
    cable_machine_t machines[CABLE_MAX_MACHINES];
    int machine_count;
    max_ask_t asks[MAX_AGENTS];      // the open questions, one an agent, by agent id
    uint32_t ask_serial;             // names the reads (max_ask_t fetch)
    bool offers_form;                // the welcome offered `form`: New is on the rail
    max_form_t form;
    max_out_t outbox[MAX_OUTBOX];    // queued for the app to send (max_ui_take)
    int out_count;
    char selected[ID_MAX];           // the room's agent, "" = none; the lanes show the others
    bool touched;                    // a tap or swipe at touched_ms: a person is at the bar for MAX_QUIET_MS
    uint32_t touched_ms;
    char toast_id[ID_MAX];           // a question that arrived while a person was at the bar, announced from toast_from
    uint32_t toast_from;
    int page;                        // the page of lanes shown, 0-based, always within max_ui_pages()
    char notice[MAX_NOTICE_BYTES];
    uint32_t notice_until;
    max_talk_t talk;
    char talk_id[ID_MAX];            // the agent the recording is for (set when the room's pet starts it; "": Say's)
    int update_pct;                  // -1: no update
    char update_to[MAX_VERSION_BYTES];
    // What the last render drew, for the finger and the clock.
    max_box_t lane_box[MAX_LANES];
    char lane_id[MAX_LANES][ID_MAX];
    int lane_hits;
    max_hit_t hits[MAX_HITS];        // the card's buttons, New, the form's choices
    int hit_count;
    char card_id[ID_MAX];            // the room's agent as drawn, for its card's buttons ("" = none)
    uint32_t card_key;               // its question and step as drawn: a tap on a card that changed since does nothing
    int32_t form_revision;           // the form's page as drawn
    uint32_t drawn_key;              // max_ui_time_key at the last render
    bool dirty;                      // the finger changed what is shown (a page, a selection): draw again
    // The contact in progress.
    bool down, moved;
    int down_x, down_y;
} max_model_t;

extern max_model_t max_m;

// Copy src (NULL reads as "") into dst[cap]: cut on a UTF-8 code point, control characters as spaces.
void max_copy(char *dst, size_t cap, const char *src);
// max_copy for a name the screen shows: one that does not fit ends in an ellipsis, so a cut word never reads as whole.
void max_copy_label(char *dst, size_t cap, const char *src);
max_agent_t *max_find(const char *id);
// The roster's indices in lane order: needs a person (asking, failed), then working, then the rest; roster order in
// each group, so the order moves only when a state does. Returns the count.
int max_order(int out[MAX_AGENTS]);
// The pages of lanes: every agent but the room's, MAX_LANES a page.
int max_pages(void);
// Keep the page within the pages there are.
void max_clamp_page(void);
// The room shows this agent ("" for none) and the lanes the others. True when it changed. Nothing is sent: the finger
// sends agent.open itself.
bool max_room_show(const char *id);
// A new question from this agent (ask_since set): with nobody at the bar it takes the room, unless the room's agent
// asks itself; with a person there the room stays, and the toast announces it.
void max_room_asks(const max_agent_t *, uint32_t now_ms);
// The room's agent's answer left the bar (a tap that sent it, or a recording sent for it): the room moves on to the
// question that has waited longest, or stays to show the agent at work when none waits. True when it moved.
bool max_room_answered(const char *id);
// The seconds a lane's clock shows at now_ms, or -1 when it shows none.
int64_t max_secs(const max_agent_t *, uint32_t now_ms);
// Whether a finished lane still shows its summary, and the notice is up.
bool max_note_shown(const max_agent_t *, uint32_t now_ms);
bool max_notice_shown(uint32_t now_ms);
// A digest of everything drawn that depends on the time (the clocks of the room and the lanes shown, a summary or a
// notice running out).
uint32_t max_time_key(uint32_t now_ms);
// "m:ss" under an hour, else "h:mm:ss"; "" for a negative count.
void max_fmt_elapsed(char *out, size_t cap, int64_t secs);
// FNV-1a over n bytes, from h (2166136261u to start).
uint32_t max_fnv(uint32_t h, const void *data, size_t n);
// The lanes on the page shown, as roster indices, in max_order() without the room's agent. Returns how many.
int max_visible(int out[MAX_LANES]);
bool max_notice_set(const char *text, uint32_t now_ms);   // for MAX_NOTICE_MS
// A state change, with the turn's clock (stopped at the end of a turn, dropped when one we did not see start begins).
void max_set_state(max_agent_t *, max_state_t st, uint32_t now_ms);

// The toast is up: toast_id still asks, for MAX_TOAST_MS from toast_from.
bool max_toast_shown(uint32_t now_ms);
// The room's pet takes voice for this agent: the link is up, nothing is recorded or sent, no form is up, and the agent
// is neither on a permission prompt (Yes or No only) nor waiting on an answer that is on its way or in.
bool max_can_talk(const max_agent_t *);

// ---- questions (max_ui_ask.c) ----
max_ask_t *max_ask_of(const char *agent);
void max_ask_drop(const char *agent);
// Whether the room shows the agent's card: a question, a failure not yet dismissed, or an alert's summary while it shows.
bool max_has_card(const max_agent_t *, uint32_t now_ms);
// What a tap on the card must match (the question, its step, its phase).
uint32_t max_card_key(const max_agent_t *);
// How a permission prompt's option reads, by the daemon's own words for them (questionPane.ts APPROVE_RE, REJECT_RE):
// the card gives a yes and a no their colours.
bool max_option_approves(const char *option);
bool max_option_rejects(const char *option);
// The finger on a card: an option, Send, the question before, Reload, Dismiss.
bool max_ask_hit(max_agent_t *, max_hit_kind_t kind, int arg, uint32_t now_ms);
void max_ask_due(uint32_t now_ms);
uint32_t max_ask_wake(uint32_t now_ms, uint32_t ms);
// The outbox's side of an answer: a plain one handed out (its words into `answer`), or one that did not go out.
bool max_ask_taken(const max_out_t *, max_answer_t *answer, uint32_t now_ms);
bool max_ask_unsent(const max_out_t *, uint32_t now_ms);

// ---- the outbox ----
max_out_t *max_out_push(max_out_kind_t kind);   // NULL when full

// ---- New Harness (max_ui_form.c) ----
bool max_form_open(void);                       // a form is up
bool max_form_command(max_form_op_t op, int delta, uint32_t now_ms);
bool max_form_dismiss(void);
void max_form_due(uint32_t now_ms);
uint32_t max_form_wake(uint32_t now_ms, uint32_t ms);
void max_form_reset(void);
bool max_form_unsent(const max_out_t *, uint32_t now_ms);
// The form takes a spoken name now: an open, current page that can be queried.
bool max_form_can_say(void);
