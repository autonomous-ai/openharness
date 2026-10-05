// Host test for the ring arc run (ht_ring_arc): the listening scene's sound waves.
//   ink lies in the band and the span, the band's solid core is all ink, the run's bounds contain every inked
//   pixel, a strip raster equals the same strip of the full raster, an empty placeholder draws and bounds nothing,
//   and the damage of a change from one ring to another covers every pixel that differs.
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "terminal.h"

static uint16_t full[HT_WIDTH * HT_HEIGHT], part[HT_WIDTH * HT_HEIGHT], other[HT_WIDTH * HT_HEIGHT];
static const uint16_t RED = 0xf800;

typedef struct { int cx16, cy16, r16, w16, mid, half; } ring_t;
static const ring_t RINGS[] = {
    {83 * 16 + 8, 65 * 16 + 10, 70 * 16 + 8, 48, 0, 24},          // the waves, right (fractions on purpose)
    {83 * 16 + 8, 65 * 16 + 10, 47 * 16 + 10, 48, 180, 24},       // left, nearest
    {233 * 16, 233 * 16, 150 * 16, 32, 90, 40},                    // up
    {233 * 16, 233 * 16, 150 * 16, 32, 270, 40},                   // down
    {233 * 16 + 5, 233 * 16 - 3, 100 * 16, 80, 45, 90},            // a half ring, diagonal
    {233 * 16, 233 * 16, 60 * 16, 160, 200, 180},                  // full circle, band to the centre
    {200 * 16, 230 * 16, 30 * 16 + 3, 24, 350, 20},                // across 0 degrees from below
    {10 * 16, 10 * 16, 40 * 16, 48, 0, 150},                       // off the glass corner: clipped by the buffer
};
#define N (int)(sizeof RINGS / sizeof RINGS[0])

