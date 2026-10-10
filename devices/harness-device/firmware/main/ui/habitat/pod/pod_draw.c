#include "pod_draw.h"
#include <string.h>

static int imin(int a, int b) { return a < b ? a : b; }
static int imax(int a, int b) { return a > b ? a : b; }

// Per-kind parameters, packed into run->text.
typedef struct { int16_t cx16, cy16; uint16_t r16, w16; int16_t ux, uy, cosh; } arc_params_t;
typedef struct { uint16_t top, bottom; } grad_params_t;
_Static_assert(sizeof(arc_params_t) <= HT_TEXT_BYTES, "arc parameters fit run->text");
_Static_assert(sizeof(grad_params_t) <= HT_TEXT_BYTES, "gradient parameters fit run->text");

static ht_run_t *new_run(ht_scene_t *s, int kind, int x, int y, int w, int h)
{
    if (s->count >= HT_RUNS) return NULL;
    ht_run_t *r = &s->runs[s->count++];
    memset(r, 0, sizeof *r);
    r->pro_kind = (uint8_t)kind; r->x = (int16_t)x; r->y = (int16_t)y; r->w = (int16_t)w;
    r->pro_height = (int16_t)h;
    return r;
}

// ---- cells ----------------------------------------------------------------------------------------------

// A frame's row `sy` (in cells) as `cols` palette indices: the plain grid's own row, or a packed row unpacked
// into `buf`.
static const uint8_t *cell_row(const uint8_t *cells, const uint16_t *row_at, int cols, int sy, uint8_t *buf)
{
    if (!row_at) return cells + (size_t)sy * cols;
    const uint8_t *p = cells + row_at[sy];
    for (int x = 0; x < cols;) {
        int skip = *p++, n = *p++;
        memset(buf + x, 0, (size_t)skip);
        x += skip;
        memcpy(buf + x, p, (size_t)n);
        p += n; x += n;
    }
    return buf;
}
uint8_t ht_cell_at(const ht_cell_frame_t *f, int col, int row)
{
    uint8_t buf[256];
    if (!f || col < 0 || row < 0 || col >= f->cols || row >= f->rows) return 0;
    return cell_row(f->cells, f->row_at, f->cols, row, buf)[col];
}
bool pod_cell(ht_scene_t *s, int x, int y, const ht_cell_frame_t *f, unsigned zoom8)
{
    if (!f || !f->cols || !f->rows || !f->cell || !f->cells || !f->palette || !zoom8) return false;
    if (zoom8 > 8) zoom8 = 8;
    int sw = f->cols * f->cell, sh = f->rows * f->cell;
    ht_run_t *r = new_run(s, POD_CELL, x, y, (int)((sw * zoom8 + 7) / 8), (int)((sh * zoom8 + 7) / 8));
    if (!r) return false;
    r->bitmap.asset = f;
    r->radius = (uint8_t)zoom8;
    return true;
}
static uint16_t swapped(uint16_t v) { return __builtin_bswap16(v); }

// A few frame rows kept unpacked, by row index (a packed row is unpacked on a miss), so a pixel can look at the
// cells around its own.
typedef struct { int row[4]; uint8_t buf[4][256]; unsigned next; } row_cache_t;
static const uint8_t *cache_row(const ht_cell_frame_t *f, row_cache_t *rc, int row)
{
    for (int i = 0; i < 4; i++) if (rc->row[i] == row) return rc->buf[i];
    unsigned slot = rc->next++ & 3;
    rc->row[slot] = row;
    const uint8_t *p = cell_row(f->cells, f->row_at, f->cols, row, rc->buf[slot]);
    if (p != rc->buf[slot]) memcpy(rc->buf[slot], p, (size_t)f->cols);   // a plain grid's own row: copied so the slot is valid
    return rc->buf[slot];
}
// The art was anti-aliased toward a black ground: the colours along its outside edge are dark. On a light ground they
// read as an outline, so an edge cell (one with a transparent 4-neighbour) whose colour is darker than a body
// colour is mixed toward the pixel UNDER it (whatever ground that is, never a fixed white) in proportion to how
// dark it is. Interior cells (eyes, shading) are untouched.
static bool edge_cell(const ht_cell_frame_t *f, row_cache_t *rc, int col, int row)
{
    const uint8_t *cur = cache_row(f, rc, row);
    if (col == 0 || col + 1 >= f->cols || row == 0 || row + 1 >= f->rows) return true;
    return !cur[col - 1] || !cur[col + 1] || !cache_row(f, rc, row - 1)[col] || !cache_row(f, rc, row + 1)[col];
}
enum { SOFT_BELOW = 112, SOFT_MAX = 154 };   // luminance under which an edge colour lightens; the most it mixes, of 256
static uint16_t soften(uint16_t c, uint16_t dest)
{
    unsigned r = c >> 11, g = (c >> 5) & 63, b = c & 31;
    unsigned lum = (r * 8u * 77u + g * 4u * 150u + b * 8u * 29u) >> 8;
    if (lum >= SOFT_BELOW) return c;
    unsigned k = (SOFT_BELOW - lum) * SOFT_MAX / SOFT_BELOW;   // 0..154 of 256
    unsigned dr = dest >> 11, dg = (dest >> 5) & 63, db = dest & 31;
    r = (r * (256 - k) + dr * k) / 256; g = (g * (256 - k) + dg * k) / 256; b = (b * (256 - k) + db * k) / 256;
    return (uint16_t)(r << 11 | g << 5 | b);
}

