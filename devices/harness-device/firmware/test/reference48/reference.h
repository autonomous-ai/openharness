#pragma once
#include "terminal.h"

// Captured .48 renderer, compiled only into diagnostic programs.
void ht48_damage(const ht_scene_t *before, const ht_scene_t *after, ht_damage_t *out);
void ht48_raster(const ht_scene_t *scene, ht_rect_t region, uint16_t *out);
