// The finger: polls the GT911 (pro_display.c turns the contact upright, once) and hands single trusted contacts to
// pro_app_touch(). Everything else is cancelled and swallowed until every finger is up, so a second finger,
// a lost sample or a touch that woke the screen never becomes a tap.
#pragma once
#include <stdbool.h>
#include <stdint.h>

#include "pro_display.h"

typedef struct {
    bool prev;       // the previous sample was a trusted finger
    bool swallow;    // the rest of this contact is not for Pod
    int last_x, last_y;
} pro_touch_t;

typedef struct {
    uint32_t presses, last_press_ms_ago, read_failures;
    bool controller_ok, held_now;
} pro_touch_stats_t;

// Start the poll task (10 KB stack, core 1, priority 7). Call after pro_app_start().
void pro_touch_start(void);

// One poll sample (and its position on ONE) through the contact rules. The task calls this every 4 ms while a
// finger is down and every 20 ms otherwise; the host tests call it with a fake clock.
void pro_touch_feed(pro_touch_t *t, pro_touch_sample_t sample, int x, int y);

void pro_touch_stats(pro_touch_stats_t *out);
