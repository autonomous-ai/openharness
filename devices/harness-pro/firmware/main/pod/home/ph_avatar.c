// A Buddy's avatar (the desktop's superTabAgentPattern, avatar_art.dart): a disc of diameter d with a 3 px ring, and a 5 x 5 pattern of rounded cells
// spanning d * 56 / 100, centred. The 15 bits are the left half: cell (row, col) is lit when bit row * 3 + [0, 1, 2, 1, 0][col] is set, so the right two
// columns mirror the left. Fill is the colour 22 % over the background, the ring 33 %. At most 27 runs: the ring, the fill and up to 25 cells.
#include "pod/home/ph.h"
#include "pro_canvas.h"

#define C(rgb) ht_rgb(rgb)
enum { RING = 3, FILL_PCT = 22, RING_PCT = 33, PATTERN_PCT = 56, GRID = 5 };

void ph_buddy_avatar(ht_scene_t *s, int x, int y, int d, uint16_t cells, uint32_t color, unsigned bg)
{
    static const uint8_t mirror[GRID] = { 0, 1, 2, 1, 0 };
    ht_pro_rect_aa(s, x, y, d, d, d / 2, C(ph_mix(color, bg, RING_PCT)));
    ht_pro_rect_aa(s, x + RING, y + RING, d - 2 * RING, d - 2 * RING, d / 2 - RING, C(ph_mix(color, bg, FILL_PCT)));
    int cell = d * PATTERN_PCT / 100 / GRID;
    int ox = x + (d - GRID * cell) / 2, oy = y + (d - GRID * cell) / 2;
    for (int r = 0; r < GRID; r++)
        for (int c = 0; c < GRID; c++)
            if (cells >> (r * 3 + mirror[c]) & 1) ht_pro_rect_aa(s, ox + c * cell, oy + r * cell, cell, cell, cell / 5, C(color));
}
