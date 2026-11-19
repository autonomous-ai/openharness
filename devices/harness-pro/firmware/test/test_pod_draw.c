// Task 3: Pod's cell sprite, ring arc and gradient runs.
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "pod/pod_draw.h"
#include "pro_canvas.h"

static int checks;
#define CHECK(c) do { assert(c); checks++; } while (0)

enum { W = 64, H = 64 };
static uint16_t buf[W * H];
static const ht_rect_t clip = {0, 0, W, H};

static void draw(const ht_scene_t *s)
{
    memset(buf, 0, sizeof buf);
    for (int i = 0; i < s->count; i++) ht_pro_raster(&s->runs[i], clip, buf);
}
static void draw_over(const ht_scene_t *s, uint16_t ground)
{
    for (int i = 0; i < W * H; i++) buf[i] = ground;
    for (int i = 0; i < s->count; i++) ht_pro_raster(&s->runs[i], clip, buf);
}
static uint16_t px(int x, int y) { return buf[y * W + x]; }

static void draw_test_cell_plain_and_packed(void)
{
    static const uint16_t pal[] = {0, 0xe0ff};
    static const uint8_t plain[] = {0, 1, 0, 0};          // 2 x 2: (1,0) opaque
    ht_cell_frame_t f = {2, 2, 4, pal, plain, NULL};
    CHECK(ht_cell_at(&f, 1, 0) == 1 && ht_cell_at(&f, 0, 0) == 0 && ht_cell_at(&f, 2, 0) == 0);
    ht_scene_t s; ht_scene_clear(&s, 0);
    CHECK(pod_cell(&s, 10, 10, &f, 8));
    draw(&s);
    CHECK(px(14, 10) == ht_rgb(0xffff00));
    CHECK(px(17, 13) == ht_rgb(0xffff00));
    CHECK(px(10, 10) == 0);
    CHECK(px(14, 14) == 0);
    CHECK(px(18, 10) == 0);

    // Packed: row 0 = skip 1, 1 opaque (index 1); row 1 = skip 2, 0 opaque.
    static const uint8_t packed[] = {1, 1, 1, 2, 0};
    static const uint16_t row_at[] = {0, 3};
    ht_cell_frame_t g = {2, 2, 4, pal, packed, row_at};
    CHECK(ht_cell_at(&g, 1, 0) == 1 && ht_cell_at(&g, 0, 0) == 0 && ht_cell_at(&g, 1, 1) == 0);
    ht_scene_clear(&s, 0);
    CHECK(pod_cell(&s, 10, 10, &g, 8));
    draw(&s);
    CHECK(px(14, 10) == ht_rgb(0xffff00));
    CHECK(px(10, 10) == 0);
    CHECK(px(14, 14) == 0);
}

// The art was anti-aliased toward black. Along the outside edge a dark colour is mixed toward white; a dark cell
// inside the shape (an eye) and a body colour keep theirs.
static void draw_test_edge_softening(void)
{
    static const uint16_t pal[] = {0, 0x0000, 0xe0ff};           // none, black, yellow (native 0xffe0 swapped)
    // 5 x 3 of yellow with black at (0,1), on the frame's border, and at (2,1), inside.
    static const uint8_t cells[] = {2,2,2,2,2,  1,2,1,2,2,  2,2,2,2,2};
    ht_cell_frame_t f = {5, 3, 1, pal, cells, NULL};
    ht_scene_t s; ht_scene_clear(&s, 0);
    CHECK(pod_cell(&s, 4, 4, &f, 8));
    draw(&s);
    CHECK(px(4 + 0, 4 + 1) == 0);                     // black on the edge over a black ground: mixed toward the ground, still black
    draw_over(&s, 0xffff);
    CHECK(px(4 + 0, 4 + 1) != 0 && px(4 + 0, 4 + 1) != 0xffff);   // over white: a grey
    draw(&s);
    CHECK(px(4 + 2, 4 + 1) == 0);                     // black inside: untouched
    CHECK(px(4 + 1, 4 + 1) == ht_rgb(0xffff00) && px(4 + 3, 4 + 1) == ht_rgb(0xffff00));   // yellow is above the body threshold
    // A black cell with four opaque neighbours is interior and stays black.
    static const uint8_t eye[] = {2,2,2,  2,1,2,  2,2,2};
    ht_cell_frame_t g = {3, 3, 1, pal, eye, NULL};
    ht_scene_clear(&s, 0);
    CHECK(pod_cell(&s, 4, 4, &g, 8));
    draw(&s);
    CHECK(px(4 + 1, 4 + 1) == 0);
    // And a transparent neighbour makes it an edge: the same black, lightened.
    static const uint8_t edge[] = {2,2,2,  0,1,2,  2,2,2};
    ht_cell_frame_t h = {3, 3, 1, pal, edge, NULL};
    ht_scene_clear(&s, 0);
    CHECK(pod_cell(&s, 4, 4, &h, 8));
    draw(&s);
    draw_over(&s, 0xffff);
    CHECK(px(4 + 1, 4 + 1) != 0);
    uint16_t light = px(4 + 1, 4 + 1);
    CHECK((light >> 11) >= 16 && (light >> 11) <= 20);  // 154/256 of the way to the (white) ground: a mid grey
}

// Edge softening mixes toward the pixel under the art, never toward a fixed white: over a lavender ground no pixel
// in the pet's box is white, and every pixel the art leaves empty is the ground, whichever ground it is.
static void draw_test_no_white_halo(void)
{
    static const uint16_t pal[] = {0, 0x0000, 0xe0ff};
    // A 6 x 6 blob: yellow body, black outline on its edge cells, a transparent corner and a transparent column.
    static const uint8_t cells[] = {0,1,1,1,1,0,  1,2,2,2,2,1,  1,2,2,2,2,1,  1,2,2,2,2,1,  1,2,2,2,2,1,  0,1,1,1,1,0};
    const uint16_t grounds[2] = {ht_rgb(0xe8ecf8), ht_rgb(0x203040)};
    uint16_t out[2][W * H];
    for (unsigned zoom = 4; zoom <= 8; zoom += 4) {
        ht_cell_frame_t f = {6, 6, 1, pal, cells, NULL};
        ht_scene_t s; ht_scene_clear(&s, 0);
        CHECK(pod_cell(&s, 10, 10, &f, zoom));
        for (int g = 0; g < 2; g++) { draw_over(&s, grounds[g]); memcpy(out[g], buf, sizeof buf); }
        int w = s.runs[0].w, h = s.runs[0].pro_height;
        for (int y = 10; y < 10 + h; y++)
            for (int x = 10; x < 10 + w; x++) {
                CHECK(out[0][y * W + x] != 0xffff);
                if (out[0][y * W + x] == grounds[0]) CHECK(out[1][y * W + x] == grounds[1]);   // empty over one ground is empty over the other
            }
        if (zoom == 8) {   // a black edge cell over the dark ground goes no lighter than the ground (it used to go toward white)
            uint16_t e = out[1][10 * W + 11], gd = grounds[1];
            CHECK((e >> 11) <= (gd >> 11) && ((e >> 5) & 63) <= ((gd >> 5) & 63) && (e & 31) <= (gd & 31));
        }
        if (zoom == 8) CHECK(out[0][10 * W + 10] == grounds[0] && out[1][10 * W + 10] == grounds[1]);   // the transparent corner
    }
}

