// max_render.c is compiled into this file without its tool (MAX_RENDER_SCREENS_ONLY): its screens and the helpers that
// set them up are this file's, so a screen added there is timed here too.
#define MAX_RENDER_SCREENS_ONLY
#include "max_render.c"

#include "bench_scenes.h"
#include "max_motions.h"

int bench_screen_count(void) { return SCREEN_COUNT; }
const char *bench_screen_name(int i) { return SCREENS[i].name; }

void bench_screen(int i, ht_scene_t *out)
{
    draw(&SCREENS[i]);
    *out = S;
}

void bench_redraw(ht_scene_t *out)
{
    ht_scene_clear(out, ht_rgb(HT_THEME_CANVAS));
    max_ui_render(out, T0);
}

// The band's waveform takes the mic's next level, one band frame later.
static void next_level(uint32_t at) { max_ui_level(4, at); }
// An agent on Overview reports what it does now: its cell's line changes.
static void new_activity(uint32_t at) { max_ui_turn("auth", "activity", "router.ts", 270, at); }

// What changes most often: the band while the person talks (ten times a second), the agent page's counter (once a
// second) and an agent's cell (at each step of its turn).
static const struct {
    const char *name;
    void (*setup)(void);
    void (*change)(uint32_t at);
    uint32_t after_ms;
} PARTIALS[] = {
    {"listening band", s_agent_listening, next_level, MAX_TALK_FRAME_MS},
    {"agent page second", s_agent_working, NULL, 1000},
    {"overview cell", s_overview, new_activity, 1000},
};
enum { PARTIAL_COUNT = sizeof PARTIALS / sizeof PARTIALS[0] };
// And one frame of motion, which no screen has yet: Overview with everything but the glass-wide runs 40 px on, as a
// row sliding a step would be. Most of the glass changes. A run that would cross the right edge stays put.
#define MOTION_PX 40

int bench_partial_count(void) { return PARTIAL_COUNT + 1; }
const char *bench_partial_name(int i) { return i < PARTIAL_COUNT ? PARTIALS[i].name : "overview +40 px"; }

static void motion(ht_scene_t *before, ht_scene_t *after)
{
    s_overview();
    ht_scene_clear(before, ht_rgb(HT_THEME_CANVAS));
    max_ui_render(before, T0);
    *after = *before;
    for (int i = 0; i < after->count; i++) {
        ht_run_t *r = &after->runs[i];
        if (r->w < HT_WIDTH && r->x + r->w + MOTION_PX <= HT_WIDTH) r->x += MOTION_PX;
    }
}

void bench_partial(int i, ht_scene_t *before, ht_scene_t *after)
{
    if (i == PARTIAL_COUNT) {
        motion(before, after);
        return;
    }
    PARTIALS[i].setup();
    ht_scene_clear(before, ht_rgb(HT_THEME_CANVAS));
    max_ui_render(before, T0);
    const uint32_t at = T0 + PARTIALS[i].after_ms;
    if (PARTIALS[i].change) PARTIALS[i].change(at);
    ht_scene_clear(after, ht_rgb(HT_THEME_CANVAS));
    max_ui_render(after, at);
}

int bench_motion_count(void) { return MAX_MOTION_COUNT; }
const char *bench_motion_name(int i) { return MAX_MOTIONS[i].name; }

void bench_draw(ht_scene_t *out, uint32_t now)
{
    ht_scene_clear(out, ht_rgb(HT_THEME_CANVAS));
    max_ui_render(out, now);
}

static void (*s_frame)(uint32_t now, int f);
static void set_up_frame(uint32_t now) { s_frame(now, -1); }

int bench_motion(int i, void (*frame)(uint32_t now, int f))
{
    const max_motion_t *m = &MAX_MOTIONS[i];
    s_frame = frame;
    m->set_up(set_up_frame);
    frame(T0 - 1000, -1);
    frame(T0 - MAX_ROW_FRAME_MS, -1);
    m->go();
    for (int f = 0; f < BENCH_MOTION_FRAMES; f++) {
        const uint32_t now = T0 + (uint32_t)f * MAX_ROW_FRAME_MS;
        if (m->step && f < m->steps) m->step(f, now);
        frame(now, f);
        if (f >= m->steps && !max_row_moving(now)) return f + 1;   // this frame drew where it rests
    }
    return BENCH_MOTION_FRAMES;
}
