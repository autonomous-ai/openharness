// What App Detail's row works out by the pixel (max_ui_draw.h). A settled sliver is rasterised on its own (ht_raster of
// its runs alone), dimmed and blurred as V3's _Dim does it (dimMatrix and a 1.2 px Gaussian blur, transparent past the
// cell; the blur only where it changes anything, and not over words: see "where the blur changes anything"), and kept
// while its runs stay the same: a sliver moves without changing. An agent between looks is drawn on the glass itself,
// every frame, about as cheaply as a cell: its colours dimmed as they are drawn (max_dim), and only what the blur
// visibly changes worked out by the pixel, in small images: its pet (with its alpha, which is also how a pet fades in
// or out over what lies under it) and its rail. Its runs are cut to its window as its own layer would be, a run cut at
// its left end shown there as a small image of what the agent draws. The P4 copies a big layer out of PSRAM about as
// slowly as it rasterises it: these images stay small.
#include <stdatomic.h>
#include <string.h>

#include "max_ui.h"
#include "max_ui_draw.h"
#include "pod/pod_draw.h"   // POD_GRAD: a glow; POD_CELL: a pet's frame
#include "pod/pod_mem.h"    // EXT_RAM_BSS_ATTR: the layers are PSRAM's on the device

enum {
    BLUR_R = 5,            // the widest kernel's reach each way (sigma 2 px: 1.2 logical px is 1.8 down at 480)
    KEPT = 8,              // slivers kept: as many as lie on the glass with the open agent dragged half off
    KEPT_RUNS = 48,        // the runs a kept sliver's key holds (its ground and its pet); more draws it on the glass
    LAYER_W = SLIVER_W,    // a kept layer's width
    PETS = 160,            // pets' images kept: an open's or a close's every step, for the agents it moves (five
                           // that all look different take 74; fewer, each step's image evicts one the next run needs),
                           // and what max_ui_warm paints ahead: Overview's every open takes about 110
    PET_RUNS = 40,         // the runs a pet scene takes at most (terminal.h)
    PET_PX = 256 * 256,    // the largest pet the row draws (the open agent's) and the blur's reach around it
    POOL_PX = 2560 * 1024, // the pets' images' pixels: a close's take over a million, Overview's every open ahead 2.1
                           // million (7.5 MB of PSRAM with alpha)
    DIM_STEP = MAX_ONE / 16,   // a pet's dim's steps: half of one is under a level of RGB565 (its brightness 1.2 %)
    PATCH_PX = 96 * 1024,  // a frame's cut ends and blurred rails
    LINE_W = ROW_W + 4 * BLUR_R,   // the widest row a blur reads: a rail across the row and its reach past both ends
    EDGE_PX = LINE_W * (RAIL_H + 3 * BLUR_R),   // the most an edge reads: that rail, its reach above and below
    EDGES_PX = 4 * EDGE_PX,   // a frame's edges as drawn: four agents' rails across the row and their sides
    JOBS = 64,             // a frame's blurs: its moving agents' pets and edges
    WORKERS = 2,           // the frame path's tasks that share them
    // The Pro's run kinds (pro_canvas.c).
    RUN_TEXT = 1, RUN_RECT = 2, RUN_IMAGE = 3, RUN_RECT_AA = 4, RUN_RECT_AA_STROKE = 5,
};

// The Gaussian kernels by sigma in eighths of a px (0..2 px), each tap's weight of 256 from the middle out.
static const uint16_t KERNEL[17][BLUR_R + 1] = {
    {256, 0, 0, 0, 0, 0},  {256, 0, 0, 0, 0, 0},  {256, 0, 0, 0, 0, 0},   {242, 7, 0, 0, 0, 0},
    {202, 27, 0, 0, 0, 0}, {164, 45, 1, 0, 0, 0}, {136, 56, 4, 0, 0, 0},  {116, 61, 9, 0, 0, 0},
    {102, 62, 14, 1, 0, 0}, {90, 61, 19, 3, 0, 0}, {82, 59, 23, 5, 0, 0}, {74, 57, 26, 7, 1, 0},
    {68, 55, 28, 9, 2, 0}, {64, 52, 29, 11, 3, 1}, {60, 50, 30, 13, 4, 1}, {54, 47, 31, 15, 6, 2},
    {52, 45, 31, 17, 7, 2},
};
// A sliver's kernels `t` of the way: 1.2 t logical px, 1.2 * 1.297 t px across and 1.2 * 1.5 t px down at 480.
static const uint16_t *kernel_x(int t) { return KERNEL[(t * 1245 / 100 + MAX_ONE / 2) / MAX_ONE]; }
static const uint16_t *kernel_y(int t) { return KERNEL[(t * 144 * HT_HEIGHT / 4800 + MAX_ONE / 2) / MAX_ONE]; }
static bool blurs(const uint16_t *k) { return k[0] != 256; }

typedef struct {
    ht_run_t runs[KEPT_RUNS];   // what it painted: the same runs again are the same pixels
    uint8_t count;
    bool full;
    uint32_t used, revision;    // the frame it was last shown in; its pixels' version, for the damage
} kept_t;

// A pet as an image. Its runs are kept from its box's corner where moving them moves nothing else (a moving pet is
// the same pixels elsewhere); a run that cannot be moved so (an arc's centre is in its packed parameters) pins it.
// Its pixels are the pool's from `at`. Undimmed (dim 0) it is also what its dims are made from: as rasterised on its
// ground, the ground transparent.
typedef struct {
    ht_run_t runs[PET_RUNS];
    uint8_t count;
    bool full, pinned;
    uint16_t ground;
    int16_t dim, x, y, w, h;
    int32_t at;
    uint32_t used, revision;
} pet_t;

static EXT_RAM_BSS_ATTR ht_scene_t s_sub, s_one;
static EXT_RAM_BSS_ATTR kept_t s_kept[KEPT];
static EXT_RAM_BSS_ATTR uint16_t s_kept_px[KEPT][LAYER_W * HT_HEIGHT];
static EXT_RAM_BSS_ATTR pet_t s_pets[PETS], s_key, s_bare;   // a pet's key, undimmed
static EXT_RAM_BSS_ATTR uint16_t s_pool_px[POOL_PX];
static EXT_RAM_BSS_ATTR uint8_t s_pool_a[POOL_PX];
static EXT_RAM_BSS_ATTR uint16_t s_patch[PATCH_PX];
static EXT_RAM_BSS_ATTR uint16_t s_edges[EDGES_PX];   // the frame's edges as drawn, before their blur
static EXT_RAM_BSS_ATTR uint16_t s_edge[EDGE_PX];     // one when they have no room
static EXT_RAM_BSS_ATTR ht_run_t s_cut[HT_RUNS];
static EXT_RAM_BSS_ATTR uint16_t s_ring[BLUR_R][LAYER_W];   // the rows above the one the vertical pass writes
static EXT_RAM_BSS_ATTR uint16_t s_line[LINE_W + 2 * BLUR_R];
static EXT_RAM_BSS_ATTR uint32_t s_rb[LINE_W + 2 * BLUR_R], s_g[LINE_W + 2 * BLUR_R];
static EXT_RAM_BSS_ATTR uint32_t s_ar[LINE_W], s_ag[LINE_W];   // a row's sums so far
static int s_patch_used, s_edges_used;   // px of s_patch and s_edges this frame took
static int s_pool_next;    // where the pool's next image goes
static uint32_t s_frame = 1, s_painted, s_revision;
static uint32_t s_warm;    // warming (max_layer_warm): what was used from this frame on stays
static unsigned s_step;    // s_painted when the warming step began: it paints one
static bool s_full, s_more;   // the step found no room; it left a paint to the next

static int imin(int a, int b) { return a < b ? a : b; }
static int imax(int a, int b) { return a > b ? a : b; }

static void jobs_frame(void);
static void owed_drop(void);
static bool owed_any(void);

