// The Max's glass shrunk into a band of the Harness Pro's panel (on-pro/main/max_shrink.c): blocks, where they land, the
// area average, the touch coming back and a frame's damage. Built alone: cc ... -I on-pro/main on-pro/main/max_shrink.c
// this.
#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "max_shrink.h"

static int checks;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #c); abort(); } checks++; } while (0)

enum { GW = MAX_SHRINK_GLASS_W, GH = MAX_SHRINK_GLASS_H, BW = MAX_SHRINK_BAND_W, BH = MAX_SHRINK_BAND_H };

static uint16_t glass[GW * GH];
static uint16_t full[BW * BH], part[BW * BH];

static bool same(max_shrink_rect_t a, max_shrink_rect_t b) { return a.x == b.x && a.y == b.y && a.w == b.w && a.h == b.h; }
static max_shrink_rect_t R(int x, int y, int w, int h) { return (max_shrink_rect_t){x, y, w, h}; }
static const max_shrink_rect_t WHOLE = {0, 0, GW, GH};

static uint32_t seed = 0x2545F491u;
static uint16_t rnd16(void)
{
    seed = seed * 1664525u + 1013904223u;
    return (uint16_t)(seed >> 16);
}

static void test_band(void)
{
    CHECK(BW == 720 && BH == 180 && MAX_SHRINK_BAND_Y == 270);   // the whole width, centred top to bottom
    CHECK(same(max_shrink_panel(WHOLE), R(0, 270, 720, 180)));
    CHECK(same(max_shrink_panel(R(8, 16, 24, 8)), R(3, 276, 9, 3)));
    CHECK(same(max_shrink_panel(R(GW - 8, GH - 8, 8, 8)), R(717, 447, 3, 3)));   // the last block, the band's last cells
}

static void test_blocks(void)
{
    CHECK(same(max_shrink_blocks(WHOLE), WHOLE));
    CHECK(same(max_shrink_blocks(R(16, 8, 24, 16)), R(16, 8, 24, 16)));   // whole blocks already
    CHECK(same(max_shrink_blocks(R(9, 7, 1, 2)), R(8, 0, 8, 16)));        // grown out to the blocks it touches
    CHECK(same(max_shrink_blocks(R(15, 15, 2, 2)), R(8, 8, 16, 16)));     // a corner of four blocks
    CHECK(same(max_shrink_blocks(R(-5, -5, 10, 10)), R(0, 0, 8, 8)));     // clipped to the glass
    CHECK(same(max_shrink_blocks(R(GW - 3, GH - 1, 50, 50)), R(GW - 8, GH - 8, 8, 8)));
    CHECK(max_shrink_blocks(R(GW, 0, 10, 10)).w == 0);                    // off the glass: nothing
    CHECK(max_shrink_blocks(R(0, -20, 10, 20)).w == 0);
    CHECK(max_shrink_blocks(R(5, 5, 0, 7)).w == 0);                       // empty
}

static void unpack(uint16_t c, int ch[3]) { ch[0] = c >> 11, ch[1] = (c >> 5) & 63, ch[2] = c & 31; }

// How much of glass pixel g lies under band pixel b along one axis: [g, g + 1) against [8b / 3, 8(b + 1) / 3).
static double cover(int g, int b)
{
    const double lo = fmax(g, b * 8.0 / 3), hi = fmin(g + 1, (b + 1) * 8.0 / 3);
    return hi > lo ? hi - lo : 0;
}

