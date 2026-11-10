#include "character.h"
#include "focus.h"

/*
 * Focus is the dial's only character (owner, 2026-11-10). The registry keeps one row so the calls
 * the action layer makes (tick, face) stay as they are.
 *
 * Focus spends the middle of the glass on the work, and the arrangement IS the face, so it owns the
 * whole face through `face`.
 */
typedef struct {
    const char *name;
    bool (*tick)(ht_character_motion_t *, uint32_t, ht_character_mood_t,
                 bool, bool, bool, int, unsigned, uint32_t);
    void (*face)(ht_scene_t *, const ht_character_face_t *, uint8_t frame, uint16_t ink,
                 const char *recap);
} character_definition_t;

// Nothing of Focus moves, so its tick is the shared motion step with a one-frame animation; the
// only thing that animates on it is the status shimmer, which the compositor already owns.
static const character_definition_t focus = {
    "Focus", ht_focus_motion_tick, ht_focus_face};

static const character_definition_t *definition(ht_character_id_t id) { (void)id; return &focus; }
// A dial opens on the work: Focus, whatever a previous firmware saved.
ht_character_id_t ht_character_default(void) { return HT_CHARACTER_FOCUS; }
const char *ht_character_name(ht_character_id_t id) { return definition(id)->name; }
bool ht_character_select(ht_character_t *c, ht_character_id_t id)
{
    (void)id;
    if (!c) return false;
    c->id = HT_CHARACTER_FOCUS;   // already Focus: the motion state is kept
    return true;
}
bool ht_character_tick(ht_character_t *c, uint32_t now, ht_character_mood_t mood,
                       bool quiet, bool visible, bool down, int x, unsigned level, uint32_t activity)
{
    if ((unsigned)mood >= HT_CHARACTER_MOODS) mood = HT_CHARACTER_IDLE;
    return definition(c->id)->tick(&c->motion, now, mood, quiet, visible, down, x, level, activity);
}
void ht_character_face(ht_scene_t *s, const ht_character_t *c,
                       const ht_character_face_t *f, uint16_t ink, const char *recap)
{
    definition(c->id)->face(s, f, c->motion.frame, ink, recap);
}
