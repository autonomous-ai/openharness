// Harness Max's copy of the Pro's canvas (text, rectangles, images), compiled by every Max build in place of the Pro's
// (sources.cmake). What the Max changes, for the 1920 x 480 glass's raster time on the ESP32-P4: rectangles fill two
// pixels a store, a rounded corner blends only its partly covered pixels, the blend works red and blue in one multiply,
// and a faded image's span takes four coverages at a time with no divide. Every pixel is as the Pro's paints it
// (test/raster_same.sh).
// pro_fork upstream: devices/harness-pro/firmware/main/display/pro_canvas.c
// pro_fork blob: c4a372c7320ea43407caa58f38f7eeb1938078ef (main 91f60b6a7b)
// scripts/check_pro_forks.py fails once the upstream file is no longer that blob: re-port its change here, then
// record its new blob on these lines and in main/pro_fork/upstream.txt.
#include "pro_canvas.h"
#include <string.h>
#include "pod/pod_draw.h"

enum { PRO_TEXT = 1, PRO_RECT, PRO_IMAGE, PRO_RECT_AA, PRO_RECT_AA_STROKE };
static int min_(int a, int b) { return a < b ? a : b; }
static int max_(int a, int b) { return a > b ? a : b; }
// ht_pro_over's sums with red and blue side by side in one word, 16 bits apart (a channel's sum stays below 2^13, so
// neither lane carries into the other): two multiplies a pixel fewer. Each lane rounds as ht_pro_over's channel does,
// so every pixel is the same (checked for every pair of colours and coverage).
static inline uint16_t over(uint16_t fg, uint16_t bg, unsigned a)
{
    if (a == 255) return fg;
    const unsigned b = 255 - a;
    uint32_t rb = ((fg & 0xF800u) << 5 | (fg & 31u)) * a + ((bg & 0xF800u) << 5 | (bg & 31u)) * b + 0x00800080u;
    unsigned g = ((fg >> 5) & 63) * a + ((bg >> 5) & 63) * b + 128;
    rb = (rb + ((rb >> 8) & 0x001F001Fu)) >> 8 & 0x001F001Fu;
    g = (g + (g >> 8)) >> 8;
    return (uint16_t)((rb >> 5 & 0xF800u) | g << 5 | (rb & 31u));
}

// Two pixels to a 32-bit store (the RV32's widest), four stores a turn: rectangles are most of what a screen paints, and
// a 16-bit store loop costs three instructions a pixel on the ESP32-P4. may_alias: the words write pixels read back as
// uint16_t.
typedef uint32_t __attribute__((__may_alias__)) two_px_t;
static void fill_span(uint16_t *dst, int count, uint16_t ink)
{
    if (count > 0 && ((uintptr_t)dst & 2)) {
        *dst++ = ink;
        count--;
    }
    const uint32_t two = ink * 0x10001u;
    two_px_t *w = (two_px_t *)dst;
    for (; count >= 8; count -= 8, w += 4) w[0] = w[1] = w[2] = w[3] = two;
    for (; count >= 2; count -= 2) *w++ = two;
    if (count > 0) *(uint16_t *)w = ink;
}
static void image_span(uint16_t *dst, const uint16_t *src, const uint8_t *alpha, int count)
{
    if (!alpha) {
        // The720-square landscape is opaque. A clipped row copy avoids
        // inspecting one million alpha/color bytes during every full repaint.
        memcpy(dst, src, (size_t)count * sizeof *dst);
        return;
    }
    int i = 0;
    for (; i + 4 <= count; i += 4) {
        uint32_t coverage;
        memcpy(&coverage, alpha + i, sizeof coverage); // alpha rows may be unaligned
        if (!coverage) continue;
        if (coverage == UINT32_MAX) {
            memcpy(dst + i, src + i, 4 * sizeof *dst);
            continue;
        }
        for (int j = i; j < i + 4; j++) {
            unsigned a = alpha[j];
            if (a) dst[j] = over(src[j], dst[j], a);
        }
    }
    for (; i < count; i++) {
        unsigned a = alpha[i];
        if (a) dst[i] = over(src[i], dst[i], a);
    }
}