static void cell_raster(const ht_run_t *r, ht_rect_t clip, uint16_t *out)
{
    const ht_cell_frame_t *f = r->bitmap.asset;
    int left = imax(clip.x, r->x), right = imin(clip.x + clip.w, r->x + r->w);
    int top = imax(clip.y, r->y), bottom = imin(clip.y + clip.h, r->y + r->pro_height);
    int cols = f->cols, z = r->radius, cell = f->cell, sw = cols * cell, sh = f->rows * cell;
    row_cache_t rc;
    memset(rc.row, 0xff, sizeof rc.row);
    rc.next = 0;
    if (z >= 8) {
        for (int y = top; y < bottom; y++) {
            int cy = (y - r->y) / cell;
            const uint8_t *row = cache_row(f, &rc, cy);
            uint16_t *dst = out + (y - clip.y) * clip.w + left - clip.x;
            for (int x = left; x < right;) {
                int c = (x - r->x) / cell, end = imin(right, r->x + (c + 1) * cell), n = end - x;
                if (row[c]) {
                    uint16_t v = swapped(f->palette[row[c]]);
                    if (edge_cell(f, &rc, c, cy)) for (int k = 0; k < n; k++) dst[k] = soften(v, dst[k]);
                    else for (int k = 0; k < n; k++) dst[k] = v;
                }
                row = cache_row(f, &rc, cy);   // the lookups above may have evicted it
                dst += n; x = end;
            }
        }
        return;
    }
    // Zoomed: in units where a frame pixel is z wide and a glass pixel 8, each glass pixel is the mean of the
    // frame pixels it overlaps, weighted by overlap; what a transparent pixel leaves uncovered is whatever is
    // already in the output (the ground), so an edge fades into the scene, not into black.
    for (int y = top; y < bottom; y++) {
        int v0 = (y - r->y) * 8, v1 = v0 + 8;
        uint16_t *dst = out + (y - clip.y) * clip.w + left - clip.x;
        for (int x = left; x < right; x++, dst++) {
            int u0 = (x - r->x) * 8, u1 = u0 + 8;
            unsigned rr = 0, gg = 0, bb = 0, cover = 0;
            for (int sy = v0 / z; sy * z < v1 && sy < sh; sy++) {
                int wy = imin(v1, (sy + 1) * z) - imax(v0, sy * z);
                for (int sx = u0 / z; sx * z < u1 && sx < sw; sx++) {
                    unsigned i = cache_row(f, &rc, sy / cell)[sx / cell];
                    if (!i) continue;
                    unsigned w = (unsigned)(wy * (imin(u1, (sx + 1) * z) - imax(u0, sx * z)));
                    uint16_t c = swapped(f->palette[i]);
                    if (edge_cell(f, &rc, sx / cell, sy / cell)) c = soften(c, *dst);
                    rr += (unsigned)(c >> 11) * w; gg += (unsigned)((c >> 5) & 63) * w; bb += (unsigned)(c & 31) * w;
                    cover += w;
                }
            }
            if (!cover) continue;
            unsigned rest = 64 - cover, d = *dst;
            rr += (d >> 11) * rest; gg += ((d >> 5) & 63) * rest; bb += (d & 31) * rest;
            *dst = (uint16_t)(((rr + 32) / 64) << 11 | ((gg + 32) / 64) << 5 | ((bb + 32) / 64));
        }
    }
}

// ---- ring arc -------------------------------------------------------------------------------------------

