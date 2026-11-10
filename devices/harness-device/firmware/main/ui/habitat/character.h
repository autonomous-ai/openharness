#pragma once
#include "character_layout.h"

// Focus is the dial's only character. Nothing is stored: whatever id an older firmware saved
// is not read, and ht_character_select() answers Focus to any id.
typedef enum { HT_CHARACTER_FOCUS = 0, HT_CHARACTER_COUNT } ht_character_id_t;
typedef struct {
    ht_character_id_t id;
    ht_character_motion_t motion;
} ht_character_t;

ht_character_id_t ht_character_default(void);
const char *ht_character_name(ht_character_id_t id);
// Any id selects Focus; it is the only character there is.
bool ht_character_select(ht_character_t *character, ht_character_id_t id);
bool ht_character_tick(ht_character_t *character, uint32_t now, ht_character_mood_t mood,
                       bool quiet, bool visible, bool down, int x, unsigned level, uint32_t activity);
void ht_character_face(ht_scene_t *scene, const ht_character_t *character,
                       const ht_character_face_t *face, uint16_t ink, const char *recap);
