#include "terminal.h"
#include <string.h>
#include "arc_geometry.inc"

static int imin(int a, int b) { return a < b ? a : b; }
static int imax(int a, int b) { return a > b ? a : b; }
static uint16_t be16(uint16_t v) { return (uint16_t)((v << 8) | (v >> 8)); }
static uint32_t punctuation_alias(uint32_t cp)
{
    // One cell in, one cell out. Keep the original UTF-8 in the scene/wire;
    // reuse existing ASCII pixels for typographic punctuation outside Latin-1.
    switch (cp) {
    case 0x2010: case 0x2011: case 0x2012: case 0x2013: case 0x2014: case 0x2015:
    case 0x2212: return '-';
    case 0x2018: case 0x2019: case 0x201a: case 0x201b: return '\'';
    case 0x201c: case 0x201d: case 0x201e: case 0x201f: return '"';
    default: return cp;
    }
}
static const ht_font_t *glyph_font(const ht_font_t *font, uint32_t cp)
{
    if (font == &ht_mono_24) {
        if (cp == 0x2197) return &ht_open_24;
        if (cp == 0x2192) return &ht_right_24;
        if (cp == 0xe000) return &ht_bell_24;
    }
    // Authored arrows in a recap use the same precomputed glyph as its marker.
    // Identical cell metrics: no scaling, allocation, or extra text runs.
    return cp == 0x2197 && font == &ht_mono_20 ? &ht_open_20 : font;
}
static uint32_t font_codepoint(const ht_font_t *font, uint32_t cp)
{
    // Space is always an empty cell, including compact Unicode-only atlases.
    if (cp == ' ' || (cp >= font->first && cp <= font->last)) return cp;
    font = glyph_font(font, cp);
    cp = punctuation_alias(cp);
    if (cp >= font->first && cp <= font->last) return cp;
    return font->first <= '?' && font->last >= '?' ? '?' : ' ';
}
uint16_t ht_rgb(unsigned c)
{
    return (uint16_t)(((c >> 8) & 0xf800) | ((c >> 5) & 0x07e0) | ((c >> 3) & 0x1f));
}
uint32_t ht_utf8_next(const char **p)
{
    const unsigned char *s = (const unsigned char *)*p;
    uint32_t c = *s++;
    if (!c)
        return 0;
    if (c >= 0xc2 && c <= 0xf4) {
        int n = c < 0xe0 ? 1 : c < 0xf0 ? 2 : 3;
        uint32_t v = c & ((1u << (6 - n)) - 1);
        for (int i = 0; i < n; i++) {
            if ((s[i] & 0xc0) != 0x80) {
                *p = (const char *)s;
                return '?';
            }
            v = (v << 6) | (s[i] & 63);
        }
        s += n;
        c = v;
    } else if (c >= 128)
        c = '?';
    *p = (const char *)s;
    return c;
}
void ht_scene_clear(ht_scene_t *s, uint16_t bg)
{
    s->count = 0;
    s->background = bg;
}
bool ht_text(ht_scene_t *s, int x, int y, int w, const ht_font_t *font, uint16_t fg, uint16_t bg,
             const char *text)
{
    if (s->count >= HT_RUNS || !font || w <= 0)
        return false;
    ht_run_t *r = &s->runs[s->count++];
    memset(r, 0, sizeof(*r));
    r->x = x;
    r->y = y;
    r->w = w;
    r->font = font;
    r->fg = fg;
    r->bg = bg;
    const char *p = text ? text : "";
    size_t n = 0;
    int cells = w / font->width;
    while (*p && cells-- > 0) {
        const char *start = p;
        ht_utf8_next(&p);
        size_t len = (size_t)(p - start);
        if (n + len >= sizeof(r->text))
            break;
        memcpy(r->text + n, start, len);
        n += len;
    }
    r->text[n] = 0;
    return true;
}
bool ht_ascii_text(ht_scene_t *s, int x, int y, int w, const ht_font_t *font,
                   uint16_t fg, uint16_t bg, const char *text, size_t cells)
{
    if (s->count >= HT_RUNS || !font || !font->width || w <= 0 || (!text && cells)) return false;
    size_t n = (size_t)w / font->width;
    if (n > cells) n = cells;
    if (n >= HT_TEXT_BYTES) n = HT_TEXT_BYTES - 1;
    ht_run_t *r = &s->runs[s->count++];
    memset(r, 0, sizeof *r);
    r->x = x; r->y = y; r->w = w; r->font = font; r->fg = fg; r->bg = bg;
    if (n) memcpy(r->text, text, n);
    return true;
}
void ht_center(ht_scene_t *s, int y, const ht_font_t *font, uint16_t fg, const char *text)
{
    const char *p = text;
    int n = 0;
    while (*p) {
        ht_utf8_next(&p);
        n++;
    }
    int w = imin(n * font->width, HT_WIDTH - 80);
    ht_text(s, (HT_WIDTH - w) / 2, y, w, font, fg, s->background, text);
}
static void arc_text(ht_scene_t *s, uint16_t fg, const char *text, bool bottom)
{
    if (!text || !*text) return;
    if (!ht_text(s, HT_ARC_X, HT_ARC_Y, HT_ARC_COLS * ht_mono_24.width,
                 &ht_mono_24, fg, s->background, text)) return;
    ht_run_t *r = &s->runs[s->count - 1];
    // A long name ends at a word boundary; the pane list retains its full name.
    if (strlen(text ? text : "") > strlen(r->text)) {
        char *last = strrchr(r->text, ' ');
        if (last && last - r->text >= HT_ARC_COLS / 2) *last = 0;
    }
    r->arc = bottom ? 2 : 1;
    r->y = bottom ? HT_HEIGHT - HT_ARC_Y - HT_ARC_HEIGHT : HT_ARC_Y;
    r->w = HT_ARC_WIDTH;
}
void ht_arc_title(ht_scene_t *s, uint16_t fg, const char *text) { arc_text(s, fg, text, false); }
void ht_arc_status(ht_scene_t *s, uint16_t fg, const char *text) { arc_text(s, fg, text, true); }
const char *ht_take_line(const char **cursor, int cols)
{
    const char *p = *cursor, *start = p, *space = NULL, *end = p;
    int n = 0;
    while (*p && *p != '\n' && n < cols) {
        if (*p == ' ')
            space = p;
        ht_utf8_next(&p);
        n++;
        end = p;
    }
    if (*p && *p != '\n' && space && space > start) {
        end = space;
        p = space + 1;
    } else if (*p == '\n')
        p++;
    *cursor = p;
    return end;
}
int ht_text_rows(const char *text, const ht_font_t *font, int width)
{
    if (!font || !font->width || width < font->width) return 0;
    const char *p = text ? text : "";
    int rows = 0;
    while (*p) { ht_take_line(&p, width / font->width); rows++; }
    return rows;
}
bool ht_can_display(const char *text, const ht_font_t *font, int width, int lines)
{
    if (!font || !font->width || width < font->width || lines < 1)
        return false;
    const char *p = text ? text : "";
    while (*p) {
        uint32_t cp = ht_utf8_next(&p);
        const ht_font_t *glyph = glyph_font(font, cp);
        if (cp < glyph->first || cp > glyph->last) cp = punctuation_alias(cp);
        if (cp != '\n' && cp != ' ' && (cp < glyph->first || cp > glyph->last || (cp >= 127 && cp < 160)))
            return false;
    }
    p = text ? text : "";
    int rows = 0;
    while (*p) {
        if (++rows > lines)
            return false;
        ht_take_line(&p, width / font->width);
    }
    return true;
}
int ht_wrap(ht_scene_t *s, int x, int y, int w, int lines, int skip, const ht_font_t *f,
            uint16_t fg, const char *text)
{
    if (!f || !f->width || w < f->width || lines <= 0)
        return 0;
    const char *p = text ? text : "";
    int row = 0, shown = 0, cols = w / f->width;
    while (*p && shown < lines) {
        const char *start = p;
        const char *end = ht_take_line(&p, cols);
        if (row++ < skip)
            continue;
        char line[HT_TEXT_BYTES];
        size_t len = (size_t)(end - start);
        if (len >= sizeof(line))
            len = sizeof(line) - 1;
        memcpy(line, start, len);
        line[len] = 0;
        ht_text(s, x, y + shown * f->height, w, f, fg, s->background, line);
        shown++;
    }
    // Keep the slots after a wrapped block stable when its line count changes.
    // Otherwise one extra prompt line makes every following button look moved.
    while (shown < lines) {
        ht_text(s, x, y + shown * f->height, w, f, fg, s->background, "");
        shown++;
    }
    return row;
}
ht_rect_t ht_run_bounds(const ht_run_t *r)
{
    if (r->arc) {
        const char *p = r->text; int count = 0;
        while (*p && count < HT_ARC_COLS) { ht_utf8_next(&p); count++; }
        if (!count) return (ht_rect_t){0, 0, 0, 0};
        int sn = arc_trig[count - 1][0], cs = arc_trig[count - 1][1];
        // Tight, conservative ink bounds. The fixed cache remains 416x128, but
        // a short name must not dirty that whole rectangle on every pane switch.
        int half_w = (((HT_ARC_CELL_WIDTH + 1) * cs + (HT_ARC_CELL_HEIGHT + 1) * sn) >> 15) + 2;
        int half_h = (((HT_ARC_CELL_HEIGHT + 1) * cs + (HT_ARC_CELL_WIDTH + 1) * sn) >> 15) + 2;
        int left = 233 - (205 * sn >> 14) - half_w - 1;
        int bottom = 233 - (205 * cs >> 14) + half_h + 1;
        return (ht_rect_t){left, r->arc == 2 ? HT_HEIGHT - bottom : HT_ARC_Y,
            2 * (233 - left), bottom - HT_ARC_Y};
    }
    return (ht_rect_t){r->x, r->y, r->w, r->font->height};
}
static bool intersect(ht_rect_t a, ht_rect_t b)
{
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
static ht_rect_t united(ht_rect_t a, ht_rect_t b)
{
    int x = imin(a.x, b.x), y = imin(a.y, b.y);
    return (ht_rect_t){x, y, imax(a.x + a.w, b.x + b.w) - x, imax(a.y + a.h, b.y + b.h) - y};
}
static void damage_add(ht_damage_t *d, ht_rect_t r)
{
    int x = imax(0, r.x) & ~1, y = imax(0, r.y) & ~1, x2 = imin(HT_WIDTH, (r.x + r.w + 1) & ~1),
        y2 = imin(HT_HEIGHT, (r.y + r.h + 1) & ~1);
    r = (ht_rect_t){x, y, x2 - x, y2 - y};
    if (r.w <= 0 || r.h <= 0)
        return;
    for (int i = 0; i < d->count; i++) {
        ht_rect_t u = united(d->rect[i], r);
        if (intersect(d->rect[i], r) || u.w * u.h <= d->rect[i].w * d->rect[i].h + r.w * r.h + 64) {
            r = u;
            d->rect[i] = d->rect[--d->count];
            i = -1;
        }
    }
    if (d->count == HT_DAMAGE_MAX) {
        d->count = 1;
        d->rect[0] = (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT};
        return;
    }
    d->rect[d->count++] = r;
}
#ifdef DEVICE_LAYOUT_BENCH
static bool damage_fast_ascii = true, raster_fast_ascii = true;
void ht_raster_fast_ascii(bool enabled) { raster_fast_ascii = enabled; }
void ht_damage_fast_ascii(bool enabled) { damage_fast_ascii = enabled; }
#endif
void ht_damage(const ht_scene_t *a, const ht_scene_t *b, ht_damage_t *d)
{
    memset(d, 0, sizeof(*d));
    if (!a || a->background != b->background) {
        damage_add(d, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT});
    } else
        for (int i = 0; i < imax(a->count, b->count); i++) {
            if (i < a->count && i < b->count &&
                memcmp(&a->runs[i], &b->runs[i], sizeof(ht_run_t)) == 0)
                continue;
            if (i < a->count && i < b->count) {
                const ht_run_t *old = &a->runs[i], *next = &b->runs[i];
                if (!old->arc && !next->arc && old->x == next->x && old->y == next->y && old->w == next->w &&
                    old->font == next->font && old->fg == next->fg && old->bg == next->bg) {
                    const char *p = old->text, *q = next->text;
                    int cell = 0, first = -1, last = -1;
                    bool ascii = old->font->first == 32 && old->font->last >= 126;
#ifdef DEVICE_LAYOUT_BENCH
                    ascii = ascii && damage_fast_ascii;
#endif
                    while (*p || *q) {
                        uint32_t pc = (uint8_t)*p, qc = (uint8_t)*q;
                        if (ascii && (pc | qc) < 128) {
                            // Artwork is one printable byte per cell. Avoid
                            // decoding and alias lookup for every tentacle cell.
                            // Missing trailing cells still render as spaces.
                            if (pc) p++; else pc = ' ';
                            if (qc) q++; else qc = ' ';
                            if (pc < 32 || pc > old->font->last) pc = '?';
                            if (qc < 32 || qc > old->font->last) qc = '?';
                        } else {
                            pc = *p ? ht_utf8_next(&p) : ' ';
                            qc = *q ? ht_utf8_next(&q) : ' ';
                            pc = font_codepoint(old->font, pc);
                            qc = font_codepoint(old->font, qc);
                        }
                        if (pc != qc) {
                            if (first < 0)
                                first = cell;
                            last = cell;
                        }
                        cell++;
                    }
                    if (first >= 0)
                        damage_add(d, (ht_rect_t){next->x + first * next->font->width, next->y,
                                                  (last - first + 1) * next->font->width,
                                                  next->font->height});
                    continue;
                }
            }
            if (i < a->count)
                damage_add(d, ht_run_bounds(&a->runs[i]));
            if (i < b->count)
                damage_add(d, ht_run_bounds(&b->runs[i]));
        }
    for (int i = 0; i < d->count; i++)
        d->pixels += (uint32_t)d->rect[i].w * d->rect[i].h;
}
static void fill(uint16_t *p, size_t n, uint16_t c)
{
    for (size_t i = 0; i < n; i++)
        p[i] = c;
}
static uint16_t blend(uint16_t fg, uint16_t bg, unsigned alpha)
{
    unsigned r = (((fg >> 11) * alpha + (bg >> 11) * (3 - alpha)) + 1) / 3;
    unsigned g = ((((fg >> 5) & 63) * alpha + ((bg >> 5) & 63) * (3 - alpha)) + 1) / 3;
    unsigned b = (((fg & 31) * alpha + (bg & 31) * (3 - alpha)) + 1) / 3;
    return be16((r << 11) | (g << 5) | b);
}