// sin() of whole degrees 0..90 in Q14, the rest by symmetry; no floating point.
static const int16_t ring_sin[91] = {
    0,286,572,857,1143,1428,1713,1997,2280,2563,2845,3126,3406,
    3686,3964,4240,4516,4790,5063,5334,5604,5872,6138,6402,6664,6924,
    7182,7438,7692,7943,8192,8438,8682,8923,9162,9397,9630,9860,10087,
    10311,10531,10749,10963,11174,11381,11585,11786,11982,12176,12365,12551,12733,
    12911,13085,13255,13421,13583,13741,13894,14044,14189,14330,14466,14598,14726,
    14849,14968,15082,15191,15296,15396,15491,15582,15668,15749,15826,15897,15964,
    16026,16083,16135,16182,16225,16262,16294,16322,16344,16362,16374,16382,16384,
};
static void ring_trig(int deg, int *cs, int *sn)
{
    deg %= 360;
    if (deg < 0) deg += 360;
    int q = deg / 90, a = deg % 90;
    int s = ring_sin[a], c = ring_sin[90 - a];
    switch (q) {
    case 0: *cs = c; *sn = s; break;
    case 1: *cs = -s; *sn = c; break;
    case 2: *cs = -c; *sn = -s; break;
    default: *cs = s; *sn = -c; break;
    }
}
static uint32_t isqrt(uint32_t n)
{
    uint32_t root = 0, bit = 1u << 30;
    while (bit > n) bit >>= 2;
    while (bit) {
        if (n >= root + bit) { n -= root + bit; root = (root >> 1) + bit; }
        else root >>= 1;
        bit >>= 2;
    }
    return root;
}
bool pod_arc(ht_scene_t *s, int cx16, int cy16, int r16, int w16, int mid_deg, int half_deg, uint16_t ink)
{
    if (r16 < 0 || w16 < 0 || w16 > 0xFFFF || r16 > 0x7FFF || half_deg < 0 ||
        cx16 < -0x7FFF || cx16 > 0x7FFF || cy16 < -0x7FFF || cy16 > 0x7FFF) return false;
    if (half_deg > 180) half_deg = 180;
    if (w16 == 0) {   // an empty placeholder: the centre's pixel, no size
        ht_run_t *e = new_run(s, POD_ARC, cx16 >> 4, cy16 >> 4, 0, 0);
        if (!e) return false;
        arc_params_t p = {0};
        p.cx16 = (int16_t)cx16; p.cy16 = (int16_t)cy16;
        memcpy(e->text, &p, sizeof p);
        return true;
    }
    int ux, uy, cs, sn;
    ring_trig(mid_deg, &ux, &uy);
    ring_trig(half_deg, &cs, &sn);
    // The annulus slice's extremes: its two edges at both radii, and every axis it spans at the outer radius.
    int rin = imax(0, r16 - w16 / 2 - 16), rout = r16 + (w16 + 1) / 2 + 16;
    int x0 = cx16, x1 = cx16, y0 = cy16, y1 = cy16;
#define RING_PT(R, ANG) do { int pc, ps; ring_trig(ANG, &pc, &ps); \
        int px = cx16 + ((R) * pc >> 14), py = cy16 - ((R) * ps >> 14); \
        x0 = imin(x0, px); x1 = imax(x1, px); y0 = imin(y0, py); y1 = imax(y1, py); } while (0)
    for (int e = -1; e <= 1; e += 2) { RING_PT(rin, mid_deg + e * half_deg); RING_PT(rout, mid_deg + e * half_deg); }
    for (int axis = 0; axis < 360; axis += 90) {
        int d = ((axis - mid_deg) % 360 + 540) % 360 - 180;   // the axis from mid, -180..179
        if (d >= -half_deg && d <= half_deg) RING_PT(rout, axis);
    }
    if (rin > 0) RING_PT(rin, mid_deg);
