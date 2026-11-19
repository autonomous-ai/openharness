// Setting up the ESP32-P4's strips (max_strips.c, behind max_strips.h): for the panel (max_display.c) and the bench.
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

// Puts a turned strip, `band` (w x h in the panel's portrait raster), at (x, y) of the panel's framebuffer, landed when
// it returns: how the CPU's turns reach the glass. Called by one worker at a time.
typedef void (*max_strips_copy_t)(int x, int y, int w, int h, const uint16_t *band);

// The strips' buffers (internal RAM, one PRO_STRIP_PX block a worker) and the PPA's clients. Before the panel is up,
// while the internal RAM is whole.
esp_err_t max_strips_init(max_strips_copy_t copy);

// The panel's framebuffer, MAX_GLASS_H x MAX_GLASS_W RGB565 (portrait), where the PPA turns the strips to. Before the
// first push.
void max_strips_framebuffer(uint16_t *fb);

// Whether the PPA turns the strips (false once it has failed); the bench switches it to time the CPU's turn.
bool max_strips_ppa(void);
void max_strips_use_ppa(bool on);

// pro_frame.c's push (pro_panel_submit), should anything paint through it: a strip of up to PRO_STRIP_PX pixels in
// max_strip_buffer(0, 0) (worker 0's two buffers are one block), turned and in place when this returns. From the render
// task between max_present's frames.
void max_strips_put(int x, int y, int w, int h);