// The small ASCII artwork uses only a handful of characters. Expand each used
// glyph once for its font/palette, then copy clipped rows directly into DMA
// strips. Fixed capacity, renderer-owned: no allocation and no per-frame churn.
// Ordinary text and Unicode fonts retain the general renderer below.
enum { GLYPH_SLOTS = 24, GLYPH_PIXELS = 50, ASCII_COUNT = 95 };
typedef struct {
    uint16_t pixels[GLYPH_SLOTS][GLYPH_PIXELS];
    uint8_t index[ASCII_COUNT], code[GLYPH_SLOTS], next;
    const ht_font_t *font;
    uint16_t fg, bg;
} glyph_cache_t;
static glyph_cache_t glyph_cache;
static bool glyph_cache_enabled = true;
static uint32_t glyph_builds;
void ht_glyph_cache_enable(bool enabled) { glyph_cache_enabled = enabled; }
uint32_t ht_glyph_cache_builds(void) { return glyph_builds; }
size_t ht_glyph_cache_bytes(void) { return sizeof glyph_cache; }

static bool glyph_cache_prepare(const ht_font_t *f, uint16_t fg, uint16_t bg)
{
    if (!glyph_cache_enabled || f->first != 32 || f->last != 126 ||
        !f->width || f->width > 5 || !f->height || f->height > 10) return false;
    if (glyph_cache.font != f || glyph_cache.fg != fg || glyph_cache.bg != bg) {
        memset(glyph_cache.index, 0, sizeof glyph_cache.index);
        memset(glyph_cache.code, 0, sizeof glyph_cache.code);
        glyph_cache.next = 0;
        glyph_cache.font = f; glyph_cache.fg = fg; glyph_cache.bg = bg;
    }
    return true;
}
static const uint16_t *glyph_cached(uint32_t c, const uint8_t *glyph,
                                    const uint16_t palette[4])
{
    unsigned code = c - 32;
    if (glyph_cache.index[code]) return glyph_cache.pixels[glyph_cache.index[code] - 1];
    unsigned slot = glyph_cache.next;
    glyph_cache.next = (slot + 1) % GLYPH_SLOTS;
    if (glyph_cache.code[slot]) glyph_cache.index[glyph_cache.code[slot] - 1] = 0;
    glyph_cache.index[code] = slot + 1;
    glyph_cache.code[slot] = code + 1;
    unsigned pixels = glyph_cache.font->width * glyph_cache.font->height;
    for (unsigned k = 0; k < pixels; k++)
        glyph_cache.pixels[slot][k] = palette[(glyph[k >> 2] >> ((3 - (k & 3)) * 2)) & 3];
    glyph_builds++;
    return glyph_cache.pixels[slot];
}

