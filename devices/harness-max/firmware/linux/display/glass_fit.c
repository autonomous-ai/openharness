#include "glass_fit.h"

#include <math.h>
#include <string.h>

glass_fit_t glass_fit(int glass_w, int glass_h, int out_w, int out_h)
{
    glass_fit_t f = {glass_w, glass_h, out_w, out_h, out_h > out_w, {0, 0, 0, 0}};
    const int lw = f.turned ? out_h : out_w, lh = f.turned ? out_w : out_h;
    // One factor for both axes, the smaller one, rounded to whole pixels on the other axis.
    if ((int64_t)lw * glass_h <= (int64_t)lh * glass_w) {
        f.pic.w = lw;
        f.pic.h = (int)(((int64_t)glass_h * lw + glass_w / 2) / glass_w);
    } else {
        f.pic.h = lh;
        f.pic.w = (int)(((int64_t)glass_w * lh + glass_h / 2) / glass_h);
    }
    f.pic.x = (lw - f.pic.w) / 2;
    f.pic.y = (lh - f.pic.h) / 2;
    return f;
}

// The picture pixels [lo, hi) of one axis whose 2-tap filter reads any of the glass pixels [g0, g1). Picture pixel p
// samples glass at s = (p + 0.5) * glass / pic - 0.5 and reads floor(s) and floor(s) + 1, so it reads the range when
// g0 - 1 < s < g1. Rounded outwards: a pixel too many is repainted from the same glass, a pixel too few goes stale.
static void damage_axis(int g0, int g1, int glass, int pic, int *lo, int *hi)
{
    const double k = (double)pic / glass;
    int a = (int)floor((g0 - 0.5) * k - 0.5), b = (int)ceil((g1 + 0.5) * k - 0.5);
    *lo = a < 0 ? 0 : a;
    *hi = b > pic ? pic : b;
}

glass_fit_rect_t glass_fit_damage(const glass_fit_t *f, glass_fit_rect_t glass)
{
    if (glass.w <= 0 || glass.h <= 0) return (glass_fit_rect_t){0, 0, 0, 0};
    int x0, x1, y0, y1;
    damage_axis(glass.x, glass.x + glass.w, f->glass_w, f->pic.w, &x0, &x1);
    damage_axis(glass.y, glass.y + glass.h, f->glass_h, f->pic.h, &y0, &y1);
    if (x1 <= x0 || y1 <= y0) return (glass_fit_rect_t){0, 0, 0, 0};
    return (glass_fit_rect_t){f->pic.x + x0, f->pic.y + y0, x1 - x0, y1 - y0};
}

// The two glass pixels picture pixel p reads along one axis, and the second one's weight (0..256).
typedef struct {
    int a, b, w;
} tap_t;

static tap_t tap_at(int p, int pic, int glass)
{
    // The sample point, in 16.16: (p + 0.5) * glass / pic - 0.5, kept on the glass.
    int64_t s = ((int64_t)(2 * p + 1) * glass << 16) / (2 * pic) - (1 << 15);
    if (s < 0) s = 0;
    if (s > (int64_t)(glass - 1) << 16) s = (int64_t)(glass - 1) << 16;
    const int a = (int)(s >> 16);
    return (tap_t){a, a + 1 < glass ? a + 1 : a, (int)((s >> 8) & 255)};
}

static inline void unpack(uint16_t c, int *r, int *g, int *b)
{
    const int r5 = c >> 11, g6 = (c >> 5) & 63, b5 = c & 31;
    *r = r5 << 3 | r5 >> 2;
    *g = g6 << 2 | g6 >> 4;
    *b = b5 << 3 | b5 >> 2;
}

// The filter one axis at a time. The first pass blends two glass pixels along one axis and keeps the sum unrounded,
// per channel: (256 - w) * c0 + w * c1, at most 256 * 255. The second blends two of those along the other axis and
// rounds once. The sum is the 2 x 2 bilinear blend's, (256 - wx)(256 - wy) c00 + wx (256 - wy) c01 + ..., to the bit,
// with each glass pixel unpacked and blended across about once instead of once for each picture pixel around it: the
// bar's whole picture in 9.0 ms instead of 12.2 on an A76 at 2 GHz (2026-11-20), which is most of a frame there.
typedef struct {
    uint16_t r, g, b;
} mix_t;

static inline mix_t mix_px(uint16_t c0, uint16_t c1, int w)
{
    int r0, g0, b0, r1, g1, b1;
    unpack(c0, &r0, &g0, &b0);
    unpack(c1, &r1, &g1, &b1);
    const int v = 256 - w;
    return (mix_t){(uint16_t)(r0 * v + r1 * w), (uint16_t)(g0 * v + g1 * w), (uint16_t)(b0 * v + b1 * w)};
}

static inline uint32_t mix_out(mix_t a, mix_t b, int w)
{
    const uint32_t v = 256 - (uint32_t)w, u = (uint32_t)w;
    const uint32_t r = (a.r * v + b.r * u + 32768) >> 16, g = (a.g * v + b.g * u + 32768) >> 16,
                   bl = (a.b * v + b.b * u + 32768) >> 16;
    return r << 16 | g << 8 | bl;
}

// The longest raster row painted at once; longer is clipped (no output this program drives is near it).
#define ROW_MAX 4096
// The first pass's sums kept at once: a band of raster rows' worth, each the glass pixels its row reads along it.
#define MIX_MAX 4096
#define BAND_MAX 8

