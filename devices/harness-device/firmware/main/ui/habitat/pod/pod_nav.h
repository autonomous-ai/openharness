// Pod's navigation: a stack of at most 4 frames (TABS, TAB, agent view). Pure C11: no drawing, no I/O, no clock
// (times are passed in). Frames name agents by id, never by pointer, so a model change cannot leave one dangling.
#pragma once
#include <stdbool.h>
#include <stdint.h>

#include "pod/pod_model.h"

typedef enum { POD_V_TABS, POD_V_TAB, POD_V_AGENT, POD_V_RECAP, POD_V_TALK } pod_view_t;
enum { POD_TAB_RECENT = -1 };   // the Recent list: the agents most recently interacted with, from every tab

typedef struct {
    pod_view_t view;
    int8_t tab;            // TAB frame: the tab index or POD_TAB_RECENT. Agent frames: the tab they came from.
                           // Only a cache: tab_id names the tab, and pod_nav_sync re-resolves the index after
                           // every model change (a tab inserted before this one moves it).
    char tab_id[SWARM_ID_MAX];   // the tab's swarm id; empty for the Recent list
    char agent[ID_MAX];
    int16_t scroll;        // the first row shown (the Tabs grid's rows of covers, a tab's agents, a recap's lines)
} pod_frame_t;

typedef struct {
    pod_frame_t stack[4];
    uint8_t depth;
    uint32_t talk_started_ms, send_started_ms;
    char sent_agent[ID_MAX];
    pod_view_t talk_prev;  // AGENT or RECAP: the screen TALK was opened from (talk_over goes back to it)
    bool send_hold;        // after SEND the view stays AGENT until the agent's next turn starts (or 15 s pass)
    char seen_agent[ID_MAX];   // the open agent as pod_nav_flip_recaps last saw it (empty: none), and whether it was
    bool seen_active;          // WORKING or ASKING then: the Recap -> Agent flip fires on that edge, not on the level
} pod_nav_t;

typedef enum {
    POD_A_NONE, POD_A_BACK,
    POD_A_OPEN_TAB,     // arg: tab index, or POD_TAB_RECENT. Only from the TABS frame.
    POD_A_OPEN_AGENT,   // arg: index into the list pod_nav_list returns for the current TAB frame.
    POD_A_PREV, POD_A_NEXT, POD_A_TALK,
    POD_A_RECAP,        // Agent <-> Recap for a working or asking agent. No button draws it (a finished agent opens on its
                        // Recap); it stays for the clock-driven flip's tests and the render tool.
    POD_A_PANES,        // from an agent screen: back to the tab's list (from TALK it aborts first)
    POD_A_TABS,         // from an agent screen: straight back to the Tabs root (from TALK it aborts first)
    POD_A_SCROLL        // arg: signed delta added to the top frame's scroll (clamped to >= 0): rows, whatever the screen draws as one.
} pod_action_t;

typedef enum { POD_FX_NONE, POD_FX_VOICE_BEGIN, POD_FX_VOICE_END, POD_FX_VOICE_ABORT, POD_FX_AGENT_OPEN } pod_effect_t;
typedef struct { pod_effect_t fx; char agent[ID_MAX]; } pod_out_t;

void pod_nav_init(pod_nav_t *);
// One effect per call. PREV/NEXT also emit AGENT_OPEN for the neighbour (except from TALK, which emits the ABORT).
pod_out_t pod_nav_act(pod_nav_t *, pod_model_t *, pod_action_t, int arg, uint32_t now_ms);
// Call after a model change: pops frames whose agent or tab is gone. Returns VOICE_ABORT (with the agent) when
// it pops a TALK frame, else NONE. (Deviation from the plan's void return.)
pod_out_t pod_nav_sync(pod_nav_t *, const pod_model_t *);
// Just the Agent <-> Recap flips of pod_nav_sync (the clock moving can cause the first without a feed): no pops, no
// effects, the stack depth untouched. Recap -> Agent when the open agent starts working or asking.
void pod_nav_flip_recaps(pod_nav_t *, const pod_model_t *);
// The recording ended without the person (a refused start, the link, the 600 s cap): TALK goes back to the
// screen it came from, with the stack as it was. Nothing happens when the top is not TALK.
void pod_nav_talk_over(pod_nav_t *);
// The send never started (the recorder was still starting): forget it, so the Agent screen does not play SEND.
void pod_nav_unsend(pod_nav_t *);
// The list the top frame's agents come from (a TAB frame or an agent view): the tab in pane order, skipping
// unknown slots, or the Recent list. An agent open from the Recent list stays in it (at the end if it has fallen
// off the newest 8), so watching an agent finish never throws the user out of it. Returns the count; 0 on the
// TABS frame.
int pod_nav_list(const pod_nav_t *, const pod_model_t *, const pod_agent_t *out[], int max);
// The host's surface moved to this agent (cable `focus`): replace the stack with TABS -> TAB -> AGENT or RECAP (the usual
// opens-on-recap rule). The tab is the window's selected one when it holds the agent, else the first that does, else
// Recent; the TAB frame's scroll shows the agent's row. Recorded as opened (Recent recency). Emits no AGENT_OPEN: the
// host already is there. Does nothing for an unknown agent, while TALK is on top, or when the agent is already open.
// Returns true when the stack changed.
bool pod_nav_follow(pod_nav_t *, pod_model_t *, const char *agent_id, uint32_t now_ms);
