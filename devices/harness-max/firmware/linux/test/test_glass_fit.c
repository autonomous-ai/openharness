// The fit between the glass and a Linux output (linux/display/glass_fit.c): the scale, the turn for a portrait raster,
// the filter's damage, the pixels, and the touch coming back. Built alone: cc ... -I linux/display glass_fit.c this.
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "glass_fit.h"

static int checks;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #c); abort(); } checks++; } while (0)

static bool same(glass_fit_rect_t a, glass_fit_rect_t b) { return a.x == b.x && a.y == b.y && a.w == b.w && a.h == b.h; }

// RGB565 -> XRGB8888 by bit replication, which is what an unscaled pixel must come out as.
static uint32_t expand(uint16_t c)
{
    const uint32_t r = c >> 11, g = (c >> 5) & 63, b = c & 31;
    return (r << 3 | r >> 2) << 16 | (g << 2 | g >> 4) << 8 | (b << 3 | b >> 2);
}

// The raster pixel a landscape pixel lies at.
static uint32_t *at(const glass_fit_t *f, uint32_t *out, int lx, int ly)
{
    return f->turned ? &out[(f->out_h - 1 - lx) * f->out_w + ly] : &out[ly * f->out_w + lx];
}

static void test_fits(void)
{
    // The bar: 1480 x 320 landscape on a 320 x 1480 raster. The 415-high glass fills it.
    glass_fit_t f = glass_fit(1920, 415, 320, 1480);
    CHECK(f.turned);
    CHECK(same(f.pic, (glass_fit_rect_t){0, 0, 1480, 320}));
    // The ESP32-P4's 480-high glass on the same bar: height-limited, centred, with black on the left and right.
    f = glass_fit(1920, 480, 320, 1480);
    CHECK(f.turned && same(f.pic, (glass_fit_rect_t){100, 0, 1280, 320}));
    // A window as large as the glass: nothing moves.
    f = glass_fit(1920, 415, 1920, 415);
    CHECK(!f.turned && same(f.pic, (glass_fit_rect_t){0, 0, 1920, 415}));
    // A landscape monitor: width-limited, centred top to bottom.
    f = glass_fit(1920, 480, 1920, 1080);
    CHECK(!f.turned && same(f.pic, (glass_fit_rect_t){0, 300, 1920, 480}));
}

static void fill(uint16_t *glass, int n, unsigned seed)
{
    for (int i = 0; i < n; i++) glass[i] = (uint16_t)((unsigned)i * 2654435761u ^ seed);
}

// Unscaled, every pixel arrives exactly, at its turned place.
static void test_unscaled_pixels(void)
{
    enum { GW = 9, GH = 4 };
    static uint16_t glass[GW * GH];
    static uint32_t out[GW * GH];
    fill(glass, GW * GH, 7);
    for (int turned = 0; turned < 2; turned++) {
        const glass_fit_t f = turned ? glass_fit(GW, GH, GH, GW) : glass_fit(GW, GH, GW, GH);
        CHECK(f.turned == (turned != 0) && same(f.pic, (glass_fit_rect_t){0, 0, GW, GH}));
        memset(out, 0, sizeof out);
        glass_fit_paint(&f, glass, f.pic, out, f.out_w);
        for (int y = 0; y < GH; y++)
            for (int x = 0; x < GW; x++) CHECK(*at(&f, out, x, y) == expand(glass[y * GW + x]));
    }
    // Turned, the glass's top-left corner is at the raster's bottom-left, its top-right at the raster's top-left.
    const glass_fit_t f = glass_fit(GW, GH, GH, GW);
    glass_fit_paint(&f, glass, f.pic, out, f.out_w);
    CHECK(out[(GW - 1) * GH + 0] == expand(glass[0]));
    CHECK(out[0] == expand(glass[GW - 1]));
}

