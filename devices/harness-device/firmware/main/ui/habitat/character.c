#include "character.h"
#include "focus.h"

/*
 * Focus is the dial's only character (owner, 2026-11-10). The registry keeps one row so the calls
 * the action layer makes (tick, face, portrait) stay as they are.
 *
 * Focus is not a portrait: it spends the middle of the glass on the work, and the arrangement IS the
 * skin. So it owns the whole face through `face`, rather than one rectangle inside
 * ht_character_layout()'s seat plan.
 */
typedef struct {
    const char *name;
    bool (*tick)(ht_character_motion_t *, uint32_t, ht_character_mood_t,
                 bool, bool, bool, int, unsigned, uint32_t);
    ht_character_painter_t paint;
    void (*face)(ht_scene_t *, const ht_character_face_t *, uint8_t frame, uint16_t ink,
                 const char *recap);
} character_definition_t;

// Nothing of Focus moves, so its tick is the shared motion step with a one-frame animation; the
// only thing that animates on it is the status shimmer, which the compositor already owns.
static const character_definition_t focus = {
    "Focus", ht_focus_motion_tick, ht_focus_portrait, ht_focus_face};

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
    face.pose.mail = f->unread && !f->carrying && f->mood != HT_CHARACTER_LISTENING
        ? 1 + c->delivery.lift : 0;
    return face;
}
void ht_character_face(ht_scene_t *s, const ht_character_t *c,
                       const ht_character_face_t *f, uint16_t ink, const char *recap)
{
    ht_character_face_t face = delivery_face(c, f);
    definition(c->id)->face(s, &face, c->motion.frame, ink, recap);
}
void ht_character_portrait(ht_scene_t *s, const ht_character_t *c,
                           const ht_character_face_t *f, uint16_t ink,
                           ht_character_size_t size, int y)
{
    ht_character_face_t face = delivery_face(c, f);
    definition(c->id)->paint(s, &face, c->motion.frame, ink, size, y);
}
