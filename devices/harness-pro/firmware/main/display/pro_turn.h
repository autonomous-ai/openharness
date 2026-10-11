// POD_PANEL_TURN=180: the unit whose panel is mounted upside down. THE one place the turn is written down; the panel
// layer (pro_display.c) applies each helper once, and the host tests call these same functions to play the glass.
// Callers above the panel layer see an upright PRO_DISPLAY_PX x PRO_DISPLAY_PX glass and must never turn anything.
#pragma once
#include <stddef.h>
#include <stdint.h>

#define PRO_TURN_PX 720

#if defined(POD_PANEL_TURN) && POD_PANEL_TURN != 180
#error "POD_PANEL_TURN must be 180 when defined"
#endif

// A coordinate on the controller's axes <-> on the upright glass (the turn is its own inverse). Identity upright.
static inline int pro_turn_coord(int v)
{
#if defined(POD_PANEL_TURN) && POD_PANEL_TURN == 180
    return PRO_TURN_PX - 1 - v;
#else
    return v;
#endif
}

// Reverse a w*h block of pixels in place: with the rectangle mapped by pro_turn_rect this is a 180 degree turn.
static inline void pro_turn_pixels(uint16_t *px, size_t count)
{
#if defined(POD_PANEL_TURN) && POD_PANEL_TURN == 180
    for (uint16_t *a = px, *b = px + count - 1; a < b; a++, b--) {
        const uint16_t v = *a;
        *a = *b;
        *b = v;
    }
#else
    (void)px;
    (void)count;
#endif
}

// The rectangle (x, y, w, h) of the upright glass -> its top-left corner on the panel.
static inline void pro_turn_rect(int x, int y, int w, int h, int *panel_x, int *panel_y)
{
#if defined(POD_PANEL_TURN) && POD_PANEL_TURN == 180
    *panel_x = PRO_TURN_PX - x - w;
    *panel_y = PRO_TURN_PX - y - h;
#else
    (void)w;
    (void)h;
    *panel_x = x;
    *panel_y = y;
#endif
}
