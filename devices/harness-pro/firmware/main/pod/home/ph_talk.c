// Pets voice (pro-edge2 "Listening" and "It answers"): the pet alone, as in its room. Listening: the room chrome (the agent's name on top) and the
// LISTEN scene at 2x. Opened from a Lead view with no harness here (a remote Lead, talked to by its Swarm id) the roster has no agent: the name is "Lead" and the
// pet the Lead's engine, as its who row shows them. On the Buddy screen (the Lead's chat is the Buddy's) it is the Buddy: its engine's pet and its name in lilac. Sending: the name and the SEND scene at 2x. No bubbles, no wave, no dots: the pet's own animation is all that moves
// (pod_view_next_ms follows it). One full-screen POD_A_TALK hit, added last, ends the recording (or the glue's timing decides).
#include <stdio.h>
#include <string.h>

#include "pod/home/ph.h"
#include "pod/home/ph_spark.h"
#include "pod/pod_draw.h"
#include "pod/pod_mem.h"
#include "pod/pod_pet.h"
#include "pod/pod_view_shared.h"
#include "pro_canvas.h"

#define C(rgb) ht_rgb(rgb)
enum { PET_FOOT = 506 };   // listening and sending stand the pet on the same floor (owner: the send screen sat it too low)

// An engine without a pet draws the round device's effect instead (owner, mockup option A "only the effect, like the round"), and nothing else but the name.
// Listening: 7 bars, 9 px wide on a 35 px pitch, rounded, #00FF2F, centred on y 360; the heights are the round's travelling-wave table (focus.c WAVE, 16 levels),
// frame (now / 80) % 15, a 1.2 s cycle, height = max(6, level / 15 * 187). Like the round it is a pure clock animation: the mic level does not shape it.
// Sending: the round's own sparkle (ht_spark scaled 720/466 to 62 x 74, ph_spark.h), three boxes centred on a 102 px pitch at y 360, all full-strength
// ink #EFE7DE, the lit one (now / 200) % 3 the meter's #00FF2F; no glow, no pop. The run count and order never change between frames (7 bars; 3 images), so
// the damage stays cheap.
enum { FX_Y = 360, FX_GREEN = 0x00FF2F, WAVE_BARS = 7, WAVE_FRAMES = 15, WAVE_MS = 80, SEND_MS = 200, SPARK_PITCH = 102 };
static const uint8_t WAVE[WAVE_FRAMES][WAVE_BARS] = {   // the round dial's wave table
    {  1,  6, 10, 14,  8,  3,  1 }, {  1,  6, 10, 13,  6,  3,  0 }, {  2,  6,  9, 11,  5,  2,  0 }, {  2,  6,  8,  9,  4,  2,  1 },
    {  2,  6,  7,  7,  3,  2,  1 }, {  2,  5,  5,  6,  3,  3,  1 }, {  1,  4,  4,  5,  4,  4,  1 }, {  1,  3,  3,  5,  5,  4,  2 },
    {  1,  2,  3,  6,  6,  5,  2 }, {  1,  2,  4,  8,  7,  6,  2 }, {  1,  2,  4, 10,  9,  6,  2 }, {  0,  2,  6, 12,  9,  6,  1 },
    {  0,  3,  7, 14, 10,  6,  1 }, {  1,  4,  8, 15,  9,  5,  1 }, {  1,  5,  9, 15,  9,  4,  1 },
};
static void fx_listen(ht_scene_t *s, uint32_t now_ms)
{
    const uint8_t *w = WAVE[(now_ms / WAVE_MS) % WAVE_FRAMES];
    for (int k = 0; k < WAVE_BARS; k++) {
        int h = w[k] * 187 / 15;
        if (h < 6) h = 6;
        ht_pro_rect_aa(s, 360 + (k - WAVE_BARS / 2) * 35 - 4, FX_Y - h / 2, 9, h, 4, C(FX_GREEN));
    }
}
// The sparkle in one ink: the shared coverage over a solid fill, filled on first use (PSRAM on the device).
static const ht_pro_bitmap_t *spark(int lit)
{
    static EXT_RAM_BSS_ATTR uint16_t px[2][PH_SPARK_W * PH_SPARK_H];
    static ht_pro_bitmap_t bm[2];
    if (!bm[lit].pixels) {
        const uint16_t ink = C(lit ? FX_GREEN : PH_INK);
        for (int i = 0; i < PH_SPARK_W * PH_SPARK_H; i++) px[lit][i] = ink;
        bm[lit] = (ht_pro_bitmap_t){ .pixels = px[lit], .alpha = PH_SPARK_ALPHA, .width = PH_SPARK_W, .height = PH_SPARK_H, .revision = 1u + (unsigned)lit };
    }
    return &bm[lit];
}
static void fx_send(ht_scene_t *s, uint32_t now_ms)
{
    const int lit = (int)((now_ms / SEND_MS) % 3);
    for (int i = 0; i < 3; i++)
        ht_pro_image(s, 360 + (i - 1) * SPARK_PITCH - PH_SPARK_W / 2, FX_Y - PH_SPARK_H / 2, spark(i == lit));
}

