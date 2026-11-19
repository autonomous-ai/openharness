// Dev tool for test/blur_same.sh: every frame of every motion (max_motions.h) rasterised whole and hashed, one line a
// frame: cold (nothing kept), again with all kept, and after painting ahead from nothing kept (max_ui_warm's bands, as
// the render task paints them while the page rests). A frame's pixels must not depend on how the layer was built.
#include <stdlib.h>

#define main max_render_main
#include "max_render.c"
#undef main
#include "max_motions.h"
#include "max_ui_draw.h"

enum { STRIP = 24, FRAMES = 128, FRAME_MS = 16 };

static ht_scene_t s_scene;
static uint16_t s_glass[HT_WIDTH * HT_HEIGHT];
static bool band_at_a_time(void) { return false; }

static uint32_t fnv(const void *p, size_t n)
{
    const uint8_t *b = p;
    uint32_t h = 2166136261u;
    while (n--) h = (h ^ *b++) * 16777619u;
    return h;
}
static void draw_at(uint32_t now)
{
    ht_scene_clear(&s_scene, 0);
    max_ui_render(&s_scene, now);
    for (int y = 0; y < HT_HEIGHT; y += STRIP)
        ht_raster(&s_scene, (ht_rect_t){0, (int16_t)y, HT_WIDTH, (int16_t)(HT_HEIGHT - y < STRIP ? HT_HEIGHT - y : STRIP)},
                  s_glass + (size_t)y * HT_WIDTH);
    printf("%08x\n", (unsigned)fnv(s_glass, sizeof s_glass));
}
int main(void)
{
    for (int i = 0; i < MAX_MOTION_COUNT; i++)
        for (int run = 0; run < 3; run++) {   // cold, kept, painted ahead
            const max_motion_t *m = &MAX_MOTIONS[i];
            if (run != 1) {
                max_layer_forget();
                pod_cell_bake_reset();
            }
            printf("# %s run %d\n", m->name, run);
            m->set_up(draw_at);
            draw_at(T0 - 1000);
            draw_at(T0 - 500);
            draw_at(T0 - FRAME_MS);
            if (run == 2)
                while (max_ui_warm_paint(band_at_a_time) || max_ui_warm(T0 - FRAME_MS)) {}
            m->go();
            for (int f = 0; f < FRAMES; f++) {
                const uint32_t now = T0 + (uint32_t)f * FRAME_MS;
                if (m->step && f < m->steps) m->step(f, now);
                draw_at(now);
                if (f >= m->steps && !max_row_moving(now)) break;
            }
        }
    return 0;
}
