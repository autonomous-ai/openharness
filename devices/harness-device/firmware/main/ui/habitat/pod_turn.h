#pragma once
// POD_PANEL_TURN=180: the unit E8:F6:0A:E7:63:7D has its panel mounted upside down. The picture is turned where
// the strips are written (display_habitat.c) and the contacts here, where they come in (touch_habitat.c), so
// the Pod above sees an upright 720 x 720 glass either way. Off unless the build sets POD_PANEL_TURN=180.
#define POD_GLASS_PX 720

// A contact coordinate on the controller's axes -> on the Pod's glass. Identity when the panel is upright.
static inline int pod_turn_coord(int v)
{
#if defined(POD_PANEL_TURN) && POD_PANEL_TURN == 180
    return POD_GLASS_PX - 1 - v;
#else
    return v;
#endif
}
