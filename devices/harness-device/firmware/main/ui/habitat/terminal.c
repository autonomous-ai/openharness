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
static uint16_t panel16(uint16_t v) { return (uint16_t)((v << 8) | (v >> 8)); }
// The eight Vietnamese letters outside 0x1EA0-0x1EF9, mapped onto the tail the generator appends
// to that block. Returns 0 for anything that is not Vietnamese. Order matches VIET_TAIL in
// scripts/gen_habitat_fonts.py; the two must be changed together.
static uint32_t viet_codepoint(uint32_t cp)
{
    // 0x1EFA..0x1F01 is the tail itself: the raster path aliases, then asks again with the result,
    // so this has to answer the same thing twice.
    if (cp >= 0x1ea0 && cp <= 0x1f01) return cp;
    switch (cp) {
    case 0x102: return 0x1efa; case 0x103: return 0x1efb;
    case 0x110: return 0x1efc; case 0x111: return 0x1efd;
    case 0x1a0: return 0x1efe; case 0x1a1: return 0x1eff;
    case 0x1af: return 0x1f00; case 0x1b0: return 0x1f01;
    default: return 0;
    }
}
static uint32_t cell_alias(uint32_t cp)
{
    // One cell in, one cell out. Keep the original UTF-8 in the scene/wire;
    // reuse existing ASCII pixels for typographic punctuation outside Latin-1.
    switch (cp) {
    case 0x2010: case 0x2011: case 0x2012: case 0x2013: case 0x2014: case 0x2015:
    case 0x2212: return '-';
    case 0x2018: case 0x2019: case 0x201a: case 0x201b: return '\'';
    case 0x201c: case 0x201d: case 0x201e: case 0x201f: return '"';
    default: break;
    }
    uint32_t viet = viet_codepoint(cp);
    return viet ? viet : cp;
}
const ht_arc_face_t ht_arc_geist = {
    &ht_mono_24, &ht_viet_24, &ht_open_24, &ht_right_24, &ht_bell_24,
    ht_mono_24_ink, ht_open_24_ink, ht_right_24_ink, ht_bell_24_ink, NULL, 0, false};