static void draw_test_zoom(void)
{
    static const uint16_t pal[] = {0, 0xe0ff};
    static uint8_t cells[64];
    memset(cells, 1, sizeof cells);
    ht_cell_frame_t f = {8, 8, 1, pal, cells, NULL};
    ht_scene_t s; ht_scene_clear(&s, 0);
    CHECK(pod_cell(&s, 20, 20, &f, 4));
    CHECK(s.runs[0].w == 4 && s.runs[0].pro_height == 4);
    draw(&s);
    CHECK(px(20, 20) == ht_rgb(0xffff00));
    CHECK(px(23, 23) == ht_rgb(0xffff00));
    CHECK(px(24, 20) == 0);
    CHECK(px(20, 24) == 0);
    CHECK(px(19, 20) == 0);
    // A partly covered glass pixel blends toward what is already there, not toward black: a quarter of a red
    // source pixel over black is a dark yellow, over white a pale yellow, and the uncovered rest of a pixel keeps the ground.
    ht_cell_frame_t one = {1, 1, 1, pal, cells, NULL};
    ht_scene_clear(&s, 0);
    CHECK(pod_cell(&s, 5, 5, &one, 4));       // 1x1 source at 4/8: a quarter of the pixel covered
    draw(&s);
    uint16_t half = px(5, 5);
    CHECK(half != 0 && half != ht_rgb(0xffff00) && (half >> 11) >= 6 && (half >> 11) <= 10 && (half & 31) == 0);
    ht_scene_clear(&s, 0);
    CHECK(pod_cell(&s, 5, 5, &one, 4));
    memset(buf, 0xff, sizeof buf);            // the white glass under it
    for (int i = 0; i < s.count; i++) ht_pro_raster(&s.runs[i], clip, buf);
    uint16_t over_white = px(5, 5);
    CHECK((over_white >> 11) == 31 && ((over_white >> 5) & 63) == 63 && (over_white & 31) >= 22 && (over_white & 31) <= 25);
    CHECK(px(6, 5) == 0xffff && px(5, 6) == 0xffff);
    ht_scene_clear(&s, 0);
    CHECK(pod_cell(&s, 5, 5, &one, 2));       // 2/8 -> 1/16 of the pixel: nearly all ground
    memset(buf, 0xff, sizeof buf);
    for (int i = 0; i < s.count; i++) ht_pro_raster(&s.runs[i], clip, buf);
    CHECK(px(5, 5) != 0xffff && (px(5, 5) & 31) >= 28 && (px(5, 5) & 31) <= 30);
    CHECK(!pod_cell(&s, 5, 5, &one, 0));
}

static void draw_test_arc(void)
{
    ht_scene_t s; ht_scene_clear(&s, 0);
    int c16 = 32 * 16 + 8;
    CHECK(pod_arc(&s, c16, c16, 80, 192, 0, 180, ht_rgb(0x00ff00)));
    draw(&s);
    CHECK(px(32, 32) == ht_rgb(0x00ff00));
    CHECK(px(37, 32) == ht_rgb(0x00ff00));
    CHECK(px(32, 44) == 0);
    CHECK(px(44, 32) == 0);

    // A quarter slice (mid 90 = up, half 45) stays above the centre; hard ends.
    ht_scene_clear(&s, 0);
    CHECK(pod_arc(&s, c16, c16, 160, 64, 90, 45, ht_rgb(0xffffff)));
    draw(&s);
    CHECK(px(32, 22) == ht_rgb(0xffffff));   // straight up, 10 px
    CHECK(px(32, 42) == 0);                  // straight down
    CHECK(px(42, 32) == 0);                  // 3 o'clock is 90 degrees from mid
    // Anti-aliased across the band: just outside the outer edge is dim or empty, never full.
    CHECK(px(32, 19) != ht_rgb(0xffffff));

    ht_scene_clear(&s, 0);
    CHECK(pod_arc(&s, c16, c16, 160, 0, 0, 90, ht_rgb(0xffffff)));
    CHECK(s.count == 1 && s.runs[0].w == 0 && s.runs[0].pro_height == 0);
    draw(&s);
    CHECK(px(42, 32) == 0);
    ht_rect_t b = ht_run_bounds(&s.runs[0]);
    CHECK(b.w == 0 && b.h == 0);
}

static void draw_test_damage(void)
{
    static const uint16_t pal[] = {0, 0x00f8};
    static const uint8_t a[] = {1, 1, 1, 1}, b[] = {1, 0, 0, 1};
    ht_cell_frame_t fa = {2, 2, 4, pal, a, NULL}, fb = {2, 2, 4, pal, b, NULL};
    ht_scene_t s1, s2, s3;
    ht_scene_clear(&s1, 0); ht_scene_clear(&s2, 0); ht_scene_clear(&s3, 0);
    pod_cell(&s1, 4, 4, &fa, 8); pod_cell(&s2, 4, 4, &fb, 8); pod_cell(&s3, 4, 4, &fa, 8);
    ht_damage_t d;
    ht_damage(&s1, &s2, &d);
    CHECK(d.count > 0);
    ht_damage(&s1, &s3, &d);
    CHECK(d.count == 0);
    // Zoom and arc angle also change bytes.
    ht_scene_clear(&s1, 0); ht_scene_clear(&s2, 0);
    pod_cell(&s1, 4, 4, &fa, 8); pod_cell(&s2, 4, 4, &fa, 6);
    ht_damage(&s1, &s2, &d);
    CHECK(d.count > 0);
    ht_scene_clear(&s1, 0); ht_scene_clear(&s2, 0);
    pod_arc(&s1, 400, 400, 160, 64, 0, 40, 1); pod_arc(&s2, 400, 400, 160, 64, 0, 50, 1);
    ht_damage(&s1, &s2, &d);
    CHECK(d.count > 0);
}

static void draw_test_grad(void)
{
    ht_scene_t s; ht_scene_clear(&s, 0);
    uint16_t top = ht_rgb(0x5ea2f2), bot = ht_rgb(0x1f63d1);
    CHECK(pod_grad(&s, 10, 10, 30, 20, 0, top, bot));
    draw(&s);
    CHECK(px(20, 10) == top);
    CHECK(px(20, 29) == bot);
    CHECK(px(20, 20) != top && px(20, 20) != bot);
    CHECK(px(9, 10) == 0 && px(40, 10) == 0 && px(20, 30) == 0);
    ht_scene_clear(&s, 0);
    CHECK(pod_grad(&s, 10, 10, 30, 20, 8, top, bot));
    draw(&s);
    CHECK(px(10, 10) == 0);      // rounded corner
    CHECK(px(25, 10) == top);
    CHECK(!pod_grad(&s, 0, 0, 0, 5, 0, top, bot));
}


static void draw_test_grad_aa_corner(void)
{
    const uint16_t ground = 0x2104, ink = ht_rgb(0x2f6df0);
    static const int rads[] = {7, 13};
    for (unsigned k = 0; k < 2; k++) {
        static uint16_t want[W * H];
        ht_scene_t s; ht_scene_clear(&s, 0);
        CHECK(ht_pro_rect_aa(&s, 5, 6, 50, 40, rads[k], ink));
        draw_over(&s, ground);
        memcpy(want, buf, sizeof want);
        ht_scene_clear(&s, 0);
        pod_grad_aa(&s, 5, 6, 50, 40, rads[k], ink, ink);
        CHECK(s.count == 1);
        draw_over(&s, ground);
        CHECK(memcmp(want, buf, sizeof want) == 0);
    }
}
static void draw_test_grad_aa_rows(void)
{
    uint16_t top = ht_rgb(0x5ea2f2), bot = ht_rgb(0x1f63d1);
    static uint16_t big[20 * 100];
    ht_scene_t s; ht_scene_clear(&s, 0);
    pod_grad_aa(&s, 0, 0, 20, 100, 7, top, bot);
    CHECK(s.count == 1);
    memset(big, 0, sizeof big);
    ht_rect_t c = {0, 0, 20, 100};
    ht_pro_raster(&s.runs[0], c, big);
    uint16_t m = big[50 * 20 + 10];
    int rr = (top >> 11) + (bot >> 11), gg = ((top >> 5) & 63) + ((bot >> 5) & 63), bb = (top & 31) + (bot & 31);
    CHECK(abs((m >> 11) - rr / 2) <= 1 && abs(((m >> 5) & 63) - gg / 2) <= 1 && abs((m & 31) - bb / 2) <= 1);
    CHECK(big[0] == 0 && big[10] == top);
}

