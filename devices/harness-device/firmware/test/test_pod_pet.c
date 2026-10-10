// Task 4: the pet player.
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "pod/pod_draw.h"
#include "pod/pod_pet.h"
#include "pro_canvas.h"

static int checks;
#define CHECK(c) do { assert(c); checks++; } while (0)

static const char *const engines[] = {"claude", "codex", "muse"};
static const pod_scene_t scenes[] = {POD_SCENE_REST, POD_SCENE_WORK, POD_SCENE_ASK,
                                     POD_SCENE_RELAX, POD_SCENE_LISTEN, POD_SCENE_SEND};

static void pet_test_runs_constant(void)
{
    for (unsigned e = 0; e < 3; e++)
        for (unsigned k = 0; k < 6; k++) {
            if (!pod_pet_has(engines[e], scenes[k])) continue;
            unsigned want = pod_pet_runs(engines[e], scenes[k]);
            CHECK(want >= 1 && want <= 40);
            for (uint32_t t = 0; t <= 5000; t += 37) {
                ht_scene_t s; ht_scene_clear(&s, 0);
                pod_pet_draw(&s, 10, 20, 270, engines[e], scenes[k], t, 0);
                CHECK(s.count == want);
            }
        }
}
// The pet is drawn straight on the glass: no ground rect under it, the frame is the scene's first run.
static const void *frame_of(const ht_scene_t *s) { return s->runs[0].bitmap.asset; }

