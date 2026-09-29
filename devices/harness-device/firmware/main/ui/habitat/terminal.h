#pragma once
// Allocation-free text compositor. No ESP-IDF, LVGL or floating point.
// Rasterization owns two bounded curved-text caches; call it from one renderer.
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
// THE FACE, as a build fact rather than a literal.
//
// 466 is the round dial and 720 is the Pro. It arrives as a -D from main/CMakeLists.txt instead of from
// sdkconfig.h on purpose: this header is also compiled by the host-side layout and damage benches, which
// have no IDF config at all, and they want the dial's geometry. So the default lives here and only the
// P4 build overrides it.
#ifndef HT_FACE_PX
#define HT_FACE_PX 466
#endif
#define HT_WIDTH HT_FACE_PX
#define HT_HEIGHT HT_FACE_PX
#define HT_RUNS 40
#define HT_TEXT_BYTES 128
#define HT_DAMAGE_MAX 24
typedef struct {
    uint16_t first, last;
    uint8_t width, height;
    const uint8_t *pixels;
} ht_font_t;
extern const ht_font_t ht_mono_16, ht_mono_20, ht_mono_24, ht_mono_28, ht_pixel_40;
// Precomputed curved-label and larger inbox navigation glyphs.
extern const ht_font_t ht_open_20, ht_nav_32;
extern const uint8_t ht_mono_20_ink[224][4], ht_open_20_ink[1][4];
extern const ht_font_t ht_right_20, ht_right_28, ht_open_28;
extern const uint8_t ht_right_20_ink[1][4];
// One authored outline bell in a normal terminal cell, not an emoji font.
#define HT_BELL "\xee\x80\x80"
extern const ht_font_t ht_bell_20, ht_bell_28;
extern const ht_font_t ht_bell_footer, ht_done_28, ht_failed_28;
#define HT_DONE "\xe2\x9c\x93"
#define HT_FAILED "\xe2\x9c\x97"
extern const uint8_t ht_bell_20_ink[1][4];
// The lock's dot is the only 40 px glyph used by the daily UI. Keep its exact
// pixels without retaining the other 94 glyphs of the gallery font in flash.
extern const ht_font_t ht_lock_dot;
typedef struct {
    int16_t x, y, w, h;
} ht_rect_t;
typedef struct {
    int16_t x, y, w;
    uint8_t arc; // 0 = straight, 1 = upper arc, 2 = lower arc
    uint8_t shimmer; // 0 = steady ink, 1..21 = cached-mask highlight sweep
    uint16_t fg, bg;
    const ht_font_t *font;
    char text[HT_TEXT_BYTES];
    // Optional immutable RGB565 foreground per text cell (straight runs only).
    // At least as many entries as text cells; storage outlives both scenes.
    const uint16_t *colors;
    // Streaming companion art must survive replacement while the previous
    // scene is still being rasterized. These colors travel with scene copies.
    uint8_t cell_color_count;
    uint16_t cell_colors[56];
} ht_run_t;
static inline uint16_t ht_run_ink(const ht_run_t *run, unsigned cell) {
    return cell < run->cell_color_count ? run->cell_colors[cell] :
        run->colors ? run->colors[cell] : run->fg;
}
typedef struct {
    uint16_t background;
    uint8_t count;
    ht_run_t runs[HT_RUNS];
} ht_scene_t;
enum { HT_ARC_COLS = 32, HT_ARC_X = 25, HT_ARC_Y = 12,
       HT_ARC_WIDTH = 416, HT_ARC_HEIGHT = 128 };
typedef struct {
    uint8_t count;
    ht_rect_t rect[HT_DAMAGE_MAX];
    uint32_t pixels;
} ht_damage_t;
uint16_t ht_rgb(unsigned rgb);
void ht_scene_clear(ht_scene_t *scene, uint16_t background);
bool ht_text(ht_scene_t *scene, int x, int y, int width, const ht_font_t *font, uint16_t fg,
             uint16_t bg, const char *text);
// Prevalidated printable ASCII assets: exactly `cells` readable bytes, one cell
// each. Copies into the scene; no UTF-8 scan, allocation, or retained pointer.
bool ht_ascii_text(ht_scene_t *scene, int x, int y, int width, const ht_font_t *font,
                   uint16_t fg, uint16_t bg, const char *text, size_t cells);
void ht_center(ht_scene_t *scene, int y, const ht_font_t *font, uint16_t fg, const char *text);
// Fixed 20 px upper/lower arcs. Text stays in the scene; each mask is cached on
// first rasterization and reused across strips, animation and color changes.
void ht_arc_title(ht_scene_t *scene, uint16_t fg, const char *text);
void ht_arc_status(ht_scene_t *scene, uint16_t fg, const char *text);
// Same conservative bounds used for damage; useful for matching curved hit areas.
ht_rect_t ht_run_bounds(const ht_run_t *run);
uint32_t ht_arc_cache_builds(void);
// A 1.28-second sweep and 0.768-second rest. Pure, wrap-safe integer clock.
uint8_t ht_shimmer_phase(uint32_t now);
uint32_t ht_shimmer_wake_ms(uint32_t now);
#ifdef DEVICE_LAYOUT_BENCH
void ht_arc_fast_sampling(bool enabled);
void ht_arc_tight_bounds(bool enabled);
void ht_damage_fast_ascii(bool enabled);
void ht_damage_banded(bool enabled);
void ht_raster_fast_ascii(bool enabled);
#endif
// Bounded small-ASCII cache. Toggle only from the renderer, for A/B profiling.
void ht_glyph_cache_enable(bool enabled);
uint32_t ht_glyph_cache_builds(void);
size_t ht_glyph_cache_bytes(void);
// Consume one word-wrapped UTF-8 line; shared by rectangular and round reading areas.
const char *ht_take_line(const char **cursor, int cells);
// Display-only normalization, before measuring/wrapping. Bounded, no allocation;
// false means the destination was truncated. Source and destination must differ.
bool ht_display_text(char *dst, size_t capacity, const char *src, const ht_font_t *font);
const char *ht_take_display_line(const char **cursor, int cells, const ht_font_t *font);
int ht_wrap(ht_scene_t *scene, int x, int y, int width, int lines, int skip, const ht_font_t *font,
            uint16_t fg, const char *text);
void ht_damage(const ht_scene_t *before, const ht_scene_t *after, ht_damage_t *out);
// Output is RGB565 in THIS BOARD'S panel order — byte-swapped for the dial's CO5300 over QSPI, native
// for the Pro's ST7703 DPI framebuffer. See panel16() in terminal.c. Buffer holds region.w * region.h.
void ht_raster(const ht_scene_t *scene, ht_rect_t region, uint16_t *out);
uint32_t ht_utf8_next(const char **cursor);
// Question/answer text must fit in full and contain glyphs available on this device.
bool ht_can_display(const char *text, const ht_font_t *font, int width, int lines);
int ht_text_rows(const char *text, const ht_font_t *font, int width);
