// App Detail's next motion painted ahead (max_ui.h, max_ui_warm). The first frames of an open or a close paint what
// no frame showed before (each step of the moving agents' pets, dimmed and blurred, and the slivers it comes to rest
// with): on the P4 that is a frame several times a warm one's. So while the row rests, each motion the finger can start
// from here is drawn off the glass as it will be drawn, frame after frame on its frames' grid (max_tween_frame), from
// the motion's start to where it rests, and what it paints is kept (max_layer_warm). A step under the lock draws one
// frame; the first image or layer it needs, and then its pets below 1x, are made out of the lock (max_ui_warm_paint) a
// few ms at a time, and the frame is drawn again once its image is made: neither the finger nor the glass's own frames
// wait on more than a step. The open agent's close first (its X, the likeliest), then every open's first frame, every
// one's second and on: whichever the finger picks starts warm, and when the room runs out the later frames are the
// ones left cold. What a step writes of the glass's model is set aside and put back as it was. Render task only.
#include <stddef.h>
#include <string.h>

#include "max_ui_draw.h"
#include "pod/pod_draw.h"   // POD_CELL: a pet's frame, baked below 1x
#include "pod/pod_mem.h"    // EXT_RAM_BSS_ATTR: the model aside is the size of the model

// What a render carries to the next (max_ui_internal.h): the row in motion and the render's own clocks.
#define CARRIED_AT offsetof(max_model_t, row)
#define CARRIED (offsetof(max_model_t, cell_box) - CARRIED_AT)
// What a step writes: a page, a talk and a render write the model from `selected` on (max_ui_internal.h).
#define ASIDE_AT offsetof(max_model_t, selected)
#define ASIDE (sizeof(max_model_t) - ASIDE_AT)

enum { MOTIONS = MAX_ROW_HITS + 1, FRAMES = 3 * MAX_ROW_MS / MAX_ROW_FRAME_MS };   // past three moves: at rest

// A motion the finger can start: an agent opening (a tap on its cell, or on its sliver beside the open agent), or the
// open agent closing (its X).
typedef struct {
    char id[ID_MAX];               // the agent that opens; "" the close
    int frame;                     // its last frame drawn whole (-1: none yet)
    bool rests;                    // and it was where the motion rests
    uint8_t carried[CARRIED];      // what that frame's render carries to the next
} motion_t;

static EXT_RAM_BSS_ATTR uint8_t s_glass[ASIDE];   // the glass's model while a motion's frame is drawn
static EXT_RAM_BSS_ATTR ht_scene_t s_scene;        // the frame drawn last, its pets below 1x baked out of the lock
static uint16_t s_px[1];
static EXT_RAM_BSS_ATTR struct {
    uint32_t from;   // max_layer_now when the warming began: what the glass showed then on is kept
    uint32_t at;     // when every motion starts, on its own clock
    motion_t motions[MOTIONS];
    int count;
    bool over;       // no room for more
    int restarts;    // the times the pets' frames baked below 1x started over since (twice: the warming bakes no more)
    motion_t *baking;            // the motion whose frame in s_scene is drawn whole once its pets below 1x are baked:
    int frame;                   // that frame,
    bool rests;                  // whether it is where the motion rests,
    uint8_t carried[CARRIED];    // and what it carries
    bool glass, glass_bakes;     // the glass is owed a draw aside (the bakes started over), then its bakes
} s_warm;

static void aside(void) { memcpy(s_glass, (uint8_t *)&max_m + ASIDE_AT, ASIDE); }
static void back(void) { memcpy((uint8_t *)&max_m + ASIDE_AT, s_glass, ASIDE); }

// The row at rest, nothing over it: no finger, no overlay, no page or form coming, nothing the row draws moving.
static bool resting(uint32_t now_ms)
{
    const max_fade_t *fades[] = {&max_m.toast_fade, &max_m.done_fade, &max_m.notice_fade};
    for (int i = 0; i < 3; i++)
        if (fades[i]->up || !max_tween_done(&fades[i]->out, now_ms)) return false;
    return max_m.link && (max_m.view == MAX_VIEW_OVERVIEW || max_m.view == MAX_VIEW_AGENT) && max_m.row.drawn &&
           max_m.update_pct < 0 && !max_form_open() && max_m.talk != MAX_TALK_SENDING && !max_m.dirty &&
           !max_m.down && !max_row_moving(now_ms);
}