void max_layer_frame(void)
{
    jobs_frame();
    s_frame++;
    s_patch_used = s_edges_used = 0;
}
unsigned max_layer_painted(void) { return s_painted; }
uint32_t max_layer_now(void) { return s_frame; }
max_warm_t max_layer_warm(uint32_t from)
{
    const max_warm_t met = s_full ? MAX_WARM_FULL : s_more ? MAX_WARM_MORE : MAX_WARM_DONE;
    s_warm = from;
    s_step = s_painted;
    s_full = s_more = false;
    return met;
}
// An image or a layer last used in `used` stays: this frame shows it, or warming keeps it.
static bool held(uint32_t used) { return used == s_frame || (s_warm && (int32_t)(used - s_warm) >= 0); }
// Whether this frame may paint an image or a layer: a warming step's first, the rest left to the next.
static bool may_paint(void)
{
    if (!s_warm || (!owed_any() && s_painted == s_step)) return true;
    s_more = true;
    return false;
}
void max_layer_forget(void)
{
    for (int i = 0; i < KEPT; i++) s_kept[i].full = false;
    for (int i = 0; i < PETS; i++) s_pets[i].full = false;
    memset(s_pool_px, 0xA5, sizeof s_pool_px);
    memset(s_pool_a, 0xA5, sizeof s_pool_a);
    owed_drop();
}

// ---- colours ----

// RGB565 as two sums a weight of 256 cannot overrun: red at bit 16 and blue at 0, green where it is.
static inline uint32_t rb_of(uint16_t c) { return (uint32_t)(c & 0xF800) << 5 | (c & 0x1F); }
static inline uint32_t g_of(uint16_t c) { return c & 0x07E0; }
static inline uint16_t pack(uint32_t rb, uint32_t g)
{
    const uint32_t v = (rb + 0x00800080u) >> 8;
    return (uint16_t)((v >> 16 & 31) << 11 | (((g >> 5) + 128) >> 8 & 63) << 5 | (v & 31));
}

// V3's dimMatrix(t): brightness b, saturate s (the Filter Effects matrix), the opacity o over black.
max_dim_t max_dim_of(int t)
{
    const int32_t b = MAX_ONE - 1556 * t / MAX_ONE, s = MAX_ONE - 1843 * t / MAX_ONE, k = b * b / MAX_ONE;   // o = b
    const int32_t lr = 872, lg = 2929, lb = 295;   // .213, .715, .072
    const int32_t m[9] = {lr + (MAX_ONE - lr) * s / MAX_ONE, lg - lg * s / MAX_ONE, lb - lb * s / MAX_ONE,
                          lr - lr * s / MAX_ONE, lg + (MAX_ONE - lg) * s / MAX_ONE, lb - lb * s / MAX_ONE,
                          lr - lr * s / MAX_ONE, lg - lg * s / MAX_ONE, lb + (MAX_ONE - lb) * s / MAX_ONE};
    max_dim_t d;
    for (int i = 0; i < 9; i++) d.m[i] = m[i] * k / MAX_ONE;
    return d;
}
unsigned max_dim_rgb(const max_dim_t *d, unsigned rgb)
{
    const int32_t c[3] = {(int32_t)(rgb >> 16 & 255), (int32_t)(rgb >> 8 & 255), (int32_t)(rgb & 255)};
    unsigned out = 0;
    for (int i = 0; i < 3; i++) {
        const int32_t v = (d->m[3 * i] * c[0] + d->m[3 * i + 1] * c[1] + d->m[3 * i + 2] * c[2] + 2048) >> 12;
        out = out << 8 | (unsigned)(v < 0 ? 0 : v > 255 ? 255 : v);
    }
    return out;
}
// A 4 x 4 Bayer matrix: where a pixel rounds between two levels, so a dark glow dimmed and blurred into RGB565 keeps
// no bands (the glow is drawn dithered for the same reason).
static const uint8_t BAYER[4][4] = {{0, 8, 2, 10}, {12, 4, 14, 6}, {3, 11, 1, 9}, {15, 7, 13, 5}};

// A pixel from its sums (weights of 256 in all), dimmed, in 8 bits a channel.
typedef struct { int32_t r, g, b; } rgb_t;
static inline rgb_t dimmed(const max_dim_t *d, uint32_t rb, uint32_t g)
{
    const int32_t r = (int32_t)((rb >> 16) * 33 >> 10), b = (int32_t)((rb & 0xFFFF) * 33 >> 10);   // 255/31 is 8.25
    const int32_t gr = (int32_t)((g >> 5) * 259 >> 14);                                             // 255/63 is 4.05
    if (!d) return (rgb_t){r, gr, b};   // as it is
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

// The colours dimmed last, by a hash of the RGB565 (0, black, is never kept: it stays black): a glow's rows are few
// colours dithered pixel by pixel, a pet's are its palette's.
enum { MEMO = 64 };
static uint16_t s_memo_of[MEMO];
static rgb_t s_memo[MEMO];
static inline uint16_t dim_px(const max_dim_t *d, uint16_t c, int x, int y)
{
    if (!c) return 0;
    const unsigned h = (c ^ c >> 5 ^ c >> 11) & (MEMO - 1);
    if (s_memo_of[h] != c) s_memo_of[h] = c, s_memo[h] = dimmed(d, rb_of(c) << 8, g_of(c) << 8);
    return dither(s_memo[h], x, y);
}

// ---- where the blur changes anything ----
//
// The blur keeps what is flat across and a straight ramp down: a layer's ground and its glow. So each pass is worked
// out only within its reach of an edge across it: down, of a mark's top and bottom and the glass's (transparent past
// them); across, of a mark's sides, the ground's and the glow's and the layer's own (transparent past them).
// Everywhere else dimming alone is the filter. Words and chips are left sharp: they are only on a layer while they
// fade out (or in) over 200 ms, and they are most of what the blur would otherwise cost. Kept per row in groups of 8
// columns.

enum { GROUP = 8, WORDS = ((LAYER_W + GROUP - 1) / GROUP + 31) / 32, DOWN = 1, ACROSS = 2 };
typedef struct { uint32_t down[HT_HEIGHT][WORDS], across[HT_HEIGHT][WORDS]; } busy_t;
static EXT_RAM_BSS_ATTR busy_t s_busy;

static void busy_add(busy_t *bz, int x0, int x1, int y0, int y1, int w, int passes)
{
    x0 = imax(0, x0), x1 = imin(w, x1), y0 = imax(0, y0), y1 = imin(HT_HEIGHT, y1);
    if (x1 <= x0 || y1 <= y0) return;
    uint32_t m[WORDS] = {0};
    for (int g = x0 / GROUP; g <= (x1 - 1) / GROUP; g++) m[g >> 5] |= 1u << (g & 31);
    for (int y = y0; y < y1; y++)
        for (int i = 0; i < WORDS; i++) {
            if (passes & DOWN) bz->down[y][i] |= m[i];
            if (passes & ACROSS) bz->across[y][i] |= m[i];
        }
}

// The edges of the layer's runs in sub over [0, w), into bz. Returns the row past anything painted but a one-px line
// the glass's height (and the blur's reach below it): past it the layer is the black ground but for the line.
static int busy_of(busy_t *bz, const ht_scene_t *sub, int w)
{
    memset(bz, 0, sizeof *bz);
    int bottom = sub->background ? HT_HEIGHT : 0;
    for (int i = 0; i < sub->count; i++) {
        const ht_run_t *r = &sub->runs[i];
        const ht_rect_t b = ht_run_bounds(r);
        const int l = b.x, e = l + b.w;
        if (e <= 0 || l >= w) continue;
        const int kind = r->pro_kind;
        const bool tall = kind == RUN_RECT && b.h >= HT_HEIGHT;   // the line or a ground: no top or bottom on the glass
        if (!(tall && b.w == 1)) bottom = imax(bottom, b.y + b.h);
        if (kind == RUN_TEXT || kind == RUN_RECT_AA || kind == RUN_RECT_AA_STROKE) continue;
        if (kind == POD_GRAD || tall) {   // a glow (it ends in the ground's colour), a ground, the line: their sides
            busy_add(bz, l - BLUR_R, l + BLUR_R, b.y, b.y + b.h, w, ACROSS);
            busy_add(bz, e - BLUR_R, e + BLUR_R, b.y, b.y + b.h, w, ACROSS);
        } else {
            busy_add(bz, l - BLUR_R, e + BLUR_R, b.y - BLUR_R, b.y + b.h + BLUR_R, w, DOWN | ACROSS);
        }
    }
    bottom = imin(HT_HEIGHT, bottom + BLUR_R);
    busy_add(bz, 0, BLUR_R, 0, bottom, w, ACROSS);
    busy_add(bz, w - BLUR_R, w, 0, bottom, w, ACROSS);
    busy_add(bz, 0, w, 0, BLUR_R, w, DOWN);
    if (bottom == HT_HEIGHT) busy_add(bz, 0, w, HT_HEIGHT - BLUR_R, HT_HEIGHT, w, DOWN);
    return bottom;
}

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

// Rows [y0, y1) of the w-wide layer blurred down where bz is busy (rows past the glass are transparent), in place:
// before a row is written, what the rows below it read of it is kept in the ring. Rows above y0 done before, with the
// same ring.
static void down(uint16_t *px, int w, const uint16_t *k, const busy_t *bz, uint16_t (*ring)[LAYER_W], int y0, int y1)
{
    span_t sp[SPANS], keep[SPANS];
    for (int y = y0; y < y1; y++) {
        uint32_t read[WORDS] = {0};
        for (int t = 1; t <= BLUR_R && y + t < HT_HEIGHT; t++)
            for (int i = 0; i < WORDS; i++) read[i] |= bz->down[y + t][i];
        const int n = spans_of(bz->down[y], w, sp), kn = spans_of(read, w, keep);
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
            const uint16_t *src = yy < y ? ring[yy % BLUR_R] : px + (size_t)yy * w;
            for (int i = 0; i < n; i++)
                for (int x = sp[i].x0; x < sp[i].x1; x++) {
                    s_rb[x] += wt * rb_of(src[x]);
                    s_g[x] += wt * g_of(src[x]);
                }
        }
        for (int i = 0; i < kn; i++) {
            const int x0 = keep[i].x0;
            memcpy(&ring[y % BLUR_R][x0], &row[x0], (size_t)(keep[i].x1 - x0) * sizeof row[0]);
        }
        for (int i = 0; i < n; i++)
            for (int x = sp[i].x0; x < sp[i].x1; x++) row[x] = pack(s_rb[x], s_g[x]);
    }
}

