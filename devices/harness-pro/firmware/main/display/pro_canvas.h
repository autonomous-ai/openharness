#pragma once
#include "terminal.h"

#include "pro_font_type.h"   // ht_pro_glyph_t, struct ht_pro_font, ht_pro_24 / 32 / 42
// Extra atlas entries follow Latin-1: the 90 Vietnamese precomposed letters,
// then the 12 letters outside that block. Keep in sync with gen_fonts.py.
static inline int ht_pro_vietnamese_index(uint32_t cp)
{
    if (cp < 256) return -1;
    if (cp >= 0x1ea0 && cp <= 0x1ef9) return (int)(cp - 0x1ea0);
    static const uint16_t extra[] = {0x102,0x103,0x110,0x111,0x128,0x129,
                                   0x168,0x169,0x1a0,0x1a1,0x1af,0x1b0};
    for (unsigned i = 0; i < sizeof extra / sizeof extra[0]; i++)
        if (cp == extra[i]) return 90 + (int)i;
    return -1;
}
// Position of cp in the face's extras table (the marks baked after the Vietnamese entries), or -1. The atlas
// index is 102 + position. The table is per face (gen_fonts.py): Pets 9 marks, old faces none.
static inline int ht_pro_extra_pos(const ht_pro_font_t *f, uint32_t cp)
{
    for (unsigned i = 0; f && f->extras && i < f->extra_count; i++)
        if (cp == f->extras[i]) return (int)i;
    return -1;
}
// Does the face draw cp from its extras table? (Latin-1 and Vietnamese are always drawn; the typographic quotes and
// dashes alias to ASCII.)
static inline bool ht_pro_can_draw(const ht_pro_font_t *f, uint32_t cp)
{
    return ht_pro_extra_pos(f, cp) >= 0;
}
int ht_pro_width(const ht_pro_font_t *font, const char *text);
bool ht_pro_text(ht_scene_t *s, int x, int y, int width, const ht_pro_font_t *font,
                 uint16_t ink, const char *text);
bool ht_pro_rect(ht_scene_t *s, int x, int y, int w, int h, int radius, uint16_t ink);
// Like ht_pro_rect, but each corner pixel is blended onto the colour under it by its coverage of the circle.
bool ht_pro_rect_aa(ht_scene_t *s, int x, int y, int w, int h, int radius, uint16_t ink);
// A rounded rect in `fill` with a one-pixel border in `ink`, as one run: pixel for pixel what ht_pro_rect_aa(ink, radius) followed by
// ht_pro_rect_aa(fill, x+1, y+1, w-2, h-2, radius-1) draws. Smaller than 3 x 3 it is the border fill alone.
bool ht_pro_rect_aa_stroke(ht_scene_t *s, int x, int y, int w, int h, int radius, uint16_t ink, uint16_t fill);
bool ht_pro_image(ht_scene_t *s, int x, int y, const ht_pro_bitmap_t *bitmap);
bool ht_pro_image_faded(ht_scene_t *s, int x, int y, const ht_pro_bitmap_t *bitmap, unsigned opacity);   // opacity 1..254 of 255
void ht_pro_raster(const ht_run_t *run, ht_rect_t clip, uint16_t *out);

// Blend fg over bg by a/255 (RGB565).
static inline uint16_t ht_pro_over(uint16_t fg, uint16_t bg, unsigned a)
{
    if (a == 255) return fg;
    unsigned b = 255 - a;
    // Exact rounded division by255 for these bounded channel products. This
    // avoids the wide multiply used for a constant division on the P4's RV32.
    unsigned r = (fg >> 11) * a + (bg >> 11) * b + 128;
    unsigned g = ((fg >> 5) & 63) * a + ((bg >> 5) & 63) * b + 128;
    unsigned v = (fg & 31) * a + (bg & 31) * b + 128;
    r = (r + (r >> 8)) >> 8;
    g = (g + (g >> 8)) >> 8;
    v = (v + (v >> 8)) >> 8;
    return (uint16_t)((r << 11) | (g << 5) | v);
}
static inline unsigned ht_pro_isqrt(unsigned n)
{
    unsigned r = 0, bit = 1u << 30;
    while (bit > n) bit >>= 2;
    for (; bit; bit >>= 2) {
        if (n >= r + bit) { n -= r + bit; r = (r >> 1) + bit; } else r >>= 1;
    }
    return r;
}
// The corner circle's coverage of the pixel at (cx, cy) from the corner circle's centre, in sixteenths: the
// pixel centre's distance from the centre against the radius, a one-pixel linear ramp (as pod_arc's edges).
static inline unsigned ht_pro_corner_cover(int rad, int px, int py)
{
    int vx = (px*2+1-2*rad)*8, vy = (py*2+1-2*rad)*8;   // 16ths from the circle's centre to the pixel's centre
    int d2 = vx*vx + vy*vy;
    // coverage = rad*16 + 8 - floor(sqrt(d2)), clamped to 0..16. Only the one-pixel edge ring needs the square root: floor(sqrt(d2))
    // is at most rad*16 - 8 (full) exactly when d2 < (rad*16 - 7)^2, and at least rad*16 + 8 (none) exactly when d2 >= (rad*16 + 8)^2.
    if (rad > 0) {
        int lo = rad*16 - 7, hi = rad*16 + 8;
        if (d2 < lo*lo) return 16;
        if (d2 >= hi*hi) return 0;
    }
    int cov = rad*16 - (int)ht_pro_isqrt((unsigned)d2) + 8;
    return cov <= 0 ? 0 : cov >= 16 ? 16 : (unsigned)cov;
}