// What the motions from here depend on: the page, the row's agents as they look, and what the finger can reach; and
// whether the row moved since (a motion may have given up what the warming painted). Never 0.
static uint32_t key_of(void)
{
    uint32_t h = max_fnv(2166136261u, &max_m.view, sizeof max_m.view);
    h = max_fnv(h, max_m.selected, sizeof max_m.selected);
    h = max_fnv(h, &max_m.talk, sizeof max_m.talk);
    h = max_fnv(h, &max_m.row_first, sizeof max_m.row_first);
    h = max_fnv(h, &max_m.row.moves, sizeof max_m.row.moves);
    for (int i = 0; i < max_m.count; i++) {
        const max_agent_t *a = &max_m.agents[i];
        h = max_fnv(h, a->id, sizeof a->id);
        h = max_fnv(h, a->engine, sizeof a->engine);
        h = max_fnv(h, &a->state, sizeof a->state);
        h = max_fnv(h, &a->caps, sizeof a->caps);
    }
    for (int i = 0; i < max_m.cell_hits; i++) h = max_fnv(h, max_m.cell_id[i], sizeof max_m.cell_id[i]);
    h = max_fnv(h, &max_m.cell_hits, sizeof max_m.cell_hits);
    return h ? h : 1;
}

// The motions the finger can start from the row as last drawn: the close first, then each cell or sliver's open. A
// tap on an agent that asks puts its question up instead (Attention): no motion of the row; nor, while the mic is open,
// a tap on another agent.
static void plan(uint32_t key, uint32_t now_ms)
{
    const bool glass = s_warm.glass || s_warm.glass_bakes;   // owed whatever the finger can do next
    memset(&s_warm, 0, sizeof s_warm);
    s_warm.glass = glass;
    max_m.warm_key = key;
    s_warm.from = max_layer_now();
    s_warm.at = now_ms;
    if (max_m.view == MAX_VIEW_AGENT) s_warm.count++;
    for (int i = 0; i < max_m.cell_hits && s_warm.count < MOTIONS && max_m.talk != MAX_TALK_RECORDING; i++) {
        const max_agent_t *a = max_find(max_m.cell_id[i]);   // while the mic is open, a tap anywhere sends instead
        if (a && a->state != MAX_ASKING) max_copy(s_warm.motions[s_warm.count++].id, ID_MAX, a->id);
    }
    for (int i = 0; i < s_warm.count; i++) s_warm.motions[i].frame = -1;
}

// The motion started at `at` as the finger starts it (max_ui_touch.c, and the mic max_app.c opens for it): the agent
// opens with the mic on when the bar can listen for it; the X closes it, the mic dropped.
static void start(const char *id, uint32_t at)
{
    if (!id[0]) {
        max_ui_talk(MAX_TALK_IDLE, at);
        max_show(MAX_VIEW_OVERVIEW);
        return;
    }
    const max_agent_t *a = max_find(id);
    const bool talks = max_can_talk(a) && max_takes_voice(a);
    max_open(id);
    if (talks) {
        max_copy(max_m.talk_id, sizeof max_m.talk_id, id);
        max_ui_talk(MAX_TALK_RECORDING, at);
    }
}

// The pets drawn below 1x on one colour in s_scene baked as its raster would bake them (one pixel of each), all of
// them or until one is new: true then (there may be more).
static bool bake(bool all)
{
    for (int i = 0; i < s_scene.count; i++) {
        const ht_run_t *r = &s_scene.runs[i];
        if (r->pro_kind != POD_CELL || r->text[0] != 1 || r->x < 0 || r->y < 0 || r->x >= HT_WIDTH || r->y >= HT_HEIGHT)
            continue;
        const unsigned baked = pod_cell_bakes();
        ht_raster(&s_scene, (ht_rect_t){r->x, r->y, 1, 1}, s_px);
        if (!all && pod_cell_bakes() != baked) return true;
    }
    return false;
}

