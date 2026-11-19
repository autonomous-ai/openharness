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

// The bilinear blend of the 2 x 2 glass pixels the taps name.
static inline uint32_t blend(const uint16_t *glass, int stride, tap_t x, tap_t y)
{
    const uint16_t *row0 = glass + y.a * stride, *row1 = glass + y.b * stride;
    int r[4], g[4], b[4];
    unpack(row0[x.a], &r[0], &g[0], &b[0]);
    unpack(row0[x.b], &r[1], &g[1], &b[1]);
    unpack(row1[x.a], &r[2], &g[2], &b[2]);
    unpack(row1[x.b], &r[3], &g[3], &b[3]);
    const int w0 = (256 - x.w) * (256 - y.w), w1 = x.w * (256 - y.w), w2 = (256 - x.w) * y.w, w3 = x.w * y.w;
    const uint32_t ro = (uint32_t)(r[0] * w0 + r[1] * w1 + r[2] * w2 + r[3] * w3 + 32768) >> 16;
    const uint32_t go = (uint32_t)(g[0] * w0 + g[1] * w1 + g[2] * w2 + g[3] * w3 + 32768) >> 16;
    const uint32_t bo = (uint32_t)(b[0] * w0 + b[1] * w1 + b[2] * w2 + b[3] * w3 + 32768) >> 16;
    return ro << 16 | go << 8 | bo;
}

// The longest raster row painted at once; longer is clipped (no output this program drives is near it).
#define ROW_MAX 4096

void glass_fit_paint(const glass_fit_t *f, const uint16_t *glass, glass_fit_rect_t land, uint32_t *out, int stride)
{
    // A raster row runs along landscape x (unturned) or landscape y (turned). Its taps are the same for every row, so
    // they are worked out once; each row is blended into `row` and copied out in one go.
    tap_t taps[ROW_MAX];
    uint32_t row[ROW_MAX];
    const int lw = f->turned ? f->out_h : f->out_w;
    const int n = f->turned ? land.h : land.w, first = f->turned ? land.y : land.x;
    if (n <= 0 || n > ROW_MAX) return;
    for (int i = 0; i < n; i++)
        taps[i] = f->turned ? tap_at(first + i - f->pic.y, f->pic.h, f->glass_h)
                            : tap_at(first + i - f->pic.x, f->pic.w, f->glass_w);
    // Turned: raster row oy is landscape column lw - 1 - oy. Unturned: raster row oy is landscape row oy.
    const int oy0 = f->turned ? lw - (land.x + land.w) : land.y, rows = f->turned ? land.w : land.h;
    for (int oy = oy0; oy < oy0 + rows; oy++) {
        const tap_t across = f->turned ? tap_at(lw - 1 - oy - f->pic.x, f->pic.w, f->glass_w)
                                       : tap_at(oy - f->pic.y, f->pic.h, f->glass_h);
        if (f->turned)
            for (int i = 0; i < n; i++) row[i] = blend(glass, f->glass_w, across, taps[i]);
        else
            for (int i = 0; i < n; i++) row[i] = blend(glass, f->glass_w, taps[i], across);
        memcpy(out + (size_t)oy * stride + first, row, (size_t)n * sizeof row[0]);
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
