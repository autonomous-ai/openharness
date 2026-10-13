// The app layer: owns Pod's one model (pod_glue.h), feeds it from pro_cable's callbacks (pro_app_api.h), draws it
// on the render task and takes the finger from the touch task.
//
// LOCKING: one recursive mutex guards the Pod object and the render. Every public entry below takes it itself, so
// callers do not. pro_app_lock/unlock exist for a caller that must read several things consistently (pro_touch,
// the voice task). What leaves the device (agent.open, scroll, library requests, voice) is sent AFTER the mutex is
// released, so a stuck cable never holds up the render.
#pragma once
#include <stdbool.h>
#include <stdint.h>

#include "app/pod_glue.h"
#include "terminal.h"

// Bring Pod up and start the render task (24 KB stack, core 1, priority 5). Needs pro_display_init() to have run.
void pro_app_start(void);

void pro_app_lock(void);
void pro_app_unlock(void);

// ---- the finger (touch task). x, y are upright glass coordinates; `down` is the contact state. ----
// False when the screen is asleep: the contact was cancelled instead and the caller swallows the rest of it.
bool pro_app_touch(bool down, int x, int y);
void pro_app_touch_cancel(void);

// ---- the screen's power. Idle for 300 s sleeps it; a touch or the power key wakes it. ----
bool pro_app_asleep(void);
void pro_app_sleep(void);
void pro_app_wake(void);
void pro_app_bump_activity(void);

// ---- the side button (board/ptt_pro.c, its own task). A press wakes a sleeping screen, else abandons a recording or
// goes home to Tabs; a 0.8 s hold puts an awake screen to sleep (it does nothing after a press that just woke it). ----
void pro_app_button_press(void);
void pro_app_button_hold(void);

// ---- the voice side (Task 7). Safe from any task. ----
// Pod's notice line under the status bar, 3 s.
void pro_app_notice(const char *text);
// Leave the Talk frame whose recording is over (pod_ui_talk_over), redrawing.
void pro_app_talk_over(void);
bool pro_app_linked(void);
// Why a recording for this agent must not start (the copy is the screen's), or NULL when it may.
const char *pro_app_voice_block_reason(const char *agent_id);
// The agent has an unanswered question (pro_app_question and not yet closed or answered by a new turn).
bool pro_app_question_open(const char *agent_id);

// ---- the app_main hooks around fw_mark_valid ----
bool pro_app_wait_first_frame(uint32_t timeout_ms);   // the render task has put a frame on the glass (false: gave up)
void pro_app_note_update(void);                       // after fw_mark_valid: the first boot of an update shows "Updated to X.Y.Z"

// ---- the render task's steps, public so the host tests drive them with a fake clock ----
void pro_app_tick(void);                 // clock edge, talk_over, library sweep
uint32_t pro_app_next_wake_ms(void);     // how long the renderer may sleep
bool pro_app_take_scene(ht_scene_t *scene);   // draw the model into `scene` when it changed

// ---- host test seams ----
pod_ui_t *pro_app_test_pod(void);
bool pro_app_test_take_dirty(void);      // the scene needs a redraw; clears the flag
void pro_app_test_reset(void);           // a fresh model; link down; nothing busy, open or requested
