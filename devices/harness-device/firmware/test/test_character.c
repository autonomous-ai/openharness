// The public character contract: reaction state, every mood/size, swapping, and
// DMA damage replay. Uses the same immutable assets and renderer as the board.
#include "../main/ui/habitat/character.h"
#include "../main/ui/habitat/pets.h"
#include "../main/ui/habitat/focus.h"
#include "../main/ui/habitat/focus_faces.h"
#include "../main/pet_store.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint16_t full[HT_WIDTH * HT_HEIGHT], partial[HT_WIDTH * HT_HEIGHT];
static uint16_t scratch[HT_WIDTH * HT_HEIGHT];
static unsigned redraws;

static void redraw(const ht_scene_t *before, const ht_scene_t *after)
{
    ht_damage_t d; ht_damage(before, after, &d);
    for (unsigned i = 0; i < d.count; i++) {
        ht_rect_t r = d.rect[i];
        assert(r.x >= 0 && r.y >= 0 && r.x + r.w <= HT_WIDTH && r.y + r.h <= HT_HEIGHT);
        assert(!((r.x | r.y | r.w | r.h) & 1));
        ht_raster(after, r, scratch);
        for (int y = 0; y < r.h; y++)
            memcpy(partial + (r.y + y) * HT_WIDTH + r.x, scratch + y * r.w, r.w * 2);
    }
    ht_raster(after, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, full);
    assert(!memcmp(full, partial, sizeof full));
    redraws++;
}

static void tick(ht_character_t *c, uint32_t now, ht_character_mood_t mood,
                 bool quiet, bool visible, bool down, unsigned level)
{
    ht_character_tick(c, now, mood, quiet, visible, down, 330, level, now / 100);
    assert(c->motion.next_ms >= 1 && c->motion.next_ms <= 1000);
    assert(c->motion.frame < c->motion.animation->frames);
}

static void clocks(void)
{
    for (int id = 0; id < HT_CHARACTER_ILLUSTRATED_TIM; id++) {
        ht_character_t c = {0}; assert(ht_character_select(&c, id));
        tick(&c, UINT32_MAX - 49, HT_CHARACTER_WORKING, false, true, false, 0);
        tick(&c, 50, HT_CHARACTER_WORKING, false, true, false, 0);
        assert(c.motion.phase == 100);
        tick(&c, 80, HT_CHARACTER_WORKING, false, true, true, 0);
        uint16_t held = c.motion.phase;
        tick(&c, 3000, HT_CHARACTER_WORKING, false, true, true, 0);
        assert(c.motion.phase == held && c.motion.reaction.pose.pressed && c.motion.reaction.pose.look == 2);
        tick(&c, 4000, HT_CHARACTER_WORKING, false, true, false, 0);
        assert(c.motion.phase == held); // No backlog on release.
        tick(&c, 4100, HT_CHARACTER_LISTENING, false, true, false, 99);
        assert(c.motion.reaction.pose.level == 4);
        held = c.motion.phase;
        for (uint32_t t = 4101; t < 4225; t++) {
            tick(&c, t, HT_CHARACTER_LISTENING, false, true, false, 0);
            assert(c.motion.reaction.pose.level == 4 && c.motion.running && c.motion.rate == 2);
        }
        tick(&c, 4225, HT_CHARACTER_LISTENING, false, true, false, 0);
        assert(!c.motion.reaction.pose.level &&
               c.motion.phase == (held + 62) % c.motion.animation->duration);
        // A silent microphone must not freeze the body; every authored frame
        // remains reachable at half speed during a complete listening cycle.
        bool listening_seen[256] = {0};
        for (uint32_t t=4226;t<=4225+c.motion.animation->duration*2u;t++) {
            tick(&c,t,HT_CHARACTER_LISTENING,false,true,false,0);
            assert(!c.motion.reaction.pose.level);
            listening_seen[c.motion.frame]=true;
        }
        for (unsigned f=0;f<c.motion.animation->frames;f++) assert(listening_seen[f]);
        for (int state = 0; state < 4; state++) {
            ht_character_mood_t mood = state == 2 ? HT_CHARACTER_ASLEEP :
                state == 3 ? HT_CHARACTER_OFFLINE : HT_CHARACTER_WORKING;
            tick(&c, 5000, mood, state == 0, state != 1, false, 0);
            held = c.motion.phase;
            for (uint32_t t = 5001; t < 5100; t++) {
                tick(&c, t, mood, state == 0, state != 1, false, 0);
                assert(c.motion.phase == held && c.motion.next_ms == 1000);
            }
        }
        // A full idle cycle runs at half speed for either character.
        memset(&c.motion, 0, sizeof c.motion);
        tick(&c, 0, HT_CHARACTER_IDLE, false, true, false, 0);
        unsigned duration = c.motion.animation->duration;
        bool seen[256] = {0};
        for (unsigned t = 0; t <= duration * 2; t++) {
            tick(&c, t, HT_CHARACTER_IDLE, false, true, false, 0);
            seen[c.motion.frame] = true;
        }
        assert(!c.motion.phase && !c.motion.frame);
        for (unsigned i = 0; i < c.motion.animation->frames; i++) assert(seen[i]);
        ht_character_motion_t before = c.motion;
        assert(ht_character_select(&c, id));
        assert(!memcmp(&before, &c.motion, sizeof before));
        assert(!ht_character_select(&c, HT_CHARACTER_COUNT) && c.id == (ht_character_id_t)id);
        assert(!ht_character_select(&c, (ht_character_id_t)-1));
        assert(ht_character_select(&c, (id + 1) % HT_CHARACTER_ILLUSTRATED_TIM));
        assert(!c.motion.initialized && !c.motion.reaction.initialized);
        tick(&c, 10000, (ht_character_mood_t)255, false, true, false, 0);
        assert(c.motion.reaction.mood == HT_CHARACTER_IDLE);
    }
}

static void portraits(void)
{
    ht_scene_t a, b;
    ht_character_t c = {0};
    ht_character_face_t f = {.recipient = "Parser helper", .status = "Working", .hint = "tap to talk",
        .detail = "A carried paragraph", .foreground = 0xffff, .ink = 0xafe0, .dim = 0x7777, .roomy_reading = true};
    ht_scene_clear(&a, ht_rgb(0x181818)); redraw(NULL, &a);
    for (int id = 0; id < HT_CHARACTER_ILLUSTRATED_TIM; id++) {
        ht_character_select(&c, id);
        for (int size = HT_CHARACTER_FULL; size <= HT_CHARACTER_QUICK; size++) {
            for (int mood = HT_CHARACTER_IDLE; mood < HT_CHARACTER_MOODS; mood++) {
                f.mood = mood;
                for (unsigned frame = 0; frame < 8; frame++) {
                    c.motion.frame = frame;
                    c.delivery.lift = (frame >> 1) & 1;
                    f.pose = (ht_character_pose_t){.blink = frame == 0, .look = (int)(frame % 5) - 2,
                        .pressed = frame == 3, .level = frame % 5};
                    ht_scene_clear(&b, a.background);
                    ht_character_portrait(&b, &c, &f, ht_rgb(0xc8a9f0), size, 98);
                    assert(b.count && b.count <= HT_RUNS - 9);
                    redraw(&a, &b); a = b;
                    uint16_t bg = (b.background << 8) | (b.background >> 8);
                    unsigned pixels = 0;
                    for (int y = 0; y < HT_HEIGHT; y++) for (int x = 0; x < HT_WIDTH; x++) {
                        if (full[y * HT_WIDTH + x] == bg) continue;
                        assert((x - 233) * (x - 233) + (y - 233) * (y - 233) < 230 * 230);
                        pixels++;
                    }
                    assert(pixels > 100);
                    f.focus = size == HT_CHARACTER_COMPACT;
                    f.straight_title = frame & 1; f.unread = frame & 2;
                    const char *recap = size == HT_CHARACTER_BRIEF ? "Fixed the parser. All tests pass." :
                        size == HT_CHARACTER_READING ? "Fixed the parser. All tests pass. Voice input now sends to the selected agent, including after switching characters or reading another pane." : NULL;
                    ht_scene_clear(&b, a.background);
                    ht_character_face(&b, &c, &f, ht_rgb(0xc8a9f0), recap);
                    assert(b.count <= HT_RUNS - 1); // Reading fits; voice puts the letter away for Discard.
                    redraw(&a, &b); a = b;
                }
            }
        }
    }
    // Changing only a cell's colour must repaint it. Compare against separate
    // uniform text runs so this also checks the palette and clipped raster path.
    const uint16_t red_blue[] = {0xf800, 0x001f}, green_blue[] = {0x07e0, 0x001f};
    ht_scene_clear(&a, 0);
    int w = ht_mono_20.width;
    assert(ht_ascii_text(&a, 200, 210, w * 2, &ht_mono_20, 0xffff, 0, "##", 2));
    a.runs[0].colors = red_blue; redraw(NULL, &a);
    b = a; b.runs[0].colors = green_blue; redraw(&a, &b);
    ht_scene_t reference; ht_scene_clear(&reference, 0);
    assert(ht_text(&reference, 200, 210, w, &ht_mono_20, 0x07e0, 0, "#"));
    assert(ht_text(&reference, 200 + w, 210, w, &ht_mono_20, 0x001f, 0, "#"));
    ht_raster(&reference, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, scratch);
    assert(!memcmp(full, scratch, sizeof full));
}

static void delivery_and_caption(void)
{
    for (int id = 0; id < HT_CHARACTER_ILLUSTRATED_TIM; id++) {
        ht_character_t c = {0}; ht_character_select(&c, id);
        c.motion.next_ms = 1000;
        assert(!ht_character_delivery_tick(&c, 100, true, 0, true)); // Restored mail only holds.
        assert(!c.delivery.moving);
        ht_character_delivery_tick(&c, 200, true, 1, true);
        assert(c.delivery.moving && c.motion.next_ms == 160);
        ht_character_delivery_tick(&c, 360, true, 1, true); assert(c.delivery.lift == 1);
        ht_character_delivery_tick(&c, 400, true, 2, true); // Burst coalesces.
        ht_character_delivery_tick(&c, 1480, true, 2, true); assert(!c.delivery.moving && !c.delivery.lift);
        ht_character_delivery_tick(&c, 1600, true, 3, false);
        ht_character_delivery_tick(&c, 1760, true, 3, true); assert(!c.delivery.moving); // No replay on wake.
        ht_character_delivery_tick(&c, UINT32_MAX - 79, true, UINT32_MAX, true);
        ht_character_delivery_tick(&c, 80, true, UINT32_MAX, true); assert(c.delivery.lift == 1);
        ht_character_delivery_tick(&c, 81, false, 0, true); assert(!c.delivery.moving && !c.delivery.lift);
    }
    ht_character_caption_t c = {0};
    ht_character_caption_tick(&c, 100, "a", false); assert(!c.activity && c.opacity == 255);
    ht_character_caption_tick(&c, 200, "a", true); assert(!c.activity && c.opacity == 255);
    ht_character_caption_tick(&c, 3080, "a", true); assert(!c.activity && c.opacity < 255);
    ht_character_caption_tick(&c, 3200, "a", true); assert(c.activity && !c.opacity);
    ht_character_caption_tick(&c, 3500, "a", true); assert(c.activity && c.opacity == 255);
    ht_character_caption_tick(&c, 6500, "a", true); assert(!c.activity && c.opacity == 255);
    ht_character_caption_tick(&c, 9600, "a", true); assert(c.activity);
    ht_character_caption_tick(&c, 9601, "a", false); assert(!c.activity && c.opacity == 255);
    ht_character_caption_tick(&c, UINT32_MAX - 1499, "a", true);
    ht_character_caption_tick(&c, 1700, "a", true); assert(c.activity);
    ht_character_caption_tick(&c, 1701, "b", true); assert(!c.activity && c.opacity == 255);
    assert(ht_character_caption_ink(0xffff, 0x18c3, 0) == 0x18c3);
    assert(ht_character_caption_ink(0xffff, 0x18c3, 255) == 0xffff);
}

/*
 * ht_character_layout()'s recap contract: four roomy rows, ninety characters, an ellipsis past that.
 *
 * Only the skins that GO THROUGH that layout are measured here. Focus owns its whole face and has
 * its own grid — three recap rows, because the fourth slot is its status line — so measuring it
 * against these numbers would be testing one layout with another layout's ruler. focus_face() below
 * is its ruler.
 */
static void recap_budget(void)
{
    for (int id = 0; id < HT_CHARACTER_ILLUSTRATED_TIM; id++) for (int unicode = 0; unicode < 2; unicode++)
        for (int length = 89; length <= 91; length++) {
            if (id == HT_CHARACTER_FOCUS) continue;
            ht_character_t c = {0}; ht_character_select(&c, id);
            ht_character_face_t f = {.roomy_reading=true, .single_label=true, .foreground=0xffff};
            char input[400] = "", visible[400] = "";
            for (int i = 0; i < length; i++) strcat(input, unicode ? "\xc3\xa9" : "x");
            ht_scene_t scene; ht_scene_clear(&scene, 0);
            ht_character_face(&scene, &c, &f, 0xffff, input);
            int rows = 0, chars = 0;
            for (int i = 0; i < scene.count; i++) if (scene.runs[i].font == &ht_mono_28) {
                if (scene.runs[i].text[0]) rows++;
                strcat(visible, scene.runs[i].text);
            }
            for (const char *p = visible; *p; chars++) {
                uint32_t cp = ht_utf8_next(&p);
                assert(cp == (unicode ? 0xe9u : 'x') || cp == '.');
            }
            assert(rows <= 4 && chars <= 90);
            if (length <= 90) assert(!strcmp(input, visible));
            else assert(!strcmp(visible + strlen(visible) - 3, "..."));
            ht_raster(&scene, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, full);
            for (int y=0;y<HT_HEIGHT;y++) for (int x=0;x<HT_WIDTH;x++)
                if (full[y*HT_WIDTH+x])
                    assert((x-233)*(x-233)+(y-233)*(y-233)<230*230);
        }
}

/*
 * THE FOCUS FACE.
 *
 * Two properties, and both are invisible until they are wrong on glass:
 *
 *  1. The run count and their order never change with the state. ht_damage() diffs run index against
 *     run index and repaints the whole 466x466 the moment either moves, so a face that drops a row
 *     when it has nothing to say costs a full frame every time it changes its mind. An earlier draft
 *     did exactly that — and worse, ht_text() refuses a zero-width run, so the empty row silently
 *     overwrote the run BEFORE it and the engine mark disappeared.
 *  2. Nothing lands outside the bezel. Every width on that face is the chord at its row's BOTTOM
 *     edge, which is the measurement that is easy to take from the wrong edge.
 */
static void squeeze(char *text)
{
    char *out = text;
    for (const char *p = text; *p; p++) if (*p != ' ') *out++ = *p;
    *out = 0;
}
// The pet registered for an engine, or NULL.
static const ht_pet_t *pet_of(const char *engine)
{
    for (unsigned i = 0; i < ht_pet_count; i++) if (!strcmp(ht_pets[i].engine, engine)) return &ht_pets[i];
    return NULL;
}
// The index of the pet's frame this run's sprite draws (every frame is in some loop), or -1: by pixels for an
// RGB565 + alpha8 pet, by cells for one that stores cell frames (Muse). Exactly one of frames / cells is set.
static int pet_frame(const ht_pet_t *pet, const ht_sprite_t *sp)
{
    assert(!pet->frames != !pet->cells);
    for (int s = 0; s < HT_PET_STATES; s++)
        for (int k = 0; k < (int)ht_pet_steps(pet); k++) {
            int fr = pet->loops[s][k].frame;
            if (pet->cells ? sp->cells == pet->cells[fr].cells : sp->pixels == pet->frames[fr].px) return fr;
        }
    return -1;
}
// Whether row `row` of the pet's frame `fr`, as drawn at 1x, has any ink (alpha, or a non-zero palette index: the
// cell frames are drawn at 2x, so the 1x row is two of theirs).
static bool pet_row_inked(const ht_pet_t *pet, int fr, int row)
{
    int w = pet->w;
    if (pet->cells) {
        const ht_cell_frame_t *f = &pet->cells[fr];
        for (int y = 2 * row; y < 2 * row + 2; y++)
            for (int x = 0; x < f->cols; x++) if (ht_cell_at(f, x, y)) return true;
        return false;
    }
    for (int x = 0; x < w; x++) if (pet->frames[fr].a[row * w + x] != 0) return true;
    return false;
}
// The index of the scene's frame whose cells these are, or -1.
static int scene_frame(const ht_pet_scene_t *sc, const uint8_t *cells, unsigned levels)
{
    unsigned n = 0;
    for (unsigned i = 0; i < sc->steps * levels; i++) if (sc->loop[i] >= n) n = sc->loop[i] + 1u;
    for (unsigned k = 0; k < n; k++) if (sc->frames[k].cells == cells) return (int)k;
    return -1;
}
// Focus draws in ONE font (owner, 2026-10-02): every visible text run of the scene is one of the five Inter faces,
// except an icon run (the bell and the close cross are FontAwesome in Montserrat, alone in their run) and the voice
// bars / sparkles (drawn art in the ht_wave / ht_spark atlases, not letters). No GeistMono, no Geist, no Roboto, and
// the curved runs are Inter Medium 26. An empty run is an invisible placeholder: its font pointer does not count.
static bool inter_face(const ht_font_t *font)
{
    return font == &ht_lv_inter_20.base || font == &ht_lv_inter_25.base || font == &ht_lv_inter_med_26.base ||
           font == &ht_lv_inter_30.base || font == &ht_lv_inter_36.base;
}
static void only_inter(const ht_scene_t *scene)
{
    for (int i = 0; i < scene->count; i++) {
        const ht_run_t *r = &scene->runs[i];
        if (!r->text[0]) continue;
        bool icon = (r->font == &ht_lv_montserrat_14.base && !strcmp(r->text, HT_LV_BELL)) ||
                    (r->font == &ht_lv_montserrat_22.base && !strcmp(r->text, HT_LV_CROSS));
        bool art = r->font == &ht_wave || r->font == &ht_spark;
        assert(inter_face(r->font) || icon || art);
        if (r->arc) assert(r->font == &ht_lv_inter_med_26.base);
    }
}
/*
 * THE PET'S GAPS (owner, 2026-10-07: "the name to the pet's head about the pet's feet to the text"): on the drawn
 * glass, from the name's ink foot over the pet's columns down to the pet's first inked row, and from its last inked row
 * down to the text's first inked row (anywhere across the glass). Returns their difference (above - below).
 */
