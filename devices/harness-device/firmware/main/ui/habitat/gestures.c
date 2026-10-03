#include "gestures.h"
#include <stdlib.h>

void ht_gesture_cancel(ht_gesture_t *g)
{
    g->live = false;
    // Preserve the voice guard across its resulting screen transition.
}
void ht_gesture_guard(ht_gesture_t *g, uint32_t now)
{
    g->guard_valid = true;
    g->guard_until = now + 450;
}
void ht_gesture_begin(ht_gesture_t *g, int x, int y, uint32_t now, uint32_t context)
{
    (void)context; // No multi-contact gesture state; the UI cancels on target/view changes.
    if (g->live) ht_gesture_cancel(g);
    g->guarded = g->guard_valid && (int32_t)(now - g->guard_until) < 0;
    if (!g->guarded) g->guard_valid = false;
    g->x = x; g->y = y; g->began = now;
    g->live = true; g->moved = false; g->axis = 0;
}
void ht_gesture_move(ht_gesture_t *g, int x, int y)
{
    if (!g->live) return;
    int dx = x - g->x, dy = y - g->y;
    if (dx * dx + dy * dy >= 12 * 12) {
        g->moved = true;
        if (!g->axis) g->axis = abs(dx) > abs(dy) ? 2 : 1;
    }
}
ht_touch_result_t ht_gesture_end(ht_gesture_t *g, int x, int y, uint32_t now)
{
    if (!g->live) return HT_TOUCH_NONE;
    ht_gesture_move(g, x, y);
    g->live = false;
    uint32_t duration = now - g->began;
    if (g->moved || g->guarded) {
        return HT_TOUCH_NONE;
    }
    if (duration < 25 || duration > 350) {
        return duration >= 650 && duration <= 1800 ? HT_TOUCH_HOLD : HT_TOUCH_NONE;
    }
    return HT_TOUCH_TAP;
}
