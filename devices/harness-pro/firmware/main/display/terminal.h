#pragma once
// Allocation-free scene compositor for the Pro's 720 x 720 glass. No ESP-IDF, LVGL or floating point.
// A scene is a list of runs (text, rectangles, images and Pod's drawing kinds, see pro_canvas.h); damage compares
// two scenes and the rasteriser paints any region of one. Call it from one renderer.
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifndef HT_FACE_PX
#define HT_FACE_PX 720
#endif
#define HT_WIDTH HT_FACE_PX
#define HT_HEIGHT HT_FACE_PX
// A pet scene alone can take 40 runs, beside the status bar and the transport. Scenes live in PSRAM
// (EXT_RAM_BSS_ATTR where they are declared) for this.
#define HT_RUNS 128
#define HT_TEXT_BYTES 128
#define HT_DAMAGE_MAX 24

typedef struct {
    int16_t x, y, w, h;
} ht_rect_t;
typedef struct ht_pro_font ht_pro_font_t;
typedef struct {
    const uint16_t *pixels;
    const uint8_t *alpha;
    uint16_t width, height;
    uint32_t revision;
    // Optional immutable art descriptor. Scene construction records this without decoding. The renderer resolves
    // pixels/alpha after model unlock, before damage/raster; old scenes subsequently serve damage comparison only.
    const void *asset;
} ht_pro_bitmap_t;
typedef struct {
    int16_t x, y, w;
    uint16_t fg;
    char text[HT_TEXT_BYTES];   // a text run's UTF-8, or a Pod drawing kind's packed parameters
    uint8_t pro_kind, radius;   // radius doubles as an image's opacity (ht_pro_image_faded)
    int16_t pro_height;
    const ht_pro_font_t *pro_font;
    ht_pro_bitmap_t bitmap;
} ht_run_t;
typedef struct {
    uint16_t background;
    uint8_t count;
    ht_run_t runs[HT_RUNS];
} ht_scene_t;
typedef struct {
    uint8_t count;
    ht_rect_t rect[HT_DAMAGE_MAX];
    uint32_t pixels;
} ht_damage_t;

uint16_t ht_rgb(unsigned rgb);
void ht_scene_clear(ht_scene_t *scene, uint16_t background);
// The box a run paints, used for damage and for matching hit areas.
ht_rect_t ht_run_bounds(const ht_run_t *run);
// Display-only normalization, before measuring/wrapping: whatever the Pro's atlases cannot draw becomes an ASCII
// equivalent or "[U+XXXX]". Bounded, no allocation; false means the destination was truncated. Source and
// destination must differ.
bool ht_display_text(char *dst, size_t capacity, const char *src);
void ht_damage(const ht_scene_t *before, const ht_scene_t *after, ht_damage_t *out);
// Output is RGB565 in the ST7703 framebuffer's own (little-endian, unswapped) order. Buffer holds
// region.w * region.h.
void ht_raster(const ht_scene_t *scene, ht_rect_t region, uint16_t *out);
uint32_t ht_utf8_next(const char **cursor);
