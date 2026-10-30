#pragma once
// The seam between pro_app.c and Pod (pod/). Everything Pod needs that is not drawing or navigation lives
// here, with no ESP-IDF dependency, so test/test_pro_app.py can compile it on the host: the model and
// navigation state, the swarm inputs the model is rebuilt from, the touch gesture, and the clock.
//
// LOCKING: none here. pro_app.c owns one pod_ui_t and touches it only with pro_app_lock() held: the cable
// callbacks (cable_link task), the touch task (pro_app_touch) and the render task (tick, render, wake).
#include <stdbool.h>
#include <stdint.h>

#include "cable/cable_types.h"
#include "scroll.h"
#include "pod/pod_pet.h"
#include "pod/pod_view.h"

enum { POD_MEMBERS_MAX = 24 };   // == POD_PANES_MAX == SWARM_MEMBERS_MAX
enum { POD_TAP_SLOP = 24 };   // px: farther than this from the DOWN and the contact is a drag, not a tap
// Gestures: the top band's height (a swipe down from it opens Notices) and the travel of that
// swipe; the travel of a swipe up (Home).
enum { POD_BAR_H = 72, POD_BAR_SWIPE = 80, POD_EDGE_SWIPE = 80, POD_BOTTOM_Y = 620 };   // POD_BOTTOM_Y: a swipe up that starts at or below it goes Home from a room or a recap

typedef struct { const char *id, *name, *engine, *machine; } pod_roster_row_t;
// One frame for the daemon about the Swarm cards: `t` is "supertab.select", "supertab.open" or "supertab.recap.get" (a literal), lead "" closes the open recap.
typedef struct { const char *t; char tab[ID_MAX], lead[ID_MAX], side[8]; } pod_supertab_out_t;   // side: only "supertab.side" ("pm" / "buddy")
enum { POD_SUPERTAB_OUT_MAX = 8, POD_SUPERTAB_RETRIES = 5, POD_SUPERTAB_RETRY_MS = 3000 };

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
    char sw_prev_sel[ID_MAX];    // the window's selected tab of the previous swarms frame of this link (pod_ui_swarms)
    bool sw_prev_valid;          // sw_prev_sel is set: the first frame after link-up only records it
    uint32_t followed_ms;        // when a host focus last landed (a selected-tab change right after it does not undo it)
    bool followed;
    cable_tile_t sw_tiles[SWARM_TILES_MAX];
    int sw_n, sw_tile_n;
    uint32_t seen_revision;
    uint32_t clock_stamp;
    bool started;                // the start (pod_ui_start) is over for this link: it ran, was disarmed, the person touched or pressed, or a host focus landed
    bool fresh_swarms;           // swarms have arrived since this link came up (the start never acts on the previous link's retained roster)
    bool rows_moved;             // this contact scrolled at least one row (the Inbox's swipe up goes back only when it did not)
    bool dirty;                  // a change the model's revision does not show (the notice)
    // The one-line notice under the status bar (a refused start, say).
    char notice[80];
    uint32_t notice_until;
    bool notice_on;
    bool notice_bad;             // the red pill (a failure), not the dark one
    // The notice toast (ph_toast, POD_TOAST_MS) (see pod_ui_notify): which entry (by agent), until when, and a contact that began on it.
    // ban_stay: a Super Tab question's toast (pod_model_attention), which does not run out: it goes when swiped up, when the question
    // closes (its entry goes) or once Notices is on screen; ban_until then only dates its slide-in.
    char ban_agent[ID_MAX];
    char ban_tab[ID_MAX];        // a Swarm chat's notice (pod_ui_swarm_notice): the Swarm it is from, with ban_agent = the Lead; "" for an agent's
    uint32_t ban_until;
    bool ban_on, ban_touch, ban_stay;
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
    pod_hit_t hit;
    // Recap drag -> the agent's pane in the desktop app, as the round dial scrolls it (ht_scroll: DOWN, MOVEs, UP with the
    // fling). Begun when the vertical drag is recognised (a tap sends nothing), at the DOWN's point and time; the host
    // applies it to the agent that is open (Pod already sent agent.open for it). The sink is set by pro_app.c before every contact.
    ht_scroll_t scroll;
    ht_scroll_emit_t scroll_emit;
    void *scroll_ctx;
    bool scroll_reversed, scroll_begun;
    uint32_t down_ms;
    // Tap to talk: armed at a DOWN that may talk, fired by its lift if the finger stayed within POD_TAP_SLOP (pod_ui_touch, on the touch task).
    bool talk_armed, bar, edge;   // bar: the contact began in the top edge (y < POD_BAR_H) of a non-Talk screen: a swipe down opens the Inbox; edge: the contact began in the bottom zone (y >= POD_BOTTOM_Y) of a room or a recap: a swipe up goes Home, and it scrolls nothing
    bool hands_free;   // a tap started a recording; the next new tap sends it (cleared by END, ABORT, talk_over)
    uint8_t talk_depth;
    pod_view_t talk_view;            // the screen (nav depth and view) and agent the tap was armed on: it fires only there
    char talk_agent[ID_MAX];
    // Following the host (see pod_ui_focus): the last contact, and a focus whose agent the model does not know yet.
    bool touched;
    uint32_t last_touch_ms;
    char pending_focus[ID_MAX];
    uint32_t pending_focus_ms;
    // The Swarm cards' Lead view (see pod_ui_take_supertab): the Lead the daemon was last told is open (empty: none), the frames waiting to go, and when a
    // supertab.focus began waiting for its Swarm list.
    char sup_tab[ID_MAX], sup_lead[ID_MAX];
    char sup_chat[ID_MAX];       // the open Lead's chat_id when open + recap.get were last pushed for it: a different one asks again at once
    struct { char swarm[ID_MAX], lead[ID_MAX]; } lead_seen[SWARMS_CARD_MAX];   // the Lead last on screen in each Swarm
    uint8_t lead_seen_next;      // the slot a new Swarm takes once all are used: the oldest, as slots fill in order
    char sup_close[ID_MAX];      // a "closed" frame the link dropped, owed for this Swarm until sent (empty: none), unless a Lead opens first
    pod_supertab_out_t sup_q[POD_SUPERTAB_OUT_MAX];
    uint8_t sup_qn;
    uint32_t sup_at;             // when the open Lead was last (re)sent to the daemon, at the model's clock
    uint8_t sup_tries;           // re-sends of open + recap.get so far while it stays LOADING (at most POD_SUPERTAB_RETRIES)
    bool sup_reopened;           // the one supertab.open sent POD_SUPERTAB_RETRY_MS after opening, so the daemon surely knows the open Lead
    bool lead_wait;
    uint32_t lead_wait_ms;
    // The software update (see pod_ui_ota): while on, the stack stays as it was and ph_view_ota is what is drawn.
    bool ota, ota_restarting;
    int ota_pct;
    char ota_from[24], ota_to[24];
} pod_ui_t;

