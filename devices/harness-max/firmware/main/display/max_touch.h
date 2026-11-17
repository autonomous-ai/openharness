// Harness Max touch: opening the panel's GT9271 (it speaks the GT911's protocol, so the GT911 driver reads it) on the
// I2C bus. Its points are the panel's own portrait coordinates; max_display.c turns them to the landscape glass.
#pragma once

#include <stdbool.h>

#include "esp_lcd_panel_io.h"
#include "esp_lcd_touch.h"

// False when the controller answers at neither address or its driver will not open (logged); the caller retries.
bool max_touch_open(esp_lcd_panel_io_handle_t *out_io, esp_lcd_touch_handle_t *out_tp);
