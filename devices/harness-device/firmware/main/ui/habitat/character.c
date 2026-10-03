#include "character.h"
#include "octopus.h"
#include "tux.h"
#include "focus.h"
#include "illustrated.h"
#include <string.h>

typedef struct {
    const char *name;
    bool (*tick)(ht_character_motion_t *, uint32_t, ht_character_mood_t,
                 bool, bool, bool, int, unsigned, uint32_t);
    ht_character_painter_t paint;
    /*
     * A SKIN THAT OWNS THE WHOLE FACE, rather than one rectangle inside ht_character_layout()'s seat
     * plan. A creature is a portrait with words arranged around it, so the layout owns the title,
     * recap, status and hint and hands the painter a single y. Focus is not a portrait: it spends the
     * middle of the glass on the work, and the arrangement IS the skin.
     *
     * NULL means the old path, unchanged — which is what Tim and Tux take.
     */
    void (*face)(ht_scene_t *, const ht_character_face_t *, uint8_t frame, uint16_t ink,
                 const char *recap);
} character_definition_t;

#define PORTRAIT(name, species) \
    static void name(ht_scene_t *s, const ht_character_face_t *f, uint8_t frame, \
        uint16_t ink, ht_character_size_t size, int y) \
    { ht_illustrated_draw(s, species, f, frame, ink, size, y); }
PORTRAIT(illustrated_tim, 0)
PORTRAIT(gnu, 1)
PORTRAIT(lynx, 2)
PORTRAIT(mutt, 3)
PORTRAIT(yak, 4)
PORTRAIT(gopher, 5)
PORTRAIT(bug, 6)
PORTRAIT(illustrated_tux, 7)
PORTRAIT(auk, 8)
PORTRAIT(beastie, 9)
#undef PORTRAIT