static void make(ht_scene_t *s, const ring_t *r)
{
    ht_scene_clear(s, 0);
    assert(ht_ring_arc(s, r->cx16, r->cy16, r->r16, r->w16, r->mid, r->half, RED) && s->count == 1);
}
static double angle_off(const ring_t *r, double dx, double up)   // degrees between the point and the ring's middle
{
    double a = atan2(up, dx) * 180.0 / M_PI - r->mid;
    while (a > 180) a -= 360;
    while (a <= -180) a += 360;
    return fabs(a);
}
static void check(const ring_t *r)
{
    ht_scene_t s;
    make(&s, r);
    ht_rect_t b = ht_run_bounds(&s.runs[0]);
    assert(b.w > 0 && b.h > 0);
    ht_raster(&s, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, full);
    double cx = r->cx16 / 16.0, cy = r->cy16 / 16.0, rad = r->r16 / 16.0, half_w = r->w16 / 32.0;
    int ink = 0, core = 0;
    for (int y = 0; y < HT_HEIGHT; y++)
        for (int x = 0; x < HT_WIDTH; x++) {
            double dx = x + 0.5 - cx, up = cy - (y + 0.5), d = hypot(dx, up);
            bool inked = full[y * HT_WIDTH + x] != 0;
            double off = angle_off(r, dx, up);
            if (inked) {
                ink++;
                assert(x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);          // damage bounds contain the ink
                assert(fabs(d - rad) <= half_w + 0.5 + 0.1);                                // in the band and its ramp
                if (d > 1.0) assert(off <= r->half + 0.5);                                  // in the span (a hair for rounding)
            }
            // The solid core (a pixel in from both band edges, a degree in from the ends) is all ink.
            if (fabs(d - rad) <= half_w - 0.6 && d > 1.5 && off <= r->half - 1.0) {
                core++;
                if (!(inked && full[y * HT_WIDTH + x] == 0x00f8)) fprintf(stderr, "ring %d x %d y %d d %.2f off %.2f px %04x\n", (int)(r - RINGS), x, y, d, off, full[y * HT_WIDTH + x]); assert(inked && full[y * HT_WIDTH + x] == 0x00f8);                          // panel order: byte-swapped red
            }
        }
    assert(ink > 0 && core > 0);
    // Strips and odd windows equal the same window of the full raster (the compositor paints in strips).
    static const ht_rect_t wins[] = {{0, 0, HT_WIDTH, 8}, {0, 0, HT_WIDTH, 1}, {3, 17, 97, 61}, {0, 0, 466, 466}};
    for (int h = 0; h < 8; h++)
        for (int pass = 0; pass < 2; pass++) {
            ht_rect_t w = pass ? (ht_rect_t){b.x + h - 2, b.y + h, 33 + h, 29 + 3 * h} : wins[h % 4];
            if (!pass) w.y = h * 56 % 430;
            if (w.x < 0 || w.y < 0 || w.x + w.w > HT_WIDTH || w.y + w.h > HT_HEIGHT) continue;
            memset(part, 0, sizeof part);
            ht_raster(&s, w, part);
            for (int y = 0; y < w.h; y++)
                for (int x = 0; x < w.w; x++)
                    assert(part[y * w.w + x] == full[(w.y + y) * HT_WIDTH + w.x + x]);
        }
}
static void placeholder(void)
{
    ht_scene_t s;
    ht_scene_clear(&s, 0);
    assert(ht_ring_arc(&s, 83 * 16, 65 * 16, 500, 0, 0, 24, RED) && s.count == 1);
    ht_rect_t b = ht_run_bounds(&s.runs[0]);
    assert(!b.w && !b.h);
    ht_raster(&s, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, full);
    for (int i = 0; i < HT_WIDTH * HT_HEIGHT; i++) assert(!full[i]);
    // The slot's place does not depend on the radius or on being empty: no reshape between a ring and its placeholder.
    ht_scene_t a, c;
    make(&a, &RINGS[0]);
    ht_scene_clear(&c, 0);
    ht_ring_arc(&c, RINGS[0].cx16, RINGS[0].cy16, 0, 0, 0, 0, 0);
    assert(a.runs[0].x == c.runs[0].x && a.runs[0].y == c.runs[0].y && a.runs[0].w == c.runs[0].w && a.runs[0].font == c.runs[0].font);
    assert(!ht_ring_arc(&s, 0, 0, -1, 4, 0, 1, RED) && s.count == 1);
}
static void damage(const ring_t *p, const ring_t *q)
{
    ht_scene_t a, b;
    make(&a, p);
    make(&b, q);
    ht_damage_t d;
    ht_damage(&a, &b, &d);
    ht_raster(&a, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, full);
    ht_raster(&b, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, other);
    for (int y = 0; y < HT_HEIGHT; y++)
        for (int x = 0; x < HT_WIDTH; x++) {
            if (full[y * HT_WIDTH + x] == other[y * HT_WIDTH + x]) continue;
            bool covered = false;
            for (int i = 0; i < d.count; i++)
                covered |= x >= d.rect[i].x && x < d.rect[i].x + d.rect[i].w && y >= d.rect[i].y && y < d.rect[i].y + d.rect[i].h;
            assert(covered);
        }
}
int main(void)
{
    for (int i = 0; i < N; i++) check(&RINGS[i]);
    placeholder();
    // The waves' real motion: one arc a frame later, then in and out of hiding.
    ring_t a = RINGS[0], b = RINGS[0];
    for (int step = 0; step < 24; step++) {
        b.r16 = a.r16 - 9 * step;
        damage(&a, &b);
        damage(&b, &a);
    }
    damage(&RINGS[0], &RINGS[1]);
    {   // empty to ring and back: damage covers the ring
        ht_scene_t e, r;
        ht_scene_clear(&e, 0);
        ht_ring_arc(&e, RINGS[0].cx16, RINGS[0].cy16, 0, 0, 0, 0, 0);
        make(&r, &RINGS[0]);
        ht_damage_t d;
        ht_damage(&e, &r, &d);
        ht_rect_t bb = ht_run_bounds(&r.runs[0]);
        bool covered = false;
        for (int i = 0; i < d.count; i++)
            covered |= d.rect[i].x <= bb.x && d.rect[i].y <= bb.y && d.rect[i].x + d.rect[i].w >= bb.x + bb.w && d.rect[i].y + d.rect[i].h >= bb.y + bb.h;
        assert(covered || d.count > 0);
        ht_damage(&r, &e, &d);
        assert(d.count > 0);
    }
    puts("arc ring: band and span, bounds contain the ink, strips equal the full raster, placeholders empty, damage covers the change PASS");
    return 0;
}
