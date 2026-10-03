// Opening the board's touch controller — the one part of ui/touch.c that is not the same on both boards.
//
// Everything else in that file turned out to be portable already: the swipe tracker, the double-tap
// window, the edge bands, the stuck-press watchdog, the reinit-on-silence loop. Even the one chip quirk
// it carries (the CST9217's missing ACK) was already gated on board()->touch rather than compiled in.
// So the split is this small: hand back an opened controller and say what it is called.
#pragma once

#include <stdbool.h>

#include "esp_lcd_panel_io.h"
#include "esp_lcd_touch.h"

// Open the controller this board has. On success both handles are set and true is returned; on failure
// nothing is left allocated and touch.c retries on its own schedule.
bool touch_ctrl_open(esp_lcd_panel_io_handle_t *out_io, esp_lcd_touch_handle_t *out_tp);

// For the log lines: "CST9217", "GT911", … Never NULL.
const char *touch_ctrl_name(void);
