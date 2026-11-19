// The compositor's pixels as hashes, for work on its speed that must not change one (test/raster_same.sh builds this
// twice, over this tree's terminal.c, pro_canvas.c and pod_draw.c and over another revision's, and compares what the
// two print). Every screen of max_render.c and scenes of random runs of the kinds whose raster was reworked, each
// rasterised through the clips the frame paths use and some they never do: the whole glass, full-width strips of 24
// and 12 rows, 7-row strips at an odd offset and width, and random rectangles. One FNV-1a hash per scene and clip set.
#define MAX_RENDER_SCREENS_ONLY
#include "max_render.c"

#include <stdlib.h>

#include "pod/pod_draw.h"

static uint16_t glass[HT_WIDTH * HT_HEIGHT];
static uint32_t seed = 0x9e3779b9u;

static uint32_t next(void)   // xorshift32: the same sequence on every machine, so both builds draw the same scenes
{
    seed ^= seed << 13;
    seed ^= seed >> 17;
    seed ^= seed << 5;
    return seed;
}
static int pick(int lo, int hi) { return lo + (int)(next() % (uint32_t)(hi - lo + 1)); }   // lo..hi

static uint64_t fnv(uint64_t h, const void *data, size_t n)
{
    const uint8_t *p = data;
    for (size_t i = 0; i < n; i++) h = (h ^ p[i]) * 0x100000001b3ull;
    return h;
}
static uint64_t clip_hash(uint64_t h, const ht_scene_t *s, ht_rect_t clip)
{
    ht_raster(s, clip, glass);
    h = fnv(h, &clip, sizeof clip);
    return fnv(h, glass, (size_t)clip.w * clip.h * sizeof glass[0]);
}
static uint64_t strips(const ht_scene_t *s, int x, int w, int lines)
{
    uint64_t h = 0xcbf29ce484222325ull;
    for (int y = 0; y < HT_HEIGHT; y += lines)
        h = clip_hash(h, s, (ht_rect_t){(int16_t)x, (int16_t)y, (int16_t)w, (int16_t)(y + lines > HT_HEIGHT ? HT_HEIGHT - y : lines)});
    return h;
}
static void dump(const char *name, const ht_scene_t *s)
{
    uint64_t random_clips = 0xcbf29ce484222325ull;
    for (int i = 0; i < 40; i++) {
        const int x = pick(0, HT_WIDTH - 1), y = pick(0, HT_HEIGHT - 1);
        random_clips = clip_hash(random_clips, s,
                                 (ht_rect_t){(int16_t)x, (int16_t)y, (int16_t)pick(1, HT_WIDTH - x), (int16_t)pick(1, HT_HEIGHT - y)});
    }
    printf("%-28s glass %016llx  24 %016llx  12 %016llx  7-odd %016llx  random %016llx\n", name,
           (unsigned long long)strips(s, 0, HT_WIDTH, HT_HEIGHT), (unsigned long long)strips(s, 0, HT_WIDTH, 24),
           (unsigned long long)strips(s, 0, HT_WIDTH, 12), (unsigned long long)strips(s, 1, HT_WIDTH - 3, 7),
           (unsigned long long)random_clips);
}

// Something under the runs to blend over: every RGB565 colour once (256 x 256), or noise with a ragged alpha, or with
// an alpha in runs of none, whole and partial (a pet's, whose spans skip and copy four at a time), plain or faded.
static uint16_t every_colour[256 * 256], noise[256 * 256];
static uint8_t noise_alpha[256 * 256], run_alpha[256 * 256];
static const ht_pro_bitmap_t EVERY = {every_colour, NULL, 256, 256, 0, NULL};
static const ht_pro_bitmap_t NOISE = {noise, noise_alpha, 256, 256, 0, NULL};
static const ht_pro_bitmap_t RUNS = {noise, run_alpha, 256, 256, 0, NULL};

static void ground(ht_scene_t *s)
{
    ht_scene_clear(s, (uint16_t)next());
    for (int i = pick(0, 4); i > 0; i--) ht_pro_image(s, pick(-128, HT_WIDTH - 128), pick(-128, HT_HEIGHT - 128), &NOISE);
    if (next() & 1) ht_pro_image(s, pick(0, HT_WIDTH - 256), pick(0, HT_HEIGHT - 256), &EVERY);
    for (int i = pick(0, 3); i > 0; i--) {
        const ht_pro_bitmap_t *b = next() % 3 ? &RUNS : &EVERY;
        const unsigned opacity = next() & 1 ? 255 : (unsigned)pick(1, 254);
        ht_pro_image_faded(s, pick(-128, HT_WIDTH - 128), pick(-128, HT_HEIGHT - 128), b, opacity);
    }
}
static void size(int *w, int *h, int min)
{
    *w = next() & 3 ? pick(min, 400) : pick(min, HT_WIDTH);
    *h = next() & 3 ? pick(min, 160) : pick(min, HT_HEIGHT);
}
// A radius: none, small, or as round as the box allows (a pill), and sometimes past it (the builders clamp).
static int radius(int w, int h)
{
    const int round = (w < h ? w : h) / 2;
    switch (next() % 4) {
    case 0: return 0;
    case 1: return pick(0, 12);
    case 2: return round;
    default: return pick(0, round + 4);
    }
}

