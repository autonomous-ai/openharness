// What App Detail's row paints off the glass (max_ui_draw.h): an agent rasterised on its own (ht_raster of its runs
// alone) and shown back as a window of an image run, so it is cut at its own edges and, a sliver, dimmed and blurred
// as V3's _Dim does it (dimMatrix and a 1.2 px Gaussian blur, transparent past the cell; the blur only where it
// changes anything, and not over words: see "where the blur changes anything"). A settled sliver is painted
// once and kept while its runs stay the same: its veil and blur are the dear part. An agent between looks is painted
// again every frame into this frame's strip of layers. Cheap content (a cell at rest, the open agent) is drawn on the
// glass itself by the overview: the P4 copies a big layer out of PSRAM about as slowly as it rasterises it.
#include <string.h>

#include "max_ui_draw.h"
#include "pod/pod_draw.h"   // POD_GRAD: a glow
#include "pod/pod_mem.h"    // EXT_RAM_BSS_ATTR: the layers are PSRAM's on the device

enum {
    BLUR_R = 5,                    // the widest kernel's reach each way (sigma 2 px: 1.2 logical px is 1.8 down at 480)
    KEPT = 8,                      // slivers kept: as many as lie on the glass with the open agent dragged half off
    KEPT_RUNS = 48,                // the runs a kept sliver's key holds (its ground and its pet); more paints it fresh
    STRIP_W = ROW_W + 2 * BLUR_R,  // this frame's fresh layers side by side: their windows tile the row, and its cut
                                   // ends take the blur's reach beyond
};

// The Gaussian kernels by sigma in eighths of a px (0..2 px), each tap's weight of 256 from the middle out.
static const uint16_t KERNEL[17][BLUR_R + 1] = {
    {256, 0, 0, 0, 0, 0},  {256, 0, 0, 0, 0, 0},  {256, 0, 0, 0, 0, 0},   {242, 7, 0, 0, 0, 0},
    {202, 27, 0, 0, 0, 0}, {164, 45, 1, 0, 0, 0}, {136, 56, 4, 0, 0, 0},  {116, 61, 9, 0, 0, 0},
    {102, 62, 14, 1, 0, 0}, {90, 61, 19, 3, 0, 0}, {82, 59, 23, 5, 0, 0}, {74, 57, 26, 7, 1, 0},
    {68, 55, 28, 9, 2, 0}, {64, 52, 29, 11, 3, 1}, {60, 50, 30, 13, 4, 1}, {54, 47, 31, 15, 6, 2},
    {52, 45, 31, 17, 7, 2},
};

typedef struct {
    ht_run_t runs[KEPT_RUNS];   // what it painted: the same runs again are the same pixels
    uint8_t count;
    bool full;
    uint32_t used, revision;    // the frame it was last shown in; its pixels' version, for the damage
} kept_t;

static EXT_RAM_BSS_ATTR ht_scene_t s_sub;
static EXT_RAM_BSS_ATTR uint16_t s_strip[STRIP_W * HT_HEIGHT];
static EXT_RAM_BSS_ATTR kept_t s_kept[KEPT];
static EXT_RAM_BSS_ATTR uint16_t s_kept_px[KEPT][SLIVER_W * HT_HEIGHT];
static EXT_RAM_BSS_ATTR uint16_t s_ring[BLUR_R][STRIP_W];   // the rows above the one the vertical pass writes
static EXT_RAM_BSS_ATTR uint16_t s_line[STRIP_W + 2 * BLUR_R];
static EXT_RAM_BSS_ATTR uint32_t s_rb[STRIP_W + 2 * BLUR_R], s_g[STRIP_W + 2 * BLUR_R];   // a row's, one tap each
static EXT_RAM_BSS_ATTR uint32_t s_ar[STRIP_W], s_ag[STRIP_W];                            // its sums so far
static int s_strip_used;            // px of the strip this frame's layers took
static uint32_t s_frame = 1, s_painted;

static int imin(int a, int b) { return a < b ? a : b; }
static int imax(int a, int b) { return a > b ? a : b; }

void max_layer_frame(void)
{
    s_frame++;
    s_strip_used = 0;
}
unsigned max_layer_painted(void) { return s_painted; }

// ---- colours ----

