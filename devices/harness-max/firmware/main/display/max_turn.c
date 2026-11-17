#include "max_turn.h"

void max_turn_point(int x, int y, int *px, int *py)
{
    if (MAX_TURN_FLIPPED) {
        *px = y;
        *py = MAX_GLASS_W - 1 - x;
    } else {
        *px = MAX_GLASS_H - 1 - y;
        *py = x;
    }
}

void max_turn_touch(int px, int py, int *x, int *y)
{
    if (MAX_TURN_FLIPPED) {
        *x = MAX_GLASS_W - 1 - py;
        *y = px;
    } else {
        *x = py;
        *y = MAX_GLASS_H - 1 - px;
    }
}

max_rect_t max_turn_rect(max_rect_t glass)
{
    // The turn of the two opposite corners; whichever lands lower on each panel axis starts the rectangle.
    int ax, ay, bx, by;
    max_turn_point(glass.x, glass.y, &ax, &ay);
    max_turn_point(glass.x + glass.w - 1, glass.y + glass.h - 1, &bx, &by);
    return (max_rect_t){ax < bx ? ax : bx, ay < by ? ay : by, glass.h, glass.w};
}

void max_turn_pixels(const uint16_t *src, int w, int h, uint16_t *dst)
{
    // One panel row (h pixels) is one landscape column, so the writes run in order and the reads stride by w.
    for (int c = 0; c < w; c++) {
        uint16_t *row = dst + (MAX_TURN_FLIPPED ? w - 1 - c : c) * h;
        const uint16_t *col = src + c;
        if (MAX_TURN_FLIPPED)
            for (int r = 0; r < h; r++) row[r] = col[r * w];
        else
            for (int r = 0; r < h; r++) row[h - 1 - r] = col[r * w];
    }
}
