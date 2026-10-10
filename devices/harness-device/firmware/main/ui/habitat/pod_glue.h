#pragma once
// The seam between ui_habitat.c and Pod (pod/). Everything Pod needs that is not drawing or navigation lives
// here, with no ESP-IDF dependency, so test/test_pod_touch_ui.py can compile it on the host: the model and
// navigation state, the swarm inputs the model is rebuilt from, the touch gesture, and the clock.
//
// LOCKING: none here. ui_habitat.c owns one pod_ui_t and touches it only with display_lock() held, as it does
// for `s`: the cable callbacks, the touch task (touch_habitat.c holds the lock around habitat_touch) and the
// render task (display_habitat.c holds it around habitat_tick / habitat_scene_take / habitat_next_wake_ms).
#include <stdbool.h>
#include <stdint.h>

#include "cable_client.h"
#include "pod_turn.h"
#include "scroll.h"
#include "pod/pod_view.h"

enum { POD_MEMBERS_MAX = 24 };   // == POD_PANES_MAX == SWARM_MEMBERS_MAX
enum { POD_TAP_SLOP = 24 };
enum { POD_PG_IDLE, POD_PG_DRAG, POD_PG_ANIM };
enum { POD_PG_ANIM_MS = 170, POD_PG_STEP_MS = 16, POD_PG_FLICK = 300 };   // settle time; animation step; flick velocity, px/s (0.3 px/ms)      // px: farther than this from the DOWN and the contact is a drag, not a tap

typedef struct { const char *id, *name, *engine, *machine; } pod_roster_row_t;

typedef struct {
    pod_model_t model;
    pod_nav_t nav;
    pod_out_frame_t frame;       // the hits of the last rendered scene
    // The swarm frame the model was last built from. Tab membership holds roster indices, so a roster change
    // rebuilds it from these.
    cable_swarm_t sw_items[SWARMS_MAX];
    uint8_t sw_member_count[SWARMS_MAX];
    char sw_member_id[SWARMS_MAX][POD_MEMBERS_MAX][ID_MAX];
    const char *sw_ptr[SWARMS_MAX][POD_MEMBERS_MAX];   // views onto sw_member_id for pod_model_swarms
    const char *const *sw_list[SWARMS_MAX];
    pod_member_meta_t sw_meta[SWARMS_MAX][POD_MEMBERS_MAX];   // the daemon's member metadata of the same frame (see pod_model_swarms_meta)
    char sw_selected[ID_MAX];
    cable_tile_t sw_tiles[SWARM_TILES_MAX];
    int sw_n, sw_tile_n;
    uint32_t seen_revision;
    uint32_t clock_stamp;
    bool dirty;                  // a change the model's revision does not show (the notice)
    // The one-line notice under the status bar (a refused start, say).
    char notice[80];
    uint32_t notice_until;
    bool notice_on;
    // player.library sweep: see pod_ui_sweep_*.
    struct {
        bool active, restart, ever;
        int last_next;           // the offset after the last page taken: a page that does not advance ends it
        uint32_t started_ms;
    } sweep;
    // touch
    bool down, cancelled, dragging, hit_valid;
    int start_x, start_y, anchor_y;
    bool sw_ok, sw_on;           // a horizontal pane swipe may come from this contact / is under way (see swipes in pod_glue.c)
    int sw_vx, sw_last_x;        // finger velocity along x, px per second
    uint32_t sw_last_ms;
    int scroll_px;               // finger travel not yet turned into a row (see scroll_rows)
    // The Tabs grid scrolls by pages in pixels (see pg_* in pod_glue.c): the resting page is the TABS frame's scroll, this
    // is the gesture on top of it.
    uint8_t pg_mode;             // POD_PG_IDLE, POD_PG_DRAG (follows the finger), POD_PG_ANIM (settling after the release)
    int pg_base, pg_dy;          // DRAG: the offset at the DOWN (px from the top of page 0) and the finger's travel since
    int pg_vel;                  // finger velocity, px per second (negative: up)
    int pg_last_y;
    uint32_t pg_last_ms;
    int pg_from, pg_to;          // ANIM: the offsets it runs between
    uint32_t pg_t0;
    bool pg_t0_pending;          // ANIM started by a cancel (no clock): the next render stamps t0
    pod_hit_t hit;
    // Recap drag -> the agent's pane in the desktop app, as the round dial scrolls it (ht_scroll: DOWN, MOVEs, UP with the
    // fling). Begun when the vertical drag is recognised (a tap sends nothing), at the DOWN's point and time; the host
    // applies it to the agent that is open (Pod already sent agent.open for it). The sink is set by ui_habitat.c before every contact.
    ht_scroll_t scroll;
    ht_scroll_emit_t scroll_emit;
    void *scroll_ctx;
    bool scroll_reversed, scroll_begun;
    uint32_t down_ms;
    // Following the host (see pod_ui_focus): the last contact, and a focus whose agent the model does not know yet.
    bool touched;
    uint32_t last_touch_ms;
    char pending_focus[ID_MAX];
    uint32_t pending_focus_ms;
} pod_ui_t;

void pod_ui_init(pod_ui_t *);

// Draw into `scene` (already cleared) and keep its hits for touch.
void pod_ui_render(pod_ui_t *, ht_scene_t *scene, uint32_t now_ms);