// The root is Home; the start (pod_ui_start) waits for the next link-up.
void pod_ui_init(pod_ui_t *);

// Draw into `scene` (already cleared) and keep its hits for touch.
void pod_ui_render(pod_ui_t *, ht_scene_t *scene, uint32_t now_ms);

// ---- feeds. Each runs pod_nav_sync and returns its effect (usually none) for the caller to perform. ------
pod_out_t pod_ui_link(pod_ui_t *, bool up);
pod_out_t pod_ui_roster(pod_ui_t *, const pod_roster_row_t *rows, int n);
// `members` may be NULL (no agentIds); its i-th entry belongs to items[i].
pod_out_t pod_ui_swarms(pod_ui_t *, const cable_swarm_t *items, int n, const cable_swarm_members_t *members,
                        const char *selected, const cable_tile_t *tiles, int tile_count);
pod_out_t pod_ui_turn(pod_ui_t *, const char *id, const char *kind, const char *text, int elapsed_s, uint32_t now_ms);
// turn.stats for an agent (-1 leaves a field unknown); unknown agents are ignored.
pod_out_t pod_ui_turn_stats(pod_ui_t *, const char *id, int32_t passed, int32_t failed, int32_t commits, int32_t tokens_in, int32_t tokens_out);
// super_tab: the Super Tab the question was asked in (NULL = a plain question) and its attention (pod_model_question_tab).
// The Swarm cards: the model's lists (pod_model_supertab_ids / _supertab / _recap / _focus) behind the same sync as every feed.
pod_out_t pod_ui_supertab_ids(pod_ui_t *, const char (*ids)[ID_MAX], int n);
pod_out_t pod_ui_supertab(pod_ui_t *, const pod_swarm_t *s, uint32_t now_ms);
pod_out_t pod_ui_supertab_recap(pod_ui_t *, const char *tab, const char *lead, const char *chat_id, const char *text, uint32_t at, bool none);
pod_out_t pod_ui_supertab_focus(pod_ui_t *, const char *tab, const char *lead, uint32_t now_ms);   // now_ms: the quiet-window and waiting clocks, as pod_ui_focus's
pod_out_t pod_ui_question(pod_ui_t *, const char *id, const char *text, const char *super_tab, pod_attention_t attention);
// The daemon took a recording for this agent (voice.result): Working now, before its turn starts (pod_model_sent).
pod_out_t pod_ui_sent(pod_ui_t *, const char *id, uint32_t now_ms);
pod_out_t pod_ui_question_close(pod_ui_t *, const char *id);
pod_out_t pod_ui_recap(pod_ui_t *, const char *id, const char *recap, bool restore);