// RGB565 as two sums a weight of 256 cannot overrun: red at bit 16 and blue at 0, green where it is.
static inline uint32_t rb_of(uint16_t c) { return (uint32_t)(c & 0xF800) << 5 | (c & 0x1F); }
static inline uint32_t g_of(uint16_t c) { return c & 0x07E0; }
static inline uint16_t pack(uint32_t rb, uint32_t g)
{
    const uint32_t v = (rb + 0x00800080u) >> 8;
    return (uint16_t)((v >> 16 & 31) << 11 | (((g >> 5) + 128) >> 8 & 63) << 5 | (v & 31));
}

// V3's dimMatrix(t) in 4096ths: brightness b, saturate s (the Filter Effects matrix), the opacity o over black.
typedef struct { int32_t m[9]; } dim_t;
static dim_t dim_of(int t)
{
    const int32_t b = MAX_ONE - 1556 * t / MAX_ONE, s = MAX_ONE - 1843 * t / MAX_ONE, k = b * b / MAX_ONE;   // o = b
    const int32_t lr = 872, lg = 2929, lb = 295;   // .213, .715, .072
    const int32_t m[9] = {lr + (MAX_ONE - lr) * s / MAX_ONE, lg - lg * s / MAX_ONE, lb - lb * s / MAX_ONE,
                          lr - lr * s / MAX_ONE, lg + (MAX_ONE - lg) * s / MAX_ONE, lb - lb * s / MAX_ONE,
                          lr - lr * s / MAX_ONE, lg - lg * s / MAX_ONE, lb + (MAX_ONE - lb) * s / MAX_ONE};
    dim_t d;
    for (int i = 0; i < 9; i++) d.m[i] = m[i] * k / MAX_ONE;
    return d;
}
// A 4 x 4 Bayer matrix: where a pixel rounds between two levels, so a dark glow dimmed and blurred into RGB565 keeps
// no bands (the glow is drawn dithered for the same reason).
static const uint8_t BAYER[4][4] = {{0, 8, 2, 10}, {12, 4, 14, 6}, {3, 11, 1, 9}, {15, 7, 13, 5}};

// A pixel from its sums (weights of 256 in all), dimmed, in 8 bits a channel.
typedef struct { int32_t r, g, b; } rgb_t;
static inline rgb_t dimmed(const dim_t *d, uint32_t rb, uint32_t g)
{
    const int32_t r = (int32_t)((rb >> 16) * 33 >> 10), b = (int32_t)((rb & 0xFFFF) * 33 >> 10);   // 255/31 is 8.25
    const int32_t gr = (int32_t)((g >> 5) * 259 >> 14);                                             // 255/63 is 4.05
    return (rgb_t){(d->m[0] * r + d->m[1] * gr + d->m[2] * b + 2048) >> 12,
                   (d->m[3] * r + d->m[4] * gr + d->m[5] * b + 2048) >> 12,
                   (d->m[6] * r + d->m[7] * gr + d->m[8] * b + 2048) >> 12};
}
// Back to RGB565 by the dither at (x, y).
static inline uint16_t dither(rgb_t c, int x, int y)
{
    const int32_t t = BAYER[y & 3][x & 3];
    return (uint16_t)(imin(31, (c.r * 249 + t * 128 + 64) >> 11) << 11 |
                      imin(63, (c.g * 253 + t * 64 + 32) >> 10) << 5 | imin(31, (c.b * 249 + t * 128 + 64) >> 11));
}

// ---- where the blur changes anything ----
//
// The blur keeps what is flat across and a straight ramp down: a layer's ground and its glow. So each pass is worked
// out only within its reach of an edge across it: down, of a mark's top and bottom and the glass's (transparent past
// them); across, of a mark's sides, the ground's and the glow's and the layer's own (transparent past them).
// Everywhere else dimming alone is the filter. Words and chips are left sharp: they are only on a layer while they
// fade out (or in) over 200 ms, and they are most of what the blur would otherwise cost. Kept per row in groups of 8
// columns.

enum { GROUP = 8, WORDS = ((STRIP_W + GROUP - 1) / GROUP + 31) / 32, DOWN = 1, ACROSS = 2 };
static EXT_RAM_BSS_ATTR uint32_t s_down[HT_HEIGHT][WORDS], s_across[HT_HEIGHT][WORDS];

