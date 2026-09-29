#include "terminal.h"
#include <stdio.h>
#include <string.h>
#include "arc_geometry.inc"
#include "display_fallbacks.inc"

static int imin(int a, int b) { return a < b ? a : b; }
static int imax(int a, int b) { return a > b ? a : b; }
/*
 * THE PANEL'S OWN BYTE ORDER, and the two panels disagree about it.
 *
 * The dial's CO5300 is fed over QSPI and wants RGB565 byte-swapped, so the raster emits it that way and
 * saves a per-pixel swap on every flush. The Pro's ST7703 is a DPI panel scanned continuously out of a
 * framebuffer in the SoC's own little-endian order, and it swaps nothing.
 *
 * Getting this wrong is not subtle and it is not a crash: #181818 read the other way round is
 * rgb(192,96,192), so the whole face comes up bright purple with a yellow-green octopus on it. That is
 * exactly what the first Pro build did. The function was called panel16() then, which is why this one is
 * not — a name that promises a swap it no longer always performs is worse than no name at all.
 */
#if HT_FACE_PX >= 720
static uint16_t panel16(uint16_t v) { return v; }
#else
static uint16_t panel16(uint16_t v) { return (uint16_t)((v << 8) | (v >> 8)); }
#endif
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
    if (font == &ht_mono_28) {
        if (cp == 0x2713) return &ht_done_28;
        if (cp == 0x2717) return &ht_failed_28;
    }
    // Inline arrows use exactly the parent font's cell metrics. The raster
    // indexes each cell by that width/height; a smaller atlas would overread.
    // Three extra immutable glyphs, no scaling, allocation or extra text runs.
    if (font == &ht_mono_20 || font == &ht_mono_28) {
        if (cp == 0x2197) return font == &ht_mono_28 ? &ht_open_28 : &ht_open_20;
        if (cp == 0x2192) return font == &ht_mono_28 ? &ht_right_28 : &ht_right_20;
        if (cp == 0xe000) return font == &ht_mono_28 ? &ht_bell_28 : &ht_bell_20;
    }
    return font;
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
                *p = (const char *)(s + i);
                return 0xfffd;
            }
            v = (v << 6) | (s[i] & 63);
        }
        s += n;
        c = v;
        if (c < (n == 1 ? 0x80u : n == 2 ? 0x800u : 0x10000u) ||
            c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)) c = 0xfffd;
    } else if (c >= 128)
        c = 0xfffd;
    *p = (const char *)s;
    return c;
}

