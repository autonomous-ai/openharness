#pragma once
#include "octopus.h"

// Captured .48 renderer/art layout, compiled only into diagnostic programs.
void ht48_octopus_face(ht_scene_t *scene, const ht_tim_face_t *face, uint8_t frame,
                        uint16_t ink, const char *recap);
void ht48_damage(const ht_scene_t *before, const ht_scene_t *after, ht_damage_t *out);
void ht48_raster(const ht_scene_t *scene, ht_rect_t region, uint16_t *out);