// Rows [y0, y1) of a w-wide layer blurred across where bz is busy (taps past its sides are transparent) and dimmed.
// Rows from `bottom` on are only their busy columns.
static void across(uint16_t *px, int w, int bottom, const uint16_t *k, const max_dim_t *d, const busy_t *bz, int y0,
                   int y1)
{
    span_t sp[SPANS];
    int taps = 1;
    while (taps <= BLUR_R && k[taps]) taps++;
    for (int y = y0; y < y1; y++) {
        const int n = spans_of(bz->across[y], w, sp);
        if (y >= bottom && !n) continue;
        uint16_t *row = px + (size_t)y * w;
        memset(s_line, 0, BLUR_R * sizeof s_line[0]);
        memcpy(s_line + BLUR_R, row, (size_t)w * sizeof row[0]);
        memset(s_line + BLUR_R + w, 0, BLUR_R * sizeof s_line[0]);
        for (int i = 0, x = 0; i <= n && y < bottom; i++) {   // between the spans the blur keeps it: dimmed alone
            for (const int x1 = i < n ? sp[i].x0 : w; x < x1; x++) row[x] = dim_px(d, s_line[BLUR_R + x], x, y);
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
                row[x] = s_ar[x] || s_ag[x] ? dither(dimmed(d, s_ar[x], s_ag[x]), x, y) : 0;
        }
    }
}

// ---- a small image's blur ----
//
// A pixel as two words of two 16-bit lanes, red and blue, green and alpha: one multiply weighs two channels, and
// weights of 256 in all keep every lane under 65536. Where every pixel a tap reads is the same, the blur keeps it (the
// weights' sum is 256): those are taken as they are, which is most of a sliver's sides and much of a pet.

static inline uint32_t halve(uint32_t sum) { return (sum + 0x00800080u) >> 8 & 0x00FF00FFu; }   // each lane / 256

// What one task's blur works in: the image as lanes and how many rows down from each pixel are the same, how many
// rows above each are each the same as the next, a row blurred down and how many columns left of each are the same,
// and the row's sums across.
typedef struct {
    uint32_t lanes[2][PET_PX];
    uint8_t same[PET_PX];
    uint16_t rows[HT_HEIGHT];
    uint32_t row[2][LINE_W + 2 * BLUR_R];
    uint8_t flat[LINE_W + 2 * BLUR_R];
    uint32_t sum[2][LINE_W];
} work_t;
static EXT_RAM_BSS_ATTR work_t s_work[WORKERS];

// src (sw x sh: premultiplied over black when `alpha` is given) blurred down by ky and across by kx, transparent past
// it, then dimmed by d (none: as it is) and dithered at the glass's (gx + x, gy + y): out (rows ow apart) is src's
// [ox, ox + ow) x [oy, oy + oh), and out_a its alpha (out no longer premultiplied) when alpha is given. out may be src.
static void blur(work_t *w, const uint16_t *src, const uint8_t *alpha, int sw, int sh, const uint16_t *kx,
                 const uint16_t *ky, const max_dim_t *d, int ox, int oy, int ow, int oh, uint16_t *out, uint8_t *out_a,
                 int gx, int gy)
{
    uint32_t *const rb = w->lanes[0], *const ga = w->lanes[1];
    uint8_t *const same = w->same, *const flat = w->flat;
    const int ya = imax(0, oy - BLUR_R), yb = imin(sh, oy + oh + BLUR_R);   // the rows the taps read
    for (int i = ya * sw; i < yb * sw; i++) {
        rb[i] = (uint32_t)(src[i] >> 11) << 16 | (src[i] & 31u);
        ga[i] = (uint32_t)(src[i] >> 5 & 63) << 16 | (alpha ? alpha[i] : 255u);
    }
    int ty = 1, tx = 1;   // the taps that weigh anything
    while (ty <= BLUR_R && ky[ty]) ty++;
    while (tx <= BLUR_R && kx[tx]) tx++;
    if (ty > 1) {
        for (int x = 0; x < sw; x++) same[(size_t)(yb - 1) * sw + x] = 1;
        for (int i = (yb - 1) * sw - 1; i >= ya * sw; i--)
            same[i] = rb[i] == rb[i + sw] && ga[i] == ga[i + sw] ? (uint8_t)imin(2 * BLUR_R + 1, same[i + sw] + 1) : 1;
    }
    // A row whose taps read only rows the same as the last row's read: its sums are the last row's (a sliver's sides
    // below its glow, every row the same).
    for (int y = ya, run = 0; y < yb - 1; y++) {
        run = !memcmp(&rb[(size_t)y * sw], &rb[(size_t)(y + 1) * sw], (size_t)sw * sizeof rb[0]) &&
                      !memcmp(&ga[(size_t)y * sw], &ga[(size_t)(y + 1) * sw], (size_t)sw * sizeof ga[0])
                  ? run + 1
                  : 0;
        w->rows[y] = (uint16_t)run;
    }
    uint32_t *const r1 = w->row[0], *const r2 = w->row[1], *const s1 = w->sum[0], *const s2 = w->sum[1];
    for (int y = 0; y < oh; y++) {
        const int cy = oy + y;
        if (y == 0 || cy - ty < ya || cy + ty > yb || w->rows[cy + ty - 2] < 2 * ty - 1) {
            // Down: the row's columns the blur across reads.
            for (int j = 0, x = ox - BLUR_R; j < ow + 2 * BLUR_R; j++, x++) {
                if (x < 0 || x >= sw) {
                    r1[j] = r2[j] = 0;
                    continue;
                }
                const size_t i = (size_t)cy * sw + x;
                if (ty == 1 || (cy >= ty - 1 && same[i - (size_t)(ty - 1) * sw] >= 2 * ty - 1)) {
                    r1[j] = rb[i], r2[j] = ga[i];
                    continue;
                }
                uint32_t v1 = ky[0] * rb[i], v2 = ky[0] * ga[i];
                for (int t = 1; t < ty; t++) {
                    uint32_t u1 = 0, u2 = 0;
                    if (cy - t >= 0) u1 += rb[i - (size_t)t * sw], u2 += ga[i - (size_t)t * sw];
                    if (cy + t < sh) u1 += rb[i + (size_t)t * sw], u2 += ga[i + (size_t)t * sw];
                    v1 += ky[t] * u1, v2 += ky[t] * u2;
                }
                r1[j] = halve(v1), r2[j] = halve(v2);
            }
            if (tx > 1) {
                flat[0] = 1;
                for (int j = 1; j < ow + 2 * BLUR_R; j++)
                    flat[j] = r1[j] == r1[j - 1] && r2[j] == r2[j - 1] ? (uint8_t)imin(2 * BLUR_R + 1, flat[j - 1] + 1)
                                                                       : 1;
            }
            for (int x = 0, j = BLUR_R; x < ow; x++, j++) {   // across
                if (tx == 1 || flat[j + tx - 1] >= 2 * tx - 1) {
                    s1[x] = r1[j] << 8, s2[x] = r2[j] << 8;
                    continue;
                }
                uint32_t v1 = kx[0] * r1[j], v2 = kx[0] * r2[j];
                for (int t = 1; t < tx; t++)
                    v1 += kx[t] * (r1[j - t] + r1[j + t]), v2 += kx[t] * (r2[j - t] + r2[j + t]);
                s1[x] = v1, s2[x] = v2;
            }
        }
        uint16_t *o = out + (size_t)y * ow;
        uint8_t *oa = out_a ? out_a + (size_t)y * ow : NULL;
        for (int x = 0; x < ow; x++) {
            uint32_t r = s1[x] >> 16, b = s1[x] & 0xFFFF, g = s2[x] >> 16;
            if (alpha) {
                const uint32_t a = s2[x] & 0xFFFF;   // of 255 * 256
                if (a < 128) {
                    o[x] = 0, oa[x] = 0;
                    continue;
                }
                oa[x] = (uint8_t)imin(255, (int)((a + 128) >> 8));
                if (a < 255 * 256 - 128) {   // an edge: its colour out of its coverage
                    r = (uint32_t)imin(31 * 256, (int)(r * 65280u / a));
                    b = (uint32_t)imin(31 * 256, (int)(b * 65280u / a));
                    g = (uint32_t)imin(63 * 256, (int)(g * 65280u / a));
                }
            }
            o[x] = dither(dimmed(d, r << 16 | b, g << 5), gx + x, gy + y);
        }
    }
}

