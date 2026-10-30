// Pod's navigation: a stack of at most 4 frames (TABS, TAB, agent view). Pure C11: no drawing, no I/O, no clock
// (times are passed in). Frames name agents by id, never by pointer, so a model change cannot leave one dangling.
#pragma once
#include <stdbool.h>
#include <stdint.h>

#include "pod/pod_model.h"

typedef enum { POD_V_TABS, POD_V_TAB, POD_V_AGENT, POD_V_RECAP, POD_V_TALK, POD_V_INBOX, POD_V_LEAD } pod_view_t;
enum { POD_TAB_RECENT = -1 };   // the Recent list: the agents with the most recent tasks, from every tab

typedef struct {
    pod_view_t view;
    int8_t tab;            // TAB frame: the tab index or POD_TAB_RECENT. Agent frames: the tab they came from.
                           // Only a cache: tab_id names the tab, and pod_nav_sync re-resolves the index after
                           // every model change (a tab inserted before this one moves it).
    char tab_id[SWARM_ID_MAX];   // the tab's swarm id; empty for the Recent list
    char agent[ID_MAX];    // LEAD frame: the harness the Lead's talk goes to (its `local`), empty for a remote Lead (re-resolved by pod_nav_sync)
    char swarm[ID_MAX];    // LEAD frame (and the TALK opened from it): the Swarm's id; empty on every other frame
    char lead_id[ID_MAX];  // ... and the Lead's id: it names the Lead, `lead` (its index in the Swarm's card order) is only a cache that pod_nav_sync re-resolves
    int8_t lead;
    int16_t scroll;        // the first row shown (the Tabs grid's rows of covers, a tab's agents, a recap's lines)
} pod_frame_t;

typedef struct {
    pod_frame_t stack[4];
    uint8_t depth;
    uint32_t talk_started_ms, send_started_ms;
    char sent_agent[ID_MAX];
    uint8_t work_page;     // Home's Working card: the page of three pets shown (0-based; reset when the card is not shown)
    uint8_t swarm_page;    // Home's Swarm card: the page of three Lead pets shown (0-based; reset when the card is not shown or the person pages cards)
    pod_view_t talk_prev;  // AGENT or RECAP: the screen TALK was opened from (talk_over goes back to it)
    bool talk_buddy;       // the voice view shows the Buddy (pinned at TALK's begin, like the daemon's face): its name and engine below
    char talk_name[49], talk_engine[16];
    bool sending;          // TALK after the stop tap: the voice screen shows SEND until the agent's real turn begins (or POD_SENT_WAIT_MS)
    bool sent_seen;        // the model has marked sent_agent's optimistic Working (pod_model_sent) since the stop tap
    char seen_agent[ID_MAX];   // the open agent as pod_nav_flip_recaps last saw it (empty: none), and whether it was
    bool seen_active;          // WORKING or ASKING then: the Recap -> Agent flip fires on that edge, not on the level
} pod_nav_t;

typedef enum {
    POD_A_NONE, POD_A_BACK,
    POD_A_BANNER,       // hit only: the notice toast (the glue handles its tap and its swipe up; the nav ignores it)
    POD_A_OPEN_TAB,     // arg: tab index, or POD_TAB_RECENT. Only from the TABS frame.
    POD_A_OPEN_AGENT,   // arg: index into the list pod_nav_list returns for the current TAB frame.
    POD_A_PREV, POD_A_NEXT, POD_A_TALK,
    POD_A_RECAP,        // Agent <-> Recap for a working or asking agent. No button draws it (a finished agent opens on its
                        // Recap); it stays for the clock-driven flip's tests and the render tool.
    POD_A_PANES,        // from an agent screen: back to the tab's list (from TALK it aborts first)
    POD_A_TABS,         // from an agent screen: straight back to the Tabs root (from TALK it aborts first)
    POD_A_INBOX,        // the bell: push the Inbox (from anywhere but TALK and the Inbox itself)
    POD_A_OPEN_NOTIF,   // arg: index into model->unread, from the Inbox: open that agent (an Agent/Recap frame over the Inbox) and mark it read. An idle agent opens on its Recap (which reads it)
    POD_A_FOLLOW,       // arg: index into model->agents: open that agent from anywhere (Inbox rows with no unread entry); the glue resolves the id
    POD_A_SCROLL,       // arg: signed delta added to the top frame's scroll (clamped to >= 0): rows, whatever the screen draws as one.
    POD_A_ENTER_TAB,    // arg: tab index, only from the TABS frame: push the TAB frame and the tab's first agent (AGENT_OPEN). An empty or unknown tab: nothing.
    POD_A_LEAD,         // hit only for now (the Swarm card's Lead pets): arg = the Lead's index in its Swarm, hit id = the Swarm's id. The nav ignores it
    POD_A_SIDE          // hit only (the Lead view's PM | Buddy pill): arg = POD_SIDE_PM or POD_SIDE_BUDDY, hit id = the Swarm's id. The nav ignores it; the glue sends supertab.side and never talks on it
} pod_action_t;

