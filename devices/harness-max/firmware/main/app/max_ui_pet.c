// The Pro's pets on Harness Max (pod/pod_pet.c and its art, compiled in place): which scene an agent plays, its pet
// fitted to its spot on the black glass, and when a moving pet next moves. As in the mockup, no floor under it.
#include <string.h>

#include "max_ui_draw.h"

enum {
    STILL_MS = 400,   // a pet that holds still holds this frame of its loop
    SIDE_STEP = 5,    // the square shrinks by this until the pet is short enough
};

// When the SEND scene began (the send's tap, once the model holds it: max_m.send_from): it plays once from there and
// holds its last step.
static uint32_t s_send_from;
static bool s_sending;

pod_scene_t max_pet_scene(const max_agent_t *a, bool page)
{
    if (page && max_m.talk != MAX_TALK_IDLE && !strcmp(max_m.talk_id, a->id))
        return max_m.talk == MAX_TALK_RECORDING ? POD_SCENE_LISTEN : POD_SCENE_SEND;
    if (page && max_send_holds(a->id)) return POD_SCENE_SEND;   // sent: until its turn begins (the Pro's voice screen)
    if (a->state == MAX_ASKING) return POD_SCENE_ASK;
    if (a->state == MAX_WORKING) return POD_SCENE_WORK;
    // On its page an agent with nothing to say relaxes, as the dial's Focus (mockup sceneFor).
    const bool said = a->note[0] && (a->state == MAX_DONE || a->state == MAX_FAILED);
    return page && !said && pod_pet_has(a->engine, POD_SCENE_RELAX) ? POD_SCENE_RELAX : POD_SCENE_REST;
}

// How the player draws it: at zoom8 16 in a side x side square, a still asking pet at zoom8 8 in its 2 * side twin,
// where the "?" beside it (drawn 1:1) does not stand nearly as tall as the pet.
typedef struct { int side; unsigned zoom8; int h; } fit_t;

static int ink_h(const char *engine, pod_scene_t scene, int side, unsigned zoom8)
{
    return pod_pet_ink_h(engine, scene, zoom8 == 8 ? 2 * side : side, zoom8);
}
// The largest square that keeps the pet at most max_h tall. Pixel art has no zoom between 1x and 2x, so the height
// jumps.
static fit_t fit(const char *engine, pod_scene_t scene, int half, int max_h, bool still)
{
    const unsigned zoom8 = still && scene == POD_SCENE_ASK ? 8 : 16;
    int side = half;
    while (side > 4 * SIDE_STEP && ink_h(engine, scene, side, zoom8) > max_h) side -= SIDE_STEP;
    return (fit_t){side, zoom8, ink_h(engine, scene, side, zoom8)};
}
// A pet-less engine's logo, else the ">_" mark: its size where a pet would stand.
static int logo_size(int max_h) { return max_h >= POD_LOGO_COVER ? POD_LOGO_COVER : 44; }

int max_pet_h(const char *engine, pod_scene_t scene, int half, int max_h, bool still)
{
    return pod_pet_for(engine) ? fit(engine, scene, half, max_h, still).h : logo_size(max_h);
}

int max_pet(ht_scene_t *s, const char *engine, pod_scene_t scene, int cx, int foot, int half, int max_h,
            unsigned ground, uint32_t now_ms, bool still)
{
    if (!pod_pet_for(engine)) {
        const int size = logo_size(max_h);
        if (!pod_logo_draw(s, cx - size / 2, foot - size, size, engine))
            pod_mark_default_big(s, cx - size / 2, foot - size, size, C(ground));
        return foot - size;
    }
    if (!still) {
        if (scene == POD_SCENE_SEND && !s_sending) s_send_from = max_m.sending ? max_m.send_from : now_ms;
        s_sending = scene == POD_SCENE_SEND;
    }
    const fit_t f = fit(engine, scene, half, max_h, still);
    const int box = f.zoom8 == 8 ? 2 * f.side : f.side, cy = foot - f.h / 2;
    // One colour under it: a frame drawn below 1x is resampled once and kept, not again every frame.
    pod_pet_draw_flat(s, cx - box / 2, cy - box / 2, box, engine, scene, still ? STILL_MS : now_ms,
                      scene == POD_SCENE_SEND ? s_send_from : 0, ground, f.zoom8);
    return foot - f.h;
}

uint32_t max_pet_next_ms(const char *engine, pod_scene_t scene, uint32_t now_ms)
{
    if (!pod_pet_for(engine)) return MAX_WAKE_MS;   // a logo holds still
    const uint32_t ms = pod_pet_next_beat_ms(engine, scene, now_ms, scene == POD_SCENE_SEND ? s_send_from : 0);
    // A large pet costs much of a frame: never sooner than the Pets beat, as the Pro's room.
    return ms < POD_PH_ANIM_MS ? POD_PH_ANIM_MS - now_ms % POD_PH_ANIM_MS : ms;
}