// pod_grad_aa_dither: a slow gradient (a few levels over 300 rows) alternates its two nearest levels instead of banding. Each 4 x 4 block
// averages to the exact channel value within one sixteenth of a level; no pixel is more than one level from it; mid-level rows are mixed.
static void draw_test_grad_aa_dither(void)
{
    enum { GW = 16, GH = 300 };
    const uint16_t top = ht_rgb(0x3a2c24), bot = ht_rgb(0x4a3a30);
    static uint16_t plain[GW * GH], dith[GW * GH];
    ht_scene_t s; ht_scene_clear(&s, 0);
    pod_grad_aa(&s, 0, 0, GW, GH, 0, top, bot);
    memset(plain, 0, sizeof plain);
    ht_rect_t c = {0, 0, GW, GH};
    ht_pro_raster(&s.runs[0], c, plain);
    ht_scene_clear(&s, 0);
    pod_grad_aa_dither(&s, 0, 0, GW, GH, 0, top, bot);
    CHECK(s.count == 1);
    memset(dith, 0, sizeof dith);
    ht_pro_raster(&s.runs[0], c, dith);
    int mixed_rows = 0, plain_mixed = 0;
    for (int y = 0; y < GH; y++) {
        const int last = GH - 1;
        unsigned lo = 0xffff, hi = 0;
        for (int x = 0; x < GW; x++) {
            unsigned v = dith[y * GW + x] >> 11;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
            if (plain[y * GW + x] != plain[y * GW]) plain_mixed++;
        }
        if (hi != lo) mixed_rows++;
        CHECK(hi - lo <= 1);   // never more than one level apart within a row
        double exact = ((top >> 11) * (double)(last - y) + (bot >> 11) * (double)y) / last;
        for (int x = 0; x < GW; x++) {
            double v = dith[y * GW + x] >> 11;
            CHECK(v >= exact - 1.0 && v <= exact + 1.0);
        }
    }
    CHECK(plain_mixed == 0);   // pod_grad_aa is untouched: one value per row, whole bands
    CHECK(mixed_rows > GH / 2);   // the dither pattern is present on most rows
    // 4 x 4 block means track the exact value within a sixteenth (+ a little rounding) for each channel.
    for (int y = 0; y + 4 <= GH; y += 4) {
        unsigned sr = 0, sg = 0, sb = 0;
        for (int dy = 0; dy < 4; dy++) for (int dx = 0; dx < 4; dx++) {
            uint16_t v = dith[(y + dy) * GW + dx];
            sr += v >> 11; sg += (v >> 5) & 63; sb += v & 31;
        }
        double mid = y + 1.5, last = GH - 1;
        double er = ((top >> 11) * (last - mid) + (bot >> 11) * mid) / last;
        double eg = (((top >> 5) & 63) * (last - mid) + ((bot >> 5) & 63) * mid) / last;
        double eb = ((top & 31) * (last - mid) + (bot & 31) * mid) / last;
        CHECK(fabs(sr / 16.0 - er) < 0.35 && fabs(sg / 16.0 - eg) < 0.35 && fabs(sb / 16.0 - eb) < 0.35);
    }
}

static void draw_test_tri(void)
{
    ht_scene_t s; ht_scene_clear(&s, 0);
    uint16_t ink = ht_rgb(0xffffff);
    // Legs along x = 10 and y = 10, hypotenuse x + y = 60 (pixel centres sit at +0.5).
    CHECK(pod_tri(&s, 10 * 16, 10 * 16, 50 * 16, 10 * 16, 10 * 16, 50 * 16, ink));
    CHECK(s.count == 1 && s.runs[0].pro_kind == POD_TRI);
    draw(&s);
    CHECK(px(15, 15) == ink);                       // inside
    CHECK(px(12, 40) == ink);
    CHECK(px(45, 45) == 0 && px(5, 5) == 0 && px(10, 60) == 0);   // outside
    CHECK(px(29, 30) != 0 && px(29, 30) != ink);    // centre exactly on the hypotenuse: partial
    CHECK(px(28, 28) == ink && px(31, 31) == 0);    // a pixel inside and a pixel outside the edge
    CHECK(px(9, 20) == 0);                          // left of the vertical leg
    // Either winding draws the same.
    ht_scene_t r; ht_scene_clear(&r, 0);
    CHECK(pod_tri(&r, 10 * 16, 10 * 16, 10 * 16, 50 * 16, 50 * 16, 10 * 16, ink));
    uint16_t keep[W * H];
    memcpy(keep, buf, sizeof keep);
    draw(&r);
    CHECK(!memcmp(keep, buf, sizeof keep));
    // Over a ground, a partial pixel is a mix of ink and ground, not black.
    ht_scene_t g; ht_scene_clear(&g, 0);
    memset(buf, 0xff, sizeof buf);
    CHECK(pod_tri(&g, 10 * 16, 10 * 16, 50 * 16, 10 * 16, 10 * 16, 50 * 16, 0));
    for (int i = 0; i < g.count; i++) ht_pro_raster(&g.runs[i], clip, buf);
    CHECK(px(15, 15) == 0 && px(45, 45) == 0xffff && px(29, 30) != 0xffff && px(29, 30) != 0);
    // A degenerate triangle and out of range vertices are refused; a vertex that moves changes the run's bytes.
    ht_scene_t d; ht_scene_clear(&d, 0);
    CHECK(!pod_tri(&d, 0, 0, 160, 160, 320, 320, ink) && d.count == 0);
    CHECK(!pod_tri(&d, 40000, 0, 0, 0, 0, 160, ink) && d.count == 0);
    ht_scene_t s1, s2, s3; ht_scene_clear(&s1, 0); ht_scene_clear(&s2, 0); ht_scene_clear(&s3, 0);
    pod_tri(&s1, 160, 160, 800, 160, 160, 800, ink);
    pod_tri(&s2, 160, 160, 800, 160, 160, 801, ink);
    pod_tri(&s3, 160, 160, 800, 160, 160, 800, ink);
    ht_damage_t dm;
    ht_damage(&s1, &s2, &dm);
    CHECK(dm.count > 0);
    ht_damage(&s1, &s3, &dm);
    CHECK(dm.count == 0);
}

// Two triangles sharing the diagonal of a square leave no seam when the diagonal is an inner edge.
static void draw_test_tri_seam(void)
{
    uint16_t ink = ht_rgb(0xffffff);
    for (int inner = 0; inner < 2; inner++) {
        ht_scene_t s; ht_scene_clear(&s, 0);
        // The square (8.25, 8.25) .. (40.25, 40.25): its diagonal runs through the pixel centres (i, i).
        int a = 8 * 16 + 4, b = 40 * 16 + 4;
        if (inner) {
            CHECK(pod_tri_inner(&s, a, a, b, a, b, b, ink, 4));   // edge 2 (b,b) -> (a,a) is the diagonal
            CHECK(pod_tri_inner(&s, a, a, b, b, a, b, ink, 1));   // edge 0 (a,a) -> (b,b)
        } else {
            CHECK(pod_tri(&s, a, a, b, a, b, b, ink));
            CHECK(pod_tri(&s, a, a, b, b, a, b, ink));
        }
        draw(&s);
        int dips = 0;
        for (int i = 12; i < 36; i++) if (px(i, i) != ink || px(i + 1, i) != ink || px(i, i + 1) != ink) dips++;
        CHECK(inner ? dips == 0 : dips > 0);        // the plain pair shows the seam, the inner pair does not
        CHECK(px(4, 4) == 0 && px(44, 44) == 0);   // outside stays dark
        CHECK(px(7, 20) == 0 && px(41, 20) == 0 && px(20, 7) == 0 && px(20, 41) == 0);
        CHECK(inner ? px(20, 20) == ink : px(20, 20) != ink);
    }
}

