// What moves on the screen by the clock alone, as the last render drew it: the room's pet and the toast's bar. The
// model's clock (max_ui_tick, max_ui_next_wake_ms) asks this, so the render task wakes for them.
#pragma once
#include <stdint.h>

// Milliseconds from now_ms until the picture moves on: 0 when it is due, MAX_WAKE_MS when nothing drawn moves.
uint32_t max_motion_ms(uint32_t now_ms);
