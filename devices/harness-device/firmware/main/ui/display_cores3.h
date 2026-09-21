// M5Stack CoreS3 display bring-up + the virtual round-screen compositor.
//
// DEVICE_BOARD_M5CORES3 only. The 8,000-line UI was designed for the 466×466 round
// AMOLED; instead of rewriting it for 320×240, the panel work happens where the pixels
// leave LVGL:
//
//   • LVGL still renders a full 466×466 virtual display (BSP_LCD_H_RES/V_RES stay 466),
//     so every geometry constant in ui_screens.c stays 1:1 with the round design.
//   • Each flush is composited into a full 466×466 PSRAM framebuffer, then integer-½
//     downsampled (2×2 RGB565 box) onto the 320×240 ILI9342C, centred with black bars.
//     Sampling only the dirty rectangle garbled glyphs; 29/50 nearest shredded 4-bpp fonts.
//   • touch.c maps panel coordinates back up by ×2, so gestures, hit tests and LVGL all
//     live in the same virtual space.
//
// Panel + power facts are cross-checked against m5stack/M5GFX (Panel_M5StackCoreS3,
// Light_M5StackCoreS3), m5stack/M5Unified and espressif/esp-bsp bsp/m5stack_core_s3.
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "lvgl.h"

// Bring the panel up: AW9523B reset pulse, SPI3 bus, ILI9341 driver (ILI9342C/E panels),
// invert on. Async IO queue (depth 10, esp-bsp convention); the flush streams chunk by chunk.
void panel_bringup_cores3(void);

// Panel on/off (sleep/wake path in display.c).
void panel_disp_on_off_cores3(bool on);

// LVGL flush: 466×466 virtual RGB565 → full FB → 320×240 integer-½ box + SPI byte-swap.
void lvgl_flush_cores3(lv_display_t *disp, const lv_area_t *area, uint8_t *px);

// panel coord → virtual coord (inverse of the flush mapping; touch.c uses this).
void panel_to_virtual(int px, int py, int *vx, int *vy);

// ── native-resolution layer ─────────────────────────────────────────────────────────────────────────
// A second LVGL display, 320x240, one-to-one with the glass, for screens the round face cannot serve.
// The virtual face lands on 233x233 after the half downsample, which gives a keyboard row ~18 px per
// key (about 2.5 mm); no styling inside the virtual face can fix that, because the mapping is uniform.
//
// Two displays, ONE panel: activate() pauses the refresh timer of whichever is going dark, so they can
// never paint at once. Everything else follows from that invariant, including the shared draw buffers.
lv_display_t *display_cores3_native_display(void);

// Hand the panel to the native display (true) or back to the 466 virtual face (false). Repaints the
// incoming display in full, and moves the touch indev with it.
void display_cores3_native_activate(bool on);

// Whether the native display currently owns the panel. touch.c reads this to decide whether the
// driver's panel coordinates still need scaling up into virtual space.
bool display_cores3_native_active(void);

// Backlight = AXP2101 DLDO1 voltage; 0 = LDO off. 0..255 in, same scale as the dial.
void display_set_brightness_cores3(uint8_t level);

// Battery HUD in the physical top-right letterbox (not the virtual 466 face).
// pct 0..100, or <0 to hide. Stamped after each flush so the compositor cannot wipe it.
void display_cores3_set_battery(int pct, bool charging);
// WiFi bars in the physical top-left letterbox. rssi in dBm; connected=false draws empty bars.
void display_cores3_set_wifi(bool connected, int rssi);