// ht_pro_rect_aa: the corner pixels are a blend between the ground and the ink; the middle is the ink.
// (x+1,y+1) of an r=16 corner is a whole pixel outside the circle, so the blended pixel is on the diagonal at (x+4,y+4).
static void draw_test_rect_aa(void)
{
    const uint16_t ground = 0x2104, ink = 0xffff;
    ht_scene_t s; ht_scene_clear(&s, 0);
    CHECK(ht_pro_rect_aa(&s, 8, 8, 40, 40, 16, ink));
    draw_over(&s, ground);
    CHECK(px(8, 8) == ground && px(9, 9) == ground);
    unsigned g = (px(12, 12) >> 5) & 63;
    CHECK(px(12, 12) != ground && px(12, 12) != ink && g > ((ground >> 5) & 63) && g < 63);
    CHECK(px(28, 28) == ink && px(8, 28) == ink && px(28, 8) == ink && px(47, 47) != ink);
    CHECK(px(22, 8) != ground && px(22, 8) != ink && px(47, 28) == ink);
    CHECK(!ht_pro_rect_aa(&s, 0, 0, 0, 5, 2, ink));
    ht_scene_clear(&s, 0);   // radius 0 is a plain rectangle
    CHECK(ht_pro_rect_aa(&s, 8, 8, 10, 10, 0, ink));
    draw_over(&s, ground);
    CHECK(px(8, 8) == ink && px(17, 17) == ink && px(18, 18) == ground);
}

// ---- v3 Task 4: the renderer speedups must not change a pixel. corner_cover_ref and ref_over are copies of the renderer's
// code from before the fast path; the references below paint a run with them, the way the old rect_aa_raster did.
static unsigned ref_isqrt(unsigned n)
{
    unsigned r = 0, bit = 1u << 30;
    while (bit > n) bit >>= 2;
    for (; bit; bit >>= 2) {
        if (n >= r + bit) { n -= r + bit; r = (r >> 1) + bit; } else r >>= 1;
    }
    return r;
}
static unsigned corner_cover_ref(int rad, int px, int py)
{
    int vx = (px*2+1-2*rad)*8, vy = (py*2+1-2*rad)*8;
    int cov = rad*16 - (int)ref_isqrt((unsigned)(vx*vx + vy*vy)) + 8;
    return cov <= 0 ? 0 : cov >= 16 ? 16 : (unsigned)cov;
}
static uint16_t ref_over(uint16_t fg, uint16_t bg, unsigned a)
{
    if (a == 255) return fg;
    unsigned b = 255 - a;
    unsigned r = (fg >> 11) * a + (bg >> 11) * b + 128;
    unsigned g = ((fg >> 5) & 63) * a + ((bg >> 5) & 63) * b + 128;
    unsigned v = (fg & 31) * a + (bg & 31) * b + 128;
    r = (r + (r >> 8)) >> 8; g = (g + (g >> 8)) >> 8; v = (v + (v >> 8)) >> 8;
    return (uint16_t)((r << 11) | (g << 5) | v);
}
enum { BW = 128, BH = 96 };
static uint16_t big_a[BW * BH], big_b[BW * BH];
static void ref_aa_raster(const ht_run_t *r, ht_rect_t clip, uint16_t *out)   // the old rect_aa_raster, plain-AA runs
{
    int rad = r->radius;
    int x0 = r->x > clip.x ? r->x : clip.x, x1 = r->x + r->w < clip.x + clip.w ? r->x + r->w : clip.x + clip.w;
    int y0 = r->y > clip.y ? r->y : clip.y, y1 = r->y + r->pro_height < clip.y + clip.h ? r->y + r->pro_height : clip.y + clip.h;
    for (int y = y0; y < y1; y++) {
        int dy = y - r->y;
        uint16_t *row = out + (y-clip.y)*clip.w - clip.x;
        int cy = dy < rad ? dy : dy >= r->pro_height-rad ? r->pro_height-1-dy : -1;
        for (int x = x0; x < x1; x++) {
            int dx = x - r->x, cx = dx < rad ? dx : dx >= r->w-rad ? r->w-1-dx : -1;
            unsigned cov = cx < 0 || cy < 0 ? 16 : corner_cover_ref(rad, cx, cy);
            if (cov >= 16) row[x] = r->fg;
            else if (cov) row[x] = ref_over(r->fg, row[x], cov*255/16);
        }
    }
}
static void ground_big(uint16_t *b) { for (int i = 0; i < BW * BH; i++) b[i] = (uint16_t)(0x2104 + (i * 7 & 0x3f)); }
static const int SIZES_W[] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 13, 16, 17, 31, 32, 33, 64, 81, 120};
static const int SIZES_H[] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 13, 16, 17, 31, 32, 33, 64, 80};
static void draw_test_corner_cover_fast_path(void)
{
    ht_rect_t full = {0, 0, BW, BH}, cut = {7, 4, 90, 60};
    for (int rad = 0; rad <= 40; rad++)
        for (unsigned iw = 0; iw < sizeof SIZES_W / sizeof *SIZES_W; iw++)
            for (unsigned ih = 0; ih < sizeof SIZES_H / sizeof *SIZES_H; ih++) {
                int w = SIZES_W[iw], h = SIZES_H[ih];
                ht_scene_t sc; ht_scene_clear(&sc, 0);
                CHECK(ht_pro_rect_aa(&sc, 3, 2, w, h, rad, ht_rgb(0xe8a030)));
                for (int c = 0; c < 2; c++) {
                    ht_rect_t clip = c ? cut : full;
                    ground_big(big_a); ground_big(big_b);
                    ht_pro_raster(&sc.runs[0], clip, big_a);
                    ref_aa_raster(&sc.runs[0], clip, big_b);
                    if (memcmp(big_a, big_b, (size_t)clip.w * clip.h * 2)) {
                        fprintf(stderr, "corner_cover differs: radius %d size %dx%d clip %d\n", rad, w, h, c);
                        CHECK(0);
                    }
                }
            }
    checks++;
}
static void draw_test_rect_aa_stroke(void)
{
    ht_rect_t full = {0, 0, BW, BH}, cut = {7, 4, 90, 60};
    uint16_t ink = ht_rgb(0x3a4a9a), fill = ht_rgb(0x111214);
    for (int rad = 0; rad <= 40; rad++)
        for (unsigned iw = 0; iw < sizeof SIZES_W / sizeof *SIZES_W; iw++)
            for (unsigned ih = 0; ih < sizeof SIZES_H / sizeof *SIZES_H; ih++) {
                int w = SIZES_W[iw], h = SIZES_H[ih];
                ht_scene_t old, nu;   // the old way: the border fill, then the inset fill with the radius one smaller
                ht_scene_clear(&old, 0); ht_scene_clear(&nu, 0);
                ht_pro_rect_aa(&old, 3, 2, w, h, rad, ink);
                ht_pro_rect_aa(&old, 4, 3, w - 2, h - 2, rad - 1, fill);
                CHECK(ht_pro_rect_aa_stroke(&nu, 3, 2, w, h, rad, ink, fill));
                CHECK(nu.count == 1);
                for (int c = 0; c < 2; c++) {
                    ht_rect_t clip = c ? cut : full;
                    ground_big(big_a); ground_big(big_b);
                    for (int i = 0; i < nu.count; i++) ht_pro_raster(&nu.runs[i], clip, big_a);
                    for (int i = 0; i < old.count; i++) ref_aa_raster(&old.runs[i], clip, big_b);
                    if (memcmp(big_a, big_b, (size_t)clip.w * clip.h * 2)) {
                        fprintf(stderr, "stroke differs: radius %d size %dx%d clip %d\n", rad, w, h, c);
                        CHECK(0);
                    }
                }
            }
    checks++;
}

