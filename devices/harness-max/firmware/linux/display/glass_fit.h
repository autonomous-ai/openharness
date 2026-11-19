// How the glass the app draws lands on a Linux output's raster, and how a touch comes back. The picture is scaled by one
// factor to fit, centred, and turned a quarter when the output's native mode is portrait: the Orange Pi's bar scans a
// 320 x 1480 raster for a 1480 x 320 picture. Pure C, no Linux: the host test checks it as the program runs it.
//
// "Landscape" coordinates are the raster seen the right way up. Turned, landscape (x, y) lies at raster
// (y, LW - 1 - x), LW the landscape width: the picture's left edge runs along the raster's bottom row. That is the
// Near demo's flutter-pi `-r 270` on the same bar, whose kmsgrab capture reads upright after a 90 degree clockwise turn.
#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef struct {
    int x, y, w, h;
} glass_fit_rect_t;

typedef struct {
    int glass_w, glass_h;   // the app's glass: HT_WIDTH x HT_HEIGHT
    int out_w, out_h;       // the output's raster as its native mode scans it
    bool turned;            // out_h > out_w: the landscape picture lies on its side in the raster
    glass_fit_rect_t pic;     // the scaled picture in landscape coordinates; the rest of the raster stays black
} glass_fit_t;

glass_fit_t glass_fit(int glass_w, int glass_h, int out_w, int out_h);

// The picture pixels (landscape) that a change to the glass rectangle `glass` reaches through the filter: each picture
// pixel blends the 2 x 2 glass pixels around the point it samples. Empty (w == 0) when it reaches none.
glass_fit_rect_t glass_fit_damage(const glass_fit_t *f, glass_fit_rect_t glass);

// Paint the picture pixels of `land` (landscape, inside f->pic) from `glass` (RGB565, rows of glass_w) into `out`
// (XRGB8888, rows of `stride` pixels, the output's raster). The writes run in raster order: a scanout buffer is often
// write-combined, where scattered writes are slow.
void glass_fit_paint(const glass_fit_t *f, const uint16_t *glass, glass_fit_rect_t land, uint32_t *out, int stride);

// The smallest rectangle holding both; an empty one (w or h of 0) adds nothing.
glass_fit_rect_t glass_fit_union(glass_fit_rect_t a, glass_fit_rect_t b);

// What a double-buffered output repaints before it flips. The buffer off screen was last painted two frames ago, so to
// show the frame being drawn it needs what this frame changed and what the last one changed: the last frame was painted
// into the other buffer only. Picture pixels (landscape), as glass_fit_damage gives them.
typedef struct {
    glass_fit_rect_t pending;   // changed since the last frame was shown
    glass_fit_rect_t last;      // what the last frame shown changed
} glass_fit_flip_t;

// A change to the frame being drawn.
void glass_fit_flip_add(glass_fit_flip_t *f, glass_fit_rect_t r);

// The frame is whole: the rectangles to paint into the buffer off screen before flipping to it, in out[0..n), n <= 2:
// the two changes, or their union when that paints fewer pixels. 0 when the frame changed nothing: then there is no
// flip, and `last` stays, as the buffer off screen still lacks it.
int glass_fit_flip(glass_fit_flip_t *f, glass_fit_rect_t out[2]);

// A raster point (a touch, in the output's native frame) -> the glass point under it. False off the picture.
bool glass_fit_touch(const glass_fit_t *f, int ox, int oy, int *gx, int *gy);

// A touchscreen's absolute axis value in [min, max] -> a raster coordinate in [0, size), as libinput scales it.
int glass_fit_axis(int value, int min, int max, int size);