#undef RING_PT
    // Whole pixels, a pixel of margin for the ramp and the integer rounding.
    int bx0 = (x0 >> 4) - 1, by0 = (y0 >> 4) - 1, bx1 = ((x1 + 15) >> 4) + 1, by1 = ((y1 + 15) >> 4) + 1;
    ht_run_t *r = new_run(s, POD_ARC, bx0, by0, bx1 - bx0, by1 - by0);
    if (!r) return false;
    arc_params_t p = {(int16_t)cx16, (int16_t)cy16, (uint16_t)r16, (uint16_t)w16,
                      (int16_t)ux, (int16_t)uy, (int16_t)cs};
    memcpy(r->text, &p, sizeof p);
    r->fg = ink;
    return true;
}
static uint16_t mix565(uint16_t fg, uint16_t bg, unsigned a, unsigned levels)
{
    unsigned half = levels / 2;
    unsigned rr = ((fg >> 11) * a + (bg >> 11) * (levels - a) + half) / levels;
    unsigned gg = (((fg >> 5) & 63) * a + ((bg >> 5) & 63) * (levels - a) + half) / levels;
    unsigned bb = ((fg & 31) * a + (bg & 31) * (levels - a) + half) / levels;
    return (uint16_t)((rr << 11) | (gg << 5) | bb);
}
// Each pixel's centre against the band (distance from the centre within half the width of the radius; a
// one-pixel linear ramp is the coverage, in sixteenths) and against the slice (squared dot product with the
// middle direction against |d|^2 cos^2(half), so no angle is computed).
static void arc_raster(const ht_run_t *r, ht_rect_t clip, uint16_t *out)
{
    arc_params_t p;
    memcpy(&p, r->text, sizeof p);
    int x1 = imax(clip.x, r->x), x2 = imin(clip.x + clip.w, r->x + r->w);
    int y1 = imax(clip.y, r->y), y2 = imin(clip.y + clip.h, r->y + r->pro_height);
    int half = p.w16 / 2, rad = p.r16;
    for (int y = y1; y < y2; y++) {
        uint16_t *row = out + (y - clip.y) * clip.w - clip.x;
        int vy = p.cy16 - (y * 16 + 8);
        for (int x = x1; x < x2; x++) {
            int vx = x * 16 + 8 - p.cx16;
            int d = (int)isqrt((uint32_t)(vx * vx + vy * vy));
            int cov = half - (d > rad ? d - rad : rad - d) + 8;   // 16 inside the band, 0 a pixel out
            if (cov <= 0) continue;
            // Inside the slice when cos(angle from mid) >= cos(half); (ux, uy) is unit to 1e-5, hence the
            // 1/4096 of slack at the two ends.
            int64_t dot = (int64_t)vx * p.ux + (int64_t)vy * p.uy;
            int64_t lhs = dot * dot, rhs = (int64_t)(vx * vx + vy * vy) * p.cosh * p.cosh;
            bool in = p.cosh >= 0 ? dot >= 0 && lhs + (lhs >> 12) >= rhs : dot >= 0 || lhs <= rhs + (rhs >> 12);
            if (!in) continue;
            row[x] = cov >= 16 ? r->fg : mix565(r->fg, row[x], (unsigned)cov, 16);
        }
    }
}

// ---- gradient -------------------------------------------------------------------------------------------

bool pod_grad(ht_scene_t *s, int x, int y, int w, int h, int radius, uint16_t top, uint16_t bottom)
{
    if (w <= 0 || h <= 0) return false;
    ht_run_t *r = new_run(s, POD_GRAD, x, y, w, h);
    if (!r) return false;
    r->radius = (uint8_t)imin(imax(0, radius), imin(w, h) / 2);
    r->fg = top;
    grad_params_t p = {top, bottom};
    memcpy(r->text, &p, sizeof p);
    return true;
}
static void grad_raster(const ht_run_t *r, ht_rect_t clip, uint16_t *out)
{
    grad_params_t p;
    memcpy(&p, r->text, sizeof p);
    int x0 = imax(clip.x, r->x), x1 = imin(clip.x + clip.w, r->x + r->w);
    int y0 = imax(clip.y, r->y), y1 = imin(clip.y + clip.h, r->y + r->pro_height);
    int rad = r->radius, last = r->pro_height > 1 ? r->pro_height - 1 : 1;
    for (int y = y0; y < y1; y++) {
        int row = y - r->y, dy = row, inset = 0;
        uint16_t ink = mix565(p.bottom, p.top, (unsigned)row, (unsigned)last);
        if (dy >= r->pro_height - rad) dy = r->pro_height - 1 - dy;
        if (dy < rad) {
            int vertical = rad - 1 - dy;
            while (inset < rad && (rad - 1 - inset) * (rad - 1 - inset) + vertical * vertical > rad * rad) inset++;
        }
        int left = imax(x0, r->x + inset), right = imin(x1, r->x + r->w - inset);
        uint16_t *dst = out + (y - clip.y) * clip.w - clip.x;
        for (int x = left; x < right; x++) dst[x] = ink;
    }
}

// ---- triangle -------------------------------------------------------------------------------------------