void glass_fit_paint(const glass_fit_t *f, const uint16_t *glass, glass_fit_rect_t land, uint32_t *out, int stride)
{
    // A raster row runs along landscape x (unturned) or landscape y (turned). Its taps are the same for every row, so
    // they are worked out once; each row is blended into `row` and copied out in one go.
    tap_t taps[ROW_MAX];
    uint32_t row[ROW_MAX];
    mix_t mix[MIX_MAX];
    const int lw = f->turned ? f->out_h : f->out_w;
    const int n = f->turned ? land.h : land.w, first = f->turned ? land.y : land.x;
    if (n <= 0 || n > ROW_MAX) return;
    for (int i = 0; i < n; i++)
        taps[i] = f->turned ? tap_at(first + i - f->pic.y, f->pic.h, f->glass_h)
                            : tap_at(first + i - f->pic.x, f->pic.w, f->glass_w);
    // The glass pixels a row reads along it, [g0, g0 + span): the taps only grow along a row. From here on the taps
    // count from g0, as the first pass's sums do.
    const int g0 = taps[0].a, span = taps[n - 1].b - g0 + 1;
    if (span > MIX_MAX) return;
    for (int i = 0; i < n; i++) taps[i].a -= g0, taps[i].b -= g0;
    // Turned: raster row oy is landscape column lw - 1 - oy. Unturned: raster row oy is landscape row oy.
    const int oy0 = f->turned ? lw - (land.x + land.w) : land.y, rows = f->turned ? land.w : land.h;
    const int band_max = f->turned ? (MIX_MAX / span < BAND_MAX ? MIX_MAX / span : BAND_MAX) : 1;
    for (int oy = oy0; oy < oy0 + rows; oy += band_max) {
        const int band = oy0 + rows - oy < band_max ? oy0 + rows - oy : band_max;
        if (f->turned) {
            // Along a raster row the taps go down a glass column. A band of raster rows, neighbouring glass columns,
            // is blended across first, a glass row at a time, so the glass is read along its rows.
            tap_t across[BAND_MAX];
            for (int k = 0; k < band; k++) across[k] = tap_at(lw - 1 - (oy + k) - f->pic.x, f->pic.w, f->glass_w);
            for (int y = 0; y < span; y++) {
                const uint16_t *g = glass + (size_t)(g0 + y) * f->glass_w;
                for (int k = 0; k < band; k++) mix[k * span + y] = mix_px(g[across[k].a], g[across[k].b], across[k].w);
            }
        } else {
            const tap_t across = tap_at(oy - f->pic.y, f->pic.h, f->glass_h);
            const uint16_t *r0 = glass + (size_t)across.a * f->glass_w + g0;
            const uint16_t *r1 = glass + (size_t)across.b * f->glass_w + g0;
            for (int x = 0; x < span; x++) mix[x] = mix_px(r0[x], r1[x], across.w);
        }
        for (int k = 0; k < band; k++) {
            const mix_t *m = mix + k * span;
            for (int i = 0; i < n; i++) row[i] = mix_out(m[taps[i].a], m[taps[i].b], taps[i].w);
            memcpy(out + (size_t)(oy + k) * stride + first, row, (size_t)n * sizeof row[0]);
        }
    }
}

static bool rect_empty(glass_fit_rect_t r) { return r.w <= 0 || r.h <= 0; }
static int64_t area(glass_fit_rect_t r) { return (int64_t)r.w * r.h; }

glass_fit_rect_t glass_fit_union(glass_fit_rect_t a, glass_fit_rect_t b)
{
    if (rect_empty(a)) return rect_empty(b) ? (glass_fit_rect_t){0, 0, 0, 0} : b;
    if (rect_empty(b)) return a;
    const int x0 = a.x < b.x ? a.x : b.x, y0 = a.y < b.y ? a.y : b.y;
    const int x1 = a.x + a.w > b.x + b.w ? a.x + a.w : b.x + b.w, y1 = a.y + a.h > b.y + b.h ? a.y + a.h : b.y + b.h;
    return (glass_fit_rect_t){x0, y0, x1 - x0, y1 - y0};
}

void glass_fit_flip_add(glass_fit_flip_t *f, glass_fit_rect_t r) { f->pending = glass_fit_union(f->pending, r); }

int glass_fit_flip(glass_fit_flip_t *f, glass_fit_rect_t out[2])
{
    const glass_fit_rect_t now = f->pending, last = f->last;
    if (rect_empty(now)) return 0;
    f->last = now;
    f->pending = (glass_fit_rect_t){0, 0, 0, 0};
    // One paint of the union when it is no more pixels than the two apart (an overlap is painted twice either way).
    const glass_fit_rect_t both = glass_fit_union(now, last);
    if (area(both) <= area(now) + (rect_empty(last) ? 0 : area(last))) {
        out[0] = both;
        return 1;
    }
    out[0] = now;
    out[1] = last;
    return 2;
}

bool glass_fit_touch(const glass_fit_t *f, int ox, int oy, int *gx, int *gy)
{
    if (ox < 0 || oy < 0 || ox >= f->out_w || oy >= f->out_h) return false;
    const int lx = f->turned ? f->out_h - 1 - oy : ox, ly = f->turned ? ox : oy;
    const int px = lx - f->pic.x, py = ly - f->pic.y;
    if (px < 0 || py < 0 || px >= f->pic.w || py >= f->pic.h) return false;
    // The glass pixel under the centre of the picture pixel.
    *gx = (int)((int64_t)(2 * px + 1) * f->glass_w / (2 * f->pic.w));
    *gy = (int)((int64_t)(2 * py + 1) * f->glass_h / (2 * f->pic.h));
    return true;
}

int glass_fit_axis(int value, int min, int max, int size)
{
    if (value < min) value = min;
    if (value > max) value = max;
    return (int)((int64_t)(value - min) * size / ((int64_t)max - min + 1));
}