// The frame in s_warm.baking drawn whole: the motion's next frame from it.
static void settle(void)
{
    motion_t *m = s_warm.baking;
    memcpy(m->carried, s_warm.carried, CARRIED);
    m->frame = s_warm.frame;
    m->rests = s_warm.rests;
    s_warm.baking = NULL;
}

// Frame `f` of motion m, from what frame f - 1 carried (frame 0 the motion's start), into s_scene: what it uses is kept,
// and the first image or layer it needs is left to make (it is drawn again once that is made). A frame with all it
// needs is drawn whole once its pets below 1x are baked (s_warm.baking), out of the lock.
static max_warm_t draw(motion_t *m, int f)
{
    aside();
    const unsigned painted = max_layer_painted();
    max_layer_warm(s_warm.from);
    start(m->id, s_warm.at);
    if (f) memcpy((uint8_t *)&max_m + CARRIED_AT, m->carried, CARRIED);
    const uint32_t now = s_warm.at + (uint32_t)f * MAX_ROW_FRAME_MS;
    max_render_aside(&s_scene, now);
    max_warm_t met = max_layer_warm(0);
    if (met == MAX_WARM_DONE && max_layer_painted() != painted) met = MAX_WARM_MORE;   // an image to make first
    if (met == MAX_WARM_DONE) {
        memcpy(s_warm.carried, (uint8_t *)&max_m + CARRIED_AT, CARRIED);
        s_warm.frame = f;
        s_warm.rests = !max_row_moving(now) || f >= FRAMES;
        s_warm.baking = m;
        if (s_warm.restarts >= 2) settle();   // no room for its bakes
    }
    back();
    return met;
}

// The glass as it stands drawn aside into s_scene, for its pets below 1x to be baked again, nothing it shows given up.
static void glass_aside(uint32_t now_ms)
{
    aside();
    max_layer_warm(s_warm.from);
    max_render_aside(&s_scene, now_ms);
    max_layer_warm(0);
    back();
    s_warm.glass = false;
    s_warm.glass_bakes = true;
}

// What is owed out of the lock: the image or layer to make, then s_scene's bakes.
static bool owed(void) { return max_layer_owes() || s_warm.baking || s_warm.glass_bakes; }

bool max_ui_warm_paint(bool (*go_on)(void))
{
    if (!owed()) return false;
    const unsigned arena = pod_cell_bake_px();
    const bool glass = s_warm.glass_bakes;
    if (max_layer_owes()) {
        max_layer_warm_paint(go_on);
    } else if (!bake(false)) {   // a bake a call: each is one of the Pro's, whole
        if (glass) s_warm.glass_bakes = false;
        else settle();
    }
    if (!glass && pod_cell_bake_px() < arena) {
        // The bakes started over (one with no room drops them all, the glass's too): the frame is drawn again, and
        // the glass drawn aside for what its next frame needs baked. The first time (the bakes held other pages' till
        // then) every motion is drawn again from its start for its bakes, its images all found; the next, there is no
        // room for them all: the warming bakes no more.
        s_warm.baking = NULL;
        s_warm.glass = true;
        if (++s_warm.restarts == 1) {
            for (int i = 0; i < s_warm.count; i++) s_warm.motions[i].frame = -1, s_warm.motions[i].rests = false;
            s_warm.over = false;
        }
    }
    return true;
}

bool max_ui_warm_rests(uint32_t now_ms) { return resting(now_ms); }

bool max_ui_warm(uint32_t now_ms)
{
    if (!resting(now_ms)) return false;
    const uint32_t key = key_of();
    if (key != max_m.warm_key) plan(key, now_ms);
    if (owed()) return true;   // out of the lock first
    if (s_warm.glass) {
        glass_aside(now_ms);
        return true;
    }
    motion_t *m = NULL;
    for (int i = 0; i < s_warm.count && !s_warm.over; i++) {
        motion_t *c = &s_warm.motions[i];
        if (c->rests) continue;
        if (!c->id[0]) {   // the close, to where it rests
            m = c;
            break;
        }
        if (!m || c->frame < m->frame) m = c;
    }
    if (!m) return false;
    s_warm.over = draw(m, m->frame + 1) == MAX_WARM_FULL;
    return !s_warm.over || owed();
}