// Scaled, a flat glass stays flat, and nothing outside the picture is written.
static void test_scaled_flat_and_bars(void)
{
    static uint16_t glass[1920 * 480];
    static uint32_t out[320 * 1480];
    for (int i = 0; i < 1920 * 480; i++) glass[i] = 0x07e0;   // pure green
    const glass_fit_t f = glass_fit(1920, 480, 320, 1480);
    for (int i = 0; i < 320 * 1480; i++) out[i] = 0xdeadbeef;
    glass_fit_paint(&f, glass, f.pic, out, f.out_w);
    for (int ly = 0; ly < 320; ly++)
        for (int lx = 0; lx < 1480; lx++) {
            const bool inside = lx >= f.pic.x && lx < f.pic.x + f.pic.w;
            CHECK(*at(&f, out, lx, ly) == (inside ? expand(0x07e0) : 0xdeadbeef));
        }
}

// The paint as it was first written, the 2 x 2 bilinear blend worked out whole for every picture pixel: what
// glass_fit_paint's two passes must give, to the bit.
typedef struct {
    int a, b, w;
} ref_tap_t;

static ref_tap_t ref_tap(int p, int pic, int glass)
{
    int64_t s = ((int64_t)(2 * p + 1) * glass << 16) / (2 * pic) - (1 << 15);
    if (s < 0) s = 0;
    if (s > (int64_t)(glass - 1) << 16) s = (int64_t)(glass - 1) << 16;
    const int a = (int)(s >> 16);
    return (ref_tap_t){a, a + 1 < glass ? a + 1 : a, (int)((s >> 8) & 255)};
}

static void ref_unpack(uint16_t c, int *r, int *g, int *b)
{
    const int r5 = c >> 11, g6 = (c >> 5) & 63, b5 = c & 31;
    *r = r5 << 3 | r5 >> 2;
    *g = g6 << 2 | g6 >> 4;
    *b = b5 << 3 | b5 >> 2;
}

static uint32_t ref_blend(const uint16_t *glass, int stride, ref_tap_t x, ref_tap_t y)
{
    const uint16_t *row0 = glass + y.a * stride, *row1 = glass + y.b * stride;
    int r[4], g[4], b[4];
    ref_unpack(row0[x.a], &r[0], &g[0], &b[0]);
    ref_unpack(row0[x.b], &r[1], &g[1], &b[1]);
    ref_unpack(row1[x.a], &r[2], &g[2], &b[2]);
    ref_unpack(row1[x.b], &r[3], &g[3], &b[3]);
    const int w0 = (256 - x.w) * (256 - y.w), w1 = x.w * (256 - y.w), w2 = (256 - x.w) * y.w, w3 = x.w * y.w;
    const uint32_t ro = (uint32_t)(r[0] * w0 + r[1] * w1 + r[2] * w2 + r[3] * w3 + 32768) >> 16;
    const uint32_t go = (uint32_t)(g[0] * w0 + g[1] * w1 + g[2] * w2 + g[3] * w3 + 32768) >> 16;
    const uint32_t bo = (uint32_t)(b[0] * w0 + b[1] * w1 + b[2] * w2 + b[3] * w3 + 32768) >> 16;
    return ro << 16 | go << 8 | bo;
}

static void ref_paint(const glass_fit_t *f, const uint16_t *glass, glass_fit_rect_t land, uint32_t *out, int stride)
{
    const int lw = f->turned ? f->out_h : f->out_w;
    for (int ly = land.y; ly < land.y + land.h; ly++)
        for (int lx = land.x; lx < land.x + land.w; lx++) {
            const ref_tap_t x = ref_tap(lx - f->pic.x, f->pic.w, f->glass_w);
            const ref_tap_t y = ref_tap(ly - f->pic.y, f->pic.h, f->glass_h);
            const int ox = f->turned ? ly : lx, oy = f->turned ? lw - 1 - lx : ly;
            out[(size_t)oy * stride + ox] = ref_blend(glass, f->glass_w, x, y);
        }
}

