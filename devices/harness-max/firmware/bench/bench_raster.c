#include "bench_raster.h"

#include "pod/pod_draw.h"
#include "pro_canvas.h"

const char *bench_kind_name(bench_kind_t kind)
{
    static const char *const NAMES[BENCH_KINDS] = {
        "background", "text", "rect", "image", "rect_aa", "rect_aa_stroke", "cell", "arc", "grad", "grad_aa",
        "grad_dither", "tri", "veil", "other"};
    return kind < BENCH_KINDS ? NAMES[kind] : "?";
}

// pro_canvas.c keeps its kinds' numbers to itself (PRO_TEXT = 1 .. PRO_RECT_AA_STROKE = 5); Pod's are pod_draw.h's.
// A gradient's flavour is the third field of pod_draw.c's grad_params_t (1 anti-aliased, 3 dithered), packed in text.
static bench_kind_t kind_of(const ht_run_t *r)
{
    switch (r->pro_kind) {
    case 1: return BENCH_TEXT;
    case 2: return BENCH_RECT;
    case 3: return BENCH_IMAGE;
    case 4: return BENCH_RECT_AA;
    case 5: return BENCH_RECT_AA_STROKE;
    case POD_CELL: return BENCH_CELL;
    case POD_ARC: return BENCH_ARC;
    case POD_GRAD: return r->text[4] == 3 ? BENCH_GRAD_DITHER : r->text[4] == 1 ? BENCH_GRAD_AA : BENCH_GRAD;
    case POD_TRI: return BENCH_TRI;
    case POD_VEIL: return BENCH_VEIL;
    default: return BENCH_OTHER;
    }
}

static int imin(int a, int b) { return a < b ? a : b; }
static int imax(int a, int b) { return a > b ? a : b; }

static ht_rect_t strip_at(int n)
{
    const int y = n * PRO_STRIP_LINES;
    return (ht_rect_t){0, (int16_t)y, HT_WIDTH, (int16_t)imin(PRO_STRIP_LINES, HT_HEIGHT - y)};
}

void bench_glass(const ht_scene_t *scene, uint16_t *strip, int first, int step)
{
    for (int n = first; n < BENCH_GLASS_STRIPS; n += step) ht_raster(scene, strip_at(n), strip);
}

void bench_glass_kinds(const ht_scene_t *scene, uint16_t *strip, bench_kinds_t *kinds, bench_clock_t clock)
{
    for (int n = 0; n < BENCH_GLASS_STRIPS; n++) {
        const ht_rect_t clip = strip_at(n);
        const size_t px = (size_t)clip.w * clip.h;
        uint32_t t = clock();
        for (size_t i = 0; i < px; i++) strip[i] = scene->background;
        kinds->ticks[BENCH_BACKGROUND] += (uint32_t)(clock() - t);
        kinds->px[BENCH_BACKGROUND] += px;
        kinds->calls[BENCH_BACKGROUND]++;
        for (int i = 0; i < scene->count; i++) {
            const ht_run_t *r = &scene->runs[i];
            const ht_rect_t b = ht_run_bounds(r);
            const int x0 = imax(b.x, clip.x), x1 = imin(b.x + b.w, clip.x + clip.w);
            const int y0 = imax(b.y, clip.y), y1 = imin(b.y + b.h, clip.y + clip.h);
            if (!r->pro_kind || x0 >= x1 || y0 >= y1) continue;
            const bench_kind_t k = kind_of(r);
            t = clock();
            ht_pro_raster(r, clip, strip);
            kinds->ticks[k] += (uint32_t)(clock() - t);
            kinds->px[k] += (uint64_t)(x1 - x0) * (uint64_t)(y1 - y0);
            kinds->calls[k]++;
        }
    }
}

uint32_t bench_frame(const ht_scene_t *prev, const ht_scene_t *next, uint16_t *strip, int *rects)
{
    ht_damage_t damage;
    ht_damage(prev, next, &damage);
    for (int n = 0; n < damage.count; n++) {
        const ht_rect_t rect = damage.rect[n];
        const int step = rect.w * rect.h <= 2048 ? rect.h : PRO_STRIP_LINES;   // pro_frame.c's split
        for (int y = rect.y; y < rect.y + rect.h; y += step) {
            const int h = imin(step, rect.y + rect.h - y);
            ht_raster(next, (ht_rect_t){rect.x, (int16_t)y, rect.w, (int16_t)h}, strip);
        }
    }
    if (rects) *rects = damage.count;
    return damage.pixels;
}
