// Pod's state: tabs, agents, per-agent state and recap. Pure C11: no drawing, no I/O, no ESP-IDF, and no
// clock (every time is passed in as now_ms). Fed by ui_habitat.c from the cable messages it already parses.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "cable_client.h"   // ID_MAX, CABLE_NAME_MAX, SWARM_ID_MAX, cable_swarm_t, cable_tile_t

#define POD_AGENTS_MAX 32
#define POD_TABS_MAX   24
#define POD_PANES_MAX  24
#define POD_RECENT_MAX 8     // agents the Recent list holds
#define POD_RECAP_BYTES 2048
#define POD_RECAP_LINES 64   // the Recap screen joins them, so this is only a cap on sentences kept (2 KB holds ~50)

// Where the roster knows an agent from. An agent stays while any source still lists it.
enum { POD_SRC_TAB = 1, POD_SRC_LIBRARY = 2, POD_SRC_TAB_META = 4 };   // TAB_META: a tab lists it and the daemon described it (swarms `members`)

// POD_OFFLINE: the agent's machine is offline (known only from a tab's member metadata); it has no turn, no recap, no voice.
typedef enum { POD_IDLE, POD_WORKING, POD_ASKING, POD_DONE, POD_OFFLINE } pod_state_t;

// Room for a Vietnamese sentence or two (UTF-8, ~2 bytes a letter). POD_AGENTS_MAX of these live in PSRAM.
#define POD_ACTIVITY_BYTES 512
// The steps of the turn so far: the activity sentences (turn.activity's `action`) the agent has moved on from, newest
// first. The cable carries no tool, token or file counters, so these are the only "how far" the device can know.
// The footer's spinner word (turn.activity `text`, "Infusing..." with its dots dropped): its own field, so it and the
// progress sentence (`action`, in activity[]) never overwrite each other.
#define POD_VERB_BYTES 64
#define POD_STEPS_MAX  3
#define POD_STEP_BYTES 160

typedef struct {
    char id[ID_MAX], name[CABLE_NAME_MAX], engine[12], machine[CABLE_NAME_MAX];
    pod_state_t state;
    uint32_t since_ms, elapsed_s, event_ms;
    bool has_event;                      // event_ms is set (an agent with none takes any feed, wrap or not)
    char activity[POD_ACTIVITY_BYTES], question[320], recap[POD_RECAP_BYTES];
    char verb[POD_VERB_BYTES];
    char steps[POD_STEPS_MAX][POD_STEP_BYTES];   // this turn's tools and previous activity sentences, newest first (cut on a codepoint)
    uint8_t step_count;
    bool activity_cut;                   // the cable text was longer than activity[]: the view ends it with an ellipsis
    bool recap_cut;                      // the text ends mid-thought (the source was cut, or too long to keep): the view ends it with "..."
    uint8_t recap_lines;                 // recap[] holds that many NUL-terminated lines, back to back
    uint16_t line_at[POD_RECAP_LINES];   // byte offset of each line in recap[]
    bool seen;                           // re-sent since the last pod_model_agents_begin
    bool recap_live;                     // the recap came from a live summary (not a restore)
    uint8_t src;                         // POD_SRC_*: agents.* (the window's tab) and/or player.library
    bool lib_seen;                       // re-sent since the last pod_model_library_begin
    int32_t age_s;                       // library: seconds since its last activity, -1 unknown (ranks the cap)
    // When the agent was last interacted with, three clocks for pod_model_recent (each valid with its flag): the last
    // turn event or change of state, the library's ageSeconds as an absolute time at receipt, and the last time the
    // user opened it on the Pod. (event_ms is no use for this: every library sweep restamps it.)
    uint32_t act_ms, lib_ms, open_ms;
    bool has_act, has_lib, has_open;
} pod_agent_t;

typedef struct { int16_t x1, y1, x2, y2; } pod_rect_t;   // 0..1000

typedef struct {
    char id[SWARM_ID_MAX], name[CABLE_NAME_MAX];
    uint8_t panes, count;                // count: members listed (or the daemon's agent count when unknown)
    int8_t agent[POD_PANES_MAX];         // indices into agents[]; -1 = not in the roster (or not a driveable tile)
    pod_rect_t rect[POD_PANES_MAX];      // selected tab only: rect[k] is tile k
    bool has_rects, members_known;
    uint32_t member_hash[POD_PANES_MAX]; // FNV-1a of each member id (0 = unused): who is in some tab, for the cap
} pod_tab_t;

typedef struct {
    pod_agent_t agents[POD_AGENTS_MAX];
    uint8_t agent_count;
    pod_tab_t tabs[POD_TABS_MAX];
    uint8_t tab_count, selected;
    bool linked;
    uint32_t revision;                   // bumped by every feed that changes something
    uint32_t clock_ms;                   // the newest now_ms seen (pod_model_clock); the stale rule reads it
    bool clock_set;
} pod_model_t;

