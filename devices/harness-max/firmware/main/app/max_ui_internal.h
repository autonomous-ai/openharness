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
#define MAX_TOAST_MS 5000u          // what needs a person who is talking is announced this long, as the Pro's toast

// The glass, 1920 x 480 at about 225 ppi (8.86 px a mm), or the demo bar's 1920 x 415. Columns, left to right, on one
// row 22 px from the glass's ends: the room (one agent, large), the lanes (the others, up to three a page sharing their
// width, MAX_LANE_GAP apart) and the side column (the pager over New Harness). Heights are drawn for 480 and scaled by
// MAX_Y; the text keeps its size.
#define MAX_Y(px) ((px) * HT_HEIGHT / 480)
enum {
    MAX_ROOM_X = 22, MAX_ROOM_W = 820,                                  // room 22..842
    MAX_LANE_X = 858, MAX_LANES_W = 928,                                // lanes 858..1786: three of 300
    MAX_LANES = 3, MAX_LANE_GAP = 14,
    MAX_SIDE_X = MAX_LANE_X + MAX_LANES_W + 16, MAX_SIDE_W = HT_WIDTH - MAX_ROOM_X - MAX_SIDE_X,   // side 1802..1898
    MAX_CARD_Y = MAX_Y(20), MAX_CARD_H = MAX_Y(440),                    // every column: 20..460 (17..397 at 415)
    MAX_TAP_SLOP = 24,                       // px, as the Pro's POD_TAP_SLOP: farther from the DOWN is a drag
    MAX_SWIPE_PX = 80,                       // a sideways drag this long turns the page
    MAX_BUTTON_H = MAX_Y(80),                // a button: 80 px at 480 (9 mm), 69 at 415
};

