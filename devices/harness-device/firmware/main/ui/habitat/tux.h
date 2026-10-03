#pragma once
#include "character_layout.h"
bool ht_tux_motion_tick(ht_character_motion_t *m, uint32_t now, ht_character_mood_t mood,
                        bool quiet, bool visible, bool down, int x, unsigned level, uint32_t activity);
void ht_tux_draw(ht_scene_t *scene, const ht_character_face_t *face, uint8_t frame,
                 uint16_t ink, ht_character_size_t size, int y);
