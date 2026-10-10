#pragma once
// Types Pod shares with the dial's generated pets (pets.h). They match the round dial's terminal.h field for
// field; the Pro's terminal.h has neither. ht_cell_at is implemented in pod_draw.c.
#include <stdbool.h>
#include <stdint.h>
#include "../terminal.h"
#include "engine_logos.h"

typedef struct {
    uint8_t cols, rows, cell;
    const uint16_t *palette;   // panel byte order
    const uint8_t *cells;
    const uint16_t *row_at;
} ht_cell_frame_t;

typedef struct { uint16_t w, h; const uint16_t *px; const uint8_t *a; } ht_icon_t;

uint8_t ht_cell_at(const ht_cell_frame_t *frame, int col, int row);

// One pre-rendered logo: size x size RGB565 in native order (ht_pro_image wants native) plus alpha8, from
// scripts/pod_gen_logos.py. Pod never scales a logo at runtime: it draws one of the sizes in pod_logo_sizes.
typedef struct { uint16_t size; const uint16_t *px; const uint8_t *a; } pod_logo_t;
// light: the art is pale enough to vanish on white glass, so it sits on a dark chip / cover. logos: one per pod_logo_sizes.
typedef struct { const char *engine; bool light; const pod_logo_t *logos; } pod_mark_t;
extern const pod_mark_t pod_marks[];
extern const unsigned pod_mark_count;
const pod_mark_t *pod_mark(const char *engine);
