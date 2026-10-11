// The frame path: ht_damage() between two scenes, then each damage rectangle (at its own width, no widening to full
// rows) is rasterised in strips straight into one of two internal DMA buffers, turned in place by the panel layer, and
// handed to the panel. While the DMA of strip n runs, strip n+1 is rasterised into the other buffer (A/B).
#include "pro_frame.h"

#include <assert.h>
#include <stddef.h>

#include "esp_timer.h"

#include "pro_display.h"

void pro_frame_init(void) {}   // the strip buffers belong to the panel (pro_display_init)

uint32_t pro_frame_present(const ht_scene_t *prev, const ht_scene_t *next)
{
    ht_damage_t damage;
    ht_damage(prev, next, &damage);
    bool pending = false;
    int buffer = 0;
    uint32_t raster_us = 0;
    for (int n = 0; n < damage.count; n++) {
        const ht_rect_t rect = damage.rect[n];
        assert(rect.x >= 0 && rect.y >= 0 && rect.w > 0 && rect.h > 0 && rect.x + rect.w <= PRO_DISPLAY_PX &&
               rect.y + rect.h <= PRO_DISPLAY_PX);
        // A small edit fits in one transfer even when taller than a strip; larger regions stay pipelined.
        const int step = rect.w * rect.h <= 2048 ? rect.h : PRO_STRIP_LINES;
        for (int y = rect.y; y < rect.y + rect.h; y += step) {
            const int h = rect.y + rect.h - y < step ? rect.y + rect.h - y : step;
            assert(rect.w * h <= PRO_STRIP_PX);
            uint16_t *px = pro_panel_strip(buffer);
            const int64_t t = esp_timer_get_time();
            ht_raster(next, (ht_rect_t){rect.x, (int16_t)y, rect.w, (int16_t)h}, px);
            pro_panel_prepare(px, rect.w, h);
            raster_us += (uint32_t)(esp_timer_get_time() - t);
            if (pending) pro_panel_wait();   // the other buffer's DMA overlapped the raster above
            pro_panel_submit(rect.x, y, rect.w, h, px);
            pending = true;
            buffer ^= 1;
        }
    }
    if (pending) pro_panel_wait();
    return raster_us;
}
