// Opening the Pro's touch controller (a GT911). Everything a finger then does is pro_display.c's.
#pragma once

#include <stdbool.h>

#include "esp_lcd_panel_io.h"
#include "esp_lcd_touch.h"

// Reset the GT911 by hand into its primary address, then open it on the shared I2C bus. On success both
// handles are set and true is returned; on failure nothing is left allocated and the caller may retry.
bool touch_ctrl_open(esp_lcd_panel_io_handle_t *out_io, esp_lcd_touch_handle_t *out_tp);