enum { BUDDY_INK = 0xC49BFF };   // the Buddy's lilac, as the Lead view's pill and name

// Who the voice screen shows: the roster agent of the frame, else the Lead of a Lead frame ("Lead" and its engine), or its Buddy on the Buddy screen. NULL: nobody.
typedef struct { const pod_agent_t *agent; const char *engine, *name; unsigned ink; } talk_who_t;
static talk_who_t talk_who(const pod_nav_t *nav, const pod_model_t *m)
{
    talk_who_t w = { pod_view_agent_of(nav, m), NULL, NULL, PH_ROOM_INK };
    const pod_lead_t *l = pod_nav_lead(nav, m, NULL);
    if (l && l->chat == POD_CHAT_BUDDY && l->has_buddy) return (talk_who_t){ NULL, l->buddy.engine, l->buddy.name, BUDDY_INK };
    if (w.agent) { w.engine = w.agent->engine; w.name = w.agent->name; }
    else if (l) { w.engine = l->engine; w.name = "Lead"; }
    return w;
}

void ph_view_talk(pod_out_frame_t *f, const pod_nav_t *nav, pod_model_t *m, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    const talk_who_t who = talk_who(nav, m);
    if (!who.name) { s->background = C(PH_ROOM_BG); return; }
    s->background = C(PH_ROOM_BG);
    ph_title_ink(s, who.name, who.ink);
    if (!pod_pet_for(who.engine)) {   // no pet: the effect alone
        if (nav->sending) fx_send(s, now_ms); else fx_listen(s, now_ms);
        if (!nav->sending) pod_hit_add(f, 0, 0, POD_W, POD_W, POD_A_TALK, 0);
        return;
    }
    const int cx = 360, foot = PET_FOOT;
    ph_room_floor(s, cx, foot, 420);
    const pod_scene_t scene = nav->sending ? POD_SCENE_SEND : POD_SCENE_LISTEN;
    const uint32_t started = nav->sending ? nav->send_started_ms : nav->talk_started_ms;
    const int side = 260, h = pod_pet_ink_h(who.engine, scene, side, 16);   // ph_room_pet's own pet, at 2x
    if (h) pod_pet_draw(s, cx - side / 2, foot - h / 2 - side / 2, side, who.engine, scene, now_ms, started, 16);
    if (!nav->sending) pod_hit_add(f, 0, 0, POD_W, POD_W, POD_A_TALK, 0);   // LAST: hits are scanned last to first, so nothing steals the send
}

// Ms to the voice screen's next change. The pet's own animation is all that moves, and Pets redraws on its 66 ms beat (POD_PH_ANIM_MS): a 2x
// pet with its waves costs most of a frame, so no faster cadence is ever asked for. SEND plays once and holds its last step, then nothing moves.
uint32_t ph_talk_next_ms(const pod_nav_t *nav, const pod_model_t *m, uint32_t now_ms)
{
    const talk_who_t who = talk_who(nav, m);
    uint32_t ms = 1000;
    if (who.name && !pod_pet_for(who.engine)) return nav->sending ? SEND_MS - now_ms % SEND_MS : WAVE_MS - now_ms % WAVE_MS;   // the effect's own steps: 80 ms wave frames, 200 ms sparkles
    if (who.name && pod_pet_for(who.engine))
        ms = pod_pet_next_beat_ms(who.engine, nav->sending ? POD_SCENE_SEND : POD_SCENE_LISTEN, now_ms, nav->sending ? nav->send_started_ms : nav->talk_started_ms);
    if (ms < POD_PH_ANIM_MS) ms = POD_PH_ANIM_MS - now_ms % POD_PH_ANIM_MS;   // never faster than the beat, and on it
    return ms;
}
