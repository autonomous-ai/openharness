#pragma once
#include "character_layout.h"

void ht_illustrated_init(void);
// Renderer only: resolves immutable scene assets into five bounded layer caches.
void ht_illustrated_prepare(ht_scene_t *scene);
bool ht_illustrated_tick_species(ht_character_motion_t *motion, unsigned species, uint32_t now,
    ht_character_mood_t mood, bool quiet, bool visible, bool down, int x,
    unsigned level, uint32_t activity);
bool ht_illustrated_tick(ht_character_motion_t *motion, uint32_t now,
    ht_character_mood_t mood, bool quiet, bool visible, bool down, int x,
    unsigned level, uint32_t activity);
void ht_illustrated_draw(ht_scene_t *scene, unsigned species,
    const ht_character_face_t *face, uint8_t frame, uint16_t ink,
    ht_character_size_t size, int y);
