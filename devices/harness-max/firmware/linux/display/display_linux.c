// The Pro's pro_display.h on Linux: the renderer's strips land in a copy of the whole glass, and the output (scaled,
// and turned for a portrait panel) is painted from that copy, so its filter can read past a strip's edge.
#include "pro_display.h"

#include <assert.h>
#include <string.h>

#include "display/max_frame.h"
#include "max_output.h"

#include "esp_log.h"

static uint16_t s_strips[2][PRO_STRIP_PX];
static uint16_t s_glass[PRO_DISPLAY_W * PRO_DISPLAY_H];

void pro_display_init(void)
{
    // main() opened the output on the main thread already: macOS wants SDL's window there.
    ESP_LOGI("display", "%dx%d glass up", PRO_DISPLAY_W, PRO_DISPLAY_H);
}

uint16_t *pro_panel_strip(int which) { return s_strips[which & 1]; }

void pro_panel_submit(int x, int y, int w, int h, const uint16_t *buf)
{
    assert(w > 0 && h > 0 && x >= 0 && y >= 0 && x + w <= PRO_DISPLAY_W && y + h <= PRO_DISPLAY_H && w * h <= PRO_STRIP_PX);
    for (int r = 0; r < h; r++) memcpy(&s_glass[(y + r) * PRO_DISPLAY_W + x], buf + r * w, (size_t)w * sizeof *buf);
    max_output_paint(s_glass, x, y, w, h);
}

// The submit painted before it returned: the strip is free again at once.
void pro_panel_wait(void) {}

pro_touch_sample_t pro_touch_poll(int *x, int *y) { return max_output_touch(x, y); }

bool pro_touch_read(int *x, int *y) { return pro_touch_poll(x, y) == PRO_TOUCH_ONE; }

// No light to set: a window has none, and the bar's HDMI monitor keeps its own.
void pro_display_set_brightness(uint8_t level) { (void)level; }

void max_frame_show(void) { max_output_show(); }

void pro_display_power(bool on)
{
    max_output_power(on);
    if (on) {
        max_output_paint(s_glass, 0, 0, PRO_DISPLAY_W, PRO_DISPLAY_H);
        max_output_show();   // the whole glass is a frame of its own: no pro_frame_present follows it
    }
}