// Every band pixel of `out` (rows of `bands.w`, at panel rectangle `bands`) is the area average of the glass under it,
// rounded half up, channel by channel in RGB565's own depths.
static void expect_average(const uint16_t *out, max_shrink_rect_t bands)
{
    for (int by = 0; by < bands.h; by++)
        for (int bx = 0; bx < bands.w; bx++) {
            const int px = bands.x + bx, py = bands.y - MAX_SHRINK_BAND_Y + by;
            double sum[3] = {0, 0, 0};
            for (int gy = py * 8 / 3; gy <= (py + 1) * 8 / 3 && gy < GH; gy++)
                for (int gx = px * 8 / 3; gx <= (px + 1) * 8 / 3 && gx < GW; gx++) {
                    const double k = cover(gx, px) * cover(gy, py);
                    int ch[3];
                    unpack(glass[gy * GW + gx], ch);
                    for (int c = 0; c < 3; c++) sum[c] += k * ch[c];
                }
            int got[3];
            unpack(out[by * bands.w + bx], got);
            for (int c = 0; c < 3; c++) CHECK(fabs(got[c] - sum[c] * 9 / 64) <= 0.5 + 1e-9);
        }
}

static void test_solid(void)
{
    // A flat colour comes out as itself, every depth's extremes included.
    const uint16_t colours[] = {0x0000, 0xFFFF, 0xF800, 0x07E0, 0x001F, 0x8410, 0x2945, 0x7BEF};
    for (size_t i = 0; i < sizeof colours / sizeof colours[0]; i++) {
        for (int p = 0; p < GW * GH; p++) glass[p] = colours[i];
        max_shrink_paint(glass, WHOLE, full);
        for (int p = 0; p < BW * BH; p++) CHECK(full[p] == colours[i]);
    }
}

static void test_average(void)
{
    for (int p = 0; p < GW * GH; p++) glass[p] = rnd16();
    max_shrink_paint(glass, WHOLE, full);
    expect_average(full, max_shrink_panel(WHOLE));
}

static void test_part_is_the_whole(void)
{
    // A few blocks repaint exactly what the whole glass paints there: a block reads only its own glass.
    for (int p = 0; p < GW * GH; p++) glass[p] = rnd16();
    max_shrink_paint(glass, WHOLE, full);
    const max_shrink_rect_t parts[] = {R(0, 0, 8, 8), R(8, 472, 1912, 8), R(1000, 96, 64, 200), R(1912, 0, 8, 480)};
    for (size_t i = 0; i < sizeof parts / sizeof parts[0]; i++) {
        const max_shrink_rect_t at = max_shrink_panel(parts[i]);
        memset(part, 0, sizeof part);
        max_shrink_paint(glass, parts[i], part);
        for (int y = 0; y < at.h; y++)
            for (int x = 0; x < at.w; x++)
                CHECK(part[y * at.w + x] == full[(at.y - MAX_SHRINK_BAND_Y + y) * BW + at.x + x]);
    }
}

static void test_thin_lines(void)
{
    // A one-pixel line, white on black, at any of a block's eight columns (rows) still shows: 3/8 of its light (green
    // 24 of 63) in a band pixel wholly over it, 1/4 (16) in the brighter of two it straddles.
    for (int off = 0; off < 8; off++) {
        memset(glass, 0, sizeof glass);
        for (int y = 0; y < GH; y++) glass[y * GW + 800 + off] = 0xFFFF;
        max_shrink_paint(glass, WHOLE, full);
        int brightest = 0;
        for (int x = 0; x < BW; x++) {
            int ch[3];
            unpack(full[90 * BW + x], ch);
            if (ch[1] > brightest) brightest = ch[1];
        }
        CHECK(brightest >= 16 && brightest <= 24);
    }
    for (int off = 0; off < 8; off++) {
        memset(glass, 0, sizeof glass);
        for (int x = 0; x < GW; x++) glass[(200 + off) * GW + x] = 0xFFFF;
        max_shrink_paint(glass, WHOLE, full);
        int brightest = 0;
        for (int y = 0; y < BH; y++) {
            int ch[3];
            unpack(full[y * BW + 360], ch);
            if (ch[1] > brightest) brightest = ch[1];
        }
        CHECK(brightest >= 16 && brightest <= 24);
    }
}

