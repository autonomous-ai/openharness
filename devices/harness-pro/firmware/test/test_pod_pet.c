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
                                     POD_SCENE_RELAX, POD_SCENE_LISTEN, POD_SCENE_SEND, POD_SCENE_WORK_ALT};
enum { NSCENES = sizeof scenes / sizeof scenes[0] };

static void pet_test_runs_constant(void)
{
    for (unsigned e = 0; e < 3; e++)
        for (unsigned k = 0; k < NSCENES; k++) {
            if (!pod_pet_has(engines[e], scenes[k])) continue;
            unsigned want = pod_pet_runs(engines[e], scenes[k]);
            CHECK(want >= 1 && want <= 40);
            for (uint32_t t = 0; t <= 5000; t += 37) {
                ht_scene_t s; ht_scene_clear(&s, 0);
                pod_pet_draw(&s, 10, 20, 270, engines[e], scenes[k], t, 0, 8);
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
    pod_pet_draw_on(&a, 0, 0, 270, "claude", POD_SCENE_WORK, 0, 0, 0xffffff, 8);   // the clock-stepped variant
    // Claude's loop holds pose 0 for its first nine steps (only the hop moves), so compare with step 9.
    pod_pet_draw_on(&b, 0, 0, 270, "claude", POD_SCENE_WORK, 9 * p->working_scene->step_ms, 0, 0xffffff, 8);
    CHECK(frame_of(&a) && frame_of(&b) && frame_of(&a) != frame_of(&b));
    ht_scene_t h; ht_scene_clear(&h, 0);   // the next step moves the same pose (step_dy)
    pod_pet_draw_on(&h, 0, 0, 270, "claude", POD_SCENE_WORK, p->working_scene->step_ms, 0, 0xffffff, 8);
    CHECK(memcmp(&a.runs[0], &h.runs[0], sizeof a.runs[0]) != 0 || frame_of(&a) == frame_of(&h));
}
// Fo (the round's fifth pet, imported 2026-10-14) plays its own scenes on the Pro: work, listen and send, not the pet-less cover.
static void pet_test_fo(void)
{
    const ht_pet_t *p = pod_pet_for("fo");
    CHECK(p && p->working_scene && p->listening_scene && p->sending_scene);
    CHECK(pod_pet_has("fo", POD_SCENE_WORK) && pod_pet_has("fo", POD_SCENE_REST) && pod_pet_has("fo", POD_SCENE_LISTEN));
    ht_scene_t s;
    ht_scene_clear(&s, 0);
    pod_pet_draw(&s, 0, 0, 206, "fo", POD_SCENE_WORK, 0, 0, 8);
    CHECK(s.count >= 1 && frame_of(&s));   // a cell frame, not the pale cover box of a pet-less engine
}
static void pet_test_send_once(void)
{
    const ht_pet_t *p = pod_pet_for("claude");
    CHECK(p && p->sending_scene && pod_pet_has("claude", POD_SCENE_SEND));
    const ht_pet_scene_t *sc = p->sending_scene;
    uint32_t start = 5000;
    ht_scene_t a, b, c;
    ht_scene_clear(&a, 0); ht_scene_clear(&b, 0); ht_scene_clear(&c, 0);
    pod_pet_draw(&a, 0, 0, 270, "claude", POD_SCENE_SEND, start + sc->steps * sc->step_ms + 1000, start, 8);
    pod_pet_draw(&b, 0, 0, 270, "claude", POD_SCENE_SEND, start + (sc->steps - 1u) * sc->step_ms, start, 8);
    CHECK(a.count == b.count && frame_of(&a) == frame_of(&b));
    CHECK(!memcmp(&a.runs[0], &b.runs[0], sizeof a.runs[0]));
    pod_pet_draw(&c, 0, 0, 270, "claude", POD_SCENE_SEND, start, start, 8);   // it starts at its first step
    CHECK(frame_of(&c) == sc->frames + sc->loop[0] || frame_of(&c) != frame_of(&a) || sc->steps == 1);
}
static void pet_test_no_pet(void)
{
    CHECK(pod_pet_for("cursor") == NULL);
    CHECK(!pod_pet_has("cursor", POD_SCENE_REST));
    // Cursor's mark is light: it would vanish on the pale box, so the cover is dark and the mark (one scaled run, 55% of
    // the cover) sits centred on it.
    ht_scene_t s; ht_scene_clear(&s, 0);
    pod_pet_draw(&s, 0, 0, 270, "cursor", POD_SCENE_WORK, 123, 0, 8);
    CHECK(s.count == 2 && pod_pet_runs("cursor", POD_SCENE_WORK) == 2);
    CHECK(pod_mark("cursor")->light);
    CHECK(s.runs[0].fg == ht_rgb(0x1d1e23) && s.runs[0].w == 270 && s.runs[0].pro_height == 270 && s.runs[0].radius == 14);
    CHECK(s.runs[1].bitmap.pixels == pod_logo_find("cursor", 72)->px && s.runs[1].w == 72 && s.runs[1].pro_height == 72);
    CHECK(s.runs[1].x == (270 - 72) / 2 && s.runs[1].y == (270 - 72) / 2);
    // A dark mark (Kilo's) keeps the pale box, drawn the same size.
    ht_scene_t k; ht_scene_clear(&k, 0);
    CHECK(!pod_mark("kilo")->light && !pod_pet_for("kilo"));
    pod_pet_draw(&k, 10, 20, 132, "kilo", POD_SCENE_REST, 0, 0, 8);
    CHECK(k.count == 2 && pod_pet_runs("kilo", POD_SCENE_REST) == 2);
    CHECK(k.runs[0].fg == ht_rgb(0xf0f4f0) && k.runs[1].bitmap.pixels == pod_logo_find("kilo", 72)->px && k.runs[1].w == 72 && k.runs[1].x == 10 + 30 && k.runs[1].y == 20 + 30);
}
// The light mark is visible: rasterised, the box under it is dark (0x1d1e23) and the mark's own pixels are far lighter.
static void pet_test_light_mark_on_dark(void)
{
    enum { SIDE = 132 };
    static uint16_t px[SIDE * SIDE];
    ht_scene_t s; ht_scene_clear(&s, ht_rgb(0xffffff));
    pod_pet_draw(&s, 0, 0, SIDE, "cursor", POD_SCENE_REST, 0, 0, 8);
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
    pod_pet_draw(&s, 10, 20, 270, "zzz", POD_SCENE_REST, 0, 0, 8);
    CHECK(s.count == 1 + POD_DEFAULT_MARK_RUNS && pod_pet_runs("zzz", POD_SCENE_REST) == (unsigned)s.count);
    CHECK(s.runs[0].fg == ht_rgb(0xf0f4f0));
    CHECK(s.runs[1].fg == ht_rgb(0x9aa09a) && s.runs[1].w == 148 && s.runs[1].pro_height == 148);   // 55% of the cover, centred
    CHECK(s.runs[1].x == 10 + (270 - 148) / 2 && s.runs[1].y == 20 + (270 - 148) / 2);
    CHECK(s.runs[3].pro_font->height > ht_pro_24.height);                                          // ">_" in a bigger font to fill it
    CHECK(s.runs[2].fg == ht_rgb(0xf0f4f0) && s.runs[3].fg == ht_rgb(0x6f746f) && !strcmp(s.runs[3].text, ">_"));
    ht_scene_t n; ht_scene_clear(&n, 0);
    pod_pet_draw(&n, 0, 0, 100, NULL, POD_SCENE_REST, 0, 0, 8);
    CHECK(n.count == 1 + POD_DEFAULT_MARK_RUNS);
}
static void pet_test_inside_box(void)
{
    static const int sides[] = {270, 230, 132, 260};
    for (unsigned e = 0; e < 4; e++)
        for (unsigned k = 0; k < NSCENES; k++)
            for (unsigned si = 0; si < 4; si++) {
                const char *eng = e < 3 ? engines[e] : "cursor";
                int side = sides[si], x = 37, y = 91;
                for (uint32_t t = 0; t <= 6000; t += 53) {
                    ht_scene_t s; ht_scene_clear(&s, 0);
                    pod_pet_draw(&s, x, y, side, eng, scenes[k], t, 0, 8);
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
static void pet_render_on(uint32_t ground, bool plain, uint16_t *buf)
{
    enum { W = 270, H = 270 };
    ht_scene_t s; ht_scene_clear(&s, 0);
    if (plain) pod_pet_draw_on(&s, 0, 0, W, "claude", POD_SCENE_LISTEN, 700, 0, 0xffffff, 8);   // the white default (pod_pet_draw steps by the beat, whose frame differs here)
    else pod_pet_draw_on(&s, 0, 0, W, "claude", POD_SCENE_LISTEN, 700, 0, ground, 8);
    for (int i = 0; i < W * H; i++) buf[i] = ht_rgb(ground);
    ht_rect_t clip = {0, 0, W, H};
    for (int i = 0; i < s.count; i++) {
        if (s.runs[i].pro_kind >= POD_KIND_BASE) pod_draw_raster(&s.runs[i], clip, buf);
        else ht_pro_raster(&s.runs[i], clip, buf);
    }
}
static int luma(uint16_t p)   // 0..255*1000, from the expanded channels
{
    int r = (p >> 11) * 255 / 31, g = ((p >> 5) & 63) * 255 / 63, b = (p & 31) * 255 / 31;
    return 299 * r + 587 * g + 114 * b;
}
static int brighter(const uint16_t *buf, uint16_t g)   // pixels lighter than the ground
{
    int n = 0;
    for (int i = 0; i < 270 * 270; i++) if (luma(buf[i]) > luma(g)) n++;
    return n;
}
static void pet_test_wave_ground(void)
{
    static uint16_t a[270 * 270], b[270 * 270], c[270 * 270];
    uint16_t g = ht_rgb(0xf6f6f0);
    pet_render_on(0xf6f6f0, false, a);
    CHECK(brighter(a, g) == 0);
    pet_render_on(0xf6f6f0, true, b);   // the white-fading default on the same ground: waves go lighter than it
    CHECK(brighter(b, g) > 0);
    pet_render_on(0xffffff, true, b);
    pet_render_on(0xffffff, false, c);
    CHECK(memcmp(b, c, sizeof b) == 0);
}
static void pet_test_palette_colour(void)
{
    enum { W = 270, H = 270 };
    static uint16_t buf[W * H];
    ht_scene_t s; ht_scene_clear(&s, 0);
    pod_pet_draw(&s, 0, 0, W, "claude", POD_SCENE_REST, 0, 0, 8);
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
    static const struct { const char *e; int sz; } cases[] = {{"cursor", 44}, {"cursor", 72}, {"kilo", 72}, {"claude", 44}};
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
    CHECK(!pod_logo_draw(&s, 0, 0, 99, "cursor") && !pod_logo_draw(&s, 0, 0, 44, "nope") && s.count == 0);
}
// The pet-less cover's centre pixel is the logo's own pixel at that position (a crisp blit, not a blend of neighbours).
static void pet_test_cover_centre_exact(void)
{
    enum { SIDE = 132 };
    static uint16_t px[SIDE * SIDE];
    ht_scene_t s; ht_scene_clear(&s, 0);
    pod_pet_draw(&s, 0, 0, SIDE, "kilo", POD_SCENE_REST, 0, 0, 8);
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
// scripts/prune_pets.py: Pod never plays the alert scenes nor the small WORKING / DONE loops, so the import
// drops them. The expectations below are hard-coded from the data before the first prune.
static void pet_test_pruned(void)
{
    static const unsigned frames[3] = {9, 8, 18};   // the small pet's frames: idle + asking only (Codex: its own HD set, pets_codex.c, not pruned)
    static const unsigned steps[3] = {24, 24, 18};
    for (unsigned e = 0; e < 3; e++) {
        const ht_pet_t *p = pod_pet_for(engines[e]);
        CHECK(p && p->relaxing_scene && !p->alert_scene);
        CHECK(pod_pet_has(engines[e], POD_SCENE_RELAX));
        CHECK(pod_pet_has(engines[e], POD_SCENE_REST) && pod_pet_has(engines[e], POD_SCENE_ASK));
        CHECK(pod_pet_has(engines[e], POD_SCENE_WORK) && pod_pet_has(engines[e], POD_SCENE_LISTEN) &&
              pod_pet_has(engines[e], POD_SCENE_SEND));
        CHECK(ht_pet_steps(p) == steps[e]);
        if (p == &pod_codex_pet) continue;
        // The frames idle and asking play are exactly 0 .. frames - 1: in range, none unused.
        unsigned seen[24] = {0}, max = 0;
        for (unsigned st = 0; st < HT_PET_STATES; st++) {
            if (st != HT_PET_IDLE && st != HT_PET_ASKING) continue;
            for (unsigned i = 0; i < ht_pet_steps(p); i++) {
                unsigned f = p->loops[st][i].frame;
                CHECK(f < frames[e]);
                seen[f] = 1;
                if (f > max) max = f;
            }
        }
        CHECK(max + 1 == frames[e]);
        for (unsigned f = 0; f < frames[e]; f++) CHECK(seen[f] && p->cells[f].cols > 0 && p->cells[f].rows > 0);
        // The loops the player never reads still name a frame that exists.
        for (unsigned st = 0; st < HT_PET_STATES; st++)
            for (unsigned i = 0; i < HT_PET_STEPS; i++) CHECK(p->loops[st][i].frame < frames[e]);
    }
}
// RELAX plays the pet's own relax scene. The round gives all four pets one (Fo too), so the fallback is checked on
// an engine with no pet at all, where every scene is the same cover.
static bool same_runs(const ht_scene_t *x, const ht_scene_t *y)
{
    return x->count == y->count && !memcmp(x->runs, y->runs, x->count * sizeof x->runs[0]);
}
static void pet_test_relax_scene_present(void)
{
    static const char *const four[] = {"claude", "codex", "muse", "fo"};
    for (unsigned e = 0; e < 4; e++) {
        ht_scene_t rest, relax;
        ht_scene_clear(&rest, 0); ht_scene_clear(&relax, 0);
        pod_pet_draw(&rest, 0, 0, 270, four[e], POD_SCENE_REST, 0, 0, 8);
        pod_pet_draw(&relax, 0, 0, 270, four[e], POD_SCENE_RELAX, 0, 0, 8);
        CHECK(pod_pet_has(four[e], POD_SCENE_RELAX) && !same_runs(&rest, &relax));
    }
}
static void pet_test_relax_falls_back(void)
{
    CHECK(!pod_pet_has("cursor", POD_SCENE_RELAX));
    ht_scene_t rest, relax;
    ht_scene_clear(&rest, 0); ht_scene_clear(&relax, 0);
    pod_pet_draw(&rest, 0, 0, 270, "cursor", POD_SCENE_REST, 0, 0, 8);
    pod_pet_draw(&relax, 0, 0, 270, "cursor", POD_SCENE_RELAX, 0, 0, 8);
    CHECK(rest.count > 0 && same_runs(&rest, &relax));
}
// Task 6: pod_pet_next_step_ms is the time until the drawn scene next changes: identical at now + next - 1, different at now + next.
static bool drawn_same(const char *eng, pod_scene_t sc, uint32_t a, uint32_t b, bool beat)
{
    ht_scene_t x, y;
    ht_scene_clear(&x, 0); ht_scene_clear(&y, 0);
    if (beat) { pod_pet_draw(&x, 0, 0, 270, eng, sc, a, 0, 8); pod_pet_draw(&y, 0, 0, 270, eng, sc, b, 0, 8); }
    else { pod_pet_draw_on(&x, 0, 0, 270, eng, sc, a, 0, 0xffffff, 8); pod_pet_draw_on(&y, 0, 0, 270, eng, sc, b, 0, 0xffffff, 8); }
    return x.count == y.count && !memcmp(x.runs, y.runs, x.count * sizeof x.runs[0]);
}
static void pet_test_next_step(void)
{
    static const struct { const char *eng; pod_scene_t sc; } cases[] = {
        {"claude", POD_SCENE_WORK}, {"claude", POD_SCENE_REST}, {"codex", POD_SCENE_WORK},   // (ASK is not here: the room's bubble bobs, see pet_test_ask_bubble)
        {"codex", POD_SCENE_REST}, {"muse", POD_SCENE_REST}, {"muse", POD_SCENE_WORK},
        {"claude", POD_SCENE_RELAX}, {"fo", POD_SCENE_WORK}};
    for (int beat = 0; beat < 2; beat++)   // the clock's and the beat's: each next-step function matches its own draw
        for (unsigned c = 0; c < sizeof cases / sizeof cases[0]; c++)
            for (uint32_t t = 0; t < 4000; t += 13) {
                uint32_t n = beat ? pod_pet_next_beat_ms(cases[c].eng, cases[c].sc, t, 0) : pod_pet_next_step_ms(cases[c].eng, cases[c].sc, t, 0);
                CHECK(n >= 1 && n <= 4000);
                CHECK(drawn_same(cases[c].eng, cases[c].sc, t, t + n - 1, beat));
                CHECK(!drawn_same(cases[c].eng, cases[c].sc, t, t + n, beat));
            }
    // Bars and waves are drawn in code from the clock: every step moves (every 66 ms beat, on it).
    CHECK(pod_pet_next_step_ms("codex", POD_SCENE_LISTEN, 123, 0) == POD_PET_STEP_MS);
    CHECK(pod_pet_next_step_ms("muse", POD_SCENE_LISTEN, 123, 0) == POD_PET_STEP_MS);
    CHECK(pod_pet_next_beat_ms("codex", POD_SCENE_LISTEN, 123, 0) == POD_PH_ANIM_MS - 123 % POD_PH_ANIM_MS);
    CHECK(pod_pet_next_beat_ms("muse", POD_SCENE_LISTEN, 132, 0) == POD_PH_ANIM_MS);
    CHECK(pod_pet_next_step_ms("nope", POD_SCENE_REST, 123, 0) == 1000);   // a still logo: only the second beat
    CHECK(pod_pet_next_beat_ms("nope", POD_SCENE_REST, 123, 0) == 1000);
    CHECK(pod_pet_next_step_ms("claude", POD_SCENE_WORK, 0, 0) > POD_PET_STEP_MS || pod_pet_next_step_ms("muse", POD_SCENE_REST, 0, 0) > POD_PET_STEP_MS);
}
// Pets draws on a 66 ms beat. A step shorter than the beat (Codex's 42..46 ms loop, Claude's 55 ms scenes) is shown for exactly one beat in beat mode, so
// consecutive beats play consecutive steps of the loop, none skipped; sampled by the clock at the same beats (the clock-stepped draw) some steps are skipped.
static const void *main_frame(const ht_scene_t *s) { return s->runs[0].bitmap.asset; }
static void pet_test_beat_steps_not_skipped(void)
{
    const ht_pet_t *codex = pod_pet_for("codex"), *claude = pod_pet_for("claude");
    CHECK(codex && codex->step_ms[HT_PET_IDLE] < POD_PH_ANIM_MS && claude && claude->working_scene && claude->working_scene->step_ms < POD_PH_ANIM_MS);
    const unsigned n = ht_pet_steps(codex), ns = claude->working_scene->steps;
    unsigned clock_off = 0;
    for (unsigned k = 0; k < 3 * n; k++) {
        const uint32_t t = 100000 + k * POD_PH_ANIM_MS;   // consecutive beats
        ht_scene_t sc; ht_scene_clear(&sc, 0);
        pod_pet_draw(&sc, 0, 0, 270, "codex", POD_SCENE_REST, t, 0, 8);
        const unsigned step = (t / POD_PH_ANIM_MS) % n;
        CHECK(main_frame(&sc) == &codex->cells[codex->loops[HT_PET_IDLE][step].frame]);
        if (k) {   // the step advanced by exactly one since the beat before
            ht_scene_t pv; ht_scene_clear(&pv, 0);
            pod_pet_draw(&pv, 0, 0, 270, "codex", POD_SCENE_REST, t - POD_PH_ANIM_MS, 0, 8);
            CHECK(main_frame(&pv) == &codex->cells[codex->loops[HT_PET_IDLE][(step + n - 1) % n].frame]);
        }
        ht_scene_clear(&sc, 0);
        pod_pet_draw_on(&sc, 0, 0, 270, "codex", POD_SCENE_REST, t, 0, 0xffffff, 8);
        clock_off += main_frame(&sc) != &codex->cells[codex->loops[HT_PET_IDLE][step].frame];
    }
    CHECK(clock_off > 0);   // by the clock the same beats land on other steps (46 ms steps against a 66 ms beat): the stutter
    for (unsigned k = 0; k < 3 * ns; k++) {   // Claude's WORK scene (55 ms steps): the frame is the scene's step k of the beat count
        const uint32_t t = 200000 + k * POD_PH_ANIM_MS;
        ht_scene_t sc; ht_scene_clear(&sc, 0);
        pod_pet_draw(&sc, 0, 0, 270, "claude", POD_SCENE_WORK, t, 0, 8);
        const ht_pet_scene_t *e = claude->working_scene;
        CHECK(main_frame(&sc) == &e->frames[e->loop[(t / POD_PH_ANIM_MS) % ns]]);
    }
    // A step of 66 ms or more is left alone: Muse's 217 ms loop is the same in both modes.
    for (uint32_t t = 0; t < 3000; t += 17) CHECK(drawn_same("muse", POD_SCENE_REST, t, t + 1, true) == drawn_same("muse", POD_SCENE_REST, t, t + 1, false));
    ht_scene_t a, b; ht_scene_clear(&a, 0); ht_scene_clear(&b, 0);
    pod_pet_draw(&a, 0, 0, 270, "muse", POD_SCENE_REST, 5555, 0, 8); pod_pet_draw_on(&b, 0, 0, 270, "muse", POD_SCENE_REST, 5555, 0, 0xffffff, 8);
    CHECK(a.count == b.count && !memcmp(a.runs, b.runs, a.count * sizeof a.runs[0]));
}
// The union of what a scene draws over a few seconds: its extent on screen.
static void union_of(const char *eng, pod_scene_t scene, int x, int y, int side, unsigned zoom, int *w, int *h)
{
    int x0 = 99999, y0 = 99999, x1 = -99999, y1 = -99999;
    for (uint32_t t = 0; t < 4000; t += 41) {
        ht_scene_t s; ht_scene_clear(&s, 0);
        pod_pet_draw(&s, x, y, side, eng, scene, t, 0, zoom);
        for (int i = 0; i < s.count; i++) {
            const ht_run_t *r = &s.runs[i];
            if (r->w <= 0 || r->pro_height <= 0) continue;
            if (r->x < x0) x0 = r->x;
            if (r->y < y0) y0 = r->y;
            if (r->x + r->w > x1) x1 = r->x + r->w;
            if (r->y + r->pro_height > y1) y1 = r->y + r->pro_height;
        }
    }
    *w = x1 - x0;
    *h = y1 - y0;
}
// At zoom 16 the 1x box (x, y, side) is drawn as the box (x - side/2, y - side/2, 2 * side): same centre, twice the
// size, the same runs, and the art itself twice as large (what pod_pet_ink_h(.., 16) promises).
static void pet_test_draw_2x(void)
{
    enum { X = 300, Y = 200, SIDE = 140 };
    const int bx = X - SIDE / 2, by = Y - SIDE / 2, bs = 2 * SIDE;
    static const pod_scene_t two[] = {POD_SCENE_WORK, POD_SCENE_RELAX, POD_SCENE_LISTEN};
    for (unsigned e = 0; e < 3; e++) {
        ht_scene_t one, twice; ht_scene_clear(&one, 0); ht_scene_clear(&twice, 0);
        pod_pet_draw(&one, X, Y, SIDE, engines[e], POD_SCENE_WORK, 200, 0, 8);
        pod_pet_draw(&twice, X, Y, SIDE, engines[e], POD_SCENE_WORK, 200, 0, 16);
        CHECK(one.count > 0 && twice.count == one.count);
        for (int i = 0; i < twice.count; i++) {
            const ht_run_t *r = &twice.runs[i];
            if (r->w <= 0 || r->pro_height <= 0) continue;
            CHECK(r->x >= bx && r->y >= by && r->x + r->w <= bx + bs && r->y + r->pro_height <= by + bs);
        }
        for (unsigned k = 0; k < 3; k++) {   // the art is 2x: its extent doubles, and is the height the room places it by
            if (!pod_pet_has(engines[e], two[k])) continue;
            int w1, h1, w2, h2;
            union_of(engines[e], two[k], 300, 300, 270, 8, &w1, &h1);
            union_of(engines[e], two[k], 300, 300, 270, 16, &w2, &h2);
            int ink = pod_pet_ink_h(engines[e], two[k], 270, 16);
            printf("2x %s scene %u: 1x %dx%d, 2x %dx%d, ink_h %d\n", engines[e], (unsigned)two[k], w1, h1, w2, h2, ink);
            if (e == 1) CHECK(w2 >= w1 && h2 >= h1);   // Codex is HD: stored at the size it is shown, so the 2x square holds it at 8, not doubled
            else CHECK(w2 >= 2 * w1 - 6 && w2 <= 2 * w1 + 6 && h2 >= 2 * h1 - 6 && h2 <= 2 * h1 + 6);
            CHECK(ink >= h2 - 4 && ink <= h2 + 4);
        }
    }
    ht_scene_t r1, r2; ht_scene_clear(&r1, 0); ht_scene_clear(&r2, 0);
    pod_pet_draw(&r1, X, Y, SIDE, "claude", POD_SCENE_REST, 0, 0, 8);
    pod_pet_draw(&r2, X, Y, SIDE, "claude", POD_SCENE_REST, 0, 0, 16);
    CHECK(r2.count == r1.count);
    for (int i = 0; i < r2.count; i++)
        CHECK(r2.runs[i].x >= bx && r2.runs[i].x + r2.runs[i].w <= bx + bs);
    {   // the resting pet: twice as tall too
        int w1, h1, w2, h2;
        union_of("claude", POD_SCENE_REST, 300, 300, 270, 8, &w1, &h1);
        union_of("claude", POD_SCENE_REST, 300, 300, 270, 16, &w2, &h2);
        CHECK(h2 >= 2 * h1 - 6 && h2 <= 2 * h1 + 6);
    }
}
// The height the room places a pet by (pod_pet_ink_h, level 0 for most scenes) is the height the draw uses: LISTEN draws at its top
// level, so the query must ask for that level's extent too. Run through every pet and scene at both zooms to fill the extent cache.
static void pet_test_extent_cache(void)
{
    static const char *const all[] = {"claude", "codex", "muse", "fo"};
    for (int pass = 0; pass < 2; pass++) {
        unsigned before = pod_pet_extent_scans();
        for (unsigned e = 0; e < 4; e++)
            for (unsigned k = 0; k < NSCENES; k++)
                for (unsigned zi = 0; zi < 2; zi++) {
                    ht_scene_t s; ht_scene_clear(&s, 0);
                    pod_pet_draw(&s, 0, 0, 260, all[e], scenes[k], 100, 0, zi ? 16u : 8u);
                    (void)pod_pet_ink_h(all[e], scenes[k], 260, zi ? 16u : 8u);
                }
        if (pass == 1) CHECK(pod_pet_extent_scans() == before);   // every scene and level measured once: no re-scan, whatever the order of asking
    }
}
static void pet_test_ink_h_matches_draw(void)
{
    static const char *const all[] = {"claude", "codex", "muse", "fo"};
    for (unsigned e = 0; e < 4; e++)
        for (unsigned k = 0; k < NSCENES; k++)
            for (unsigned zi = 0; zi < 2; zi++) {
                unsigned zoom = zi ? 16u : 8u;
                if (!pod_pet_has(all[e], scenes[k])) continue;
                int h = pod_pet_ink_h(all[e], scenes[k], 260, zoom), w2, h2;
                union_of(all[e], scenes[k], 300, 300, 260, zoom, &w2, &h2);
                if (scenes[k] == POD_SCENE_REST || scenes[k] == POD_SCENE_ASK) continue;   // the small pet: its ink is the first frame's, not a union
                if (scenes[k] != POD_SCENE_SEND) CHECK(h >= h2 - 4 && h <= h2 + 4);   // (SEND plays once from its start: not a loop's union)
            }
}
// THE BUILDER (owner, 2026-10-16): WORK_ALT is Claude's second working scene, still pixel art (pod_cell, its frames as
// stored); a pet without one plays its WORK. Its widest props frame is wider than a byte (pod_types.h HT_CELL_COLS_MAX).
static void pet_test_work_alt(void)
{
    const ht_pet_t *p = pod_pet_for("claude");
    CHECK(p && p->working_alt && p->working_alt != p->working_scene && p->working_alt->steps == 32);
    for (unsigned e = 1; e < 3; e++) CHECK(!pod_pet_for(engines[e])->working_alt && pod_pet_has(engines[e], POD_SCENE_WORK_ALT));
    const ht_pet_scene_t *b = p->working_alt;
    bool wide = false, bodies = false;
    for (unsigned i = 0; i < b->steps; i++) wide |= b->overlay->frames[b->overlay->loop[i]].cols > 255;
    CHECK(wide);
    CHECK(pod_pet_runs("claude", POD_SCENE_WORK_ALT) == pod_pet_runs("claude", POD_SCENE_WORK));
    for (unsigned i = 0; i < b->steps; i++) {
        ht_scene_t s; ht_scene_clear(&s, 0);
        pod_pet_draw(&s, 0, 0, 270, "claude", POD_SCENE_WORK_ALT, i * POD_PH_ANIM_MS, 0, 16);
        CHECK(s.count == 2 && s.runs[0].text[1] == 0 && s.runs[1].text[1] == 0);   // pod_cell, as stored
        bodies |= frame_of(&s) == &b->frames[b->loop[i]];
        CHECK(frame_of(&s) == &b->frames[0] || frame_of(&s) == &b->frames[1]);
        CHECK(s.runs[1].bitmap.asset == &b->overlay->frames[b->overlay->loop[i]]);
    }
    CHECK(bodies);
    // codex has none: WORK_ALT draws exactly its WORK
    ht_scene_t w, a; ht_scene_clear(&w, 0); ht_scene_clear(&a, 0);
    pod_pet_draw(&w, 0, 0, 270, "codex", POD_SCENE_WORK, 500, 0, 8);
    pod_pet_draw(&a, 0, 0, 270, "codex", POD_SCENE_WORK_ALT, 500, 0, 8);
    CHECK(w.count == a.count && !memcmp(w.runs, a.runs, sizeof w.runs[0] * (size_t)w.count));
    CHECK(pod_pet_next_beat_ms("claude", POD_SCENE_WORK_ALT, 0, 0) >= 1 && pod_pet_ink_h("claude", POD_SCENE_WORK_ALT, 260, 8) > 0);
    CHECK(pod_pet_ink_h("claude", POD_SCENE_WORK_ALT, 260, 8) != pod_pet_ink_h("claude", POD_SCENE_WORK, 260, 8));
}
// Codex is HD (pets_codex.c): found before any ht_pets row of the same name (an import_pets.sh re-run restores one), and in the room and on the
// voice screen (side 260, zoom8 16 as ph_room_pet draws, 13 as the voice screen once did) its main frame is drawn at exactly 8, never interpolated.
static void pet_test_codex_is_hd(void)
{
    CHECK(pod_pet_for("codex") == &pod_codex_pet);
    for (unsigned i = 0; i < ht_pet_count; i++) if (!strcmp(ht_pets[i].engine, "codex")) CHECK(pod_pet_for("codex") != &ht_pets[i]);
}
static void pet_test_codex_room_z8(void)
{
    static const pod_scene_t sc[] = {POD_SCENE_WORK, POD_SCENE_LISTEN, POD_SCENE_SEND, POD_SCENE_RELAX, POD_SCENE_REST, POD_SCENE_ASK};
    static const unsigned zoom[] = {16, 13};
    for (unsigned k = 0; k < 6; k++)
        for (unsigned zi = 0; zi < 2; zi++)
            for (uint32_t t = 0; t < 3000; t += 66) {
                ht_scene_t s; ht_scene_clear(&s, 0);
                pod_pet_draw(&s, 380 - 130, 400 - 130, 260, "codex", sc[k], t, 0, zoom[zi]);
                const ht_cell_frame_t *f = s.runs[0].bitmap.asset;
                CHECK(f && s.runs[0].pro_kind == POD_CELL && s.runs[0].w == f->cols * f->cell && s.runs[0].radius == 8);
                for (int i = 0; i < s.count - (sc[k] == POD_SCENE_ASK); i++)   // (ASK's last run is the "?" bubble, popping in at its own zoom)
                    if (s.runs[i].pro_kind == POD_CELL) CHECK(s.runs[i].radius <= 8 && s.runs[i].text[1] == 0);
            }
}
// An HD scene is taller than 255 rows (the extent and the ink height must not wrap a byte): at side 260 and zoom8 16 the square is 520, the scene
// fits at 1x, so its ink height is the tallest of its frames' rows.
static void pet_test_codex_ink_h_tall(void)
{
    const ht_pet_scene_t *w = pod_codex_pet.working_scene;
    int tall = 0;
    for (unsigned i = 0; i < w->steps; i++) { int r = w->frames[w->loop[i]].rows; if (r > tall) tall = r; }
    CHECK(tall > 255);
    CHECK(pod_pet_ink_h("codex", POD_SCENE_WORK, 260, 16) == tall);
}
// ASK (the "asking" look): Claude and Codex play their own ask scene, Muse (and Fo) the small pet; in the room (zoom8 16) a "?" bubble is drawn over it.
static int ask_run(const ht_scene_t *s) { return s->count - 1; }   // the bubble is the last run
static void ask_draw(ht_scene_t *s, const char *engine, uint32_t t, unsigned zoom8)
{
    ht_scene_clear(s, 0);
    pod_pet_draw(s, 380 - 130, 400 - 130, 260, engine, POD_SCENE_ASK, t, 0, zoom8);
}
static bool ask_has_bubble(const ht_scene_t *s) { return s->count > 0 && s->runs[ask_run(s)].bitmap.asset == &pod_ask_bubble; }
static uint32_t ask_loop_ms(const char *engine)
{
    if (!strcmp(engine, "claude")) return pod_claude_ask.steps * pod_claude_ask.step_ms;
    if (!strcmp(engine, "codex")) return pod_codex_ask.steps * pod_codex_ask.step_ms;
    const ht_pet_t *p = pod_pet_for(engine);
    return ht_pet_steps(p) * p->step_ms[HT_PET_ASKING];
}
static void pet_test_ask_bodies(void)
{
    ht_scene_t s;
    CHECK(pod_codex_ask.frames == pod_codex_pet.sending_scene->frames && pod_codex_ask.steps == 10 && pod_codex_ask.step_ms == 140 && !pod_codex_ask.overlay);
    CHECK(pod_claude_ask.steps == 12 && pod_claude_ask.step_ms == 120 && !pod_claude_ask.overlay);
    for (unsigned i = 0; i < 12; i++) CHECK(pod_claude_ask.frames[pod_claude_ask.loop[i]].cols == 120 && pod_claude_ask.frames[pod_claude_ask.loop[i]].cell == 1);
    for (uint32_t t = 0; t < 1500; t += 41) {
        ask_draw(&s, "claude", t, 16);   // Claude: its own frame at the room's exact 2x
        CHECK(s.count == 2 && s.runs[0].bitmap.asset == &pod_claude_ask.frames[pod_claude_ask.loop[t / 120 % 12]] &&
              s.runs[0].radius == 16 && s.runs[0].text[1] == 0);
        ask_draw(&s, "codex", t, 16);   // Codex: pxc_send's waving frames, drawn at 1x
        CHECK(s.count == 2 && s.runs[0].bitmap.asset == &pod_codex_ask.frames[pod_codex_ask.loop[t / 140 % 10]] && s.runs[0].radius == 8);
    }
    const ht_pet_t *m = pod_pet_for("muse");   // Muse: today's small pet, still
    ask_draw(&s, "muse", 0, 16);
    CHECK(s.count == 2 && (const ht_cell_frame_t *)s.runs[0].bitmap.asset >= m->cells && (const ht_cell_frame_t *)s.runs[0].bitmap.asset < m->cells + 18);
    CHECK(pod_pet_ink_h("claude", POD_SCENE_ASK, 260, 16) == 102 * 2 && pod_pet_ink_h("codex", POD_SCENE_ASK, 260, 16) == pod_codex_ask.h);
}
static void pet_test_ask_bubble(void)
{
    for (unsigned e = 0; e < 3; e++) {
        ht_scene_t s, a, b, c;
        const uint32_t L = ask_loop_ms(engines[e]);
        for (uint32_t t = 0; t < 2 * L; t += 33) {
            ask_draw(&s, engines[e], t, 16);
            CHECK(ask_has_bubble(&s));
            const ht_run_t *pet = &s.runs[0], *q = &s.runs[ask_run(&s)];
            CHECK(q->y >= pet->y);                                                      // never above the pet's top
            CHECK(q->x >= 120 && q->x + q->w <= 120 + 520 && q->y >= 120 && q->y + q->pro_height <= 120 + 520);   // inside the pet's (2x) square
            CHECK(s.count == (int)pod_pet_runs(engines[e], POD_SCENE_ASK) + 1);
        }
        ask_draw(&s, engines[e], 0, 8); CHECK(!ask_has_bubble(&s) && s.count == (int)pod_pet_runs(engines[e], POD_SCENE_ASK));
        ht_scene_clear(&s, 0); pod_pet_draw(&s, 250, 270, 260, engines[e], POD_SCENE_REST, 0, 0, 16); CHECK(!ask_has_bubble(&s));   // the room's other scenes: none
        ask_draw(&a, engines[e], 0, 16); ask_draw(&b, engines[e], 400, 16); ask_draw(&c, engines[e], L, 16);
        CHECK(a.runs[ask_run(&a)].w < b.runs[ask_run(&b)].w && c.runs[ask_run(&c)].w == a.runs[ask_run(&a)].w);   // pops in once a loop
        CHECK(b.runs[ask_run(&b)].w == 64 && b.runs[ask_run(&b)].pro_height == 74);                                // then full, at its own 1:1 size
        int lo = 9999, hi = -9999;
        for (uint32_t t = 300; t < L; t += 33) { ask_draw(&s, engines[e], t, 16); int y = s.runs[ask_run(&s)].y - s.runs[0].y; if (y < lo) lo = y; if (y > hi) hi = y; }
        CHECK(hi - lo >= 6 && hi - lo <= 9);   // bobs 4 px either way over the loop
        for (uint32_t t = 0; t < 400; t += 33) { CHECK(pod_pet_next_beat_ms(engines[e], POD_SCENE_ASK, t, 0) <= POD_PH_ANIM_MS); CHECK(pod_pet_next_step_ms(engines[e], POD_SCENE_ASK, t, 0) >= 1); }
    }
    ht_scene_t s; ask_draw(&s, "claude", 0, 16);   // beside the pet: left edge = its right + 6, top = its top + 6 (+ bob 0 at the loop's start)
    CHECK(s.runs[1].x == s.runs[0].x + s.runs[0].w + 6 && s.runs[1].y == s.runs[0].y + 6);
}
int main(void)
{
    pet_test_ask_bodies();
    pet_test_ask_bubble();
    pet_test_codex_is_hd();
    pet_test_codex_ink_h_tall();
    pet_test_codex_room_z8();
    pet_test_pruned();
    pet_test_work_alt();
    pet_test_runs_constant();
    pet_test_draw_2x();
    pet_test_ink_h_matches_draw();
    pet_test_extent_cache();
    pet_test_frames_advance();
    pet_test_send_once();
    pet_test_fo();
    pet_test_relax_scene_present();
    pet_test_relax_falls_back();
    pet_test_next_step();
    pet_test_beat_steps_not_skipped();
    pet_test_no_pet();
    pet_test_light_mark_on_dark();
    pet_test_default_mark();
    pet_test_inside_box();
    pet_test_palette_colour();
    pet_test_wave_ground();
    pet_test_logo_exact();
    pet_test_cover_centre_exact();
    printf("test_pod_pet: %d checks ok\n", checks);
    return 0;
}