static int pet_gaps(const ht_scene_t *scene, const ht_run_t *mark)
{
    ht_raster(scene, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, full);
    int x0 = mark->x, x1 = mark->x + mark->sprite.width, first = -1, last = -1;
    #define INKED(y_) ({ bool i_ = false; for (int x_ = x0; x_ < x1; x_++) i_ |= full[(y_) * HT_WIDTH + x_] != 0; i_; })
    for (int y = mark->y; y < mark->y + mark->sprite.height; y++) if (INKED(y)) { if (first < 0) first = y; last = y; }
    assert(first > 0);
    int foot = first - 1;
    while (foot > 0 && !INKED(foot)) foot--;
    int text = last + 1;
    x0 = 0; x1 = HT_WIDTH;
    while (text < HT_HEIGHT && !INKED(text)) text++;
    #undef INKED
    int above = first - foot - 1, below = text - last - 1;
    assert(foot > 0 && above > 0 && below > 0);
    return above - below;
}
static void focus_face(void)
{
    ht_character_t c = {0};
    assert(ht_character_select(&c, HT_CHARACTER_FOCUS));
    assert(!strcmp(ht_character_name(HT_CHARACTER_FOCUS), "Focus"));
    const char *long_name = "A pane with a name far wider than the glass can hold";
    const char *long_tab = "A workspace whose name is no longer drawn on this face";
    const char *recap = "Shipped the retry queue and the webhook tests pass on the first run, "
                        "then tidied the parser.";
    struct { const char *tab, *name, *engine, *activity, *recap; ht_character_mood_t mood;
             uint16_t elapsed; uint8_t level; } cases[] = {
        {"", "", "", "", "", HT_CHARACTER_IDLE, 0, 0},
        {"Harness repo", "Payments refactor", "claude", "", recap, HT_CHARACTER_IDLE, 0, 0},
        {"Harness repo", "Payments refactor", "claude", "Coalescing", "", HT_CHARACTER_WORKING, 34, 0},
        {"Harness repo", "Payments refactor", "codex", "", "", HT_CHARACTER_LISTENING, 0, 4},
        {long_tab, long_name, "opencode", "Simmering", recap, HT_CHARACTER_WORKING, 65535, 2},
        // The widest four lines the recap can hold: its fourth line sits lowest on the glass, where
        // the circle is narrowest, and must still keep its ink inside it.
        {"", "Wide", "codex", "", "MW MW MW MW MW MW MW MW MW MW MW MW MW MW MW MW MW MW MW MW MW MW MW "
         "MW MW MW MW MW MW MW", HT_CHARACTER_IDLE, 0, 0},
        {"Ti\u1ebfng Vi\u1ec7t", "\u0110\u00e3 s\u1eeda xong ph\u1ea7n flush", "claude", "",
         "L\u01b0\u1ee3ng b\u1ed9 nh\u1edb \u0111\u00e3 gi\u1ea3m v\u00e0 ki\u1ec3m tra l\u1ea1i.", HT_CHARACTER_IDLE, 0, 0},
    };
    int expected = -1;
    for (unsigned i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        ht_character_face_t f = {.recipient = cases[i].name, .tab = cases[i].tab,
            .engine = cases[i].engine, .activity = cases[i].activity, .elapsed = cases[i].elapsed,
            .status = "", .hint = "", .detail = "", .mood = cases[i].mood,
            .foreground = 0xffff, .dim = 0x8410, .ink = 0xffff};
        f.pose.level = cases[i].level;
        ht_scene_t scene; ht_scene_clear(&scene, 0);
        ht_character_face(&scene, &c, &f, 0xffff, cases[i].recap);
        if (expected < 0) expected = scene.count;
        assert(scene.count == expected);   // property 1
        only_inter(&scene);
        ht_raster(&scene, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, full);
        for (int y = 0; y < HT_HEIGHT; y++) for (int x = 0; x < HT_WIDTH; x++)
            if (full[y * HT_WIDTH + x])
                assert((x - 233) * (x - 233) + (y - 233) * (y - 233) < 230 * 230);   // property 2
    }
    /*
     * THE OCTOPUS'S LAYOUT (owner, 2026-10-01): the name on the top curve, the engine's 56 px mark,
     * and a recap of up to four lines that ends in "…" once it is cut — at the octopus's ninety
     * codepoints or at four lines, whichever comes first — every line within the recap column's 364 px, so the
     * raster never cuts it.
     */
    {
        const char *lengthy = "Flashed 0.0.91 to both dials and verified the image on each. All 44 host checks "
                              "pass, including the new reader tests. Nothing is committed yet; say commit.";
        ht_character_face_t f = {.recipient = long_name, .tab = long_tab, .engine = "claude",
            .activity = "", .status = "", .hint = "", .detail = "", .mood = HT_CHARACTER_IDLE,
            .foreground = 0xffff, .dim = 0x8410, .ink = 0xffff};
        ht_scene_t scene; ht_scene_clear(&scene, 0);
        ht_character_face(&scene, &c, &f, 0xffff, lengthy);
        int arc = 0, mark = 0, lines = 0;
        const ht_run_t *last = NULL;
        for (int i = 0; i < scene.count; i++) {
            const ht_run_t *r = &scene.runs[i];
            if (r->arc == 1) { arc++; assert(r->font == &ht_lv_inter_med_26.base); }
            if (r->sprite.width == 56 || r->sprite.width == pet_of("claude")->w) mark++;
            if (r->font == &ht_lv_inter_30.base && r->text[0]) {
                lines++; last = r;
                // LVGL lets a wrapped line's trailing space run past the width; its ink may not.
                char ink[HT_TEXT_BYTES];
                snprintf(ink, sizeof ink, "%s", r->text);
                for (size_t n = strlen(ink); n && ink[n - 1] == ' '; ) ink[--n] = 0;
                assert(ht_measure(r->font, r->text) <= r->w && ht_measure(r->font, ink) <= 364);
            }
        }
        assert(arc == 1 && mark == 1 && lines >= 3 && lines <= 4);
        size_t n = strlen(last->text);
        assert(n >= 3 && !strcmp(last->text + n - 3, "\xe2\x80\xa6"));
        only_inter(&scene);
        // No tab pill and no name row: nothing in Montserrat is drawn.
        for (int i = 0; i < scene.count; i++)
            assert(scene.runs[i].font != &ht_lv_montserrat_22.base && scene.runs[i].font != &ht_lv_montserrat_14.base);
    }

    // The check and cross marks (U+2713 / U+2717) reach the glass: every Focus face holds them (the five
    // Inter faces take them from Noto Sans Symbols 2 through gen_focus_faces.py's second --font); a missing glyph is "?".
    {
        const char *marks = "Tests \xe2\x9c\x93 pushed \xe2\x9c\x97";
        ht_character_face_t f = {.recipient = "pane", .tab = "", .engine = "claude", .activity = "",
            .status = "", .hint = "", .detail = "", .mood = HT_CHARACTER_IDLE,
            .foreground = 0xffff, .dim = 0x8410, .ink = 0xffff};
        ht_scene_t scene; ht_scene_clear(&scene, 0);
        ht_character_face(&scene, &c, &f, 0xffff, marks);
        int found = 0;
        for (int i = 0; i < scene.count; i++)
            if (scene.runs[i].font == &ht_lv_inter_30.base && strstr(scene.runs[i].text, "\xe2\x9c\x93")) found++;
        assert(found == 1);
        const ht_pfont_t *faces[] = {&ht_lv_inter_20, &ht_lv_inter_25, &ht_lv_inter_med_26,
            &ht_lv_inter_30, &ht_lv_inter_36};
        for (unsigned k = 0; k < sizeof faces / sizeof faces[0]; k++) {
            int has[2] = {0, 0};   // the face itself holds both marks, not its "?" or a fallback
            for (unsigned g = 0; g < faces[k]->count; g++) {
                has[0] |= faces[k]->codes[g] == 0x2713;
                has[1] |= faces[k]->codes[g] == 0x2717;
            }
            assert(has[0] && has[1]);
        }
    }

    /*
     * THE VOICE FACE, both halves of it, every frame.
     *
     * It is the same skin through the same entry point — ui_habitat.c sets `voice` and Focus owns
     * the whole glass — so the constant-run rule applies across the two states as well as within
     * them: recording and sending must emit the same runs in the same order, or a person watching a
     * clip go out gets a full 466x466 repaint at the moment the meter stops. The bars reach 121 px
     * and the sparkles sit on a 66 px pitch, both of which are wider and taller than anything the
     * home face draws, so the bezel is checked here again rather than assumed from above.
     */
    {
        int voice_runs = -1;
        for (int sending = 0; sending < 2; sending++)
            for (int frame = 0; frame < 15; frame++) {
                ht_character_face_t f = {.recipient = "", .tab = "", .engine = "", .activity = "",
                    .status = "", .hint = "", .detail = "", .voice = true,
                    .mood = sending ? HT_CHARACTER_WORKING : HT_CHARACTER_LISTENING,
                    .foreground = 0xffff, .dim = 0x8410, .ink = 0xffff};
                ht_scene_t scene; ht_scene_clear(&scene, 0);
                c.motion.frame = (uint8_t)frame;
                ht_character_face(&scene, &c, &f, 0xffff, recap);
                if (voice_runs < 0) voice_runs = scene.count;
                assert(scene.count == voice_runs);
                ht_raster(&scene, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, full);
                int ink = 0;
                for (int y = 0; y < HT_HEIGHT; y++) for (int x = 0; x < HT_WIDTH; x++)
                    if (full[y * HT_WIDTH + x]) {
                        ink++;
                        assert((x - 233) * (x - 233) + (y - 233) * (y - 233) < 230 * 230);
                    }
                assert(ink > 0);   // a voice screen that drew nothing would pass every rule above
            }
        c.motion.frame = 0;
    }

    /*
     * WHERE THEY STAND: the name on the arc. A recap is a "Kindle dark" page, set in Inter (owner, 2026-10-02, K3), on a
     * card again (owner, 2026-10-07): #1c1e26 (the LVGL card's #23252f at 80 %) rimmed #3d3f47, the full 384 px column at x 41, from 21 px over the first
     * line's capitals to 21 px under the last line's baseline (a line's baseline to the next one's capitals), so it grows with the lines; up to four lines of inter_30 in 0xd6d6d2, each centred on x 233
     * in the 364 px column at x 51, 43 px apart, the block centred in y 176..376 with its first baseline 30 px under the block's top. Working or resting
     * there is no recap and the line is centred on the glass. The mark sits halfway between the foot of the arc's cells
     * (y 44) and the recap's first line as drawn (its capitals' top, 22 px over the baseline): the gap above equals the
     * gap below (owner, 2026-10-05). Over a short recap the pet is larger, its own drawing at that size: 2x over one
     * line, 1.75x over two, 1.5x over three; over four the 56 px mark's box.
     */
    {
        ht_character_face_t f = {.recipient = "Payments refactor", .tab = "Harness repo",
            .engine = "claude", .status = "", .hint = "", .detail = "", .mood = HT_CHARACTER_IDLE,
            .foreground = 0xffff, .dim = 0x8410, .ink = 0xffff};
        const char *recaps[] = {"Done.", "Shipped the retry queue and the webhook tests.",
            ("Flashed 0.0.91 to both dials and verified the image on each. All 44 host checks pass, "
             "including the new reader tests. Nothing is committed yet."),
            ("Flashed 0.0.91 to both dials and verified the image on each. All 44 host checks pass, "
             "including the new reader tests. Nothing is committed yet; say commit and I will push it.")};
        const ht_pfont_t *lit = &ht_lv_inter_30;
        int count = -1;
        for (unsigned k = 0; k < 4; k++) {
            ht_scene_t scene; ht_scene_clear(&scene, 0);
            ht_character_face(&scene, &c, &f, 0xffff, recaps[k]);
            if (count < 0) count = scene.count;
            assert(scene.count == count);   // the run count never moves with the recap
            const ht_run_t *name = &scene.runs[0], *mark = &scene.runs[1];
            assert(name->arc == 1 && !strcmp(name->text, "Payments refactor") && name->font == &ht_lv_inter_med_26.base);
            only_inter(&scene);
            // The Claude pet, still (clock 0), centred in the 56 px mark's box: the rest loop's 73 x 50 cell frames
            // (assets/pets/claude/rest), at its step 0.
            const ht_pet_t *cp = pet_of("claude");
            assert(cp && cp->cells && !cp->frames && cp->w == 73 && cp->h == 50);
            const ht_run_t *card = &scene.runs[2];
            int lines = 0;
            for (int i = 3; i < 7; i++) if (scene.runs[i].text[0]) lines++;
            assert(lines >= 1 && lines <= 4 && (k != 0 || lines == 1));
            {
                int cap = scene.runs[3].y + lit->ascent - 22;
                assert(card->box.fill == ht_rgb(0x1c1e26) && card->box.border == ht_rgb(0x3d3f47) && card->box.radius == 24);
                assert(card->x == 41 && card->w == 384 && card->y == cap - 21 && card->box.h == 22 + (lines - 1) * 43 + 42);
                for (int i = 3; i < 3 + lines; i++) assert(scene.runs[i].bg == card->box.fill);   // set on the card
                // inside the glass at four lines too
                static uint16_t cpx[HT_WIDTH * HT_HEIGHT];
                ht_scene_t only; ht_scene_clear(&only, 0);
                only.runs[only.count++] = *card;
                ht_raster(&only, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, cpx);
                for (int y = 0; y < HT_HEIGHT; y++) for (int x = 0; x < HT_WIDTH; x++)
                    if (cpx[y * HT_WIDTH + x]) assert((x - 233) * (x - 233) + (y - 233) * (y - 233) < 230 * 230);
            }
            for (int i = 3; i < 3 + lines; i++)
                assert(scene.runs[i].font == &lit->base && scene.runs[i].fg == ht_rgb(0xd6d6d2));
            for (int i = 3; i < 3 + lines; i++) {   // each line centred on x 233 (+-1), inside its column
                const ht_run_t *ln = &scene.runs[i];
                assert(ln->x + ln->w / 2 >= 232 && ln->x + ln->w / 2 <= 234 && ln->x >= 51 && ln->x + ln->w <= 51 + 364);
            }
            int top = 176 + (200 - 43 * lines) / 2;
            for (int i = 0; i < lines; i++) {
                assert(scene.runs[3 + i].y == top + 30 - lit->ascent + i * 43);   // baseline top + 30, pitch 43
                assert(scene.runs[3 + i].y + lit->base.height <= 376 && scene.runs[3 + i].y >= 176 - 5);
            }
            if (k == 3) {   // cut at four lines with its ellipsis
                size_t n = strlen(scene.runs[6].text);
                assert(lines == 4 && n >= 3 && !strcmp(scene.runs[6].text + n - 3, "\xe2\x80\xa6"));
            }
            // The mark: at step 0, its size by the line count, its ink centred between the name's ink above it and the
            // first line's capitals.
            int frame = cp->loops[HT_PET_IDLE][0].frame;
            assert(pet_frame(cp, &mark->sprite) == frame);
            if (lines < 4) {
                // the same 2x drawing (99 px tall) at 1.5x over one, two or three lines: Claude stays there (owner, 2026-10-06)
                static const int want_zoom[3] = {6, 6, 6}, want_h[3] = {75, 75, 75};
                assert(mark->sprite.zoom == want_zoom[lines - 1] && mark->sprite.height == want_h[lines - 1]);
                assert(mark->x == (466 - mark->sprite.width) / 2);
            } else {
                assert(mark->sprite.zoom == 4 && mark->sprite.width == cp->w && mark->sprite.height == cp->h &&
                       mark->x == (466 - cp->w) / 2);
            }
            // Within 3 px: the pet is placed by the line's capitals, and a tall letter (l, d, h) reaches a little over them.
            int d = pet_gaps(&scene, mark);
            assert(d >= -3 && d <= 3);
        }

        // The name in Inter on the arc: ink inside r 230 and the canvas for an ASCII, a Vietnamese and a long name, the
        // long one cut with its ellipsis; the caption's tap target (the run's bounds) stays on the top edge.
        {
            const char *long_names[] = {"Payments refactor", "Tri\xe1\xbb\x83n khai firmware m\xe1\xbb\x9bi nh\xe1\xba\xa5t",
                "\xe1\xba\xbe\xe1\xbb\x86\xe1\xba\xbe\xe1\xbb\x86\xe1\xba\xbe\xe1\xbb\x86\xe1\xba\xbe\xe1\xbb\x86\xe1\xba\xbe\xe1\xbb\x86\xe1\xba\xbe\xe1\xbb\x86",
                "Supercalifragilisticexpialidocious pane name that runs on and on"};
            for (unsigned k = 0; k < 4; k++) {
                ht_character_face_t g = f; g.recipient = long_names[k];
                ht_scene_t sc; ht_scene_clear(&sc, 0);
                ht_character_face(&sc, &c, &g, 0xffff, "Done.");
                const ht_run_t *name = &sc.runs[0];
                assert(name->arc == 1 && name->font == &ht_lv_inter_med_26.base && name->ink && name->text[0]);
                assert(ht_arc_measure(&ht_arc_inter_prop, name->text) <= HT_ARC_SPAN);
                ht_rect_t b = ht_run_bounds(name);
                assert(b.y >= HT_ARC_Y && b.y + b.h <= HT_ARC_Y + HT_ARC_HEIGHT && b.y < 66);   // on the top edge, inside the tap strip
                static uint16_t px[HT_WIDTH * HT_HEIGHT], blank[HT_WIDTH * HT_HEIGHT];   // the name alone: every inked pixel inside r 230
                ht_scene_t only, none; ht_scene_clear(&only, 0); ht_scene_clear(&none, 0);
                ht_arc_title_face(&only, 0xffff, long_names[k], &ht_arc_inter_prop);
                ht_raster(&only, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, px);
                ht_raster(&none, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, blank);
                int ink = 0;
                for (int y = 0; y < HT_HEIGHT; y++) for (int x = 0; x < HT_WIDTH; x++) if (px[y * HT_WIDTH + x] != blank[y * HT_WIDTH + x]) {
                    ink++;
                    assert((x - 233) * (x - 233) + (y - 233) * (y - 233) < 230 * 230);
                    assert(x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h && y != HT_ARC_Y);
                }
                assert(ink > 0);
                if (k == 3) {   // too long for the arc: cut short with no "…" (owner, 2026-10-03) — at a word when
                    size_t n = strlen(name->text);   // that keeps half the span, here a letter into the first word
                    assert(n > 3 && n < strlen(long_names[k]) && !strstr(name->text, "\xe2\x80\xa6") &&
                           name->text[n - 1] != ' ' && !strncmp(long_names[k], name->text, n));
                    ht_scene_t w; ht_scene_clear(&w, 0);   // a name of short words ends at a whole word
                    const char *words = "Deploy the latest firmware to every dial in the studio tonight";
                    ht_arc_title_face(&w, 0xffff, words, &ht_arc_inter_prop);
                    size_t m = strlen(w.runs[0].text);
                    assert(m && m < strlen(words) && !strncmp(words, w.runs[0].text, m) && words[m] == ' ' &&
                           !strstr(w.runs[0].text, "\xe2\x80\xa6"));
                }
            }
        }

        f.activity = "Working"; f.elapsed = 34;
        ht_scene_t scene; ht_scene_clear(&scene, 0);
        ht_character_face(&scene, &c, &f, 0xffff, "");
        only_inter(&scene);
        assert(scene.runs[7].y == 233 - ht_lv_inter_30.base.height / 2 && scene.runs[7].font == &ht_lv_inter_30.base &&
               !strcmp(scene.runs[7].text, "Simmering\xe2\x80\xa6 34s"));   // the gerund for 30..35 s
        {
            int d = pet_gaps(&scene, &scene.runs[1]);
            assert(d >= -3 && d <= 3);
        }

        // Resting: one of the invitations, centred, holding still while the face stays up (both draws
        // of an agent say the same), and picked afresh when the face comes back.
        f.activity = ""; f.elapsed = 0;
        static const char *const resting[] = {"Let's build it", "Do anything", "What's next?",
            "Ready when you are", "Tap to talk", "Say the word", "Make it happen", "Start something",
            "Hold to switch tabs", "Tap the name to switch panes"};
        char first[64] = "";
        const char *names[] = {"Payments refactor", "Landing page", "Deploy firmware", "Docs sweep",
                               "Bug triage", "Release notes"};
        for (unsigned k = 0; k < sizeof names / sizeof names[0]; k++) {
            f.recipient = names[k];
            for (int again = 0; again < 2; again++) {
                ht_scene_clear(&scene, 0);
                ht_character_face(&scene, &c, &f, 0xffff, "");
                only_inter(&scene);
                const ht_run_t *l1 = &scene.runs[8], *l2 = &scene.runs[9];
                // Compared without spaces: a wrapped line keeps the space LVGL broke it at.
                char said[64], want[64];
                snprintf(said, sizeof said, "%s%s", l1->text, l2->text);
                squeeze(said);
                bool known = false;
                for (unsigned r = 0; r < sizeof resting / sizeof resting[0]; r++) {
                    snprintf(want, sizeof want, "%s", resting[r]); squeeze(want);
                    known |= !strcmp(said, want);
                }
                assert(known);
                assert(l1->y == 233 - ht_lv_inter_30.base.height / 2);
                // The pet (Claude resting is its 1.5x drawing) is centred over the resting line itself: as far from the
                // name above it as from the line under it (owner, 2026-10-07).
                assert(scene.runs[1].sprite.zoom == 6 && scene.runs[1].sprite.height == 75);
                // Within 4 px: a resting line's tall letters (l, d, b at 36 px) reach over its capitals.
                int d = pet_gaps(&scene, &scene.runs[1]);
                assert(d >= -4 && d <= 4);
                if (!again) snprintf(first, sizeof first, "%s", said);
                else assert(!strcmp(said, first));   // a redraw never swaps it
            }
        }
        /*
         * RANDOM WHEREVER IT SHOWS (owner, 2026-10-02): the same name every time — "Choose a pane",
         * the face with no agent — still gets a new line each time the resting face returns, never
         * the one it just showed, and over a few returns most of the list.
         */
        for (int relaxing = 0; relaxing < 2; relaxing++) {
            // Today's resting face (an engine with no relaxing scene: Cursor) says its line in the middle, runs 8 and 9;
            // the relaxing face (Claude) on the lower arc, run 10, from its own list (owner, 2026-10-09). The same picker.
            f.engine = relaxing ? "claude" : "cursor";
            f.recipient = "Choose a pane";
            char last[64] = "", seen[10][64];
            int kinds = 0;
            #define SAID(sc_, out_) do { if (relaxing) { assert((sc_).runs[10].arc == 2 && (sc_).runs[10].fg == ht_rgb(0x9a9aa6) && \
                !(sc_).runs[8].text[0] && !(sc_).runs[9].text[0]); snprintf(out_, sizeof out_, "%s", (sc_).runs[10].text); } \
                else { assert(!(sc_).runs[10].arc); snprintf(out_, sizeof out_, "%s%s", (sc_).runs[8].text, (sc_).runs[9].text); } \
                squeeze(out_); } while (0)
            for (int visit = 0; visit < 24; visit++) {
                f.activity = "Working"; f.elapsed = 3; f.clock_ms = 1000u + (uint32_t)visit * 977u;
                ht_scene_clear(&scene, 0);
                ht_character_face(&scene, &c, &f, 0xffff, "");   // away: the working line
                f.activity = ""; f.elapsed = 0;
                ht_scene_clear(&scene, 0);
                ht_character_face(&scene, &c, &f, 0xffff, "");   // back to resting
                char said[64];
                SAID(scene, said);
                assert(said[0] && strcmp(said, last));
                snprintf(last, sizeof last, "%s", said);
                bool known = false;
                for (int k = 0; k < kinds; k++) known |= !strcmp(seen[k], said);
                if (!known && kinds < 10) snprintf(seen[kinds++], sizeof seen[0], "%s", said);
                // held while the face stays up: a redraw later in the scene says the same
                f.clock_ms += 2000;
                ht_scene_clear(&scene, 0);
                ht_character_face(&scene, &c, &f, 0xffff, "");
                char again[64];
                SAID(scene, again);
                assert(!strcmp(again, said));
            }
            assert(kinds >= 5);
            // The teaching lines come up more (owner, 2026-10-03): today's "Tap to talk" is listed 10 times of 27,
            // "Hold to switch tabs" 5, "Tap the name to switch panes" 5, the rest once; the relaxing list "Tap to talk"
            // 10 of 24, "Hold for tabs" 5, "Tap name for panes" 5, "What's next?", "Your move", "Say the word", "Ask away"
            // once — never twice running.
            static const char *const relax_lines[] = {"Taptotalk", "Holdfortabs", "Tapnameforpanes", "What'snext?",
                                                      "Yourmove", "Saytheword", "Askaway"};
            int talk = 0, tabs = 0, name = 0, other = 0, each[7] = {0};
            for (int visit = 0; visit < 900; visit++) {
                f.activity = "Working"; f.elapsed = 3; f.clock_ms = 7u + (uint32_t)visit * 613u;
                ht_scene_clear(&scene, 0);
                ht_character_face(&scene, &c, &f, 0xffff, "");
                f.activity = ""; f.elapsed = 0;
                ht_scene_clear(&scene, 0);
                ht_character_face(&scene, &c, &f, 0xffff, "");
                char said[64];
                SAID(scene, said);
                assert(strcmp(said, last));
                snprintf(last, sizeof last, "%s", said);
                if (!strcmp(said, "Taptotalk")) talk++;
                else if (!strcmp(said, relaxing ? "Holdfortabs" : "Holdtoswitchtabs")) tabs++;
                else if (!strcmp(said, relaxing ? "Tapnameforpanes" : "Tapthenametoswitchpanes")) name++;
                else other++;
                if (relaxing) {
                    bool listed = false;
                    for (int k = 0; k < 7; k++) if (!strcmp(said, relax_lines[k])) { each[k]++; listed = true; }
                    assert(listed);   // only the new list on the relaxing face
                }
            }
            #undef SAID
            if (relaxing) {
                assert(talk > tabs && talk > name && talk > 250 && tabs > 100 && name > 100 && other > 60);
                for (int k = 3; k < 7; k++) assert(each[k] > 10);   // every invitation comes up
            } else
                assert(talk > tabs && talk > name && tabs > other / 7 * 2 && name > other / 7 * 2 && talk > 200 && other > 60);
            f.clock_ms = 0;
        }
        f.engine = "claude";
        f.recipient = "Payments refactor";

        // An engine this build has no mark for leaves the mark's place empty, not a wrong mark.
        f.engine = "something-new";
        ht_scene_clear(&scene, 0);
        ht_character_face(&scene, &c, &f, 0xffff, "");
        assert(!scene.runs[1].sprite.width && !scene.runs[1].text[0]);
    }

    /*
     * THE PETS (claude, codex): every state, every step. The pet takes the mark's run (the count never moves),
     * its frame and hop follow the face's own state and clock_ms, it stays on the glass, and only an engine with a
     * pet gets one.
     */
    assert(ht_pet_count > 0);
    for (unsigned pe = 0; pe < ht_pet_count; pe++) {
        const ht_pet_t *pet = &ht_pets[pe];
        const char *eng = pet->engine;
        assert(pet_of(eng) == pet && ht_focus_engine_index(eng) >= 0);   // a known engine, listed once
        for (unsigned q = 0; q < pe; q++) assert(strcmp(ht_pets[q].engine, eng));
        // Clear of the curved title: no layout, state or step puts ink above the foot of its cells.
        for (int layout = 0; layout < 3; layout++)       // recap card, working line, resting line
            for (int state = 0; state < HT_PET_STATES; state++)
                for (int step = 0; step < (int)ht_pet_steps(pet); step++) {
                    ht_character_face_t f = {.recipient = "Payments refactor", .engine = eng,
                        .activity = layout == 1 ? "Working" : "", .elapsed = 5, .status = "", .hint = "",
                        .detail = "", .mood = state == HT_PET_DONE ? HT_CHARACTER_DONE : HT_CHARACTER_IDLE,
                        .foreground = 0xffff, .dim = 0x8410, .ink = 0xffff, .asking = state == HT_PET_ASKING,
                        .clock_ms = (uint32_t)step * pet->step_ms[state] + 1};
                    if (state == HT_PET_WORKING && layout != 2) f.activity = "Working";
                    ht_scene_t scene; ht_scene_clear(&scene, 0);
                    ht_character_face(&scene, &c, &f, 0xffff, layout == 0 ? "Shipped the retry queue." : "");
                    const ht_run_t *mark = &scene.runs[1];
                    if (pet->working_scene && layout == 1 && state != HT_PET_ASKING) continue;   // the scene: below
                    if (pet->relaxing_scene && layout == 2 && (state == HT_PET_IDLE || state == HT_PET_DONE || state == HT_PET_WORKING)) continue;   // relaxing: below
                    int fr = pet_frame(pet, &mark->sprite);
                    assert(fr >= 0);
                    if (mark->sprite.height != pet->h) {   // a larger drawing: its whole box is under the title
                        assert(mark->y >= HT_ARC_Y + HT_ARC_CELL_HEIGHT);
                        continue;
                    }
                    int row = 0;
                    while (row < pet->h && !pet_row_inked(pet, fr, row)) row++;
                    assert(row < pet->h && mark->y + row >= HT_ARC_Y + HT_ARC_CELL_HEIGHT);
                }
        int frame_at[HT_PET_STATES][HT_PET_STEPS];
        for (int state = 0; state < HT_PET_STATES; state++)
            for (int step = 0; step < (int)ht_pet_steps(pet); step++) {
                ht_character_face_t f = {.recipient = "Payments refactor", .engine = eng,
                    .activity = "", .status = "", .hint = "", .detail = "", .mood = HT_CHARACTER_IDLE,
                    .foreground = 0xffff, .dim = 0x8410, .ink = 0xffff,
                    .clock_ms = (uint32_t)step * pet->step_ms[state] + 1};
                if (state == HT_PET_WORKING) { f.activity = "Working"; f.elapsed = 5; }
                if (state == HT_PET_DONE) f.mood = HT_CHARACTER_DONE;
                if (state == HT_PET_ASKING) f.asking = true;
                ht_scene_t scene; ht_scene_clear(&scene, 0);
                ht_character_face(&scene, &c, &f, 0xffff, state == HT_PET_DONE ? "Done." : "");
                const ht_run_t *mark = &scene.runs[1];
                const ht_pet_scene_t *rs = state == HT_PET_IDLE ? pet->relaxing_scene : NULL;
                assert(scene.count == 1 + 1 + 1 + 4 + 1 + 2 + 1 + (rs && rs->shapes ? rs->shapes->count : 0));
                const ht_pet_scene_t *ws = state == HT_PET_WORKING ? pet->working_scene : NULL;
                if (rs) {
                    // THE RELAXING SCENE: in the mark's run, placed as a working scene is, the grey line on the lower arc.
                    unsigned st = (step * pet->step_ms[state] + 1) / rs->step_ms % rs->steps;
                    int frame = scene_frame(rs, mark->sprite.cells, 1);
                    assert(frame == rs->loop[st]);
                    assert(mark->sprite.width == rs->w && mark->sprite.height == rs->h && mark->x == (466 - rs->w) / 2 + rs->dx);
                    assert(mark->y == 233 + 4 - rs->h / 2 + rs->dy + (rs->step_dy ? rs->step_dy[st] : 0));
                    assert(!scene.runs[7].text[0] && !scene.runs[8].text[0] && !scene.runs[9].text[0]);
                    assert(scene.runs[10].arc == 2 && scene.runs[10].fg == ht_rgb(0x9a9aa6) && scene.runs[10].text[0]);
                    frame_at[state][step] = frame;
                } else if (ws) {
                    // THE WORKING SCENE: in the mark's run, centred, the status on the lower arc.
                    int frame = scene_frame(ws, mark->sprite.cells, 1);
                    assert(frame == ws->loop[(step * pet->step_ms[state] + 1) / ws->step_ms % ws->steps]);
                    assert(mark->sprite.width == ws->w && mark->sprite.height == ws->h && mark->x == (466 - ws->w) / 2 + ws->dx);
                    int bob = ws->step_dy ? ws->step_dy[(step * pet->step_ms[state] + 1) / ws->step_ms % ws->steps] : 0;
                    assert(mark->y == 233 + 4 - ws->h / 2 + ws->dy + bob);
                    assert(!scene.runs[7].text[0]);                 // the centred status is empty
                    const ht_run_t *lower = &scene.runs[10];
                    assert(lower->arc == 2 && !strcmp(lower->text, "Working\xe2\x80\xa6 5s"));   // Inter has the real ellipsis
                    assert(lower->fg == ht_rgb(0x00ff2f));
                    frame_at[state][step] = frame;
                } else {
                int frame = pet_frame(pet, &mark->sprite);
                const ht_pet_step_t *want = &pet->loops[state][step];
                // Over the one-line "Done." recap the pet is shown at 2x, the same frame; its hop grows with it. Claude
                // stays at 1.5x there and resting (asking, idle: no recap, no status) — owner, 2026-10-06. Codex resting
                // is 2x, as over a one-line recap (owner, 2026-10-07).
                bool claude = !strcmp(eng, "claude"), codex = !strcmp(eng, "codex");
                int z = claude && state != HT_PET_WORKING ? 6 : state == HT_PET_DONE || codex ? 8 : 4;
                const ht_cell_frame_t *fr_ = &pet->cells[want->frame];
                int ww = (fr_->cols * fr_->cell * z + 7) / 8, hh = (fr_->rows * fr_->cell * z + 7) / 8;
                assert(frame == want->frame && mark->sprite.width == ww && mark->sprite.height == hh);
                assert(mark->x == (466 - ww) / 2);
                assert(!scene.runs[10].text[0] && !scene.runs[10].arc);   // no lower arc outside the scene
                // The 56 px box's top is where the same face with step 0 puts it: only dy moves the pet.
                ht_character_face_t g = f; g.clock_ms = 1;
                ht_scene_t rest; ht_scene_clear(&rest, 0);
                ht_character_face(&rest, &c, &g, 0xffff, state == HT_PET_DONE ? "Done." : "");
                assert(mark->y - rest.runs[1].y == (want->dy - pet->loops[state][0].dy) * z / 4);
                frame_at[state][step] = frame;
                }
                ht_raster(&scene, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, full);
                int ink = 0;
                for (int y = 0; y < HT_HEIGHT; y++) for (int x = 0; x < HT_WIDTH; x++)
                    if (full[y * HT_WIDTH + x]) {
                        ink++;
                        assert((x - 233) * (x - 233) + (y - 233) * (y - 233) < 230 * 230);
                    }
                assert(ink > 0);
            }
        // Each state moves: more than one frame (or a hop) over its loop, and one step_ms changes it.
        for (int state = 0; state < HT_PET_STATES; state++) {
            bool moves = false;
            for (int step = 0; step < (int)ht_pet_steps(pet); step++)
                moves |= frame_at[state][step] != frame_at[state][0] ||
                         pet->loops[state][step].dy != pet->loops[state][0].dy;
            assert(moves);
        }
        // Every small pet is cell frames drawn at 2x (one palette, 0 transparent; Codex's grid at 8 px a cell), shown at 1x
        // with ht_cell_sprite_zoom (zoom 4), centred in the 56 px box.
        assert(pet->cells && !pet->frames);
        if (pet->cells) {
            ht_character_face_t cf = {.recipient = "Payments refactor", .engine = eng, .status = "", .hint = "", .detail = "",
                .mood = HT_CHARACTER_IDLE, .foreground = 0xffff, .dim = 0x8410, .ink = 0xffff, .clock_ms = 1};
            // (a pet with a relaxing scene shows its small self resting only while held: clock 0)
            if (pet->relaxing_scene) cf.clock_ms = 0;
            ht_scene_t cs; ht_scene_clear(&cs, 0);
            ht_character_face(&cs, &c, &cf, 0xffff, "");
            const ht_run_t *cm = &cs.runs[1];
            int fr = pet_frame(pet, &cm->sprite);
            assert(fr == pet->loops[HT_PET_IDLE][0].frame && !cm->sprite.pixels && cm->sprite.cells == pet->cells[fr].cells);
            assert((pet->cells[fr].cols * pet->cells[fr].cell * 4 + 7) / 8 == pet->w &&
                   (pet->cells[fr].rows * pet->cells[fr].cell * 4 + 7) / 8 == pet->h && !pet->cells[fr].palette[0]);
            // Resting: a 1x pet, Claude's 1.5x and Codex's 2x drawing, centred across the glass and, by its ink, between the
            // name above it and the resting line under it (owner, 2026-10-07).
            if (!strcmp(eng, "claude") || !strcmp(eng, "codex")) {
                int z = !strcmp(eng, "claude") ? 6 : 8;
                assert(cm->sprite.zoom == (z == 8 ? 0 : z) && cm->sprite.height == (pet->cells[fr].rows * pet->cells[fr].cell * z + 7) / 8);
            } else assert(cm->sprite.zoom == 4 && cm->sprite.width == pet->w && cm->sprite.height == pet->h);
            assert(cm->x == (466 - cm->sprite.width) / 2);
            int d = pet_gaps(&cs, cm);
            assert(d >= -4 && d <= 4);
        }
        // The working legs change on the next step: 90 ms later is a different frame.
        // (Muse's Jolly and Claude's Clawd play one rest loop for every state: no legs, no blink at 20.)
        if (!strcmp(eng, "codex")) {
            assert(frame_at[HT_PET_WORKING][0] != frame_at[HT_PET_WORKING][3]);
            assert(frame_at[HT_PET_IDLE][0] != frame_at[HT_PET_IDLE][20]);   // the blink
        }

        // clock_ms 0, and a sleeping or offline mood, hold idle step 0 whatever the state says.
        ht_character_face_t held[3] = {
            {.recipient = "x", .engine = eng, .activity = "Working", .elapsed = 5, .asking = true,
             .mood = HT_CHARACTER_WORKING, .clock_ms = 0},
            {.recipient = "x", .engine = eng, .activity = "", .mood = HT_CHARACTER_ASLEEP, .clock_ms = 5000},
            {.recipient = "x", .engine = eng, .activity = "", .mood = HT_CHARACTER_OFFLINE, .clock_ms = 5000},
        };
        for (int k = 0; k < 3; k++) {
            held[k].status = ""; held[k].hint = ""; held[k].detail = "";
            ht_scene_t scene; ht_scene_clear(&scene, 0);
            ht_character_face(&scene, &c, &held[k], 0xffff, "");
            assert(scene.count == 1 + 1 + 1 + 4 + 1 + 2 + 1);
            assert(pet_frame(pet, &scene.runs[1].sprite) == pet->loops[HT_PET_IDLE][0].frame);
            assert(!ht_focus_pet_next_ms(&held[k], ""));
        }

        // An engine without a pet keeps its own mark, in any state, and has no pet clock.
        ht_character_face_t other = {.recipient = "x", .engine = "cursor", .activity = "Working",
            .elapsed = 5, .status = "", .hint = "", .detail = "", .mood = HT_CHARACTER_WORKING,
            .clock_ms = 4321};
        ht_scene_t scene; ht_scene_clear(&scene, 0);
        ht_character_face(&scene, &c, &other, 0xffff, "");
        assert(scene.runs[1].sprite.pixels == ht_icon_engine56[2].px && scene.runs[1].sprite.width == 56);
        assert(!ht_focus_pet_next_ms(&other, ""));

        // The time the face next changes: a later clock, where the drawn frame or hop really differs,
        // and nothing differs one ms before it.
        ht_character_face_t w = {.recipient = "x", .engine = eng, .activity = "Working",
            .status = "", .hint = "", .detail = "", .elapsed = 5, .mood = HT_CHARACTER_WORKING};
        for (unsigned k = 0; k < 40; k++) {
            w.clock_ms = k * 90 + 1;
            uint32_t next = ht_focus_pet_next_ms(&w, "");
            assert(next > w.clock_ms);
            ht_character_face_t at = w, before = w;
            at.clock_ms = next; before.clock_ms = next - 1;
            ht_scene_t sa, sb, sw; ht_scene_clear(&sa, 0); ht_scene_clear(&sb, 0); ht_scene_clear(&sw, 0);
            ht_character_face(&sa, &c, &at, 0xffff, "");
            ht_character_face(&sb, &c, &before, 0xffff, "");
            ht_character_face(&sw, &c, &w, 0xffff, "");
            // The pet's run, and the scene's props in run 3 (Claude's pan and food move while the body holds a pose).
            #define SAME_SPRITES(p_, q_) ({ bool e_ = true; for (int r_ = 1; r_ <= 3; r_ += 2) \
                e_ &= (p_).runs[r_].sprite.pixels == (q_).runs[r_].sprite.pixels && (p_).runs[r_].sprite.cells == (q_).runs[r_].sprite.cells && \
                      (p_).runs[r_].x == (q_).runs[r_].x && (p_).runs[r_].y == (q_).runs[r_].y; e_; })
            assert(!SAME_SPRITES(sa, sb));
            assert(SAME_SPRITES(sb, sw));
            #undef SAME_SPRITES
        }
        w.clock_ms = 1; w.mood = HT_CHARACTER_IDLE; w.activity = "";
        assert(ht_focus_pet_next_ms(&w, "") > 1);
        // On the voice screen it is the sending scene's schedule (Claude's) or nothing, not the pet's.
        w.voice = true;
        {   // the next frame change from step 0 (equal frames are skipped), or nothing without a scene
            const ht_pet_scene_t *sn = pet_of(eng)->sending_scene;
            uint32_t want = 0;
            for (unsigned i = 1; sn && i <= sn->steps && !want; i++) {
                const ht_pet_overlay_t *o = sn->overlay;   // the frame, or the overlay's frame or place
                unsigned j = i % sn->steps;
                if (sn->loop[j] != sn->loop[0] || (sn->step_dy && sn->step_dy[j] != sn->step_dy[0]) ||
                    (o && (o->loop[j] != o->loop[0] || o->at[j][0] != o->at[0][0] || o->at[j][1] != o->at[0][1])))
                    want = i * sn->step_ms;
            }
            assert(ht_focus_pet_next_ms(&w, "") == want);
        }
        w.voice = false;
        w.clock_ms = 0; assert(!ht_focus_pet_next_ms(&w, ""));
    }

    /*
     * THE SCENES (Claude and Codex; Codex's own checks follow). Working: the cooking Clawd is the one large run, centred, the status
     * goes to the lower arc in green and the centred status is empty; the other states keep the run
     * count. An engine without scenes (Cursor) still draws its mark and the centred green line.
     */
    {
        const ht_pet_t *cp = pet_of("claude");
        assert(cp && cp->working_scene && cp->listening_scene && cp->sending_scene);
        const ht_pet_t *xp = pet_of("codex");
        assert(xp && xp->working_scene && xp->listening_scene && xp->sending_scene && !pet_of("cursor"));
        const ht_pet_scene_t *ws = cp->working_scene;
        assert(ws->w == 117 && ws->h == 117 && ws->steps == 26 && ws->step_ms == 55 && ws->overlay && ws->step_dy);
        int frames_seen[26], distinct = 0;
        for (unsigned step = 0; step < ws->steps; step++) {
            ht_character_face_t f = {.recipient = "Payments refactor", .engine = "claude",
                .activity = "Coalescing", .elapsed = 34, .status = "", .hint = "", .detail = "",
                .mood = HT_CHARACTER_WORKING, .foreground = 0xffff, .dim = 0x8410, .ink = 0xffff,
                .clock_ms = step * ws->step_ms + 1};
            ht_scene_t scene; ht_scene_clear(&scene, 0);
            ht_character_face(&scene, &c, &f, 0xffff, "");
            assert(scene.count == 11);
            int big = 0, small = 0;
            for (int i = 0; i < scene.count; i++) {
                if (scene.runs[i].sprite.width == ws->w && scene.runs[i].sprite.height == ws->h) {
                    big++; assert(scene.runs[i].x == (466 - ws->w) / 2 + ws->dx);
                }
                if (scene.runs[i].sprite.width == cp->w || scene.runs[i].sprite.width == 56) small++;
            }
            assert(big == 1 && !small);
            assert(scene_frame(ws, scene.runs[1].sprite.cells, 1) == ws->loop[step]);
            assert(!scene.runs[7].text[0] && scene.runs[3].sprite.cells);   // the props (pan, food) in run 3
            assert(scene.runs[10].arc == 2 && scene.runs[10].fg == ht_rgb(0x00ff2f) &&
                   !strcmp(scene.runs[10].text, "Coalescing\xe2\x80\xa6 34s") &&
                   scene.runs[10].font == &ht_lv_inter_med_26.base);
            bool fresh = true;
            for (int k = 0; k < distinct; k++) fresh &= frames_seen[k] != ws->loop[step];
            if (fresh) frames_seen[distinct++] = ws->loop[step];
            ht_raster(&scene, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, full);
            for (int y = 0; y < HT_HEIGHT; y++) for (int x = 0; x < HT_WIDTH; x++)
                if (full[y * HT_WIDTH + x])
                    assert((x - 233) * (x - 233) + (y - 233) * (y - 233) < 230 * 230);
            // It is scheduled: the next change is the next step's boundary.
            // (the pan's still steps draw the same, so it skips those)
            unsigned nx = step + 1;
            const ht_pet_overlay_t *o = ws->overlay;
            for (; nx < step + ws->steps; nx++) {
                unsigned a = nx % ws->steps;
                if (ws->loop[a] != ws->loop[step] || ws->step_dy[a] != ws->step_dy[step] || o->loop[a] != o->loop[step] ||
                    o->at[a][0] != o->at[step][0] || o->at[a][1] != o->at[step][1]) break;
            }
            assert(ht_focus_pet_next_ms(&f, "") == nx * ws->step_ms);
        }
        assert(distinct == 2);   // two body poses (eyes open, ^ ^ on the flick); a bob moves them
        // "Try again" (a status of its own, after a failed voice turn): the mark as over a one-line recap — 2x, Claude
        // 1.5x — its ink centred between the name and the line (owner, 2026-10-06, 2026-10-07).
        for (unsigned pe = 0; pe < ht_pet_count; pe++) {
            const ht_pet_t *pt = &ht_pets[pe];
            ht_character_face_t g = {.recipient = "x", .engine = pt->engine, .activity = "", .status = "Try again",
                .hint = "", .detail = "", .mood = HT_CHARACTER_IDLE, .clock_ms = 0};
            ht_scene_t sc; ht_scene_clear(&sc, 0); ht_character_face(&sc, &c, &g, 0xffff, "");
            const ht_run_t *m = &sc.runs[1];
            bool claude = !strcmp(pt->engine, "claude");
            const ht_cell_frame_t *fr0 = &pt->cells[pt->loops[HT_PET_IDLE][0].frame];
            int h = (fr0->rows * fr0->cell * (claude ? 6 : 8) + 7) / 8;
            assert(m->sprite.cells == fr0->cells && m->sprite.height == h && m->sprite.zoom == (claude ? 6 : 0));
            int d = pet_gaps(&sc, m);
            assert(d >= -3 && d <= 3);
        }
        // Codex over a four-line recap is 1.25x, not 1x (owner, 2026-10-06: "it looks tiny"; 1.5x "a bit big"), between
        // the name and the recap's first line; Muse stays 1x there.
        for (int e = 0; e < 2; e++) {
            const char *eng_ = e ? "muse" : "codex";
            ht_character_face_t g = {.recipient = "x", .engine = eng_, .activity = "", .status = "", .hint = "",
                .detail = "", .mood = HT_CHARACTER_DONE, .clock_ms = 0};
            ht_scene_t sc; ht_scene_clear(&sc, 0);
            ht_character_face(&sc, &c, &g, 0xffff, "Flashed 0.0.91 to both dials and verified the image on each. All 44 "
                              "host checks pass, including the new reader tests. Nothing is committed yet; say commit.");
            int lines = 0;
            for (int i = 3; i < 7; i++) lines += sc.runs[i].text[0] != 0;
            const ht_run_t *m = &sc.runs[1];
            assert(lines == 4 && m->sprite.cells && m->sprite.zoom == (e ? 4 : 5));
            assert(m->y >= 44 && m->y + m->sprite.height <= sc.runs[3].y + ht_lv_inter_30.ascent - 22);
        }
        // No pane's engine (no pet, no mark: design 2026-10-06 "No pane"): the resting line alone, its one or two lines
        // 50 px apart and centred on the glass, each baseline where a browser puts Inter 36's.
        for (int k = 0; k < 6; k++) {
            ht_character_face_t g = {.recipient = "Deploy latest firmware", .engine = "", .activity = "", .status = "",
                .hint = "", .detail = "", .mood = HT_CHARACTER_IDLE, .clock_ms = (uint32_t)k * 977 + 1};
            ht_scene_t sc; ht_scene_clear(&sc, 0); ht_character_face(&sc, &c, &g, 0xffff, "");
            int n = 0, base[2];
            for (int i = 0; i < sc.count; i++)
                if (sc.runs[i].font == &ht_lv_inter_36.base && sc.runs[i].text[0] && n < 2)
                    base[n++] = sc.runs[i].y + ht_lv_inter_36.ascent;
            assert(n >= 1 && !sc.runs[1].sprite.cells);
            for (int i = 0; i < n; i++) assert(base[i] == 233 - n * 25 + 25 + 36 * 93 / 256 + i * 50);
        }
        // Every engine's working mascot (the scene's frames, props apart) is centred on the glass (design 2026-10-06).
        for (unsigned pe = 0; pe < ht_pet_count; pe++) {
            const ht_pet_scene_t *w = ht_pets[pe].working_scene;
            if (!w) continue;
            ht_character_face_t g = {.recipient = "x", .engine = ht_pets[pe].engine, .activity = "Coalescing", .elapsed = 3,
                .status = "", .hint = "", .detail = "", .mood = HT_CHARACTER_WORKING, .clock_ms = 1};
            ht_scene_t sc; ht_scene_clear(&sc, 0); ht_character_face(&sc, &c, &g, 0xffff, "");
            const ht_run_t *m = &sc.runs[1];
            assert(m->sprite.width == w->w && abs(m->x + w->w / 2 - 233) <= 1 &&
                   abs(m->y - (w->step_dy ? w->step_dy[0] : 0) + w->h / 2 - 233) <= 1);
        }
        // The other states and the recap keep the small pet, the centred line and no lower arc.
        ht_character_face_t g = {.recipient = "x", .engine = "claude", .activity = "Coalescing", .elapsed = 34,
            .status = "", .hint = "", .detail = "", .mood = HT_CHARACTER_WORKING, .clock_ms = 500};
        ht_scene_t scene; ht_scene_clear(&scene, 0);
        ht_character_face(&scene, &c, &g, 0xffff, "Done.");
        // (over a one-line recap, Claude's 1.5x drawing)
        assert(scene.count == 11 && scene.runs[1].sprite.width == (cp->cells[0].cols * cp->cells[0].cell * 6 + 7) / 8 &&
               !scene.runs[10].text[0]);
        g.asking = true; ht_scene_clear(&scene, 0); ht_character_face(&scene, &c, &g, 0xffff, "");
        assert(scene.count == 11 && scene.runs[1].sprite.width == cp->w && scene.runs[7].text[0] && !scene.runs[10].text[0]);

        // An engine without scenes working: its mark, the centred inter_30 green line, nothing on the lower arc.
        ht_character_face_t x = {.recipient = "x", .engine = "cursor", .activity = "Coalescing", .elapsed = 34,
            .status = "", .hint = "", .detail = "", .mood = HT_CHARACTER_WORKING, .clock_ms = 500,
            .foreground = 0xffff, .dim = 0x8410, .ink = 0xffff};
        ht_scene_clear(&scene, 0); ht_character_face(&scene, &c, &x, 0xffff, "");
        assert(scene.count == 11 && scene.runs[1].sprite.width == 56);
        assert(scene.runs[7].font == &ht_lv_inter_30.base && scene.runs[7].fg == ht_rgb(0x00ff2f) &&
               scene.runs[7].y == 233 - ht_lv_inter_30.base.height / 2 &&
               !strcmp(scene.runs[7].text, "Coalescing\xe2\x80\xa6 34s"));
        assert(!scene.runs[10].text[0] && !scene.runs[10].arc);

        // Listening: Claude draws a scene frame, no bars; an engine without one draws its seven bars.
        const ht_pet_scene_t *ls = cp->listening_scene;
        assert(ls->w == 161 && ls->h == 123 && ls->steps == 56 && ls->step_ms == 60 && ls->waves && ls->step_dy);
        const uint8_t *shown[HT_PET_SCENE_LEVELS][56];
        for (unsigned level = 0; level < HT_PET_SCENE_LEVELS; level++)
            for (unsigned step = 0; step < 56; step++) {
                ht_character_face_t v = {.recipient = "", .tab = "", .engine = "claude", .activity = "",
                    .status = "", .hint = "", .detail = "", .voice = true, .mood = HT_CHARACTER_LISTENING,
                    .foreground = 0xffff, .dim = 0x8410, .ink = 0xffff, .clock_ms = step * ls->step_ms + 1};
                v.pose.level = level;
                ht_scene_clear(&scene, 0); ht_character_face(&scene, &c, &v, 0xffff, ""); only_inter(&scene);
                assert(scene.count == 11);
                int icons = 0, bars = 0;
                for (int i = 0; i < scene.count; i++) {
                    if (scene.runs[i].sprite.width == ls->w) {
                        icons++; shown[level][step] = scene.runs[i].sprite.cells;
                        assert(scene.runs[i].x == (466 - ls->w) / 2 + ls->dx &&
                               scene.runs[i].y == 233 - ls->h / 2 - 6 + ls->dy + ls->step_dy[level * ls->steps + step]);
                    }
                    if (scene.runs[i].font == &ht_wave && scene.runs[i].text[0]) bars++;
                }
                assert(icons == 1 && !bars);
                assert(scene_frame(ls, shown[level][step], HT_PET_SCENE_LEVELS) == ls->loop[level * ls->steps + step]);
                ht_raster(&scene, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, full);
                for (int y = 0; y < HT_HEIGHT; y++) for (int xx = 0; xx < HT_WIDTH; xx++)
                    if (full[y * HT_WIDTH + xx])
                        assert((xx - 233) * (xx - 233) + (y - 233) * (y - 233) < 230 * 230);
            }
        // One stored pose: the nod is the step's offset, and it moves.
        bool moved = false;
        for (unsigned step = 0; step < ls->steps; step++) {
            assert(shown[0][step] == shown[0][0] && shown[4][step] == shown[0][0]);
            moved |= ls->step_dy[step] != ls->step_dy[0];
        }
        assert(moved);
        ht_character_face_t sending = {.recipient = "", .tab = "", .engine = "claude", .activity = "", .status = "",
            .hint = "", .detail = "", .voice = true, .mood = HT_CHARACTER_WORKING, .clock_ms = 1,
            .foreground = 0xffff, .dim = 0x8410, .ink = 0xffff};
        ht_scene_clear(&scene, 0); ht_character_face(&scene, &c, &sending, 0xffff, "");
        assert(scene.count == 11);
        for (int i = 0; i < scene.count; i++) assert(scene.runs[i].sprite.width != ls->w);   // the sending scene, not this one
        // Sending: Claude draws the post box scene, centred, with no sparkle runs; the frame follows the clock.
        {
            const ht_pet_scene_t *ss = cp->sending_scene;
            assert(ss && ss->w == 192 && ss->h == 109 && ss->steps == 40 && ss->step_ms == 60 && ss->overlay);
            const uint8_t *seen[40];
            for (unsigned step = 0; step < ss->steps; step++) {
                ht_character_face_t v = sending; v.clock_ms = step * ss->step_ms + 1;
                ht_scene_clear(&scene, 0); ht_character_face(&scene, &c, &v, 0xffff, ""); only_inter(&scene);
                assert(scene.count == 11);
                int icons = 0, sparks = 0;
                for (int i = 0; i < scene.count; i++) {
                    if (scene.runs[i].sprite.width == ss->w && scene.runs[i].sprite.height == ss->h && scene.runs[i].sprite.cells) {
                        icons++; seen[step] = scene.runs[i].sprite.cells;
                        assert(scene.runs[i].x == (466 - ss->w) / 2 + ss->dx &&
                               scene.runs[i].y == 233 - ss->h / 2 + ss->dy + ss->step_dy[step]);
                        assert(scene.runs[i].sprite.cells == ss->frames[ss->loop[step]].cells);
                    }
                    sparks += scene.runs[i].font == &ht_spark && scene.runs[i].text[0];
                }
                assert(icons == 1 && !sparks);
                ht_raster(&scene, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, full);
                int ink = 0;
                for (int y = 0; y < HT_HEIGHT; y++) for (int xx = 0; xx < HT_WIDTH; xx++)
                    if (full[y * HT_WIDTH + xx]) {
                        ink++;
                        assert((xx - 233) * (xx - 233) + (y - 233) * (y - 233) < 230 * 230);
                    }
                assert(ink > 0);
            }
            int poses = 0;
            for (unsigned a = 0; a < ss->steps; a++) {
                bool fresh = true;
                for (unsigned b = 0; b < a; b++) fresh &= seen[b] != seen[a];
                poses += fresh;
            }
            assert(poses == 4);   // eyes open, and ^ ^ with an arm up at three hop heights; the letter and flag are props
            // A held clock (quiet, asleep) draws no scene: the sparkles.
            ht_character_face_t h = sending; h.clock_ms = 0;
            ht_scene_clear(&scene, 0); ht_character_face(&scene, &c, &h, 0xffff, "");
            int sparks = 0;
            for (int i = 0; i < scene.count; i++) {
                assert(scene.runs[i].sprite.width != ss->w);
                sparks += scene.runs[i].font == &ht_spark && scene.runs[i].text[0];
            }
            assert(scene.count == 11 && sparks == 3);
        }
        // An engine without scenes and an empty engine, sending: still the three sparkles.
        for (int e = 0; e < 2; e++) {
            ht_character_face_t v = sending; v.engine = e ? "" : "cursor";
            ht_scene_clear(&scene, 0); ht_character_face(&scene, &c, &v, 0xffff, ""); only_inter(&scene);
            int sparks = 0;
            for (int i = 0; i < scene.count; i++) sparks += scene.runs[i].font == &ht_spark && scene.runs[i].text[0];
            assert(scene.count == 11 && sparks == 3);
        }
        ht_character_face_t cx = sending; cx.engine = "cursor"; cx.mood = HT_CHARACTER_LISTENING; cx.pose.level = 3;
        ht_scene_clear(&scene, 0); ht_character_face(&scene, &c, &cx, 0xffff, "");
        int bars = 0;
        for (int i = 0; i < scene.count; i++) bars += scene.runs[i].font == &ht_wave && scene.runs[i].text[0];
        assert(scene.count == 11 && bars == 7);
        cx.engine = "";
        ht_scene_clear(&scene, 0); ht_character_face(&scene, &c, &cx, 0xffff, "");
        bars = 0;
        for (int i = 0; i < scene.count; i++) bars += scene.runs[i].font == &ht_wave && scene.runs[i].text[0];
        assert(bars == 7);

        // Codex (the owner's robot pack): the same three scenes, listening and sending with an overlay sprite after its
        // own run (the first sparkle's slot), working with none (owner, 2026-10-07: the notice bell took its sandbox
        // bubble's place); ink inside r 230, the run count constant.
        {
            ht_character_face_t base = {.recipient = "Payments refactor", .tab = "", .engine = "codex", .activity = "Coalescing",
                .elapsed = 34, .status = "", .hint = "", .detail = "", .foreground = 0xffff, .dim = 0x8410, .ink = 0xffff};
            ht_scene_t cs_;
            static const int bias_[3] = {4, -6, 0};
            static const unsigned steps_[3] = {28, 15, 15}, ms_[3] = {120, 80, 140};
            static const int w_[3] = {166, 151, 137};
            for (int kind = 0; kind < 3; kind++) {          // 0 working, 1 listening, 2 sending
                const ht_pet_scene_t *sc = kind == 0 ? xp->working_scene : kind == 1 ? xp->listening_scene : xp->sending_scene;
                const ht_pet_overlay_t *ov = sc->overlay;
                unsigned levels = kind == 1 ? HT_PET_SCENE_LEVELS : 1;
                assert((kind == 0) == !ov && cp->working_scene->overlay && !cp->listening_scene->overlay && cp->sending_scene->overlay);
                assert(sc->steps == steps_[kind] && sc->step_ms == ms_[kind] && sc->w == w_[kind] && sc->h == 170);
                assert(sc->frames[0].cell == 1 && !sc->frames[0].palette[0] && (!ov || (ov->frames[0].cell == 1 && !ov->frames[0].palette[0])));
                const int scene_run = kind == 0 ? 1 : 7, overlay_run = kind == 0 ? 3 : kind == 1 ? 1 : 8;   // the bubble sits in the second bar slot
                for (unsigned level = 0; level < levels; level++)
                    for (unsigned step = 0; step < sc->steps; step++) {
                        ht_character_face_t v = base;
                        v.clock_ms = step * sc->step_ms + 1; v.pose.level = level;
                        if (kind == 0) v.mood = HT_CHARACTER_WORKING;
                        else { v.voice = true; v.mood = kind == 1 ? HT_CHARACTER_LISTENING : HT_CHARACTER_WORKING; }
                        ht_scene_clear(&cs_, 0); ht_character_face(&cs_, &c, &v, 0xffff, ""); only_inter(&cs_);
                        assert(cs_.count == 11);
                        unsigned i = level * sc->steps + step;
                        int ox = (466 - sc->w) / 2 + sc->dx, oy = 233 - sc->h / 2 + bias_[kind] + sc->dy;
                        const ht_run_t *sr = &cs_.runs[scene_run], *orun = &cs_.runs[overlay_run];
                        assert(sr->sprite.cells == sc->frames[sc->loop[i]].cells && sr->sprite.width == sc->w && sr->sprite.height == sc->h);
                        assert(sr->x == ox && sr->y == oy);
                        if (ov) {
                            assert(orun->sprite.cells == ov->frames[ov->loop[i]].cells);
                            assert(orun->x == ox + ov->at[i][0] && orun->y == oy + ov->at[i][1]);
                        }
                        for (int k = 0; k < cs_.count; k++) {
                            if (k != scene_run && (!ov || k != overlay_run)) assert(!cs_.runs[k].sprite.width);   // no pet, no mark
                            assert(!(cs_.runs[k].font == &ht_spark && cs_.runs[k].text[0]) && !(cs_.runs[k].font == &ht_wave && cs_.runs[k].text[0]));
                        }
                        if (kind == 0) {        // status on the lower arc, nothing centred
                            assert(!cs_.runs[7].text[0] && cs_.runs[10].arc == 2 &&
                                   !strcmp(cs_.runs[10].text, "Coalescing\xe2\x80\xa6 34s") && !cs_.runs[10].gained);
                            assert(!cs_.runs[4].text[0] && !cs_.runs[5].text[0] && !cs_.runs[6].text[0]);   // the other recap lines stay empty
                        }
                        if (kind == 1) {
                            assert(cs_.runs[0].arc == 2 && !strcmp(cs_.runs[0].text, "Listening") && cs_.runs[0].gained);
                            // three bar boxes in the sparkle slots, over the bubble (and the robot never reaches it)
                            const ht_pet_bars_t *b = sc->bars;
                            assert(b && b->w == 8 && b->radius == 3 && b->min_h == 9 && b->swing == 19 && b->period_ms == 1200);
                            for (int j = 0; j < 3; j++) {
                                const ht_run_t *br = &cs_.runs[8 + j];
                                float a = (sinf(6.2831853f * (float)(v.clock_ms % 1200) / 1200.0f + (float)j * 1.2f) + 1.0f) / 2.0f;
                                int h = (int)floorf(9.0f + 19.0f * a * (float)level / 4.0f + 0.5f);
                                assert(h >= 9 && (level || h == 9));
                                assert(br->box.h == h + 1 && br->w == 8 && br->box.radius == 3 && !br->sprite.width && !br->text[0]);
                                assert(br->box.fill == ht_rgb(j == 1 ? 0xb6f6ff : 0x74d7ff) && br->box.border == br->box.fill);
                                assert(br->x == ox + b->x[j] && br->y == oy + 31 - h / 2);
                                assert(b->x[j] == 167 + 11 * j && b->cy == 31);   // 184/195/206 and 61, from the robot's ink box
                            }
                            assert(cs_.runs[1].sprite.cells == ov->frames[0].cells && ov->loop[i] == 0);
                        }
                        ht_raster(&cs_, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, full);
                        int ink = 0;
                        for (int y = 0; y < HT_HEIGHT; y++) for (int xx = 0; xx < HT_WIDTH; xx++)
                            if (full[y * HT_WIDTH + xx]) {
                                ink++;
                                assert((xx - 233) * (xx - 233) + (y - 233) * (y - 233) < 230 * 230);
                            }
                        assert(ink > 0);
                        // next_ms: the boundary of the next step that draws a different frame or overlay (equal ones are skipped).
                        uint32_t want = 0;
                        for (unsigned q = 1; q <= sc->steps && !want; q++) {
                            unsigned j = level * sc->steps + (step + q) % sc->steps;
                            if (sc->loop[j] != sc->loop[i] || (ov && (ov->loop[j] != ov->loop[i] || ov->at[j][0] != ov->at[i][0] || ov->at[j][1] != ov->at[i][1])))
                                want = (step + q) * sc->step_ms;
                        }
                        uint32_t got = ht_focus_pet_next_ms(&v, "");
                        if (kind == 1) assert(got > v.clock_ms && got <= want);   // or the word's sweep step, if that comes first
                        else assert(want && got == want);
                    }
            }
            // The overlays move: the bars follow the level, the plane flies off.
            {
                const ht_pet_overlay_t *lo = xp->listening_scene->overlay, *so = xp->sending_scene->overlay;
                // The listening bubble is stored once (every loop entry the same frame at the same place); the bars are code.
                for (unsigned i = 0; i < 5 * 15; i++)
                    assert(lo->loop[i] == 0 && lo->at[i][0] == lo->at[0][0] && lo->at[i][1] == lo->at[0][1]);
                assert(xp->listening_scene->bars && !xp->working_scene->bars && !xp->sending_scene->bars && !cp->listening_scene->bars);
                // Heights at known clocks: level 0 is flat at 9 px; level 4 swings between 9 and 28 over 1200 ms.
                {
                    int lo_h = 99, hi_h = 0;
                    for (unsigned clock = 0; clock < 1200; clock += 10) {
                        ht_character_face_t v = base; v.voice = true; v.mood = HT_CHARACTER_LISTENING; v.clock_ms = clock;
                        for (unsigned level = 0; level < 5; level += 4) {
                            v.pose.level = level;
                            ht_scene_clear(&cs_, 0); ht_character_face(&cs_, &c, &v, 0xffff, "");
                            assert(cs_.count == 11);
                            for (int j = 0; j < 3; j++) {
                                int h = cs_.runs[8 + j].box.h - 1;
                                if (!level) assert(h == 9); else { if (h < lo_h) lo_h = h; if (h > hi_h) hi_h = h; }
                            }
                        }
                    }
                    assert(lo_h == 9 && hi_h == 28);
                    // The bars move smoothly and are scheduled: every 50 ms at level 4, no extra wake at level 0.
                    ht_character_face_t v = base; v.voice = true; v.mood = HT_CHARACTER_LISTENING; v.clock_ms = 405;
                    v.pose.level = 4;
                    uint32_t nx = ht_focus_pet_next_ms(&v, "");
                    assert(nx == 450);
                    v.pose.level = 0;
                    uint32_t n0 = ht_focus_pet_next_ms(&v, "");
                    assert(n0 > 450);          // flat bars: only the word's sweep (455) or the robot's frame (480) wakes it
                    v.pose.level = 4; v.clock_ms = 401;
                    assert(ht_focus_pet_next_ms(&v, "") <= 450);
                }
                assert(so->frames[so->loop[14]].cols == 1 && so->frames[so->loop[14]].rows == 1 && so->frames[so->loop[0]].cols > 1);
                assert(so->at[12][0] > so->at[8][0] && so->at[12][1] < so->at[8][1] && so->loop[3] != so->loop[4]);
            }
            // Sending on the voice screen redraws at the pet's next frame change, a held clock draws sparkles.
            ht_character_face_t h = base; h.voice = true; h.mood = HT_CHARACTER_WORKING; h.clock_ms = 0;
            assert(!ht_focus_pet_next_ms(&h, ""));
            ht_scene_clear(&cs_, 0); ht_character_face(&cs_, &c, &h, 0xffff, "");
            int sparks = 0;
            for (int i = 0; i < cs_.count; i++) {
                assert(!cs_.runs[i].sprite.width);
                sparks += cs_.runs[i].font == &ht_spark && cs_.runs[i].text[0];
            }
            assert(cs_.count == 11 && sparks == 3);
        }
        // Muse (Jolly, from Meta's render and clip): the small pet waves one 24-step loop in every state; working
        // (8 x 140 ms) and listening (12 x 140 ms, the same frames at every level) have no overlay, sending (13
        // body steps of 166 ms and the last held) carries the paper plane; ink inside r 230, run counts constant.
        {
            const ht_pet_t *mp = pet_of("muse");
            assert(mp && mp->working_scene && mp->listening_scene && mp->sending_scene);
            assert(mp->w > 0 && mp->w < 128 && mp->h > 0 && mp->h < 128);
            for (int st = 1; st < HT_PET_STATES; st++) {
                assert(mp->step_ms[st] == mp->step_ms[0]);
                for (int k = 0; k < HT_PET_STEPS; k++) assert(mp->loops[st][k].frame == mp->loops[0][k].frame && !mp->loops[st][k].dy);
            }
            // Two waves and the arm down and up, 18 steps (owner, 2026-10-06): the loop wraps at 18, not 24.
            assert(mp->step_ms[0] == 217 && ht_pet_steps(mp) == 18);
            {
                // (with a status line: an idle or done agent with nothing to show is the relaxing face; every
                // state plays this one loop)
                ht_character_face_t g = {.recipient = "x", .engine = "muse", .activity = "", .status = "Ready", .hint = "",
                    .detail = "", .mood = HT_CHARACTER_DONE, .clock_ms = 18 * 217 + 1};
                ht_scene_t a, b; ht_scene_clear(&a, 0); ht_scene_clear(&b, 0);
                ht_character_face(&a, &c, &g, 0xffff, "");
                g.clock_ms = 1; ht_character_face(&b, &c, &g, 0xffff, "");
                assert(a.runs[1].sprite.cells == b.runs[1].sprite.cells && a.runs[1].sprite.cells == mp->cells[mp->loops[0][0].frame].cells);
                g.clock_ms = 17 * 217 + 1;
                ht_scene_t z; ht_scene_clear(&z, 0); ht_character_face(&z, &c, &g, 0xffff, "");
                assert(z.runs[1].sprite.cells == mp->cells[mp->loops[0][17].frame].cells);
                assert(ht_focus_pet_next_ms(&g, "") == 18 * 217);   // the last step's end is the loop's start again
            }
            const ht_pet_scene_t *ms_[3] = {mp->working_scene, mp->listening_scene, mp->sending_scene};
            assert(!ms_[0]->overlay && !ms_[1]->overlay && ms_[2]->overlay);
            assert(ms_[0]->steps == 8 && ms_[0]->step_ms == 140 && ms_[1]->steps == 12 && ms_[1]->step_ms == 140);
            assert(ms_[2]->steps >= 13 && ms_[2]->step_ms == 166);
            // the sending scene holds its last step and the plane is gone there
            assert(ms_[2]->loop[ms_[2]->steps - 1] == ms_[2]->loop[ms_[2]->steps - 2]);
            assert(ms_[2]->overlay->frames[ms_[2]->overlay->loop[ms_[2]->steps - 1]].cols == 1);
            assert(ms_[2]->overlay->frames[ms_[2]->overlay->loop[0]].cols > 1);
            static const int mbias_[3] = {4, -6, 0};
            ht_character_face_t mbase = {.recipient = "Payments refactor", .tab = "", .engine = "muse", .activity = "Coalescing",
                .elapsed = 34, .status = "", .hint = "", .detail = "", .foreground = 0xffff, .dim = 0x8410, .ink = 0xffff};
            ht_scene_t ms;
            for (int kind = 0; kind < 3; kind++) {
                const ht_pet_scene_t *sc = ms_[kind];
                assert(sc->frames[0].cell == 1 && !sc->frames[0].palette[0]);
                unsigned levels = kind == 1 ? HT_PET_SCENE_LEVELS : 1;
                const int scene_run = kind == 0 ? 1 : 7;
                for (unsigned level = 0; level < levels; level++)
                    for (unsigned step = 0; step < sc->steps; step++) {
                        ht_character_face_t v = mbase;
                        v.clock_ms = step * sc->step_ms + 1; v.pose.level = level;
                        if (kind == 0) v.mood = HT_CHARACTER_WORKING;
                        else { v.voice = true; v.mood = kind == 1 ? HT_CHARACTER_LISTENING : HT_CHARACTER_WORKING; }
                        ht_scene_clear(&ms, 0); ht_character_face(&ms, &c, &v, 0xffff, ""); only_inter(&ms);
                        assert(ms.count == 11);
                        unsigned i = level * sc->steps + step;
                        const ht_run_t *sr = &ms.runs[scene_run];
                        assert(sr->sprite.cells == sc->frames[sc->loop[i]].cells && sr->sprite.width == sc->w);
                        assert(sr->x == (466 - sc->w) / 2 + sc->dx && sr->y == 233 - sc->h / 2 + mbias_[kind] + sc->dy);
                        ht_raster(&ms, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, full);
                        int ink = 0;
                        for (int y = 0; y < HT_HEIGHT; y++) for (int xx = 0; xx < HT_WIDTH; xx++)
                            if (full[y * HT_WIDTH + xx]) {
                                ink++;
                                assert((xx - 233) * (xx - 233) + (y - 233) * (y - 233) < 230 * 230);
                            }
                        assert(ink > 0);
                    }
            }
            // THE WAVES (L2): the sound waves are not in the frames but drawn by the dial: six ring arcs in runs 1-6
            // (right side 1-3, left side 4-6), before the scene's run 7; hidden ones are empty rings, never skipped.
            {
                const ht_pet_scene_t *ls = ms_[1];
                const ht_pet_waves_t *wv = ls->waves;
                assert(wv && !ms_[0]->waves && !ms_[2]->waves && cp->listening_scene->waves && !xp->listening_scene->waves);
                assert(wv->count == 3 && wv->half_deg == 24 && wv->w16 == 48 && wv->period_ms == 1680);
                assert(wv->r_far16 == 1128 && wv->r_near16 == 762 && wv->rgb[0] == 214 && wv->rgb[1] == 208 && wv->rgb[2] == 255);
                // Poses that mirror each other are one stored frame; 8 distinct pictures in the 12 steps.
                bool seen[12] = {false};
                int distinct = 0;
                for (unsigned t = 0; t < 12; t++) {
                    if (!seen[ls->loop[t]]) { seen[ls->loop[t]] = true; distinct++; }
                }
                assert(distinct == 8);
                // The pose swings 0 .. 3 .. 6 and back (9): the mirror pairs 1/5, 2/4, 7/11, 8/10 share a frame (the extremes 0, 3, 6, 9 are alone).
                assert(ls->loop[1] == ls->loop[5] && ls->loop[2] == ls->loop[4] && ls->loop[7] == ls->loop[11] && ls->loop[8] == ls->loop[10]);
                static const uint32_t clocks[] = {0, 140, 280, 420, 560, 700, 840, 1000, 1400, 1679, 1680, 3333, 100001};
                int shown = 0, hidden = 0;
                for (unsigned level = 0; level < HT_PET_SCENE_LEVELS; level++)
                    for (unsigned q = 0; q < sizeof clocks / sizeof clocks[0]; q++) {
                        ht_character_face_t v = mbase;
                        v.voice = true; v.mood = HT_CHARACTER_LISTENING; v.clock_ms = clocks[q]; v.pose.level = level;
                        ht_scene_clear(&ms, 0); ht_character_face(&ms, &c, &v, 0xffff, ""); only_inter(&ms);
                        assert(ms.count == 11);
                        assert(ms.runs[0].arc == 2 && !strcmp(ms.runs[0].text, "Listening"));
                        unsigned step = (clocks[q] / ls->step_ms) % ls->steps;
                        const ht_run_t *sr = &ms.runs[7];
                        assert(sr->sprite.cells == ls->frames[ls->loop[level * ls->steps + step]].cells);
                        int ox = (466 - ls->w) / 2 + ls->dx, oy = 233 - ls->h / 2 - 6 + ls->dy;
                        for (int side = 0; side < 2; side++)
                            for (int k = 0; k < 3; k++) {
                                const ht_run_t *r = &ms.runs[1 + side * 3 + k];
                                assert(r->ring.set && !r->sprite.width && !r->box.h && !r->arc && !r->text[0]);
                                float u = (float)(clocks[q] % 1680) / 1680.0f + (float)k / 3.0f;
                                if (u >= 1.0f) u -= 1.0f;
                                float a = sinf(3.14159265f * u) * (0.4f + 0.6f * (float)level / 4.0f);
                                if (!level && k == 0 && !clocks[q]) assert(a == 0.0f);   // u = 0: the arc is at the far edge, dark
                                assert(r->ring.cx16 == ox * 16 + wv->cx16 && r->ring.cy16 == oy * 16 + wv->cy16);
                                if (a < 0.12f) {
                                    hidden++;
                                    ht_rect_t b = ht_run_bounds(r);
                                    assert(!r->ring.w16 && !r->ring.colour && !b.w && !b.h);
                                    continue;
                                }
                                shown++;
                                int rad = (int)floorf(1128.0f - (1128.0f - 762.0f) * u + 0.5f);
                                assert(r->ring.r16 == rad && r->ring.w16 == 48);
                                assert(r->ring.ux == (side ? -16384 : 16384) && r->ring.uy == 0);
                                assert(r->ring.cosh == 14968);   // cos 24 degrees, Q14
                                unsigned want[3];
                                for (int i = 0; i < 3; i++) want[i] = (unsigned)floorf((float)wv->rgb[i] * a + 0.5f);
                                assert(r->ring.colour == ht_rgb(want[0] << 16 | want[1] << 8 | want[2]));
                                ht_rect_t b = ht_run_bounds(r);
                                assert(b.w > 0 && b.h > 0 && b.x >= 0 && b.y >= 0 && b.x + b.w <= HT_WIDTH && b.y + b.h <= HT_HEIGHT);
                            }
                        // Level 0 at the brightest point of an arc: 0.4 * sin(pi u), never past 0.4.
                        if (!level) for (int k = 0; k < 3; k++) {
                            const ht_run_t *r = &ms.runs[1 + k];
                            if (r->ring.w16) assert((int)((r->ring.colour >> 11) << 3) <= (int)(0.4f * 214) + 8);
                        }
                        // The ink is inside r 230, the arcs included, and the wake is every 50 ms at most while it glides.
                        ht_raster(&ms, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, full);
                        int ring_ink = 0;
                        for (int y = 0; y < HT_HEIGHT; y++) for (int xx = 0; xx < HT_WIDTH; xx++)
                            if (full[y * HT_WIDTH + xx]) {
                                ring_ink++;
                                assert((xx - 233) * (xx - 233) + (y - 233) * (y - 233) < 230 * 230);
                            }
                        assert(ring_ink > 0);
                        uint32_t nx = ht_focus_pet_next_ms(&v, "");
                        if (clocks[q]) assert(nx > clocks[q] && nx <= (clocks[q] / 50 + 1) * 50);   // clock 0 is the held face: no wake
                    }
                assert(shown > 0 && hidden > 0);
                // The arcs never touch the body: (almost) no pixel of any frame lies inside an arc's slice at r_near .. r_far.
                int touching = 0;
                for (unsigned f = 0; f < 8; f++) {
                    const ht_cell_frame_t *fr = &ls->frames[f];
                    for (int y = 0; y < fr->rows; y++) for (int xx = 0; xx < fr->cols; xx++) {
                        if (!ht_cell_at(fr, xx, y)) continue;
                        // the pixel's centre against the waves' centre, sixteenths of a px, scene coordinates
                        int dx = xx * 16 + 8 - wv->cx16, dy = wv->cy16 - (y * 16 + 8);
                        int d2 = dx * dx + dy * dy, rin = wv->r_near16 - 24, rout = wv->r_far16 + 24;
                        if (d2 < rin * rin || d2 > rout * rout) continue;
                        int ax = dx < 0 ? -dx : dx;                       // mirror: both sides are the same slice
                        // tan 24 = 0.4452: inside the slice when |dy| <= 0.4452 |dx|
                        if (dy * 1000 <= 445 * ax && -dy * 1000 <= 445 * ax) touching++;
                    }
                }
                assert(touching <= 1);   // one soft edge pixel of one frame at most
            }
            // the listening scene's loop is the same 12 frames at every level
            for (unsigned level = 1; level < HT_PET_SCENE_LEVELS; level++)
                for (unsigned step = 0; step < 12; step++) assert(ms_[1]->loop[level * 12 + step] == ms_[1]->loop[step]);
        }
        // THE LISTENING WORD (Claude and Codex): "Listening", Inter Medium 26, green, on the lower arc in the first bar's
        // slot, brightness per letter by rhythm B; 11 runs listening, sending, held and plain.
        for (int e = 0; e < 2; e++) {
            const char *eng = e ? "codex" : "claude";
            ht_character_face_t v = {.recipient = "", .tab = "", .engine = eng, .activity = "", .status = "", .hint = "",
                .detail = "", .voice = true, .mood = HT_CHARACTER_LISTENING, .foreground = 0xffff, .dim = 0x8410, .ink = 0xffff};
            for (uint32_t clock = 1; clock < 2700; clock += 13) {
                v.clock_ms = clock;
                ht_scene_clear(&scene, 0); ht_character_face(&scene, &c, &v, 0xffff, ""); only_inter(&scene);
                assert(scene.count == 11);
                int words = 0;
                for (int i = 0; i < scene.count; i++) if (scene.runs[i].arc == 2) {
                    words++;
                    const ht_run_t *r = &scene.runs[i];
                    assert(i == 0 && !strcmp(r->text, "Listening") && r->font == &ht_lv_inter_med_26.base && r->fg == ht_rgb(0x00ff2f) && r->gained);
                    // rhythm B at the 65 ms step the clock is in: dim 30 %, a band two letters wide, sweeping 900 ms, resting 400 ms.
                    unsigned t = clock % 1300 / 65 * 65;
                    for (int g = 0; g < 9; g++) {
                        double head = t < 900 ? -2 + 13.0 * t / 900 : -99, d = g - head < 0 ? head - g : g - head;
                        double want = 255 * (0.3 + 0.7 * (1 - d / 2 > 0 ? 1 - d / 2 : 0));
                        assert(r->gain[g] + 1.0 >= want && r->gain[g] - 1.0 <= want);
                    }
                    if (t == 130) assert(r->gain[0] > 230 && r->gain[8] < 90);        // the band has reached the first letter
                    if (t >= 910) for (int g = 0; g < 9; g++) assert(r->gain[g] == 76);   // at rest
                }
                assert(words == 1);
            }
            // The word moves on its own clock: every 65 ms while sweeping, then once for the rest (or the scene's own frame).
            // (Claude's scene steps every 60 ms and its arcs tick every 50: those can come first; never later.)
            v.clock_ms = 100; assert(e ? ht_focus_pet_next_ms(&v, "") == 130 : ht_focus_pet_next_ms(&v, "") > 100 && ht_focus_pet_next_ms(&v, "") <= 130);
            v.clock_ms = 1000; assert(ht_focus_pet_next_ms(&v, "") > 1000 && ht_focus_pet_next_ms(&v, "") <= 1365);   // the rest ends at 1365 at the latest
            v.clock_ms = 1; assert(e ? ht_focus_pet_next_ms(&v, "") == 65 : ht_focus_pet_next_ms(&v, "") > 1 && ht_focus_pet_next_ms(&v, "") <= 65);
            v.clock_ms = 0; assert(!ht_focus_pet_next_ms(&v, ""));
            // Eleven runs whichever voice state: sending, a held clock, an engine without scenes, none; no word outside listening.
            for (int mode = 0; mode < 4; mode++) {
                ht_character_face_t w = v;
                w.clock_ms = 700;
                if (mode == 0) w.mood = HT_CHARACTER_WORKING;
                if (mode == 1) w.clock_ms = 0;
                if (mode == 2) w.engine = "cursor";
                if (mode == 3) w.engine = "";
                ht_scene_clear(&scene, 0); ht_character_face(&scene, &c, &w, 0xffff, "");
                assert(scene.count == 11);
                for (int i = 0; i < scene.count; i++) assert(mode == 1 ? scene.runs[i].arc == (i == 0 ? 2 : 0) : !scene.runs[i].arc);
            }
        }
    }

    /*
     * THE CELL SPRITES on glass. Every frame of both scenes, rasterised through ht_cell_sprite, is the
     * independent per-pixel expansion of its cells (a transparent cell leaves the background), whole
     * and clipped to rects that cut through cells; and changing frame damages only the sprite's rect.
     */
    {
        const ht_pet_t *cp = pet_of("claude");
        const ht_pet_scene_t *scs[2] = {cp->working_scene, cp->listening_scene};
        for (int w = 0; w < 2; w++) {
            const ht_pet_scene_t *sc = scs[w];
            unsigned nf = 0;
            for (unsigned i = 0; i < sc->steps * (w ? HT_PET_SCENE_LEVELS : 1u); i++)
                if (sc->loop[i] >= nf) nf = sc->loop[i] + 1u;
            int x0 = (HT_WIDTH - sc->w) / 2, y0 = (HT_HEIGHT - sc->h) / 2;
            const ht_rect_t cuts[] = {{(int16_t)(x0 + 3), (int16_t)(y0 + 5), 61, 47},
                {(int16_t)(x0 - 10), (int16_t)(y0 + 60), 50, 150}, {(int16_t)(x0 + sc->w - 5), (int16_t)(y0 + 1), 20, 9},
                {(int16_t)(x0 + 7), (int16_t)(y0 + 7), 1, 1}};
            for (unsigned k = 0; k < nf; k++) {
                const ht_cell_frame_t *fr = &sc->frames[k];
                assert(fr->cell >= 1 && fr->cols * fr->cell == sc->w && fr->rows * fr->cell == sc->h);
                assert(!fr->palette[0]);
                ht_scene_t scene; ht_scene_clear(&scene, 0x1234);
                assert(ht_cell_sprite(&scene, x0, y0, fr) && scene.count == 1);
                assert(scene.runs[0].sprite.width == sc->w && scene.runs[0].sprite.height == sc->h);
                ht_raster(&scene, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, full);
                int inked = 0;
                for (int y = y0; y < y0 + sc->h; y++) for (int x = x0; x < x0 + sc->w; x++) {
                    unsigned idx = ht_cell_at(fr, (x - x0) / fr->cell, (y - y0) / fr->cell);
                    uint16_t want = idx ? fr->palette[idx] : 0x3412;   // the background, in panel order
                    if (full[y * HT_WIDTH + x] != want) { fprintf(stderr, "px %d,%d idx %u got %04x want %04x\n", x, y, idx, full[y * HT_WIDTH + x], want); assert(0); }
                    inked += idx != 0;
                }
                assert(inked);
                for (unsigned q = 0; q < sizeof cuts / sizeof cuts[0]; q++) {
                    ht_rect_t r = cuts[q];
                    ht_raster(&scene, r, partial);
                    for (int y = 0; y < r.h; y++) for (int x = 0; x < r.w; x++)
                        assert(partial[y * r.w + x] == full[(r.y + y) * HT_WIDTH + r.x + x]);
                }
                // The next frame repaints inside the sprite's rect and nowhere else.
                const ht_cell_frame_t *nx = &sc->frames[(k + 1) % nf];
                ht_scene_t after; ht_scene_clear(&after, 0x1234);
                ht_cell_sprite(&after, x0, y0, nx);
                ht_damage_t dmg;
                ht_damage(&scene, &after, &dmg);
                if (nx == fr) assert(!dmg.count);
                else {
                    // Banded on 2 px rows and columns: the sprite's rect plus at most 1 px of rounding.
                    assert(dmg.count >= 1 && dmg.pixels <= (uint32_t)(sc->w + 2) * (sc->h + 2));
                    for (int i = 0; i < dmg.count; i++)
                        assert(dmg.rect[i].x >= x0 - 1 && dmg.rect[i].y >= y0 - 1 &&
                               dmg.rect[i].x + dmg.rect[i].w <= x0 + sc->w + 1 && dmg.rect[i].y + dmg.rect[i].h <= y0 + sc->h + 1);
                }
            }
        }
    }

    /*
     * THE BOTTOM EDGE IS TAKEN (a footer control; the bell steps up instead): the working scene stays, its status is a
     * straight centred inter_30 line at y 334 in the same slot (the run count never moves) and the
     * lower arc is the empty placeholder. Long verbs keep their seconds, on the arc and on the line.
     */
    {
        const ht_pet_t *cp = pet_of("claude");
        ht_character_face_t f = {.recipient = "x", .engine = "claude", .activity = "Coalescing", .elapsed = 34,
            .status = "", .hint = "", .detail = "", .mood = HT_CHARACTER_WORKING, .clock_ms = 500,
            .foreground = 0xffff, .dim = 0x8410, .ink = 0xffff};
        ht_scene_t scene;
        {
            f.footer_action = true;
            ht_scene_clear(&scene, 0); ht_character_face(&scene, &c, &f, 0xffff, "");
            assert(scene.count == 11 && scene.runs[1].sprite.width == cp->working_scene->w);
            const ht_run_t *line = &scene.runs[7];
            assert(!line->arc && line->font == &ht_lv_inter_30.base && line->y == 334 &&
                   line->fg == ht_rgb(0x00ff2f) && !strcmp(line->text, "Coalescing\xe2\x80\xa6 34s"));
            assert(line->x + line->w / 2 >= 232 && line->x + line->w / 2 <= 234);
            assert(!scene.runs[10].text[0] && !scene.runs[10].arc);
            for (int i = 0; i < scene.count; i++) assert(scene.runs[i].arc != 2);
        }
        // Not taken: the arc, no straight line. Both fit a long verb with its seconds.
        f.footer_action = false; f.activity = "Running firmware checks";
        ht_scene_clear(&scene, 0); ht_character_face(&scene, &c, &f, 0xffff, "");
        size_t n = strlen(scene.runs[10].text);
        assert(scene.runs[10].arc == 2 && n >= 3 && !strcmp(scene.runs[10].text + n - 3, "34s") && ht_arc_measure(&ht_arc_inter_lower, scene.runs[10].text) <= HT_ARC_SPAN);
        assert(strstr(scene.runs[10].text, "Running firmw") && !scene.runs[7].text[0]);
        f.elapsed = 65;
        ht_scene_clear(&scene, 0); ht_character_face(&scene, &c, &f, 0xffff, "");
        n = strlen(scene.runs[10].text);
        assert(!strcmp(scene.runs[10].text + n - 6, "1m 05s") && ht_arc_measure(&ht_arc_inter_lower, scene.runs[10].text) <= HT_ARC_SPAN);
        f.elapsed = 34; f.activity = "Reconciling the payment ledger migration plan"; f.footer_action = true;
        ht_scene_clear(&scene, 0); ht_character_face(&scene, &c, &f, 0xffff, "");
        n = strlen(scene.runs[7].text);
        assert(!strcmp(scene.runs[7].text + n - 3, "34s") && scene.runs[7].w <= 384 && scene.runs[7].w > 300);
        assert(scene.runs[7].x >= 41 && scene.runs[7].x + scene.runs[7].w <= 41 + 384);
    }

    // The listening scene is scheduled like the working one: the next step boundary (or sweep step) while recording
    // (level 0..4 read at the moment), nothing held, or on an engine without one; sending has its own below.
    {
        const ht_pet_scene_t *ls = pet_of("claude")->listening_scene;
        for (unsigned level = 0; level < HT_PET_SCENE_LEVELS + 2; level++)
            for (unsigned step = 0; step < ls->steps; step++) {
                ht_character_face_t v = {.recipient = "", .tab = "", .engine = "claude", .activity = "", .status = "",
                    .hint = "", .detail = "", .voice = true, .mood = HT_CHARACTER_LISTENING,
                    .clock_ms = step * ls->step_ms + 1};
                v.pose.level = level;
                // The scene's next step, the word's next sweep step (a multiple of 65 ms) or the arcs' next tick (50 ms),
                // whichever comes first.
                uint32_t next = ht_focus_pet_next_ms(&v, "");
                assert(next > v.clock_ms && next <= (step + 1) * ls->step_ms &&
                       (next == (step + 1) * ls->step_ms || next % 65 == 0 || next % 50 == 0));
            }
        ht_character_face_t v = {.recipient = "", .tab = "", .engine = "claude", .activity = "", .status = "",
            .hint = "", .detail = "", .voice = true, .mood = HT_CHARACTER_LISTENING, .clock_ms = 1};
        v.clock_ms = 0; assert(!ht_focus_pet_next_ms(&v, ""));
        // Sending: the next frame change of the post box scene; held or without a scene, nothing.
        const ht_pet_scene_t *ss = pet_of("claude")->sending_scene;
        v.mood = HT_CHARACTER_WORKING;
        for (unsigned step = 0; step < ss->steps; step++) {
            v.clock_ms = step * ss->step_ms + 1;
            uint32_t want = 0;
            for (unsigned i = 1; i <= ss->steps && !want; i++) {
                unsigned a = (step + i) % ss->steps;   // a different pose, offset, props sprite or place
                const ht_pet_overlay_t *o = ss->overlay;
                if (ss->loop[a] != ss->loop[step] || (ss->step_dy && ss->step_dy[a] != ss->step_dy[step]) ||
                    (o && (o->loop[a] != o->loop[step] || o->at[a][0] != o->at[step][0] || o->at[a][1] != o->at[step][1])))
                    want = (step + i) * ss->step_ms;
            }
            assert(want && ht_focus_pet_next_ms(&v, "") == want);
        }
        v.clock_ms = 0; assert(!ht_focus_pet_next_ms(&v, ""));
        v.clock_ms = 1; v.engine = "cursor"; assert(!ht_focus_pet_next_ms(&v, ""));
        v.engine = ""; assert(!ht_focus_pet_next_ms(&v, ""));
        v.engine = "claude";
        v.mood = HT_CHARACTER_LISTENING; v.engine = "cursor"; assert(!ht_focus_pet_next_ms(&v, ""));
        v.engine = ""; assert(!ht_focus_pet_next_ms(&v, ""));
        // Frames and levels come from one count.
        assert(HT_PET_SCENE_LEVELS == 5);
    }

    // Stated as its parts rather than as a number: the curved name, the mark, the card, the recap
    // (four lines), the live status, the resting line (two lines) and the lower-arc status (the
    // working scene's). Each is emitted empty when it has nothing to say.
    assert(expected == 1 + 1 + 1 + 4 + 1 + 2 + 1);
}