static void busy_add(int x0, int x1, int y0, int y1, int w, int passes)
{
    x0 = imax(0, x0), x1 = imin(w, x1), y0 = imax(0, y0), y1 = imin(HT_HEIGHT, y1);
    if (x1 <= x0 || y1 <= y0) return;
    uint32_t m[WORDS] = {0};
    for (int g = x0 / GROUP; g <= (x1 - 1) / GROUP; g++) m[g >> 5] |= 1u << (g & 31);
    for (int y = y0; y < y1; y++)
        for (int i = 0; i < WORDS; i++) {
            if (passes & DOWN) s_down[y][i] |= m[i];
            if (passes & ACROSS) s_across[y][i] |= m[i];
        }
}

// The edges of the layer's runs in s_sub over [x0, x0 + w). Returns the row past anything painted but a one-px line the
// glass's height (and the blur's reach below it): past it the layer is the black ground but for the line.
static int busy_of(int x0, int w)
{
    memset(s_down, 0, sizeof s_down);
    memset(s_across, 0, sizeof s_across);
    int bottom = s_sub.background ? HT_HEIGHT : 0;
    for (int i = 0; i < s_sub.count; i++) {
        const ht_run_t *r = &s_sub.runs[i];
        const ht_rect_t b = ht_run_bounds(r);
        const int l = b.x - x0, e = l + b.w;
        if (e <= 0 || l >= w) continue;
        const int kind = r->pro_kind;   // PRO_TEXT 1, PRO_RECT 2, PRO_RECT_AA 4, PRO_RECT_AA_STROKE 5
        const bool tall = kind == 2 && b.h >= HT_HEIGHT;   // the line or a ground: no top or bottom on the glass
        if (!(tall && b.w == 1)) bottom = imax(bottom, b.y + b.h);
        if (kind == 1 || kind == 4 || kind == 5) continue;
        if (kind == POD_GRAD || tall) {   // a glow (it ends in the ground's colour), a ground, the line: their sides
            busy_add(l - BLUR_R, l + BLUR_R, b.y, b.y + b.h, w, ACROSS);
            busy_add(e - BLUR_R, e + BLUR_R, b.y, b.y + b.h, w, ACROSS);
        } else {
            busy_add(l - BLUR_R, e + BLUR_R, b.y - BLUR_R, b.y + b.h + BLUR_R, w, DOWN | ACROSS);
        }
    }
    bottom = imin(HT_HEIGHT, bottom + BLUR_R);
    busy_add(0, BLUR_R, 0, bottom, w, ACROSS);
    busy_add(w - BLUR_R, w, 0, bottom, w, ACROSS);
    busy_add(0, w, 0, BLUR_R, w, DOWN);
    if (bottom == HT_HEIGHT) busy_add(0, w, HT_HEIGHT - BLUR_R, HT_HEIGHT, w, DOWN);
    return bottom;
}

// ---- dimming and blurring ----

// A row's busy columns as runs [x0, x1).
typedef struct { int16_t x0, x1; } span_t;
enum { SPANS = WORDS * 16 };
static int spans_of(const uint32_t *m, int w, span_t *out)
{
    const int groups = (w + GROUP - 1) / GROUP;
    int n = 0;
    for (int g = 0; g < groups;) {
        const uint32_t set = m[g >> 5] >> (g & 31);
        if (!set) {
            g = (g | 31) + 1;
            continue;
        }
        g += __builtin_ctz(set);
        if (g >= groups) break;
        const int g0 = g;
        while (g < groups) {   // to its first clear group: the bits shifted in above the word's are not clear ones
            const uint32_t clear = ~m[g >> 5] >> (g & 31);
            if (clear) {
                g += __builtin_ctz(clear);
                break;
            }
            g = (g | 31) + 1;
        }
        out[n++] = (span_t){(int16_t)(g0 * GROUP), (int16_t)imin(w, imin(g, groups) * GROUP)};
    }
    return n;
}

