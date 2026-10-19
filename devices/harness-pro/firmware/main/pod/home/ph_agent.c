// Pets room (the Agent screen): one pet at a time on its floor, 2x, thinking or speaking in a bubble (pro-edge2 "Room"). No command bar: the
// name centred on top (ph_room_chrome), no dots. A finished or failed agent is not here: its RECAP frame draws the recap (ph_recap.c).
//   working   WORK scene, a thought with the activity sentence (else the verb) and "<Verb>... m:ss" in green at y 612.
//   resting   nothing to tell: REST scene and the thought "z z z".
//   asking    ASK scene bottom left and a speech bubble with the question: no answers, no mic.
//   offline   REST scene (not dimmed: the canvas has no alpha) and the thought "My machine is offline."
// A pet moves with the clock (ph_room_next_ms); the status line redraws when its time text changes (pod_time.h).
#include <ctype.h>
#include <stdio.h>
#include <string.h>

#include "pod/home/ph.h"
#include "pod/pod_view_shared.h"
#include "pro_canvas.h"

#define C(rgb) ht_rgb(rgb)
#define ELL "\xe2\x80\xa6"
enum { PET_SIDE = 260,   // the 1x square: at 2x it is 520, wide enough for every pet's WORK and RELAX scenes at exactly 2x
       ALT_SIDE = 280,   // ... but Claude's builder (WORK_ALT): its sweat drop flies off left while the hammer is out right, 273 px
                         // across, so 546 at 2x; a 560 square keeps it at exactly 2x (pixel art has no zoom between 1x and 2x)
       STATUS_CY = 636, BUBBLE_TOP = 96, TAIL = 22, GAP = 30 };

// The pet, 2x, its feet on `foot`, centred on cx. An engine with no pet: its 72 px logo or the ">_" outline. Returns the top of what is drawn.
int ph_room_pet(ht_scene_t *s, const pod_model_t *m, const pod_agent_t *a, pod_scene_t scene, int cx, int foot, uint32_t now_ms, uint32_t started_ms)
{
    const int side = scene == POD_SCENE_WORK_ALT ? ALT_SIDE : PET_SIDE;
    int h = pod_pet_ink_h(a->engine, scene, side, 16);
    if (!h) {
        ph_card_art(s, cx, foot - 40, 72, m, a, PH_ROOM_BG, now_ms);
        return foot - 80;
    }
    int cy = foot - h / 2;
    pod_pet_draw(s, cx - side / 2, cy - side / 2, side, a->engine, scene, now_ms, started_ms, 16);
    return foot - h;
}

// A thought bubble whose bottom sits above the head at (hx, head_top), with its two dots trailing to it.
static void thought(ht_scene_t *s, const char *text, const ht_pro_font_t *font, int bx, int w, int max_rows, int hx, int head_top)
{
    int h_est = ph_bubble_height(font, w, text, max_rows, false);   // placed by the bubble's own wrapping
    int by = head_top - 90 - h_est;
    if (by < BUBBLE_TOP) by = BUBBLE_TOP;
    int h = ph_bubble(s, PH_THOUGHT, bx, by, w, 0, -1, font, text, max_rows, NULL);
    int dx = hx - 60 < bx + w - 60 ? hx - 60 : bx + w - 60;
    if (dx < bx + 40) dx = bx + 40;
    ph_thought_dots(s, dx, by + h + 22, dx + 22, by + h + 48);
}

static void capitalise(char *dst, size_t n, const char *src)
{
    snprintf(dst, n, "%s", src);
    if (dst[0]) dst[0] = (char)toupper((unsigned char)dst[0]);
}

// A speech bubble over the head of a pet at (hx, head_top); returns its y, its height in *h.
static int speech(ht_scene_t *s, ph_bubble_kind_t kind, const char *text, int max_rows, const char *muted, int bx, int w, int hx, int head_top, int *h)
{
    const ht_pro_font_t *f = &ph_sb_34;
    int h_est = ph_bubble_height(f, w, text, max_rows, muted != NULL);
    int by = head_top - GAP - TAIL - h_est;
    if (by < BUBBLE_TOP - 4) by = BUBBLE_TOP - 4;
    int tail_x = hx - 40;
    if (tail_x < bx + 50) tail_x = bx + 50;
    if (tail_x > bx + w - 50) tail_x = bx + w - 50;
    *h = ph_bubble(s, kind, bx, by, w, tail_x, 0, f, text, max_rows, muted);
    return by;
}

