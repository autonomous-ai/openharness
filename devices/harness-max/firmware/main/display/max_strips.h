// The strips Harness Max's frame path (max_present.h) rasterises and the platform's display puts on the glass. Two
// tasks rasterise (MAX_WORKERS: 0 the render task, 1 a helper on the other core), each into its own MAX_STRIP_SLOTS
// buffers: it pushes one and rasterises into the other while the first is on its way (on the ESP32-P4, the PPA turning
// it into the panel's framebuffer), and waits for a buffer's push to land before writing it again. Each platform's
// display implements these: max_strips.c on the ESP32-P4, display_linux.c on Linux.
#pragma once

#include <stdint.h>

#include "pro_display.h"

// Rows a strip, at most: 4 buffers of 1920 x 12 take the 180 KB of internal RAM the Pro's two 24-row strips did, and
// one strip fits the P4's 64 KB data cache while it is rasterised.
#define MAX_STRIP_LINES 12
#define MAX_STRIP_PX (PRO_DISPLAY_W * MAX_STRIP_LINES)
#define MAX_WORKERS 2
#define MAX_STRIP_SLOTS 2

// Buffer `slot` of `worker`: MAX_STRIP_PX pixels, internal RAM.
uint16_t *max_strip_buffer(int worker, int slot);

// Puts the w x h pixels of that buffer (rows packed at width w) on the glass at (x, y), or starts to. The buffer is
// the platform's until max_strip_wait returns for it. Called by both workers at once.
void max_strip_push(int worker, int slot, int x, int y, int w, int h);

// Until the last push of that buffer has landed; at once when none is on its way.
void max_strip_wait(int worker, int slot);