// The w-wide layer blurred down where busy (rows past the glass are transparent), in place: before a row is written,
// what the rows below it read of it is kept in the ring.
static void down(uint16_t *px, int w, const uint16_t *k)
{
    span_t sp[SPANS], keep[SPANS];
    for (int y = 0; y < HT_HEIGHT; y++) {
        uint32_t read[WORDS] = {0};
        for (int t = 1; t <= BLUR_R && y + t < HT_HEIGHT; t++)
            for (int i = 0; i < WORDS; i++) read[i] |= s_down[y + t][i];
        const int n = spans_of(s_down[y], w, sp), kn = spans_of(read, w, keep);
        if (!n && !kn) continue;
        uint16_t *row = px + (size_t)y * w;
        for (int i = 0; i < n; i++) {
            memset(&s_rb[sp[i].x0], 0, (size_t)(sp[i].x1 - sp[i].x0) * sizeof s_rb[0]);
            memset(&s_g[sp[i].x0], 0, (size_t)(sp[i].x1 - sp[i].x0) * sizeof s_g[0]);
        }
        for (int t = -BLUR_R; t <= BLUR_R && n; t++) {
            const uint32_t wt = k[t < 0 ? -t : t];
            const int yy = y + t;
            if (!wt || yy < 0 || yy >= HT_HEIGHT) continue;
            const uint16_t *src = yy < y ? s_ring[yy % BLUR_R] : px + (size_t)yy * w;
            for (int i = 0; i < n; i++)
                for (int x = sp[i].x0; x < sp[i].x1; x++) {
                    s_rb[x] += wt * rb_of(src[x]);
                    s_g[x] += wt * g_of(src[x]);
                }
        }
        for (int i = 0; i < kn; i++) {
            const int x0 = keep[i].x0;
            memcpy(&s_ring[y % BLUR_R][x0], &row[x0], (size_t)(keep[i].x1 - x0) * sizeof row[0]);
        }
        for (int i = 0; i < n; i++)
            for (int x = sp[i].x0; x < sp[i].x1; x++) row[x] = pack(s_rb[x], s_g[x]);
    }
}

// The colours dimmed last, by a hash of the RGB565 (0, black, is never kept: it stays black): a glow's rows are few
// colours dithered pixel by pixel.
enum { MEMO = 64 };
static uint16_t s_memo_of[MEMO];
static rgb_t s_memo[MEMO];

// Each row of a w-wide layer blurred across where busy (taps past its sides are transparent) and dimmed, from its left
// at ox in its agent's columns, where the dither is laid. Rows from `bottom` on are only their busy columns.
static void across(uint16_t *px, int w, int ox, int bottom, const uint16_t *k, const dim_t *d)
{
    span_t sp[SPANS];
    int taps = 1;
    while (taps <= BLUR_R && k[taps]) taps++;
    for (int y = 0; y < HT_HEIGHT; y++) {
        const int n = spans_of(s_across[y], w, sp);
        if (y >= bottom && !n) continue;
        uint16_t *row = px + (size_t)y * w;
        memset(s_line, 0, BLUR_R * sizeof s_line[0]);
        memcpy(s_line + BLUR_R, row, (size_t)w * sizeof row[0]);
        memset(s_line + BLUR_R + w, 0, BLUR_R * sizeof s_line[0]);
        for (int i = 0, x = 0; i <= n && y < bottom; i++) {   // between the spans the blur keeps it: dimmed alone
            for (const int x1 = i < n ? sp[i].x0 : w; x < x1; x++) {
                const uint16_t c = s_line[BLUR_R + x];
                if (!c) {
                    row[x] = 0;
                    continue;
                }
                const unsigned h = (c ^ c >> 5 ^ c >> 11) & (MEMO - 1);
                if (s_memo_of[h] != c) s_memo_of[h] = c, s_memo[h] = dimmed(d, rb_of(c) << 8, g_of(c) << 8);
                row[x] = dither(s_memo[h], ox + x, y);
            }
            if (i < n) x = sp[i].x1;
        }
        for (int i = 0; i < n; i++) {
            const int x0 = sp[i].x0, x1 = sp[i].x1;
            for (int x = x0 - BLUR_R; x < x1 + BLUR_R; x++) {   // the line's own sums, from -BLUR_R
                s_rb[x + BLUR_R] = rb_of(s_line[BLUR_R + x]);
                s_g[x + BLUR_R] = g_of(s_line[BLUR_R + x]);
            }
            for (int x = x0; x < x1; x++) {
                s_ar[x] = k[0] * s_rb[x + BLUR_R];
                s_ag[x] = k[0] * s_g[x + BLUR_R];
            }
            for (int t = 1; t < taps; t++)
                for (int x = x0; x < x1; x++) {
                    s_ar[x] += k[t] * (s_rb[x + BLUR_R - t] + s_rb[x + BLUR_R + t]);
                    s_ag[x] += k[t] * (s_g[x + BLUR_R - t] + s_g[x + BLUR_R + t]);
                }
            for (int x = x0; x < x1; x++)
                row[x] = s_ar[x] || s_ag[x] ? dither(dimmed(d, s_ar[x], s_ag[x]), ox + x, y) : 0;
        }
    }
}

