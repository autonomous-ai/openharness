// Harness Max's frame path: the Pro's pro_frame_present (pro_frame.h), painted by both cores. The Pro keeps its own.
#pragma once

#include <stdint.h>

#include "terminal.h"

// Paints `next`, only where it differs from `prev` (NULL: the whole glass), and returns when every pixel has landed.
// Returns the microseconds both tasks spent rasterising; `pushed_px`, when not NULL, gets the pixels repainted (0:
// `next` differs from `prev` nowhere). From the render task only; the first call starts the helper task.
uint32_t max_present(const ht_scene_t *prev, const ht_scene_t *next, uint32_t *pushed_px);

// 2 (the default): the helper on the other core paints strips too. 1: the render task alone, for the bench to compare.
void max_present_cores(int cores);

// Work the scene's strips read that the scene's build left to the frame (the UI's blurs, max_ui_work): each task that
// paints a frame's strips calls work(0 for the render task, 1 for the helper) before its first, and work returns once
// all of it is done; a frame no task paints is the render task's to work all the same. NULL (the default): none.
void max_present_work(void (*work)(int worker));