// The renderer owns two 13 KiB 2-bit masks plus bounded row-ink spans.
// Upper/lower text have independent keys, so they never evict each other.
// Scenes retain immutable text, allowing old scenes to rasterize correctly.
typedef struct {
    uint8_t mask[HT_ARC_WIDTH * HT_ARC_HEIGHT / 4];
    uint16_t left[HT_ARC_HEIGHT], right[HT_ARC_HEIGHT];
    char text[HT_TEXT_BYTES];
    bool valid;
} arc_cache_t;
static arc_cache_t arc_caches[2];
static uint32_t arc_builds;
uint32_t ht_arc_cache_builds(void) { return arc_builds; }
#ifdef DEVICE_LAYOUT_BENCH
static bool arc_fast = true, arc_tight = true;
void ht_arc_tight_bounds(bool enabled)
{
    arc_tight = enabled;
    arc_caches[0].valid = arc_caches[1].valid = false;
}
void ht_arc_fast_sampling(bool enabled)
{
    arc_fast = enabled;
    arc_caches[0].valid = arc_caches[1].valid = false;
}
static unsigned glyph_alpha_reference(const uint8_t *glyph, int x, int y)
{
    if (x < 0 || x >= HT_ARC_CELL_WIDTH || y < 0 || y >= HT_ARC_CELL_HEIGHT) return 0;
    unsigned k = (unsigned)y * HT_ARC_CELL_WIDTH + (unsigned)x;
    return (glyph[k >> 2] >> ((3 - (k & 3)) * 2)) & 3;
}
#endif

