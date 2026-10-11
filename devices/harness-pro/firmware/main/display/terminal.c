#include "terminal.h"
#include "pro_canvas.h"
#include <stdio.h>
#include <string.h>
#include "display_fallbacks.inc"

static int imin(int a, int b) { return a < b ? a : b; }
static int imax(int a, int b) { return a > b ? a : b; }
/*
 * The Pro's ST7703 is a DPI panel scanned continuously out of a framebuffer in the SoC's own little-endian
 * order, and it swaps nothing: the raster below emits plain RGB565. (The round dial's QSPI panel wants it
 * byte-swapped; getting this wrong turns #181818 into rgb(192,96,192), not a crash.)
 */
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

// Does the Pro's text path draw this code point as itself? Latin-1, typographic punctuation (aliased to ASCII by
// pro_canvas.c) and the Vietnamese letters its proportional atlases carry. The five marks below keep their UTF-8
// through normalization as well, as they always have; the atlases draw them as '?'.
static bool native_glyph(uint32_t cp)
{
    if (cp < 32 || (cp >= 127 && cp < 160)) return false;
    if (ht_pro_vietnamese_index(cp) >= 0) return true;
    if (cp == 0x2713 || cp == 0x2717 || cp == 0x2192 || cp == 0x2197 || cp == 0xe000) return true;
    cp = punctuation_alias(cp);
    return cp >= 32 && cp <= 255;
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
static void display_token(const char **cursor, display_token_t *t)
{
    const char *start = *cursor;
    uint32_t cp = (unsigned char)*start;
    if (cp < 128) (*cursor)++; // Keep ordinary text on the cheap path.
    else cp = ht_utf8_next(cursor);
    *t = (display_token_t){.text=start,.bytes=(size_t)(*cursor-start),.cells=1};
    if (cp >= 32 && cp < 127) {
        // ASCII prose needs no Unicode lookup.
        t->digit = cp >= '0' && cp <= '9'; t->space = cp == ' ';
        return;
    }
    t->fraction = (cp >= 0xbc && cp <= 0xbe) || (cp >= 0x2150 && cp < 0x215f) || cp == 0x2189;
    if (cp >= 9 && cp <= 13) { t->text=" "; t->bytes=1; }
    else if (cp == 0xa0 || cp == 0xad || t->fraction || !native_glyph(cp)) {
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
bool ht_display_text(char *dst, size_t cap, const char *src)
{
    // Byte capacity also bounds cell count, avoiding unbounded size_t -> int.
    if (!cap) return false;
    int columns = (int)(cap < 32768 ? cap : 32768);
    const char *p = src ? src : "";
    size_t used = 0;
    bool digit = false, fraction = false, complete = true;
    while (*p) {
        bool newline = *p == '\n';
        display_token_t t; display_token(&p,&t);
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
void ht_scene_clear(ht_scene_t *s, uint16_t bg)
{
    s->count = 0;
    s->background = bg;
}
ht_rect_t ht_run_bounds(const ht_run_t *r)
{
    return (ht_rect_t){r->x, r->y, r->w, r->pro_height};
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
// They hold x/2, which reaches 360 on this glass: wider than a byte. A byte here once wrapped the right edge of
// any damage band past x=510 to a small number, so the right of the screen never repainted (no crash, nothing
// in the logs).
typedef uint16_t damage_coord_t;
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
            // a full frame simply because an outline has many steps.
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
void ht_damage(const ht_scene_t *a, const ht_scene_t *b, ht_damage_t *d)
{
    memset(d, 0, sizeof(*d));
    damage_rows_t row_storage, *rows = NULL;
    bool reshape = false;
    if (a && a->background == b->background) {
        reshape = a->count != b->count;
        for (int i = 0; !reshape && i < a->count; i++) {
            const ht_run_t *old = &a->runs[i], *next = &b->runs[i];
            reshape = old->x != next->x || old->y != next->y || old->w != next->w;
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
            if (i < a->count)
                damage_add(d, ht_run_bounds(&a->runs[i]), rows);
            if (i < b->count)
                damage_add(d, ht_run_bounds(&b->runs[i]), rows);
        }
    for (int i = 0; i < d->count; i++)
        d->pixels += (uint32_t)d->rect[i].w * d->rect[i].h;
    if (rows) damage_rows_finish(rows, d);
}
void ht_raster(const ht_scene_t *s, ht_rect_t clip, uint16_t *out)
{
    for (size_t i = 0, n = (size_t)clip.w * clip.h; i < n; i++)
        out[i] = s->background;
    for (int i = 0; i < s->count; i++) {
        const ht_run_t *r = &s->runs[i];
        if (r->pro_kind && intersect(ht_run_bounds(r), clip))
            ht_pro_raster(r, clip, out);
    }
}