// ---- a frame's blurs ----
//
// The blurs a frame's moving agents ask for are its costliest work by the pixel. Off the device each is done as it is
// asked for. On it (max_ui_share) they are kept until the frame path, its two tasks each taking the next nobody has
// before they paint their strips (max_ui_work): out of the model's lock, on both cores, and before the strips that
// read them.

typedef struct {
    const uint16_t *src, *kx, *ky;
    const uint8_t *alpha;
    uint16_t *out;
    uint8_t *out_a;
    max_dim_t d;
    bool dims, done;   // done: ahead of the frame path, for a raster of the build's that reads it
    int16_t sw, sh, ox, oy, ow, oh, gx, gy;
    pet_t *pet;   // the pet whose image it makes (NULL: a patch, this frame's alone)
} job_t;
static EXT_RAM_BSS_ATTR job_t s_jobs[JOBS];
static int s_jobs_count;
static atomic_int s_jobs_next, s_jobs_done;
static bool s_share;

static void job_run(const job_t *j, work_t *w)
{
    blur(w, j->src, j->alpha, j->sw, j->sh, j->kx, j->ky, j->dims ? &j->d : NULL, j->ox, j->oy, j->ow, j->oh, j->out,
         j->out_a, j->gx, j->gy);
}
static void job_ask(const job_t *j)
{
    if (s_share && !s_warm && s_jobs_count < JOBS) s_jobs[s_jobs_count++] = *j;
    else job_run(j, &s_work[0]);   // nobody else is at work while the scene is built
}
// A frame whose blurs were never done (it was built and never shown): the pets they were for are given up.
static void jobs_frame(void)
{
    if (atomic_load(&s_jobs_done) < s_jobs_count)
        for (int i = 0; i < s_jobs_count; i++)
            if (s_jobs[i].pet) s_jobs[i].pet->full = false;
    s_jobs_count = 0;
    atomic_store(&s_jobs_next, 0);
    atomic_store(&s_jobs_done, 0);
}

// What a raster of the build's (a cut end's patch, an edge) reads of this frame's blurs: those of the images among
// runs[0, n) over rect, done now.
static void ready(const ht_run_t *runs, int n, ht_rect_t rect)
{
    for (int i = 0; i < n; i++) {
        const ht_run_t *r = &runs[i];
        const ht_rect_t b = ht_run_bounds(r);
        if (r->pro_kind != RUN_IMAGE || b.x >= rect.x + rect.w || rect.x >= b.x + b.w || b.y >= rect.y + rect.h ||
            rect.y >= b.y + b.h)
            continue;
        for (int k = 0; k < s_jobs_count; k++) {
            job_t *j = &s_jobs[k];
            if (!j->done && r->bitmap.pixels >= j->out && r->bitmap.pixels < j->out + j->ow * j->oh) {
                job_run(j, &s_work[0]);   // nobody else is at work while the scene is built
                j->done = true;
            }
        }
    }
}

void max_ui_share(bool on) { s_share = on; }

void max_ui_work(int worker)
{
    work_t *w = &s_work[worker < 0 || worker >= WORKERS ? 0 : worker];
    for (int i; (i = atomic_fetch_add(&s_jobs_next, 1)) < s_jobs_count;) {
        if (!s_jobs[i].done) job_run(&s_jobs[i], w);
        atomic_fetch_add(&s_jobs_done, 1);
    }
    while (atomic_load(&s_jobs_done) < s_jobs_count) {}   // the other task's last one: as long as one blur at most
}

// ---- pets as images ----

// Whether moving a run moves all it draws: its packed parameters hold no place of the glass.
static bool movable(const ht_run_t *r)
{
    return r->pro_kind == RUN_TEXT || r->pro_kind == RUN_RECT || r->pro_kind == RUN_IMAGE ||
           r->pro_kind == RUN_RECT_AA || r->pro_kind == RUN_RECT_AA_STROKE || r->pro_kind == POD_CELL;
}

// ---- a warming's paint, out of the lock ----
//
// A warming's frame paints nothing itself: the first image or layer it needs is taken (its entry and its room in the
// pool kept from the glass's frames until it is made) and left here, with copies of what it is made from, for
// max_layer_warm_paint to make a band of rows at a time, out of the model's lock: no step of the warming holds the
// render task or the lock for more than a band. The frame is drawn again once it is made.

// A band's pixels, about a ms on the P4: a pet's blur (it reads 2 * BLUR_R rows more a band), or a raster (a pet's
// frame below 1x resampled straight in costs about four times a blur's pixel).
enum { BAND_PX = 1024, RASTER_PX = BAND_PX / 4 };
typedef enum { OWED_NONE, OWED_BARE, OWED_DIM, OWED_KEPT } owed_kind_t;
static EXT_RAM_BSS_ATTR struct {
    owed_kind_t kind;
    pet_t *pet, *src;   // the pet's image being made and (dimmed) the undimmed one it is made from
    kept_t *kept;       // or the layer
    job_t job;          // a dimmed pet's blur
    int y;              // its next row; a layer's are all rasterised first, then blurred from y - HT_HEIGHT
    int bottom;         // a layer's busy_of
    busy_t busy;
    uint16_t ring[BLUR_R][LAYER_W];
    ht_scene_t scene;   // what a bare pet or a layer is rasterised from
} s_owed;

