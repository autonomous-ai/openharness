// The Pro's glass: a 720 x 720 RGB565 panel and its GT911 touch, upright to the caller.
//
// Build with -DPOD_PANEL_TURN=180 for a unit whose panel is mounted upside down. The picture is turned
// where strips are written and the contact where it is read, so callers always see an upright
// PRO_DISPLAY_PX x PRO_DISPLAY_PX glass.
#pragma once

#include <stdbool.h>
#include <stdint.h>

#define PRO_DISPLAY_PX 720

// Backlight, panel and touch bring-up, in that order. Needs the I2C bus and the power latch
// (board_pro / power_pro) to have been set up first. Aborts if the panel will not come up; a missing
// touch controller is logged and retried by pro_touch_read().
void pro_display_init(void);

// One contact, in upright glass coordinates. False when nothing touches the glass or the controller is
// absent or returned something untrustworthy (out of range, or more than one finger).
bool pro_touch_read(int *x, int *y);

// What one poll of the controller saw. NONE: no finger (or no controller yet). ONE: a single trusted finger.
// BAD: fingers the caller must not act on (more than one, or a point off the glass): cancel the contact and
// ignore it until every finger is up. ERROR: the read itself failed (a stale or lost sample, not a lift).
typedef enum { PRO_TOUCH_NONE, PRO_TOUCH_ONE, PRO_TOUCH_BAD, PRO_TOUCH_ERROR } pro_touch_sample_t;
// Upright glass coordinates in *x, *y on ONE. This is where POD_PANEL_TURN=180 turns the contact (once).
pro_touch_sample_t pro_touch_poll(int *x, int *y);

// Backlight level 0..255, floored at 20 so the glass never goes dark by a setting. Off keeps the picture and
// cuts the light (a wake must feel instant), on restores it.
void pro_display_set_brightness(uint8_t level);
void pro_display_power(bool on);

// Strip buffers: two internal, DMA-capable buffers of PRO_STRIP_PX pixels each. The renderer rasterises into one
// while the DMA of the other is in flight (A/B).
#define PRO_STRIP_LINES 24
#define PRO_STRIP_PX (PRO_DISPLAY_PX * PRO_STRIP_LINES)
uint16_t *pro_panel_strip(int which);   // 0 or 1

// Push the w*h pixels in strip buffer `buf` (a pro_panel_strip() buffer, rows packed at width w) to the upright
// rectangle (x, y). Applies the panel turn exactly once: pro_panel_prepare() reverses the buffer in place (call it
// right after rasterising, before waiting), and the submit maps the rectangle. Asynchronous: the buffer belongs to the
// DMA until pro_panel_wait() returns. Waiting for the previous submit before the next one is the caller's job.
void pro_panel_prepare(uint16_t *buf, int w, int h);
void pro_panel_submit(int x, int y, int w, int h, const uint16_t *buf);
// Block until the last submit has landed in the panel's framebuffer (250 ms; a timeout aborts to the reboot path).
void pro_panel_wait(void);
