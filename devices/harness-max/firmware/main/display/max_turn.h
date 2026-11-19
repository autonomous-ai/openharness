// Harness Max's turn between the glass the app draws and the panel's own raster. Pure C, no ESP-IDF: the host test
// checks it as the device runs it.
//
// The app draws landscape, MAX_GLASS_W x MAX_GLASS_H (the compositor's HT_WIDTH x HT_HEIGHT). The OTA7290B's
// framebuffer is its native portrait, MAX_GLASS_H wide and MAX_GLASS_W tall: landscape (x, y) lands at panel
// (MAX_GLASS_H - 1 - y, x). MAX_TURN_FLIPPED set to 1 turns that by a further 180 degrees, for a panel mounted the
// other way up.
#pragma once
#include <stdint.h>

#define MAX_GLASS_W 1920
#define MAX_GLASS_H 480
#define MAX_TURN_FLIPPED 0
// The same turn as the P4's PPA names it: a counter-clockwise rotation of the landscape rectangle, a quarter clockwise
// (270) unflipped, a quarter counter-clockwise (90) flipped.
#define MAX_TURN_CCW_DEGREES (MAX_TURN_FLIPPED ? 90 : 270)

typedef struct {
    int x, y, w, h;
} max_rect_t;

// A landscape point on the glass -> its panel pixel.
void max_turn_point(int x, int y, int *px, int *py);
// A panel point (what the touch controller reports) -> the landscape point on the glass. The inverse of the above.
void max_turn_touch(int px, int py, int *x, int *y);
// The panel rectangle a landscape rectangle covers: as many pixels, its width and height swapped.
max_rect_t max_turn_rect(max_rect_t glass);
// Turn w x h landscape pixels (rows packed at width w, the rectangle `glass`) into the panel rectangle
// max_turn_rect(glass), rows packed at its width h. `src` and `dst` hold w * h pixels each and must not overlap.
void max_turn_pixels(const uint16_t *src, int w, int h, uint16_t *dst);