// Every picture pixel glass_fit_paint writes is the whole 2 x 2 blend's, on every fit (turned or not, scaled down, up
// or not at all, a picture with black either side), for the whole picture and for damage of any size anywhere, and
// nothing outside the rectangle asked for is written.
static void test_paint_matches_blend(void)
{
    static const struct { int gw, gh, ow, oh; } FITS[] = {
        {1920, 480, 320, 1480},   // the ESP32-P4's glass on the bar: turned, 2/3, black either side
        {1920, 415, 320, 1480},   // the bar's own shape: turned, filling it
        {1920, 480, 1920, 1080},  // a landscape monitor: unturned, unscaled, black above and below
        {1920, 480, 1280, 720},   // unturned and scaled down
        {37, 11, 100, 300},       // turned and scaled up
        {37, 11, 160, 90},        // unturned and scaled up
        {1000, 333, 250, 777},    // turned, odd sizes, no simple ratio
        {9, 4, 4, 9},             // turned, unscaled
    };
    static uint16_t glass[1920 * 480];
    static uint32_t want[1920 * 1080], got[1920 * 1080];
    unsigned seed = 99;
    for (size_t c = 0; c < sizeof FITS / sizeof FITS[0]; c++) {
        const glass_fit_t f = glass_fit(FITS[c].gw, FITS[c].gh, FITS[c].ow, FITS[c].oh);
        const size_t px = (size_t)f.out_w * f.out_h;
        for (int rep = 0; rep < 40; rep++) {
            fill(glass, f.glass_w * f.glass_h, seed++);
            glass_fit_rect_t land = f.pic;
            if (rep) {   // a change somewhere on the glass, from one pixel to most of it, as a frame's damage
                seed = seed * 1103515245u + 12345u;
                const int x = (int)(seed >> 8) % f.glass_w, y = (int)(seed >> 4) % f.glass_h;
                seed = seed * 1103515245u + 12345u;
                const int w = 1 + (int)(seed >> 8) % (rep % 3 ? 24 : f.glass_w - x);
                const int h = 1 + (int)(seed >> 4) % (rep % 3 ? 24 : f.glass_h - y);
                land = glass_fit_damage(&f, (glass_fit_rect_t){x, y, w > f.glass_w - x ? f.glass_w - x : w,
                                                              h > f.glass_h - y ? f.glass_h - y : h});
            }
            for (size_t i = 0; i < px; i++) want[i] = got[i] = 0xdeadbeef;
            ref_paint(&f, glass, land, want, f.out_w);
            glass_fit_paint(&f, glass, land, got, f.out_w);
            CHECK(!memcmp(want, got, px * sizeof want[0]));
        }
    }
}

// Every raster pixel a change to a glass rectangle alters lies inside glass_fit_damage of it, and the damage is no more
// than a pixel or two wider than the change's own footprint.
static void check_damage(const glass_fit_t *f, glass_fit_rect_t g)
{
    static uint16_t glass[1920 * 480];
    static uint32_t before[320 * 1480], after[320 * 1480];
    fill(glass, f->glass_w * f->glass_h, 3);
    glass_fit_paint(f, glass, f->pic, before, f->out_w);
    for (int y = g.y; y < g.y + g.h; y++)
        for (int x = g.x; x < g.x + g.w; x++) glass[y * f->glass_w + x] ^= 0xffff;
    glass_fit_paint(f, glass, f->pic, after, f->out_w);
    const glass_fit_rect_t d = glass_fit_damage(f, g);
    CHECK(d.x >= f->pic.x && d.y >= f->pic.y && d.x + d.w <= f->pic.x + f->pic.w && d.y + d.h <= f->pic.y + f->pic.h);
    int lx0 = 1 << 30, ly0 = 1 << 30, lx1 = -1, ly1 = -1;
    for (int ly = 0; ly < f->pic.y + f->pic.h; ly++)
        for (int lx = 0; lx < f->pic.x + f->pic.w; lx++) {
            if (*at(f, before, lx, ly) == *at(f, after, lx, ly)) continue;
            CHECK(lx >= d.x && lx < d.x + d.w && ly >= d.y && ly < d.y + d.h);
            if (lx < lx0) lx0 = lx;
            if (ly < ly0) ly0 = ly;
            if (lx > lx1) lx1 = lx;
            if (ly > ly1) ly1 = ly;
        }
    CHECK(lx1 >= 0);   // the change shows somewhere
    CHECK(lx0 - d.x <= 2 && ly0 - d.y <= 2 && d.x + d.w - 1 - lx1 <= 2 && d.y + d.h - 1 - ly1 <= 2);
}

