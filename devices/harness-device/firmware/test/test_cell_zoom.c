// Host test for ht_cell_sprite_zoom (one 2x pet drawing shown at 1x, 1.5x, 1.75x, 2x): the drawn size is the frame's
//   times zoom / 8; a solid frame stays solid inside; a glass pixel is the overlap-weighted mean of the frame pixels
//   it covers over black, and one under a quarter covered is left as it was; strips equal the full raster; and pixel
//   art whose cells land on whole glass pixels (8 px cells at zoom 6 = 6 px) stays exact. A packed frame (transparent
//   runs as (skip, count) pairs, terminal.h) draws exactly as its plain grid at every zoom, in strips too.
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "terminal.h"

static uint16_t full[HT_WIDTH * HT_HEIGHT], part[HT_WIDTH * HT_HEIGHT];
static uint16_t native(uint16_t v) { return (uint16_t)((v >> 8) | (v << 8)); }

int main(void)
{
    static const uint16_t pal[3] = {0, 0xffff, 0x00f8};   // panel order: [1] white, [2] red (0xf800)
    // A 10 x 10 frame of 1 px cells: white, a one-pixel transparent border.
    static uint8_t cells[100];
    for (int y = 0; y < 10; y++) for (int x = 0; x < 10; x++) cells[y * 10 + x] = (x && y && x < 9 && y < 9) ? 1 : 0;
    ht_cell_frame_t fr = {10, 10, 1, pal, cells, NULL};
    for (unsigned z = 1; z <= 8; z++) {
        ht_scene_t s; ht_scene_clear(&s, 0);
        assert(ht_cell_sprite_zoom(&s, 100, 100, &fr, z) && s.count == 1);
        const ht_run_t *r = &s.runs[0];
        int w = (int)((10 * z + 7) / 8);
        assert(r->sprite.width == w && r->sprite.height == w && r->w == w);
        assert(z == 8 ? !r->sprite.zoom : r->sprite.zoom == z);
        memset(full, 0, sizeof full);
        ht_raster(&s, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, full);
        for (int y = 0; y < HT_HEIGHT; y++) for (int x = 0; x < HT_WIDTH; x++) {
            uint16_t v = full[y * HT_WIDTH + x];
            if (x < 100 || y < 100 || x >= 100 + w || y >= 100 + w) { assert(!v); continue; }
            // the glass pixel's span in frame px, and the white share of it
            double u0 = (x - 100) * 8.0 / z, u1 = u0 + 8.0 / z, v0 = (y - 100) * 8.0 / z, v1 = v0 + 8.0 / z;
            double ox = (u1 < 9 ? u1 : 9) - (u0 > 1 ? u0 : 1), oy = (v1 < 9 ? v1 : 9) - (v0 > 1 ? v0 : 1);
            double cover = (ox > 0 ? ox : 0) * (oy > 0 ? oy : 0) / ((u1 - u0) * (v1 - v0));
            if (cover < 0.25 - 1e-9) { assert(!v); continue; }
            uint16_t c = native(v);
            int g = (c >> 5) & 63;
            if (!(g >= (int)(63 * cover) - 1 && g <= (int)(63 * cover + 0.5) + 1)) {
                fprintf(stderr, "z %u at %d,%d cover %.3f green %d\n", z, x, y, cover, g); assert(0);
            }
        }
        // strips equal the full raster
        for (int y0 = 98; y0 < 100 + w + 2; y0 += 3) {
            ht_rect_t clip = {97, (int16_t)y0, 20, 3};
            ht_raster(&s, clip, part);
            for (int y = 0; y < clip.h; y++) for (int x = 0; x < clip.w; x++)
                assert(part[y * clip.w + x] == full[(clip.y + y) * HT_WIDTH + clip.x + x]);
        }
    }
    // Pixel art: a 4 x 4 grid of 8 px cells (a checker of red and white) at zoom 6 is 6 px cells, exact.
    static uint8_t grid[16];
    for (int i = 0; i < 16; i++) grid[i] = ((i / 4 + i % 4) & 1) ? 2 : 1;
    ht_cell_frame_t px = {4, 4, 8, pal, grid, NULL};
    ht_scene_t s; ht_scene_clear(&s, 0);
    assert(ht_cell_sprite_zoom(&s, 50, 60, &px, 6) && s.runs[0].sprite.width == 24);
    memset(full, 0, sizeof full);
    ht_raster(&s, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, full);
    for (int y = 0; y < 24; y++) for (int x = 0; x < 24; x++)
        assert(full[(60 + y) * HT_WIDTH + 50 + x] == pal[grid[(y / 6) * 4 + x / 6]]);
    // Packed: a frame with holes, runs at both edges and a row of nothing, packed as gen_pets.py packs it.
    static uint8_t plain[12 * 9], packed[12 * 9 * 3];
    static uint16_t row_at[9];
    for (int y = 0; y < 9; y++) for (int x = 0; x < 12; x++)
        plain[y * 12 + x] = y == 4 ? 0 : ((x * 7 + y * 3) % 5 == 0 ? 0 : (uint8_t)(1 + (x + y) % 2));
    size_t n = 0;
    for (int y = 0; y < 9; y++) {
        row_at[y] = (uint16_t)n;
        for (int x = 0; x < 12;) {
            int skip = 0, run = 0;
            while (x < 12 && !plain[y * 12 + x]) { skip++; x++; }
            size_t at = n + 2;
            while (x < 12 && plain[y * 12 + x]) { packed[at++] = plain[y * 12 + x]; run++; x++; }
            packed[n] = (uint8_t)skip; packed[n + 1] = (uint8_t)run; n = at;
        }
    }
    for (unsigned cell = 1; cell <= 3; cell += 2) {
        ht_cell_frame_t a = {12, 9, (uint8_t)cell, pal, plain, NULL}, b = {12, 9, (uint8_t)cell, pal, packed, row_at};
        for (int y = 0; y < 9; y++) for (int x = 0; x < 12; x++) assert(ht_cell_at(&b, x, y) == plain[y * 12 + x]);
        for (unsigned z = 1; z <= 8; z++) {
            ht_scene_t sa, sb; ht_scene_clear(&sa, 0); ht_scene_clear(&sb, 0);
            assert(ht_cell_sprite_zoom(&sa, 201, 203, &a, z) && ht_cell_sprite_zoom(&sb, 201, 203, &b, z));
            memset(full, 0, sizeof full); memset(part, 0, sizeof part);
            ht_raster(&sa, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, full);
            ht_raster(&sb, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, part);
            assert(!memcmp(full, part, sizeof full));
            for (int y0 = 200; y0 < 240; y0 += 7) {   // strips of the packed one equal the plain one's full raster
                ht_rect_t clip = {195, (int16_t)y0, 50, 7};
                static uint16_t strip[50 * 7];
                ht_raster(&sb, clip, strip);
                for (int y = 0; y < clip.h; y++) for (int x = 0; x < clip.w; x++)
                    assert(strip[y * clip.w + x] == full[(clip.y + y) * HT_WIDTH + clip.x + x]);
            }
        }
    }
    puts("cell zoom: ok");
    return 0;
}