// ---- Face-aware text: a code point is kept only if the face draws it (the face's extras table) ----
#define FACES(X) \
    X(ht_pro_24) X(ht_pro_32) X(ht_pro_42) X(ht_pro_56) \
    X(ph_sb_48) X(ph_sb_34) X(ph_sb_26) X(ph_sb_22) X(ph_rg_24) X(ph_mono_26) X(ph_mono_18) \
    X(ph_sb_32) X(ph_rg_36) X(ph_mono_22)
typedef struct { const char *name; const ht_pro_font_t *face; } named_face_t;
#define ENTRY(f) {#f, &f},
static const named_face_t all_faces[] = { FACES(ENTRY) };
#define N_FACES (sizeof all_faces / sizeof all_faces[0])

enum { TW = 400, TH = 96 };
static uint16_t tbuf[TW * TH];
// Draw `text` on `face` into tbuf (ground 0, white ink) and return the run's normalized text; *ink counts inked pixels.
static const char *draw_text(const ht_pro_font_t *face, const char *text, int *ink)
{
    static ht_scene_t s;
    ht_scene_clear(&s, 0);
    memset(tbuf, 0, sizeof tbuf);
    CHECK(ht_pro_text(&s, 2, 2, TW - 4, face, 0xffff, text));
    ht_pro_raster(&s.runs[0], (ht_rect_t){0, 0, TW, TH}, tbuf);
    int n = 0;
    for (int i = 0; i < TW * TH; i++) n += tbuf[i] != 0;
    if (ink) *ink = n;
    return s.runs[0].text;
}
static bool cut_face(const char *name)   // faces cut to a fixed string (gen_fonts CONSOLE_CUT): their extras may be blank
{
    return !strcmp(name, "ph_sb_48");
}
static const named_face_t *find_face(const char *name)
{
    for (unsigned i = 0; i < N_FACES; i++) if (!strcmp(all_faces[i].name, name)) return &all_faces[i];
    return NULL;
}

static void draw_test_marks_follow_the_face(void)
{
    const char *input = "a \xe2\x86\x90 b \xe2\x86\x91 c \xe2\x96\xb2";   // a <- b ^ c up-triangle
    // Pets: the marks are native and kept as they are.
    const char *cs = draw_text(find_face("ph_rg_24")->face, input, NULL);
    CHECK(!strcmp(cs, input));
    // The old faces carry no marks either: a fallback, never '?'.
    const char *old = draw_text(find_face("ht_pro_24")->face, input, NULL);
    CHECK(!strchr(old, '?'));
    for (const char *p = old; *p; p++) CHECK(!((unsigned char)*p & 0x80));
    // The five marks that always passed through the no-face path still do.
    char out[64];
    CHECK(ht_display_text_ex(out, sizeof out, "\xe2\x86\x92", NULL) && !strcmp(out, "\xe2\x86\x92"));
    // Pets's right arrow stays native.
    CHECK(!strcmp(draw_text(find_face("ph_rg_24")->face, "\xe2\x86\x92", NULL), "\xe2\x86\x92"));
}

static void draw_test_extras_round_trip(void)
{
    for (unsigned i = 0; i < N_FACES; i++) {
        const named_face_t *nf = &all_faces[i];
        const ht_pro_font_t *f = nf->face;
        CHECK((f->extras == NULL) == (f->extra_count == 0));
        CHECK(f->glyph_count == (f->last - f->first + 1) + 102 + f->extra_count);   // the table matches the atlas
        for (unsigned k = 0; k < f->extra_count; k++) {
            uint32_t cp = f->extras[k];
            CHECK(ht_pro_extra_pos(f, cp) == (int)k && ht_pro_can_draw(f, cp));
            char text[8] = {0};
            if (cp < 0x800) { text[0] = (char)(0xc0 | cp >> 6); text[1] = (char)(0x80 | (cp & 63)); }
            else { text[0] = (char)(0xe0 | cp >> 12); text[1] = (char)(0x80 | ((cp >> 6) & 63)); text[2] = (char)(0x80 | (cp & 63)); }
            int ink;
            const char *shown = draw_text(f, text, &ink);
            CHECK(!strcmp(shown, text));   // kept native
            // A face cut to a fixed string draws only that string's marks (U+2026 on ph_sb_48).
            if (cut_face(nf->name) && !(cp == 0x2026 && !strcmp(nf->name, "ph_sb_48"))) continue;
            if (!ink) fprintf(stderr, "%s U+%04X has no ink\n", nf->name, (unsigned)cp);
            CHECK(ink > 0);
        }
    }
}

// zoom 16 is an exact 2x nearest-neighbour scale of the zoom-8 picture; 9..15 clamp to 8.
static void draw_test_cell_zoom_2x(void)
{
    static const uint16_t pal[] = {0, 0xe0ff, 0x1f00};
    static const uint8_t cells[] = {1,0,2,  2,1,1};
    ht_cell_frame_t f = {3, 2, 1, pal, cells, NULL};
    ht_scene_t a, b; ht_scene_clear(&a, 0); ht_scene_clear(&b, 0);
    CHECK(pod_cell(&a, 5, 6, &f, 8));
    CHECK(pod_cell(&b, 5, 6, &f, 16));
    CHECK(b.runs[0].x == 5 && b.runs[0].y == 6);
    CHECK(b.runs[0].w == 2 * a.runs[0].w && b.runs[0].pro_height == 2 * a.runs[0].pro_height);
    uint16_t one[W * H];
    draw_over(&a, 0x1234); memcpy(one, buf, sizeof buf);
    draw_over(&b, 0x1234);
    for (int j = 0; j < 2; j++)
        for (int k = 0; k < 3; k++)
            for (int dy = 0; dy < 2; dy++)
                for (int dx = 0; dx < 2; dx++)
                    CHECK(px(5 + 2 * k + dx, 6 + 2 * j + dy) == one[(6 + j) * W + 5 + k]);
    CHECK(px(4, 6) == 0x1234 && px(11, 6) == 0x1234 && px(5, 10) == 0x1234);   // nothing outside the 6 x 4 box
}
// A coarse grid (cell 2: each cell 2 glass pixels at zoom 8) at zoom 16 is the zoom-8 picture, every pixel doubled: the cells are
// 4 px wide, the edge softening decides per cell exactly as at 1x.
static void draw_test_cell_zoom_2x_coarse(void)
{
    static const uint16_t pal[] = {0, 0xe0ff, 0x1f00};
    static const uint8_t cells[] = {1,0,2,  2,1,1,  1,1,2};
    ht_cell_frame_t f = {3, 3, 2, pal, cells, NULL};
    ht_scene_t a, b; ht_scene_clear(&a, 0); ht_scene_clear(&b, 0);
    CHECK(pod_cell(&a, 3, 2, &f, 8));
    CHECK(pod_cell(&b, 3, 2, &f, 16));
    CHECK(a.runs[0].w == 6 && a.runs[0].pro_height == 6 && b.runs[0].w == 12 && b.runs[0].pro_height == 12);
    uint16_t one[W * H];
    draw_over(&a, 0x1234); memcpy(one, buf, sizeof buf);
    draw_over(&b, 0x1234);
    int inked = 0;
    for (int j = 0; j < 6; j++)
        for (int k = 0; k < 6; k++) {
            uint16_t want = one[(2 + j) * W + 3 + k];
            inked += want != 0x1234;
            for (int dy = 0; dy < 2; dy++)
                for (int dx = 0; dx < 2; dx++)
                    CHECK(px(3 + 2 * k + dx, 2 + 2 * j + dy) == want);
        }
    CHECK(inked > 20);
    CHECK(px(2, 2) == 0x1234 && px(15, 2) == 0x1234 && px(3, 14) == 0x1234);   // nothing outside the 12 x 12 box
}
static void draw_test_cell_zoom_clamp(void)
{
    static const uint16_t pal[] = {0, 0xe0ff};
    static const uint8_t cells[] = {1,1,1,  1,1,1};
    ht_cell_frame_t f = {3, 2, 1, pal, cells, NULL};
    for (unsigned z = 9; z <= 15; z++) {
        ht_scene_t a, b; ht_scene_clear(&a, 0); ht_scene_clear(&b, 0);
        CHECK(pod_cell(&a, 5, 6, &f, 8));
        CHECK(pod_cell(&b, 5, 6, &f, z));
        CHECK(a.runs[0].w == b.runs[0].w && a.runs[0].pro_height == b.runs[0].pro_height);
        CHECK(a.runs[0].radius == b.runs[0].radius);
    }
}