// An image's span at opacity o (1..254): coverage a * o / 255, as (x + 1 + (x >> 8)) >> 8 is x / 255 for x below
// 65535, with no divide. Four coverages at a time as image_span: none skipped, all whole at o itself.
static void faded_span(uint16_t *dst, const uint16_t *src, const uint8_t *alpha, int count, unsigned o)
{
    int i = 0;
    if (!alpha) {
        for (; i < count; i++) dst[i] = over(src[i], dst[i], o);
        return;
    }
    for (; i + 4 <= count; i += 4) {
        uint32_t coverage;
        memcpy(&coverage, alpha + i, sizeof coverage); // alpha rows may be unaligned
        if (!coverage) continue;
        if (coverage == UINT32_MAX) {
            for (int j = i; j < i + 4; j++) dst[j] = over(src[j], dst[j], o);
            continue;
        }
        for (int j = i; j < i + 4; j++) {
            const unsigned x = alpha[j] * o, a = (x + 1 + (x >> 8)) >> 8;
            if (a) dst[j] = over(src[j], dst[j], a);
        }
    }
    for (; i < count; i++) {
        const unsigned x = alpha[i] * o, a = (x + 1 + (x >> 8)) >> 8;
        if (a) dst[i] = over(src[i], dst[i], a);
    }
}

static void glyph_span(uint16_t *dst, const uint8_t *mask, size_t first, int count, uint16_t ink)
{
    // Adjacent4-bit glyph coverages share a byte. Reading pairs skips empty
    // atlas space and writes opaque stems without a blend or nibble-index math.
    const uint8_t *src = mask + (first >> 1);
    if ((first & 1) && count) {
        unsigned a = *src++ & 15;
        if (a) *dst = over(ink, *dst, a * 17);
        dst++; count--;
    }
    for (; count >= 2; count -= 2, dst += 2) {
        unsigned pair = *src++;
        if (!pair) continue;
        if (pair == 255) { dst[0] = dst[1] = ink; continue; }
        unsigned a = pair >> 4, b = pair & 15;
        if (a) dst[0] = over(ink, dst[0], a * 17);
        if (b) dst[1] = over(ink, dst[1], b * 17);
    }
    if (count) {
        unsigned a = *src >> 4;
        if (a) *dst = over(ink, *dst, a * 17);
    }
}
static unsigned code(const ht_pro_font_t *f, uint32_t cp)
{
    int vietnamese = ht_pro_vietnamese_index(cp);
    if (vietnamese >= 0 && f->last - f->first + 1 + vietnamese < f->glyph_count)
        return f->last + 1 + (unsigned)vietnamese;
    int extra = ht_pro_extra_pos(f, cp);   // marks the face was baked with, after the Vietnamese entries
    if (extra >= 0 && f->last - f->first + 1 + 102 + extra < f->glyph_count)
        return f->last + 1 + 102 + (unsigned)extra;
    if (cp == 0x2018 || cp == 0x2019) cp = '\'';
    if (cp == 0x201c || cp == 0x201d) cp = '"';
    if (cp >= 0x2010 && cp <= 0x2015) cp = '-';
    return cp >= f->first && cp <= f->last ? cp : '?';
}
/* Glyph advances position the next glyph; atlas ink may extend beyond them.
 * Keep that last overhang inside both fit decisions and damage bounds. */
