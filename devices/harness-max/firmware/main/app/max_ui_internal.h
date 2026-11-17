// What max_ui_model.c, max_ui_view.c and max_ui_touch.c share: the one model, the layout and the helpers. Private to
// those three files and their host tests.
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
#define MAX_NOTICE_BYTES 96
#define MAX_VERSION_BYTES 24
#define MAX_DONE_MS 60000u          // how long a finished turn's summary stays on its lane
#define MAX_WAKE_MS 60000u          // the render task's longest sleep when nothing drawn depends on the time

// The glass, 1920 x 480 at about 225 ppi (8.86 px a mm). Columns, left to right: the rail, three lanes, the Talk slot.
// Cards are inset in their column so neighbours stand 16 px apart; the band under the cards holds the page dots or
// the notice.
enum {
    MAX_RAIL_W = 300,
    MAX_LANES = 3,
    MAX_LANE_X = 300, MAX_LANE_W = 452,      // lanes 300..1656
    MAX_TALK_X = 1656, MAX_TALK_W = 264,     // Talk 1656..1920
    MAX_INSET = 8,
    MAX_CARD_Y = 14, MAX_CARD_H = 420,       // cards 14..434
    MAX_BAND_Y = 434,                        // dots and notice 434..480
    MAX_PAD = 24,                            // text inside a card
    MAX_TAP_SLOP = 24,                       // px, as the Pro's POD_TAP_SLOP: farther from the DOWN is a drag
    MAX_SWIPE_PX = 80,                       // a sideways drag this long turns the page
};

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
    uint32_t ask_key;                // the open question's request and prompt: a re-sent one is no change
    char note[MAX_NOTE_BYTES];       // FAILED: the error; DONE: the summary's text, shown until note_until
    uint32_t note_until;
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
    char selected[ID_MAX];           // "" = none
    int page;                        // the page of lanes shown, 0-based, always within max_ui_pages()
    char notice[MAX_NOTICE_BYTES];
    uint32_t notice_until;
    max_talk_t talk;
    char talk_id[ID_MAX];            // the agent the recording is for (set when the Talk tap starts it)
    int update_pct;                  // -1: no update
    char update_to[MAX_VERSION_BYTES];
    // What the last render drew, for the finger and the clock.
    max_box_t lane_box[MAX_LANES];
    char lane_id[MAX_LANES][ID_MAX];
    int lane_hits;
    max_box_t talk_box;
    bool talk_hit;
    uint32_t drawn_key;              // max_ui_time_key at the last render
    bool dirty;                      // the finger changed what is shown (a page, a selection): draw again
    // The contact in progress.
    bool down, moved;
    int down_x, down_y;
} max_model_t;

extern max_model_t max_m;

// Copy src (NULL reads as "") into dst[cap]: cut on a UTF-8 code point, control characters as spaces.
void max_copy(char *dst, size_t cap, const char *src);
max_agent_t *max_find(const char *id);
// The roster's indices in lane order: needs a person (asking, failed), then working, then the rest; roster order in
// each group, so the order moves only when a state does. Returns the count.
int max_order(int out[MAX_AGENTS]);
int max_pages(void);
// Keep the page within the pages there are.
void max_clamp_page(void);
// The seconds a lane's clock shows at now_ms, or -1 when it shows none.
int64_t max_secs(const max_agent_t *, uint32_t now_ms);
// Whether a finished lane still shows its summary, and the notice is up.
bool max_note_shown(const max_agent_t *, uint32_t now_ms);
bool max_notice_shown(uint32_t now_ms);
// A digest of everything drawn that depends on the time (the visible clocks, a summary or a notice running out).
uint32_t max_time_key(uint32_t now_ms);
// "m:ss" under an hour, else "h:mm:ss"; "" for a negative count.
void max_fmt_elapsed(char *out, size_t cap, int64_t secs);