static void test_damage(void)
{
    const glass_fit_t bar = glass_fit(1920, 415, 320, 1480);
    check_damage(&bar, (glass_fit_rect_t){0, 0, 1920, 24});       // a full strip at the top
    check_damage(&bar, (glass_fit_rect_t){0, 408, 1920, 7});      // the last, short one
    check_damage(&bar, (glass_fit_rect_t){611, 33, 1, 1});        // one pixel
    check_damage(&bar, (glass_fit_rect_t){1919, 414, 1, 1});      // the far corner
    check_damage(&bar, (glass_fit_rect_t){300, 120, 260, 48});    // a lane's text
    const glass_fit_t boxed = glass_fit(1920, 480, 320, 1480);
    check_damage(&boxed, (glass_fit_rect_t){0, 0, 1, 480});       // the left edge, next to the black bar
    check_damage(&boxed, (glass_fit_rect_t){1000, 456, 920, 24});
    CHECK(glass_fit_damage(&bar, (glass_fit_rect_t){5, 5, 0, 3}).w == 0);
}

static bool empty(glass_fit_rect_t r) { return r.w <= 0 || r.h <= 0; }

static void test_union(void)
{
    const glass_fit_rect_t none = {0, 0, 0, 0}, a = {10, 20, 30, 40}, b = {35, 5, 10, 10};
    CHECK(same(glass_fit_union(none, a), a) && same(glass_fit_union(a, none), a));
    CHECK(empty(glass_fit_union(none, (glass_fit_rect_t){7, 7, 0, 9})));
    CHECK(same(glass_fit_union(a, b), (glass_fit_rect_t){10, 5, 35, 55}));
    CHECK(same(glass_fit_union(a, (glass_fit_rect_t){12, 22, 2, 2}), a));
}

// The rectangles a flip asks for, frame by frame.
static void test_flip_rects(void)
{
    glass_fit_flip_t f = {{0, 0, 0, 0}, {0, 0, 0, 0}};
    glass_fit_rect_t out[2];
    CHECK(glass_fit_flip(&f, out) == 0);   // nothing changed: no flip
    // The first change: there was no frame before it.
    glass_fit_flip_add(&f, (glass_fit_rect_t){0, 0, 4, 2});
    glass_fit_flip_add(&f, (glass_fit_rect_t){0, 2, 4, 2});   // the frame's next strip
    CHECK(glass_fit_flip(&f, out) == 1 && same(out[0], (glass_fit_rect_t){0, 0, 4, 4}));
    // A change far from the last one: both, apart (their union would repaint the space between).
    glass_fit_flip_add(&f, (glass_fit_rect_t){1000, 300, 10, 10});
    CHECK(glass_fit_flip(&f, out) == 2 && same(out[0], (glass_fit_rect_t){1000, 300, 10, 10}) &&
          same(out[1], (glass_fit_rect_t){0, 0, 4, 4}));
    // A row moving by two pixels: the two overlap, and their union is one paint of fewer pixels.
    glass_fit_flip_add(&f, (glass_fit_rect_t){1002, 300, 10, 10});
    CHECK(glass_fit_flip(&f, out) == 1 && same(out[0], (glass_fit_rect_t){1000, 300, 12, 10}));
    // A frame that changed nothing keeps what the buffer off screen lacks for the next one.
    CHECK(glass_fit_flip(&f, out) == 0);
    glass_fit_flip_add(&f, (glass_fit_rect_t){1003, 300, 2, 2});
    CHECK(glass_fit_flip(&f, out) == 1 && same(out[0], (glass_fit_rect_t){1002, 300, 10, 10}));
}

