// Task 3: Pod's cell sprite, ring arc and gradient runs.
#include <assert.h>
#include <stdio.h>
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

int main(void)
{
    draw_test_cell_plain_and_packed();
    draw_test_edge_softening();
    draw_test_no_white_halo();
    draw_test_zoom();
    draw_test_arc();
    draw_test_damage();
    draw_test_grad();
    draw_test_tri();
    draw_test_tri_seam();
    printf("Pod draw: PASS (%d checks)\n", checks);
    return 0;
}