/*
 * THE RELAXING FACE (owner, 2026-10-09: mockup/relaxing.html). Claude, Codex and Muse with nothing to show play their
 * relaxing scene in the mark's run, placed as a working scene is; nothing in the middle (the recap slots, the status
 * and the two resting lines empty; Codex's plane the overlay in run 3); one line on the lower arc in quiet grey,
 * Inter Medium 26, from the new list, held while the face stays up; the balls (Claude's three, Muse's beach ball) are ring arcs
 * after the eleven runs, as many on every step. The incremental redraw from step to step is exact, the ink stays inside
 * r 230, and the schedule wakes on each step that draws differently. Every other engine keeps today's resting face.
 */
static void ink_inside_r230(const ht_scene_t *scene);
static void focus_relaxing(void)
{
    ht_character_t c = {0};
    assert(ht_character_select(&c, HT_CHARACTER_FOCUS));
    static const char *const lines[] = {"Tap to talk", "Hold for tabs", "Tap name for panes", "What's next?",
                                        "Your move", "Say the word", "Ask away"};
    static const struct { const char *engine; unsigned shapes, step_ms; bool overlay; } want[] = {
        {"claude", 6, 55, false}, {"codex", 0, 120, true}, {"muse", 8, 100, false}};
    for (unsigned e = 0; e < 3; e++) {
        const ht_pet_t *pet = pet_of(want[e].engine);
        const ht_pet_scene_t *rs = pet->relaxing_scene;
        assert(rs && rs->steps == 24 && rs->step_ms == want[e].step_ms && !rs->overlay == !want[e].overlay);
        assert(want[e].shapes ? rs->shapes && rs->shapes->count == want[e].shapes : !rs->shapes);
        ht_scene_t prev; ht_scene_clear(&prev, 0);
        const char *held = NULL;
        unsigned arcs_ink = 0;
        bool moved = false;
        int ball_at[24] = {0};
        for (unsigned step = 0; step < 2 * rs->steps; step++) {
            ht_character_face_t f = {.recipient = "Payments refactor", .engine = want[e].engine, .activity = "",
                .status = "", .hint = "", .detail = "", .mood = HT_CHARACTER_IDLE, .foreground = 0xffff, .dim = 0x8410,
                .ink = 0xffff, .clock_ms = 5000 + step * rs->step_ms};
            unsigned st = f.clock_ms / rs->step_ms % rs->steps;
            ht_scene_t scene; ht_scene_clear(&scene, 0);
            ht_character_face(&scene, &c, &f, 0xffff, "");
            only_inter(&scene);
            assert(scene.count == 11 + (int)want[e].shapes);   // the same runs on every step of it
            assert(scene.runs[0].arc == 1 && !strcmp(scene.runs[0].text, "Payments refactor"));
            const ht_run_t *m = &scene.runs[1];
            assert(m->sprite.cells == rs->frames[rs->loop[st]].cells && !m->sprite.zoom);
            assert(m->x == (466 - rs->w) / 2 + rs->dx && m->y == 233 + 4 - rs->h / 2 + rs->dy + (rs->step_dy ? rs->step_dy[st] : 0));
            assert(!scene.runs[2].box.h || scene.runs[2].box.fill == scene.runs[2].box.border);   // no card
            for (int i = 3; i < 10; i++) {
                assert(!scene.runs[i].text[0]);                               // no text in the middle
                if (i == 3 && rs->overlay) assert(scene.runs[i].sprite.cells == rs->overlay->frames[rs->overlay->loop[st]].cells);
                else assert(!scene.runs[i].sprite.width);
            }
            const ht_run_t *arc = &scene.runs[10];
            assert(arc->arc == 2 && arc->fg == ht_rgb(0x9a9aa6) && arc->font == &ht_lv_inter_med_26.base);
            bool listed = false;
            for (unsigned k = 0; k < 7; k++) listed |= !strcmp(arc->text, lines[k]);
            assert(listed && ht_arc_measure(&ht_arc_inter_lower, arc->text) <= HT_ARC_SPAN);
            if (!held) held = arc->text; else assert(!strcmp(held, arc->text));   // held while the face stays up
            for (unsigned k = 0; k < want[e].shapes; k++) {
                const ht_run_t *r = &scene.runs[11 + k];
                const ht_pet_shape_t *at = &rs->shapes->at[st * rs->shapes->count + k];
                assert(r->ring.set);
                // placed from the scene's origin (the frame's step_dy moves the frame alone), as the step lists it
                assert(r->ring.cx16 == ((466 - rs->w) / 2 + rs->dx) * 16 + at->cx16);
                assert(r->ring.cy16 == (233 + 4 - rs->h / 2 + rs->dy) * 16 + at->cy16);
                assert(r->ring.r16 == at->r16 && r->ring.w16 == at->w16 && r->ring.colour == at->rgb);
                if (r->ring.w16) arcs_ink += (unsigned)(r->ink_box.w * r->ink_box.h);
            }
            if (e == 2) {
                // Muse's keepy-uppy (mockup/muse-play.html D): the beach ball is six 60-degree wedges round one
                // centre, reaching it, then the white centre disc on it and the highlight up and left of it.
                const ht_run_t *b0 = &scene.runs[11];
                for (unsigned k = 0; k < 8; k++) {
                    const ht_run_t *r = &scene.runs[11 + k];
                    assert(r->ring.w16);
                    if (k < 7) assert(r->ring.cx16 == b0->ring.cx16 && r->ring.cy16 == b0->ring.cy16);
                    if (k < 6) assert(r->ring.w16 >= 2 * r->ring.r16);              // a wedge: the band reaches the centre
                }
                assert(scene.runs[18].ring.cx16 < b0->ring.cx16 && scene.runs[18].ring.cy16 < b0->ring.cy16);
                // It meets the ball on steps 0 and 12 (a squash, the ball low on its head), hops on 1 and 13, the ball
                // highest halfway between; the ball always above the body's top.
                int ball_y = b0->ring.cy16 / 16, top = m->y;
                assert(ball_y < top + 12);
                if (st % 12 == 1) assert(rs->step_dy && rs->step_dy[st] < 0);
                else assert(!rs->step_dy || !rs->step_dy[st]);
                ball_at[st] = ball_y;
            }
            ink_inside_r230(&scene);
            if (!step) ht_raster(&scene, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, partial);   // what the glass holds
            else {
                redraw(&prev, &scene);                                       // the damage from the step before is exact
                moved |= memcmp(&prev.runs[1], &scene.runs[1], sizeof scene.runs[1]) != 0;
            }
            // Its schedule: the next step that draws differently, and nothing changes a ms before it.
            uint32_t next = ht_focus_pet_next_ms(&f, "");
            assert(next > f.clock_ms && next <= f.clock_ms + rs->steps * rs->step_ms);
            ht_character_face_t a = f, b = f; a.clock_ms = next; b.clock_ms = next - 1;
            ht_scene_t sa, sb; ht_scene_clear(&sa, 0); ht_scene_clear(&sb, 0);
            ht_character_face(&sa, &c, &a, 0xffff, ""); ht_character_face(&sb, &c, &b, 0xffff, "");
            bool same_b = true, same_a = true;
            for (int i = 1; i < scene.count; i++) {
                if (i == 10) continue;
                same_b &= !memcmp(&sb.runs[i], &scene.runs[i], sizeof scene.runs[i]);
                same_a &= !memcmp(&sa.runs[i], &scene.runs[i], sizeof scene.runs[i]);
            }
            assert(same_b && !same_a);
            prev = scene;
        }
        assert(moved);
        if (e == 2) {   // Muse: five body pictures (the squash, the hop, eyes up, eyes on the ball high, wide-eyed)
            unsigned seen = 0;
            for (unsigned st = 0; st < rs->steps; st++) seen |= 1u << rs->loop[st];
            assert(__builtin_popcount(seen) == 5);
            for (unsigned st = 0; st < 24; st++)      // lowest as it meets the head, up and down between, highest at 6, 18
                assert(st % 12 == 0 ? ball_at[st] >= ball_at[(st + 23) % 24] : st % 12 <= 6 ? ball_at[st] < ball_at[st - 1]
                                    : ball_at[st] >= ball_at[st - 1]);
            assert(ball_at[0] - ball_at[6] > 40 && ball_at[12] - ball_at[18] > 40);
        }
        // The raster budget: the code-drawn shapes stay small (each ring arc rasterises only its ink box).
        assert(arcs_ink / (2 * rs->steps) <= 8000);   // Claude ~1.7k px a step, Muse's ball ~1.5k
        // Not relaxing: working, a recap, a question, a status of its own, held (clock 0, asleep), the voice screen.
        ht_character_face_t g = {.recipient = "x", .engine = want[e].engine, .activity = "", .status = "", .hint = "",
            .detail = "", .mood = HT_CHARACTER_IDLE, .clock_ms = 1234};
        ht_scene_t sc;
        ht_character_face_t w = g; w.activity = "Working"; w.elapsed = 3;
        ht_scene_clear(&sc, 0); ht_character_face(&sc, &c, &w, 0xffff, "");
        assert(sc.count == 11 && sc.runs[1].sprite.cells != rs->frames[0].cells && sc.runs[10].fg == ht_rgb(0x00ff2f));
        ht_scene_clear(&sc, 0); ht_character_face(&sc, &c, &g, 0xffff, "Done.");
        assert(sc.count == 11 && sc.runs[3].text[0] && !sc.runs[10].arc);
        ht_character_face_t q = g; q.asking = true;
        ht_scene_clear(&sc, 0); ht_character_face(&sc, &c, &q, 0xffff, "");
        assert(sc.count == 11 && !sc.runs[10].arc);
        ht_character_face_t t = g; t.status = "Try again";
        ht_scene_clear(&sc, 0); ht_character_face(&sc, &c, &t, 0xffff, "");
        assert(sc.count == 11 && !sc.runs[10].arc && sc.runs[7].text[0]);
        ht_character_face_t h = g; h.clock_ms = 0;
        ht_scene_clear(&sc, 0); ht_character_face(&sc, &c, &h, 0xffff, "");
        assert(sc.count == 11 && pet_frame(pet, &sc.runs[1].sprite) == pet->loops[HT_PET_IDLE][0].frame && !sc.runs[10].arc);
        ht_character_face_t z = g; z.mood = HT_CHARACTER_ASLEEP;
        ht_scene_clear(&sc, 0); ht_character_face(&sc, &c, &z, 0xffff, "");
        assert(sc.count == 11 && !sc.runs[10].arc);
        ht_character_face_t v = g; v.voice = true; v.mood = HT_CHARACTER_WORKING;
        ht_scene_clear(&sc, 0); ht_character_face(&sc, &c, &v, 0xffff, "");
        assert(sc.count == 11);
    }
    // EVERY OTHER ENGINE keeps today's resting face (owner, 2026-10-09): Cursor's 56 px mark, the resting line in
    // grey inter_36 in runs 8 and 9 from today's list, nothing on the lower arc, eleven runs.
    for (int k = 0; k < 6; k++) {
        static const char *const others[] = {"cursor", "opencode", "grok", "hermes", "agy", "something-new"};
        ht_character_face_t g = {.recipient = "Payments refactor", .engine = others[k], .activity = "", .status = "",
            .hint = "", .detail = "", .mood = HT_CHARACTER_IDLE, .clock_ms = 777u * (unsigned)k + 1};
        ht_scene_t sc; ht_scene_clear(&sc, 0); ht_character_face(&sc, &c, &g, 0xffff, "");
        assert(sc.count == 11 && !sc.runs[10].arc && !sc.runs[10].text[0]);
        assert(sc.runs[8].text[0] && sc.runs[8].font == &ht_lv_inter_36.base && sc.runs[8].fg == ht_rgb(0x585863));
        if (k == 0) assert(sc.runs[1].sprite.pixels == ht_icon_engine56[2].px && sc.runs[1].sprite.width == 56);
        assert(!ht_focus_pet_next_ms(&g, ""));
        char said[64];
        snprintf(said, sizeof said, "%s%s", sc.runs[8].text, sc.runs[9].text);
        squeeze(said);
        static const char *const today[] = {"Let'sbuildit", "Doanything", "What'snext?", "Readywhenyouare", "Saytheword",
            "Makeithappen", "Startsomething", "Taptotalk", "Holdtoswitchtabs", "Tapthenametoswitchpanes"};
        bool known = false;
        for (unsigned r = 0; r < 10; r++) known |= !strcmp(said, today[r]);
        assert(known);
    }
    puts("Focus relaxing: Claude juggles, Codex's plane, Muse's keepy-uppy; constant runs, exact redraws, grey arc line; others unchanged PASS");
}