void ph_room(pod_out_frame_t *f, const pod_nav_t *nav, pod_model_t *m, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    const pod_agent_t *a = pod_view_agent_of(nav, m);
    if (!a) { s->background = C(PH_ROOM_BG); return; }
    pod_state_t st = pod_model_eff(m, a);
        pod_scene_t scene = ph_room_scene(m, a);
    ph_room_chrome(f, nav, m, a);

    if (st == POD_WORKING) {
        const int cx = 380, foot = 566;
        ph_room_floor(s, cx - 40, foot, 400);
        int top = ph_room_pet(s, m, a, scene, cx, foot, now_ms, 0);
        char verb[POD_VERB_BYTES + 4], line[POD_VERB_BYTES + 24], t[12];
        capitalise(verb, sizeof verb, a->verb[0] ? a->verb : "Working");
        pod_fmt_elapsed(t, sizeof t, pod_agent_secs(a, now_ms));
        snprintf(line, sizeof line, "%s" ELL " %s", verb, t);
        thought(s, a->activity[0] ? a->activity : verb, &ph_sb_32, 40, 560, 2, cx, top);
        int w = ht_pro_width(&ph_sb_34, line);
        ph_text(s, (POD_W - w) / 2, STATUS_CY, w + 2, &ph_sb_34, PH_ROOM_GREEN, line);
        return;
    }
    if (st == POD_ASKING) {
        const int cx = 190, foot = 660;
        ph_room_floor(s, cx, foot, 280);
        int top = ph_room_pet(s, m, a, scene, cx, foot, now_ms, 0);
        int h;
        speech(s, PH_SPEECH, a->question, 3, NULL, 40, 640, cx, top, &h);
        return;
    }
    const int cx = 360, foot = 566;
    ph_room_floor(s, cx, foot, 320);
    int top = ph_room_pet(s, m, a, scene, cx, foot, now_ms, 0);
    if (st == POD_OFFLINE) thought(s, "My machine is offline.", &ph_sb_32, 60, 480, 2, cx, top);
    else thought(s, "z z z", &ph_sb_32, 120, 190, 1, cx, top);
}

// An idle agent with a recap is a RECAP frame (pod_model_opens_on_recap); if a render comes before the nav's flip, it draws the recap, never a room.
void ph_view_agent(pod_out_frame_t *f, const pod_nav_t *nav, pod_model_t *m, uint32_t now_ms)
{
    const pod_agent_t *a = pod_view_agent_of(nav, m);
    if (a && pod_model_opens_on_recap(m, a)) ph_view_recap(f, nav, m, now_ms);
    else ph_room(f, nav, m, now_ms);
}

// The scene the open screen plays: the recap's (RELAX, REST when failed) on a RECAP frame, else the room's.
static pod_scene_t ph_room_scene_of(const pod_nav_t *nav, const pod_model_t *m, const pod_agent_t *a)
{
    if (nav->depth && nav->stack[nav->depth - 1].view == POD_V_RECAP) {
        const pod_unread_t *u = pod_model_unread_find(m, a->id);
        return a->failed || (u && u->kind == POD_UNREAD_FAILED) ? POD_SCENE_REST : POD_SCENE_RELAX;
    }
    return ph_room_scene(m, a);
}

uint32_t ph_room_next_ms(const pod_nav_t *nav, const pod_model_t *m, uint32_t now_ms)
{
    const pod_agent_t *a = pod_view_agent_of(nav, m);
    if (!a) return POD_PET_STEP_MS;
    uint32_t ms = pod_pet_next_beat_ms(a->engine, ph_room_scene_of(nav, m, a), now_ms, 0);
    if (ms < POD_PH_ANIM_MS) ms = POD_PH_ANIM_MS - now_ms % POD_PH_ANIM_MS;   // a 2x pet redraws a lot: no faster than the Pets beat
    if (pod_model_eff(m, a) == POD_WORKING) { uint32_t t = pod_agent_timer_ms(a, now_ms); if (ms > t) ms = t; }   // the status line's clock, when its text next changes
    return ms;
}