// ---- the fast paths against the plain per-pixel forms they replaced ------------------------------------------------------------
static uint32_t lcg_state = 12345;
static unsigned rnd(unsigned n) { lcg_state = lcg_state * 1664525u + 1013904223u; return (lcg_state >> 8) % n; }

typedef struct { int16_t cx16, cy16; uint16_t r16, w16; int16_t ux, uy, cosh; } ref_arc_params_t;   // pod_draw.c's arc_params_t
static uint16_t ref_mix565(uint16_t fg, uint16_t bg, unsigned a, unsigned levels)
{
    unsigned half = levels / 2;
    unsigned rr = ((fg >> 11) * a + (bg >> 11) * (levels - a) + half) / levels;
    unsigned gg = (((fg >> 5) & 63) * a + ((bg >> 5) & 63) * (levels - a) + half) / levels;
    unsigned bb = ((fg & 31) * a + (bg & 31) * (levels - a) + half) / levels;
    return (uint16_t)((rr << 11) | (gg << 5) | bb);
}
// The arc as it was before the band was cut per row: every pixel of the box takes the square root.
static void ref_arc_raster(const ht_run_t *r, ht_rect_t c, uint16_t *out)
{
    ref_arc_params_t p;
    memcpy(&p, r->text, sizeof p);
    int x1 = c.x > r->x ? c.x : r->x, x2 = c.x + c.w < r->x + r->w ? c.x + c.w : r->x + r->w;
    int y1 = c.y > r->y ? c.y : r->y, y2 = c.y + c.h < r->y + r->pro_height ? c.y + c.h : r->y + r->pro_height;
    int half = p.w16 / 2, rad = p.r16;
    for (int y = y1; y < y2; y++) {
        uint16_t *row = out + (y - c.y) * c.w - c.x;
        int vy = p.cy16 - (y * 16 + 8);
        for (int x = x1; x < x2; x++) {
            int vx = x * 16 + 8 - p.cx16;
            int d = (int)ref_isqrt((uint32_t)(vx * vx + vy * vy));
            int cov = half - (d > rad ? d - rad : rad - d) + 8;
            if (cov <= 0) continue;
            int64_t dot = (int64_t)vx * p.ux + (int64_t)vy * p.uy;
            int64_t lhs = dot * dot, rhs = (int64_t)(vx * vx + vy * vy) * p.cosh * p.cosh;
            bool in = p.cosh >= 0 ? dot >= 0 && lhs + (lhs >> 12) >= rhs : dot >= 0 || lhs <= rhs + (rhs >> 12);
            if (!in) continue;
            row[x] = cov >= 16 ? r->fg : ref_mix565(r->fg, row[x], (unsigned)cov, 16);
        }
    }
}
// A ring arc cut into a span per row (and a hole in the middle) draws exactly the pixels of the full box: random arcs, including ones whose centre is
// a pixel centre (distance 0) and thick ones that reach it, clipped whole and to a window.
static void draw_test_arc_rows_equal_box(void)
{
    static uint16_t a[W * H], b[W * H];
    int drawn = 0;
    for (int n = 0; n < 600; n++) {
        ht_scene_t s; ht_scene_clear(&s, 0);
        int cx16 = n % 3 == 0 ? (int)(8 + 16 * rnd(W)) : (int)rnd(W * 16 + 400) - 200, cy16 = n % 3 == 0 ? (int)(8 + 16 * rnd(H)) : (int)rnd(H * 16 + 400) - 200;
        int r16 = n % 5 == 0 ? (int)rnd(120) : (int)rnd(900), w16 = 1 + (int)rnd(n % 4 == 0 ? 700 : 160);
        if (!pod_arc(&s, cx16, cy16, r16, w16, (int)rnd(360), (int)rnd(181), (uint16_t)(0x1000 + rnd(0xE000)))) continue;
        for (int pass = 0; pass < 2; pass++) {
            const ht_rect_t c = pass ? (ht_rect_t){5, 7, 40, 33} : clip;
            for (int i = 0; i < c.w * c.h; i++) a[i] = b[i] = (uint16_t)(0x0841 * (unsigned)(i & 7));
            ht_pro_raster(&s.runs[0], c, a);
            ref_arc_raster(&s.runs[0], c, b);
            CHECK(!memcmp(a, b, (size_t)c.w * c.h * sizeof a[0]));
        }
        drawn += s.runs[0].w > 0;
    }
    CHECK(drawn > 400);
}

// The 2x cell path against its per-pixel definition: output pixel (x, y) is source cell ((x - x0) >> 1, (y - y0) >> 1), softened toward what is under it on an
// edge. Windows that start on an odd or an even output row, and ones that cut the frame on either side.
static unsigned ref_soften_k(uint16_t c)
{
    unsigned r = c >> 11, g = (c >> 5) & 63, b = c & 31;
    unsigned lum = (r * 8u * 77u + g * 4u * 150u + b * 8u * 29u) >> 8;
    return lum >= 112 ? 0 : (112 - lum) * 154 / 112;
}
static uint16_t ref_soften(uint16_t c, uint16_t dest)
{
    unsigned k = ref_soften_k(c);
    if (!k) return c;
    unsigned r = c >> 11, g = (c >> 5) & 63, b = c & 31, dr = dest >> 11, dg = (dest >> 5) & 63, db = dest & 31;
    r = (r * (256 - k) + dr * k) / 256; g = (g * (256 - k) + dg * k) / 256; b = (b * (256 - k) + db * k) / 256;
    return (uint16_t)(r << 11 | g << 5 | b);
}
static void ref_cell_2x(const ht_cell_frame_t *f, int x0, int y0, ht_rect_t c, uint16_t *out)
{
    for (int y = c.y; y < c.y + c.h; y++)
        for (int x = c.x; x < c.x + c.w; x++) {
            int cx = (x - x0) >> 1, cy = (y - y0) >> 1;
            if (x < x0 || y < y0 || cx >= f->cols || cy >= f->rows) continue;
            unsigned i = f->cells[cy * f->cols + cx];
            if (!i) continue;
            uint16_t v = __builtin_bswap16(f->palette[i]);
            bool edge = cx == 0 || cy == 0 || cx + 1 >= f->cols || cy + 1 >= f->rows || !f->cells[cy * f->cols + cx - 1] ||
                        !f->cells[cy * f->cols + cx + 1] || !f->cells[(cy - 1) * f->cols + cx] || !f->cells[(cy + 1) * f->cols + cx];
            out[(y - c.y) * c.w + x - c.x] = edge ? ref_soften(v, out[(y - c.y) * c.w + x - c.x]) : v;
        }
}
static void draw_test_cell_2x_matches_definition(void)
{
    static uint16_t pal[16];
    static uint8_t cells[20 * 20];
    static uint16_t a[W * H], b[W * H];
    for (int n = 0; n < 200; n++) {
        for (int k = 1; k < 16; k++) pal[k] = (uint16_t)rnd(0x10000);   // dark ones (they soften) and light ones
        int cols = 3 + (int)rnd(14), rows = 3 + (int)rnd(14);
        for (int i = 0; i < cols * rows; i++) cells[i] = rnd(4) ? (uint8_t)(1 + rnd(15)) : 0;
        ht_cell_frame_t f = {(uint8_t)cols, (uint8_t)rows, 1, pal, cells, NULL};
        int x0 = (int)rnd(30) - 8, y0 = (int)rnd(30) - 8;
        ht_scene_t s; ht_scene_clear(&s, 0);
        CHECK(pod_cell(&s, x0, y0, &f, 16));
        for (int pass = 0; pass < 3; pass++) {
            const ht_rect_t c = pass == 0 ? clip : pass == 1 ? (ht_rect_t){(int16_t)rnd(10), (int16_t)(1 + 2 * rnd(8)), 30, 25} : (ht_rect_t){3, (int16_t)(2 * rnd(8)), 41, 20};
            for (int i = 0; i < c.w * c.h; i++) a[i] = b[i] = 0x5555;
            ht_pro_raster(&s.runs[0], c, a);
            ref_cell_2x(&f, x0, y0, c, b);
            CHECK(!memcmp(a, b, (size_t)c.w * c.h * sizeof a[0]));
        }
    }
}

