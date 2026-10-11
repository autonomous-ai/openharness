#include "scroll.h"
#include "terminal.h"   // HT_WIDTH / HT_FACE_PX: a rim is a property of the face
#include <stdlib.h>

#define CLAIM_PX 24
#define REPORT_PX 8
#define REPORT_MS 16
#define MAX_SPEED 6000

bool ht_scroll_on_rim(int x, int y)
{
#if HT_FACE_PX >= 720
    /*
     * A SQUARE HAS NO RIM, so nothing is ever on it.
     *
     * The annulus below is a 466 circle's: centred on (233,233) with radii 178..233. Left alone on a
     * 720 face it keeps that centre, so the band lands in the top-left quadrant and sweeps straight
     * across the screen — and a press that starts on the rim is cancelled by the app layer. The symptom is not a wrong scroll. It is taps over a third of
     * the screen doing nothing at all, which is precisely what the first Pro build did.
     *
     * Returning false here also makes bearing() and the rim_radius bookkeeping dead on this board:
     * they are only ever reached through a rim candidate.
     */
    (void)x; (void)y;
    return false;
#else
    x -= 233; y -= 233;
    int r = x * x + y * y;
    return r >= 178 * 178 && r <= 233 * 233;
#endif
}
// Monotonic octant approximation: 1024 units per turn, clockwise. No trig/FPU in touch.
static int bearing(int x, int y)
{
    x -= 233; y -= 233;
    int ax = abs(x), ay = abs(y);
    int angle = ax >= ay ? (ax ? 128 * ay / ax : 0) : 256 - 128 * ax / ay;
    if (x < 0) angle = 512 - angle;
    if (y < 0) angle = 1024 - angle;
    return angle & 1023;
}

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
void ht_scroll_begin(ht_scroll_t *g, int x, int y, uint32_t now, bool reversed, bool rim_enabled,
                     ht_scroll_emit_t emit, void *ctx)
{
    ht_scroll_cancel(g);
    *g = (ht_scroll_t){.sx = x, .sy = y, .y = y, .at = now,
                       .sign = reversed ? -1 : 1, .emit = emit, .ctx = ctx};
    g->rim_candidate = rim_enabled && ht_scroll_on_rim(x, y);
    g->rim_angle = bearing(x, y);
    g->rim_radius = (x - 233) * (x - 233) + (y - 233) * (y - 233);
    // A touch stops the preceding fling immediately; movement waits for a direction claim.
    g->live = emit(HT_SCROLL_DOWN, 0, 0, ctx);
}
void ht_scroll_move(ht_scroll_t *g, int x, int y, uint32_t now)
{
    if (!g->live) return;
    if (g->rim_candidate) {
        int r = (x - 233) * (x - 233) + (y - 233) * (y - 233);
        int angle = bearing(x, y), delta = (angle - g->rim_angle + 1536) % 1024 - 512;
        if (r < 155 * 155 || r > 238 * 238 || abs(r - g->rim_radius) > 15000 || abs(delta) > 128) {
            ht_scroll_cancel(g); // a radial stroke or bad sample cannot become a pane swipe
            return;
        }
        g->rim_angle = angle;
        if (!g->axis) g->rim_travel += delta;
        g->rim_remainder -= delta * 600; // clockwise reads further down; 600 glass px/turn
        g->pending += g->rim_remainder / 1024;
        g->rim_remainder %= 1024;
        if (abs(g->pending) > 2048) {
            ht_scroll_cancel(g); // bounded backpressure; never emit an unbounded desktop jump
            return;
        }
        if (!g->axis && abs(g->rim_travel) >= 48) g->axis = 3;
        if (g->axis == 3 && (abs(g->pending) >= REPORT_PX || now - g->at >= REPORT_MS)) {
            if (!g->pending || g->emit(HT_SCROLL_MOVE, g->sign * g->pending, 0, g->ctx)) {
                g->pending = 0;
                g->at = now;
            }
        }
        return;
    }
    if (!g->axis) {
        int dx = abs(x - g->sx), dy = abs(y - g->sy);
        if (dx >= CLAIM_PX && dx * 4 > dy * 5) g->axis = 2;
        else if (dy >= CLAIM_PX && dy * 4 > dx * 5) g->axis = 1;
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
    if (!g->live) return g->rim_candidate;
    ht_scroll_move(g, x, y, now);
    if (!g->live) return g->rim_candidate;
    bool claimed = g->axis == 1 || g->axis == 3;
    if (claimed) measure(g, g->pending, now);
    if (g->rim_candidate) g->velocity = 0; // a wheel stops under the finger, without a fling
    g->emit(HT_SCROLL_UP, claimed ? g->sign * g->pending : 0,
            claimed ? g->sign * g->velocity : 0, g->ctx);
    g->live = false;
    return claimed || g->rim_candidate;
}
void ht_scroll_cancel(ht_scroll_t *g)
{
    if (g->live) g->emit(HT_SCROLL_UP, 0, 0, g->ctx);
    g->live = false;
}
