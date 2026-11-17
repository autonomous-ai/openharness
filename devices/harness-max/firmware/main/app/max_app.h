// Harness Max's app layer: the lanes model (max_ui.h) fed from pro_cable's callbacks (pro_app_api.h), drawn on the
// render task, and the finger from the touch task (app/pro_app_hooks.h). max_app.c implements all three headers.
#pragma once
#include <stdbool.h>
#include <stdint.h>

#include "app/pro_app_hooks.h"

// Bring the model up and start the render task (pro_render: 24 KB stack, core 1, priority 5). Needs
// pro_display_init() to have run.
void pro_app_start(void);

// app_main's hook before fw_confirm_frame_painted: the render task has put a frame on the glass (false: gave up).
// The other hook, pro_app_note_update, is pro_app_api.h's.
bool pro_app_wait_first_frame(uint32_t timeout_ms);