static bool native_glyph(const ht_font_t *font, uint32_t cp)
{
    if (cp < 32 || (cp >= 127 && cp < 160)) return false;
    const ht_font_t *face = glyph_font(font, cp);
    cp = punctuation_alias(cp);
    return cp >= face->first && cp <= face->last;
}
static const char *display_fallback(uint32_t cp, char scratch[12])
{
    // Styling/joining controls carry no ink. Unknown text itself is never lost.
    if ((cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)) return "";
    size_t lo = 0, hi = sizeof display_ranges / sizeof display_ranges[0];
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        if (cp < display_ranges[mid].first) hi = mid;
        else if (cp > display_ranges[mid].last) lo = mid + 1;
        else {
            scratch[0] = (char)((int32_t)cp + display_ranges[mid].delta);
            scratch[1] = 0;
            return scratch;
        }
    }
    lo = 0; hi = sizeof display_entries / sizeof display_entries[0];
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        uint32_t key = display_entries[mid] >> DISPLAY_OFFSET_BITS;
        if (cp < key) hi = mid;
        else if (cp > key) lo = mid + 1;
        else return display_pool + (display_entries[mid] & DISPLAY_OFFSET_MASK);
    }
    // An explicit, lossless identifier is preferable to inventing a meaning or
    // showing '?' (which could be part of the author's actual message).
    snprintf(scratch, 12, "[U+%04lX]", (unsigned long)cp);
    return scratch;
}
typedef struct {
    const char *text;
    size_t bytes;
    unsigned cells;
    bool fraction, digit, space;
    char scratch[12];
} display_token_t;
static void display_token(const char **cursor, const ht_font_t *font, display_token_t *t)
{
    const char *start = *cursor;
    uint32_t cp = (unsigned char)*start;
    if (cp < 128) (*cursor)++; // Keep ordinary terminal text on the cheap path.
    else cp = ht_utf8_next(cursor);
    *t = (display_token_t){.text=start,.bytes=(size_t)(*cursor-start),.cells=1};
    if (font->first > 32 || font->last < 126 || (cp >= 32 && cp < 127)) {
        // Compact artwork/icon atlases retain their one-cell contract. They
        // cannot render fallback words. ASCII prose needs no Unicode lookup.
        t->digit = cp >= '0' && cp <= '9'; t->space = cp == ' ';
        return;
    }
    t->fraction = (cp >= 0xbc && cp <= 0xbe) || (cp >= 0x2150 && cp < 0x215f) || cp == 0x2189;
    if (cp >= 9 && cp <= 13) { t->text=" "; t->bytes=1; }
    else if (cp == 0xa0 || cp == 0xad || t->fraction || !native_glyph(font,cp)) {
        t->text = display_fallback(cp,t->scratch);
        t->bytes = t->cells = (unsigned)strlen(t->text); // fallback pool is ASCII only
    }
    t->digit = t->bytes && t->text[t->bytes-1] >= '0' && t->text[t->bytes-1] <= '9';
    t->space = t->bytes == 1 && t->text[0] == ' ';
}
static bool token_gap(const display_token_t *t, bool digit, bool fraction)
{
    // Mixed/adjacent fractions must read '1 1/3', never '11/3' or '1/32/3'.
    return t->bytes && ((t->fraction && digit) ||
        (fraction && t->text[0] >= '0' && t->text[0] <= '9'));
}
static bool display_copy(char *dst, size_t cap, const char *src, const char *end,
                         const ht_font_t *font, int columns)
{
    if (!cap || !font) return false;
    const char *p = src ? src : "";
    size_t used = 0;
    bool digit = false, fraction = false, complete = true;
    while (*p && (!end || p < end)) {
        bool newline = *p == '\n';
        display_token_t t; display_token(&p,font,&t);
        bool gap = token_gap(&t,digit,fraction);
        if (t.cells + gap > (unsigned)columns || t.bytes + gap >= cap - used) {
            complete = false; break;
        }
        if (gap) dst[used++] = ' ';
        if (newline) dst[used++] = '\n';
        else { memcpy(dst+used,t.text,t.bytes); used += t.bytes; }
        columns -= t.cells + gap;
        if (t.bytes) { digit=t.digit; fraction=t.fraction; }
    }
    dst[used] = 0;
    return complete;
}
bool ht_display_text(char *dst, size_t cap, const char *src, const ht_font_t *font)
{
    // Byte capacity also bounds cell count, avoiding unbounded size_t -> int.
    return display_copy(dst,cap,src,NULL,font,(int)(cap < 32768 ? cap : 32768));
}
const char *ht_take_display_line(const char **cursor, int cols, const ht_font_t *font)
{
    const char *p = *cursor, *start = p, *space = NULL, *after_space = NULL, *end = p;
    unsigned used = 0;
    bool digit = false, fraction = false;
    while (*p && *p != '\n') {
        const char *before = p;
        display_token_t t; display_token(&p,font,&t);
        unsigned cells = t.cells + token_gap(&t,digit,fraction);
        if (used + cells > (unsigned)(cols > 0 ? cols : 0)) {
            // A single replacement larger than the entire viewport still has
            // to make progress. ht_text will safely omit that indivisible token.
            if (before == start) end = p;
            else p = before;
            break;
        }
        if (t.space) { space=before; after_space=p; }
        used += cells; end = p;
        if (t.bytes) { digit=t.digit; fraction=t.fraction; }
    }
    if (*p && *p != '\n' && space && space > start) { end=space; p=after_space; }
    else if (*p == '\n') p++;
    *cursor = p;
    return end;
}
uint8_t ht_shimmer_phase(uint32_t now)
{
    unsigned step = (now / 64) % 32;
    return (uint8_t)(1 + (step < 20 ? step : 20));
}
uint32_t ht_shimmer_wake_ms(uint32_t now)
{
    unsigned step = (now / 64) % 32;
    return (step < 20 ? 64 : (32 - step) * 64) - now % 64;
}
void ht_scene_clear(ht_scene_t *s, uint16_t bg)
{
    s->count = 0;
    s->background = bg;
}
bool ht_text(ht_scene_t *s, int x, int y, int w, const ht_font_t *font, uint16_t fg, uint16_t bg,
             const char *text)
{
    if (s->count >= HT_RUNS || !font || !font->width || w <= 0)
        return false;
    ht_run_t *r = &s->runs[s->count++];
    memset(r, 0, sizeof(*r));
    r->x = x;
    r->y = y;
    r->w = w;
    r->font = font;
    r->fg = fg;
    r->bg = bg;
    display_copy(r->text,sizeof r->text,text,NULL,font,w / font->width);
    // A run is one line. Multi-line callers split before constructing runs.
    for (char *p=r->text; *p; p++) if (*p=='\n') *p=' ';
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
    char visible[HT_TEXT_BYTES];
    ht_display_text(visible,sizeof visible,text,font);
    const char *p = visible;
    int n = 0;
    while (*p) {
        ht_utf8_next(&p);
        n++;
    }
    int w = imin(n * font->width, HT_WIDTH - 80);
    ht_text(s, (HT_WIDTH - w) / 2, y, w, font, fg, s->background, visible);
}
static void arc_text(ht_scene_t *s, uint16_t fg, const char *text, bool bottom)
{
    if (!text || !*text) return;
    char visible[HT_TEXT_BYTES];
    bool complete = ht_display_text(visible,sizeof visible,text,&ht_mono_20);
    if (!ht_text(s, HT_ARC_X, HT_ARC_Y, HT_ARC_COLS * ht_mono_20.width,
                 &ht_mono_20, fg, s->background, visible)) return;
    ht_run_t *r = &s->runs[s->count - 1];
    // A long name ends at a word boundary; the pane list retains its full name.
    if (!complete || strlen(visible) > strlen(r->text)) {
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
    while (*p) { ht_take_display_line(&p, width / font->width, font); rows++; }
    return rows;
}
bool ht_can_display(const char *text, const ht_font_t *font, int width, int lines)
{
    if (!font || !font->width || width < font->width || lines < 1)
        return false;
    const char *p = text ? text : "";
    while (*p) {
        const char *start = p;
        uint32_t cp = ht_utf8_next(&p);
        const ht_font_t *glyph = glyph_font(font, cp);
        if (cp < glyph->first || cp > glyph->last) cp = punctuation_alias(cp);
        if (cp != '\n' && cp != ' ' && (cp < glyph->first || cp > glyph->last || (cp >= 127 && cp < 160)))
            return false;
        // Even native fractions expand to several cells. Never approve text
        // whose indivisible display equivalent cannot fit in the viewport.
        display_token_t token;
        display_token(&start,font,&token);
        if (token.cells > (unsigned)(width / font->width)) return false;
    }
    p = text ? text : "";
    int rows = 0;
    while (*p) {
        if (++rows > lines)
            return false;
        ht_take_display_line(&p, width / font->width, font);
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
        const char *end = ht_take_display_line(&p, cols, f);
        if (row++ < skip)
            continue;
        char line[HT_TEXT_BYTES];
        display_copy(line,sizeof line,start,end,f,cols);
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
        // Tight, conservative ink bounds. The arc canvas remains 416x128, but
        // a short name must not dirty that whole rectangle on every pane switch.
        int half_w = ((13 * cs + 29 * sn) >> 15) + 2;
        int half_h = ((29 * cs + 13 * sn) >> 15) + 2;
        int left = 233 - (205 * sn >> 14) - half_w - 1;
        int bottom = 233 - (205 * cs >> 14) + half_h + 1;
        return (ht_rect_t){left, r->arc == 2 ? HT_HEIGHT - bottom : HT_ARC_Y,
            2 * (233 - left), bottom - HT_ARC_Y};
    }
    return (ht_rect_t){r->x, r->y, r->w, r->font->height};
}
static int shimmer_center(const ht_run_t *r, ht_rect_t box)
{
    unsigned phase = r->shimmer > 21 ? 21 : r->shimmer;
    return box.x - 48 + (box.w + 96) * (int)(phase - 1) / 20;
}
static ht_rect_t shimmer_band(const ht_run_t *r)
{
    ht_rect_t box = ht_run_bounds(r);
    int cx = shimmer_center(r, box);
    int left = imax(box.x, cx - 48), right = imin(box.x + box.w, cx + 48);
    return (ht_rect_t){left, box.y, imax(0, right - left), box.h};
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
// Layout changes often form a stepped outline: a wide recap underneath a
// narrower portrait. Keep that outline instead of inflating it to one large
// rectangle. One pair of half-pixel x coordinates per two display rows, on the stack.
//
// THE WIDTH OF THESE FOLLOWS THE FACE, and it has to. They hold x/2, so the dial's 466 tops out at 233
// and fits a byte exactly — which is why this was a byte array and why the comment used to say so. At
// 720 the same values reach 360: the right edge of any damage band past x=510 wrapped to a small
// number, damage_rows_finish() emitted a band far narrower than the change, and the right of the
// screen simply never repainted. On the glass that is an octopus drawn on top of the last octopus and
// a menu with the old screen still behind it — not a crash, and nothing in the logs.
//
// The dial keeps its byte array: 360 entries of uint16_t is 1,440 bytes of render-task stack, and the
// 466 face has no need of them.
#if HT_WIDTH / 2 > 255
typedef uint16_t damage_coord_t;
#else
typedef uint8_t damage_coord_t;
#endif
typedef struct {
    damage_coord_t left[HT_HEIGHT / 2], right[HT_HEIGHT / 2];
} damage_rows_t;
static void damage_add(ht_damage_t *d, ht_rect_t r, damage_rows_t *rows)
{
    int x = imax(0, r.x) & ~1, y = imax(0, r.y) & ~1, x2 = imin(HT_WIDTH, (r.x + r.w + 1) & ~1),
        y2 = imin(HT_HEIGHT, (r.y + r.h + 1) & ~1);
    r = (ht_rect_t){x, y, x2 - x, y2 - y};
    if (r.w <= 0 || r.h <= 0)
        return;
    if (rows) for (int y = r.y / 2; y < (r.y + r.h) / 2; y++) {
        damage_coord_t left = (damage_coord_t)(r.x / 2), right = (damage_coord_t)((r.x + r.w) / 2);
        if (left < rows->left[y]) rows->left[y] = left;
        if (right > rows->right[y]) rows->right[y] = right;
    }
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
static void damage_rows_finish(const damage_rows_t *rows, ht_damage_t *d)
{
    ht_damage_t candidate = {0};
    for (int y = 0; y < HT_HEIGHT / 2;) {
        int left = rows->left[y], right = rows->right[y], top = y++;
        if (left >= right) continue;
        while (y < HT_HEIGHT / 2 && rows->left[y] == left && rows->right[y] == right) y++;
        if (candidate.count == HT_DAMAGE_MAX) {
            // Bounded storage. Merge the adjacent pair costing the fewest extra
            // pixels before adding another band; never allocate or fall back to
            // a full frame simply because a curved outline has many steps.
            int best = 0; unsigned least = UINT32_MAX;
            for (int i = 0; i + 1 < candidate.count; i++) {
                ht_rect_t a = candidate.rect[i], b = candidate.rect[i + 1], u = united(a, b);
                unsigned extra = u.w * u.h - a.w * a.h - b.w * b.h;
                if (extra < least) { least = extra; best = i; }
            }
            candidate.rect[best] = united(candidate.rect[best], candidate.rect[best + 1]);
            memmove(&candidate.rect[best + 1], &candidate.rect[best + 2],
                (size_t)(candidate.count - best - 2) * sizeof candidate.rect[0]);
            candidate.count--;
        }
        candidate.rect[candidate.count++] = (ht_rect_t){left * 2, top * 2,
                                                        (right - left) * 2, (y - top) * 2};
    }
    for (int i = 0; i < candidate.count; i++)
        candidate.pixels += (uint32_t)candidate.rect[i].w * candidate.rect[i].h;
    // Include a small command/transaction cost. A marginal pixel reduction
    // must not turn one efficient transfer into many tiny transfers.
    if (candidate.pixels + candidate.count * 256u + 64 < d->pixels + d->count * 256u)
        *d = candidate;
}
#ifdef DEVICE_LAYOUT_BENCH
static bool damage_fast_ascii = true, raster_fast_ascii = true, damage_bands = true;
void ht_damage_banded(bool enabled) { damage_bands = enabled; }
void ht_raster_fast_ascii(bool enabled) { raster_fast_ascii = enabled; }
void ht_damage_fast_ascii(bool enabled) { damage_fast_ascii = enabled; }
#endif
void ht_damage(const ht_scene_t *a, const ht_scene_t *b, ht_damage_t *d)
{
    memset(d, 0, sizeof(*d));
    damage_rows_t row_storage, *rows = NULL;
    bool reshape = false;
    if (a && a->background == b->background
#ifdef DEVICE_LAYOUT_BENCH
        && damage_bands
#endif
    ) {
        reshape = a->count != b->count;
        for (int i = 0; !reshape && i < a->count; i++) {
            const ht_run_t *old = &a->runs[i], *next = &b->runs[i];
            reshape = old->font != next->font || old->x != next->x || old->y != next->y ||
                      old->w != next->w || old->arc != next->arc;
        }
    }
    if (reshape) {
        rows = &row_storage;
        // Not memset for `left`: it writes one BYTE, so a 16-bit sentinel of 360 would be seeded as
        // 0x6868. The sentinel is "no damage on this row", recognised by left >= right below.
        for (int y = 0; y < HT_HEIGHT / 2; y++) rows->left[y] = (damage_coord_t)(HT_WIDTH / 2);
        memset(rows->right, 0, sizeof rows->right);
    }
    if (!a || a->background != b->background) {
        damage_add(d, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, NULL);
    } else
        for (int i = 0; i < imax(a->count, b->count); i++) {
            if (i < a->count && i < b->count &&
                memcmp(&a->runs[i], &b->runs[i], sizeof(ht_run_t)) == 0)
                continue;
            if (i < a->count && i < b->count) {
                const ht_run_t *old = &a->runs[i], *next = &b->runs[i];
                if (old->arc && old->arc == next->arc && old->shimmer && next->shimmer &&
                    old->x == next->x && old->y == next->y && old->w == next->w &&
                    old->font == next->font && old->fg == next->fg && old->bg == next->bg &&
                    old->colors == next->colors && !strcmp(old->text, next->text)) {
                    // Only the old/new highlight bands change. The rotated glyph
                    // mask and the dim text outside those bands stay untouched.
                    damage_add(d, shimmer_band(old), rows);
                    damage_add(d, shimmer_band(next), rows);
                    continue;
                }
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
                        if (pc != qc || (pc != ' ' &&
                            ht_run_ink(old, cell) !=
                            ht_run_ink(next, cell))) {
                            if (first < 0)
                                first = cell;
                            last = cell;
                        }
                        cell++;
                    }
                    if (first >= 0)
                        damage_add(d, (ht_rect_t){next->x + first * next->font->width, next->y,
                                                  (last - first + 1) * next->font->width,
                                                  next->font->height}, rows);
                    continue;
                }
            }
            if (i < a->count)
                damage_add(d, ht_run_bounds(&a->runs[i]), rows);
            if (i < b->count)
                damage_add(d, ht_run_bounds(&b->runs[i]), rows);
        }
    for (int i = 0; i < d->count; i++)
        d->pixels += (uint32_t)d->rect[i].w * d->rect[i].h;
    if (rows) damage_rows_finish(rows, d);
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
    return panel16((r << 11) | (g << 5) | b);
}

// The small ASCII artwork uses only a handful of characters. Expand each used
// glyph once for its font/palette, then copy clipped rows directly into DMA
// strips. Fixed capacity, renderer-owned: no allocation and no per-frame churn.
// Ordinary text and Unicode fonts retain the general renderer below.
/*
 * THE CACHE HAS TO BE BIG ENOUGH FOR THE BIGGEST CELL IT IS MEANT TO SERVE.
 *
 * 50 pixels is font_10 exactly — 5 x 10 — which was the largest octopus atlas while there was only a
 * round dial. The Pro draws its companion in font_16 (8 x 16 = 128 px) and its carrying state in
 * font_14 (98), so BOTH were rejected by the size guard below and the cache sat idle over the one
 * surface on that board that redraws sixty-three times a loop.
 *
 * The creature's alphabet is ten symbols and there are twenty-four slots, so every cell of it is a
 * hit once the size fits. The dial keeps 50: it has no atlas that needs more, and 24 x 128 x 2 is
 * 6 KB of internal RAM against its 2.4.
 */
// #define, not enum: the unrolled copy in the rasteriser selects its cases with #if, and the
// preprocessor cannot see an enum constant — it reads the name as 0. That is precisely how the first
// version of the widened cache shipped columns 5..7 unwritten while looking correct in the source.
#if HT_FACE_PX >= 720
#define GLYPH_PIXELS 128
#define GLYPH_MAX_W  8
#define GLYPH_MAX_H  16
#else
#define GLYPH_PIXELS 50
#define GLYPH_MAX_W  5
#define GLYPH_MAX_H  10
#endif
enum { GLYPH_SLOTS = 24, ASCII_COUNT = 95 };
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
        !f->width || f->width > GLYPH_MAX_W || !f->height || f->height > GLYPH_MAX_H) return false;
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