static void random_rects(ht_scene_t *s, int kind)
{
    ground(s);
    for (int n = pick(1, 30); n > 0; n--) {
        int w, h;
        size(&w, &h, 1);
        const int x = pick(-w / 2, HT_WIDTH - w / 2), y = pick(-h / 2, HT_HEIGHT - h / 2), r = radius(w, h);
        const uint16_t ink = (uint16_t)next(), fill = (uint16_t)next();
        switch (kind) {
        case 0: ht_pro_rect(s, x, y, w, h, r, ink); break;
        case 1: ht_pro_rect_aa(s, x, y, w, h, r, ink); break;
        case 2: ht_pro_rect_aa_stroke(s, x, y, w, h, r, ink, fill); break;
        default: {
            const int edge = next() & 1 ? pick(x - 20, x + w + 20) : (next() & 1 ? x : x + w);
            const int gh = next() & 1 ? pick(0, h + 40) : h;
            const unsigned k = next() & 3 ? (unsigned)pick(0, 255) : (next() & 1 ? 0u : 255u);
            pod_veil(s, x, y, w, h, edge, next() & 1, pick(y - 40, y + h), gh, (uint16_t)next(), (uint16_t)next(),
                     (uint16_t)next(), k);
        }
        }
    }
}

// The veil over every colour under it, for each level and a few inks: the blend's arithmetic over its whole domain.
static void veil_everything(ht_scene_t *s, unsigned k_first)
{
    ht_scene_clear(s, 0);
    for (unsigned i = 0; i < 7; i++) {
        const int x = (int)i * 260;
        ht_pro_image(s, x, 0, &EVERY);
        const unsigned k = k_first + i;
        const uint16_t ink = (uint16_t)next();
        pod_veil(s, x, 0, 256, 256, x + 256, true, 0, 1, ink, ink, 0, k > 255 ? 255 : k);
    }
    // A gradient veil (one ink per row) and the bare ground beside it.
    ht_pro_image(s, 0, HT_HEIGHT - 200, &EVERY);
    pod_veil(s, 0, HT_HEIGHT - 200, 400, 200, 128, false, HT_HEIGHT - 200, 200, (uint16_t)next(), (uint16_t)next(),
             (uint16_t)next(), k_first & 255);
}

// pro_canvas.c finds a corner row's spans of none, partial and full coverage by bisecting ht_pro_corner_cover, which
// holds only if the coverage never falls as cx grows along a row. Every radius a run can have, every pixel of its corner.
static bool corner_cover_grows(void)
{
    for (int rad = 1; rad <= 255; rad++)
        for (int cy = 0; cy < rad; cy++)
            for (int cx = 1; cx < rad; cx++)
                if (ht_pro_corner_cover(rad, cx, cy) < ht_pro_corner_cover(rad, cx - 1, cy)) {
                    fprintf(stderr, "raster_dump: corner cover falls at rad %d, (%d, %d)\n", rad, cx, cy);
                    return false;
                }
    return true;
}

int main(void)
{
    static ht_scene_t s;
    if (!corner_cover_grows()) return 1;
    for (int i = 0; i < 256 * 256; i++) {
        every_colour[i] = (uint16_t)i;
        noise[i] = (uint16_t)next();
        const uint32_t a = next() % 4;
        noise_alpha[i] = a == 0 ? 0 : a == 1 ? 255 : (uint8_t)next();
    }
    for (int i = 0; i < 256 * 256;) {
        const uint32_t a = next() % 3;
        for (int n = pick(1, 12); n > 0 && i < 256 * 256; n--, i++)
            run_alpha[i] = a == 0 ? 0 : a == 1 ? 255 : (uint8_t)next();
    }
    printf("raster_dump %dx%d\n", HT_WIDTH, HT_HEIGHT);
    for (int i = 0; i < SCREEN_COUNT; i++) {
        draw(&SCREENS[i]);
        dump(SCREENS[i].name, &S);
    }
    static const char *const KINDS[] = {"rect", "rect_aa", "rect_aa_stroke", "veil"};
    char name[40];
    for (int kind = 0; kind < 4; kind++)
        for (int n = 0; n < 60; n++) {
            random_rects(&s, kind);
            snprintf(name, sizeof name, "%s %d", KINDS[kind], n);
            dump(name, &s);
        }
    for (unsigned k = 0; k < 256 + 7; k += 7) {
        veil_everything(&s, k);
        snprintf(name, sizeof name, "veil every colour %u", k);
        dump(name, &s);
    }
    return 0;
}