// ---- Demo V2: the pages (docs/superpowers/specs/2026-11-18-harness-max-v2-design.md) ----
typedef enum { MAX_VIEW_OVERVIEW, MAX_VIEW_AGENT, MAX_VIEW_ATTENTION, MAX_VIEW_INBOX, MAX_VIEW_APPS, MAX_VIEW_AMBIENT } max_view_t;
// Why Attention is up: a question, or a turn that ended loud.
typedef enum { MAX_ATTN_ASK, MAX_ATTN_DONE, MAX_ATTN_FAIL } max_attn_t;
// pro_agent_row_t.caps as bits: no letters string (NULL) is all of them, as the dial reads it.
enum { MAX_CAP_VOICE = 1, MAX_CAP_FOCUS = 2, MAX_CAP_ANSWER = 4, MAX_CAPS_ALL = 7 };
#define MAX_CELLS 5                 // agents on one page of Overview
#define MAX_SEGS 6                  // agents on the agent page's strip
#define MAX_INBOX 12                // notices kept, newest first
#define MAX_LEVELS 48               // the band's waveform: the mic's last levels, a tick each
#define MAX_SPEECH_LEVEL 2          // a level at least this is speech (pro_rec_level: 0..4)
#define MAX_HEAR_MS 4000u           // nothing heard this long after the mic opened: it closes
#define MAX_SILENCE_MS 1600u        // quiet this long after speech: the recording is sent
#define MAX_AMBIENT_MS 60000u       // nobody touched and nothing works or waits this long: Ambient
#define MAX_ATTN_END_MS 8000u       // a done or failed turn's Attention goes back to Overview after this
#define MAX_TALK_FRAME_MS 100u      // the band redraws this often while recording
#define MAX_EDGE_FRAME_MS 83u       // the edge light moves this often while Attention is up
typedef struct {
    char id[PRO_APP_ID_BYTES], name[CABLE_NAME_MAX];
    int count, waiting;
} max_app_t;
// A notice in Inbox: who, from which app, why, and its words, kept after the agent leaves the ring.
typedef struct {
    char id[ID_MAX], name[CABLE_NAME_MAX], engine[12], app[CABLE_NAME_MAX];
    max_attn_t kind;
    char text[MAX_QUESTION_BYTES];
    uint32_t at;
    bool unread;
} max_inbox_t;

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
    MAX_HIT_NEW,         // New Harness, at the foot of the side column
    MAX_HIT_FORM_MOVE,   // arg: -1 the choice before, +1 the one after
    MAX_HIT_FORM_PICK,   // the focused choice, or the action button: activate
    MAX_HIT_FORM_BACK,
    MAX_HIT_FORM_CLOSE,
    MAX_HIT_FORM_RETRY,  // a failed form: open a new one
    MAX_HIT_TALK,        // the room's pet and its Tap to talk: record for the room's agent
    MAX_HIT_TALK_SEND,   // the room's Send while recording
    MAX_HIT_TALK_CANCEL, // the room's Cancel while recording: nothing is sent
    MAX_HIT_TOAST,       // the toast: Attention for its agent (toast_id, toast_attn)
    MAX_HIT_FORM_SAY,    // the form's Say, while max_form_can_say(): a spoken name for its field
    MAX_HIT_PAGE,        // the pager: the next page of lanes, the first after the last
    // Demo V2's pages:
    MAX_HIT_BACK,        // the agent page's Back: to Overview (a recording with words is sent, else cancelled)
    MAX_HIT_SEG,         // arg: a strip segment (seg_id): show that agent, mic closed (a recording as Back)
    MAX_HIT_BODY,        // the agent page's body: record (mic closed), or send now (recording)
    MAX_HIT_BELL,        // Overview's bell: Inbox
    MAX_HIT_APPS,        // Overview's app column: Apps (only drawn as a hit when there is another app)
    MAX_HIT_APP,         // arg: an app card on Apps (index in apps[]): pick it
    MAX_HIT_NOTE,        // arg: an Inbox card (index in inbox[])
    MAX_HIT_CLOSE,       // Inbox's or Apps' Close: Overview
    MAX_HIT_SAY_IT,      // Attention's Say it: the agent page with the mic open
    MAX_HIT_AWAY,        // Attention outside its buttons: bring the agent up on the computer, Overview
    MAX_HIT_WAKE,        // Ambient: Overview
} max_hit_kind_t;
typedef struct {
    int16_t x, y, w, h;
    uint8_t kind;
    int8_t arg;
} max_hit_t;
#define MAX_HITS 48

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
    uint32_t ask_since;              // when the open question arrived: Attention takes the oldest first
    char note[MAX_NOTE_BYTES];       // FAILED: the error; DONE: the summary's text, shown until note_until
    uint32_t note_until;
    bool card;                       // a failure's card lasts until the agent moves on; an alert's, until it runs out
    char host[PRO_APP_ID_BYTES];     // its app ("" when the daemon sent none)
    uint8_t caps;                    // MAX_CAP_* bits
    uint32_t since_ms;               // its state's last change: the agent page's "· 2m ago"
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
    bool offers_form;                // the welcome offered `form`: New is under the pager
    max_form_t form;
    max_out_t outbox[MAX_OUTBOX];    // queued for the app to send (max_ui_take)
    int out_count;
    char selected[ID_MAX];           // the agent page's agent, "" = none (it left the ring)
    char toast_id[ID_MAX];           // what needed the person while they talked or the form was up, from toast_from
    uint32_t toast_from;
    max_attn_t toast_attn;           // why: a question, a turn done or failed
    int page;                        // the page of lanes shown, 0-based, always within max_ui_pages()
    char notice[MAX_NOTICE_BYTES];
    uint32_t notice_until;
    max_talk_t talk;
    char talk_id[ID_MAX];            // the agent the recording is for (set by the tap that starts it; "": Say's)
    int update_pct;                  // -1: no update
    char update_to[MAX_VERSION_BYTES];
    // Demo V2's pages.
    max_view_t view;
    char attn_id[ID_MAX];            // Attention's agent
    max_attn_t attn;
    uint32_t attn_from;              // when Attention came up: the edge light runs from here
    max_app_t apps[PRO_APPS_MAX];    // the daemon's `apps`, its order
    int app_count;
    char shown[PRO_APP_ID_BYTES];    // the app whose agents the ring holds
    bool apps_known;                 // an `apps` frame came: else the app column names the computer, and no Apps page
    max_inbox_t inbox[MAX_INBOX];    // newest first
    int inbox_count;
    int cell_page;                   // Overview's page of cells, within max_cell_pages()
    uint32_t talk_from;              // the recording's start (its clock)
    bool talk_heard;                 // speech was heard in this recording
    uint32_t talk_quiet_from;        // when the speech last stopped (the send ring fills from here)
    uint8_t levels[MAX_LEVELS];      // the mic's levels, oldest first
    int level_count;
    uint32_t idle_from;              // since when nothing works or waits (Ambient)
    bool wall_known;                 // the wall clock (max_ui_wall): Ambient's clock and date, else no clock
    uint8_t wall_hour, wall_min, wall_wday, wall_mday, wall_mon;   // local time; wday 0 = Sunday, mon 0 = January
    // What the last render drew, for the finger and the clock.
    max_box_t cell_box[MAX_CELLS];
    char cell_id[MAX_CELLS][ID_MAX];
    int cell_hits;
    char seg_id[MAX_SEGS][ID_MAX];   // MAX_HIT_SEG's arg names one
    max_box_t lane_box[MAX_LANES];
    char lane_id[MAX_LANES][ID_MAX];
    int lane_hits;
    max_hit_t hits[MAX_HITS];        // the card's buttons, the pager and New, the form's choices
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
// The seconds a lane's clock shows at now_ms, or -1 when it shows none.
int64_t max_secs(const max_agent_t *, uint32_t now_ms);
// Whether a finished lane still shows its summary, and the notice is up.
bool max_note_shown(const max_agent_t *, uint32_t now_ms);
bool max_notice_shown(uint32_t now_ms);
// A digest of everything drawn that depends on the time (the agent page's clock, summary and "ago", Inbox's "ago",
// the recording's band, a notice or the toast running out).
uint32_t max_time_key(uint32_t now_ms);
// "m:ss" under an hour, else "h:mm:ss"; "" for a negative count.
void max_fmt_elapsed(char *out, size_t cap, int64_t secs);
// How long ago since_ms was at now_ms, as the agent page's status and Inbox's cards say it: "just now" under a minute,
// then "2m ago", "3h ago", "4d ago".
void max_fmt_ago(char *out, size_t cap, uint32_t since_ms, uint32_t now_ms);
// FNV-1a over n bytes, from h (2166136261u to start).
uint32_t max_fnv(uint32_t h, const void *data, size_t n);
// The lanes on the page shown, as roster indices, in max_order() without the room's agent. Returns how many.
int max_visible(int out[MAX_LANES]);
// An agent on a page of lanes not shown asks: the pager's badge.
bool max_asks_off_page(void);
bool max_notice_set(const char *text, uint32_t now_ms);   // for MAX_NOTICE_MS
// A state change, with the turn's clock (stopped at the end of a turn, dropped when one we did not see start begins).
void max_set_state(max_agent_t *, max_state_t st, uint32_t now_ms);