static void footer_layout(void)
{
    const unsigned counts[] = {0, 1, 9, 10, 32, 1, 0};
    ht_scene_t before, after;
    ht_scene_clear(&before, 0); redraw(NULL, &before);
    for (unsigned i = 0; i < sizeof counts / sizeof counts[0]; i++) {
        ht_scene_clear(&after, 0);
        ht_notification_bell(&after, counts[i], counts[i] ? 0xffff : ht_rgb(0x888888));
        redraw(&before, &after); before = after;
        int left = HT_WIDTH, right = 0, top = HT_HEIGHT, bottom = 0;
        for (int y = 0; y < HT_HEIGHT; y++) for (int x = 0; x < HT_WIDTH; x++)
            if (full[y * HT_WIDTH + x]) {
                assert((x - 233) * (x - 233) + (y - 233) * (y - 233) < 230 * 230);
                if (x < left) left = x;
                if (x > right) right = x;
                if (y < top) top = y;
                if (y > bottom) bottom = y;
            }
        assert(left + right >= 460 && left + right <= 470);
        assert(top >= 418 && bottom <= 451); // Matches the upper curve's rim inset.
    }
    ht_scene_clear(&after, 0); redraw(&before, &after);
}

static void inbox_layout(void)
{
    const char *names[] = {"Build", "Investigate firmware and notifications"};
    const char *messages[] = {"Yes. The fix is installed.",
        "Fixed and merged into main: PR #436. All 62 relevant tests and static analysis passed.",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"};
    const char *marks[] = {HT_DONE, "?", HT_FAILED};
    const unsigned colors[] = {0x0dbc79, 0xe5e510, 0xcd3131};
    ht_scene_t before, after;
    ht_scene_clear(&before, 0); redraw(NULL, &before);
    for (unsigned n = 0; n < 2; n++) for (unsigned m = 0; m < 3; m++)
        for (unsigned k = 0; k < 3; k++) {
            ht_scene_clear(&after, 0);
            ht_inbox_card(&after, marks[k], names[n], messages[m], 0xffff, ht_rgb(colors[k]));
            int titles = n ? 2 : 1, bodies = after.count - titles - 1;
            assert(bodies >= 1 && bodies <= 4);
            const ht_run_t *icon = &after.runs[after.count - 1];
            assert(!strcmp(icon->text, marks[k]) && icon->fg == ht_rgb(colors[k]));
            assert(icon->x == after.runs[0].x && icon->y == after.runs[0].y);
            assert(after.runs[titles].y - after.runs[titles - 1].y - 38 == 28);
            int bottom = after.runs[after.count - 2].y + 38;
            assert(after.runs[0].y + bottom >= 453 && after.runs[0].y + bottom <= 454);
            for (int i = 0; i < after.count - 1; i++)
                assert(after.runs[i].font == &ht_mono_28 && after.runs[i].fg == 0xffff);
            redraw(&before, &after); before = after;
            for (int y = 0; y < HT_HEIGHT; y++) for (int x = 0; x < HT_WIDTH; x++)
                if (full[y * HT_WIDTH + x])
                    assert((x - 233) * (x - 233) + (y - 233) * (y - 233) < 230 * 230);
        }
    puts("Inbox layout: desktop status colors, neutral prose, balanced short/long blocks, fixed gap, circle bounds and exact incremental redraws PASS");
}

/*
 * THE CUSTOM PET (docs/superpowers/plans/2026-10-08-custom-pet.md, Task 7): a pack the daemon sent, mapped as "all",
 * draws on the Focus face in place of the built-in pet — the same run count and order, the working alert drawn in
 * code, the ink inside r 230, and a pack dropped mid-frame still readable until the frame is released. The vector is
 * the daemon's own encoder output (test/vectors/pet_min.hpet): two 8 x 8 frames, a working scene of the second.
 */
static uint8_t vec_buf[4096];
static size_t vec_len;
static const char *VEC_ID = "0102030405060708";
static uint32_t crc32_of(const uint8_t *p, size_t n)
{
    uint32_t c = 0xffffffffu;
    for (size_t i = 0; i < n; i++) {
        c ^= p[i];
        for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xedb88320u & (0u - (c & 1u)));
    }
    return ~c;
}
static void put32le(uint8_t *p, uint32_t v) { for (int i = 0; i < 4; i++) p[i] = (uint8_t)(v >> (8 * i)); }
// Offer + slice + finish + map as "all", the way the cable does; the bytes as given (a patched copy is resealed here).
static void pack_load(const uint8_t *b, size_t n)
{
    put32le((uint8_t *)b + 14, (uint32_t)n);
    put32le((uint8_t *)b + 18, crc32_of(b + 22, n - 22));
    uint32_t crc = (uint32_t)(b[18] | b[19] << 8 | b[20] << 16 | (uint32_t)b[21] << 24);
    assert(pet_store_offer(VEC_ID, (uint32_t)n, crc));
    for (size_t at = 0; at < n; at += 50) assert(pet_store_slice(b + at, n - at < 50 ? n - at : 50));
    assert(pet_store_finish() == 0);
    pet_store_map(VEC_ID, NULL, NULL, 0);
    pet_store_release_frame();                                // the next take: the staged pack and mapping go live
}
static void pack_unload(void)
{
    pet_store_drop(VEC_ID);
    pet_store_map(NULL, NULL, NULL, 0);
    pet_store_release_frame();
}
// The offset of the working scene's dx in the vector (the walk test_pet_store.c does): palette, size, three loops.
static size_t working_dx_at(void)
{
    size_t pos = 22;
    pos += 1 + 2u * vec_buf[pos];
    pos += 4;
    for (int l = 0; l < 3; l++) pos += 1 + 2u * vec_buf[pos];
    return pos + 3;
}
static ht_character_face_t custom_face(bool working, unsigned notices)
{
    ht_character_face_t f = {.recipient = "Payments refactor", .tab = "", .engine = "claude",
        .activity = working ? "Coalescing" : "", .status = "", .hint = "", .detail = "",
        .mood = working ? HT_CHARACTER_WORKING : HT_CHARACTER_IDLE, .clock_ms = 1000,
        .foreground = 0xffff, .dim = 0x8410, .ink = 0xffff};
    if (notices) { f.notice_ms = 500; f.notices = (uint16_t)notices; }
    return f;
}
static void ink_inside_r230(const ht_scene_t *scene)
{
    ht_raster(scene, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, full);
    for (int y = 0; y < HT_HEIGHT; y++) for (int x = 0; x < HT_WIDTH; x++)
        if (full[y * HT_WIDTH + x]) assert((x - 233) * (x - 233) + (y - 233) * (y - 233) < 230 * 230);
}
// The code-drawn bubble of a scene: the 68 x 44 box filled 0x006fff; NULL when there is none.
static const ht_run_t *alert_box(const ht_scene_t *scene)
{
    for (int i = 0; i < scene->count; i++)
        if (scene->runs[i].box.h == 44 && scene->runs[i].w == 68 && scene->runs[i].box.fill == ht_rgb(0x006fff))
            return &scene->runs[i];
    return NULL;
}
static void focus_custom_pet_resting(void)
{
    ht_character_t c = {0};
    assert(ht_character_select(&c, HT_CHARACTER_FOCUS));
    ht_character_face_t f = custom_face(false, 0);
    // Today's resting face of a pet without a relaxing scene (Cursor's mark): a v1 pack keeps exactly its runs.
    ht_character_face_t g = f; g.engine = "cursor";
    ht_scene_t builtin; ht_scene_clear(&builtin, 0);
    ht_character_face(&builtin, &c, &g, 0xffff, "");
    pack_load(vec_buf, vec_len);
    ht_scene_t scene; ht_scene_clear(&scene, 0);
    ht_character_face(&scene, &c, &f, 0xffff, "");
    assert(scene.count == builtin.count);   // THE RULE: same runs, same order
    const ht_pet_t *pet = pet_store_lookup("claude");
    assert(pet && pet->cells && !pet->alert_scene);
    bool drawn = false;
    for (int i = 0; i < scene.count; i++)
        for (unsigned k = 0; k < 2; k++)
            if (scene.runs[i].sprite.cells && scene.runs[i].sprite.cells == pet->cells[k].cells) drawn = true;
    assert(drawn);
    ink_inside_r230(&scene);
    pet_store_release_frame();
    pack_unload();
}
/*
 * A VERSION 2 PACK (pet_store.c): a fifth scene, relaxing, after failed. Its pet's resting face is the relaxing face
 * with that scene (placed as its working scene is, from its dx, dy; the quiet line on the lower arc, nothing in the
 * middle); a version 1 pack keeps today's resting face (the small pet and the two lines in the middle).
 */
