// Harness Max on a Harness Pro (on-pro/): the Max's 1920 x 480 glass shrunk by 3/8 into a 720 x 180 band across the
// middle of the Pro's 720 x 720 panel, and the panel's touches taken back to the glass. Pure C, no ESP-IDF: the host
// test (test/test_max_shrink.c) checks it as the Pro runs it.
//
// Each 8 x 8 block of the glass becomes 3 x 3 band pixels, each the average of the glass it covers (a band pixel spans
// 8/3 glass pixels along each axis, so the glass pixels on its edges count in part). Thin strokes thin out evenly
// instead of losing whole rows and columns, as sampling one pixel in three would.
#pragma once

#include <stdbool.h>
#include <stdint.h>

#define MAX_SHRINK_GLASS_W 1920
#define MAX_SHRINK_GLASS_H 480
#define MAX_SHRINK_BLOCK 8          // glass pixels a block, along each axis …
#define MAX_SHRINK_CELLS 3          // … and the band pixels they become
#define MAX_SHRINK_PANEL 720        // the Pro's square panel
#define MAX_SHRINK_BAND_W (MAX_SHRINK_GLASS_W * MAX_SHRINK_CELLS / MAX_SHRINK_BLOCK)   // 720: the panel's width
#define MAX_SHRINK_BAND_H (MAX_SHRINK_GLASS_H * MAX_SHRINK_CELLS / MAX_SHRINK_BLOCK)   // 180
#define MAX_SHRINK_BAND_Y ((MAX_SHRINK_PANEL - MAX_SHRINK_BAND_H) / 2)                 // 270: the band centred

typedef struct {
    int x, y, w, h;
} max_shrink_rect_t;

// The glass rectangle `glass`, clipped to the glass and grown to whole blocks: what a change inside it repaints.
// Empty (w == 0) when nothing of it is on the glass.
max_shrink_rect_t max_shrink_blocks(max_shrink_rect_t glass);

// Where the whole blocks `blocks` land on the panel: 3/8 of them, in the band.
max_shrink_rect_t max_shrink_panel(max_shrink_rect_t blocks);

// The band pixels of the whole blocks `blocks`, from `glass` (RGB565, rows of MAX_SHRINK_GLASS_W) into `out` (RGB565,
// rows packed at max_shrink_panel(blocks).w). At most MAX_SHRINK_GLASS_W wide. One caller at a time: its sums are
// static, too big for a task's stack.
void max_shrink_paint(const uint16_t *glass, max_shrink_rect_t blocks, uint16_t *out);

// A panel point (what the touch controller reports) -> the glass point under its middle. False off the band.
bool max_shrink_touch(int px, int py, int *gx, int *gy);

// The changes of one frame, as whole blocks, joined into at most MAX_SHRINK_RECTS rectangles: pets moving at both ends
// of the glass repaint the pets, not the glass between them.
#define MAX_SHRINK_RECTS 4
typedef struct {
    max_shrink_rect_t r[MAX_SHRINK_RECTS];
    int n;
} max_shrink_damage_t;

// A change to the glass rectangle `glass`. Its blocks join a rectangle already kept when their union is no more pixels
// than the two apart (the strips of one change, a change inside another); with MAX_SHRINK_RECTS kept apart already,
// they join the one whose union grows least.
void max_shrink_damage_add(max_shrink_damage_t *d, max_shrink_rect_t glass);
