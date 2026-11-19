// Dev tool: what App Detail's row costs on the host while it moves, against a whole-glass raster, at the glass it is
// built for (1920 x HT_HEIGHT). A motion frame is the render task's work for one frame of 16 ms: max_ui_render (the
// row's layers are painted in it), then the damage between the last scene and this one rasterised in strips of 24
// rows, as pro_frame_present does it. Built and run by test/max_motion_bench.sh (max_motion_bench -v: every frame).
// The demo model and its scenes are max_render.c's.
#include <time.h>

#define main max_render_main
#include "max_render.c"
#undef main
#include "max_ui_draw.h"   // max_layer_painted

enum { REPEATS = 9, FRAMES = 96, STRIP = 24, FRAME_MS = 16 };

static ht_scene_t s_scene[2];
static int s_front;
static uint16_t s_px[HT_WIDTH * STRIP];

static double now_us(void)
{
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1e6 + t.tv_nsec / 1e3;
}

typedef struct { double build, raster; uint32_t damage; } cost_t;

// One frame at `now`: the scene built over the other buffer, then what changed rasterised.
static cost_t frame_at(uint32_t now)
{
    ht_scene_t *prev = &s_scene[s_front], *next = &s_scene[s_front ^ 1];
    const double t0 = now_us();
    ht_scene_clear(next, ht_rgb(HT_THEME_CANVAS));
    max_ui_render(next, now);
    const double t1 = now_us();
    ht_damage_t d;
    ht_damage(prev, next, &d);
    for (int n = 0; n < d.count; n++) {
        const ht_rect_t r = d.rect[n];
        const int step = r.w * r.h <= 2048 ? r.h : STRIP;
        for (int y = r.y; y < r.y + r.h; y += step) {
            const int h = r.y + r.h - y < step ? r.y + r.h - y : step;
            ht_raster(next, (ht_rect_t){r.x, (int16_t)y, r.w, (int16_t)h}, s_px);
        }
    }
    s_front ^= 1;
    return (cost_t){t1 - t0, now_us() - t1, d.pixels};
}

// The whole glass of the page as it stands, rasterised in strips: the least of 4 * REPEATS.
static double whole_glass(void)
{
    double least = 1e9;
    for (int i = 0; i < 4 * REPEATS; i++) {
        const double t0 = now_us();
        for (int y = 0; y < HT_HEIGHT; y += STRIP) {
            const int h = HT_HEIGHT - y < STRIP ? HT_HEIGHT - y : STRIP;
            ht_raster(&s_scene[s_front], (ht_rect_t){0, (int16_t)y, HT_WIDTH, (int16_t)h}, s_px);
        }
        const double t = now_us() - t0;
        least = t < least ? t : least;
    }
    return least;
}

// A motion: set_up puts the page at rest (drawn at T0 - 1000 and the frame before T0), go starts it at T0, and step
// (may be NULL) is called before each of its first `steps` frames with the frame's time. It runs until the row stops
// moving.
typedef struct {
    const char *name;
    void (*set_up)(void);
    void (*go)(void);
    void (*step)(int frame, uint32_t now);
    int steps;
} motion_t;

static void overview_rest(void) { orca(); show(MAX_VIEW_OVERVIEW, NULL); }
static void agent_rest(void)
{
    orca();
    show(MAX_VIEW_OVERVIEW, NULL);
    frame_at(T0 - 2000);
    max_open("rate");
}
static void nothing(void) {}
static void open_rate(void) { max_open("rate"); }
static void close_rate(void) { max_show(MAX_VIEW_OVERVIEW); }
// A finger across the row at 750 px/s for 40 frames from 1400, then let go: the row follows it, then settles.
static void drag_row(int frame, uint32_t now)
{
    if (frame == 0) max_ui_touch(true, 1400, 240, now);
    else if (frame <= 40) max_ui_touch(true, 1400 - 12 * frame, 240, now);
    else if (frame == 41) max_ui_touch(false, 1400 - 12 * 40, 240, now);
}
// The same over the slivers beside the open agent: from the right one, the row dragged the other way.
static void drag_slivers(int frame, uint32_t now)
{
    if (frame == 0) max_ui_touch(true, 1650, 240, now);
    else if (frame <= 30) max_ui_touch(true, 1650 + 4 * frame, 240, now);
    else if (frame == 31) max_ui_touch(false, 1650 + 4 * 30, 240, now);
}

