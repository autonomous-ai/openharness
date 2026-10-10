// DEVICE_POD links neither the Living portraits (pro_living.c, pro_living.pack) nor the Daemon art
// (pro_visual.c, pro_art.pack): Pod draws neither. ui_habitat.c and the character registry still name the two
// players, so this file answers for them. Nothing here is reached at runtime: ui_init() skips the two inits and
// habitat_scene_take() returns Pod's scene before any Player 1 or Pro screen is built. The art is a no-op rather
// than an assert, so a path that does slip through draws an empty scene instead of aborting the device.
#include "pro_visual.h"
#include "pro_living.h"

void pro_living_init(void) {}
void pro_living_image(ht_scene_t *scene, unsigned character, unsigned mood, unsigned frame, int x, int y,
                      unsigned size)
{
    (void)scene; (void)character; (void)mood; (void)frame; (void)x; (void)y; (void)size;
}
void pro_living_prepare(ht_scene_t *scene) { (void)scene; }

void pro_visual_init(void) {}
void pro_visual_prepare(ht_scene_t *scene) { (void)scene; }
void pro_visual_background(ht_scene_t *scene, pro_scene_id_t choice, ht_character_id_t daemon)
{
    (void)scene; (void)choice; (void)daemon;
}
void pro_visual_landscape(ht_scene_t *scene) { (void)scene; }
bool pro_visual_changed(const ht_character_t *c, ht_character_mood_t mood, uint32_t now, bool quiet, bool mail)
{
    (void)c; (void)mood; (void)now; (void)quiet; (void)mail;
    return false;
}
uint32_t pro_visual_next_wake_ms(const ht_character_t *c, ht_character_mood_t mood, uint32_t now, bool quiet,
                                 bool mail)
{
    (void)c; (void)mood; (void)now; (void)quiet; (void)mail;
    return 1000;
}
void pro_visual_character(ht_scene_t *scene, const ht_character_t *c, ht_character_mood_t mood, bool compact,
                          int x, int y, uint32_t now, bool quiet, bool mail)
{
    (void)scene; (void)c; (void)mood; (void)compact; (void)x; (void)y; (void)now; (void)quiet; (void)mail;
}
void pro_visual_paint(ht_scene_t *scene, ht_character_id_t id, const ht_character_face_t *face, uint8_t frame,
                      ht_character_size_t size, int y)
{
    (void)scene; (void)id; (void)face; (void)frame; (void)size; (void)y;
}
