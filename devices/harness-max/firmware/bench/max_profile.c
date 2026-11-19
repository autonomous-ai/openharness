// Dev tool: where the renderer's time goes, on this computer. Every screen of test/max_render.c built and rasterised
// whole at the glass's size as max_display.c does it on the ESP32-P4 (full-width strips of PRO_STRIP_LINES rows into one
// buffer), then the same strips through ht_raster's loop run by run, to split the time by run kind; the frames that
// change only part of a screen; the strip turn. bench/profile.sh builds it with the device's optimisation and runs it.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "bench_raster.h"
#include "bench_scenes.h"
#include "max_turn.h"
#include "pod/pod_draw.h"

enum { REPS = 5, KIND_REPS = 10, FRAME_REPS = 50, TURN_REPS = 200, SCREENS_MAX = 64 };

static ht_scene_t scene, before, after;
static uint16_t strip[PRO_STRIP_PX], band[PRO_STRIP_PX];

static uint64_t ns(void)
{
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC_RAW, &t);
    return (uint64_t)t.tv_sec * 1000000000u + (uint64_t)t.tv_nsec;
}
static uint32_t clock32(void) { return (uint32_t)ns(); }
static double ms(uint64_t t) { return (double)t / 1e6; }

static int by_value(const void *a, const void *b)
{
    const double x = *(const double *)a, y = *(const double *)b;
    return x < y ? -1 : x > y;
}
static void spread(const char *what, const double *v, int n)
{
    double s[SCREENS_MAX], sum = 0;
    memcpy(s, v, (size_t)n * sizeof s[0]);
    qsort(s, (size_t)n, sizeof s[0], by_value);
    for (int i = 0; i < n; i++) sum += s[i];
    printf("%s: median %.3f ms, mean %.3f ms, max %.3f ms\n", what, s[n / 2], sum / n, s[n - 1]);
}

