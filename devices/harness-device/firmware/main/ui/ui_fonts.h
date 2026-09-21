// Font faces for the device UI.
//
// Geist 4-bpp bitmaps (ASCII + Vietnamese + › ✓ ✗ and dashes). LV_SYMBOL_*
// (bell, close, wifi, …) live only in the bundled Montserrat faces and are
// selected explicitly at those call sites. Emoji are stripped by utf8_filter
// before they reach a label — they are not in either family.
#pragma once

#include "lvgl.h"

extern const lv_font_t geist_reg_16;
extern const lv_font_t geist_reg_20;
extern const lv_font_t geist_reg_24;
extern const lv_font_t geist_reg_25;
extern const lv_font_t geist_med_28;
extern const lv_font_t geist_med_32;
extern const lv_font_t geist_reg_32;
extern const lv_font_t geist_reg_34;
extern const lv_font_t geist_reg_38;
extern const lv_font_t geist_med_38;
extern const lv_font_t geist_med_48;
extern const lv_font_t geist_med_64;
extern const lv_font_t geist_sem_24;
