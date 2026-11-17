// The Pro's pets on Harness Max (pod/pod_pet.c and its art, compiled in place): which scene an agent plays, its pet
// fitted to its spot on Max's ground, and when the room's pet next moves.
#include <string.h>

#include "max_ui_draw.h"

enum {
    STILL_MS = 400,   // a lane's pet holds this frame of its loop
    SIDE_STEP = 5,    // the square shrinks by this until the pet is short enough
    FLOOR_W = 160, FLOOR_H = 24,   // the floor shadow under the pet, as the Pro's ph_room_floor
    LANE_FLOOR_W = 100, LANE_FLOOR_H = 12,
};

// When the room's SEND scene began: it plays once from there and holds its last step.
static uint32_t s_send_from;
static bool s_sending;

pod_scene_t max_pet_scene(const max_agent_t *a, bool room)
{
    if (room && max_m.talk != MAX_TALK_IDLE && !strcmp(max_m.talk_id, a->id))
        return max_m.talk == MAX_TALK_RECORDING ? POD_SCENE_LISTEN : POD_SCENE_SEND;
    if (a->state == MAX_ASKING) return POD_SCENE_ASK;
    return a->state == MAX_WORKING ? POD_SCENE_WORK : POD_SCENE_REST;
}

// The player's square at 2x (zoom8 16: a side x side square drawn in its 2 * side twin, the "?" beside an asking pet):
// the largest that keeps the pet at most max_h tall. Pixel art has no zoom between 1x and 2x, so the height jumps.
static int side_for(const char *engine, pod_scene_t scene, int half, int max_h)
{
    int side = half;
    while (side > 4 * SIDE_STEP && pod_pet_ink_h(engine, scene, side, 16) > max_h) side -= SIDE_STEP;
    return side;
}

int max_pet(ht_scene_t *s, const max_agent_t *a, pod_scene_t scene, int cx, int foot, int half, int max_h,
            unsigned ground, uint32_t now_ms, bool still)
{
    if (!pod_pet_for(a->engine)) {   // its logo, else the ">_" mark, standing where the pet would
        const int size = max_h >= POD_LOGO_COVER ? POD_LOGO_COVER : 44;
        if (!pod_logo_draw(s, cx - size / 2, foot - size, size, a->engine))
            pod_mark_default_big(s, cx - size / 2, foot - size, size, C(ground));
        return foot - size;
    }
    if (!still) {
        if (scene == POD_SCENE_SEND && !s_sending) s_send_from = now_ms;
        s_sending = scene == POD_SCENE_SEND;
    }
    const int floor_w = still ? LANE_FLOOR_W : FLOOR_W, floor_h = still ? LANE_FLOOR_H : FLOOR_H;
    ht_pro_rect_aa(s, cx - floor_w / 2, foot - floor_h / 2, floor_w, floor_h, floor_h / 2,
                   C(max_mix(0x000000, ground, still ? 30 : 12)));
    const int side = side_for(a->engine, scene, half, max_h), h = pod_pet_ink_h(a->engine, scene, side, 16);
    // The same pet in the same 2 * side square either way: the room's at zoom8 16, with the "?" beside it while it
    // asks; a lane's at zoom8 8, where that "?" (drawn 1:1) would stand nearly as tall as the pet.
    const unsigned zoom8 = still ? 8 : 16;
    const int box = still ? 2 * side : side, cy = foot - h / 2;
    // One colour under it: a frame drawn below 1x is resampled once and kept, not again every frame.
    pod_pet_draw_flat(s, cx - box / 2, cy - box / 2, box, a->engine, scene, still ? STILL_MS : now_ms,
                      scene == POD_SCENE_SEND ? s_send_from : 0, ground, zoom8);
    return foot - h;
}

uint32_t max_pet_next_ms(const max_agent_t *a, pod_scene_t scene, uint32_t now_ms)
{
    if (!pod_pet_for(a->engine)) return MAX_WAKE_MS;   // a logo holds still
    const uint32_t ms = pod_pet_next_beat_ms(a->engine, scene, now_ms, scene == POD_SCENE_SEND ? s_send_from : 0);
    // A large pet costs much of a frame: never sooner than the Pets beat, as the Pro's room.
    return ms < POD_PH_ANIM_MS ? POD_PH_ANIM_MS - now_ms % POD_PH_ANIM_MS : ms;
}