// The host's focus moved to an agent (cable `focus`): show it (pod_nav_follow). Not while TALK is on top, nor within
// POD_FOLLOW_QUIET_MS of the user's own touch (they are driving; that focus is dropped). An agent the model does not
// know yet is kept for POD_FOLLOW_PENDING_MS and applied when it arrives. Never returns an effect (no AGENT_OPEN back).
#define POD_FOLLOW_QUIET_MS 4000
#define POD_FOLLOW_ECHO_MS 800   // on the Tabs screen: the daemon's echo of the device's own move settles within 750 ms
#define POD_FOLLOW_PENDING_MS 5000
pod_out_t pod_ui_focus(pod_ui_t *, const char *agent_id, uint32_t now_ms);

// ---- the Lead view (Swarm cards) ----
// A tap on a Lead pet (POD_A_LEAD) opens the Lead view; a horizontal swipe on it steps to the previous / next Lead; supertab.focus (the model's focus_pending, acted on
// after every feed) opens the Lead the desktop opened, the way pod_ui_focus does (not while talking, updating or touching; a Lead the list does not hold yet waits
// POD_FOLLOW_PENDING_MS for it). The frames for the daemon are queued and taken after the lock is released: select (a tap or a swipe, never a follow: the
// desktop already is there), then whatever makes the daemon's idea of the open recap match the screen: supertab.open with the Lead (and supertab.recap.get unless its
// text is LOADED; it goes LOADING) when the Lead view shows one, supertab.open with no lead when it no longer does. While the Lead cannot be found (the link dropped,
// the list not back yet) nothing is sent; a link drop forgets what was open, so the view re-sends open and get when its Lead is back.
// Returns how many frames were written to out (at most max).
int pod_ui_take_supertab(pod_ui_t *, pod_supertab_out_t out[], int max);
// A frame taken by pod_ui_take_supertab that could not be sent (the link was busy): open / recap.get count as not sent, so the retry comes again (a failed retry is not counted);
// the closing open (no lead) is owed until it is sent, unless a Lead opened since.
// The person picked a side of that Swarm: queue `supertab.side`. False when the queue is full or `side` is NONE. A frame that could not be sent is dropped, not
// retried (pod_ui_supertab_unsent ignores it): the next supertab frame shows the side the desktop really holds.
bool pod_ui_supertab_side(pod_ui_t *, const char *tab, pod_side_t side);
void pod_ui_supertab_unsent(pod_ui_t *, const pod_supertab_out_t *frame);

// The start, armed by a real link down -> up (pod_ui_link): once swarms of this link have arrived, if the stack is at the
// root (TABS) and tab 0 has agents, enter tab 0 on its first agent (POD_A_ENTER_TAB). It is device-local: no AGENT_OPEN
// goes to the host (that message only moves the desktop's focused pane). Any other outcome ends the start for this link:
// tab 0 empty, the person already elsewhere, a touch or the side button (pod_ui_navigated), or a host focus that landed.
// True when it entered. Call after every model change. An update and a contact in progress: false.
bool pod_ui_start(pod_ui_t *, uint32_t now_ms);
// The person navigated (the side button): the start never runs over them. Touches do this themselves.
void pod_ui_navigated(pod_ui_t *);

// The roster's second source, player.library. A sweep walks the pages: begin, one pod_ui_library_page per page
// received (it feeds the rows and says where to go next), end. A sweep is due on link up, when the swarms change, and
// every POD_SWEEP_MS while linked; one that has run longer than POD_SWEEP_MS is stalled and starts over.
// pro_app.c owns the request (pinning, the 3 s retry); this owns the walk.
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
void pod_ui_notice_bad(pod_ui_t *, const char *text, uint32_t now_ms);   // the same, in red (#b3261e): "Update failed"

// The software update screen (owner, 2026-10-11): ph_view_ota is drawn instead of the stack, touches do nothing, no banner.
// pct 0..100 is the progress; `restarting` the last screen before the reboot. pct < 0 ends the screen and the stack
// underneath (untouched) is back. Notifications still fill the Inbox meanwhile, quietly.
void pod_ui_ota(pod_ui_t *, const char *from, const char *to, int pct, bool restarting);
bool pod_ui_updating(const pod_ui_t *);

