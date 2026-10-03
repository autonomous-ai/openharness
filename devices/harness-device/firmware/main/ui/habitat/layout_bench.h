#pragma once
#include "terminal.h"

// Diagnostic-only hooks. The final DMA fence is shared by both renderer paths.
void ht_layout_raster(const ht_scene_t *scene, ht_rect_t region, uint16_t *out);
void ht_layout_benchmark(uint16_t *scratch, ht_scene_t *a, ht_scene_t *b,
                         uint32_t (*paint)(const ht_scene_t *, const ht_damage_t *));
