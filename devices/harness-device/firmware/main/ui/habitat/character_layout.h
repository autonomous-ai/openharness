#pragma once
#include "character_types.h"
typedef enum {
    HT_CHARACTER_FULL, HT_CHARACTER_COMPACT, HT_CHARACTER_BRIEF,
    HT_CHARACTER_READING, HT_CHARACTER_QUICK
} ht_character_size_t;
enum { HT_CHARACTER_BRIEF_Y = 84, HT_CHARACTER_READING_Y = 82,
       HT_CHARACTER_BRIEF_TEXT_Y = 264, HT_CHARACTER_READING_TEXT_Y = 208,
       HT_CHARACTER_RECAP_CHARS = 90, HT_CHARACTER_RECAP_ROWS = 4,
       HT_NOTIFICATION_Y = 414 };
typedef struct {
    char pane[128];
    uint32_t began, next_ms;
    uint8_t opacity;
    bool initialized, working, activity;
} ht_character_caption_t;
bool ht_character_caption_tick(ht_character_caption_t *caption, uint32_t now,
                                const char *pane, bool working);
uint16_t ht_character_caption_ink(uint16_t foreground, uint16_t background, uint8_t opacity);
typedef void (*ht_character_painter_t)(ht_scene_t *, const ht_character_face_t *, uint8_t frame,
                                      uint16_t ink, ht_character_size_t size, int y);
void ht_character_layout(ht_scene_t *s, const ht_character_face_t *f, uint8_t frame,
                         uint16_t ink, const char *recap, ht_character_painter_t paint);
// Text-only inbox, deliberately distinct from the companion's home recap.
void ht_inbox_card(ht_scene_t *scene, const char *mark, const char *name,
                   const char *message, uint16_t foreground, uint16_t status_ink);
// The same card with the agent's engine badge (an ht_engine glyph) leading its title line, as the
// Focus skin's design draws it. `badge` NULL is exactly ht_inbox_card; "" keeps the badge's run and
// draws nothing, for an agent whose engine this dial does not know.
void ht_inbox_card_badged(ht_scene_t *scene, const char *mark, const char *name,
                          const char *message, uint16_t foreground, uint16_t status_ink,
                          const char *badge, uint16_t badge_ink);
void ht_notification_bell(ht_scene_t *scene, unsigned count, uint16_t ink);
/*
 * The same badge, placed.
 *
 * The creature skins pin it under the companion at HT_NOTIFICATION_Y, which is the row the hint
 * would use and the only space a portrait leaves. A face that fills the footer with its own control
 * has no such row, so it puts the badge at the top — which is also where the device drew it before
 * habitat (mockup/device-screens/png/inbox.png).
 */
void ht_notification_bell_at(ht_scene_t *scene, unsigned count, uint16_t ink, int y);
// The envelope is painted in the character's own cells, attached to its limb.
void ht_character_letter(ht_scene_t *s, const ht_character_face_t *f,
                         const ht_font_t *font, int x, int y);
