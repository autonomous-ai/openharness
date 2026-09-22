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

#if defined(DEVICE_BOARD_M5CORES3)
// The CoreS3 twins: every face at 0.6x, which is the dial's PHYSICAL size on this glass (the dial is
// ~326 ppi, the CoreS3's 320x240 on 2.0" ~200 ppi). Mapped here, so ui_screens.c names one set of faces
// for both boards and the dial's own layout decisions — which face for which role — carry over whole.
extern const lv_font_t geist_c3_reg_10;
extern const lv_font_t geist_c3_reg_12;
extern const lv_font_t geist_c3_reg_15;
extern const lv_font_t geist_c3_reg_20;
extern const lv_font_t geist_c3_reg_21;
extern const lv_font_t geist_c3_reg_23;
extern const lv_font_t geist_c3_med_17;
extern const lv_font_t geist_c3_med_20;
extern const lv_font_t geist_c3_med_23;
extern const lv_font_t geist_c3_med_29;
extern const lv_font_t geist_c3_med_39;
extern const lv_font_t geist_c3_sem_15;
#define geist_reg_16 geist_c3_reg_10
#define geist_reg_20 geist_c3_reg_12
#define geist_reg_24 geist_c3_reg_15
#define geist_reg_25 geist_c3_reg_15
#define geist_reg_32 geist_c3_reg_20
#define geist_reg_34 geist_c3_reg_21
#define geist_reg_38 geist_c3_reg_23
#define geist_med_28 geist_c3_med_17
#define geist_med_32 geist_c3_med_20
#define geist_med_38 geist_c3_med_23
#define geist_med_48 geist_c3_med_29
#define geist_med_64 geist_c3_med_39
#define geist_sem_24 geist_c3_sem_15
// LV_SYMBOL_* glyphs live only in Montserrat; the same 0.6x.
#define lv_font_montserrat_14 lv_font_montserrat_12
#define lv_font_montserrat_18 lv_font_montserrat_12
#define lv_font_montserrat_22 lv_font_montserrat_14
#define lv_font_montserrat_24 lv_font_montserrat_14
#define lv_font_montserrat_30 lv_font_montserrat_18
#define lv_font_montserrat_40 lv_font_montserrat_24
#endif
