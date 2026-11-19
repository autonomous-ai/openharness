// The turn between the landscape glass and the portrait panel (main/display/max_turn.c): points, rectangles, the
// pixels of a strip, and the touch coming back. Built alone: cc ... -I main/display main/display/max_turn.c this.
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>

#include "max_turn.h"

static int checks;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #c); abort(); } checks++; } while (0)

enum { W = MAX_GLASS_W, H = MAX_GLASS_H };

// Where the design puts landscape (x, y) on the panel, (H - 1 - y, x), turned 180 degrees more when flipped.
static void expect_point(int x, int y, int px, int py)
{
    if (MAX_TURN_FLIPPED) {
        px = H - 1 - px;
        py = W - 1 - py;
    }
    int gx = -1, gy = -1;
    max_turn_point(x, y, &gx, &gy);
    CHECK(gx == px && gy == py);
}

static bool same_rect(max_rect_t a, max_rect_t b) { return a.x == b.x && a.y == b.y && a.w == b.w && a.h == b.h; }

static void test_corners_and_edges(void)
{
    expect_point(0, 0, H - 1, 0);            // top left of the glass
    expect_point(W - 1, 0, H - 1, W - 1);    // top right
    expect_point(0, H - 1, 0, 0);            // bottom left
    expect_point(W - 1, H - 1, 0, W - 1);    // bottom right
    expect_point(W / 2, 0, H - 1, W / 2);    // the middle of each edge
    expect_point(W / 2, H - 1, 0, W / 2);
    expect_point(0, H / 2, H / 2 - 1, 0);
    expect_point(W - 1, H / 2, H / 2 - 1, W - 1);
    expect_point(611, 33, H - 34, 611);      // and somewhere odd inside
}

// Every pixel of the turned rectangle holds the landscape pixel the point turn sends there, and the rectangle is
// exactly the set of turned points.
static void check_rect(max_rect_t g)
{
    static uint16_t src[W * 24], dst[W * 24];
    CHECK(g.w * g.h <= W * 24);
    for (int r = 0; r < g.h; r++)
        for (int c = 0; c < g.w; c++) src[r * g.w + c] = (uint16_t)((g.y + r) * 7919 + (g.x + c) * 31);
    for (int i = 0; i < g.w * g.h; i++) dst[i] = 0xdead;
    const max_rect_t p = max_turn_rect(g);
    CHECK(p.w == g.h && p.h == g.w);
    CHECK(p.x >= 0 && p.y >= 0 && p.x + p.w <= H && p.y + p.h <= W);
    max_turn_pixels(src, g.w, g.h, dst);
    for (int r = 0; r < g.h; r++)
        for (int c = 0; c < g.w; c++) {
            int px = -1, py = -1;
            max_turn_point(g.x + c, g.y + r, &px, &py);
            CHECK(px >= p.x && px < p.x + p.w && py >= p.y && py < p.y + p.h);
            CHECK(dst[(py - p.y) * p.w + (px - p.x)] == src[r * g.w + c]);
        }
}

static void test_one_pixel(void)
{
    const max_rect_t g = {5, 7, 1, 1};
    int px, py;
    max_turn_point(5, 7, &px, &py);
    CHECK(same_rect(max_turn_rect(g), (max_rect_t){px, py, 1, 1}));
    const uint16_t one = 0xbeef;
    uint16_t out = 0;
    max_turn_pixels(&one, 1, 1, &out);
    CHECK(out == 0xbeef);
    check_rect(g);
    check_rect((max_rect_t){W - 1, H - 1, 1, 1});   // the far corner
}

static void test_strips(void)
{
    // A full 24-line strip at the top, one inside, the last one at the bottom: each a full-height band of the panel.
    const max_rect_t top = {0, 0, W, 24}, mid = {0, 24, W, 24}, bottom = {0, H - 24, W, 24};
    check_rect(top);
    check_rect(mid);
    check_rect(bottom);
    CHECK(same_rect(max_turn_rect(top), MAX_TURN_FLIPPED ? (max_rect_t){0, 0, 24, W} : (max_rect_t){H - 24, 0, 24, W}));
    CHECK(same_rect(max_turn_rect(bottom), MAX_TURN_FLIPPED ? (max_rect_t){H - 24, 0, 24, W} : (max_rect_t){0, 0, 24, W}));
    // Damage rectangles of any shape: narrow and tall, wide and short, odd bounds.
    check_rect((max_rect_t){611, 33, 77, 11});
    check_rect((max_rect_t){0, 100, 3, 24});
    check_rect((max_rect_t){1900, 470, 20, 10});
}

// The P4's PPA turns a block counter-clockwise by a quarter or three (driver/ppa.h, PPA_SRM_ROTATION_ANGLE_90/270),
// as seen on a raster whose rows run down: one quarter takes (x, y) of a w x h block to (y, w - 1 - x) of an h x w one.
// MAX_TURN_CCW_DEGREES is the angle the PPA path asks for; turned that way, every strip must be max_turn_pixels'.
static void ccw(const uint16_t *src, int w, int h, int degrees, uint16_t *dst)
{
    for (int y = 0; y < h; y++)
        for (int x = 0; x < w; x++) {
            int px = x, py = y, pw = w;
            for (int q = 0; q < degrees / 90; q++) {
                const int nx = py, ny = pw - 1 - px;
                pw = pw == w ? h : w;
                px = nx, py = ny;
            }
            dst[py * pw + px] = src[y * w + x];
        }
}

static void test_ppa_angle(void)
{
    CHECK(MAX_TURN_CCW_DEGREES == 90 || MAX_TURN_CCW_DEGREES == 270);
    static uint16_t src[W * 24], cpu[W * 24], ppa[W * 24];
    const int shapes[][2] = {{W, 24}, {77, 11}, {3, 24}, {20, 10}, {1, 1}, {2, 2}};
    for (size_t s = 0; s < sizeof shapes / sizeof shapes[0]; s++) {
        const int w = shapes[s][0], h = shapes[s][1];
        for (int i = 0; i < w * h; i++) src[i] = (uint16_t)(i * 2654435761u >> 16);
        max_turn_pixels(src, w, h, cpu);
        ccw(src, w, h, MAX_TURN_CCW_DEGREES, ppa);
        for (int i = 0; i < w * h; i++) CHECK(ppa[i] == cpu[i]);
    }
}

static void test_touch_round_trip(void)
{
    for (int y = 0; y < H; y += 7)
        for (int x = 0; x < W; x += 13) {
            int px, py, bx, by;
            max_turn_point(x, y, &px, &py);
            CHECK(px >= 0 && px < H && py >= 0 && py < W);
            max_turn_touch(px, py, &bx, &by);
            CHECK(bx == x && by == y);
        }
    // The panel's corners come back as the glass's corners.
    int x, y;
    max_turn_touch(0, 0, &x, &y);
    CHECK(MAX_TURN_FLIPPED ? (x == W - 1 && y == 0) : (x == 0 && y == H - 1));
    max_turn_touch(H - 1, W - 1, &x, &y);
    CHECK(MAX_TURN_FLIPPED ? (x == 0 && y == H - 1) : (x == W - 1 && y == 0));
}

int main(void)
{
    test_corners_and_edges();
    test_one_pixel();
    test_strips();
    test_touch_round_trip();
    test_ppa_angle();
    printf("test_max_turn: %d checks passed\n", checks);
    return 0;
}
