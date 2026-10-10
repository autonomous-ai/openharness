#include "pro_canvas.h"
#include <string.h>
#ifdef DEVICE_POD
#include "pod/pod_draw.h"
#endif

enum { PRO_TEXT = 1, PRO_RECT, PRO_IMAGE };
static int min_(int a, int b) { return a < b ? a : b; }
static int max_(int a, int b) { return a > b ? a : b; }
static uint16_t over(uint16_t fg, uint16_t bg, unsigned a)
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

static void fill_span(uint16_t *dst, int count, uint16_t ink)
{
    for (int i = 0; i < count; i++) dst[i] = ink;
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
    ht_display_text(visible, sizeof visible, text, &ht_mono_28);
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
    bool complete = ht_display_text(normalized, sizeof normalized, text, &ht_mono_28);
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
/* Return a bounded UTF-8 line and advance past one word-wrap boundary. */
static void line(const char **cursor, const ht_pro_font_t *font, int width, char out[HT_TEXT_BYTES])
{
    const char *begin = *cursor, *p, *last_space = NULL, *end;
    while (*begin == ' ') begin++;
    p = end = begin;
    int advance = 0, extent = 0;
    while (*p && *p != '\n') {
        const char *start = p;
        unsigned cp = code(font, ht_utf8_next(&p));
        const ht_pro_glyph_t *g = &font->glyphs[cp - font->first];
        int next_extent = max_(extent, advance + g->width);
        if (max_(next_extent, advance + g->advance) > width || p - begin >= HT_TEXT_BYTES) {
            p = start;
            if (last_space) p = last_space;
            break;
        }
        advance += g->advance; extent = next_extent; end = p;
        if (cp == ' ') last_space = start;
    }
    if (!*p || *p == '\n') end = p;
    else if (p > begin) end = p;
    if (end == begin && *p && *p != '\n') { ht_utf8_next(&p); end = p; }
    size_t bytes = (size_t)(end - begin);
    if (bytes >= HT_TEXT_BYTES) bytes = HT_TEXT_BYTES - 1;
    memcpy(out, begin, bytes); out[bytes] = 0;
    while (bytes && out[bytes-1] == ' ') out[--bytes] = 0;
    p = end;
    if (*p == '\n') p++; else while (*p == ' ') p++;
    *cursor = p;
}
int ht_pro_text_rows(const char *text, const ht_pro_font_t *font, int width)
{
    if (!font || width <= 0 || !text || !*text) return 0;
    char visible[4096], row[HT_TEXT_BYTES];
    ht_display_text(visible, sizeof visible, text, &ht_mono_28);
    const char *p = visible; int count = 0;
    while (*p) { line(&p, font, width, row); count++; }
    return count;
}
int ht_pro_wrap(ht_scene_t *s, int x, int y, int width, int rows, int skip,
                const ht_pro_font_t *font, uint16_t ink, const char *text)
{
    if (!font || width <= 0 || rows <= 0 || !text) return 0;
    char visible[4096], row[HT_TEXT_BYTES];
    ht_display_text(visible, sizeof visible, text, &ht_mono_28);
    const char *p = visible; int shown = 0;
    while (*p && skip-- > 0) line(&p, font, width, row);
    while (*p && shown < rows) {
        line(&p, font, width, row);
        ht_pro_text(s, x, y + shown * font->height, width, font, ink, row);
        shown++;
    }
    return shown;
}
void ht_pro_center(ht_scene_t *s, int y, const ht_pro_font_t *f, uint16_t ink, const char *text)
{
    int width = min_(ht_pro_width(f, text), HT_WIDTH - 80);
    ht_pro_text(s, (HT_WIDTH-width)/2, y, width, f, ink, text);
}
bool ht_pro_rect(ht_scene_t *s, int x, int y, int w, int h, int radius, uint16_t ink)
{
    ht_run_t *r = run(s, PRO_RECT, x, y, w, h);
    if (!r) return false;
    r->fg = ink; r->radius = min_(max_(0, radius), min_(w,h)/2);
    return true;
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
    } else if (r->pro_kind == PRO_IMAGE) {
        for (int y=y0;y<y1;y++) {
            size_t src=(size_t)(y-r->y)*r->bitmap.width+x0-r->x;
            uint16_t *dst=out+(y-clip.y)*clip.w+x0-clip.x;
            if (r->radius) {   // faded (ht_pro_image_faded): every pixel's coverage scaled by the opacity
                for (int i = 0; i < x1-x0; i++) {
                    unsigned a = r->bitmap.alpha ? r->bitmap.alpha[src+i] : 255;
                    a = a * r->radius / 255;
                    if (a) dst[i] = over(r->bitmap.pixels[src+i], dst[i], a);
                }
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
            if (right > left) for(int y=y0;y<y1;y++)
                glyph_span(out+(y-clip.y)*clip.w+left-clip.x, f->alpha+g->offset,
                           (size_t)(y-r->y)*g->width+left-gx, right-left, r->fg);
            gx+=g->advance;
        }
    }
#ifdef DEVICE_POD
    else if (r->pro_kind >= POD_KIND_BASE) pod_draw_raster(r, clip, out);
#endif
}
