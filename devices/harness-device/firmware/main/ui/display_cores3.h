// M5Stack CoreS3 display: the ILI9342C/E panel, driven natively at 320x240.
//
// DEVICE_BOARD_M5CORES3 only. LVGL renders straight at the panel's resolution (BSP_LCD_H_RES/V_RES are
// 320x240 on this board), and ui_screens.c lays itself out for that rectangle. The flush byte-swaps each
// strip in place and DMAs it out asynchronously — see display_cores3.c.
//
// Panel + power facts are cross-checked against m5stack/M5GFX (Panel_M5StackCoreS3,
// Light_M5StackCoreS3), m5stack/M5Unified and espressif/esp-bsp bsp/m5stack_core_s3.
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "lvgl.h"

// Bring the panel up: AW9523B reset pulse, SPI3 bus, ILI9341 driver (ILI9342C/E panels), invert on.
void panel_bringup_cores3(void);

// Panel and backlight on/off together (sleep/wake path in display.c).
void panel_disp_on_off_cores3(bool on);

// The LVGL display the flush completes on. display.c binds it right after creating it.
void display_cores3_bind(lv_display_t *disp);

// LVGL flush: swap the strip to big-endian in place and DMA it out; LVGL is told when it lands.
void lvgl_flush_cores3(lv_display_t *disp, const lv_area_t *area, uint8_t *px);

// Backlight = AXP2101 DLDO1 voltage; 0 = LDO off. 0..255 in, same scale as the dial. Remembered, so a
// wake restores it.
void display_set_brightness_cores3(uint8_t level);

// Battery and WiFi, for the chrome to draw. pct <0 = unknown; wifi_bars -1 = not connected, else 0..4.
void display_cores3_set_battery(int pct, bool charging);
void display_cores3_set_wifi(bool connected, int rssi);
void display_cores3_status(int *batt_pct, bool *charging, int *wifi_bars);

// Debug: send what is on the glass back over the cable (SNAP frames; scripts/cores3-snap.py).
void display_cores3_snapshot(void);
