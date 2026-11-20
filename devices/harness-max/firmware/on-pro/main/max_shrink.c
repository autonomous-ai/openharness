#include "max_shrink.h"

#include <string.h>

_Static_assert(MAX_SHRINK_GLASS_W % MAX_SHRINK_BLOCK == 0 && MAX_SHRINK_GLASS_H % MAX_SHRINK_BLOCK == 0,
               "the glass is whole blocks");
_Static_assert(MAX_SHRINK_BAND_W == MAX_SHRINK_PANEL, "the band is the panel's width");

static int imin(int a, int b) { return a < b ? a : b; }
static int imax(int a, int b) { return a > b ? a : b; }

max_shrink_rect_t max_shrink_blocks(max_shrink_rect_t g)
{
    const int x0 = imax(g.x, 0), y0 = imax(g.y, 0);
    const int x1 = imin(g.x + g.w, MAX_SHRINK_GLASS_W), y1 = imin(g.y + g.h, MAX_SHRINK_GLASS_H);
    if (g.w <= 0 || g.h <= 0 || x1 <= x0 || y1 <= y0) return (max_shrink_rect_t){0, 0, 0, 0};
    const int bx0 = x0 / MAX_SHRINK_BLOCK * MAX_SHRINK_BLOCK, by0 = y0 / MAX_SHRINK_BLOCK * MAX_SHRINK_BLOCK;
    const int bx1 = (x1 + MAX_SHRINK_BLOCK - 1) / MAX_SHRINK_BLOCK * MAX_SHRINK_BLOCK;
    const int by1 = (y1 + MAX_SHRINK_BLOCK - 1) / MAX_SHRINK_BLOCK * MAX_SHRINK_BLOCK;
    return (max_shrink_rect_t){bx0, by0, bx1 - bx0, by1 - by0};
}

max_shrink_rect_t max_shrink_panel(max_shrink_rect_t b)
{
    return (max_shrink_rect_t){b.x / MAX_SHRINK_BLOCK * MAX_SHRINK_CELLS,
                               MAX_SHRINK_BAND_Y + b.y / MAX_SHRINK_BLOCK * MAX_SHRINK_CELLS,
                               b.w / MAX_SHRINK_BLOCK * MAX_SHRINK_CELLS, b.h / MAX_SHRINK_BLOCK * MAX_SHRINK_CELLS};
}

// Along either axis a block's 8 glass pixels give its 3 band pixels, each the glass it spans weighted by how much of
// each pixel it covers, times 3 so the weights are whole: 3 3 2 | 1 3 3 1 | 2 3 3, each band pixel's adding to 8. The
// two axes' weights multiply to 64, so a band pixel is its 64ths, rounded once at the end.
//
// Each glass row of a block row is summed across first (glass row -> the band pixels' sums along it, per channel, at
// most 8 x 63), then added into the three band rows by its own weight down: at most 64 x 63, a uint16_t.
static uint16_t s_sum[MAX_SHRINK_CELLS][MAX_SHRINK_BAND_W][3];

static inline void add_down(int s, int x, const int across[3])
{
    // Glass row s of the block in band rows 0..2: 3 3 2 0 0 0 0 0 | 0 0 1 3 3 1 0 0 | 0 0 0 0 0 2 3 3.
    static const uint8_t DOWN[MAX_SHRINK_BLOCK][MAX_SHRINK_CELLS] = {
        {3, 0, 0}, {3, 0, 0}, {2, 1, 0}, {0, 3, 0}, {0, 3, 0}, {0, 1, 2}, {0, 0, 3}, {0, 0, 3},
    };
    for (int k = 0; k < MAX_SHRINK_CELLS; k++) {
        const int w = DOWN[s][k];
        if (!w) continue;
        uint16_t *sum = s_sum[k][x];
        sum[0] = (uint16_t)(sum[0] + w * across[0]);
        sum[1] = (uint16_t)(sum[1] + w * across[1]);
        sum[2] = (uint16_t)(sum[2] + w * across[2]);
    }
}

