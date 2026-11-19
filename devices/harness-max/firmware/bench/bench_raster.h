// The renderer's paths as the bench times them, the same on the host and on the ESP32-P4. Strips are the device's:
// PRO_STRIP_LINES rows at the rectangle's width, in one buffer of PRO_STRIP_PX pixels.
#pragma once

#include <stdint.h>

#include "pro_display.h"
#include "terminal.h"

#define BENCH_GLASS_STRIPS ((HT_HEIGHT + PRO_STRIP_LINES - 1) / PRO_STRIP_LINES)

// The kinds of work in a raster: the background fill, then one per run kind (the dithered and anti-aliased gradients
// apart from the plain one, as they cost differently).
typedef enum {
    BENCH_BACKGROUND,
    BENCH_TEXT,
    BENCH_RECT,
    BENCH_IMAGE,
    BENCH_RECT_AA,
    BENCH_RECT_AA_STROKE,
    BENCH_CELL,
    BENCH_ARC,
    BENCH_GRAD,
    BENCH_GRAD_AA,
    BENCH_GRAD_DITHER,
    BENCH_TRI,
    BENCH_VEIL,
    BENCH_OTHER,
    BENCH_KINDS
} bench_kind_t;

typedef struct {
    uint64_t ticks[BENCH_KINDS];   // in the caller's clock
    uint64_t px[BENCH_KINDS];      // the pixels each kind's runs cover (the fill's: every pixel)
    uint32_t calls[BENCH_KINDS];
} bench_kinds_t;

// A free-running counter (nanoseconds on the host, CPU cycles on the ESP32-P4); differences are taken modulo 2^32.
typedef uint32_t (*bench_clock_t)(void);

const char *bench_kind_name(bench_kind_t kind);

// The whole glass as max_display.c gets it: full-width strips, top to bottom, ht_raster each into `strip`. Only strips
// first, first + step, ...: (0, 1) is the glass, (0, 2) and (1, 2) its two halves for two cores.
void bench_glass(const ht_scene_t *scene, uint16_t *strip, int first, int step);

// The same strips through ht_raster's own loop, run by run, adding each run's time to its kind in `kinds`.
void bench_glass_kinds(const ht_scene_t *scene, uint16_t *strip, bench_kinds_t *kinds, bench_clock_t clock);

// A frame as pro_frame_present paints it, without the panel: ht_damage, then each damage rectangle in strips (one
// transfer when small). Returns the pixels repainted; `rects` gets the rectangle count.
uint32_t bench_frame(const ht_scene_t *prev, const ht_scene_t *next, uint16_t *strip, int *rects);
