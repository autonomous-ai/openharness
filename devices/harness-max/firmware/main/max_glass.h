// Harness Max's glass, for every file of a Max build: its own and the Pro's compiled where they are. Each build
// force-includes this header ahead of a file's first line (-include: sources.cmake's MAX_GLASS_PRELUDE, the bench and
// the host scripts) and sets the glass itself, -DHT_WIDTH=1920 -DHT_HEIGHT=480 (the host tests also draw 415 high).
//
// The Pro's compositor (terminal.h) and glass (pro_display.h) are headers for its square 720 glass, which the Max does
// not change. This reads both first, once (#pragma once keeps every later include of them from being read again), then
// puts the build's sizes in place of theirs. A Max build that misses this header does not draw at 720: the Pro's
// terminal.h redefines the build's HT_WIDTH, which -Werror refuses.
// pro_fork relies on: devices/harness-pro/firmware/main/display/terminal.h
// pro_fork blob: df90cd7b4acf2cf2609303da27ad465ea7bef1fd (main 91f60b6a7b)
// pro_fork relies on: devices/harness-pro/firmware/main/display/pro_display.h
// pro_fork blob: a584d5d3515431bb42863524624a8b61ddd62b16 (main 91f60b6a7b)
// scripts/check_pro_forks.py fails once either is no longer that blob: check what this header assumes of it (that
// HT_WIDTH and HT_HEIGHT are the only sizes terminal.h sets, and PRO_DISPLAY_PX the only one pro_display.h does), then
// record its new blob on these lines and in main/pro_fork/upstream.txt.
#pragma once

#if !defined(HT_WIDTH) || !defined(HT_HEIGHT)
#error "a Harness Max build sets its glass: -DHT_WIDTH=1920 -DHT_HEIGHT=480"
#endif

#pragma push_macro("HT_WIDTH")
#pragma push_macro("HT_HEIGHT")
#undef HT_WIDTH
#undef HT_HEIGHT
#include "terminal.h"
#undef HT_WIDTH
#undef HT_HEIGHT
#pragma pop_macro("HT_WIDTH")
#pragma pop_macro("HT_HEIGHT")

// The Max's own code names each axis; the scene is the glass.
#ifndef PRO_DISPLAY_W
#define PRO_DISPLAY_W HT_WIDTH
#endif
#ifndef PRO_DISPLAY_H
#define PRO_DISPLAY_H HT_HEIGHT
#endif
// pro_display.h's one size is the length of a strip's rows (PRO_STRIP_PX) and pro_frame.c's bound on either axis: the
// glass's width, its longer side.
#include "pro_display.h"
#undef PRO_DISPLAY_PX
#define PRO_DISPLAY_PX PRO_DISPLAY_W
