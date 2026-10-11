// Paints Pod's scenes onto the glass: damage between two scenes, then the damaged rectangles rasterised in strips
// into two DMA buffers and pushed through pro_panel_submit(). Upright coordinates; the panel turn is pro_turn.h's.
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "terminal.h"

// Kept for the caller's boot order; the strip buffers are the panel's (pro_display_init allocates them).
void pro_frame_init(void);

// Paint `next`. With a `prev` scene only the rows that differ are pushed; with NULL, the whole glass is. Returns
// the microseconds spent in the rasteriser. Call from the one render task.
uint32_t pro_frame_present(const ht_scene_t *prev, const ht_scene_t *next);