// The layer px (w wide, the glass's x0 at its left, ox in its agent's columns) dimmed `t` of the way and blurred 1.2 t
// logical px (1.2 * 1.297 t px across, 1.2 * 1.5 t px down at 480), as one filter.
static void dim_blur(uint16_t *px, int x0, int ox, int w, int t)
{
    const dim_t d = dim_of(t);
    memset(s_memo_of, 0, sizeof s_memo_of);
    const int kx = (t * 1245 / 100 + MAX_ONE / 2) / MAX_ONE, ky = (t * 144 * HT_HEIGHT / 4800 + MAX_ONE / 2) / MAX_ONE;
    const int bottom = busy_of(x0, w);
    if (KERNEL[ky][0] != 256) down(px, w, KERNEL[ky]);
    across(px, w, ox, bottom, KERNEL[kx], &d);
}

// ---- showing them ----

// The glass's [l, r) from a layer stride px wide whose column 0 lies at the glass's x0.
static void show(ht_scene_t *s, int l, int r, const uint16_t *px, int stride, int x0, uint32_t revision)
{
    const ht_pro_bitmap_t b = {px + (l - x0), NULL, (uint16_t)stride, HT_HEIGHT, revision, NULL};
    if (ht_pro_image(s, l, 0, &b)) s->runs[s->count - 1].w = (int16_t)(r - l);
}

static void paint_sub(int x, max_paint_t paint, const void *arg)
{
    ht_scene_clear(&s_sub, ht_rgb(GROUND));
    paint(&s_sub, x, arg);
}

void max_layer_fresh(ht_scene_t *s, int x, int w, int l, int r, int dim, max_paint_t paint, const void *arg)
{
    // The window, and where the row cuts the agent, the blur's reach of it beyond.
    const int reach = dim ? BLUR_R : 0;
    const int x0 = l > x ? imax(x, l - reach) : l, x1 = r < x + w ? imin(x + w, r + reach) : r;
    const int lw = x1 - x0;
    if (lw <= 0 || s_strip_used + lw > STRIP_W) return;
    uint16_t *px = s_strip + (size_t)s_strip_used * HT_HEIGHT;
    s_strip_used += lw;
    paint_sub(x, paint, arg);
    ht_raster(&s_sub, (ht_rect_t){(int16_t)x0, 0, (int16_t)lw, HT_HEIGHT}, px);
    if (dim) dim_blur(px, x0, x0 - x, lw, dim);
    s_painted++;
    show(s, l, r, px, lw, x0, s_frame);
}

void max_layer_kept(ht_scene_t *s, int x, int l, int r, max_paint_t paint, const void *arg)
{
    paint_sub(0, paint, arg);
    if (s_sub.count > KEPT_RUNS) {
        max_layer_fresh(s, x, SLIVER_W, l, r, MAX_ONE, paint, arg);
        return;
    }
    kept_t *k = NULL, *spare = NULL;
    for (int i = 0; i < KEPT && !k; i++) {
        kept_t *c = &s_kept[i];
        if (c->full && c->count == s_sub.count && !memcmp(c->runs, s_sub.runs, (size_t)c->count * sizeof c->runs[0]))
            k = c;
        else if (c->used != s_frame && (!spare || c->used < spare->used))   // the longest unseen, never this frame's
            spare = c;
    }
    if (!k) {
        if (!spare) {
            max_layer_fresh(s, x, SLIVER_W, l, r, MAX_ONE, paint, arg);
            return;
        }
        k = spare;
        uint16_t *px = s_kept_px[k - s_kept];
        ht_raster(&s_sub, (ht_rect_t){0, 0, SLIVER_W, HT_HEIGHT}, px);
        dim_blur(px, 0, 0, SLIVER_W, MAX_ONE);
        memcpy(k->runs, s_sub.runs, (size_t)s_sub.count * sizeof s_sub.runs[0]);
        k->count = s_sub.count;
        k->full = true;
        k->revision++;
        s_painted++;
    }
    k->used = s_frame;
    show(s, l, r, s_kept_px[k - s_kept], SLIVER_W, x, k->revision);
}