static void owed_drop(void)
{
    s_owed.kind = OWED_NONE;
    s_owed.pet = s_owed.src = NULL;
    s_owed.kept = NULL;
}
// A pet's frame below 1x on one colour (pod_cell_flat) is baked whole by pod_draw.c the first time a raster meets it
// (resampled onto that colour into its arena) and copied from then on where it is not that colour: one band of an
// image would bake all of it, in one go. So a band of a warming's image draws each such frame as that copy instead:
// its rows in the band resampled onto the colour, then put down as an image whole where that is not the colour and
// clear where it is. The same pixels; no bake.
enum { FLATS = 4, FLAT_PX = 2 * BAND_PX };
static EXT_RAM_BSS_ATTR uint16_t s_flat_px[FLATS][FLAT_PX];
static EXT_RAM_BSS_ATTR uint8_t s_flat_a[FLATS][FLAT_PX];
static EXT_RAM_BSS_ATTR ht_scene_t s_flat, s_band;   // a frame alone; the scene with its frames as those copies
static bool flat_in(const ht_run_t *r, ht_rect_t band)
{
    const ht_rect_t b = ht_run_bounds(r);
    return r->pro_kind == POD_CELL && r->text[0] == 1 && b.x < band.x + band.w && band.x < b.x + b.w &&
           b.y < band.y + band.h && band.y < b.y + b.h;
}
static void band_raster(const ht_scene_t *sc, ht_rect_t band, uint16_t *out)
{
    int n = 0, i = 0;
    while (i < sc->count && !flat_in(&sc->runs[i], band)) i++;
    if (i == sc->count) {   // none in it
        ht_raster(sc, band, out);
        return;
    }
    s_band.background = sc->background;
    s_band.count = sc->count;
    memcpy(s_band.runs, sc->runs, (size_t)sc->count * sizeof sc->runs[0]);
    for (; i < sc->count; i++) {
        const ht_run_t *r = &sc->runs[i];
        if (r->pro_kind != POD_CELL || r->text[0] != 1) continue;
        const ht_rect_t b = ht_run_bounds(r);
        const int x0 = imax(b.x, band.x), x1 = imin(b.x + b.w, band.x + band.w);
        const int y0 = imax(b.y, band.y), y1 = imin(b.y + b.h, band.y + band.h);
        if (x1 <= x0 || y1 <= y0) continue;
        const int w = x1 - x0, area = w * (y1 - y0);
        if (n == FLATS || area > FLAT_PX) {   // no room: as the glass draws it, baked
            ht_raster(sc, band, out);
            return;
        }
        uint16_t *px = s_flat_px[n];
        uint8_t *a = s_flat_a[n];
        ht_scene_clear(&s_flat, r->fg);
        s_flat.runs[0] = *r;
        s_flat.runs[0].text[0] = 0;   // the frame resampled as its bake is, onto its colour
        s_flat.count = 1;
        ht_raster(&s_flat, (ht_rect_t){(int16_t)x0, (int16_t)y0, (int16_t)w, (int16_t)(y1 - y0)}, px);
        for (int k = 0; k < area; k++) a[k] = px[k] != r->fg ? 255 : 0;
        ht_scene_clear(&s_flat, 0);
        const ht_pro_bitmap_t bmp = {px, a, (uint16_t)w, (uint16_t)(y1 - y0), s_frame, NULL};
        ht_pro_image(&s_flat, x0, y0, &bmp);
        s_band.runs[i] = s_flat.runs[0];
        n++;
    }
    ht_raster(&s_band, band, out);
}

static bool owed_any(void) { return s_owed.kind != OWED_NONE; }
bool max_layer_owes(void) { return owed_any(); }
// An image or a layer the warming is making, or making one from: neither shown nor given up until it is made.
static bool owed(const void *c) { return c == s_owed.pet || c == s_owed.src || c == s_owed.kept; }

// Room for `area` px in the pool from the next place on, past any image this frame shows; the images there given up.
// -1 when there is none.
static int place(int area)
{
    int at = s_pool_next;
    for (int tries = 0; tries <= PETS + 1; tries++) {
        if (at + area > POOL_PX) at = 0;
        const pet_t *shown = NULL;
        for (int i = 0; i < PETS && !shown; i++) {
            const pet_t *c = &s_pets[i];
            if (c->full && (held(c->used) || owed(c)) && c->at < at + area && at < c->at + c->w * c->h) shown = c;
        }
        if (!shown) {
            for (int i = 0; i < PETS; i++) {
                pet_t *c = &s_pets[i];
                if (c->full && c->at < at + area && at < c->at + c->w * c->h) c->full = false;
            }
            s_pool_next = at + area;
            return at;
        }
        at = shown->at + shown->w * shown->h;
    }
    return -1;
}

static pet_t *find(const pet_t *k)
{
    for (int i = 0; i < PETS; i++) {
        pet_t *c = &s_pets[i];
        if (c->full && c != s_owed.pet && c->count == k->count && c->pinned == k->pinned && c->ground == k->ground && c->dim == k->dim &&
            c->w == k->w && c->h == k->h && (!k->pinned || (c->x == k->x && c->y == k->y)) &&
            !memcmp(c->runs, k->runs, (size_t)k->count * sizeof k->runs[0]))
            return c;
    }
    return NULL;
}
// A place for k's image: the longest unseen entry (never one this frame shows) and room in the pool. NULL: none.
static pet_t *take(const pet_t *k)
{
    pet_t *spare = NULL;
    for (int i = 0; i < PETS; i++) {
        pet_t *c = &s_pets[i];
        if (!c->full) {
            spare = c;
            break;
        }
        if (!held(c->used) && !owed(c) && (!spare || c->used < spare->used)) spare = c;
    }
    const int at = spare ? place(k->w * k->h) : -1;
    if (at < 0) {
        s_full |= s_warm != 0;
        return NULL;
    }
    *spare = *k;
    spare->full = true;
    spare->at = at;
    spare->revision = ++s_revision;
    spare->used = s_frame;
    return spare;
}

// Rows [y0, y1) of p undimmed, from its scene: its runs rasterised on its ground, what is not the ground its alpha
// (premultiplied: 0 where it is not).
static void bare_rows(const pet_t *p, const ht_scene_t *one, int y0, int y1,
                      void (*raster)(const ht_scene_t *, ht_rect_t, uint16_t *))
{
    uint16_t *px = &s_pool_px[p->at];
    uint8_t *a = &s_pool_a[p->at];
    raster(one, (ht_rect_t){p->x, (int16_t)(p->y + y0), p->w, (int16_t)(y1 - y0)}, px + (size_t)y0 * p->w);
    for (int i = y0 * p->w; i < y1 * p->w; i++) {
        const bool on = px[i] != p->ground;
        a[i] = on ? 255 : 0;
        if (!on) px[i] = 0;
    }
}
// k undimmed.
static pet_t *undimmed(const pet_t *k, const ht_run_t *runs)
{
    s_bare = *k;
    s_bare.dim = 0;
    pet_t *p = find(&s_bare);
    if (p) return p;
    if (!may_paint() || !(p = take(&s_bare))) return NULL;
    ht_scene_t *one = s_warm ? &s_owed.scene : &s_one;
    ht_scene_clear(one, p->ground);
    memcpy(one->runs, runs, (size_t)p->count * sizeof runs[0]);
    one->count = p->count;
    // A frame below 1x on one colour is baked for the frames that draw it again (pod_cell_flat); drawn into this image
    // once, on nothing but that colour, it is resampled straight in: the same pixels, no room taken from the bakes the
    // glass draws from (a warming's frames would fill it).
    for (int i = 0; i < p->count; i++) {
        ht_run_t *r = &one->runs[i];
        if (r->pro_kind != POD_CELL || r->text[0] != 1 || r->fg != p->ground) continue;
        const ht_rect_t b = ht_run_bounds(r);
        bool bare = true;
        for (int j = 0; j < i && bare; j++) {
            const ht_rect_t u = ht_run_bounds(&one->runs[j]);
            bare = u.x >= b.x + b.w || b.x >= u.x + u.w || u.y >= b.y + b.h || b.y >= u.y + u.h;
        }
        if (bare) r->text[0] = 0;
    }
    s_painted++;
    if (s_warm) {   // made out of the lock
        s_owed.kind = OWED_BARE, s_owed.pet = p, s_owed.y = 0;
        return NULL;
    }
    bare_rows(p, one, 0, p->h, ht_raster);
    return p;
}

