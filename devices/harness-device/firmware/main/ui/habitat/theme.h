#pragma once

// One charcoal surface, two neutral inks, one companion/action accent.
// Canvas matches the desktop terminal pane and Cmd N / Cmd P surfaces.
// All colors are RGB565-representable at full brightness. Conversion and the
// existing saved brightness setting remain at the UI boundary; no theme heap.
#ifdef DEVICE_PRO_COMPANION
#define HT_THEME_CANVAS    0xeeede5u
#define HT_THEME_TEXT      0x191a18u
#define HT_THEME_SECONDARY 0x73746eu
#define HT_THEME_ACCENT    0x191a18u
#define HT_THEME_SELECTION 0xdeddd5u
#define HT_THEME_ERROR     0x9b3d4au
#define HT_PATTERN_X 192
#define HT_PATTERN_Y 252
#define HT_PATTERN_STEP_X 168
#define HT_PATTERN_STEP_Y 168
#define HT_PATTERN_RADIUS 52
#else
#define HT_THEME_CANVAS    0x181818u
#define HT_THEME_TEXT      0xefe7deu
#define HT_THEME_SECONDARY 0xada6adu
#ifdef DEVICE_HABITAT_ORANGE
#define HT_THEME_ACCENT    0xff6d00u
#else
#define HT_THEME_ACCENT    0xc6aaefu
#endif
#define HT_THEME_SELECTION 0x392c4au
#define HT_THEME_ERROR     0xe7a6adu
#define HT_PATTERN_X 157
#define HT_PATTERN_Y 180
#define HT_PATTERN_STEP_X 80
#define HT_PATTERN_STEP_Y 74
#define HT_PATTERN_RADIUS 30
#endif
// Desktop activityColor() / darkTerminalTheme ANSI status colors. Only the
// inbox status mark gets color; pane name, message and navigation stay neutral.
#define HT_THEME_DONE      0x0dbc79u
#define HT_THEME_QUESTION  0xe5e510u
#define HT_THEME_FAILED    0xcd3131u
