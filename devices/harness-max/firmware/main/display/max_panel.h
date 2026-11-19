// Harness Max's panel and its light: the DSI PHY's LDO, the two-lane bus, the DBI io, the OTA7290B, and the display
// board's MCU (I2C 0x45), which powers the panel and drives the backlight. max_display.c owns the panel handle: the PPA
// turns strips straight into its framebuffer (max_strips.c), and the CPU's turns go in with esp_lcd_panel_draw_bitmap.
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"
#include "esp_lcd_types.h"

// LDO -> DSI bus -> DBI io -> OTA7290B -> init. Opening the OTA7290B powers the display board through its MCU and
// waits a second for it (the driver's own sequence). Needs the I2C bus (max_i2c_bus). The backlight is dark when this
// returns; the DPI callbacks are registered by the caller, because what they signal is the caller's business.
esp_err_t max_panel_open(esp_lcd_panel_handle_t *out_panel);

// 0 = dark .. 255 = brightest. Kept, and put on the panel while the light is on.
void max_backlight_set(uint8_t level);

// The light alone, for the idle blank: off writes level 0 and keeps the picture; on puts the kept level back.
void max_backlight_enable(bool on);