// Copy src into dst[cap], cut on a UTF-8 codepoint boundary (always valid, always NUL-terminated); src may be dst.
void pod_copy_str(char *dst, size_t cap, const char *src);
// Cut a trailing partial UTF-8 codepoint off s (after an snprintf that truncated).
void pod_utf8_trim(char *s);

void pod_model_reset(pod_model_t *);
// Interface addition: call at agents.begin; agents_end then drops every agent not re-sent since.
void pod_model_agents_begin(pod_model_t *);
void pod_model_agent(pod_model_t *, const char *id, const char *name, const char *engine, const char *machine);
void pod_model_agents_end(pod_model_t *);
void pod_model_swarms(pod_model_t *, const cable_swarm_t *items, const char *const *agent_ids[],
                      const uint8_t agent_id_counts[], int n, const char *selected,
                      const cable_tile_t *tiles, int tile_count);
// The same with the daemon's member metadata: meta[i][k] describes agent_ids[i][k] (NULL: none, nothing changes). A member
// that no roster source lists and whose machine is offline joins the roster as POD_OFFLINE (source POD_SRC_TAB_META, which
// the agents.* and library sweeps leave alone) for as long as the tab still lists it.
typedef cable_swarm_member_meta_t pod_member_meta_t;
void pod_model_swarms_meta(pod_model_t *, const cable_swarm_t *items, const char *const *agent_ids[],
                           const uint8_t agent_id_counts[], int n, const char *selected,
                           const cable_tile_t *tiles, int tile_count, const pod_member_meta_t (*meta)[POD_PANES_MAX]);
// player.library is the second roster source: every session on every machine, so tabs other than the window's
// show their agents. A sweep is library_begin, one library_row per row of every page, library_end (which drops the
// LIBRARY source from agents the sweep did not see). A row adds the agent if absent, fills empty name / engine /
// machine, and applies `status` like pod_model_library_status. age_s is the row's ageSeconds (-1 unknown).
// The roster holds POD_AGENTS_MAX agents. When it is full, a library-only agent is kept over another by: member of
// some tab, then working or asking, then most recent. A row that ranks below every library-only agent is not
// added; agents.* agents always make room.
void pod_model_library_begin(pod_model_t *);
void pod_model_library_row(pod_model_t *, const char *id, const char *name, const char *engine, const char *machine,
                           const char *status, int32_t age_s, uint32_t now_ms);
void pod_model_library_end(pod_model_t *);
void pod_model_library_status(pod_model_t *, const char *id, const char *status, uint32_t now_ms);
// kind: started, activity (text = the progress sentence, the `action`), verb (text = the footer's spinner word),
// step (text = a tool the turn started, "Read · file.c"), done, error.
// An empty text never blanks the line it feeds.
void pod_model_turn(pod_model_t *, const char *id, const char *kind, const char *text, int elapsed_s, uint32_t now_ms);
void pod_model_question(pod_model_t *, const char *id, const char *text);
void pod_model_question_close(pod_model_t *, const char *id);
void pod_model_recap(pod_model_t *, const char *id, const char *recap, bool restore);
void pod_model_link(pod_model_t *, bool up);

const pod_agent_t *pod_model_find(const pod_model_t *, const char *id);
// The user opened the agent on the Pod (POD_A_OPEN_AGENT): it counts as interacted with now.
void pod_model_opened(pod_model_t *, const char *id, uint32_t now_ms);
// The agents most recently interacted with (the newest of act_ms, lib_ms and open_ms), at most max, newest first.
// When there are more candidates than max, every working or asking agent (by the effective state) is kept first, most
// recent first, and the most recent others fill the rest. The list is only as stable as the clocks: it reorders when
// an agent is opened or gets news.
int pod_model_recent(const pod_model_t *, const pod_agent_t *out[], int max);
int pod_model_working(const pod_model_t *, const pod_agent_t *out[], int max);
// The state to show: the agent's own, except that Working goes Idle once its last event is over 25 s old (a turn.done
// that was never delivered). pod_model_eff is that at the model's clock and is what every reader uses (the working
// list, the tab counts and tints, the rows, the recap rule, the cap's ranking); pod_model_state names the instant.
pod_state_t pod_model_state(const pod_model_t *, const pod_agent_t *, uint32_t now_ms);
pod_state_t pod_model_eff(const pod_model_t *, const pod_agent_t *);
// Advance the model's clock (never backwards). Feeds that carry now_ms do it themselves; the renderer calls it.
void pod_model_clock(pod_model_t *, uint32_t now_ms);
bool pod_model_opens_on_recap(const pod_model_t *, const pod_agent_t *);