// k dimmed and blurred, from k undimmed.
static pet_t *dimmed_pet(const pet_t *k, const ht_run_t *runs)
{
    pet_t *p = find(k);
    if (p) return p;
    pet_t *u = undimmed(k, runs);
    if (!u) return NULL;
    u->used = s_frame;   // kept while its dim is made
    if (!may_paint() || !(p = take(k))) return NULL;
    const job_t j = {.src = &s_pool_px[u->at], .alpha = &s_pool_a[u->at], .kx = kernel_x(p->dim),
                     .ky = kernel_y(p->dim), .d = max_dim_of(p->dim), .dims = true, .sw = p->w, .sh = p->h, .ow = p->w,
                     .oh = p->h, .out = &s_pool_px[p->at], .out_a = &s_pool_a[p->at], .pet = p};
    s_painted++;
    if (s_warm) {   // made out of the lock
        s_owed.kind = OWED_DIM, s_owed.pet = p, s_owed.src = u, s_owed.job = j, s_owed.y = 0;
        return NULL;
    }
    job_ask(&j);
    return p;
}

void max_layer_pet(ht_scene_t *s, int from, unsigned ground, int dim, unsigned keep)
{
    const int n = s->count - from;
    dim = (dim + DIM_STEP / 2) / DIM_STEP * DIM_STEP;
    if (n <= 0 || (!dim && keep >= 256)) return;   // drawn as it is
    const unsigned opacity = keep >= 256 ? 255 : keep * 255 / 256;
    if (!opacity) {   // nothing of it shows
        s->count = from;
        return;
    }
    ht_rect_t b = ht_run_bounds(&s->runs[from]);
    for (int i = from + 1; i < s->count; i++) {
        const ht_rect_t r = ht_run_bounds(&s->runs[i]);
        const int x1 = imax(b.x + b.w, r.x + r.w), y1 = imax(b.y + b.h, r.y + r.h);
        b.x = (int16_t)imin(b.x, r.x), b.y = (int16_t)imin(b.y, r.y);
        b.w = (int16_t)(x1 - b.x), b.h = (int16_t)(y1 - b.y);
    }
    // Its box and the blur's reach around it, at every dim: its undimmed image is each one's source.
    const int x0 = imax(0, b.x - BLUR_R), y0 = imax(0, b.y - BLUR_R);
    const int x1 = imin(HT_WIDTH, b.x + b.w + BLUR_R), y1 = imin(HT_HEIGHT, b.y + b.h + BLUR_R);
    if (n > PET_RUNS || x1 <= x0 || y1 <= y0 || (x1 - x0) * (y1 - y0) > PET_PX) return;   // too big: as it is
    // Its key: its runs from its box's corner, unless one pins it to its place.
    pet_t *k = &s_key;
    *k = (pet_t){.count = (uint8_t)n, .ground = ht_rgb(ground), .dim = (int16_t)dim, .x = (int16_t)x0,
                 .y = (int16_t)y0, .w = (int16_t)(x1 - x0), .h = (int16_t)(y1 - y0)};
    for (int i = 0; i < n; i++) {
        k->runs[i] = s->runs[from + i];
        k->pinned |= !movable(&k->runs[i]);
    }
    if (!k->pinned)
        for (int i = 0; i < n; i++)
            k->runs[i].x = (int16_t)(k->runs[i].x - x0), k->runs[i].y = (int16_t)(k->runs[i].y - y0);
    pet_t *p = dim ? dimmed_pet(k, &s->runs[from]) : undimmed(k, &s->runs[from]);
    if (!p) return;   // no room this frame: as it is
    p->used = s_frame;
    s->count = from;
    const ht_pro_bitmap_t bmp = {&s_pool_px[p->at], &s_pool_a[p->at], (uint16_t)p->w, (uint16_t)p->h, p->revision,
                                 NULL};
    ht_pro_image_faded(s, x0, y0, &bmp, opacity);
}

// ---- an agent between looks, cut to its window ----

// The glyph the compositor draws for cp (pro_canvas.c's code()).
static const ht_pro_glyph_t *glyph_of(const ht_pro_font_t *f, uint32_t cp)
{
    const int vietnamese = ht_pro_vietnamese_index(cp);
    if (vietnamese >= 0 && f->last - f->first + 1 + vietnamese < f->glyph_count)
        return &f->glyphs[f->last + 1 + vietnamese - f->first];
    const int extra = ht_pro_extra_pos(f, cp);
    if (extra >= 0 && f->last - f->first + 1 + 102 + extra < f->glyph_count)
        return &f->glyphs[f->last + 1 + 102 + extra - f->first];
    if (cp == 0x2018 || cp == 0x2019) cp = '\'';
    if (cp == 0x201c || cp == 0x201d) cp = '"';
    if (cp >= 0x2010 && cp <= 0x2015) cp = '-';
    return &f->glyphs[(cp >= f->first && cp <= f->last ? cp : '?') - f->first];
}

// An image run of px (w x h) at (x, y), this frame's.
static ht_run_t image_run(int x, int y, int w, int h, const uint16_t *px)
{
    ht_scene_clear(&s_one, 0);
    const ht_pro_bitmap_t b = {px, NULL, (uint16_t)w, (uint16_t)h, s_frame, NULL};
    ht_pro_image(&s_one, x, y, &b);
    return s_one.runs[0];
}
static uint16_t *patch_px(int area)
{
    if (area <= 0 || s_patch_used + area > PATCH_PX) return NULL;
    uint16_t *px = s_patch + s_patch_used;
    s_patch_used += area;
    return px;
}

void max_layer_light(ht_scene_t *s, int lx, int lw, int l, int r, unsigned base, unsigned peak)
{
    if (s_warm) return;   // a frame's own
    int x0 = imax(imax(l, lx), 0), x1 = imin(imin(r, lx + lw), HT_WIDTH);
    // Off the rail it keeps a column of the rail's own colour at the end it left or comes in at: the scene's runs keep
    // their places from frame to frame, so the damage stays the light's (ht_damage compares the runs in order).
    if (x1 <= x0) {
        x0 = lx >= r ? imin(r, HT_WIDTH) - 1 : imax(l, 0);
        x1 = x0 + 1;
    }
    const int w = x1 - x0;
    uint16_t *px = x0 >= 0 && x1 <= HT_WIDTH && lw > 0 ? patch_px(w * RAIL_H) : NULL;
    if (!px) return;
    for (int x = x0; x < x1; x++) {
        // V3's gradient base, peak, base at 0, .5 and 1 of the light, at the pixel's middle: t of MAX_ONE the peak's.
        const int from_mid = 2 * (2 * (x - lx) + 1) - 2 * lw;
        const int32_t t = imax(0, MAX_ONE - (int)((int64_t)(from_mid < 0 ? -from_mid : from_mid) * MAX_ONE / (2 * lw)));
        rgb_t c;
        int32_t *ch[3] = {&c.r, &c.g, &c.b};
        for (int k = 0, sh = 16; k < 3; k++, sh -= 8) {
            const int32_t b = (int32_t)(base >> sh & 255), p = (int32_t)(peak >> sh & 255);
            *ch[k] = b + ((p - b) * t + MAX_ONE / 2) / MAX_ONE;
        }
        for (int y = 0; y < RAIL_H; y++) px[y * w + x - x0] = t ? dither(c, x, y) : ht_rgb(base);   // the rail's own
    }
    const ht_pro_bitmap_t b = {px, NULL, (uint16_t)w, RAIL_H, s_frame, NULL};
    ht_pro_image(s, x0, 0, &b);
}

// What the agent draws over `rect` up to its run i, that run as `last`: rasterised as a patch in that run's place.
// Returns the runs out.
static int patch(int i, const ht_run_t *last, ht_rect_t rect, int out)
{
    const int y1 = imin(HT_HEIGHT, rect.y + rect.h);
    rect.y = (int16_t)imax(0, rect.y), rect.h = (int16_t)(y1 - rect.y);
    uint16_t *px = rect.w > 0 && rect.h > 0 ? patch_px(rect.w * rect.h) : NULL;
    if (!px || out >= HT_RUNS) return out;   // no room: that end is left out
    const ht_run_t was = s_sub.runs[i];
    const int count = s_sub.count;
    s_sub.runs[i] = *last;
    s_sub.count = i + 1;
    ready(s_sub.runs, s_sub.count, rect);
    ht_raster(&s_sub, rect, px);
    s_sub.runs[i] = was;
    s_sub.count = count;
    s_cut[out++] = image_run(rect.x, rect.y, rect.w, rect.h, px);
    return out;
}