static void pet_test_frames_advance(void)
{
    const ht_pet_t *p = pod_pet_for("claude");
    CHECK(p && p->working_scene);
    ht_scene_t a, b;
    ht_scene_clear(&a, 0); ht_scene_clear(&b, 0);
    pod_pet_draw(&a, 0, 0, 270, "claude", POD_SCENE_WORK, 0, 0);
    // Claude's loop holds pose 0 for its first nine steps (only the hop moves), so compare with step 9.
    pod_pet_draw(&b, 0, 0, 270, "claude", POD_SCENE_WORK, 9 * p->working_scene->step_ms, 0);
    CHECK(frame_of(&a) && frame_of(&b) && frame_of(&a) != frame_of(&b));
    ht_scene_t h; ht_scene_clear(&h, 0);   // the next step moves the same pose (step_dy)
    pod_pet_draw(&h, 0, 0, 270, "claude", POD_SCENE_WORK, p->working_scene->step_ms, 0);
    CHECK(memcmp(&a.runs[0], &h.runs[0], sizeof a.runs[0]) != 0 || frame_of(&a) == frame_of(&h));
}
static void pet_test_send_once(void)
{
    const ht_pet_t *p = pod_pet_for("claude");
    CHECK(p && p->sending_scene && pod_pet_has("claude", POD_SCENE_SEND));
    const ht_pet_scene_t *sc = p->sending_scene;
    uint32_t start = 5000;
    ht_scene_t a, b, c;
    ht_scene_clear(&a, 0); ht_scene_clear(&b, 0); ht_scene_clear(&c, 0);
    pod_pet_draw(&a, 0, 0, 270, "claude", POD_SCENE_SEND, start + sc->steps * sc->step_ms + 1000, start);
    pod_pet_draw(&b, 0, 0, 270, "claude", POD_SCENE_SEND, start + (sc->steps - 1u) * sc->step_ms, start);
    CHECK(a.count == b.count && frame_of(&a) == frame_of(&b));
    CHECK(!memcmp(&a.runs[0], &b.runs[0], sizeof a.runs[0]));
    pod_pet_draw(&c, 0, 0, 270, "claude", POD_SCENE_SEND, start, start);   // it starts at its first step
    CHECK(frame_of(&c) == sc->frames + sc->loop[0] || frame_of(&c) != frame_of(&a) || sc->steps == 1);
}
static void pet_test_no_pet(void)
{
    CHECK(pod_pet_for("cursor") == NULL);
    CHECK(!pod_pet_has("cursor", POD_SCENE_REST));
    // Cursor's mark is light: it would vanish on the pale box, so the cover is dark and the mark (one scaled run, 55% of
    // the cover) sits centred on it.
    ht_scene_t s; ht_scene_clear(&s, 0);
    pod_pet_draw(&s, 0, 0, 270, "cursor", POD_SCENE_WORK, 123, 0);
    CHECK(s.count == 2 && pod_pet_runs("cursor", POD_SCENE_WORK) == 2);
    CHECK(pod_mark("cursor")->light);
    CHECK(s.runs[0].fg == ht_rgb(0x1d1e23) && s.runs[0].w == 270 && s.runs[0].pro_height == 270 && s.runs[0].radius == 14);
    CHECK(s.runs[1].bitmap.pixels == pod_logo_find("cursor", 72)->px && s.runs[1].w == 72 && s.runs[1].pro_height == 72);
    CHECK(s.runs[1].x == (270 - 72) / 2 && s.runs[1].y == (270 - 72) / 2);
    // A dark mark (Kilo's) keeps the pale box, drawn the same size.
    ht_scene_t k; ht_scene_clear(&k, 0);
    CHECK(!pod_mark("kilo")->light && !pod_pet_for("kilo"));
    pod_pet_draw(&k, 10, 20, 132, "kilo", POD_SCENE_REST, 0, 0);
    CHECK(k.count == 2 && pod_pet_runs("kilo", POD_SCENE_REST) == 2);
    CHECK(k.runs[0].fg == ht_rgb(0xf0f4f0) && k.runs[1].bitmap.pixels == pod_logo_find("kilo", 72)->px && k.runs[1].w == 72 && k.runs[1].x == 10 + 30 && k.runs[1].y == 20 + 30);
}
// The light mark is visible: rasterised, the box under it is dark (0x1d1e23) and the mark's own pixels are far lighter.
static void pet_test_light_mark_on_dark(void)
{
    enum { SIDE = 132 };
    static uint16_t px[SIDE * SIDE];
    ht_scene_t s; ht_scene_clear(&s, ht_rgb(0xffffff));
    pod_pet_draw(&s, 0, 0, SIDE, "cursor", POD_SCENE_REST, 0, 0);
    for (int i = 0; i < SIDE * SIDE; i++) px[i] = ht_rgb(0xffffff);
    for (int i = 0; i < s.count; i++) ht_pro_raster(&s.runs[i], (ht_rect_t){0, 0, SIDE, SIDE}, px);
    unsigned dark = 0, light = 0;
    for (int y = 30; y < 102; y++)
        for (int x = 30; x < 102; x++) {
            unsigned g = (px[y * SIDE + x] >> 5) & 63;
            if (g < 14) dark++; else if (g > 40) light++;
        }
    CHECK(px[3 * SIDE + 60] == ht_rgb(0x1d1e23) && px[SIDE / 2 * SIDE + 6] == ht_rgb(0x1d1e23));   // the box around and under it
    CHECK(dark > 72 * 72 / 3 && light > 100);                                                     // dark ground, and a visible mark on it
}
static void pet_test_default_mark(void)
{
    // An engine with neither pet nor mark: the pale cover and the default mark (3 runs), centred.
    CHECK(pod_pet_for("zzz") == NULL && pod_mark("zzz") == NULL);
    ht_scene_t s; ht_scene_clear(&s, 0);
    pod_pet_draw(&s, 10, 20, 270, "zzz", POD_SCENE_REST, 0, 0);
    CHECK(s.count == 1 + POD_DEFAULT_MARK_RUNS && pod_pet_runs("zzz", POD_SCENE_REST) == (unsigned)s.count);
    CHECK(s.runs[0].fg == ht_rgb(0xf0f4f0));
    CHECK(s.runs[1].fg == ht_rgb(0x9aa09a) && s.runs[1].w == 148 && s.runs[1].pro_height == 148);   // 55% of the cover, centred
    CHECK(s.runs[1].x == 10 + (270 - 148) / 2 && s.runs[1].y == 20 + (270 - 148) / 2);
    CHECK(s.runs[3].pro_font->height > ht_pro_24.height);                                          // ">_" in a bigger font to fill it
    CHECK(s.runs[2].fg == ht_rgb(0xf0f4f0) && s.runs[3].fg == ht_rgb(0x6f746f) && !strcmp(s.runs[3].text, ">_"));
    ht_scene_t n; ht_scene_clear(&n, 0);
    pod_pet_draw(&n, 0, 0, 100, NULL, POD_SCENE_REST, 0, 0);
    CHECK(n.count == 1 + POD_DEFAULT_MARK_RUNS);
}
static void pet_test_inside_box(void)
{
    static const int sides[] = {270, 230, 132, 260};
    for (unsigned e = 0; e < 4; e++)
        for (unsigned k = 0; k < 6; k++)
            for (unsigned si = 0; si < 4; si++) {
                const char *eng = e < 3 ? engines[e] : "cursor";
                int side = sides[si], x = 37, y = 91;
                for (uint32_t t = 0; t <= 6000; t += 53) {
                    ht_scene_t s; ht_scene_clear(&s, 0);
                    pod_pet_draw(&s, x, y, side, eng, scenes[k], t, 0);
                    CHECK(s.count == pod_pet_runs(eng, scenes[k]));
                    for (int i = 0; i < s.count; i++) {
                        const ht_run_t *r = &s.runs[i];
                        if (r->w <= 0 || r->pro_height <= 0) continue;   // an empty placeholder
                        if (!(r->x >= x && r->y >= y && r->x + r->w <= x + side && r->y + r->pro_height <= y + side))
                            printf("outside: %s scene %u side %d t %u run %d kind %d (%d,%d %dx%d)\n", eng, k, side,
                                   (unsigned)t, i, r->pro_kind, r->x, r->y, r->w, r->pro_height);
                        CHECK(r->x >= x && r->y >= y && r->x + r->w <= x + side && r->y + r->pro_height <= y + side);
                    }
                }
            }
}
static void pet_test_palette_colour(void)
{
    enum { W = 270, H = 270 };
    static uint16_t buf[W * H];
    ht_scene_t s; ht_scene_clear(&s, 0);
    pod_pet_draw(&s, 0, 0, W, "claude", POD_SCENE_REST, 0, 0);
    ht_rect_t clip = {0, 0, W, H};
    for (int i = 0; i < s.count; i++) {
        if (s.runs[i].pro_kind >= POD_KIND_BASE) pod_draw_raster(&s.runs[i], clip, buf);
        else ht_pro_raster(&s.runs[i], clip, buf);
    }
    uint16_t want = ht_rgb(0xcc7c5e);
    int hit = 0;
    for (int i = 0; i < W * H; i++) {
        int dr = (buf[i] >> 11) - (want >> 11), dg = ((buf[i] >> 5) & 63) - ((want >> 5) & 63),
            db = (buf[i] & 31) - (want & 31);
        if (dr >= -2 && dr <= 2 && dg >= -3 && dg <= 3 && db >= -2 && db <= 2) hit++;
    }
    CHECK(hit > 100);
}
// The logo is blitted 1:1 from the pre-rendered table (no scaling, no byte swap): every opaque logo pixel lands exactly.
static void pet_test_logo_exact(void)
{
    enum { W = 200, H = 200 };
    static uint16_t buf[W * H];
    static const struct { const char *e; int sz; } cases[] = {{"cursor", 28}, {"cursor", 72}, {"kilo", 72}, {"claude", 28}};
    for (unsigned c = 0; c < sizeof cases / sizeof *cases; c++) {
        ht_scene_t s; ht_scene_clear(&s, 0);
        CHECK(pod_logo_draw(&s, 36, 36, cases[c].sz, cases[c].e) && s.count == 1);
        memset(buf, 0, sizeof buf);
        ht_rect_t clip = {0, 0, W, H};
        for (int i = 0; i < s.count; i++) ht_pro_raster(&s.runs[i], clip, buf);
        const pod_logo_t *l = pod_logo_find(cases[c].e, cases[c].sz);
        int sz = cases[c].sz, opaque = 0, match = 0;
        for (int y = 0; y < sz; y++)
            for (int x = 0; x < sz; x++)
                if (l->a[y * sz + x] == 255) { opaque++; if (buf[(36 + y) * W + 36 + x] == l->px[y * sz + x]) match++; }
        CHECK(opaque > 0 && match == opaque);
    }
    ht_scene_t s; ht_scene_clear(&s, 0);
    CHECK(!pod_logo_draw(&s, 0, 0, 99, "cursor") && !pod_logo_draw(&s, 0, 0, 28, "nope") && s.count == 0);
}
// The pet-less cover's centre pixel is the logo's own pixel at that position (a crisp blit, not a blend of neighbours).
static void pet_test_cover_centre_exact(void)
{
    enum { SIDE = 132 };
    static uint16_t px[SIDE * SIDE];
    ht_scene_t s; ht_scene_clear(&s, 0);
    pod_pet_draw(&s, 0, 0, SIDE, "kilo", POD_SCENE_REST, 0, 0);
    for (int i = 0; i < SIDE * SIDE; i++) px[i] = 0;
    for (int i = 0; i < s.count; i++) ht_pro_raster(&s.runs[i], (ht_rect_t){0, 0, SIDE, SIDE}, px);
    const pod_logo_t *l = pod_logo_find("kilo", 72);
    int o = (SIDE - 72) / 2, hit = 0, opaque = 0;
    for (int y = 0; y < 72; y++)
        for (int x = 0; x < 72; x++)
            if (l->a[y * 72 + x] == 255) { opaque++; if (px[(o + y) * SIDE + o + x] == l->px[y * 72 + x]) hit++; }
    CHECK(opaque > 1000 && hit == opaque);
    CHECK(l->a[36 * 72 + 36] != 255 || px[(o + 36) * SIDE + o + 36] == l->px[36 * 72 + 36]);
}
int main(void)
{
    pet_test_runs_constant();
    pet_test_frames_advance();
    pet_test_send_once();
    pet_test_no_pet();
    pet_test_light_mark_on_dark();
    pet_test_default_mark();
    pet_test_inside_box();
    pet_test_palette_colour();
    pet_test_logo_exact();
    pet_test_cover_centre_exact();
    printf("test_pod_pet: %d checks ok\n", checks);
    return 0;
}