// ---- notifications ----
// A live summary ended a turn: file an unread entry for the agent (its recap, name, elapsed; one per agent, the newest) and, for an
// alert, show the toast for POD_TOAST_MS over a room (a newer one replaces it; none while TALK is on top; a tap opens Notices, a
// swipe up dismisses). A Super Tab question's toast (pod_model_attention) stays instead: until swiped up, until the question
// closes, or until Notices opens. Nothing is filed when the agent is not on the roster.
#define POD_BANNER_SWIPE_PX 40
// `awake`: the glass is lit. A dark one is not looking, even when it rests on that agent's screen.
// When the current toast started (it shows for POD_TOAST_MS); the toast draw reads it for its timer line.
uint32_t pod_ui_banner_shown_ms(const pod_ui_t *);
// `tier` (alert / list / silent): silent files nothing; list files the entry only; alert also toasts. If the agent's own room is on
// screen (and the glass is lit) any tier is read at once there. Returns true only when the caller must wake the glass and beep:
// an alert, not on that agent's own screen. `text` NULL = the agent's recap; `question`: the entry is a question's (it goes when the
// question closes).
bool pod_ui_notify_text(pod_ui_t *, const char *agent_id, pod_tier_t tier, const char *text, bool question, bool awake, uint32_t now_ms);
bool pod_ui_notify(pod_ui_t *, const char *agent_id, pod_tier_t tier, bool awake, uint32_t now_ms);
// A Swarm chat's notice (supertab.notice), the alert tier: files the entry (one per Lead, the newest) and toasts over a room or another Lead's view; a tap on the toast
// or on its Notices row opens that Lead (and selects it on the desktop) instead of Notices. Returns true when the caller must wake the glass and beep. Nothing
// is filed for a Swarm or Lead the model does not hold. If that Lead's own view is on screen and the glass is lit, it is read at once: no entry, no toast, false.
// The read (supertab.notice.read) drops the entry of that chat only, and ends its toast if that is the one showing.
bool pod_ui_swarm_notice(pod_ui_t *, const char *tab, const char *lead, const char *chat, const char *chat_id, const char *text, bool awake, uint32_t now_ms);
void pod_ui_swarm_notice_read(pod_ui_t *, const char *tab, const char *lead, const char *chat_id);
// notif.replace: begin (clears the list), one row per item, end. The toast is not shown for these.
void pod_ui_notif_begin(pod_ui_t *);
void pod_ui_notif_row(pod_ui_t *, const char *agent_id, const char *name, const char *token, const char *summary, uint32_t now_ms);
void pod_ui_notif_end(pod_ui_t *);
// notif.seen: read elsewhere. True if an entry was dropped.
bool pod_ui_notif_seen(pod_ui_t *, const char *agent_id, const char *token);
// The notif.read frames to send (entries read on the Pod that had a token); pro_app sends them after the lock.
int pod_ui_take_reads(pod_ui_t *, pod_read_out_t out[], int max);

// True once per model or navigation change since the last call: the caller marks its scene dirty.
bool pod_ui_take_changed(pod_ui_t *);

// ---- touch. `down` is the contact state at (x, y); returns the effect of a completed tap, if any. ---------
// Where Recap drags are reported (NULL: nowhere) and which way the person's setting reads them. Cheap: call before each contact.
void pod_ui_scroll_sink(pod_ui_t *, ht_scroll_emit_t emit, void *ctx, bool reversed);
pod_out_t pod_ui_touch(pod_ui_t *, bool down, int x, int y, uint32_t now_ms, bool *changed);
pod_out_t pod_ui_touch_cancel(pod_ui_t *);   // the contact is dropped; an open recording does not depend on it and stays

// ---- voice and clock ---------------------------------------------------------------------------------------
bool pod_ui_talking(const pod_ui_t *);
// Leave a TALK frame whose recording is already over (refused start, link loss, the 600 s cap): back to the Agent
// or Recap screen it came from, same stack, no effect to perform.
void pod_ui_talk_over(pod_ui_t *);
// SEND was tapped but the recorder had not started, so nothing is sent: forget the send (no send scene), say
// "Not sent" for a moment. The frame is already back on the Agent screen.
void pod_ui_unsend(pod_ui_t *, uint32_t now_ms);
// Whether the top screen shows a pet (AGENT, RECAP, TALK, Home's equaliser) and is linked.
bool pod_ui_pet_on_screen(const pod_ui_t *);
// The next clock edge: the pet's step while one is on screen, 66 ms while Home's equaliser moves, else the next second.
uint32_t pod_ui_wake_ms(const pod_ui_t *, uint32_t now_ms);
// True when the clock has crossed an edge since the last call: the caller redraws.
bool pod_ui_clock_tick(pod_ui_t *, uint32_t now_ms);

