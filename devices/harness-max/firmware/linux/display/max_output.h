// A Linux output for the glass, chosen at build time (MAX_LINUX_OUTPUT): an SDL window, where the mouse is the finger
// (out_sdl.c: the macOS simulator), or a DRM/KMS screen with evdev touch (out_drm.c: the Orange Pi's bar).
// display_linux.c implements the Pro's pro_display.h over it.
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "pro_display.h"

// On the main thread, before anything draws (macOS wants SDL's window there). False: no picture (logged).
bool max_output_open(int glass_w, int glass_h);

// The glass rectangle (x, y, w, h) changed in `glass` (RGB565, rows of the glass width). From the render task; ignored
// while dark.
void max_output_paint(const uint16_t *glass, int x, int y, int w, int h);

// Dark (false) shows black and keeps the picture, as the device's backlight off; the caller repaints after on.
void max_output_power(bool on);

// One poll of the finger, in glass coordinates on PRO_TOUCH_ONE.
pro_touch_sample_t max_output_touch(int *x, int *y);

#ifdef MAX_OUTPUT_SDL
// Save the glass as the window's renderer draws it to `path` (BMP) `after_ms` after start, then quit: the simulator's
// screenshot.
void max_output_screenshot(uint32_t after_ms, const char *path);
#endif

// The main thread's loop, for as long as the program runs: SDL's events, or DRM's wait for the end.
void max_output_run(void) __attribute__((noreturn));