// Baked cells (pod_cell_flat): over the one colour it is told, a frame zoomed below 1x is the very picture pod_cell resamples, whole or in windows;
// it is worked out once per (frame, zoom, ground) and kept; another ground, zoom or frame is another entry.
static void draw_test_cell_flat_equals_resample(void)
{
    static uint16_t pal[16];
    static uint8_t cells[30 * 30];
    static uint16_t a[W * H], b[W * H];
    pod_cell_bake_reset();
    unsigned expect_bakes = 0;
    for (int n = 0; n < 60; n++) {
        for (int k = 1; k < 16; k++) pal[k] = (uint16_t)rnd(0x10000);
        int cols = 4 + (int)rnd(26), rows = 4 + (int)rnd(26);
        for (int i = 0; i < cols * rows; i++) cells[i] = rnd(3) ? (uint8_t)(1 + rnd(15)) : 0;
        ht_cell_frame_t f = {(uint8_t)cols, (uint8_t)rows, 1, pal, cells, NULL};
        unsigned z = 2 + rnd(6);   // 2..7: below 1x
        uint16_t ground = (uint16_t)rnd(0x10000);
        int x0 = (int)rnd(20), y0 = (int)rnd(20);   // on the clip, so the first raster bakes
        ht_scene_t flat, plain; ht_scene_clear(&flat, 0); ht_scene_clear(&plain, 0);
        CHECK(pod_cell_flat(&flat, x0, y0, &f, z, ground) && pod_cell(&plain, x0, y0, &f, z));
        CHECK(flat.runs[0].w == plain.runs[0].w && flat.runs[0].pro_height == plain.runs[0].pro_height);
        for (int pass = 0; pass < 3; pass++) {
            const ht_rect_t c = pass == 0 ? clip : pass == 1 ? (ht_rect_t){(int16_t)rnd(10), (int16_t)rnd(10), 33, 21} : (ht_rect_t){0, (int16_t)rnd(30), 64, 7};
            for (int i = 0; i < c.w * c.h; i++) a[i] = b[i] = ground;
            ht_pro_raster(&flat.runs[0], c, a);
            ht_pro_raster(&plain.runs[0], c, b);
            CHECK(!memcmp(a, b, (size_t)c.w * c.h * sizeof a[0]));
        }
        expect_bakes++;
        CHECK(pod_cell_bakes() == expect_bakes);   // three rasters, one bake
    }
    // The entry is found again, not baked again; a different ground or zoom is a new entry; a frame at 1x or more is not baked at all.
    const unsigned px = pod_cell_bake_px();
    CHECK(px > 0);
    ht_cell_frame_t g = {6, 6, 1, pal, cells, NULL};
    ht_scene_t s; ht_scene_clear(&s, 0);
    CHECK(pod_cell_flat(&s, 0, 0, &g, 5, 0x1234) && pod_cell_flat(&s, 0, 0, &g, 5, 0x1234) && pod_cell_flat(&s, 0, 0, &g, 5, 0x4321) && pod_cell_flat(&s, 0, 0, &g, 4, 0x1234));
    for (int i = 0; i < s.count; i++) { for (int j = 0; j < W * H; j++) a[j] = 0; ht_pro_raster(&s.runs[i], clip, a); }
    CHECK(pod_cell_bakes() == expect_bakes + 3);
    CHECK(pod_cell_flat(&s, 0, 0, &g, 8, 0x1234) && s.runs[s.count - 1].text[0] == 0);
    for (int j = 0; j < W * H; j++) a[j] = 0;
    ht_pro_raster(&s.runs[s.count - 1], clip, a);
    CHECK(pod_cell_bakes() == expect_bakes + 3);
    // A full table starts over: the 65th entry clears the 64 and is baked in their place, the picture the same either way. (A screen re-bakes what it draws.)
    pod_cell_bake_reset();
    for (int n = 0; n < 70; n++) {
        const uint16_t ground = (uint16_t)(0x0100 + n);
        ht_scene_t flat, plain; ht_scene_clear(&flat, 0); ht_scene_clear(&plain, 0);
        CHECK(pod_cell_flat(&flat, 4, 4, &g, 5, ground) && pod_cell(&plain, 4, 4, &g, 5));
        for (int j = 0; j < W * H; j++) a[j] = b[j] = ground;
        ht_pro_raster(&flat.runs[0], clip, a);
        ht_pro_raster(&plain.runs[0], clip, b);
        CHECK(!memcmp(a, b, sizeof a));
    }
    CHECK(pod_cell_bakes() == 70 && pod_cell_bake_px() == 6u * 16u);   // all 70 baked; the 6 since the restart hold 4 x 4 px each (6 x 6 at 5/8)
    pod_cell_bake_reset();
    CHECK(pod_cell_bakes() == 0 && pod_cell_bake_px() == 0);
}

// The anti-aliased gradient's corner rows work the coverage out only within the radius at each end and fill between; clear rows are one colour.
// Against the per-pixel form, whole and clipped, with radii from 0 to a pill.
static void draw_test_grad_aa_spans_equal_pixels(void)
{
    static uint16_t a[W * H], b[W * H];
    for (int n = 0; n < 300; n++) {
        int w = 4 + (int)rnd(56), h = 2 + (int)rnd(40), rad = n % 7 == 0 ? 0 : (int)rnd((unsigned)(w < h ? w : h) / 2 + 1);
        int x0 = (int)rnd(10) - 3, y0 = (int)rnd(12) - 3;
        uint16_t top = (uint16_t)rnd(0x10000), bot = (uint16_t)rnd(0x10000);
        ht_scene_t s; ht_scene_clear(&s, 0);
        pod_grad_aa(&s, x0, y0, w, h, rad, top, bot);
        const ht_run_t *r = &s.runs[0];
        for (int pass = 0; pass < 3; pass++) {
            const ht_rect_t c = pass == 0 ? clip : pass == 1 ? (ht_rect_t){(int16_t)rnd(20), (int16_t)rnd(12), (int16_t)(1 + rnd(40)), (int16_t)(1 + rnd(30))} : (ht_rect_t){0, 0, 64, 3};
            for (int i = 0; i < c.w * c.h; i++) a[i] = b[i] = (uint16_t)(0x2104 * (unsigned)(i % 5));
            ht_pro_raster(r, c, a);
            const int last = r->pro_height > 1 ? r->pro_height - 1 : 1;
            for (int y = c.y > r->y ? c.y : r->y; y < (c.y + c.h < r->y + r->pro_height ? c.y + c.h : r->y + r->pro_height); y++) {
                int row = y - r->y, cy = row < r->radius ? row : row >= r->pro_height - r->radius ? r->pro_height - 1 - row : -1;
                uint16_t ink = ref_mix565(bot, top, (unsigned)row, (unsigned)last);
                for (int x = c.x > r->x ? c.x : r->x; x < (c.x + c.w < r->x + r->w ? c.x + c.w : r->x + r->w); x++) {
                    int dx = x - r->x, cx = dx < r->radius ? dx : dx >= r->w - r->radius ? r->w - 1 - dx : -1;
                    unsigned cov = cx < 0 || cy < 0 ? 16 : ht_pro_corner_cover(r->radius, cx, cy);
                    uint16_t *d = &b[(y - c.y) * c.w + x - c.x];
                    if (!cov) continue;
                    *d = cov >= 16 ? ink : ht_pro_over(ink, *d, cov * 255 / 16);
                }
            }
            CHECK(!memcmp(a, b, (size_t)c.w * c.h * sizeof a[0]));
        }
    }
}

