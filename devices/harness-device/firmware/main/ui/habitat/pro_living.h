#pragma once
#include "pro_canvas.h"

enum { PRO_LIVING_CHARACTERS=3, PRO_LIVING_MOODS=6, PRO_LIVING_STEP_MS=40,
       PRO_LIVING_FRAMES=200, PRO_LIVING_MAX_SIZE=512 };
// Review-only identity. Never written into the persistent daemon/skin registry.
static inline unsigned pro_living_frame(uint32_t elapsed) {
    return (elapsed / PRO_LIVING_STEP_MS) % PRO_LIVING_FRAMES;
}
void pro_living_init(void);
// Scene assembly is allocation/decode free. Preparation belongs to the renderer.
void pro_living_image(ht_scene_t *, unsigned character, unsigned mood, unsigned frame,
                      int x, int y, unsigned size);
void pro_living_prepare(ht_scene_t *);