static int visible_width(const ht_pro_font_t *f, const char *text)
{
    int advance = 0, extent = 0;
    while (*text && *text != '\n') {
        const ht_pro_glyph_t *g = &f->glyphs[code(f, ht_utf8_next(&text)) - f->first];
        extent = max_(extent, advance + g->width);
        advance += g->advance;
    }
    return max_(advance, extent);
}
int ht_pro_width(const ht_pro_font_t *f, const char *text)
{
    if (!f || !text) return 0;
    // Measurement follows the same display normalization as wrapping/raster:
    // fractions and unsupported characters may expand to several glyphs.
    char visible[4096];
    ht_display_text_ex(visible, sizeof visible, text, f);
    return visible_width(f, visible);
}
static ht_run_t *run(ht_scene_t *s, int kind, int x, int y, int w, int h)
{
    if (s->count >= HT_RUNS || w <= 0 || h <= 0) return NULL;
    ht_run_t *r = &s->runs[s->count++];
    memset(r, 0, sizeof *r);
    r->pro_kind = kind; r->x = x; r->y = y; r->w = w; r->pro_height = h;
    return r;
}
bool ht_pro_text(ht_scene_t *s, int x, int y, int width, const ht_pro_font_t *font,
                 uint16_t ink, const char *text)
{
    if (!font || !text) return false;
    ht_run_t *r = run(s, PRO_TEXT, x, y, width, font->height);
    if (!r) return false;
    r->pro_font = font; r->fg = ink;
    char normalized[HT_TEXT_BYTES * 4];
    bool complete = ht_display_text_ex(normalized, sizeof normalized, text, font);
    const char *p = normalized;
    int used = 0, advance = 0, extent = 0;
    while (*p && *p != '\n') {
        const char *next = p;
        const ht_pro_glyph_t *g = &font->glyphs[code(font, ht_utf8_next(&next)) - font->first];
        int n = (int)(next - p), next_extent = max_(extent, advance + g->width);
        if (max_(next_extent, advance + g->advance) > width || used + n >= HT_TEXT_BYTES) break;
        memcpy(r->text + used, p, (size_t)n); used += n;
        advance += g->advance; extent = next_extent; p = next;
    }
    r->text[used] = 0;
    if ((*p && *p != '\n') || (!*p && !complete)) {
        // Do not consume the rejected glyph before checking this condition: it
        // can be the final glyph. Make room for dots in bytes as well as pixels.
        for (;;) {
            if (used + 3 < HT_TEXT_BYTES) {
                memcpy(r->text + used, "...", 4);
                if (visible_width(font, r->text) <= width) break;
            }
            r->text[used] = 0;
            if (!used) break;
            used--;
            while (used && ((unsigned char)r->text[used] & 0xc0) == 0x80) used--;
            r->text[used] = 0;
        }
    }
    int ink_width = visible_width(font, r->text);
    r->w = ink_width > 0 ? ink_width : 1;
    return true;
}
bool ht_pro_rect(ht_scene_t *s, int x, int y, int w, int h, int radius, uint16_t ink)
{
    ht_run_t *r = run(s, PRO_RECT, x, y, w, h);
    if (!r) return false;
    r->fg = ink; r->radius = min_(max_(0, radius), min_(w,h)/2);
    return true;
}
bool ht_pro_rect_aa(ht_scene_t *s, int x, int y, int w, int h, int radius, uint16_t ink)
{
    ht_run_t *r = run(s, PRO_RECT_AA, x, y, w, h);
    if (!r) return false;
    r->fg = ink; r->radius = min_(max_(0, radius), min_(min_(w,h)/2, 255));
    return true;
}
// A filled rounded rect with a one-pixel border in one run: exactly what ht_pro_rect_aa(ink, rad) followed by
// ht_pro_rect_aa(fill, inset by 1, rad - 1) draws, without painting the inner area twice. The fill colour rides in text[0..1].
bool ht_pro_rect_aa_stroke(ht_scene_t *s, int x, int y, int w, int h, int radius, uint16_t ink, uint16_t fill)
{
    if (w < 3 || h < 3) return ht_pro_rect_aa(s, x, y, w, h, radius, ink);   // no inner rect: the border fill alone
    ht_run_t *r = run(s, PRO_RECT_AA_STROKE, x, y, w, h);
    if (!r) return false;
    r->fg = ink; r->radius = min_(max_(0, radius), min_(min_(w,h)/2, 255));
    memcpy(r->text, &fill, sizeof fill);
    return true;
}
// The first cx in [lo, hi) where ht_pro_corner_cover(rad, cx, cy) is at least `cover`, else hi. Along a corner row the
// coverage only grows with cx (the pixel nears the circle's centre), so this bisects the very function the pixel loops
// call: the columns it splits off as none or full are, pixel for pixel, what those loops would have found.
static int cover_from(int rad, int cy, unsigned cover, int lo, int hi)
{
    while (lo < hi) {
        const int mid = (lo + hi) / 2;
        if (ht_pro_corner_cover(rad, mid, cy) >= cover) hi = mid;
        else lo = mid + 1;
    }
    return lo;
}
// The same first cx, looked for from `near` (the row before's answer: an edge moves little from one row to the next) by
// stepping, which the coverage only growing along the row also makes exact. A negative `near` bisects.
static int cover_edge(int rad, int cy, unsigned cover, int near)
{
    if (near < 0) return cover_from(rad, cy, cover, 0, rad);
    while (near > 0 && ht_pro_corner_cover(rad, near - 1, cy) >= cover) near--;
    while (near < rad && ht_pro_corner_cover(rad, near, cy) < cover) near++;
    return near;
}
static void fill_clipped(uint16_t *row, int from, int to, int x0, int x1, uint16_t ink)
{
    from = max_(from, x0);
    to = min_(to, x1);
    if (to > from) fill_span(row + from, to - from, ink);
}
// A corner row's pixels in [from, to) clipped to [x0, x1), each blended by its own coverage.
static void rect_aa_px(const ht_run_t *r, int cy, int from, int to, int x0, int x1, uint16_t *row)
{
    const int rad = r->radius;
    for (int x = max_(from, x0); x < min_(to, x1); x++) {
        int dx = x - r->x, cx = dx < rad ? dx : dx >= r->w-rad ? r->w-1-dx : -1;
        unsigned cov = cx < 0 ? 16 : ht_pro_corner_cover(rad, cx, cy);
        if (cov >= 16) row[x] = r->fg;
        else if (cov) row[x] = over(r->fg, row[x], cov*255/16);
    }
}
static void rect_aa_raster(const ht_run_t *r, int x0, int y0, int x1, int y1, ht_rect_t clip, uint16_t *out)
{
    int rad = r->radius, none = -1, full = -1;
    for (int y = y0; y < y1; y++) {
        int dy = y - r->y;
        uint16_t *row = out + (y-clip.y)*clip.w - clip.x;
        int cy = dy < rad ? dy : dy >= r->pro_height-rad ? r->pro_height-1-dy : -1;   // corner row, mirrored
        if (cy < 0) { fill_span(row + x0, x1-x0, r->fg); continue; }
        // A corner row: outside the circle up to `none`, partly covered up to `full`, then one span (the straight middle
        // with it) to the mirror image on the right. Only the partly covered pixels are worked out one by one.
        none = cover_edge(rad, cy, 1, none);
        full = cover_edge(rad, cy, 16, full);
        rect_aa_px(r, cy, r->x + none, r->x + full, x0, x1, row);
        fill_clipped(row, r->x + full, r->x + r->w - full, x0, x1, r->fg);
        rect_aa_px(r, cy, r->x + r->w - full, r->x + r->w - none, x0, x1, row);
    }
}
// The coverage of pixel (dx, dy) of a w x h AA rect of corner radius rad (the corner circle's, mirrored into each corner).
static unsigned rect_cover(int rad, int w, int h, int dx, int dy)
{
    int cy = dy < rad ? dy : dy >= h-rad ? h-1-dy : -1;
    int cx = dx < rad ? dx : dx >= w-rad ? w-1-dx : -1;
    return cx < 0 || cy < 0 ? 16 : ht_pro_corner_cover(rad, cx, cy);
}
static void blend_px(uint16_t *p, uint16_t ink, unsigned cov)
{
    if (cov >= 16) *p = ink;
    else if (cov) *p = over(ink, *p, cov*255/16);
}
static void rect_aa_stroke_raster(const ht_run_t *r, int x0, int y0, int x1, int y1, ht_rect_t clip, uint16_t *out)
{
    int rad = r->radius, inner = rad > 0 ? rad-1 : 0, w = r->w, h = r->pro_height;
    uint16_t ink = r->fg, fill;
    memcpy(&fill, r->text, sizeof fill);
    int none = -1, full = -1, inone = -1, ifull = -1;   // the last corner row's edges, near where this row's are
    for (int y = y0; y < y1; y++) {
        int dy = y - r->y;
        uint16_t *row = out + (y-clip.y)*clip.w - clip.x;
        if (dy >= 1 && dy < h-1 && dy >= rad && dy < h-rad) {   // straight rows: border, fill, border
            if (x0 <= r->x) row[r->x] = ink;
            int lo = max_(x0, r->x+1), hi = min_(x1, r->x+w-1);
            if (hi > lo) fill_span(row + lo, hi-lo, fill);
            if (x1 > r->x+w-1 && x0 <= r->x+w-1) row[r->x+w-1] = ink;
            continue;
        }
        // Border and corner rows: the corner pixels take the border fill and then the inner one over it; between the
        // corners (dx in [rad, w-rad)) the row is plain: the border on the top and bottom edges, the fill under them.
        uint16_t mid = dy == 0 || dy == h-1 ? ink : fill;
        fill_clipped(row, r->x + rad, r->x + w - rad, x0, x1, mid);
        if (rad == 0) continue;
        // The left corner's columns dx = 0 .. rad-1, the right one's mirrored (dx = w-1-c), split where either circle's
        // coverage turns from none to partial to full (cover_edge). A span with no partial coverage is one thing (the
        // pixels as they were, the border or the fill); only the others are blended pixel by pixel, as before.
        const bool inside = dy >= 1 && dy < h-1;   // the inner rect covers this row (the border's own rows it does not)
        const int cy = dy < rad ? dy : h-1-dy;     // a corner row of the border's circle (rows that are not are straight)
        const int iy = dy-1 < inner ? dy-1 : dy-1 >= h-2-inner ? h-3-(dy-1) : -1;   // the inner circle's, or none
        none = cover_edge(rad, cy, 1, none);
        full = cover_edge(rad, cy, 16, full);
        const bool inner_corner = inside && iy >= 0 && inner > 0;
        if (inner_corner) {
            inone = cover_edge(inner, iy, 1, inone);
            ifull = cover_edge(inner, iy, 16, ifull);
        }
        // In the inner rect's columns (c-1); a straight inner row covers all of them.
        const int in_none = inner_corner ? inone : 0, in_full = inner_corner ? ifull : 0;
        int cut[7] = {0, rad, none, full}, n = 4;
        if (inside) { cut[n++] = 1; cut[n++] = 1 + in_none; cut[n++] = 1 + in_full; }
        for (int i = 1; i < n; i++)   // insertion sort: seven at most
            for (int j = i; j > 0 && cut[j-1] > cut[j]; j--) { int t = cut[j]; cut[j] = cut[j-1]; cut[j-1] = t; }
        for (int i = 0; i + 1 < n; i++) {
            const int c = cut[i], e = cut[i+1];
            if (c == e) continue;
            const int o = c < none ? 0 : c < full ? 1 : 2;   // the border's circle: none, partial, full
            const int f = !inside || c < 1 || c-1 < in_none ? 0 : c-1 < in_full ? 1 : 2;   // the inner one's
            for (int side = 0; side < 2; side++) {
                const int from = side ? r->x + w - e : r->x + c, to = side ? r->x + w - c : r->x + e;
                if (o == 1 || f == 1) {
                    for (int x = max_(from, x0); x < min_(to, x1); x++) {
                        int dx = x - r->x;
                        blend_px(row + x, ink, rect_cover(rad, w, h, dx, dy));
                        if (dx >= 1 && dx < w-1 && inside)
                            blend_px(row + x, fill, rect_cover(inner, w-2, h-2, dx-1, dy-1));
                    }
                } else if (f == 2) fill_clipped(row, from, to, x0, x1, fill);
                else if (o == 2) fill_clipped(row, from, to, x0, x1, ink);
            }
        }
    }
}
// An image drawn at `opacity` (1..254 of 255; anything else is plain): the run's radius holds it.
bool ht_pro_image_faded(ht_scene_t *s, int x, int y, const ht_pro_bitmap_t *bitmap, unsigned opacity)
{
    if (!ht_pro_image(s, x, y, bitmap)) return false;
    if (opacity > 0 && opacity < 255) s->runs[s->count - 1].radius = (uint8_t)opacity;
    return true;
}
bool ht_pro_image(ht_scene_t *s, int x, int y, const ht_pro_bitmap_t *bitmap)
{
    if (!bitmap || (!bitmap->pixels && !bitmap->asset)) return false;
    ht_run_t *r = run(s, PRO_IMAGE, x, y, bitmap->width, bitmap->height);
    if (!r) return false;
    r->bitmap = *bitmap;
    return true;
}
void ht_pro_raster(const ht_run_t *r, ht_rect_t clip, uint16_t *out)
{
    int x0 = max_(clip.x,r->x), x1 = min_(clip.x+clip.w,r->x+r->w);
    int y0 = max_(clip.y,r->y), y1 = min_(clip.y+clip.h,r->y+r->pro_height);
    if (x0 >= x1 || y0 >= y1) return;
    if (r->pro_kind == PRO_RECT) {
        int rad = r->radius;
        for (int y = y0; y < y1; y++) {
            int dy = y-r->y, inset = 0;
            if (dy >= r->pro_height-rad) dy = r->pro_height-1-dy;
            if (dy < rad) {
                int vertical = rad-1-dy;
                while (inset < rad && (rad-1-inset)*(rad-1-inset) + vertical*vertical > rad*rad) inset++;
            }
            int left = max_(x0, r->x + inset), right = min_(x1, r->x + r->w - inset);
            if (right > left) fill_span(out + (y-clip.y)*clip.w + left-clip.x, right-left, r->fg);
        }
    } else if (r->pro_kind == PRO_RECT_AA) {
        rect_aa_raster(r, x0, y0, x1, y1, clip, out);
    } else if (r->pro_kind == PRO_RECT_AA_STROKE) {
        rect_aa_stroke_raster(r, x0, y0, x1, y1, clip, out);
    } else if (r->pro_kind == PRO_IMAGE) {
        for (int y=y0;y<y1;y++) {
            size_t src=(size_t)(y-r->y)*r->bitmap.width+x0-r->x;
            uint16_t *dst=out+(y-clip.y)*clip.w+x0-clip.x;
            if (r->radius) {   // faded (ht_pro_image_faded): every pixel's coverage scaled by the opacity
                faded_span(dst, r->bitmap.pixels + src, r->bitmap.alpha ? r->bitmap.alpha + src : NULL, x1-x0,
                           r->radius);
            } else {
                image_span(dst, r->bitmap.pixels + src, r->bitmap.alpha ? r->bitmap.alpha + src : NULL, x1-x0);
            }
        }
    } else if (r->pro_kind == PRO_TEXT) {
        const ht_pro_font_t *f=r->pro_font;
        const char *p=r->text; int gx=r->x;
        while (*p && gx < x1) {
            const ht_pro_glyph_t *g=&f->glyphs[code(f,ht_utf8_next(&p))-f->first];
            int left=max_(x0,gx), right=min_(x1,gx+g->width);
            if (right > left) for(int y=y0;y<y1;y++) {
                int row=y-r->y;
                if (g->rows) { row-=g->top; if (row<0 || row>=g->rows) continue; }
                glyph_span(out+(y-clip.y)*clip.w+left-clip.x, f->alpha+g->offset,
                           (size_t)row*g->width+left-gx, right-left, r->fg);
            }
            gx+=g->advance;
        }
    }
    else if (r->pro_kind >= POD_KIND_BASE) pod_draw_raster(r, clip, out);
}