static const motion_t MOTIONS[] = {
    {"drag + snap", overview_rest, nothing, drag_row, 42},
    {"open", overview_rest, open_rate, NULL, 0},
    {"close", agent_rest, close_rate, NULL, 0},
    {"drag slivers", agent_rest, nothing, drag_slivers, 32},
};
enum { MOTION_COUNT = sizeof MOTIONS / sizeof MOTIONS[0] };

// Runs one motion REPEATS times; prints its frames' mean and worst cost (each frame's least of the runs: the host's
// other work only ever adds), the first run's worst (before the kept slivers were painted), and each against the whole
// glass of the page it moves on. verbose: each frame's build and raster, its damage and the layers it painted.
static void bench(const motion_t *m, double glass, bool verbose)
{
    static cost_t cost[REPEATS][FRAMES];
    static unsigned painted[FRAMES];
    int frames = 0;
    double cold = 0;
    for (int r = 0; r < REPEATS; r++) {
        m->set_up();
        frame_at(T0 - 1000);
        frame_at(T0 - FRAME_MS);
        m->go();
        int f = 0;
        for (; f < FRAMES; f++) {
            const uint32_t now = T0 + (uint32_t)(f * FRAME_MS);
            if (m->step && f < m->steps) m->step(f, now);
            const unsigned before = max_layer_painted();
            cost[r][f] = frame_at(now);
            painted[f] = max_layer_painted() - before;
            const double c = cost[r][f].build + cost[r][f].raster;
            if (!r && c > cold) cold = c;
            if (f >= m->steps && !max_row_moving(now)) {   // this frame drew where it rests
                f++;
                break;
            }
        }
        frames = f;
    }
    double sum = 0, worst = 0, px = 0;
    for (int f = 0; f < frames; f++) {
        cost_t least = cost[0][f];
        for (int r = 1; r < REPEATS; r++) {
            if (cost[r][f].build < least.build) least.build = cost[r][f].build;
            if (cost[r][f].raster < least.raster) least.raster = cost[r][f].raster;
        }
        const double c = least.build + least.raster;
        sum += c;
        worst = c > worst ? c : worst;
        px += least.damage;
        if (verbose)
            printf("    %3d ms  build %5.0f us  raster %5.0f us  damage %3.0f%%  layers painted %u\n", f * FRAME_MS,
                   least.build, least.raster, 100.0 * least.damage / (HT_WIDTH * HT_HEIGHT), painted[f]);
    }
    const double mean = sum / frames;
    printf("  %-13s %2d frames  mean %5.0f us (%3.0f%%)  worst %5.0f us (%3.0f%%)  cold worst %5.0f us (%3.0f%%)"
           "  damage %3.0f%% of the glass\n",
           m->name, frames, mean, 100 * mean / glass, worst, 100 * worst / glass, cold, 100 * cold / glass,
           100 * px / frames / (HT_WIDTH * HT_HEIGHT));
}

int main(int argc, char **argv)
{
    const bool verbose = argc > 1 && !strcmp(argv[1], "-v");
    overview_rest();
    frame_at(T0 - 1000);
    frame_at(T0);
    const double overview = whole_glass();
    agent_rest();
    frame_at(T0 - 1000);
    frame_at(T0);
    const double agent = whole_glass();
    printf("%d x %d: whole glass raster  overview %.0f us  agent page %.0f us\n", HT_WIDTH, HT_HEIGHT, overview, agent);
    for (int i = 0; i < MOTION_COUNT; i++)
        bench(&MOTIONS[i], MOTIONS[i].set_up == agent_rest ? agent : overview, verbose);
    return 0;
}