// The toast is up: its agent still is what it announced (asking, done, failed), for MAX_TOAST_MS from toast_from.
bool max_toast_shown(uint32_t now_ms);
// The bar may record for this agent now: the link is up, nothing is recorded or sent, no form is up, and the agent is
// neither on a permission prompt (Yes or No only) nor waiting on an answer that is on its way or in. Whether the agent
// takes voice at all is max_takes_voice.
bool max_can_talk(const max_agent_t *);

// ---- Demo V2: which page is up (max_ui_model.c) ----
// Put this page up; leaving Inbox marks every notice read. True when it changed.
bool max_show(max_view_t view);
// Attention for this agent, for this reason, from now_ms (the edge light and a turn's end count from it).
void max_attention(const char *id, max_attn_t why, uint32_t now_ms);
// The agent still is what `why` says (asking, done, failed): Attention and the toast hold only while it is.
bool max_attn_holds(const char *id, max_attn_t why);
// An agent needs the person (a new question, a failed turn, an alert's summary): an unread notice in Inbox, and
// Attention takes the glass, unless a person talks or New Harness is up (then only the toast), or another agent's
// question is on Attention (a question then waits its turn; a turn's end stays in Inbox).
void max_attend(max_agent_t *, max_attn_t why, uint32_t now_ms);
// Attention leaves `except`'s question (answered, or gone): the question that has waited longest takes it, else
// Overview.
void max_next_question(const char *except, uint32_t now_ms);

// ---- Demo V2: what the pages read (max_ui_nav.c) ----
// Overview's cells on the page shown, as roster indices in roster order (the ring's own). Returns how many.
int max_cells(int out[MAX_CELLS]);
// Overview's pages of cells (0 with no agents).
int max_cell_pages(void);
// An agent on this page of cells waits on the person.
bool max_page_waits(int page);
// The agent page's strip: up to MAX_SEGS agents in roster order, a window that holds the selected one. Returns how many.
int max_segs(int out[MAX_SEGS]);
// Inbox's unread notices.
int max_unread(void);
// The shown app's entry, or NULL (no `apps` yet, or it lists no such app).
const max_app_t *max_shown_app(void);
// The app column's name: the shown app's, else the computer's, else "Harness".
const char *max_app_label(void);
// The app an agent of the ring is in, for "Answer it in <App>": the shown app's name, else its host's id, else "".
const char *max_app_of(const max_agent_t *);
// Whether the bar answers this agent's open question (caps a, and a question the inbox holds: a plain or reviewed path).
bool max_takes_answers(const max_agent_t *);
// Whether the bar records for this agent (caps v).
bool max_takes_voice(const max_agent_t *);
// The status word under a cell and on its segment: "Needs you", the spinner word, "Done", "Failed", "Resting".
const char *max_status_word(const max_agent_t *);
// The letters pro_agent_row_t.caps carries as MAX_CAP_* bits (NULL: all).
uint8_t max_caps_of(const char *letters);

// ---- questions (max_ui_ask.c) ----
max_ask_t *max_ask_of(const char *agent);
void max_ask_drop(const char *agent);
// Whether the agent has a card for Attention: a question, a failure, or an alert's summary while it shows.
bool max_has_card(const max_agent_t *, uint32_t now_ms);
// What a tap on the card must match (the question, its step, its phase).
uint32_t max_card_key(const max_agent_t *);
// How a permission prompt's option reads, by the daemon's own words for them (questionPane.ts APPROVE_RE, REJECT_RE):
// the card gives a yes and a no their colours.
bool max_option_approves(const char *option);
bool max_option_rejects(const char *option);
// The finger on a card: an option, Send, the question before, Reload.
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