// A square rect, as ht_pro_rect draws it, into the runs out.
static int square(int x, int y, int w, int h, uint16_t ink, int out)
{
    ht_scene_clear(&s_one, 0);
    if (out < HT_RUNS && ht_pro_rect(&s_one, x, y, w, h, 0, ink)) s_cut[out++] = s_one.runs[0];
    return out;
}

// A rounded box (run i) cut by an end of [l, r) at x0..x1 of it: its straight middle a square fill (or a stroked
// box's three, its one-px rim and its fill), each corner the window keeps a patch.
static int cut_box(int i, const ht_run_t *c, int x0, int x1, int out)
{
    const ht_rect_t b = ht_run_bounds(c);
    const int m0 = imax(x0, b.x + c->radius), m1 = imin(x1, b.x + b.w - c->radius);
    if (m1 <= m0) return patch(i, c, (ht_rect_t){(int16_t)x0, b.y, (int16_t)(x1 - x0), b.h}, out);
    if (x0 < m0) out = patch(i, c, (ht_rect_t){(int16_t)x0, b.y, (int16_t)(m0 - x0), b.h}, out);
    if (c->pro_kind == RUN_RECT_AA_STROKE) {
        uint16_t fill;
        memcpy(&fill, c->text, sizeof fill);
        out = square(m0, b.y, m1 - m0, 1, c->fg, out);
        out = square(m0, b.y + 1, m1 - m0, b.h - 2, fill, out);
        out = square(m0, b.y + b.h - 1, m1 - m0, 1, c->fg, out);
    } else {
        out = square(m0, b.y, m1 - m0, b.h, c->fg, out);
    }
    if (m1 < x1) out = patch(i, c, (ht_rect_t){(int16_t)m1, b.y, (int16_t)(x1 - m1), b.h}, out);
    return out;
}

// Run i of the agent (in s_sub), which crosses an end of [l, r), cut there: a straight end by its width, a rounded
// box by its middle, a text's right end by its width (the compositor draws no glyph past it) and its left end from the
// first glyph inside, an image as a window of it; anything else, a box's corners and the glyphs the left end cuts, as
// patches. Returns the runs out.
static int cut(int i, int l, int r, int out)
{
    ht_run_t c = s_sub.runs[i];
    const ht_rect_t b = ht_run_bounds(&c);
    const int x0 = imax(b.x, l), x1 = imin(b.x + b.w, r);
    const bool straight = !c.radius && (c.pro_kind == RUN_RECT || c.pro_kind == POD_GRAD);
    if (straight || (c.pro_kind == RUN_IMAGE && c.bitmap.pixels)) {
        if (c.pro_kind == RUN_IMAGE) {
            c.bitmap.pixels += x0 - c.x;
            if (c.bitmap.alpha) c.bitmap.alpha += x0 - c.x;
        }
        c.x = (int16_t)x0, c.w = (int16_t)(x1 - x0);
        if (out < HT_RUNS) s_cut[out++] = c;
        return out;
    }
    if (c.pro_kind == RUN_RECT || c.pro_kind == RUN_RECT_AA || c.pro_kind == RUN_RECT_AA_STROKE)
        return cut_box(i, &c, x0, x1, out);
    if (c.pro_kind != RUN_TEXT)
        return patch(i, &c, (ht_rect_t){(int16_t)x0, b.y, (int16_t)(x1 - x0), b.h}, out);
    const char *p = c.text;
    int gx = c.x;
    while (*p && gx < l) {
        const char *next = p;
        gx += glyph_of(c.pro_font, ht_utf8_next(&next))->advance;
        p = next;
    }
    if (p > c.text) {   // the glyphs before p start left of l: those inside, as a patch
        ht_run_t head = c;
        head.text[p - c.text] = 0;
        out = patch(i, &head, (ht_rect_t){(int16_t)x0, b.y, (int16_t)(imin(gx, x1) - x0), b.h}, out);
    }
    if (!*p || gx >= x1 || out >= HT_RUNS) return out;
    const size_t len = strlen(p);
    memmove(c.text, p, len + 1);
    memset(c.text + len + 1, 0, sizeof c.text - len - 1);
    c.x = (int16_t)gx, c.w = (int16_t)(x1 - gx);
    s_cut[out++] = c;
    return out;
}

// A patch of the glass's [x0, x1) x [y0, y1), blurred from src (the glass's [c0, c0 + sw) x [r0, r0 + sh) as drawn).
static int blur_patch(const uint16_t *src, int c0, int r0, int sw, int sh, int x0, int x1, int y0, int y1,
                      const uint16_t *kx, const uint16_t *ky, bool now, int out)
{
    const int ow = x1 - x0, oh = y1 - y0;
    uint16_t *px = ow > 0 && oh > 0 && out < HT_RUNS ? patch_px(ow * oh) : NULL;
    if (!px) return out;   // no room: that edge is left sharp
    const job_t j = {.src = src, .kx = kx, .ky = ky, .sw = (int16_t)sw, .sh = (int16_t)sh, .ox = (int16_t)(x0 - c0),
                     .oy = (int16_t)(y0 - r0), .ow = (int16_t)ow, .oh = (int16_t)oh, .out = px, .gx = (int16_t)x0,
                     .gy = (int16_t)y0};   // no dim: its colours are dimmed as drawn
    if (now) job_run(&j, &s_work[0]);
    else job_ask(&j);
    s_cut[out++] = image_run(x0, y0, ow, oh, px);
    return out;
}

// The glass's [x0, x1) x [y0, y1) of the agent from x (w wide) blurred as its layer would blur it (transparent past
// the agent and the glass), over the runs out. Where the rows it reads are all one row (an agent's sides below its
// glow), its rows are that row blurred across alone: columns of runs, rounded where a patch dithers.
static int blurred(int x, int w, int x0, int x1, int y0, int y1, const uint16_t *kx, const uint16_t *ky, int out)
{
    const int c0 = imax(x, x0 - BLUR_R), c1 = imin(x + w, x1 + BLUR_R);
    const int r0 = imax(0, y0 - BLUR_R), r1 = imin(HT_HEIGHT, y1 + BLUR_R);
    const int sw = c1 - c0, sh = r1 - r0, area = sw * sh;
    if (x1 <= x0 || y1 <= y0 || out >= HT_RUNS || sw > LINE_W || area > EDGE_PX) return out;
    const bool room = s_edges_used + area <= EDGES_PX;   // else done now, in the one buffer
    uint16_t *src = room ? s_edges + s_edges_used : s_edge;
    if (room) s_edges_used += area;
    const ht_rect_t read = {(int16_t)c0, (int16_t)r0, (int16_t)sw, (int16_t)sh};
    ready(s_sub.runs, s_sub.count, read);
    ht_raster(&s_sub, read, src);
    int same = sh - 1;   // the rows from `same` on are one row
    while (same > 0 && !memcmp(&src[(size_t)(same - 1) * sw], &src[(size_t)same * sw], (size_t)sw * sizeof src[0]))
        same--;
    const int f0 = imax(y0, r0 + same + BLUR_R), f1 = imin(y1, r1 - BLUR_R);
    if (f1 - f0 < 2 * BLUR_R)
        return blur_patch(src, c0, r0, sw, sh, x0, x1, y0, y1, kx, ky, !room, out);
    out = blur_patch(src, c0, r0, sw, sh, x0, x1, y0, f0, kx, ky, !room, out);
    const uint16_t *row = &src[(size_t)(f0 - r0) * sw];
    uint16_t ink = 0;
    for (int c = x0, from = x0; c <= x1; c++) {
        uint16_t at = 0;
        if (c < x1) {
            uint32_t r = 0, g = 0, b = 0;
            for (int t = -BLUR_R; t <= BLUR_R; t++) {
                const int i = c + t - c0;
                if (i < 0 || i >= sw) continue;
                const uint32_t k = kx[t < 0 ? -t : t];
                r += k * (row[i] >> 11), g += k * (row[i] >> 5 & 63), b += k * (row[i] & 31);
            }
            at = (uint16_t)(((r + 128) >> 8) << 11 | ((g + 128) >> 8) << 5 | ((b + 128) >> 8));
        }
        if (c > x0 && (c == x1 || at != ink)) {
            out = square(from, f0, c - from, f1 - f0, ink, out);
            from = c;
        }
        ink = at;
    }
    return blur_patch(src, c0, r0, sw, sh, x0, x1, f1, y1, kx, ky, !room, out);
}