typedef struct { int16_t v[6]; uint8_t inner; } tri_params_t;   // x0 y0 x1 y1 x2 y2, sixteenths of a px; edges that bleed
_Static_assert(sizeof(tri_params_t) <= HT_TEXT_BYTES, "triangle parameters fit run->text");

bool pod_tri(ht_scene_t *s, int x0, int y0, int x1, int y1, int x2, int y2, uint16_t ink)
{
    return pod_tri_inner(s, x0, y0, x1, y1, x2, y2, ink, 0);
}
bool pod_tri_inner(ht_scene_t *s, int x0, int y0, int x1, int y1, int x2, int y2, uint16_t ink, unsigned inner)
{
    const int v[6] = {x0, y0, x1, y1, x2, y2};
    for (int i = 0; i < 6; i++) if (v[i] < -0x3FFF || v[i] > 0x3FFF) return false;
    int64_t area = (int64_t)(x1 - x0) * (y2 - y0) - (int64_t)(y1 - y0) * (x2 - x0);
    if (!area) return false;
    int lx = imin(x0, imin(x1, x2)), hx = imax(x0, imax(x1, x2));
    int ly = imin(y0, imin(y1, y2)), hy = imax(y0, imax(y1, y2));
    int bx0 = (lx >> 4) - 1, by0 = (ly >> 4) - 1, bx1 = ((hx + 15) >> 4) + 1, by1 = ((hy + 15) >> 4) + 1;
    ht_run_t *r = new_run(s, POD_TRI, bx0, by0, bx1 - bx0, by1 - by0);
    if (!r) return false;
    tri_params_t p = {{0}, 0};
    for (int i = 0; i < 6; i++) p.v[i] = (int16_t)v[i];
    p.inner = (uint8_t)(inner & 7);
    memcpy(r->text, &p, sizeof p);
    r->fg = ink;
    return true;
}
// Each pixel centre's signed distance to the three edges (inside positive, in sixteenths): the coverage is the
// smallest of them across a ramp one pixel wide centred on the edge, so a pixel on an edge is half inked.
static void tri_raster(const ht_run_t *r, ht_rect_t clip, uint16_t *out)
{
    tri_params_t p;
    memcpy(&p, r->text, sizeof p);
    int64_t area = (int64_t)(p.v[2] - p.v[0]) * (p.v[5] - p.v[1]) - (int64_t)(p.v[3] - p.v[1]) * (p.v[4] - p.v[0]);
    int sign = area < 0 ? -1 : 1;
    int64_t ex[3], ey[3];
    int64_t len[3];
    for (int i = 0; i < 3; i++) {
        int j = (i + 1) % 3;
        ex[i] = p.v[j * 2] - p.v[i * 2]; ey[i] = p.v[j * 2 + 1] - p.v[i * 2 + 1];
        len[i] = (int64_t)isqrt((uint32_t)(ex[i] * ex[i] + ey[i] * ey[i]));
        if (!len[i]) len[i] = 1;
    }
    int x1 = imax(clip.x, r->x), x2 = imin(clip.x + clip.w, r->x + r->w);
    int y1 = imax(clip.y, r->y), y2 = imin(clip.y + clip.h, r->y + r->pro_height);
    for (int y = y1; y < y2; y++) {
        uint16_t *row = out + (y - clip.y) * clip.w - clip.x;
        for (int x = x1; x < x2; x++) {
            int px = x * 16 + 8, py = y * 16 + 8;
            int cov = 16;
            for (int i = 0; i < 3 && cov > 0; i++) {
                int64_t cross = ex[i] * (py - p.v[i * 2 + 1]) - ey[i] * (px - p.v[i * 2]);
                int64_t d = sign * cross / len[i];   // inside positive
                int lo = (p.inner >> i) & 1 ? 16 : 8;   // an inner edge is full on the line and fades over the next pixel
                int c = d >= 8 ? 16 : d <= -lo ? 0 : (int)d + lo;
                if (c < cov) cov = c;
            }
            if (cov <= 0) continue;
            row[x] = cov >= 16 ? r->fg : mix565(r->fg, row[x], (unsigned)cov, 16);
        }
    }
}

void pod_draw_raster(const ht_run_t *r, ht_rect_t clip, uint16_t *out)
{
    if (r->w <= 0 || r->pro_height <= 0) return;
    switch (r->pro_kind) {
    case POD_CELL: cell_raster(r, clip, out); break;
    case POD_ARC: arc_raster(r, clip, out); break;
    case POD_GRAD: grad_raster(r, clip, out); break;
    case POD_TRI: tri_raster(r, clip, out); break;
    default: break;
    }
}
