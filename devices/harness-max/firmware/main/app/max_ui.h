// Harness Max's screen in pure C: the lanes model, fed from the cable's callbacks, drawn into a scene, and the finger
// turned into what the app must do. No ESP-IDF and no lock: max_app.c holds its own lock around every call, so the host
// tests drive it with a fake clock.
//
// The glass is 1920 x 480, landscape (HT_WIDTH x HT_HEIGHT). Strings passed in are copied; a NULL string is "absent".
// A feed returns true when the screen changed and must be drawn again.
#pragma once
#include <stdbool.h>
#include <stdint.h>

#include "cable/cable_machines.h"   // cable_machine_t
#include "cable/cable_types.h"      // ID_MAX, pod_tier_t
#include "pro_app_api.h"            // pro_agent_row_t
#include "terminal.h"               // ht_scene_t

// A fresh model: link down, no agents, nothing selected, no notice, no update.
void max_ui_reset(void);

// ---- feeds (the cable_link task, through max_app.c) ----
bool max_ui_link(bool up, const char *machine, uint32_t now_ms);
bool max_ui_agents(const pro_agent_row_t *rows, int n, uint32_t now_ms);
bool max_ui_machines(const cable_machine_t *rows, int count, const char *selected);
// kind and text as pro_app_turn (pro_app_api.h).
bool max_ui_turn(const char *id, const char *kind, const char *text, int elapsed_s, uint32_t now_ms);
bool max_ui_question(const char *id, const char *request, const char *text, uint32_t now_ms);
bool max_ui_question_close(const char *id);
bool max_ui_summary(const char *id, const char *text, const char *recap, bool restore, pod_tier_t tier,
                    uint32_t now_ms);
// The computer's window moved to this agent: it becomes the selected lane, and its page is shown.
bool max_ui_focus(const char *id);

// ---- the app's own state ----
// The notice line, for `duration_ms`; NULL or "" clears it.
bool max_ui_notice(const char *text, uint32_t duration_ms, uint32_t now_ms);
typedef enum { MAX_TALK_IDLE, MAX_TALK_RECORDING, MAX_TALK_SENDING } max_talk_t;
bool max_ui_talk(max_talk_t state);
// A firmware update in progress: pct 0..100, or -1 when there is none. `to` is the version being installed.
bool max_ui_update(int pct, const char *to);

// ---- the clock (render task) ----
// True when something drawn depends on the time and has changed (an elapsed counter, a notice that ran out).
bool max_ui_tick(uint32_t now_ms);
// How long the render task may sleep before max_ui_tick has something to do (bounded, at least 1).
uint32_t max_ui_next_wake_ms(uint32_t now_ms);

// ---- drawing (render task) ----
// Draw the model into `scene`, which the caller has cleared. Keeps the hit areas for max_ui_touch.
void max_ui_render(ht_scene_t *scene, uint32_t now_ms);

// ---- the finger (touch task), landscape glass coordinates ----
typedef enum {
    MAX_ACT_NONE,
    MAX_ACT_OPEN,    // a lane was tapped: it is now the selected one; send agent.open for agent_id
    MAX_ACT_TALK,    // the Talk slot was tapped while idle: record for agent_id (the selected agent)
    MAX_ACT_SEND,    // the Talk slot was tapped while recording: finish and send
} max_act_kind_t;
typedef struct {
    max_act_kind_t kind;
    char agent_id[ID_MAX];
} max_act_t;
// One contact at a time: down with the first point, then moves, then up (down false). A tap acts on the lift; a
// sideways swipe turns the page of lanes. Returns what the app must do (most calls: MAX_ACT_NONE).
max_act_t max_ui_touch(bool down, int x, int y, uint32_t now_ms);
void max_ui_touch_cancel(void);

// The selected agent's id, or NULL when no agent is selected.
const char *max_ui_selected(void);