// A frame taller than 255 rows: rows 0 and 299 inked, the rest empty (4 cols, packed, 1 px cells).
static void draw_test_tall_frame(void)
{
    enum { TC = 4, TR = 300 };
    static const uint16_t pal[] = {0, 0xe0ff};
    static uint8_t cells[TR * 2 + 8];
    static uint16_t at[TR];
    size_t n = 0;
    for (int r = 0; r < TR; r++) {
        at[r] = (uint16_t)n;
        if (r == 0) { cells[n++] = 0; cells[n++] = 1; cells[n++] = 1; cells[n++] = 3; cells[n++] = 0; }
        else if (r == TR - 1) { cells[n++] = 3; cells[n++] = 1; cells[n++] = 1; }
        else { cells[n++] = TC; cells[n++] = 0; }
    }
    ht_cell_frame_t f = {TC, TR, 1, pal, cells, at};
    CHECK(f.rows == TR);
    CHECK(ht_cell_at(&f, 0, 0) == 1 && ht_cell_at(&f, 3, TR - 1) == 1 && ht_cell_at(&f, 0, TR - 1) == 0 && ht_cell_at(&f, 0, 150) == 0);
    ht_scene_t s; ht_scene_clear(&s, 0);
    CHECK(pod_cell(&s, 0, 0, &f, 8));
    CHECK(s.runs[0].pro_height == TR);
    static uint16_t out[TC * TR];
    ht_rect_t c = {0, 0, TC, TR};
    ht_pro_raster(&s.runs[0], c, out);
    int first = -1, last = -1, inked = 0;
    for (int y = 0; y < TR; y++)
        for (int x = 0; x < TC; x++)
            if (out[y * TC + x]) { if (first < 0) first = y; last = y; inked++; }
    CHECK(first == 0 && last == TR - 1 && inked == 2);
}

// pod_cell16: a zoom below 1x in sixteenths. 16x16 solid at 5/16 is a 5x5 run (ceil(16 * 5 / 16)), every glass pixel fully covered;
// a 16x16 frame whose left half is red and right half blue averages to the weighted mean of the two at the seam pixel; an even
// count is the eighths' picture exactly; over the ground the bake (pod_cell_flat16) is the very resample.
static void draw_test_cell16(void)
{
    static const uint16_t pal[] = {0, 0xe0ff, 0x1f00};
    static uint8_t cells[256], half[256];
    memset(cells, 1, sizeof cells);
    for (int y = 0; y < 16; y++) for (int x = 0; x < 16; x++) half[y * 16 + x] = x < 8 ? 1 : 2;
    ht_cell_frame_t f = {16, 16, 1, pal, cells, NULL}, h = {16, 16, 1, pal, half, NULL};
    ht_scene_t s; ht_scene_clear(&s, 0);
    CHECK(pod_cell16(&s, 20, 20, &f, 5));
    CHECK(s.runs[0].w == 5 && s.runs[0].pro_height == 5);
    draw(&s);
    for (int y = 19; y < 26; y++) for (int x = 19; x < 26; x++)
        CHECK(px(x, y) == (x >= 20 && x < 25 && y >= 20 && y < 25 ? ht_rgb(0xffff00) : 0));
    // 5/16 of 16 px = 5 glass px; the pixel at 2 spans frame px 6.4 .. 9.6: 1.6 red + 1.6 blue of 3.2 -> red 31, blue 31 halves
    ht_scene_clear(&s, 0);
    CHECK(pod_cell16(&s, 20, 20, &h, 5));
    draw(&s);
    CHECK(px(22, 22) != 0 && (px(22, 22) >> 11) >= 14 && (px(22, 22) >> 11) <= 16 && (px(22, 22) & 31) >= 14 && (px(22, 22) & 31) <= 16);
    CHECK(px(20, 22) == ht_rgb(0xffff00) && px(24, 22) != 0 && (px(24, 22) >> 11) < 4);
    // even sixteenths are eighths; 16..31 are 1x, 32 is 2x
    ht_scene_t a, b; ht_scene_clear(&a, 0); ht_scene_clear(&b, 0);
    CHECK(pod_cell16(&a, 3, 3, &h, 10) && pod_cell(&b, 3, 3, &h, 5) && !memcmp(&a.runs[0], &b.runs[0], sizeof a.runs[0]));
    ht_scene_clear(&a, 0);
    CHECK(pod_cell16(&a, 3, 3, &h, 32) && a.runs[0].w == 32 && pod_cell16(&a, 3, 3, &h, 17) && a.runs[1].w == 16);
    CHECK(!pod_cell16(&a, 3, 3, &h, 0));
    // the bake: another zoom (5/16 against 5/8), the same one twice, and the pixels are the resample's
    ht_scene_t fl, pl; ht_scene_clear(&fl, 0); ht_scene_clear(&pl, 0);
    pod_cell_bake_reset();
    CHECK(pod_cell_flat16(&fl, 4, 4, &h, 5, 0x1234) && pod_cell16(&pl, 4, 4, &h, 5));
    draw_over(&fl, 0x1234); uint16_t keep[W * H]; memcpy(keep, buf, sizeof buf);
    draw_over(&pl, 0x1234);
    CHECK(!memcmp(keep, buf, sizeof buf) && pod_cell_bakes() == 1);
    CHECK(pod_cell_flat16(&fl, 4, 4, &h, 5, 0x1234) && pod_cell_flat(&fl, 4, 4, &h, 5, 0x1234));
    draw_over(&fl, 0x1234);
    CHECK(pod_cell_bakes() == 2);
}

int main(void)
{
    draw_test_tall_frame();
    draw_test_corner_cover_fast_path();
    draw_test_rect_aa_stroke();
    draw_test_rect_aa();
    draw_test_cell_plain_and_packed();
    draw_test_edge_softening();
    draw_test_no_white_halo();
    draw_test_zoom();
    draw_test_cell_zoom_2x();
    draw_test_cell_zoom_2x_coarse();
    draw_test_cell_zoom_clamp();
    draw_test_arc();
    draw_test_arc_rows_equal_box();
    draw_test_cell_2x_matches_definition();
    draw_test_cell_flat_equals_resample();
    draw_test_cell16();
    draw_test_grad_aa_spans_equal_pixels();
    draw_test_damage();
    draw_test_grad();
    draw_test_grad_aa_corner();
    draw_test_grad_aa_rows();
    draw_test_grad_aa_dither();
    draw_test_tri();
    draw_test_tri_seam();
    draw_test_marks_follow_the_face();
    draw_test_extras_round_trip();
    printf("Pod draw: PASS (%d checks)\n", checks);
    return 0;
}