// Two buffers flipped frame after frame, each painted only with what glass_fit_flip asks for: the one on screen is
// always the whole glass.
static void test_flip_keeps_both_buffers(void)
{
    enum { W = 24, H = 12, FRAMES = 400 };
    static int glass[H][W], buf[2][H][W];
    glass_fit_flip_t f = {{0, 0, 0, 0}, {0, 0, 0, 0}};
    int front = 0;
    unsigned seed = 12345;
    for (int frame = 1; frame <= FRAMES; frame++) {
        // Zero to three changes in the frame, anywhere.
        seed = seed * 1103515245u + 12345u;
        const int changes = (int)(seed >> 16) % 4;
        for (int c = 0; c < changes; c++) {
            seed = seed * 1103515245u + 12345u;
            const int x = (int)(seed >> 8) % W, y = (int)(seed >> 16) % H;
            const int w = 1 + (int)(seed >> 4) % (W - x), h = 1 + (int)(seed >> 20) % (H - y);
            for (int yy = y; yy < y + h; yy++)
                for (int xx = x; xx < x + w; xx++) glass[yy][xx] = frame * 4 + c;
            glass_fit_flip_add(&f, (glass_fit_rect_t){x, y, w, h});
        }
        glass_fit_rect_t out[2];
        const int n = glass_fit_flip(&f, out);
        CHECK(n == 0 || changes > 0);
        for (int i = 0; i < n; i++)
            for (int yy = out[i].y; yy < out[i].y + out[i].h; yy++)
                for (int xx = out[i].x; xx < out[i].x + out[i].w; xx++) buf[front ^ 1][yy][xx] = glass[yy][xx];
        if (n) front ^= 1;
        CHECK(!memcmp(buf[front], glass, sizeof glass));
    }
}

static void test_touch(void)
{
    const glass_fit_t bar = glass_fit(1920, 415, 320, 1480);
    int gx = -1, gy = -1;
    // The raster's origin is the picture's top-right corner; its far end the bottom-left.
    CHECK(glass_fit_touch(&bar, 0, 0, &gx, &gy) && gx == 1919 && gy == 0);
    CHECK(glass_fit_touch(&bar, 319, 1479, &gx, &gy) && gx == 0 && gy == 414);
    CHECK(glass_fit_touch(&bar, 160, 740, &gx, &gy) && gx == 959 && gy == 208);
    // Every glass point comes back within one picture pixel's worth of glass (1 / 0.77 = 1.3 px) of where it was drawn.
    for (int y = 0; y < 415; y += 7)
        for (int x = 0; x < 1920; x += 13) {
            const int lx = (int)((x + 0.5) * 1480 / 1920), ly = (int)((y + 0.5) * 320 / 415);
            CHECK(glass_fit_touch(&bar, ly, 1479 - lx, &gx, &gy));
            CHECK(abs(gx - x) <= 1 && abs(gy - y) <= 1);
        }
    // Off the picture: the black bars of a letterboxed 480-high glass, and off the raster.
    const glass_fit_t boxed = glass_fit(1920, 480, 320, 1480);
    CHECK(!glass_fit_touch(&boxed, 100, 1479, &gx, &gy));   // landscape x 0, left of the picture
    CHECK(!glass_fit_touch(&boxed, 100, 0, &gx, &gy));      // landscape x 1479, right of it
    CHECK(glass_fit_touch(&boxed, 319, 1479 - 100, &gx, &gy) && gx == 0 && gy == 479);   // the picture's bottom-left
    CHECK(!glass_fit_touch(&bar, -1, 5, &gx, &gy) && !glass_fit_touch(&bar, 320, 5, &gx, &gy));
    // Unturned and unscaled, a touch is where it is.
    const glass_fit_t window = glass_fit(1920, 480, 1920, 480);
    CHECK(glass_fit_touch(&window, 1234, 321, &gx, &gy) && gx == 1234 && gy == 321);
}

static void test_axis(void)
{
    CHECK(glass_fit_axis(0, 0, 4096, 320) == 0);
    CHECK(glass_fit_axis(4096, 0, 4096, 320) == 319);
    CHECK(glass_fit_axis(2048, 0, 4096, 1480) == 739);
    CHECK(glass_fit_axis(-5, 0, 4096, 320) == 0);        // a reading past the axis stays on the raster
    CHECK(glass_fit_axis(5000, 0, 4096, 320) == 319);
    CHECK(glass_fit_axis(150, 100, 200, 10) == 4);       // a range that does not start at 0
}

int main(void)
{
    test_fits();
    test_unscaled_pixels();
    test_scaled_flat_and_bars();
    test_paint_matches_blend();
    test_damage();
    test_union();
    test_flip_rects();
    test_flip_keeps_both_buffers();
    test_touch();
    test_axis();
    printf("test_glass_fit: %d checks passed\n", checks);
    return 0;
}