int main(void)
{
    const int screens = bench_screen_count() < SCREENS_MAX ? bench_screen_count() : SCREENS_MAX;
    printf("Harness Max raster profile: %d x %d glass, %d-line strips, %d screens\n\n", HT_WIDTH, HT_HEIGHT,
           PRO_STRIP_LINES, screens);

    // Per screen: the scene's building (max_ui_render), the glass with no pet cell baked yet (the first frame, and each
    // new pet frame), and the glass warm; the best of a few passes each.
    bench_kinds_t all = {0};
    double build[SCREENS_MAX], cold[SCREENS_MAX], warm[SCREENS_MAX];
    printf("%-24s %5s %8s %8s %8s  %s\n", "screen", "runs", "build", "cold", "warm", "costliest kinds, warm (ms)");
    for (int i = 0; i < screens; i++) {
        bench_screen(i, &scene);
        uint64_t b = UINT64_MAX, c = UINT64_MAX, w = UINT64_MAX;
        for (int rep = 0; rep < REPS; rep++) {
            uint64_t t = ns();
            bench_redraw(&scene);
            if (ns() - t < b) b = ns() - t;
            pod_cell_bake_reset();
            t = ns();
            bench_glass(&scene, strip, 0, 1);
            if (ns() - t < c) c = ns() - t;
            t = ns();
            bench_glass(&scene, strip, 0, 1);
            if (ns() - t < w) w = ns() - t;
        }
        build[i] = ms(b), cold[i] = ms(c), warm[i] = ms(w);
        bench_kinds_t k = {0};
        for (int rep = 0; rep < KIND_REPS; rep++) bench_glass_kinds(&scene, strip, &k, clock32);
        int top[3] = {-1, -1, -1};
        for (int kind = 0; kind < BENCH_KINDS; kind++) {
            all.ticks[kind] += k.ticks[kind] / KIND_REPS;
            all.px[kind] += k.px[kind] / KIND_REPS;
            all.calls[kind] += k.calls[kind] / KIND_REPS;
            for (int t = 0; t < 3; t++)
                if (top[t] < 0 || k.ticks[kind] > k.ticks[top[t]]) {
                    memmove(top + t + 1, top + t, (size_t)(2 - t) * sizeof top[0]);
                    top[t] = kind;
                    break;
                }
        }
        printf("%-24s %5d %8.3f %8.3f %8.3f ", bench_screen_name(i), scene.count, build[i], cold[i], warm[i]);
        for (int t = 0; t < 3; t++)
            if (top[t] >= 0 && k.ticks[top[t]])
                printf(" %s %.3f", bench_kind_name((bench_kind_t)top[t]), ms(k.ticks[top[t]] / KIND_REPS));
        printf("\n");
    }
    printf("\n");
    spread("scene build", build, screens);
    spread("glass, cold", cold, screens);
    spread("glass, warm", warm, screens);

    // By kind, over every screen once: where a full repaint's time goes, and what one pixel of the kind costs.
    uint64_t total = 0;
    for (int kind = 0; kind < BENCH_KINDS; kind++) total += all.ticks[kind];
    printf("\n%-16s %9s %6s %8s %9s %7s\n", "kind (warm)", "ms", "share", "calls", "Mpx", "ns/px");
    for (int kind = 0; kind < BENCH_KINDS; kind++) {
        if (!all.calls[kind]) continue;
        printf("%-16s %9.3f %5.1f%% %8u %9.2f %7.2f\n", bench_kind_name((bench_kind_t)kind), ms(all.ticks[kind]),
               100.0 * (double)all.ticks[kind] / (double)total, (unsigned)all.calls[kind], (double)all.px[kind] / 1e6,
               all.px[kind] ? (double)all.ticks[kind] / (double)all.px[kind] : 0.0);
    }
    printf("%-16s %9.3f   (every screen once, run by run)\n\n", "all", ms(total));

    // The frames that change part of a screen, as pro_frame_present repaints them.
    printf("%-24s %5s %8s %8s  %s\n", "partial frame", "rects", "px", "ms", "costliest kinds (ms)");
    for (int i = 0; i < bench_partial_count(); i++) {
        bench_partial(i, &before, &after);
        int rects = 0;
        const uint32_t px = bench_frame(&before, &after, strip, &rects);
        uint64_t best = UINT64_MAX;
        for (int rep = 0; rep < FRAME_REPS; rep++) {
            const uint64_t t = ns();
            bench_frame(&before, &after, strip, NULL);
            if (ns() - t < best) best = ns() - t;
        }
        bench_kinds_t k = {0};
        for (int rep = 0; rep < KIND_REPS; rep++) bench_frame_kinds(&before, &after, strip, &k, clock32);
        printf("%-24s %5d %8u %8.3f ", bench_partial_name(i), rects, (unsigned)px, ms(best));
        for (int shown = 0, done[BENCH_KINDS] = {0}; shown < 3; shown++) {
            int top = -1;
            for (int kind = 0; kind < BENCH_KINDS; kind++)
                if (!done[kind] && k.ticks[kind] && (top < 0 || k.ticks[kind] > k.ticks[top])) top = kind;
            if (top < 0) break;
            done[top] = 1;
            printf(" %s %.3f (%.0f k px)", bench_kind_name((bench_kind_t)top), ms(k.ticks[top] / KIND_REPS),
                   (double)k.px[top] / KIND_REPS / 1000);
        }
        printf("\n");
    }

    // The strip turn into the panel's portrait raster (max_turn.c), as pro_panel_submit does it per strip.
    for (int i = 0; i < PRO_STRIP_PX; i++) strip[i] = (uint16_t)(i * 2654435761u >> 16);
    uint64_t best = UINT64_MAX;
    for (int rep = 0; rep < TURN_REPS; rep++) {
        const uint64_t t = ns();
        max_turn_pixels(strip, HT_WIDTH, PRO_STRIP_LINES, band);
        if (ns() - t < best) best = ns() - t;
    }
    printf("\nturn %dx%d strip: %.3f ms, whole glass (%d strips): %.3f ms\n", HT_WIDTH, PRO_STRIP_LINES, ms(best),
           BENCH_GLASS_STRIPS, ms(best) * BENCH_GLASS_STRIPS);
    return band[0] == 0xdead;   // keeps the turn from being optimised away
}