static void test_touch(void)
{
    int gx = -1, gy = -1;
    CHECK(max_shrink_touch(0, MAX_SHRINK_BAND_Y, &gx, &gy) && gx == 1 && gy == 1);   // the band's top left
    CHECK(max_shrink_touch(BW - 1, MAX_SHRINK_BAND_Y + BH - 1, &gx, &gy) && gx == GW - 2 && gy == GH - 2);
    CHECK(max_shrink_touch(360, 360, &gx, &gy) && gx == 961 && gy == 241);   // the panel's middle, the glass's
    // Off the band: above, below and beside it.
    CHECK(!max_shrink_touch(100, MAX_SHRINK_BAND_Y - 1, &gx, &gy));
    CHECK(!max_shrink_touch(100, MAX_SHRINK_BAND_Y + BH, &gx, &gy));
    CHECK(!max_shrink_touch(-1, 300, &gx, &gy));
    CHECK(!max_shrink_touch(BW, 300, &gx, &gy));
    CHECK(!max_shrink_touch(100, 0, &gx, &gy) && !max_shrink_touch(100, MAX_SHRINK_PANEL - 1, &gx, &gy));
    // Every band pixel goes back to a glass point under it.
    for (int py = MAX_SHRINK_BAND_Y; py < MAX_SHRINK_BAND_Y + BH; py++)
        for (int px = 0; px < BW; px++) {
            CHECK(max_shrink_touch(px, py, &gx, &gy));
            const int by = py - MAX_SHRINK_BAND_Y;
            CHECK(gx >= 0 && gx < GW && gy >= 0 && gy < GH);
            CHECK(cover(gx, px) > 0 && cover(gy, by) > 0);
        }
}

static bool inside(max_shrink_rect_t in, max_shrink_rect_t out)
{
    return in.x >= out.x && in.y >= out.y && in.x + in.w <= out.x + out.w && in.y + in.h <= out.y + out.h;
}

static void test_damage(void)
{
    max_shrink_damage_t d = {0};
    // The strips of one change are one rectangle.
    for (int y = 100; y < 200; y += 12) max_shrink_damage_add(&d, R(50, y, 300, 12));
    CHECK(d.n == 1 && same(d.r[0], R(48, 96, 304, 112)));
    // A change inside it adds nothing; one at the far end is kept apart.
    max_shrink_damage_add(&d, R(60, 120, 5, 5));
    CHECK(d.n == 1);
    max_shrink_damage_add(&d, R(1700, 300, 40, 40));
    CHECK(d.n == 2 && same(d.r[1], R(1696, 296, 48, 48)));
    // Nothing on the glass adds nothing.
    max_shrink_damage_add(&d, R(GW + 5, 0, 10, 10));
    max_shrink_damage_add(&d, R(10, 10, 0, 0));
    CHECK(d.n == 2);

    // Far more changes than rectangles: at most MAX_SHRINK_RECTS, whole blocks, and every change inside one of them.
    max_shrink_damage_t m = {0};
    max_shrink_rect_t added[40];
    for (int i = 0; i < 40; i++) {
        added[i] = R(rnd16() % (GW - 64), rnd16() % (GH - 32), 1 + rnd16() % 64, 1 + rnd16() % 32);
        max_shrink_damage_add(&m, added[i]);
        CHECK(m.n >= 1 && m.n <= MAX_SHRINK_RECTS);
    }
    for (int k = 0; k < m.n; k++) CHECK(same(max_shrink_blocks(m.r[k]), m.r[k]));
    for (int i = 0; i < 40; i++) {
        bool covered = false;
        for (int k = 0; k < m.n; k++) covered = covered || inside(max_shrink_blocks(added[i]), m.r[k]);
        CHECK(covered);
    }
}

int main(void)
{
    test_band();
    test_blocks();
    test_solid();
    test_average();
    test_part_is_the_whole();
    test_thin_lines();
    test_touch();
    test_damage();
    printf("test_max_shrink: %d checks passed\n", checks);
    return 0;
}