// ---- feeds. Each runs pod_nav_sync and returns its effect (usually none) for the caller to perform. ------
pod_out_t pod_ui_link(pod_ui_t *, bool up);
pod_out_t pod_ui_roster(pod_ui_t *, const pod_roster_row_t *rows, int n);
// `members` may be NULL (no agentIds); its i-th entry belongs to items[i].
pod_out_t pod_ui_swarms(pod_ui_t *, const cable_swarm_t *items, int n, const cable_swarm_members_t *members,
                        const char *selected, const cable_tile_t *tiles, int tile_count);
pod_out_t pod_ui_status(pod_ui_t *, const char *id, const char *status, uint32_t now_ms);
pod_out_t pod_ui_turn(pod_ui_t *, const char *id, const char *kind, const char *text, int elapsed_s, uint32_t now_ms);
pod_out_t pod_ui_question(pod_ui_t *, const char *id, const char *text);
pod_out_t pod_ui_question_close(pod_ui_t *, const char *id);
pod_out_t pod_ui_recap(pod_ui_t *, const char *id, const char *recap, bool restore);

// The host's focus moved to an agent (cable `focus`): show it (pod_nav_follow). Not while TALK is on top, nor within
// POD_FOLLOW_QUIET_MS of the user's own touch (they are driving; that focus is dropped). An agent the model does not
// know yet is kept for POD_FOLLOW_PENDING_MS and applied when it arrives. Never returns an effect (no AGENT_OPEN back).
#define POD_FOLLOW_QUIET_MS 4000
#define POD_FOLLOW_ECHO_MS 800   // on the Tabs screen: the daemon's echo of the device's own move settles within 750 ms
#define POD_FOLLOW_PENDING_MS 5000
pod_out_t pod_ui_focus(pod_ui_t *, const char *agent_id, uint32_t now_ms);

// The roster's second source, player.library. A sweep walks the pages: begin, one pod_ui_library_page per page
// received (it feeds the rows and says where to go next), end. A sweep is due on link up, when the swarms change, and
// every POD_SWEEP_MS while linked; one that has run longer than POD_SWEEP_MS is stalled and starts over.
// ui_habitat.c owns the request (pinning, the 3 s retry); this owns the walk.
#define POD_SWEEP_MS 30000
typedef struct { const char *id, *name, *engine, *machine, *status; int32_t age_s; } pod_library_row_t;
bool pod_ui_sweep_due(const pod_ui_t *, uint32_t now_ms);
void pod_ui_sweep_begin(pod_ui_t *, uint32_t now_ms);   // the caller then requests offset 0
void pod_ui_sweep_abort(pod_ui_t *);                    // the link dropped
bool pod_ui_sweeping(const pod_ui_t *);
// Rows of one page (the page's offset, row count and the library's total). Returns the offset to request next, or -1
// when the sweep is complete (library_end has run). Also tabs are rebuilt and the nav synced; the effect is returned
// through *fx (may be NULL).
int pod_ui_library_page(pod_ui_t *, const pod_library_row_t *rows, int count, int offset, int total, uint32_t now_ms,
                        pod_out_t *fx);
// Rows outside a sweep (a page someone else asked for): status and roster only.
pod_out_t pod_ui_library_rows(pod_ui_t *, const pod_library_row_t *rows, int count, uint32_t now_ms);

// A transient one-line notice, 3 s, drawn under the status bar by pod_ui_render.
void pod_ui_notice(pod_ui_t *, const char *text, uint32_t now_ms);

// True once per model or navigation change since the last call: the caller marks its scene dirty.
bool pod_ui_take_changed(pod_ui_t *);

// ---- touch. `down` is the contact state at (x, y); returns the effect of a completed tap, if any. ---------
// Where Recap drags are reported (NULL: nowhere) and which way the person's setting reads them. Cheap: call before each contact.
void pod_ui_scroll_sink(pod_ui_t *, ht_scroll_emit_t emit, void *ctx, bool reversed);
pod_out_t pod_ui_touch(pod_ui_t *, bool down, int x, int y, uint32_t now_ms, bool *changed);
void pod_ui_touch_cancel(pod_ui_t *);

// ---- voice and clock ---------------------------------------------------------------------------------------
bool pod_ui_talking(const pod_ui_t *);
// Leave a TALK frame whose recording is already over (refused start, link loss, the 600 s cap): back to the Agent
// or Recap screen it came from, same stack, no effect to perform.
void pod_ui_talk_over(pod_ui_t *);
// SEND was tapped but the recorder had not started, so nothing is sent: forget the send (no send scene), say
// "Not sent" for a moment. The frame is already back on the Agent screen.
void pod_ui_unsend(pod_ui_t *, uint32_t now_ms);
// Whether the top screen shows a pet (AGENT, RECAP, TALK) and is linked.
bool pod_ui_pet_on_screen(const pod_ui_t *);
// The next clock edge: 16 ms while the Tabs grid settles onto a page, the pet's step while one is on screen, 150 ms while
// an agent works on Tab (the equaliser), else the next second (the elapsed clocks).
uint32_t pod_ui_wake_ms(const pod_ui_t *, uint32_t now_ms);
// True when the clock has crossed an edge since the last call: the caller redraws.
bool pod_ui_clock_tick(pod_ui_t *, uint32_t now_ms);

#define POD_PET_STEP_MS 33   // 1000 / 30
