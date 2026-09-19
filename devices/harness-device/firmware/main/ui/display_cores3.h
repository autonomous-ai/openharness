// M5Stack CoreS3 display bring-up + the virtual round-screen compositor.
//
// DEVICE_BOARD_M5CORES3 only. The 8,000-line UI was designed for the 466×466 round
// AMOLED; instead of rewriting it for 320×240, the panel work happens where the pixels
// leave LVGL:
//
//   • LVGL still renders a full 466×466 virtual display (BSP_LCD_H_RES/V_RES stay 466),
//     so every geometry constant in ui_screens.c stays 1:1 with the round design.
//   • The flush callback nearest-neighbour downscales each dirty area by 29/50 onto the
//     320×240 ILI9342C panel. The window is fitted to the UI's real content bounds
//     (notification pill y=22 → Voice button y=434, see ui_screens.c), so nothing the
//     round design draws is cropped.
//   • touch.c maps panel coordinates back up by 50/29, so gestures, hit tests and LVGL all
//     live in the same virtual space.
//
// Panel + power facts are cross-checked against m5stack/M5GFX (Panel_M5StackCoreS3,
// Light_M5StackCoreS3), m5stack/M5Unified and espressif/esp-bsp bsp/m5stack_core_s3.
#pragma once

#include <stdint.h>
#include "lvgl.h"

// Bring the panel up: AW9523B reset pulse, SPI3 bus, ILI9341 driver (ILI9342C/E panels),
// invert on. Async IO queue (depth 10, esp-bsp convention); the flush streams chunk by chunk.
void panel_bringup_cores3(void);

// Panel on/off (sleep/wake path in display.c).
void panel_disp_on_off_cores3(bool on);

// LVGL flush: 466×466 virtual RGB565 → 320×240 panel, 8/11 nearest-neighbour.
void lvgl_flush_cores3(lv_display_t *disp, const lv_area_t *area, uint8_t *px);

// panel coord → virtual coord (inverse of the flush mapping; touch.c uses this).
void panel_to_virtual(int px, int py, int *vx, int *vy);

// Backlight = AXP2101 DLDO1 voltage; 0 = LDO off. 0..255 in, same scale as the dial.
void display_set_brightness_cores3(uint8_t level);