// Where the blur visibly moves what an agent between looks draws on the glass, but for its pet (its own image): its
// rail (a bright bar on the dark, its top at the glass's) and the agent's sides (its rail's ends, its glow's and its
// ground's, and the one-px line down its right), over its window [l, r).
static int edges(int x, int w, int l, int r, int dim, int out)
{
    const uint16_t *kx = kernel_x(dim), *ky = kernel_y(dim);
    if (!blurs(kx) && !blurs(ky)) return out;
    const int top = RAIL_H + BLUR_R;
    out = blurred(x, w, l, r, 0, top, kx, ky, out);
    if (x >= l) out = blurred(x, w, x, imin(r, x + BLUR_R), top, HT_HEIGHT, kx, ky, out);
    if (x + w <= r) out = blurred(x, w, imax(l, x + w - 1 - BLUR_R), x + w, top, HT_HEIGHT, kx, ky, out);
    return out;
}

void max_layer_cut(ht_scene_t *s, int from, int x, int w, int l, int r, int dim)
{
    const int n = s->count - from;
    if (n <= 0 || s_warm) return;
    // What the agent's own layer would hold: what a cut end and the edges are rasterised from.
    ht_scene_clear(&s_sub, s->background);
    memcpy(s_sub.runs, &s->runs[from], (size_t)n * sizeof s->runs[0]);
    s_sub.count = n;
    int out = 0;
    for (int i = 0; i < n; i++) {
        const ht_rect_t b = ht_run_bounds(&s_sub.runs[i]);
        if (b.x >= l && b.x + b.w <= r) {
            if (out < HT_RUNS) s_cut[out++] = s_sub.runs[i];
        } else if (b.x + b.w > l && b.x < r && b.w > 0) {
            out = cut(i, l, r, out);
        }
    }
    if (dim) out = edges(x, w, l, r, dim, out);
    const int room = imin(out, HT_RUNS - from);
    memcpy(&s->runs[from], s_cut, (size_t)room * sizeof s_cut[0]);
    s->count = from + room;
}

// ---- settled slivers, kept ----

static void paint_sub(int x, max_paint_t paint, const void *arg)
{
    ht_scene_clear(&s_sub, ht_rgb(GROUND));
    paint(&s_sub, x, arg);
}

// One that cannot be kept: drawn on the glass as an agent between looks at its end.
static void on_glass(ht_scene_t *s, int x, int l, int r, max_paint_t paint, const void *arg)
{
    const int from = s->count;
    max_dim(MAX_ONE);
    paint(s, x, arg);
    max_dim(0);
    max_layer_cut(s, from, x, SLIVER_W, l, r, MAX_ONE);
}

// Rows [y0, y1) of a sliver's layer, rasterised whole, blurred and dimmed as it is kept (rows above done before).
static void kept_rows(uint16_t *px, int bottom, const busy_t *bz, uint16_t (*ring)[LAYER_W], int y0, int y1)
{
    const max_dim_t d = max_dim_of(MAX_ONE);
    memset(s_memo_of, 0, sizeof s_memo_of);   // a frame's own layers may have dimmed by the memo since
    down(px, LAYER_W, kernel_y(MAX_ONE), bz, ring, y0, y1);
    across(px, LAYER_W, bottom, kernel_x(MAX_ONE), &d, bz, y0, y1);
}
static void kept_made(kept_t *k, const ht_scene_t *sub)
{
    memcpy(k->runs, sub->runs, (size_t)sub->count * sizeof sub->runs[0]);
    k->count = sub->count;
    k->full = true;
    k->revision++;
}

void max_layer_kept(ht_scene_t *s, int x, int l, int r, max_paint_t paint, const void *arg)
{
    paint_sub(0, paint, arg);
    kept_t *k = NULL, *spare = NULL;
    for (int i = 0; i < KEPT && !k && s_sub.count <= KEPT_RUNS; i++) {
        kept_t *c = &s_kept[i];
        if (c->full && c->count == s_sub.count && !memcmp(c->runs, s_sub.runs, (size_t)c->count * sizeof c->runs[0]))
            k = c;
        else if (!held(c->used) && !owed(c) && (!spare || c->used < spare->used))   // the longest unseen, not this frame's
            spare = c;
    }
    if (!k) {
        s_full |= s_warm && !spare;
        if (!spare || s_sub.count > KEPT_RUNS || !may_paint()) {
            on_glass(s, x, l, r, paint, arg);
            return;
        }
        k = spare;
        s_painted++;
        if (s_warm) {   // made out of the lock; on the glass this frame
            k->full = false;
            memcpy(&s_owed.scene, &s_sub, sizeof s_sub);
            s_owed.kind = OWED_KEPT, s_owed.kept = k, s_owed.y = 0;
            on_glass(s, x, l, r, paint, arg);
            return;
        }
        uint16_t *px = s_kept_px[k - s_kept];
        ht_raster(&s_sub, (ht_rect_t){0, 0, LAYER_W, HT_HEIGHT}, px);
        kept_rows(px, busy_of(&s_busy, &s_sub, LAYER_W), &s_busy, s_ring, 0, HT_HEIGHT);
        kept_made(k, &s_sub);
    }
    k->used = s_frame;
    const ht_pro_bitmap_t b = {s_kept_px[k - s_kept] + (l - x), NULL, LAYER_W, HT_HEIGHT, k->revision, NULL};
    if (ht_pro_image(s, l, 0, &b)) s->runs[s->count - 1].w = (int16_t)(r - l);
}

bool max_layer_warm_paint(bool (*go_on)(void))
{
    while (s_owed.kind) {
        const int y0 = s_owed.y;
        bool made = false;
        if (s_owed.kind == OWED_BARE) {
            pet_t *p = s_owed.pet;
            const int y1 = imin(p->h, y0 + imax(1, RASTER_PX / p->w));
            bare_rows(p, &s_owed.scene, y0, y1, band_raster);
            s_owed.y = y1;
            made = y1 == p->h;
        } else if (s_owed.kind == OWED_DIM) {
            const job_t *j = &s_owed.job;
            const int y1 = imin(j->oh, y0 + imax(1, BAND_PX / j->ow));
            blur(&s_work[0], j->src, j->alpha, j->sw, j->sh, j->kx, j->ky, &j->d, j->ox, j->oy + y0, j->ow, y1 - y0,
                 j->out + (size_t)y0 * j->ow, j->out_a + (size_t)y0 * j->ow, j->gx, j->gy + y0);
            s_owed.y = y1;
            made = y1 == j->oh;
        } else {   // a layer: its rows rasterised, then blurred
            uint16_t *px = s_kept_px[s_owed.kept - s_kept];
            const int y1 = imin(2 * HT_HEIGHT, y0 + imax(1, (y0 < HT_HEIGHT ? RASTER_PX : BAND_PX) / LAYER_W));
            if (y0 < HT_HEIGHT) {
                band_raster(&s_owed.scene, (ht_rect_t){0, (int16_t)y0, LAYER_W, (int16_t)(imin(y1, HT_HEIGHT) - y0)},
                            px + (size_t)y0 * LAYER_W);
                if (y1 >= HT_HEIGHT) s_owed.bottom = busy_of(&s_owed.busy, &s_owed.scene, LAYER_W);
                s_owed.y = imin(y1, HT_HEIGHT);
            } else {
                kept_rows(px, s_owed.bottom, &s_owed.busy, s_owed.ring, y0 - HT_HEIGHT, y1 - HT_HEIGHT);
                s_owed.y = y1;
                if ((made = y1 == 2 * HT_HEIGHT)) kept_made(s_owed.kept, &s_owed.scene);
            }
        }
        if (made) {   // kept by the warming from here
            if (s_owed.pet) s_owed.pet->used = s_frame;
            if (s_owed.src) s_owed.src->used = s_frame;
            if (s_owed.kept) s_owed.kept->used = s_frame;
            owed_drop();
        }
        if (!go_on()) break;
    }
    return s_owed.kind != OWED_NONE;
}