typedef enum { POD_FX_NONE, POD_FX_VOICE_BEGIN, POD_FX_VOICE_END, POD_FX_VOICE_ABORT, POD_FX_AGENT_OPEN } pod_effect_t;
typedef struct { pod_effect_t fx; char agent[ID_MAX]; } pod_out_t;

void pod_nav_init(pod_nav_t *);
// One effect per call. PREV/NEXT also emit AGENT_OPEN for the neighbour (except from TALK, which emits the ABORT).
pod_out_t pod_nav_act(pod_nav_t *, pod_model_t *, pod_action_t, int arg, uint32_t now_ms);
// Call after a model change: pops frames whose agent or tab is gone. Returns VOICE_ABORT (with the agent) when
// it pops a TALK frame, else NONE. (Deviation from the plan's void return.)
pod_out_t pod_nav_sync(pod_nav_t *, pod_model_t *);
// Just the Agent <-> Recap flips of pod_nav_sync (the clock moving can cause the first without a feed): no pops, no
// effects, the stack depth untouched. Recap -> Agent when the open agent starts working or asking.
void pod_nav_flip_recaps(pod_nav_t *, pod_model_t *);
// The recording ended without the person (a refused start, the link, the 600 s cap): TALK goes back to the
// screen it came from, with the stack as it was. Nothing happens when the top is not TALK.
void pod_nav_talk_over(pod_nav_t *);
// The send never started (the recorder was still starting): forget it and leave TALK for the screen it came from.
void pod_nav_unsend(pod_nav_t *);
// The list the top frame's agents come from (a TAB frame or an agent view): the tab in pane order, skipping
// unknown slots, or the Recent list. An agent open from the Recent list stays in it (at the end if it has fallen
// off the newest 8), so watching an agent finish never throws the user out of it. Returns the count; 0 on the
// TABS frame.
int pod_nav_list(const pod_nav_t *, const pod_model_t *, const pod_agent_t *out[], int max);
// Opening an agent (a tap on a row, PREV/NEXT, follow) marks its unread entry read here: pod_model_unread_read.
// The host's surface moved to this agent (cable `focus`): replace the stack with TABS -> TAB -> AGENT or RECAP (the usual
// opens-on-recap rule). The tab is the window's selected one when it holds the agent, else the first that does, else
// Recent; the TAB frame's scroll shows the agent's row. Not a task: Recent does not change. Emits no AGENT_OPEN: the
// host already is there. Does nothing for an unknown agent, while TALK is on top, or when the agent is already open.
// Returns true when the stack changed.
// The label of the top frame's Back, from the frame below it: "Recent" (came from the Recent list), the tab's name
// (a tab list), "Tabs" (the root), "Inbox", else "Back". The pointer is into the model (or a literal): valid until the next model change.
const char *pod_nav_origin(const pod_nav_t *, const pod_model_t *);
bool pod_nav_follow(pod_nav_t *, pod_model_t *, const char *agent_id, uint32_t now_ms);
// ---- the Lead view (Swarm cards) ----
// A tap on a Lead pet: push the Lead view for lead index `lead` of the Swarm over Home. Home stays on its card (and its swarm_page), so Back lands on it. Nothing for
// an unknown Swarm or Lead, over TALK, or when the stack is not at Home. Returns true when it pushed.
bool pod_nav_open_lead(pod_nav_t *, pod_model_t *, const char *swarm_id, int lead);
// supertab.focus: replace the stack with Home on the Swarm's card and the Lead view over it (the card's pet page is the one holding the Lead). Does nothing for an
// unknown Swarm or Lead, while TALK is on top, or when that Lead is already open. Returns true when the stack changed.
bool pod_nav_follow_lead(pod_nav_t *, pod_model_t *, const char *swarm_id, const char *lead_id);
// The Lead the top frame shows (the Lead view, or the TALK opened from it) and its Swarm (may be NULL); NULL when the top is not one or the model does not hold it (yet).
const pod_lead_t *pod_nav_lead(const pod_nav_t *, const pod_model_t *, const pod_swarm_t **swarm);
// POD_A_PREV / POD_A_NEXT on the Lead view step to the previous / next Lead of the Swarm in card order (wrapping; nothing with fewer than two); on the TALK opened from it, nothing.
bool pod_nav_follow_tab(pod_nav_t *, pod_model_t *);   // The app window's selected tab changed: Home's card or the room follows (device-local)
