#pragma once
#include "pro_canvas.h"
#include "pro_daemon.h"
#include "pro_living.h"
void pro_visual_init(void);
// Only the renderer prepares pixels, after releasing the model lock and after
// the previous DMA completes. Old scenes then serve damage comparison only.
void pro_visual_prepare(ht_scene_t *scene);
void pro_visual_background(ht_scene_t *scene, pro_scene_id_t choice, ht_character_id_t daemon);
void pro_visual_landscape(ht_scene_t *scene); // Meadow fixture / original artwork preview.
// Pure queries: never decode, allocate or modify either active/preview motion.
bool pro_visual_changed(const ht_character_t *, ht_character_mood_t, uint32_t now, bool quiet, bool mail);
uint32_t pro_visual_next_wake_ms(const ht_character_t *, ht_character_mood_t, uint32_t now, bool quiet, bool mail);
void pro_visual_character(ht_scene_t *, const ht_character_t *, ht_character_mood_t,
                          bool compact, int x, int y, uint32_t now, bool quiet, bool mail);
// Adapter for the common character registry's portrait/layout entry points.
void pro_visual_paint(ht_scene_t *, ht_character_id_t, const ht_character_face_t *,
                      uint8_t frame, ht_character_size_t, int y);
