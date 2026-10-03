#pragma once
#include "character_layout.h"

// IDs are stored in NVS. Append new characters; never renumber existing IDs.
typedef enum {
    HT_CHARACTER_TIM = 0, HT_CHARACTER_TUX = 1, HT_CHARACTER_FOCUS = 2,
    HT_CHARACTER_ILLUSTRATED_TIM, HT_CHARACTER_GNU, HT_CHARACTER_LYNX,
    HT_CHARACTER_MUTT, HT_CHARACTER_YAK, HT_CHARACTER_GOPHER, HT_CHARACTER_BUG,
    HT_CHARACTER_ILLUSTRATED_TUX, HT_CHARACTER_AUK, HT_CHARACTER_BEASTIE,
    HT_CHARACTER_COUNT
} ht_character_id_t;
typedef struct {
    ht_character_id_t id;
    ht_character_motion_t motion;
    ht_companion_style_t companion_style;
    struct {
        uint32_t sequence, began;
        uint8_t lift;
        bool initialized, moving;
    } delivery;
} ht_character_t;

ht_character_id_t ht_character_default(void);
const char *ht_character_name(ht_character_id_t id);
// Stable desktop species keys. NULL/unknown returns COUNT, never a default companion.
ht_character_id_t ht_character_companion(const char *species);
const char *ht_character_species(ht_character_id_t id);
bool ht_character_select(ht_character_t *character, ht_character_id_t id);
bool ht_character_tick(ht_character_t *character, uint32_t now, ht_character_mood_t mood,
                       bool quiet, bool visible, bool down, int x, unsigned level, uint32_t activity);
// A live delivery briefly lifts the held letter. Restored unread state stays still;
// a hidden, quiet or listening character never queues a surprise animation later.
bool ht_character_delivery_tick(ht_character_t *character, uint32_t now, bool pending,
                                uint32_t sequence, bool animate);
void ht_character_face(ht_scene_t *scene, const ht_character_t *character,
                       const ht_character_face_t *face, uint16_t ink, const char *recap);
void ht_character_portrait(ht_scene_t *scene, const ht_character_t *character,
                           const ht_character_face_t *face, uint16_t ink,
                           ht_character_size_t size, int y);