// Adding artwork changes this registry and its adapter, never the action layer.
static const character_definition_t characters[HT_CHARACTER_COUNT] = {
    [HT_CHARACTER_TIM] = {"Tim", ht_octopus_motion_tick, ht_octopus_draw, NULL},
    [HT_CHARACTER_TUX] = {"Tux", ht_tux_motion_tick, ht_tux_draw, NULL},
    // Nothing of Focus moves, so its tick is the shared motion step with a one-frame animation; the
    // only thing that animates on it is the status shimmer, which the compositor already owns.
    [HT_CHARACTER_FOCUS] = {"Focus", ht_focus_motion_tick, ht_focus_portrait, ht_focus_face},
    [HT_CHARACTER_ILLUSTRATED_TIM] = {"Tim", ht_illustrated_tick, illustrated_tim, NULL},
    [HT_CHARACTER_GNU] = {"GNU", ht_illustrated_tick, gnu, NULL},
    [HT_CHARACTER_LYNX] = {"Lynx", ht_illustrated_tick, lynx, NULL},
    [HT_CHARACTER_MUTT] = {"Mutt", ht_illustrated_tick, mutt, NULL},
    [HT_CHARACTER_YAK] = {"Yak", ht_illustrated_tick, yak, NULL},
    [HT_CHARACTER_GOPHER] = {"Gopher", ht_illustrated_tick, gopher, NULL},
    [HT_CHARACTER_BUG] = {"Bug", ht_illustrated_tick, bug, NULL},
    [HT_CHARACTER_ILLUSTRATED_TUX] = {"Tux", ht_illustrated_tick, illustrated_tux, NULL},
    [HT_CHARACTER_AUK] = {"Auk", ht_illustrated_tick, auk, NULL},
    [HT_CHARACTER_BEASTIE] = {"Beastie", ht_illustrated_tick, beastie, NULL},
};
static const char *species[] = {"tim", "gnu", "lynx", "mutt", "yak", "gopher", "bug", "tux", "auk", "beastie"};
ht_character_id_t ht_character_companion(const char *key)
{
    if (key) for (unsigned i = 0; i < sizeof species / sizeof species[0]; i++)
        if (!strcmp(key, species[i])) return (ht_character_id_t)(HT_CHARACTER_ILLUSTRATED_TIM + i);
    return HT_CHARACTER_COUNT;
}
const char *ht_character_species(ht_character_id_t id)
{
    return id >= HT_CHARACTER_ILLUSTRATED_TIM && id < HT_CHARACTER_COUNT
        ? species[id - HT_CHARACTER_ILLUSTRATED_TIM] : NULL;
}
static const character_definition_t *definition(ht_character_id_t id)
{
    return &characters[(unsigned)id < HT_CHARACTER_COUNT ? id : HT_CHARACTER_TIM];
}
// What a dial shows before anybody has chosen: Focus. The owner's decision (2026-09-30), and the
// reason a freshly flashed dial — or one coming from a firmware that never saved `habitat_char` —
// opens on the work rather than on the octopus. A choice made since is kept; this is only the
// fallback for none. Tim or Tux as the default is a build flag (DEVICE_DEFAULT_CHARACTER).
ht_character_id_t ht_character_default(void)
{
#if defined(DEVICE_DEFAULT_CHARACTER_TIM)
    return HT_CHARACTER_TIM;
#elif defined(DEVICE_DEFAULT_CHARACTER_TUX)
    return HT_CHARACTER_TUX;
#else
    return HT_CHARACTER_FOCUS;
#endif
}
const char *ht_character_name(ht_character_id_t id) { return definition(id)->name; }
bool ht_character_select(ht_character_t *c, ht_character_id_t id)
{
    if (!c || (unsigned)id >= HT_CHARACTER_COUNT) return false;
    if (c->id == id) return true;
    memset(&c->motion, 0, sizeof c->motion);
    c->companion_style = (ht_companion_style_t){.stage=2,.colour=255};
    c->id = id;
    return true;
}
bool ht_character_tick(ht_character_t *c, uint32_t now, ht_character_mood_t mood,
                       bool quiet, bool visible, bool down, int x, unsigned level, uint32_t activity)
{
    if ((unsigned)mood >= HT_CHARACTER_MOODS) mood = HT_CHARACTER_IDLE;
    if (ht_character_species(c->id)) return ht_illustrated_tick_species(&c->motion,
        c->id-HT_CHARACTER_ILLUSTRATED_TIM,now,mood,quiet,visible,down,x,level,activity);
    return definition(c->id)->tick(&c->motion, now, mood, quiet, visible, down, x, level, activity);
}
bool ht_character_delivery_tick(ht_character_t *c, uint32_t now, bool pending,
                                uint32_t sequence, bool animate)
{
    uint8_t before = c->delivery.lift;
    if (!c->delivery.initialized) {
        c->delivery.initialized = true;
        c->delivery.sequence = sequence;
    }
    if (sequence != c->delivery.sequence) {
        c->delivery.sequence = sequence;
        // Arrivals during a delivery coalesce; they cannot prolong the motion.
        if (!c->delivery.moving && pending && animate) {
            c->delivery.began = now;
            c->delivery.moving = true;
        }
    }
    uint32_t age = now - c->delivery.began;
    if (!pending || !animate || age >= 1280) c->delivery.moving = false;
    c->delivery.lift = c->delivery.moving ? (age / 160) % 2 : 0;
    if (c->delivery.moving) {
        uint32_t next = 160 - age % 160;
        if (next < c->motion.next_ms) c->motion.next_ms = next;
    }
    return before != c->delivery.lift;
}
static ht_character_face_t delivery_face(const ht_character_t *c, const ht_character_face_t *f)
{
    ht_character_face_t face = *f;
    face.companion_style = c->companion_style;
    face.pose.mail = f->unread && !f->carrying && f->mood != HT_CHARACTER_LISTENING
        ? 1 + c->delivery.lift : 0;
    return face;
}
void ht_character_face(ht_scene_t *s, const ht_character_t *c,
                       const ht_character_face_t *f, uint16_t ink, const char *recap)
{
    ht_character_face_t face = delivery_face(c, f);
    const character_definition_t *skin = definition(c->id);
    if (skin->face) { skin->face(s, &face, c->motion.frame, ink, recap); return; }
    ht_character_layout(s, &face, c->motion.frame, ink, recap, skin->paint);
}
void ht_character_portrait(ht_scene_t *s, const ht_character_t *c,
                           const ht_character_face_t *f, uint16_t ink,
                           ht_character_size_t size, int y)
{
    ht_character_face_t face = delivery_face(c, f);
    definition(c->id)->paint(s, &face, c->motion.frame, ink, size, y);
}
