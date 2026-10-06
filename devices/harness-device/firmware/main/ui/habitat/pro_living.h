#pragma once
#include "pro_canvas.h"

enum { PRO_LIVING_CHARACTERS=3, PRO_LIVING_REVIEW_MOODS=6, PRO_LIVING_ATTENTION=6,
       PRO_LIVING_MOODS=7, PRO_LIVING_STEP_MS=33, PRO_LIVING_FRAMES=240,
       PRO_LIVING_MAX_SIZE=640 };
// This local identity has its own preference; it never overwrites daemon IDs.
static inline unsigned pro_living_frame(uint32_t elapsed) {
    return (elapsed / PRO_LIVING_STEP_MS) % PRO_LIVING_FRAMES;
}
void pro_living_init(void);
void pro_living_image(ht_scene_t *, unsigned character, unsigned mood, unsigned frame,
                      int x, int y, unsigned size);
void pro_living_prepare(ht_scene_t *);
