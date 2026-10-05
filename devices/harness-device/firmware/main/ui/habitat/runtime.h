#pragma once
#include "terminal.h"
// Model is protected by display_lock; DMA never holds that lock.
bool habitat_scene_take(ht_scene_t *out);
// Capture under the model lock after taking a scene, acknowledge only after
// its pixels finish DMA. Zero means there is no unread card in that frame.
uint32_t habitat_scene_receipt(void);
void habitat_scene_presented(uint32_t receipt);
void habitat_tick(void);
uint32_t habitat_next_wake_ms(void);
bool habitat_is_voice_view(void);
void habitat_touch(bool down, int x, int y, uint32_t now_ms);
// The driver calls this on an untrusted sample, then swallows contact until a real release.
void habitat_touch_cancel(void);
#ifdef DEVICE_PRO_COMPANION
// Called under the display lock. Begin consumes the pending one-finger action;
// end can select only the still-current, down-pinned adjacent workspace.
bool habitat_workspace_gesture_begin(void);
void habitat_workspace_gesture_end(int step);
#endif
void habitat_render_notify(void);
void habitat_input_stamp(int64_t now_us);
typedef struct {
    uint32_t frames, bytes, raster_max_us, frame_max_us, input_last_us, input_max_us;
    uint32_t prepare_max_us, render_max_us;
} habitat_perf_t;
void habitat_perf_get(habitat_perf_t *out);