static void glyph_coverage(const uint8_t *glyph, uint8_t padded[(HT_ARC_CELL_WIDTH + 2) * (HT_ARC_CELL_HEIGHT + 2)])
{
    // One glyph plus a transparent one-pixel border. Bilinear sampling below
    // then needs four byte loads instead of four checked packed-bit lookups.
    // This 578-byte scratch lives only while a changed curved label is built.
    memset(padded, 0, (HT_ARC_CELL_WIDTH + 2) * (HT_ARC_CELL_HEIGHT + 2));
    for (unsigned y = 0; y < HT_ARC_CELL_HEIGHT; y++) for (unsigned x = 0; x < HT_ARC_CELL_WIDTH; x++) {
        unsigned k = y * HT_ARC_CELL_WIDTH + x;
        padded[(y + 1) * (HT_ARC_CELL_WIDTH + 2) + x + 1] = (glyph[k >> 2] >> ((3 - (k & 3)) * 2)) & 3;
    }
}
static void arc_prepare(const ht_run_t *r, arc_cache_t *cache)
{
    if (cache->valid && !strcmp(cache->text, r->text)) return;
    memset(cache->mask, 0, sizeof cache->mask);
    for (int y = 0; y < HT_ARC_HEIGHT; y++) { cache->left[y] = HT_ARC_WIDTH; cache->right[y] = 0; }
    strcpy(cache->text, r->text);
    cache->valid = true; arc_builds++;
    uint32_t cp[HT_ARC_COLS];
    int count = 0;
    const char *p = r->text;
    while (*p && count < HT_ARC_COLS) cp[count++] = ht_utf8_next(&p);
    uint8_t coverage[(HT_ARC_CELL_WIDTH + 2) * (HT_ARC_CELL_HEIGHT + 2)];
    for (int i = 0; i < count; i++) {
        uint32_t c = font_codepoint(&ht_mono_24, cp[i]);
        if (c == ' ') continue;
        const ht_font_t *f = glyph_font(&ht_mono_24, c);
        const uint8_t *glyph = f->pixels + (c - f->first) * ((HT_ARC_CELL_WIDTH * HT_ARC_CELL_HEIGHT + 3) / 4);
#ifdef DEVICE_LAYOUT_BENCH
        if (arc_fast)
#endif
        glyph_coverage(glyph, coverage);
        int step = 2 * i - (count - 1), absolute = step < 0 ? -step : step;
        int sn = arc_trig[absolute][0] * (step < 0 ? -1 : 1), cs = arc_trig[absolute][1];
        int cx = (233 - HT_ARC_X) * 256 + (205 * sn * 256 >> 14);
        int cy = (233 - r->y) * 256 + (r->arc == 2 ? 1 : -1) * (205 * cs * 256 >> 14);
        if (r->arc == 2) sn = -sn; // lower arc reads left-to-right with upright letters
        int sin_abs = sn < 0 ? -sn : sn;
        int half_w = (((HT_ARC_CELL_WIDTH + 1) * cs + (HT_ARC_CELL_HEIGHT + 1) * sin_abs) >> 15) + 2;
        int half_h = (((HT_ARC_CELL_HEIGHT + 1) * cs + (HT_ARC_CELL_WIDTH + 1) * sin_abs) >> 15) + 2;
        int box_x = cx, box_y = cy;
#ifdef DEVICE_LAYOUT_BENCH
        if (arc_tight)
#endif
        {
            const uint8_t *ink = f == &ht_open_24 ? ht_open_24_ink[0] :
                f == &ht_right_24 ? ht_right_24_ink[0] :
                f == &ht_bell_24 ? ht_bell_24_ink[0] : ht_mono_24_ink[c - f->first];
            // Source pixels outside this box are transparent. Include a full
            // bilinear halo and two destination pixels for fixed-point rounding.
            int ox = (ink[0] + ink[2]) * 128 - (HT_ARC_CELL_WIDTH * 128 - 128);
            int oy = (ink[1] + ink[3]) * 128 - (HT_ARC_CELL_HEIGHT * 128 - 128);
            box_x += (ox * cs - oy * sn) >> 14;
            box_y += (ox * sn + oy * cs) >> 14;
            int w = ink[2] - ink[0] + 2, h = ink[3] - ink[1] + 2;
            half_w = ((w * cs + h * sin_abs) >> 15) + 2;
            half_h = ((h * cs + w * sin_abs) >> 15) + 2;
        }
        int x0 = imax(0, (box_x >> 8) - half_w), x1 = imin(HT_ARC_WIDTH, (box_x >> 8) + half_w + 1);
        int y0 = imax(0, (box_y >> 8) - half_h), y1 = imin(HT_ARC_HEIGHT, (box_y >> 8) + half_h + 1);
        for (int y = y0; y < y1; y++) for (int x = x0; x < x1; x++) {
            int dx = x * 256 + 128 - cx, dy = y * 256 + 128 - cy;
            int sx = ((dx * cs + dy * sn) >> 14) + HT_ARC_CELL_WIDTH * 128 - 128;
            int sy = ((-dx * sn + dy * cs) >> 14) + HT_ARC_CELL_HEIGHT * 128 - 128;
            if (sx < -256 || sx >= HT_ARC_CELL_WIDTH * 256 || sy < -256 || sy >= HT_ARC_CELL_HEIGHT * 256) continue;
            int gx = sx >> 8, gy = sy >> 8;
            unsigned fx = sx & 255, fy = sy & 255;
            // Fixed-point bilinear coverage preserves the existing font's soft
            // edges. This runs only on a title change, never per animation tick.
            unsigned a;
#ifdef DEVICE_LAYOUT_BENCH
            if (!arc_fast) {
                a = (glyph_alpha_reference(glyph,gx,gy)*(256-fx)*(256-fy) +
                    glyph_alpha_reference(glyph,gx+1,gy)*fx*(256-fy) +
                    glyph_alpha_reference(glyph,gx,gy+1)*(256-fx)*fy +
                    glyph_alpha_reference(glyph,gx+1,gy+1)*fx*fy + 32768) >> 16;
            } else
#endif
            {
                const uint8_t *alpha = coverage + (gy + 1) * (HT_ARC_CELL_WIDTH + 2) + gx + 1;
                unsigned upper = alpha[0]*(256-fx) + alpha[1]*fx;
                unsigned lower = alpha[HT_ARC_CELL_WIDTH + 2]*(256-fx) + alpha[HT_ARC_CELL_WIDTH + 3]*fx;
                a = (upper*(256-fy) + lower*fy + 32768) >> 16;
            }
            unsigned k = (unsigned)y * HT_ARC_WIDTH + (unsigned)x, shift = (3 - (k & 3)) * 2;
            unsigned old = (cache->mask[k >> 2] >> shift) & 3;
            if (a > old) {
                cache->mask[k >> 2] = (uint8_t)((cache->mask[k >> 2] & ~(3u << shift)) | (a << shift));
                if (x < cache->left[y]) cache->left[y] = x;
                if (x + 1 > cache->right[y]) cache->right[y] = x + 1;
            }
        }
    }
}
static void arc_raster(const ht_run_t *r, ht_rect_t clip, uint16_t *out)
{
    arc_cache_t *cache = &arc_caches[r->arc == 2];
    arc_prepare(r, cache);
    uint16_t palette[4] = {0, blend(r->fg,r->bg,1), blend(r->fg,r->bg,2), be16(r->fg)};
    int x0 = imax(clip.x,r->x), x1 = imin(clip.x+clip.w,r->x+r->w);
    int y0 = imax(clip.y,r->y), y1 = imin(clip.y+clip.h,r->y+HT_ARC_HEIGHT);
    for (int y = y0; y < y1; y++) {
        int left = imax(x0, r->x + cache->left[y-r->y]);
        int right = imin(x1, r->x + cache->right[y-r->y]);
        if (left >= right) continue;
        unsigned k = (unsigned)(y-r->y)*HT_ARC_WIDTH + (unsigned)(left-r->x);
        uint16_t *dst = out + (y-clip.y)*clip.w + left-clip.x;
        for (int x = left; x < right; x++, k++, dst++) {
            unsigned a = (cache->mask[k >> 2] >> ((3-(k&3))*2)) & 3;
            if (a) *dst = palette[a];
        }
    }
}
void ht_raster(const ht_scene_t *s, ht_rect_t clip, uint16_t *out)
{
    fill(out, (size_t)clip.w * clip.h, be16(s->background));
    for (int i = 0; i < s->count; i++) {
        const ht_run_t *r = &s->runs[i];
        const ht_font_t *f = r->font;
        ht_rect_t box = ht_run_bounds(r);
        if (!intersect(box, clip))
            continue;
        if (r->arc) { arc_raster(r, clip, out); continue; }
        int y1 = imax(clip.y, r->y), y2 = imin(clip.y + clip.h, r->y + f->height),
            x1 = imax(clip.x, r->x), x2 = imin(clip.x + clip.w, r->x + r->w);
        if (r->bg != s->background)
            for (int y = y1; y < y2; y++)
                fill(out + (y - clip.y) * clip.w + x1 - clip.x, (size_t)(x2 - x1), be16(r->bg));
        uint16_t palette[4] = {be16(r->bg), blend(r->fg, r->bg, 1), blend(r->fg, r->bg, 2),
                               be16(r->fg)};
        bool cached = glyph_cache_prepare(f, r->fg, r->bg);
        bool ascii = f->first == 32 && f->last >= 126;
#ifdef DEVICE_LAYOUT_BENCH
        ascii = ascii && raster_fast_ascii;
#endif
        const char *p = r->text;
        int gx = r->x;
        while (*p && gx < x2) {
            uint32_t c = (uint8_t)*p;
            if (ascii && c < 128) {
                p++;
                if (c < 32 || c > f->last) c = '?';
            } else {
                c = ht_utf8_next(&p);
                c = font_codepoint(f, c);
            }
            if (gx + f->width > x1 && c != ' ') {
                const ht_font_t *face = glyph_font(f, c);
                size_t stride = ((size_t)face->width * face->height + 3) / 4;
                const uint8_t *glyph = face->pixels + (c - face->first) * stride;
                int xa = imax(x1, gx), xb = imin(x2, gx + f->width);
                const uint16_t *colored = cached ? glyph_cached(c, glyph, palette) : NULL;
                for (int y = y1; y < y2; y++) {
                    uint16_t *dst = out + (y - clip.y) * clip.w + xa - clip.x;
                    size_t k = (size_t)(y - r->y) * f->width + xa - gx;
                    if (colored) {
                        // At most five pixels. A general memcpy call costs more
                        // than these aligned 16-bit loads/stores on the ESP32.
                        const uint16_t *src = colored + k;
                        switch (xb - xa) {
                        case 5: dst[4] = src[4]; /* fall through */
                        case 4: dst[3] = src[3]; /* fall through */
                        case 3: dst[2] = src[2]; /* fall through */
                        case 2: dst[1] = src[1]; /* fall through */
                        case 1: dst[0] = src[0];
                        }
                        continue;
                    }
                    for (int x = xa; x < xb; x++, k++)
                        *dst++ = palette[(glyph[k >> 2] >> ((3 - (k & 3)) * 2)) & 3];
                }
            }
            gx += f->width;
        }
    }
}