// The arc face whose mono atlas is `font`, or NULL. A curved run carries its face as that atlas
// (run.font), so every font comparison in the damage code already tells two faces apart.
static const ht_arc_face_t *arc_face_of(const ht_font_t *font)
{
    static const ht_arc_face_t *const faces[] = {&ht_arc_geist};
    for (unsigned i = 0; i < sizeof faces / sizeof faces[0]; i++) if (faces[i]->mono == font) return faces[i];
    return NULL;
}
static const ht_font_t *glyph_font(const ht_font_t *font, uint32_t cp)
{
    const ht_arc_face_t *face = arc_face_of(font);
    if (face) {
        if (cp == 0x2197) return face->open;
        if (cp == 0x2192) return face->right;
        if (cp == 0xe000) return face->bell;
    }
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
    // After the icon substitutions above, which claim codepoints inside this range.
    if (viet_codepoint(cp)) {
        if (font == &ht_mono_16) return &ht_viet_16;
        if (font == &ht_mono_20) return &ht_viet_20;
        if (face) return face->viet;
        if (font == &ht_mono_28) return &ht_viet_28;
    }
    return font;
}
static uint32_t font_codepoint(const ht_font_t *font, uint32_t cp)
{
    // Space is always an empty cell, including compact Unicode-only atlases.
    if (cp == ' ' || (cp >= font->first && cp <= font->last)) return cp;
    font = glyph_font(font, cp);
    cp = cell_alias(cp);
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
    cp = cell_alias(cp);
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
    if (ht_pfont(font)) {
        // Proportional: the caller fitted it in pixels (ht_fit_width / ht_lv_label); the
        // column budget below would count glyphs against the space's advance and cut it short.
        size_t n = text ? strnlen(text, sizeof r->text - 1) : 0;
        memcpy(r->text, text ? text : "", n);
        r->text[n] = 0;
    } else display_copy(r->text,sizeof r->text,text,NULL,font,w / font->width);
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
// ── PROPORTIONAL TEXT ──────────────────────────────────────────────────────────────────────────
// The Focus skin's faces carry a glyph per codepoint with its own advance. Everything below is the
// fixed-cell code's counterpart measured in pixels; nothing above changes for a mono atlas.
// One looked-up glyph: which face drew it (the run's, or its fallback) and its index there.
typedef struct { const ht_pfont_t *face; const ht_glyph_t *g; int index; } pglyph_t;
static int pindex(const ht_pfont_t *f, uint32_t cp)
{
    int lo = 0, hi = (int)f->count - 1;
    while (lo <= hi) {
        int mid = (lo + hi) / 2;
        if (f->codes[mid] == cp) return mid;
        if (f->codes[mid] < cp) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
}
static bool plookup(const ht_pfont_t *f, uint32_t cp, pglyph_t *out)
{
    int i = pindex(f, cp);
    if (i >= 0) { *out = (pglyph_t){f, &f->glyphs[i], i}; return true; }
    if (f->fallback && (i = pindex(f->fallback, cp)) >= 0) {
        *out = (pglyph_t){f->fallback, &f->fallback->glyphs[i], i};
        return true;
    }
    if (cp != '?' && (i = pindex(f, '?')) >= 0) { *out = (pglyph_t){f, &f->glyphs[i], i}; return true; }
    return false;
}
// LVGL's class kerning between two glyphs of one face, in 1/16 px (kern_scale 16 cancels its >> 4).
static int pkern(const pglyph_t *a, const pglyph_t *b)
{
    if (a->face != b->face || !a->face->kern_values) return 0;
    unsigned l = a->face->kern_left[a->index], r = b->face->kern_right[b->index];
    return l && r ? a->face->kern_values[(l - 1) * a->face->kern_right_count + (r - 1)] : 0;
}
static uint32_t peek(const char *p)
{
    return *p ? ht_utf8_next(&p) : 0;
}
/*
 * How far `cp` moves the pen when `next` follows it — lv_font_fmt_txt.c's own arithmetic: the
 * advance in 1/16 px plus the pair's kerning, rounded to a whole pixel for this letter. A fixed-cell
 * font answers its cell width.
 */
static int pair_advance(const ht_font_t *f, uint32_t cp, uint32_t next)
{
    const ht_pfont_t *pf = ht_pfont(f);
    if (!pf) return f->width;
    pglyph_t g, n;
    if (!plookup(pf, cp, &g)) return 0;
    int kv = next && plookup(pf, next, &n) ? pkern(&g, &n) : 0;
    return ((int)g.g->adv + kv + 8) >> 4;
}
int ht_measure(const ht_font_t *font, const char *text)
{
    int w = 0;
    for (const char *p = text ? text : ""; *p;) {
        uint32_t cp = ht_utf8_next(&p);
        w += pair_advance(font, cp, peek(p));
    }
    return w;
}
/*
 * LVGL 9.5's word wrap, as the live firmware was configured (LV_TXT_BREAK_CHARS " ,.;:-_)}",
 * LV_TXT_LINE_BREAK_LONG_LEN 0): lv_text_get_next_word and lv_text_get_next_line, letter spacing 0.
 * A break character is a word of its own, so a line keeps the spaces it broke at — and a centred
 * line is centred on a width that counts them, which is what LVGL draws and so what this does.
 */
static bool lv_break_char(uint32_t c) { return c && c < 0x80 && strchr(" ,.;:-_)}", (int)c); }
static size_t lv_next_word(const char *t, const ht_font_t *f, int max, bool all, int *word_w)
{
    const char *p = t, *stop = NULL, *brk = NULL;
    int cur = 0, n = 0;
    *word_w = 0;
    while (*p) {
        const char *at = p;
        uint32_t c = ht_utf8_next(&p);
        n++;
        cur += pair_advance(f, c, peek(p));
        if (!brk && cur > max) { brk = at; if (all) break; }
        if (c == '\n' || c == '\r' || lv_break_char(c)) {
            if (at == t && !brk) *word_w = cur;
            n--;
            stop = n ? at : p;
            break;
        }
        if (!brk) *word_w = cur;
    }
    if (!brk) return (size_t)((stop ? stop : p) - t);
    if (all) return (size_t)(brk - t);
    *word_w = 0;
    return 0;
}
// The next line of `txt` at `width`; returns where the one after it starts. `all` breaks inside
// words, as LVGL does on the last visible line of a LONG_DOT label.
static const char *lv_next_line(const char *txt, int width, const ht_font_t *f, bool all)
{
    size_t i = 0;
    int max = width;
    bool newline = false;
    while (txt[i] && max > 0) {
        int ww;
        size_t adv = lv_next_word(txt + i, f, max, all || i == 0, &ww);
        max -= ww;
        if (!adv) break;
        i += adv;
        if (txt[0] == '\n' || txt[0] == '\r') { newline = true; break; }
        if (txt[i] == '\n' || txt[i] == '\r') { i++; newline = true; break; }
    }
    const char *end = txt + i;
    if (!i && *txt) ht_utf8_next(&end);
    if (!newline) while (*end == ' ') end++;
    return end;
}
// lv_text_get_width: the last letter kerns against whatever follows it, past `len` or not.
static int lv_width(const ht_font_t *f, const char *txt, size_t len)
{
    int w = 0;
    for (const char *p = txt; *p && p < txt + len;) {
        uint32_t c = ht_utf8_next(&p);
        w += pair_advance(f, c, peek(p));
    }
    return w;
}
static int lv_layout(ht_lv_label_t *l, const ht_font_t *f, int width, int lines, bool dots)
{
    l->lines = l->w = 0;
    for (const char *p = l->text; *p;) {
        bool last = dots && l->lines == lines - 1;
        const char *end = lv_next_line(p, width, f, last);
        if (l->lines < HT_LV_LINES) {
            ht_lv_line_t *ln = &l->line[l->lines];
            ln->at = (uint16_t)(p - l->text);
            ln->len = (uint16_t)(end - p);
            ln->w = (int16_t)lv_width(f, p, ln->len);
            ln->x = (int16_t)((width - ln->w) / 2);
            if (ln->w > l->w) l->w = ln->w;
        }
        l->lines++;
        p = end;
    }
    return l->lines;
}
int ht_lv_label(ht_lv_label_t *l, const ht_font_t *font, const char *text, int width, int lines,
                bool dots)
{
    snprintf(l->text, sizeof l->text, "%s", text ? text : "");
    if (lines > HT_LV_LINES) lines = HT_LV_LINES;
    int need = lv_layout(l, font, width, lines, false);
    if (dots) lv_layout(l, font, width, lines, true);
    size_t cps = 0;
    for (const char *p = l->text; *p; ht_utf8_next(&p)) cps++;
    /*
     * LV_LABEL_LONG_DOT (lv_label.c refr_text): the letter under `width - 3 dots` on the last line
     * that shows becomes the first of three '.', and the rest of the text goes.
     */
    if (dots && need > lines && need > 1 && cps > 3) {
        const ht_lv_line_t *ln = &l->line[lines - 1];
        int px = width - 3 * pair_advance(font, '.', '.'), x = ln->x;
        const char *line = l->text + ln->at, *dot = line;
        for (const char *p = line; *p && p < line + ln->len;) {
            const char *at = p;
            uint32_t c = ht_utf8_next(&p);
            int gw = pair_advance(font, c, peek(p));
            dot = at;
            if (px < x + gw || p >= line + ln->len) break;
            x += gw;
        }
        size_t id = (size_t)(dot - l->text), len = strlen(l->text);
        while (id && id + 3 > len) { do id--; while (id && ((uint8_t)l->text[id] & 0xc0) == 0x80); }
        size_t k = 0;
        for (; k < 3 && l->text[id + k]; k++) l->text[id + k] = '.';
        l->text[id + k] = 0;
        lv_layout(l, font, width, lines, dots);
    }
    if (l->lines > lines) l->lines = lines;
    return need;
}
int ht_fit_width(char *dst, size_t cap, const char *text, int width, const ht_font_t *font)
{
    static const char ellipsis[] = "\xe2\x80\xa6";
    if (!cap) return 0;
    const char *src = text ? text : "";
    size_t n = strnlen(src, cap - 1);
    memcpy(dst, src, n);
    dst[n] = 0;
    for (char *q = dst; *q; q++) if (*q == '\n') *q = ' ';
    int whole = ht_measure(font, dst);
    if (whole <= width) return whole;
    int room = width - ht_measure(font, ellipsis), used = 0;
    const char *p = dst, *end = dst;
    while (*p) {
        const char *at = p;
        uint32_t cp = ht_utf8_next(&p);
        int a = pair_advance(font, cp, peek(p));
        if (used + a > room) break;
        used += a;
        end = p;
        (void)at;
    }
    while (end > dst && end[-1] == ' ') end--;
    size_t keep = (size_t)(end - dst);
    if (keep + sizeof ellipsis > cap) keep = cap > sizeof ellipsis ? cap - sizeof ellipsis : 0;
    memcpy(dst + keep, ellipsis, sizeof ellipsis);
    return ht_measure(font, dst);
}
bool ht_icon(ht_scene_t *s, int x, int y, const ht_icon_t *icon)
{
    if (s->count >= HT_RUNS || !icon || !icon->w) return false;
    ht_run_t *r = &s->runs[s->count++];
    memset(r, 0, sizeof *r);
    // Not text, but the rest of the compositor reads every run's font; it is never drawn.
    r->x = x; r->y = y; r->w = icon->w; r->font = &ht_mono_16;
    r->sprite = (ht_sprite_t){.pixels = icon->px, .alpha = icon->a, .width = icon->w,
                              .height = icon->h, .lvgl = true};
    return true;
}
bool ht_cell_sprite(ht_scene_t *s, int x, int y, const ht_cell_frame_t *f)
{
    if (s->count >= HT_RUNS || !f || !f->cols || !f->rows || !f->cell) return false;
    ht_run_t *r = &s->runs[s->count++];
    memset(r, 0, sizeof *r);
    r->x = x; r->y = y; r->w = f->cols * f->cell; r->font = &ht_mono_16;
    r->sprite = (ht_sprite_t){.width = r->w, .height = f->rows * f->cell, .cells = f->cells,
                              .palette = f->palette, .cell = f->cell};
    return true;
}
bool ht_box(ht_scene_t *s, int x, int y, int w, int h, int radius, uint16_t fill, uint16_t border)
{
    if (s->count >= HT_RUNS || w <= 0 || h <= 0) return false;
    ht_run_t *r = &s->runs[s->count++];
    memset(r, 0, sizeof *r);
    // A box is not text, but the rest of the compositor reads every run's font; it is never drawn.
    r->x = x; r->y = y; r->w = w; r->font = &ht_mono_16; r->fg = r->bg = fill;
    if (radius > w / 2) radius = w / 2;
    if (radius > h / 2) radius = h / 2;
    r->box.h = (uint16_t)h; r->box.fill = fill; r->box.border = border; r->box.radius = (uint8_t)radius;
    return true;
}

/*
 * A PROPORTIONAL ARC LABEL (Focus: Literata Medium 26 for the name and the lower status). Each glyph keeps its own advance and kerning, in
 * 1/16 px like the straight text, and stands upright at its own place on the 205 px curve: the arc
 * length from the label's centre to the glyph's advance centre, divided by 205, is its angle (the Q14
 * table in arc_geometry.inc steps 1 px of arc; the 1/16 between entries is interpolated). The curve
 * carries the middle of the caps, ARC_PROP_MID above the baseline (a face's own `mid`, when it has one), at 205 (the baseline on 194, as in
 * mockup/focus-v2.html) so the tallest stacked Vietnamese letter ends inside the 128 px canvas at
 * 12 o'clock; the lower arc sits 3 px nearer the centre, so its descenders end inside it as well.
 * Literata's stacked marks stand tall, so its upper-arc face carries mid 16; its lower-arc face keeps
 * mid 11 (its descenders would leave the canvas at 16).
 * The three walks over a label — bounds, mask geometry, mask paint — share one placement, so the
 * bounds can never be smaller than the ink.
 */
enum { ARC_PROP_MID = 11, ARC_PROP_RADIUS = 205, ARC_PROP_LOWER = 202, ARC_PROP_SPAN16 = HT_ARC_SPAN * 16 };
#ifdef DEVICE_LAYOUT_BENCH
static bool arc_tight;   // defined below with the mask cache
#endif
typedef struct {
    pglyph_t g;
    int cx, cy;              // the pivot in canvas px * 256 (the arc canvas is r->x, r->y)
    int sn, cs;              // the rotation, Q14; sn already mirrored for the lower arc
    int index;               // the glyph's place in the label's text, from 0
    int left, top;           // the ink box from the pivot, px * 256, before rotating
    int x0, y0, x1, y1;      // the canvas pixels it can touch (bilinear halo and rounding included)
} arc_pplace_t;
static int arc_advance16(const ht_pfont_t *f, const pglyph_t *g, const char *rest)
{
    pglyph_t n;
    return g->g->adv + (*rest && plookup(f, peek(rest), &n) ? pkern(g, &n) : 0);
}
static int arc_prop_width16(const ht_pfont_t *f, const char *text)
{
    int w = 0;
    for (const char *p = text; *p;) {
        pglyph_t g;
        uint32_t cp = ht_utf8_next(&p);
        if (plookup(f, cp, &g)) w += arc_advance16(f, &g, p);
    }
    return w;
}
static void arc_prop_walk(const ht_run_t *r, const ht_pfont_t *f,
                          void (*visit)(void *, const arc_pplace_t *), void *ctx)
{
    int total = arc_prop_width16(f, r->text), pen = 0, limit = (ARC_PROP_TRIG - 2) * 16, index = 0;
    for (const char *p = r->text; *p;) {
        pglyph_t g;
        uint32_t cp = ht_utf8_next(&p);
        int at = index++;
        if (!plookup(f, cp, &g)) continue;
        int adv = arc_advance16(f, &g, p);
        const ht_glyph_t *gl = g.g;
        int s16 = pen + gl->adv / 2 - total / 2;
        pen += adv;
        if (!gl->w || !gl->h) continue;
        int mag = s16 < 0 ? -s16 : s16;
        if (mag > limit) mag = limit;
        int i = mag >> 4, fr = mag & 15;
        arc_pplace_t pl = {.g = g, .index = at};
        pl.sn = (arc_prop_trig[i][0] * (16 - fr) + arc_prop_trig[i + 1][0] * fr) >> 4;
        pl.cs = (arc_prop_trig[i][1] * (16 - fr) + arc_prop_trig[i + 1][1] * fr) >> 4;
        if (s16 < 0) pl.sn = -pl.sn;
        bool lower = r->arc == 2;
        int radius = lower ? ARC_PROP_LOWER : ARC_PROP_RADIUS;
        pl.cx = (233 - r->x) * 256 + (radius * pl.sn * 256 >> 14);
        pl.cy = (233 - r->y) * 256 + (lower ? 1 : -1) * (radius * pl.cs * 256 >> 14);
        if (lower) pl.sn = -pl.sn;   // the lower arc reads left to right with upright letters
        pl.left = gl->ox * 256 - gl->adv * 8;
        pl.top = ((r->arc_mid ? r->arc_mid : ARC_PROP_MID) + gl->oy - g.face->ascent) * 256;
        // The ink box and one pixel of bilinear halo, rotated about the pivot.
        int u0 = pl.left - 256, u1 = pl.left + gl->w * 256 + 256;
        int v0 = pl.top - 256, v1 = pl.top + gl->h * 256 + 256;
#ifdef DEVICE_LAYOUT_BENCH
        if (!arc_tight) { u0 -= 256; v0 -= 256; u1 += 256; v1 += 256; }   // looser than the 1 px halo
#endif
        int minx = 1 << 30, maxx = -minx, miny = minx, maxy = -minx;
        for (int c = 0; c < 4; c++) {
            int u = c & 1 ? u1 : u0, v = c & 2 ? v1 : v0;
            int dx = (u * pl.cs - v * pl.sn) >> 14, dy = (u * pl.sn + v * pl.cs) >> 14;
            minx = imin(minx, dx); maxx = imax(maxx, dx); miny = imin(miny, dy); maxy = imax(maxy, dy);
        }
        pl.x0 = imax(0, ((pl.cx + minx) >> 8) - 2);
        pl.x1 = imin(HT_ARC_WIDTH, ((pl.cx + maxx) >> 8) + 3);
        pl.y0 = imax(0, ((pl.cy + miny) >> 8) - 2);
        pl.y1 = imin(HT_ARC_HEIGHT, ((pl.cy + maxy) >> 8) + 3);
        visit(ctx, &pl);
    }
}
// `text` cut to what fits the span: whole, else at the last word when that keeps at least half the span
// (as the mono rule keeps half the columns), else per character, before "…" (none when `bare`).
// Newlines are spaces.
static void arc_prop_fit(char *dst, size_t cap, const ht_pfont_t *f, const char *text, bool bare)
{
    char flat[HT_TEXT_BYTES];
    size_t len = strlen(text), n = len < sizeof flat - 4 ? len : sizeof flat - 4;
    if (n > cap - 4) n = cap - 4;
    while (n < len && n && ((uint8_t)text[n] & 0xc0) == 0x80) n--;
    memcpy(flat, text, n);
    flat[n] = 0;
    for (char *c = flat; *c; c++) if (*c == '\n') *c = ' ';
    bool cut = n < len;
    for (;;) {
        memcpy(dst, flat, n);
        dst[n] = 0;
        if (cut && !bare) strcpy(dst + n, "\xe2\x80\xa6");
        if (arc_prop_width16(f, dst) <= ARC_PROP_SPAN16 || !n) return;
        size_t k = n, word = 0;
        while (k && flat[k - 1] != ' ') k--;
        if (k) {
            word = k - 1;   // the word before
            while (word && flat[word - 1] == ' ') word--;
            memcpy(dst, flat, word);
            dst[word] = 0;
            if (arc_prop_width16(f, dst) < ARC_PROP_SPAN16 / 2) word = 0;   // too little left: cut letters
        }
        if (word) n = word;
        else do n--; while (n && ((uint8_t)flat[n] & 0xc0) == 0x80);
        while (n && flat[n - 1] == ' ') n--;
        cut = true;
    }
}
// One glyph shorter, still ending "…" (unless `bare`); false once nothing but "…" is left.
static bool arc_prop_trim(char *text, bool bare)
{
    size_t n = strlen(text);
    if (n >= 3 && !strcmp(text + n - 3, "\xe2\x80\xa6")) n -= 3;
    size_t kept = n;
    if (n) do n--; while (n && ((uint8_t)text[n] & 0xc0) == 0x80);
    while (n && text[n - 1] == ' ') n--;
    if (bare) text[n] = 0;
    else strcpy(text + n, "\xe2\x80\xa6");
    return kept != 0;
}
enum { ARC_HALF = HT_ARC_WIDTH / 2, ARC_MASK_BYTES = 9216 };
_Static_assert(sizeof ((ht_run_t *)0)->gain == HT_ARC_GAINS, "a run holds one gain per arc glyph");
typedef struct {
    uint16_t offset;
    uint8_t first, last;
    uint8_t ink_first, ink_last;
} arc_span_t;
// Widens each row's two bands by one glyph's rotated box; ctx is the spans array.
static void arc_prop_band(void *ctx, const arc_pplace_t *g)
{
    arc_span_t (*spans)[2] = ctx;
    for (int y = g->y0; y < g->y1; y++) for (int h = 0; h < 2; h++) {
        int left = imax(0, g->x0 - h * ARC_HALF), right = imin(ARC_HALF, g->x1 - h * ARC_HALF);
        if (left >= right) continue;
        arc_span_t *span = &spans[y][h];
        if (left < span->first) span->first = left;
        if (right > span->last) span->last = right;
    }
}
// The packed 4-bit mask a label needs, in bytes, with the row bands (offsets included) left in `spans`.
static unsigned arc_prop_geometry(const ht_run_t *r, const ht_pfont_t *pf, arc_span_t (*spans)[2])
{
    for (int y = 0; y < HT_ARC_HEIGHT; y++) for (int h = 0; h < 2; h++)
        spans[y][h] = (arc_span_t){.first = ARC_HALF, .ink_first = ARC_HALF};
    arc_prop_walk(r, pf, arc_prop_band, spans);
    unsigned used = 0;
    for (int y = 0; y < HT_ARC_HEIGHT; y++) for (int h = 0; h < 2; h++) {
        arc_span_t *span = &spans[y][h];
        span->offset = used;
        if (span->first < span->last) used += (span->last - span->first + 1) / 2;
    }
    return used;
}
typedef struct { int x0, y0, x1, y1; } arc_union_t;
static void arc_union_visit(void *ctx, const arc_pplace_t *g)
{
    arc_union_t *u = ctx;
    u->x0 = imin(u->x0, g->x0); u->y0 = imin(u->y0, g->y0);
    u->x1 = imax(u->x1, g->x1); u->y1 = imax(u->y1, g->y1);
}
static void arc_text(ht_scene_t *s, uint16_t fg, const char *text, bool bottom,
                     const ht_arc_face_t *face)
{
    if (!text || !*text) return;
    if (!face) face = &ht_arc_geist;
    char visible[HT_TEXT_BYTES];
    if (face->prop) {
        // The run carries the pfont's base as its font; a proportional run is fitted by the caller.
        arc_prop_fit(visible, sizeof visible, face->prop, text, face->bare);
        if (!ht_text(s, HT_ARC_X, HT_ARC_Y, HT_ARC_WIDTH, &face->prop->base, fg, s->background, visible)) return;
    } else {
        bool complete = ht_display_text(visible,sizeof visible,text,face->mono);
        if (!ht_text(s, HT_ARC_X, HT_ARC_Y, HT_ARC_COLS * face->mono->width,
                     face->mono, fg, s->background, visible)) return;
        ht_run_t *m = &s->runs[s->count - 1];
        // A long name ends at a word boundary; the pane list retains its full name.
        if (!complete || strlen(visible) > strlen(m->text)) {
            char *last = strrchr(m->text, ' ');
            if (last && last - m->text >= HT_ARC_COLS / 2) *last = 0;
        }
    }
    ht_run_t *r = &s->runs[s->count - 1];
    r->arc = bottom ? 2 : 1;
    r->y = bottom ? HT_HEIGHT - HT_ARC_Y - HT_ARC_HEIGHT : HT_ARC_Y;
    r->w = HT_ARC_WIDTH;
    if (face->prop) {
        r->arc_mid = face->mid;
        // A mask that would not fit would blank the label: cut it shorter instead, until it does.
        arc_span_t spans[HT_ARC_HEIGHT][2];
        while (arc_prop_geometry(r, face->prop, spans) > ARC_MASK_BYTES && arc_prop_trim(r->text, face->bare)) {}
        // The tight bounds, laid out once here: a pure function of the run's text, face and position.
        arc_union_t u = {HT_ARC_WIDTH, HT_ARC_HEIGHT, 0, 0};
        arc_prop_walk(r, face->prop, arc_union_visit, &u);
        r->ink = 1;
        if (u.x0 < u.x1 && u.y0 < u.y1)
            r->ink_box = (ht_rect_t){r->x + u.x0, r->y + u.y0, u.x1 - u.x0, u.y1 - u.y0};
    }
}
void ht_arc_title(ht_scene_t *s, uint16_t fg, const char *text) { arc_text(s, fg, text, false, &ht_arc_geist); }
void ht_arc_title_face(ht_scene_t *s, uint16_t fg, const char *text, const ht_arc_face_t *face)
{
    arc_text(s, fg, text, false, face);
}
void ht_arc_status(ht_scene_t *s, uint16_t fg, const char *text) { arc_text(s, fg, text, true, &ht_arc_geist); }
void ht_arc_status_face(ht_scene_t *s, uint16_t fg, const char *text, const ht_arc_face_t *face)
{
    arc_text(s, fg, text, true, face);
}
void ht_arc_status_sweep(ht_scene_t *s, uint16_t fg, const char *text, const ht_arc_face_t *face,
                         const uint8_t *gain)
{
    int before = s->count;
    arc_text(s, fg, text, true, face);
    if (!gain || s->count == before || !face || !face->prop) return;
    ht_run_t *r = &s->runs[s->count - 1];
    r->gained = 1;
    memcpy(r->gain, gain, HT_ARC_GAINS);
}
int ht_arc_measure(const ht_arc_face_t *face, const char *text)
{
    if (!face) face = &ht_arc_geist;
    return face->prop ? (arc_prop_width16(face->prop, text) + 15) >> 4 : ht_measure(face->mono, text);
}
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
        if (cp < glyph->first || cp > glyph->last) cp = cell_alias(cp);
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
    if (r->sprite.width) return (ht_rect_t){r->x,r->y,r->sprite.width,r->sprite.height};
    if (r->box.h) return (ht_rect_t){r->x, r->y, r->w, (int16_t)r->box.h};
    if (r->arc && ht_pfont(r->font)) {
        if (r->ink) return r->ink_box;   // laid out once, by arc_text
        // A hand-built run (no stored bounds): lay it out here.
        arc_union_t u = {HT_ARC_WIDTH, HT_ARC_HEIGHT, 0, 0};
        arc_prop_walk(r, ht_pfont(r->font), arc_union_visit, &u);
        if (u.x0 >= u.x1 || u.y0 >= u.y1) return (ht_rect_t){0, 0, 0, 0};
        return (ht_rect_t){r->x + u.x0, r->y + u.y0, u.x1 - u.x0, u.y1 - u.y0};
    }
    if (r->arc) {
        const char *p = r->text; int count = 0;
        while (*p && count < HT_ARC_COLS) { ht_utf8_next(&p); count++; }
        if (!count) return (ht_rect_t){0, 0, 0, 0};
        int sn = arc_trig[count - 1][0], cs = arc_trig[count - 1][1];
        // Tight, conservative ink bounds. The arc canvas remains 416x128, but
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
typedef uint8_t damage_coord_t;
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
                // Fixed-cell text only: a proportional run's glyphs move when one before them
                // changes width, and a box has no cells. Both repaint their whole bounds instead.
                if (!old->sprite.width && !next->sprite.width && !old->arc && !next->arc &&
                    !old->box.h && !next->box.h && !ht_pfont(old->font) && !ht_pfont(next->font) &&
                    old->x == next->x && old->y == next->y && old->w == next->w &&
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
                            (old->colors ? old->colors[cell] : old->fg) !=
                            (next->colors ? next->colors[cell] : next->fg))) {
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
// An `a`-in-`levels` mix: 3 for fixed-cell 2-bit glyphs, 15 for 4-bit ones, 16 for box corners (0 = all bg, `levels` = all fg).
static uint16_t mix(uint16_t fg, uint16_t bg, unsigned a, unsigned levels)
{
    unsigned half = levels / 2;
    unsigned r = ((fg >> 11) * a + (bg >> 11) * (levels - a) + half) / levels;
    unsigned g = (((fg >> 5) & 63) * a + ((bg >> 5) & 63) * (levels - a) + half) / levels;
    unsigned b = ((fg & 31) * a + (bg & 31) * (levels - a) + half) / levels;
    return (uint16_t)((r << 11) | (g << 5) | b);
}
static uint16_t blend(uint16_t fg, uint16_t bg, unsigned alpha)
{
    return panel16(mix(fg, bg, alpha, 3));
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
#define GLYPH_PIXELS 50
#define GLYPH_MAX_W  5
#define GLYPH_MAX_H  10
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
// All 52 count/edge geometries fit in 4538 bytes; 4608 leaves a little headroom.
// Upper/lower text have independent keys, so they never evict each other.
// Scenes retain immutable text, allowing old scenes to rasterize correctly.
// A proportional label's mask keeps its 4-bit coverage (two pixels a byte, `bpp` 4) instead of the mono
// atlases' two bits, so the same cache entry holds either. 9216 holds every label arc_text lets through:
// the worst real one (stacked Vietnamese capitals, 24 glyphs) needs 9116 in Literata, and arc_text re-fits any label
// whose mask would not fit shorter (with "…") rather than drawing nothing; the mono ones need 4538.
typedef struct {
    uint8_t mask[ARC_MASK_BYTES];
    arc_span_t spans[HT_ARC_HEIGHT][2];
    char text[HT_TEXT_BYTES];
    uint16_t mask_bytes;
    uint8_t columns;
    const ht_arc_face_t *face; // the face the mask was built for; NULL = empty
    const ht_pfont_t *prop;    // its pfont when proportional (the run's font is that face's base)
    uint8_t bpp;               // 2 for the mono faces, 4 for a proportional one
    uint8_t mid;               // a proportional mask's mid-caps offset (the face's `mid`: the curve carries the glyphs there)
    uint8_t gain[HT_ARC_GAINS];   // a proportional mask's per-glyph gains (255 = plain)
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
    arc_caches[0].face = arc_caches[1].face = NULL;
    arc_caches[0].prop = arc_caches[1].prop = NULL;
}
void ht_arc_fast_sampling(bool enabled)
{
    arc_fast = enabled;
    arc_caches[0].face = arc_caches[1].face = NULL;
    arc_caches[0].prop = arc_caches[1].prop = NULL;
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
        int half_w = (((HT_ARC_CELL_WIDTH + 1) * cs + (HT_ARC_CELL_HEIGHT + 1) * sin_abs) >> 15) + 2;
        int half_h = (((HT_ARC_CELL_HEIGHT + 1) * cs + (HT_ARC_CELL_WIDTH + 1) * sin_abs) >> 15) + 2;
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
/*
 * The proportional label's mask. Geometry first, from the same placement the bounds use: each glyph's
 * rotated box widens the two row bands, so a short name costs a few rows and a long one the whole
 * arc. Then each glyph is sampled into the mask by the mono path's bilinear rule (a pixel's centre
 * mapped back into the upright glyph, 1/256 px, and the four nearest coverage values weighted) from
 * the glyph's 4-bit stream, kept at 4 bits; overlapping boxes keep the larger coverage.
 */
static unsigned prop_coverage(const ht_glyph_t *gl, const uint8_t *bits, int x, int y)
{
    if (x < 0 || y < 0 || x >= gl->w || y >= gl->h) return 0;
    unsigned k = (unsigned)(y * gl->w + x);
    return (bits[k >> 1] >> ((k & 1) ? 0 : 4)) & 15;
}
static void arc_prop_paint(void *ctx, const arc_pplace_t *g)
{
    arc_cache_t *cache = ctx;
    const ht_glyph_t *gl = g->g.g;
    const unsigned gain = g->index < HT_ARC_GAINS ? cache->gain[g->index] : 255;
    const uint8_t *bits = g->g.face->base.pixels + gl->offset;
    for (int y = g->y0; y < g->y1; y++) for (int x = g->x0; x < g->x1; x++) {
        int dx = x * 256 + 128 - g->cx, dy = y * 256 + 128 - g->cy;
        int sx = ((dx * g->cs + dy * g->sn) >> 14) - g->left - 128;
        int sy = ((-dx * g->sn + dy * g->cs) >> 14) - g->top - 128;
        if (sx < -256 || sx >= gl->w * 256 || sy < -256 || sy >= gl->h * 256) continue;
        int gx = sx >> 8, gy = sy >> 8;
        unsigned fx = sx & 255, fy = sy & 255;
        unsigned upper = prop_coverage(gl, bits, gx, gy) * (256 - fx) + prop_coverage(gl, bits, gx + 1, gy) * fx;
        unsigned lower = prop_coverage(gl, bits, gx, gy + 1) * (256 - fx) + prop_coverage(gl, bits, gx + 1, gy + 1) * fx;
        unsigned a = (upper * (256 - fy) + lower * fy + 32768) >> 16;
        if (gain != 255) a = (a * gain + 127) / 255;
        if (!a) continue;
        arc_span_t *span = &cache->spans[y][x >= ARC_HALF];
        int local = x - (x >= ARC_HALF ? ARC_HALF : 0);
        if (local < span->first || local >= span->last) continue;
        unsigned k = (unsigned)(local - span->first), shift = (k & 1) ? 0 : 4;
        uint8_t *packed = &cache->mask[span->offset + (k >> 1)];
        if (a > ((*packed >> shift) & 15u)) {
            *packed = (uint8_t)((*packed & ~(15u << shift)) | (a << shift));
            if (local < span->ink_first) span->ink_first = local;
            if (local + 1 > span->ink_last) span->ink_last = local + 1;
        }
    }
}
static void arc_prepare_prop(const ht_run_t *r, arc_cache_t *cache, const ht_pfont_t *pf)
{
    uint8_t gain[HT_ARC_GAINS];
    for (int i = 0; i < HT_ARC_GAINS; i++) gain[i] = r->gained ? r->gain[i] : 255;
    if (cache->prop == pf && cache->bpp == 4 && cache->mid == r->arc_mid && !strcmp(cache->text, r->text) &&
        !memcmp(cache->gain, gain, sizeof gain)) return;
    strcpy(cache->text, r->text);
    cache->mid = r->arc_mid;
    memcpy(cache->gain, gain, sizeof gain);
    cache->face = NULL; cache->prop = pf; cache->bpp = 4; cache->columns = 0; arc_builds++;
    unsigned used = arc_prop_geometry(r, pf, cache->spans);
    cache->mask_bytes = used <= sizeof cache->mask && used <= UINT16_MAX ? used : 0;
    if (!cache->mask_bytes) return;
    memset(cache->mask, 0, cache->mask_bytes);
    arc_prop_walk(r, pf, arc_prop_paint, cache);
}
static void arc_prepare(const ht_run_t *r, arc_cache_t *cache)
{
    const ht_pfont_t *pf = ht_pfont(r->font);
    if (pf) { arc_prepare_prop(r, cache, pf); return; }
    const ht_arc_face_t *face = arc_face_of(r->font);
    if (!face) face = &ht_arc_geist;
    if (cache->face == face && cache->bpp == 2 && !strcmp(cache->text, r->text)) return;   // the same text in another face is another mask
    strcpy(cache->text, r->text);
    cache->face = face; cache->prop = NULL; cache->bpp = 2; arc_builds++;
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
    uint8_t coverage[(HT_ARC_CELL_WIDTH + 2) * (HT_ARC_CELL_HEIGHT + 2)];
    for (int i = 0; i < count; i++) {
        uint32_t c = font_codepoint(face->mono, cp[i]);
        if (c == ' ') continue;
        const ht_font_t *f = glyph_font(face->mono, c);
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
        int half_w, half_h;
        int box_x = cx, box_y = cy;
#ifdef DEVICE_LAYOUT_BENCH
        if (!arc_tight) {
            half_w = (((HT_ARC_CELL_WIDTH + 1) * cs + (HT_ARC_CELL_HEIGHT + 1) * sin_abs) >> 15) + 2;
            half_h = (((HT_ARC_CELL_HEIGHT + 1) * cs + (HT_ARC_CELL_WIDTH + 1) * sin_abs) >> 15) + 2;
        } else
#endif
        {
            const uint8_t full_ink[] = {0, 0, HT_ARC_CELL_WIDTH, HT_ARC_CELL_HEIGHT};
            const uint8_t *ink = f == face->viet ? full_ink : f == face->open ? face->open_ink[0] :
                f == face->right ? face->right_ink[0] :
                f == face->bell ? face->bell_ink[0] : face->ink[c - f->first];
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
    // Colour a cached mask: no glyph rotation, allocations or extra text runs. The 4-bit (proportional)
    // masks mix in fifteenths; both tables are 16 wide so one loop reads either.
    const unsigned top = cache->bpp == 4 ? 15 : 3;
    uint16_t palette[16] = {0};
    for (unsigned a = 1; a <= top; a++) palette[a] = panel16(mix(r->fg, r->bg, a, top));
    // Sixteen brightness levels use at most 512 bytes of bounded stack scratch.
    uint16_t sweep[16][16];
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
            for (unsigned a = 1; a <= top; a++) sweep[level][a] = panel16(mix(ink, r->bg, a, top));
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
            unsigned a = cache->bpp == 4 ? (mask[k >> 1] >> ((k & 1) ? 0 : 4)) & 15
                                         : (mask[k >> 2] >> ((3-(k&3))*2)) & 3;
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
static uint16_t lv_mix24_16(uint16_t src, uint16_t dst, unsigned a);
static void sprite_raster(const ht_run_t *r, ht_rect_t clip, uint16_t *out)
{
    const ht_sprite_t *s=&r->sprite;
    if(!s->pixels&&!s->cells)return;
    int left=imax(clip.x,r->x),right=imin(clip.x+clip.w,r->x+s->width);
    int top=imax(clip.y,r->y),bottom=imin(clip.y+clip.h,r->y+s->height);
    if(s->cells){
        // Cells: a run of `cell` px per palette index, 0 leaves the frame as it is.
        int cols=s->width/s->cell;
        for(int y=top;y<bottom;y++){
            const uint8_t *row=s->cells+(size_t)((y-r->y)/s->cell)*cols;
            uint16_t *dst=out+(y-clip.y)*clip.w+left-clip.x;
            for(int x=left;x<right;){
                int c=(x-r->x)/s->cell,end=imin(right,r->x+(c+1)*s->cell),n=end-x;
                if(row[c])for(int k=0;k<n;k++)dst[k]=s->palette[row[c]];
                dst+=n;x=end;
            }
        }
        return;
    }
    for(int y=top;y<bottom;y++){
        size_t at=(size_t)(y-r->y)*s->width+left-r->x;
        uint16_t *dst=out+(y-clip.y)*clip.w+left-clip.x;
        int x=left;
        while(x<right){
            unsigned a=s->alpha?s->alpha[at]:255;
            if(!a){at++;dst++;x++;continue;}
            if(a==255){
                size_t first=at;
                do{at++;x++;}while(x<right && (!s->alpha || s->alpha[at]==255));
                size_t n=at-first;memcpy(dst,s->pixels+first,n*2);dst+=n;continue;
            }
            if(s->lvgl){*dst=panel16(lv_mix24_16(panel16(s->pixels[at]),panel16(*dst),a));at++;dst++;x++;continue;}
            uint16_t fg=panel16(s->pixels[at]),bg=panel16(*dst);
            unsigned red=((fg>>11)*a+(bg>>11)*(255-a)+127)/255;
            unsigned green=(((fg>>5)&63)*a+((bg>>5)&63)*(255-a)+127)/255;
            unsigned blue=((fg&31)*a+(bg&31)*(255-a)+127)/255;
            *dst++=panel16((red<<11)|(green<<5)|blue);at++;x++;
        }
    }
}
// lv_color_16_16_mix, as LVGL 9.5 blends a glyph's coverage into an RGB565 frame.
static uint16_t lv_mix16(uint16_t c1, uint16_t c2, uint8_t mix)
{
    if (mix == 255) return c1;
    if (mix == 0 || c1 == c2) return mix ? c1 : c2;
    mix = (uint8_t)(((uint32_t)mix + 4) >> 3);
    uint32_t bg = (uint32_t)(c2 | ((uint32_t)c2 << 16)) & 0x7E0F81Fu;
    uint32_t fg = (uint32_t)(c1 | ((uint32_t)c1 << 16)) & 0x7E0F81Fu;
    uint32_t result = ((((fg - bg) * mix) >> 5) + bg) & 0x7E0F81Fu;
    return (uint16_t)((result >> 16) | result);
}
// lv_color_24_16_mix with a 565 source: how LVGL blends an ARGB8888 image into an RGB565 frame.
static uint16_t lv_mix24_16(uint16_t src, uint16_t dst, unsigned a)
{
    if (!a) return dst;
    if (a == 255) return src;
    unsigned inv = 255 - a;
    return (uint16_t)(((((src >> 11) * a + (dst >> 11) * inv) << 3) & 0xF800) +
                      (((((src >> 5) & 63) * a + ((dst >> 5) & 63) * inv) >> 3) & 0x07E0) +
                      (((src & 31) * a + (dst & 31) * inv) >> 8));
}
/*
 * A PROPORTIONAL RUN, drawn the way LVGL draws a label: each letter's box at `pen + ofs_x` and
 * `top + (line - base) - box_h - ofs_y` (precomputed as oy), its 4-bit coverage as opacity v * 17,
 * blended into whatever is already on the frame — so text laid on a card blends into the card. The
 * pen moves by the pair advance, kerning included. Nothing is filled behind the run. Clipped to the
 * run's bounds, which are also its damage.
 */
static void prop_raster(const ht_run_t *r, ht_rect_t clip, uint16_t *out)
{
    const ht_pfont_t *f = ht_pfont(r->font);
    int x1 = imax(clip.x, r->x), x2 = imin(clip.x + clip.w, r->x + r->w);
    int y1 = imax(clip.y, r->y), y2 = imin(clip.y + clip.h, r->y + f->base.height);
    if (x1 >= x2 || y1 >= y2) return;
    int pen = r->x;
    for (const char *p = r->text; *p && pen < x2;) {
        uint32_t cp = ht_utf8_next(&p);
        pglyph_t g;
        if (!plookup(f, cp, &g)) continue;
        int adv = pair_advance(r->font, cp, peek(p));
        const ht_glyph_t *gl = g.g;
        // A fallback face's letter sits on this face's baseline.
        int gx = pen + gl->ox, gy = r->y + f->ascent - g.face->ascent + gl->oy;
        int xa = imax(x1, gx), xb = imin(x2, gx + gl->w), ya = imax(y1, gy), yb = imin(y2, gy + gl->h);
        const uint8_t *bits = g.face->base.pixels + gl->offset;
        for (int y = ya; y < yb; y++) {
            uint16_t *dst = out + (y - clip.y) * clip.w + xa - clip.x;
            for (int x = xa; x < xb; x++, dst++) {
                unsigned k = (unsigned)((y - gy) * gl->w + (x - gx));
                unsigned v = (bits[k >> 1] >> ((k & 1) ? 0 : 4)) & 15;
                if (v) *dst = panel16(lv_mix16(r->fg, panel16(*dst), (uint8_t)(v * 17)));
            }
        }
        pen += adv;
    }
}
static uint32_t isqrt(uint32_t v)
{
    uint32_t r = 0, bit = 1u << 30;
    while (bit > v) bit >>= 2;
    while (bit) {
        if (v >= r + bit) { v -= r + bit; r = (r >> 1) + bit; } else r >>= 1;
        bit >>= 2;
    }
    return r;
}
/*
 * A ROUNDED BOX, analytically: full coverage everywhere but the four corner squares, where each
 * pixel's coverage is its centre's distance from the corner's centre against the radius, in
 * sixteenths of a pixel. The border is the same test one pixel in. Blended onto whatever is
 * already there, so a box on the canvas and a box on a card both antialias correctly.
 */
static void box_raster(const ht_run_t *r, ht_rect_t clip, uint16_t *out)
{
    int bx = r->x, by = r->y, bw = r->w, bh = r->box.h, rad = r->box.radius;
    int x1 = imax(clip.x, bx), x2 = imin(clip.x + clip.w, bx + bw);
    int y1 = imax(clip.y, by), y2 = imin(clip.y + clip.h, by + bh);
    if (x1 >= x2) return;
    bool edged = r->box.border != r->box.fill;
    uint16_t pf = panel16(r->box.fill), pb = panel16(edged ? r->box.border : r->box.fill);
    for (int y = y1; y < y2; y++) {
        uint16_t *row = out + (y - clip.y) * clip.w - clip.x;
        bool corner_row = y < by + rad || y >= by + bh - rad;
        if (!corner_row) {
            // The straight middle: one border pixel each side, the fill between. Most of a card.
            int left = imax(x1, bx + 1), right = imin(x2, bx + bw - 1);
            if (x1 == bx) row[bx] = pb;
            if (right > left) fill(row + left, (size_t)(right - left), pf);
            if (x2 == bx + bw) row[bx + bw - 1] = pb;
            continue;
        }
        bool edge_row = y == by || y == by + bh - 1;
        int cy = y < by + rad ? by + rad : by + bh - rad;
        int dy = y * 16 + 8 - cy * 16;
        for (int x = x1; x < x2; x++) {
            int cx = x < bx + rad ? bx + rad : x >= bx + bw - rad ? bx + bw - rad : -1;
            if (cx < 0) { row[x] = edge_row ? pb : pf; continue; }
            // A corner pixel: coverage from its centre's distance to the corner's centre.
            int dx = x * 16 + 8 - cx * 16;
            int d = (int)isqrt((uint32_t)(dx * dx + dy * dy));
            int o = rad * 16 + 8 - d, in = (rad - 1) * 16 + 8 - d;
            if (o <= 0) continue;
            unsigned outer = o >= 16 ? 16 : (unsigned)o, inner = in <= 0 ? 0 : in >= 16 ? 16 : (unsigned)in;
            uint16_t c = !edged || inner == 16 ? r->box.fill : inner == 0 ? r->box.border
                       : mix(r->box.fill, r->box.border, inner, 16);
            row[x] = outer == 16 ? panel16(c) : panel16(mix(c, panel16(row[x]), outer, 16));
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
        if (r->sprite.width) { sprite_raster(r, clip, out); continue; }
        if (r->box.h) { box_raster(r, clip, out); continue; }
        if (r->arc) { arc_raster(r, clip, out); continue; }
        if (ht_pfont(f)) { prop_raster(r, clip, out); continue; }
        int y1 = imax(clip.y, r->y), y2 = imin(clip.y + clip.h, r->y + f->height),
            x1 = imax(clip.x, r->x), x2 = imin(clip.x + clip.w, r->x + r->w);
        if (r->bg != s->background)
            for (int y = y1; y < y2; y++)
                fill(out + (y - clip.y) * clip.w + x1 - clip.x, (size_t)(x2 - x1), panel16(r->bg));
        uint16_t palette[4] = {panel16(r->bg), blend(r->fg, r->bg, 1), blend(r->fg, r->bg, 2),
                               panel16(r->fg)};
        bool cached = !r->colors && glyph_cache_prepare(f, r->fg, r->bg);
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
                if (r->colors) {
                    uint16_t fg = r->colors[cell];
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