static size_t make_v2(uint8_t *out)
{
    size_t pos = 22;
    pos += 1 + 2u * vec_buf[pos];
    pos += 4;
    for (int l = 0; l < 3; l++) pos += 1 + 2u * vec_buf[pos];
    for (int s = 0; s < 4; s++) pos += 7 + 2u * vec_buf[pos];
    static const uint8_t relax[] = {2, 150, 0, 4, 0, 0xfa, 0xff, 1, 0, 0, 0};   // 2 x 150 ms: frames 1, 0; (4, -6)
    memcpy(out, vec_buf, pos);
    memcpy(out + pos, relax, sizeof relax);
    memcpy(out + pos + sizeof relax, vec_buf + pos, vec_len - pos);
    out[4] = 2;
    return vec_len + sizeof relax;
}
static void focus_custom_pet_relaxing(void)
{
    ht_character_t c = {0};
    assert(ht_character_select(&c, HT_CHARACTER_FOCUS));
    ht_character_face_t f = custom_face(false, 0);
    // v1: today's face
    pack_load(vec_buf, vec_len);
    ht_scene_t old; ht_scene_clear(&old, 0);
    ht_character_face(&old, &c, &f, 0xffff, "");
    assert(old.count == 11 && (old.runs[8].text[0] || old.runs[9].text[0]) && !old.runs[10].arc);
    assert(old.runs[8].font == &ht_lv_inter_36.base && old.runs[1].sprite.zoom);   // the small pet, drawn zoomed
    pet_store_release_frame();
    pack_unload();
    // v2: the relaxing face
    static uint8_t b[4096];
    size_t n = make_v2(b);
    pack_load(b, n);
    const ht_pet_t *pet = pet_store_lookup("claude");
    assert(pet && pet->relaxing_scene && pet->relaxing_scene->steps == 2);
    const ht_pet_scene_t *rs = pet->relaxing_scene;
    for (unsigned step = 0; step < 4; step++) {
        f.clock_ms = 1000 + step * 150;
        ht_scene_t scene; ht_scene_clear(&scene, 0);
        ht_character_face(&scene, &c, &f, 0xffff, "");
        assert(scene.count == 11);                        // no shapes: the eleven runs
        const ht_run_t *m = &scene.runs[1];
        unsigned st = f.clock_ms / 150 % 2;
        assert(m->sprite.cells == pet->cells[rs->loop[st]].cells && !m->sprite.zoom);
        assert(m->x == (466 - rs->w) / 2 + 4 && m->y == 233 - rs->h / 2 + 4 - 6);
        for (int i = 3; i < 10; i++) assert(!scene.runs[i].text[0] && !scene.runs[i].sprite.width);
        assert(scene.runs[10].arc == 2 && scene.runs[10].fg == ht_rgb(0x9a9aa6) && scene.runs[10].text[0]);
        assert(ht_focus_pet_next_ms(&f, "") == (f.clock_ms / 150 + 1) * 150);
        ink_inside_r230(&scene);
    }
    // with notices (the bell pill takes the lower arc) or a footer action: the same runs, the line left out
    {
        ht_character_face_t nf = custom_face(false, 2), ff = custom_face(false, 0);
        ff.footer_action = true;
        ht_scene_t base, ns, fs;
        ht_scene_clear(&base, 0); ht_scene_clear(&ns, 0); ht_scene_clear(&fs, 0);
        ht_character_face(&base, &c, &f, 0xffff, "");
        ht_character_face(&ns, &c, &nf, 0xffff, "");
        ht_character_face(&fs, &c, &ff, 0xffff, "");
        assert(base.runs[10].arc == 2 && base.runs[10].text[0]);
        assert(ns.count == base.count && fs.count == base.count);
        assert(!ns.runs[10].arc && !ns.runs[10].text[0] && !fs.runs[10].arc && !fs.runs[10].text[0]);
        ink_inside_r230(&ns);
    }
    // working, and a recap, are not relaxing
    ht_character_face_t w = custom_face(true, 0);
    ht_scene_t ws; ht_scene_clear(&ws, 0); ht_character_face(&ws, &c, &w, 0xffff, "");
    assert(ws.runs[1].sprite.cells && !ws.runs[1].sprite.zoom && ws.runs[10].arc == 2 && ws.runs[10].fg == ht_rgb(0x00ff2f));
    ht_scene_t rc; ht_scene_clear(&rc, 0); ht_character_face(&rc, &c, &f, 0xffff, "Done.");
    assert(rc.runs[3].text[0] && !rc.runs[10].arc);
    pet_store_release_frame();
    pack_unload();
    // a v2 pack whose relaxing scene has no frames keeps today's resting face
    {
        static const uint8_t none[] = {0, 0, 0, 0, 0, 0, 0};
        size_t pos = 22;
        pos += 1 + 2u * vec_buf[pos];
        pos += 4;
        for (int l = 0; l < 3; l++) pos += 1 + 2u * vec_buf[pos];
        for (int k = 0; k < 4; k++) pos += 7 + 2u * vec_buf[pos];
        memcpy(b, vec_buf, pos);
        memcpy(b + pos, none, sizeof none);
        memcpy(b + pos + sizeof none, vec_buf + pos, vec_len - pos);
        b[4] = 2;
        pack_load(b, vec_len + sizeof none);
        pet = pet_store_lookup("claude");
        assert(pet && !pet->relaxing_scene);
        ht_scene_t e; ht_scene_clear(&e, 0);
        ht_character_face(&e, &c, &f, 0xffff, "");
        assert(e.count == 11 && (e.runs[8].text[0] || e.runs[9].text[0]) && !e.runs[10].arc && e.runs[1].sprite.zoom);
    }
    pet_store_release_frame();
    pack_unload();
}
static void focus_custom_pet_working_alert(void)
{
    ht_character_t c = {0};
    assert(ht_character_select(&c, HT_CHARACTER_FOCUS));
    pack_load(vec_buf, vec_len);
    const ht_pet_t *pet = pet_store_lookup("claude");
    assert(pet && pet->working_scene && !pet->alert_scene);
    int sw = pet->working_scene->w, sh = pet->working_scene->h;
    int sx = (HT_WIDTH - sw) / 2 + pet->working_scene->dx, sy = HT_HEIGHT / 2 - sh / 2 + 4 + pet->working_scene->dy;
    ht_character_face_t quiet = custom_face(true, 0), told = custom_face(true, 3), many = custom_face(true, 12);
    ht_scene_t a, b, m;
    ht_scene_clear(&a, 0); ht_character_face(&a, &c, &quiet, 0xffff, "");
    ht_scene_clear(&b, 0); ht_character_face(&b, &c, &told, 0xffff, "");
    ht_scene_clear(&m, 0); ht_character_face(&m, &c, &many, 0xffff, "");
    assert(a.count == b.count && b.count == m.count);   // the alert takes the slots the built-in one does
    assert(!alert_box(&a));
    const ht_run_t *box = alert_box(&b);
    assert(box);
    // Centred on the scene's top-right corner, inset 8 px: the scene's corner is at (sx + sw, sy).
    assert(box->x + 34 == sx + sw - 8 && box->y + 22 == sy + 8);
    ht_rect_t at = {0};
    assert(ht_focus_alert_shown(&told, "", &at));
    assert(at.x == box->x && at.y == box->y && at.w == 68 && at.h == 44);   // the tap target covers it
    assert(!ht_focus_alert_shown(&quiet, "", &at));
    assert(ht_focus_alert_pop_ms(&told) == 0);
    // The count: Inter Medium 26 for one digit, Inter 20 for "9+", on the bubble's fill, inside the box.
    bool one = false, nine = false;
    for (int i = 0; i < b.count; i++) if (b.runs[i].font == &ht_lv_inter_med_26.base && !strcmp(b.runs[i].text, "3")) one = true;
    for (int i = 0; i < m.count; i++) if (m.runs[i].font == &ht_lv_inter_20.base && !strcmp(m.runs[i].text, "9+")) nine = true;
    assert(one && nine);
    ht_raster(&b, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, full);
    const uint16_t blue = (uint16_t)((ht_rgb(0x006fff) >> 8) | (ht_rgb(0x006fff) << 8));   // the raster is in panel order
    assert(full[(box->y + 22) * HT_WIDTH + box->x + 8] == blue);   // the fill reaches the glass
    int lit = 0;   // ... and the digit is drawn in it
    for (int y = box->y + 4; y < box->y + 40; y++) for (int x = box->x + 20; x < box->x + 48; x++)
        lit += full[y * HT_WIDTH + x] != blue && full[y * HT_WIDTH + x] != 0;
    assert(lit > 10);
    ink_inside_r230(&b);
    ink_inside_r230(&m);
    // The alert is a notice's, not the pet's: a pack without a working scene leaves the pill to ui_habitat.c.
    ht_character_face_t idle = custom_face(false, 3);
    assert(!ht_focus_alert_shown(&idle, "", &at));
    pet_store_release_frame();
    pack_unload();
}
static void focus_custom_ink_inside_r230(void)
{
    ht_character_t c = {0};
    assert(ht_character_select(&c, HT_CHARACTER_FOCUS));
    // Moves the working scene to the glass's upper right so the bubble at its corner would leave r 230 unclamped.
    uint8_t b[4096];
    memcpy(b, vec_buf, vec_len);
    size_t dx = working_dx_at();
    b[dx] = 165; b[dx + 1] = 0;
    b[dx + 2] = (uint8_t)(-135 & 0xff); b[dx + 3] = (uint8_t)((-135 >> 8) & 0xff);
    pack_load(b, vec_len);
    const ht_pet_t *pet = pet_store_lookup("claude");
    assert(pet && pet->working_scene->dx == 165 && pet->working_scene->dy == -135);
    ht_character_face_t f = custom_face(true, 12);
    ht_scene_t scene; ht_scene_clear(&scene, 0);
    ht_character_face(&scene, &c, &f, 0xffff, "");
    const ht_run_t *box = alert_box(&scene);
    assert(box);
    int sx = (HT_WIDTH - 8) / 2 + 165, sy = HT_HEIGHT / 2 - 4 + 4 - 135;
    assert(box->x + 34 < sx + 8 - 8 || box->y + 22 > sy + 8);   // pulled inward
    ink_inside_r230(&scene);
    ht_rect_t at;
    assert(ht_focus_alert_shown(&f, "", &at) && at.x == box->x && at.y == box->y);
    // ... and the same for the other three quarters of the glass.
    for (int q = 0; q < 4; q++) {
        int sdx = (q & 1) ? -165 : 165, sdy = (q & 2) ? 135 : -135;
        pet_store_release_frame();
        pack_unload();
        memcpy(b, vec_buf, vec_len);
        b[dx] = (uint8_t)(sdx & 0xff); b[dx + 1] = (uint8_t)((sdx >> 8) & 0xff);
        b[dx + 2] = (uint8_t)(sdy & 0xff); b[dx + 3] = (uint8_t)((sdy >> 8) & 0xff);
        pack_load(b, vec_len);
        ht_scene_clear(&scene, 0);
        ht_character_face(&scene, &c, &f, 0xffff, "");
        assert(alert_box(&scene));
        ink_inside_r230(&scene);
    }
    pet_store_release_frame();
    pack_unload();
}
// Draw, drop the pack under the drawn scene, draw again, release: under the address sanitizer (the --custom-only
// build) a pointer used after the free is an error.
static void focus_swap_mid_scene(void)
{
    ht_character_t c = {0};
    assert(ht_character_select(&c, HT_CHARACTER_FOCUS));
    pack_load(vec_buf, vec_len);
    ht_character_face_t f = custom_face(true, 2);
    ht_scene_t first; ht_scene_clear(&first, 0);
    ht_character_face(&first, &c, &f, 0xffff, "");
    assert(alert_box(&first));
    ht_raster(&first, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, full);
    pet_store_drop(VEC_ID);                                  // the cable task: the pack is replaced under the frame
    pet_store_map(NULL, NULL, NULL, 0);
    assert(pet_store_lookup("claude"));                      // staged only: this frame's snapshot is unchanged
    ht_raster(&first, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, scratch);   // the scene still reads the pack
    assert(!memcmp(full, scratch, sizeof full));
    pet_store_release_frame();                               // the next take: the pack is freed, the mapping is gone
    ht_scene_t second; ht_scene_clear(&second, 0);
    ht_character_face(&second, &c, &f, 0xffff, "");          // now the built-in claude
    assert(!pet_store_lookup("claude"));
    assert(first.count == second.count);                      // the same runs either way
    ht_damage_t d; ht_damage(&first, &second, &d);           // compares the frames by pointer, never reads them
    ht_raster(&second, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, full);
    pet_store_release_frame();
    ht_raster(&second, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, full);   // the built-in scene needs no pack
}
static void custom_pet(void)
{
    focus_custom_pet_resting();
    focus_custom_pet_relaxing();
    focus_custom_pet_working_alert();
    focus_custom_ink_inside_r230();
    focus_swap_mid_scene();
    puts("Custom pet: resting, relaxing (v2), code-drawn working alert, r 230 clamp and a swap mid-scene PASS");
}

int main(int argc, char **argv)
{
    if (argc < 2) { fprintf(stderr, "usage: test_character <pet_min.hpet> [--custom-only]\n"); return 2; }
    FILE *fp = fopen(argv[1], "rb");
    assert(fp);
    vec_len = fread(vec_buf, 1, sizeof vec_buf, fp);
    fclose(fp);
    assert(vec_len > 22 && vec_len < sizeof vec_buf);
    if (argc > 2 && !strcmp(argv[2], "--custom-only")) { custom_pet(); return 0; }
    assert(!strcmp(ht_character_name(HT_CHARACTER_TIM), "Tim"));
    assert(!strcmp(ht_character_name(HT_CHARACTER_TUX), "Tux"));
    clocks(); portraits(); delivery_and_caption(); recap_budget(); focus_face();
    focus_relaxing(); footer_layout(); inbox_layout(); custom_pet();
    printf("Characters: both adapters, eight moods, five sizes, pause/mic/wrap/swap and %u exact incremental redraws PASS\n", redraws);
}