void max_shrink_paint(const uint16_t *glass, max_shrink_rect_t b, uint16_t *out)
{
    const int blocks = b.w / MAX_SHRINK_BLOCK, ow = blocks * MAX_SHRINK_CELLS;
    if (blocks <= 0 || ow > MAX_SHRINK_BAND_W || b.h <= 0) return;
    for (int by = b.y; by < b.y + b.h; by += MAX_SHRINK_BLOCK) {
        for (int k = 0; k < MAX_SHRINK_CELLS; k++) memset(s_sum[k], 0, (size_t)ow * sizeof s_sum[k][0]);
        for (int s = 0; s < MAX_SHRINK_BLOCK; s++) {
            const uint16_t *row = glass + (size_t)(by + s) * MAX_SHRINK_GLASS_W + b.x;
            for (int c = 0; c < blocks; c++, row += MAX_SHRINK_BLOCK) {
                int p[3][MAX_SHRINK_BLOCK];   // the block row's 8 pixels, channel by channel
                for (int i = 0; i < MAX_SHRINK_BLOCK; i++) {
                    p[0][i] = row[i] >> 11;
                    p[1][i] = (row[i] >> 5) & 63;
                    p[2][i] = row[i] & 31;
                }
                int a0[3], a1[3], a2[3];
                for (int ch = 0; ch < 3; ch++) {
                    const int *q = p[ch];
                    a0[ch] = 3 * q[0] + 3 * q[1] + 2 * q[2];
                    a1[ch] = q[2] + 3 * q[3] + 3 * q[4] + q[5];
                    a2[ch] = 2 * q[5] + 3 * q[6] + 3 * q[7];
                }
                add_down(s, c * MAX_SHRINK_CELLS + 0, a0);
                add_down(s, c * MAX_SHRINK_CELLS + 1, a1);
                add_down(s, c * MAX_SHRINK_CELLS + 2, a2);
            }
        }
        uint16_t *dst = out + (size_t)(by - b.y) / MAX_SHRINK_BLOCK * MAX_SHRINK_CELLS * ow;
        for (int k = 0; k < MAX_SHRINK_CELLS; k++, dst += ow)
            for (int x = 0; x < ow; x++) {
                const uint16_t *sum = s_sum[k][x];
                dst[x] = (uint16_t)(((sum[0] + 32) >> 6) << 11 | ((sum[1] + 32) >> 6) << 5 | ((sum[2] + 32) >> 6));
            }
    }
}

bool max_shrink_touch(int px, int py, int *gx, int *gy)
{
    if (px < 0 || px >= MAX_SHRINK_BAND_W || py < MAX_SHRINK_BAND_Y || py >= MAX_SHRINK_BAND_Y + MAX_SHRINK_BAND_H)
        return false;
    // Band pixel p spans glass [8p / 3, 8(p + 1) / 3): its middle is (8p + 4) / 3.
    *gx = (MAX_SHRINK_BLOCK * px + MAX_SHRINK_BLOCK / 2) / MAX_SHRINK_CELLS;
    *gy = (MAX_SHRINK_BLOCK * (py - MAX_SHRINK_BAND_Y) + MAX_SHRINK_BLOCK / 2) / MAX_SHRINK_CELLS;
    return true;
}

static bool empty(max_shrink_rect_t r) { return r.w <= 0 || r.h <= 0; }
static long area(max_shrink_rect_t r) { return (long)r.w * r.h; }

static max_shrink_rect_t join(max_shrink_rect_t a, max_shrink_rect_t b)
{
    const int x0 = imin(a.x, b.x), y0 = imin(a.y, b.y);
    const int x1 = imax(a.x + a.w, b.x + b.w), y1 = imax(a.y + a.h, b.y + b.h);
    return (max_shrink_rect_t){x0, y0, x1 - x0, y1 - y0};
}

void max_shrink_damage_add(max_shrink_damage_t *d, max_shrink_rect_t glass)
{
    max_shrink_rect_t r = max_shrink_blocks(glass);
    if (empty(r)) return;
    // Joined with every rectangle it costs no pixels to join (again with the union, which may reach another), else
    // kept apart; with no room left, joined with the one it grows least.
    for (;;) {
        int with = -1;
        for (int i = 0; i < d->n && with < 0; i++)
            if (area(join(d->r[i], r)) <= area(d->r[i]) + area(r)) with = i;
        if (with < 0 && d->n == MAX_SHRINK_RECTS) {
            long least = -1;
            for (int i = 0; i < d->n; i++) {
                const long grows = area(join(d->r[i], r)) - area(d->r[i]);
                if (least < 0 || grows < least) least = grows, with = i;
            }
        }
        if (with < 0) {
            d->r[d->n++] = r;
            return;
        }
        r = join(d->r[with], r);   // out of the set, and in again as the union
        d->r[with] = d->r[--d->n];
    }
}