// Each row of an arc has two narrow bands, separated by transparent space.
// Pack those bands independently instead of retaining a mostly empty rectangle.
// All 64 count/edge geometries fit in 3968 bytes; 4096 leaves a little headroom.
// Upper/lower text have independent keys, so they never evict each other.
// Scenes retain immutable text, allowing old scenes to rasterize correctly.
enum { ARC_HALF = HT_ARC_WIDTH / 2, ARC_MASK_BYTES = 4096 };
typedef struct {
    uint16_t offset;
    uint8_t first, last;
    uint8_t ink_first, ink_last;
} arc_span_t;
typedef struct {
    uint8_t mask[ARC_MASK_BYTES];
    arc_span_t spans[HT_ARC_HEIGHT][2];
    char text[HT_TEXT_BYTES];
    uint16_t mask_bytes;
    uint8_t columns;
    bool valid;
} arc_cache_t;
_Static_assert(ARC_HALF <= UINT8_MAX, "arc span coordinates must fit in a byte");
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
    if (x < 0 || x >= 12 || y < 0 || y >= 28) return 0;
    unsigned k = (unsigned)y * 12 + (unsigned)x;
    return (glyph[k >> 2] >> ((3 - (k & 3)) * 2)) & 3;
}
#endif

static void glyph_coverage(const uint8_t *glyph, uint8_t padded[14 * 30])
{
    // One glyph plus a transparent one-pixel border. Bilinear sampling below
    // then needs four byte loads instead of four checked packed-bit lookups.
    // This 420-byte scratch lives only while a changed curved label is built.
    memset(padded, 0, 14 * 30);
    for (unsigned y = 0; y < 28; y++) for (unsigned x = 0; x < 12; x++) {
        unsigned k = y * 12 + x;
        padded[(y + 1) * 14 + x + 1] = (glyph[k >> 2] >> ((3 - (k & 3)) * 2)) & 3;
    }
}
static bool arc_pack_geometry(const ht_run_t *r, arc_cache_t *cache, int count)
{
    if (cache->columns == count && cache->mask_bytes) return true;
    for (int y = 0; y < HT_ARC_HEIGHT; y++) for (int h = 0; h < 2; h++)
        cache->spans[y][h] = (arc_span_t){.first=ARC_HALF};
    // These are the original full-cell bounds, before glyph ink trimming.
    // Their union includes every possible glyph/antialiasing value at this
    // length, so geometry can be reused when only the label's letters change.
    for (int i = 0; i < count; i++) {
        int step = 2 * i - (count - 1), absolute = step < 0 ? -step : step;
        int sn = arc_trig[absolute][0] * (step < 0 ? -1 : 1), cs = arc_trig[absolute][1];
        int cx = (233 - HT_ARC_X) * 256 + (205 * sn * 256 >> 14);
        int cy = (233 - r->y) * 256 + (r->arc == 2 ? 1 : -1) * (205 * cs * 256 >> 14);
        int sin_abs = sn < 0 ? -sn : sn;
        int half_w = ((13 * cs + 29 * sin_abs) >> 15) + 2;
        int half_h = ((29 * cs + 13 * sin_abs) >> 15) + 2;
        int x0 = imax(0, (cx >> 8) - half_w), x1 = imin(HT_ARC_WIDTH, (cx >> 8) + half_w + 1);
        int y0 = imax(0, (cy >> 8) - half_h), y1 = imin(HT_ARC_HEIGHT, (cy >> 8) + half_h + 1);
        for (int y = y0; y < y1; y++) for (int h = 0; h < 2; h++) {
            int left = imax(0, x0 - h * ARC_HALF), right = imin(ARC_HALF, x1 - h * ARC_HALF);
            if (left >= right) continue;
            arc_span_t *span = &cache->spans[y][h];
            if (left < span->first) span->first = left;
            if (right > span->last) span->last = right;
        }
    }
    unsigned used = 0;
    for (int y = 0; y < HT_ARC_HEIGHT; y++) for (int h = 0; h < 2; h++) {
        arc_span_t *span = &cache->spans[y][h];
        span->offset = used;
        if (span->first < span->last) used += (span->last - span->first + 3) / 4;
    }
    cache->columns = count;
    cache->mask_bytes = used <= sizeof cache->mask ? used : 0;
    return cache->mask_bytes != 0;
}
static void arc_prepare(const ht_run_t *r, arc_cache_t *cache)
{
    if (cache->valid && !strcmp(cache->text, r->text)) return;
    strcpy(cache->text, r->text);
    cache->valid = true; arc_builds++;
    uint32_t cp[HT_ARC_COLS];
    int count = 0;
    const char *p = r->text;
    while (*p && count < HT_ARC_COLS) cp[count++] = ht_utf8_next(&p);
    if (!arc_pack_geometry(r, cache, count)) return;
    memset(cache->mask, 0, cache->mask_bytes);
    for (int y = 0; y < HT_ARC_HEIGHT; y++) for (int h = 0; h < 2; h++) {
        cache->spans[y][h].ink_first = ARC_HALF;
        cache->spans[y][h].ink_last = 0;
    }
    uint8_t coverage[14 * 30];
    for (int i = 0; i < count; i++) {
        uint32_t c = font_codepoint(&ht_mono_20, cp[i]);
        if (c == ' ') continue;
        const ht_font_t *f = glyph_font(&ht_mono_20, c);
        const uint8_t *glyph = f->pixels + (c - f->first) * 84;
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
        int half_w, half_h;
        int box_x = cx, box_y = cy;
#ifdef DEVICE_LAYOUT_BENCH
        if (!arc_tight) {
            half_w = ((13 * cs + 29 * sin_abs) >> 15) + 2;
            half_h = ((29 * cs + 13 * sin_abs) >> 15) + 2;
        } else
#endif
        {
            const uint8_t *ink = f == &ht_open_20 ? ht_open_20_ink[0] :
                f == &ht_right_20 ? ht_right_20_ink[0] :
                f == &ht_bell_20 ? ht_bell_20_ink[0] : ht_mono_20_ink[c - f->first];
            // Source pixels outside this box are transparent. Include a full
            // bilinear halo and two destination pixels for fixed-point rounding.
            int ox = (ink[0] + ink[2]) * 128 - (6 * 256 - 128);
            int oy = (ink[1] + ink[3]) * 128 - (14 * 256 - 128);
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
            int sx = ((dx * cs + dy * sn) >> 14) + 6 * 256 - 128;
            int sy = ((-dx * sn + dy * cs) >> 14) + 14 * 256 - 128;
            if (sx < -256 || sx >= 12 * 256 || sy < -256 || sy >= 28 * 256) continue;
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
                const uint8_t *alpha = coverage + (gy + 1) * 14 + gx + 1;
                unsigned upper = alpha[0]*(256-fx) + alpha[1]*fx;
                unsigned lower = alpha[14]*(256-fx) + alpha[15]*fx;
                a = (upper*(256-fy) + lower*fy + 32768) >> 16;
            }
            if (!a) continue;
            arc_span_t *span = &cache->spans[y][x >= ARC_HALF];
            int local = x - (x >= ARC_HALF ? ARC_HALF : 0);
            if (local < span->first || local >= span->last) continue;
            unsigned k = (unsigned)(local - span->first), shift = (3 - (k & 3)) * 2;
            uint8_t *packed = &cache->mask[span->offset + (k >> 2)];
            unsigned old = (*packed >> shift) & 3;
            if (a > old) {
                *packed = (uint8_t)((*packed & ~(3u << shift)) | (a << shift));
                if (local < span->ink_first) span->ink_first = local;
                if (local + 1 > span->ink_last) span->ink_last = local + 1;
            }
        }
    }
}
static void arc_raster(const ht_run_t *r, ht_rect_t clip, uint16_t *out)
{
    arc_cache_t *cache = &arc_caches[r->arc == 2];
    arc_prepare(r, cache);
    if (!cache->mask_bytes) return;
    uint16_t palette[4] = {0, blend(r->fg,r->bg,1), blend(r->fg,r->bg,2), panel16(r->fg)};
    // Colour a cached mask: no glyph rotation, allocations or extra text runs.
    // Sixteen brightness levels use 128 bytes of bounded stack scratch.
    uint16_t sweep[16][4];
    int center = 0;
    if (r->shimmer) {
        center = shimmer_center(r, ht_run_bounds(r));
        for (unsigned level = 0; level < 16; level++) {
            unsigned opacity = 100 + level * 155 / 15, inverse = 255 - opacity;
            unsigned red = ((r->fg >> 11) * opacity + (r->bg >> 11) * inverse + 127) / 255;
            unsigned green = (((r->fg >> 5) & 63) * opacity + ((r->bg >> 5) & 63) * inverse + 127) / 255;
            unsigned blue = ((r->fg & 31) * opacity + (r->bg & 31) * inverse + 127) / 255;
            uint16_t ink = (uint16_t)((red << 11) | (green << 5) | blue);
            sweep[level][0] = 0;
            sweep[level][1] = blend(ink, r->bg, 1);
            sweep[level][2] = blend(ink, r->bg, 2);
            sweep[level][3] = panel16(ink);
        }
    }
    int x0 = imax(clip.x,r->x), x1 = imin(clip.x+clip.w,r->x+r->w);
    int y0 = imax(clip.y,r->y), y1 = imin(clip.y+clip.h,r->y+HT_ARC_HEIGHT);
    for (int y = y0; y < y1; y++) for (int h = 0; h < 2; h++) {
        const arc_span_t *span = &cache->spans[y-r->y][h];
        int base = r->x + h * ARC_HALF;
        int left = imax(x0, base + span->ink_first);
        int right = imin(x1, base + span->ink_last);
        if (left >= right) continue;
        unsigned k = (unsigned)(left - base - span->first);
        const uint8_t *mask = cache->mask + span->offset;
        uint16_t *dst = out + (y-clip.y)*clip.w + left-clip.x;
        for (int x = left; x < right; x++, k++, dst++) {
            unsigned a = (mask[k >> 2] >> ((3-(k&3))*2)) & 3;
            if (a) {
                if (r->shimmer) {
                    int distance = x - center;
                    if (distance < 0) distance = -distance;
                    unsigned level = distance >= 48 ? 0 : 15 - (unsigned)distance * 15 / 48;
                    *dst = sweep[level][a];
                } else *dst = palette[a];
            }
        }
    }
}
void ht_raster(const ht_scene_t *s, ht_rect_t clip, uint16_t *out)
{
    fill(out, (size_t)clip.w * clip.h, panel16(s->background));
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
                fill(out + (y - clip.y) * clip.w + x1 - clip.x, (size_t)(x2 - x1), panel16(r->bg));
        uint16_t palette[4] = {panel16(r->bg), blend(r->fg, r->bg, 1), blend(r->fg, r->bg, 2),
                               panel16(r->fg)};
        bool cached = !r->colors && !r->cell_color_count && glyph_cache_prepare(f, r->fg, r->bg);
        bool ascii = f->first == 32 && f->last >= 126;
#ifdef DEVICE_LAYOUT_BENCH
        ascii = ascii && raster_fast_ascii;
#endif
        const char *p = r->text;
        int gx = r->x, cell = 0;
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
                if (r->colors || r->cell_color_count) {
                    uint16_t fg = ht_run_ink(r, cell);
                    palette[1] = blend(fg, r->bg, 1);
                    palette[2] = blend(fg, r->bg, 2);
                    palette[3] = panel16(fg);
                }
                const ht_font_t *face = glyph_font(f, c);
                size_t stride = ((size_t)face->width * face->height + 3) / 4;
                const uint8_t *glyph = face->pixels + (c - face->first) * stride;
                int xa = imax(x1, gx), xb = imin(x2, gx + f->width);
                const uint16_t *colored = cached ? glyph_cached(c, glyph, palette) : NULL;
                for (int y = y1; y < y2; y++) {
                    uint16_t *dst = out + (y - clip.y) * clip.w + xa - clip.x;
                    size_t k = (size_t)(y - r->y) * f->width + xa - gx;
                    if (colored) {
                        // One store per pixel of the widest cached cell, unrolled: a general memcpy
                        // costs more than these aligned 16-bit loads/stores on the ESP32.
                        //
                        // The count has to match GLYPH_MAX_W. It was five — font_10, the dial's widest
                        // atlas — and the Pro's font_16 is eight, so columns 5..7 of every cached cell
                        // were simply never written. test_glyph_cache caught it the moment the size
                        // guard let those atlases in.
                        const uint16_t *src = colored + k;
                        switch (xb - xa) {
#if GLYPH_MAX_W >= 8
                        case 8: dst[7] = src[7]; /* fall through */
                        case 7: dst[6] = src[6]; /* fall through */
                        case 6: dst[5] = src[5]; /* fall through */
#endif
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
            cell++;
        }
    }
}
