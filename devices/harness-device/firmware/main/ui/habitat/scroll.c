#include "scroll.h"
#include <stdlib.h>

#define CLAIM_PX 12
#define REPORT_PX 8
#define REPORT_MS 16
#define MAX_SPEED 6000


uint32_t ht_scroll_coast_ms(int velocity)
{
    unsigned speed = (unsigned)abs(velocity), duration = 0;
    if (speed > MAX_SPEED) speed = MAX_SPEED;
    // Rounded up, including a final frame; intentionally errs toward braking, never voice.
    while (speed >= 40) {
        speed = speed * 906 / 1000;
        duration += 16;
    }
    return duration ? duration + 32 : 0;
}

static void measure(ht_scroll_t *g, int delta, uint32_t now)
{
    uint32_t dt = now - g->at;
    if (!dt) return;
    int speed = (int)((int64_t)delta * 1000 / dt);
    if (speed > MAX_SPEED) speed = MAX_SPEED;
    if (speed < -MAX_SPEED) speed = -MAX_SPEED;
    g->velocity = (3 * speed + 2 * g->velocity) / 5;
    g->at = now;
}
void ht_scroll_begin(ht_scroll_t *g, int x, int y, uint32_t now, bool reversed,
                     ht_scroll_emit_t emit, void *ctx)
{
    ht_scroll_cancel(g);
    *g = (ht_scroll_t){.sx = x, .sy = y, .y = y, .at = now,
                       .sign = reversed ? -1 : 1, .emit = emit, .ctx = ctx};
    // A touch stops the preceding fling immediately; movement waits for a direction claim.
    g->live = emit(HT_SCROLL_DOWN, 0, 0, ctx);
}
void ht_scroll_move(ht_scroll_t *g, int x, int y, uint32_t now)
{
    if (!g->live) return;
    if (!g->axis) {
        int dx = abs(x - g->sx), dy = abs(y - g->sy);
        if (dx >= CLAIM_PX && dx > dy) g->axis = 2;
        else if (dy >= CLAIM_PX && dy > dx) g->axis = 1;
    }
    if (g->axis == 2) return;
    g->pending += y - g->y;
    g->y = y;
    if (g->axis != 1) return;
    if (abs(g->pending) >= REPORT_PX || now - g->at >= REPORT_MS) {
        // Backpressure retains travel. The caller reserves room for the closing UP.
        if (!g->pending || g->emit(HT_SCROLL_MOVE, g->sign * g->pending, 0, g->ctx)) {
            measure(g, g->pending, now);
            g->pending = 0;
        }
    }
}
bool ht_scroll_end(ht_scroll_t *g, int x, int y, uint32_t now)
{
    if (!g->live) return false;
    ht_scroll_move(g, x, y, now);
    if (!g->live) return false;
    bool claimed = g->axis == 1;
    if (claimed) measure(g, g->pending, now);
    g->emit(HT_SCROLL_UP, claimed ? g->sign * g->pending : 0,
            claimed ? g->sign * g->velocity : 0, g->ctx);
    g->live = false;
    return claimed;
}
void ht_scroll_cancel(ht_scroll_t *g)
{
    if (g->live) g->emit(HT_SCROLL_UP, 0, 0, g->ctx);
    g->live = false;
}
