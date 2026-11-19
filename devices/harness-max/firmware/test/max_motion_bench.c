// Dev tool: what App Detail's row costs on the host while it moves, against a whole-glass raster, at the glass it is
// built for (1920 x HT_HEIGHT). A motion frame is the render task's work for one frame of 16 ms: max_ui_render (the
// row's layers are painted in it), then the damage between the last scene and this one rasterised in strips of 24
// rows, as pro_frame_present does it. Built and run by test/max_motion_bench.sh (max_motion_bench -v: every frame).
// The demo model and its scenes are max_render.c's.
// Each motion runs cold (nothing kept), then ahead (nothing kept, then max_ui_warm while the page rests, as the render
// task paints it ahead), then warm: its first frames (0 and 1) ahead must cost no more than its warm worst.
#include <stdlib.h>
#include <time.h>

#define main max_render_main
#include "max_render.c"
#undef main
#include "max_motions.h"
#include "max_ui_draw.h"   // max_layer_painted

enum { REPEATS = 9, FRAMES = 128, STRIP = 24, FRAME_MS = 16 };

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

// The whole glass of the page as it stands, rasterised in strips: the least of n.
static double whole_glass(int n)
{
    double least = 1e9;
    for (int i = 0; i < n; i++) {
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

static void draw_frame(uint32_t now) { frame_at(now); }

// Runs one motion REPEATS times; prints its frames' mean and worst cost (each frame's least of the runs: the host's
// other work only ever adds, and the runs after the first find the pets' images and the slivers kept), the first run's
// mean and worst (cold: nothing kept, every image painted as it first appears), the second's first frames and worst
// (ahead: nothing kept, then painted ahead: max_ui_warm's steps as max_app.c takes them, their time and its spread),
// and each against the
// whole glass of the page it moves on, timed before each run (the least of them: a host's cores and clocks change under
// a run of seconds, and the frames and the glass they are measured against must be timed alike). verbose: each frame's
// build and raster, its damage, the layers and pets it painted and the pet frames it resampled (pod_cell_bakes: below
// 1x a frame is resampled once a size and ground).
// A step out of the lock makes bands for STEP_US: the P4's WARM_STEP_US (max_app.c) at the host's ~60x its speed. A
// step over OVER_US is one over the P4's 4 ms at that speed.
enum { STEP_US = 3000 / 60, OVER_US = 4000 / 60, STEPS = 8192 };
static double s_until;
static bool step_on(void) { return now_us() < s_until; }
static int by_time(const void *a, const void *b)
{
    const double x = *(const double *)a, y = *(const double *)b;
    return x < y ? -1 : x > y;
}

static void bench(const max_motion_t *m, bool verbose)
{
    static double step_us[STEPS];
    int locked = 0;
    double locked_max = 0;
    static cost_t cost[REPEATS][FRAMES];
    static unsigned painted[FRAMES], baked[FRAMES];
    int frames = 0, steps = 0;
    double cold = 0, cold_sum = 0, glass = 1e9, ahead = 0, ahead_first = 0, ahead_us = 0;
    for (int r = 0; r < REPEATS; r++) {
        if (r < 2) {
            max_layer_forget();
            pod_cell_bake_reset();
        }
        m->set_up(draw_frame);
        frame_at(T0 - 1000);
        frame_at(T0 - 500);
        frame_at(T0 - FRAME_MS);
        for (bool more = r == 1; more && steps < STEPS; steps++) {
            const double t0 = now_us();
            s_until = t0 + STEP_US;
            const bool out = max_ui_warm_paint(step_on);
            if (!out) more = max_ui_warm(T0 - FRAME_MS);
            const double t = now_us() - t0;
            if (!out) locked++, locked_max = t > locked_max ? t : locked_max;
            step_us[steps] = t;
            ahead_us += t;
        }
        const double g = whole_glass(4);
        glass = g < glass ? g : glass;
        m->go();
        int f = 0;
        for (; f < FRAMES; f++) {
            const uint32_t now = T0 + (uint32_t)(f * FRAME_MS);
            if (m->step && f < m->steps) m->step(f, now);
            const unsigned before = max_layer_painted(), bakes = pod_cell_bakes();
            cost[r][f] = frame_at(now);
            painted[f] = max_layer_painted() - before;
            baked[f] = pod_cell_bakes() - bakes;
            const double c = cost[r][f].build + cost[r][f].raster;
            if (!r && c > cold) cold = c;
            if (!r) cold_sum += c;
            if (r == 1 && c > ahead) ahead = c;
            if (r == 1 && f < 2 && c > ahead_first) ahead_first = c;
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
            printf("    %3d ms  build %5.0f us  raster %5.0f us  damage %3.0f%%  layers painted %u  pet frames baked %u\n",
                   f * FRAME_MS, least.build, least.raster, 100.0 * least.damage / (HT_WIDTH * HT_HEIGHT), painted[f],
                   baked[f]);
    }
    const double mean = sum / frames, cold_mean = cold_sum / frames;
    printf("  %-13s %2d frames  glass %4.0f us  mean %5.0f us (%3.0f%%)  worst %5.0f us (%3.0f%%)  cold mean %5.0f us"
           " (%3.0f%%)  worst %5.0f us (%3.0f%%)  damage %3.0f%%\n",
           m->name, frames, glass, mean, 100 * mean / glass, worst, 100 * worst / glass, cold_mean,
           100 * cold_mean / glass, cold, 100 * cold / glass, 100 * px / frames / (HT_WIDTH * HT_HEIGHT));
    int over = 0;
    for (int i = 0; i < steps; i++) over += step_us[i] > OVER_US;
    qsort(step_us, (size_t)steps, sizeof step_us[0], by_time);
    printf("  %-13s ahead: first frames %5.0f us (%3.0f%%, %s the warm worst)  worst %5.0f us (%3.0f%%)  painted in"
           " %d steps (%d under the lock), %.1f ms\n",
           "", ahead_first, 100 * ahead_first / glass, ahead_first <= worst ? "within" : "OVER", ahead,
           100 * ahead / glass, steps, locked, ahead_us / 1000);
    printf("  %-13s ahead: a step p50 %3.0f us  p95 %3.0f us  max %4.0f us, %d over %d us; under the lock max %4.0f us\n",
           "", step_us[steps / 2], step_us[steps * 95 / 100], step_us[steps - 1], over, OVER_US, locked_max);
}

int main(int argc, char **argv)
{
    const bool verbose = argc > 1 && !strcmp(argv[1], "-v");
    printf("%d x %d: each motion's frames against a whole-glass raster of the page it starts on (glass)\n", HT_WIDTH,
           HT_HEIGHT);
    for (int i = 0; i < MAX_MOTION_COUNT; i++) bench(&MAX_MOTIONS[i], verbose);
    return 0;
}
