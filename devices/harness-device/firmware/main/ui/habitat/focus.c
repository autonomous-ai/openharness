#include "focus.h"
#include "pets.h"
#include "focus_faces.h"
#include "theme.h"
#include "../../pet_store.h"
#include <math.h>
#include <stdio.h>
#include <string.h>

/*
 * THE FOCUS FACE — the agent screen, laid out like the octopus's (owner, 2026-10-01).
 *
 * The session's name curves along the top edge in the octopus's own arc, in Inter Medium 26 laid out
 * glyph by glyph along it (ht_arc_title_face, ht_arc_inter_prop; the lower-arc status and the Listening
 * sweep wear the same face on the lower curve, ht_arc_inter_lower);
 * the engine's mark stands where the octopus does, 56 px (focus_marks.c) — for an engine with a pet
 * (Claude, Codex: pets.c) it is the animated pet instead, centred in the same box. Under it the recap
 * is set in the "Kindle dark" layout (owner, 2026-10-02, K3: mockup/kindle_options.py), now in Inter, SF Compact's
 * open look-alike (owner, 2026-10-03), soft white Inter 30 (inter_30, focus_faces.c), back in a card (owner, 2026-10-07,
 * mockup/recap_box.py A, recap_pad.py P1): the LVGL firmware's card at 80 %, rimmed, 384 px wide, as tall as its lines, each line centred
 * on x 233 in a 364 px column at x 51, 43 px apart, up to four lines — as many as the octopus reads — and a longer recap
 * ends in "…". The block is centred vertically in a fixed area (y 176..376), so the mark never moves
 * with its length. A question takes the recap's place and look. With no recap, the working line or a
 * resting line ("Let's build it", …) is centred on the glass. The mark stands halfway between the
 * name and what is under it — the recap area's top, or the line. There is no tab pill and no microphone: a tap anywhere
 * on the face talks to the agent, a hold opens the tabs, a tap on the name opens the panes
 * (ui_habitat.c).
 *
 * Every word is Inter (focus_faces.c, owner 2026-10-02: one font), laid out by ht_lv_label — LVGL's own wrap,
 * centring and LONG_DOT.
 *
 * ── the rule that decides the SHAPE of this file ────────────────────────────────────────────────
 *
 * ht_damage() diffs run index against run index and repaints the whole 466x466 the moment the count
 * or the order changes (terminal.c). So the home face emits the SAME ELEVEN RUNS IN THE SAME ORDER on
 * every frame — name, mark, card (drawn under a recap, an invisible placeholder otherwise, so the count and
 * order never move), recap ×4, status, resting line ×2, lower-arc status — each empty
 * where it has nothing to say. Do not make one conditional. The lower arc is a working scene's
 * status line (arc_status below), or a relaxing scene's quiet line; every other state, and every other engine,
 * leaves it empty. A scene's overlay (Codex's sandbox bubble, its paper plane) takes the first recap line's slot,
 * which a working or relaxing scene (no recap) leaves empty, and is emitted after the scene's own run so it draws
 * over it. A relaxing scene with SHAPES (Claude's balls, Muse's beach ball: pets.h ht_pet_shapes_t) emits them after
 * the eleven, `count` ring arcs on every step of it (an empty slot keeps a shape's place), so on that face the
 * runs are 11 + count, the same on every frame of it.
 */
// The text column of the working and resting lines: 384 px at x 41. The recap has its own: 364 px at
// x 51 (233 - 182), each line centred in it (LVGL's centring, as every label here), up to four lines 43 px apart, centred vertically in the area
// y 176..376 (RECAP_AREA_*), the first baseline 30 px under the block's top. Every
// line's ink stays inside r 230. TITLE_BOTTOM is the foot of the arc's cells at the top of the curve,
// where the mark is measured from.
enum { MARK_SIZE = 56, TITLE_BOTTOM = HT_ARC_Y + HT_ARC_CELL_HEIGHT, COL_X = 41, COL_W = 384,
       RECAP_X = 51, RECAP_W = 364, RECAP_LINES = 4, RECAP_PITCH = 43, RECAP_BASELINE = 30,
       RECAP_AREA_Y = 176, RECAP_AREA_H = 200, RECAP_CAP = 22, EMPTY_W = 276, EMPTY_CAP = 26,
       CARD_R = 24,
       SCENE_LINE_Y = 334 };   // the working scene ends at y 325
#define FOCUS_RECAP   0xd6d6d2u   // the "Kindle dark" layout's soft white
#define FOCUS_CARD    0x1c1e26u   // the recap's card: the LVGL firmware's #23252f at 80 % (owner, 2026-10-07: a little
                                  // fainter), and its rim (#a6a6a6 at 20 %)
#define FOCUS_CARD_RIM 0x3d3f47u
#define FOCUS_FG      0xeaeaf0u
#define FOCUS_EMPTY   0x585863u
#define FOCUS_VOICE   0x00ff2fu
#define FOCUS_REST    0x9a9aa6u   // the relaxing face's lower-arc line: the working line's arc and font, quiet grey

/*
 * WHAT AN AGENT WITH NOTHING YET SAYS, in place of "No activity yet" (owner, 2026-10-01): an
 * invitation rather than a report, picked at random each time the resting face appears — on arrival,
 * after a turn, on another agent, back from voice — and never the same line twice running (owner,
 * 2026-10-02). It holds while that face stays up, so a redraw never swaps it. Each fits two lines of
 * inter_36 at EMPTY_W. The lines that teach the dial come up more often (owner, 2026-10-03): a line
 * listed k times is k times as likely — "Tap to talk" 10, "Hold to switch tabs" 5, "Tap the name to
 * switch panes" 5, every other line once.
 */
#define TAP_TO_TALK "Tap to talk"
#define HOLD_FOR_TABS "Hold to switch tabs"
#define TAP_THE_NAME "Tap the name to switch panes"
static const char *const RESTING[] = {
    "Let's build it", "Do anything", "What's next?", "Ready when you are",
    "Say the word", "Make it happen", "Start something",
    TAP_TO_TALK, TAP_TO_TALK, TAP_TO_TALK, TAP_TO_TALK, TAP_TO_TALK,
    TAP_TO_TALK, TAP_TO_TALK, TAP_TO_TALK, TAP_TO_TALK, TAP_TO_TALK,
    HOLD_FOR_TABS, HOLD_FOR_TABS, HOLD_FOR_TABS, HOLD_FOR_TABS, HOLD_FOR_TABS,
    TAP_THE_NAME, TAP_THE_NAME, TAP_THE_NAME, TAP_THE_NAME, TAP_THE_NAME,
};
/*
 * THE RELAXING FACE'S LINES (owner, 2026-10-09: mockup/relaxing.html): one short line on the lower arc, two or three
 * words, picked the same way — "Tap to talk" 10, "Hold for tabs" 5, "Tap name for panes" 5, every other line once.
 * Each fits the lower arc's 390 px (Tap name for panes, the longest, is 248).
 */
#define TAP_TALK "Tap to talk"
#define HOLD_TABS "Hold for tabs"
#define TAP_NAME "Tap name for panes"
static const char *const RELAXING[] = {
    TAP_TALK, TAP_TALK, TAP_TALK, TAP_TALK, TAP_TALK, TAP_TALK, TAP_TALK, TAP_TALK, TAP_TALK, TAP_TALK,
    HOLD_TABS, HOLD_TABS, HOLD_TABS, HOLD_TABS, HOLD_TABS,
    TAP_NAME, TAP_NAME, TAP_NAME, TAP_NAME, TAP_NAME,
    "What's next?", "Your move", "Say the word", "Ask away",
};
static struct {
    bool showing;           // the last home face drawn was a resting one
    char who[64];           // ... for this recipient
    const char *const *list;   // ... from this list (RESTING or RELAXING)
    const char *line;
    uint32_t seed;
} resting;
static const char *pick_line(const ht_character_face_t *f, const char *const *list, unsigned n)
{
    const char *who = f->recipient ? f->recipient : "";
    if (!resting.showing || !resting.line || resting.list != list || strncmp(resting.who, who, sizeof resting.who - 1)) {
        // An LCG stirred with the clock: no entropy source is needed to look random on a dial.
        resting.seed = resting.seed * 1664525u + 1013904223u + f->clock_ms;
        unsigned pick = (resting.seed >> 16) % n;
        // Never the same words twice running: past every copy of the last line (copies are adjacent).
        while (resting.line && !strcmp(list[pick], resting.line)) pick = (pick + 1) % n;
        resting.line = list[pick];
        resting.list = list;
        snprintf(resting.who, sizeof resting.who, "%s", who);
    }
    resting.showing = true;
    return resting.line;
}
static const char *resting_line(const ht_character_face_t *f)
{
    return pick_line(f, RESTING, sizeof RESTING / sizeof RESTING[0]);
}
static const char *relaxing_line(const ht_character_face_t *f)
{
    return pick_line(f, RELAXING, sizeof RELAXING / sizeof RELAXING[0]);
}

/*
 * THE ENGINE'S OWN MARK.
 *
 * Order matches ENGINES in scripts/gen_habitat_fonts.py, which is what assigns the codepoints; the
 * two lists are one list in two files and must be changed together. `engine` is twelve bytes on the
 * wire (cable_client.c) and was stored and drawn nowhere until this face.
 *
 * An unknown engine gets no badge rather than a wrong one — a mark that means "some engine" teaches
 * a person to stop reading it.
 */
static const char *const ENGINES[] = {
    "claude", "codex", "cursor", "opencode", "grok", "copilot", "amp",
    "devin", "kilo", "pi", "hermes", "muse", "agy", "commandcode",
};

/*
 * And the colour it is drawn in — one per engine, in the order above.
 *
 * A badge is a single text cell, and ht_run_t.colors is per CELL, so a mark gets exactly one colour;
 * a two-tone logo (the Codex ring, the Antigravity gradient) is flattened to its dominant hue and
 * that is a real limit, not a choice. What IS a choice is which colour, and the old firmware's answer
 * is the one kept here: it recoloured Claude alone, to 0xcc7c5e, and let every other vendored asset
 * keep its own — which for ten of these fourteen meant white. Measured off those assets, only Codex,
 * Kilo, Muse and Antigravity ever carried a hue at all. Painting all fourteen in the accent, as the
 * first draft of this face did, made every engine look like the same lilac smudge and told a person
 * nothing; 0 here means "no colour of its own", and the mark is drawn in the row's ink.
 */
static const uint32_t ENGINE_INK[] = {
    0xcc7c5e, 0x7090f0, 0, 0, 0, 0, 0,
    0, 0xf0f070, 0, 0, 0x2d9bf0, 0x3080f0, 0,
};
_Static_assert(sizeof ENGINE_INK / sizeof ENGINE_INK[0] == sizeof ENGINES / sizeof ENGINES[0],
               "one ink per engine");

int ht_focus_engine_index(const char *engine)
{
    if (!engine || !*engine) return -1;
    for (unsigned i = 0; i < sizeof ENGINES / sizeof ENGINES[0]; i++)
        if (!strcmp(engine, ENGINES[i])) return (int)i;
    return -1;
}
_Static_assert(sizeof ht_icon_engine20 / sizeof ht_icon_engine20[0] == sizeof ENGINES / sizeof ENGINES[0],
               "one icon per engine");

/*
 * A PET'S STATE, from the face alone: an open question; else the working line (the
 * `status[0]` path in ht_focus_face: no recap, an activity); else a finished turn; else resting.
 * A clock of 0, or a sleeping/offline mood, holds idle step 0. ht_focus_pet_next_ms() and the face
 * share this, so the redraw time in ui_habitat.c always agrees with what is drawn.
 */
static ht_pet_state_t pet_state(const ht_character_face_t *f, const char *recap)
{
    bool has_recap = recap && *recap;
    if (f->asking) return HT_PET_ASKING;
    if (!has_recap && f->activity && *f->activity) return HT_PET_WORKING;
    return f->mood == HT_CHARACTER_DONE ? HT_PET_DONE : HT_PET_IDLE;
}
static bool pet_holds(const ht_character_face_t *f)
{
    return !f->clock_ms || f->mood == HT_CHARACTER_ASLEEP || f->mood == HT_CHARACTER_OFFLINE;
}

// The pet of the face's engine, or NULL: the face draws the engine's mark. A pack the person sent (pet_store.c:
// the engine's own, else "all") wins over the built-in pet; its pointers stay good until ui_habitat.c's next
// pet_store_release_frame, which comes only after the frame built from them has been painted.
static const ht_pet_t *pet_for(const ht_character_face_t *f)
{
    if (!f->engine) return NULL;
    const ht_pet_t *custom = pet_store_lookup(f->engine);
    if (custom) return custom;
    for (unsigned i = 0; i < ht_pet_count; i++)
        if (!strcmp(f->engine, ht_pets[i].engine)) return &ht_pets[i];
    return NULL;
}

/*
 * THE WORKING SCENE: a pet with one (Claude's cooking Clawd) plays it, large, in place of the small
 * pet and the centred working line, while it is working on a plain working line — not asking, not a
 * recap, not the listening meter, not held. NULL otherwise.
 */
static const ht_pet_scene_t *working_scene(const ht_character_face_t *f, const char *recap)
{
    const ht_pet_t *pet = pet_for(f);
    if (!pet || !pet->working_scene || pet_holds(f) || f->mood == HT_CHARACTER_LISTENING) return NULL;
    return pet_state(f, recap) == HT_PET_WORKING ? pet->working_scene : NULL;
}
/*
 * THE RELAXING SCENE (owner, 2026-10-09: mockup/relaxing.html): the resting face of an agent with nothing to show —
 * no recap, no question, no working line, no status of its own, idle — laid out like the working face when its pet
 * has one: the name on the upper arc, the scene in the mark's slot placed as a working scene is, no text in the
 * middle, one quiet line on the lower arc (RELAXING). Claude juggles, Codex plays with its paper plane, Muse keeps a
 * beach ball up off its head (mockup/muse-play.html D); a custom pack of version 2 may carry one. A pet without one keeps today's resting face. Not while
 * held (clock 0, asleep, offline), as the working scene.
 */
static const ht_pet_scene_t *relaxing_scene(const ht_character_face_t *f, const char *recap)
{
    const ht_pet_t *pet = pet_for(f);
    if (!pet || !pet->relaxing_scene || f->voice || pet_holds(f) || f->mood == HT_CHARACTER_LISTENING) return NULL;
    if ((recap && *recap) || (f->activity && *f->activity) || (f->status && *f->status)) return NULL;
    // Done with no recap relaxes too: an agent whose turn just ended rests in DONE, which is where most resting
    // faces are (owner, 2026-10-09: the Devices tab's Codex kept the old face after its turn).
    const ht_pet_state_t state = pet_state(f, recap);
    return state == HT_PET_IDLE || state == HT_PET_DONE ? pet->relaxing_scene : NULL;
}
static void scene_origin(const ht_pet_scene_t *sc, int bias, int *x, int *y);
/*
 * THE ALERT (owner, 2026-10-05: no bell pill on the working face, the pet tells you; 2026-10-07, mockup/
 * alert_count.py: "keep the bell, the number beside it"): while the working scene shows and a notice is unread, the
 * pet's alert scene plays over it from f->notice_ms, its bubble the overlay placed from the working scene's origin
 * in the run after the working scene's overlay: popped in, the bell ringing for ~5 s, then its last step (the
 * bubble at rest) held until the notices are read. From the step the bubble is whole (count_at) the count is
 * written in it. NULL when there is none to show; *held when it is past its last step.
 */
static const ht_pet_scene_t *alert_scene(const ht_character_face_t *f, const char *recap, uint32_t *step, bool *held)
{
    const ht_pet_scene_t *work = working_scene(f, recap);
    const ht_pet_t *pet = pet_for(f);
    if (!work || !pet || !pet->alert_scene || !f->notice_ms || !f->notices) return NULL;
    const ht_pet_scene_t *a = pet->alert_scene;
    uint32_t age = f->clock_ms - f->notice_ms;
    bool past = age >= (uint32_t)a->steps * a->step_ms;
    if (step) *step = past ? a->steps - 1u : age / a->step_ms;
    if (held) *held = past;
    return a;
}
/*
 * THE ALERT OF A PET WITHOUT ONE (a custom pack has no alert_scene: the person's art has no bubble): drawn in code, a
 * blue box ALERT_W x ALERT_H (gen_pets.py's bubble size) centred on the working scene's top-right corner inset
 * ALERT_INSET px, the count in it at once (there is no pop-in, so ht_focus_alert_pop_ms is 0). It takes the same run
 * slots the built-in bubble does (the second recap slot the box, the third the count), so the face's runs never change.
 * Pulled toward the glass's centre until its rounded outline lies inside r 230 (a scene placed far out by its dx, dy).
 */
enum { ALERT_W = 68, ALERT_H = 44, ALERT_INSET = 8, ALERT_R = 13, ALERT_GLASS_R = 230 };
#define ALERT_BLUE 0x006fffu
static bool code_alert(const ht_character_face_t *f, const char *recap, ht_rect_t *box)
{
    const ht_pet_scene_t *work = working_scene(f, recap);
    const ht_pet_t *pet = pet_for(f);
    if (!work || !pet || pet->alert_scene || !f->notice_ms || !f->notices) return false;
    if (box) {
        int sx, sy;
        scene_origin(work, 4, &sx, &sy);
        int x = sx + work->w - ALERT_INSET - ALERT_W / 2, y = sy + ALERT_INSET - ALERT_H / 2;
        for (int guard = 0; guard < 240; guard++) {   // the farthest corner's arc centre, plus the radius, inside r 230
            int cx = x + ALERT_W / 2 >= HT_WIDTH / 2 ? x + ALERT_W - ALERT_R : x + ALERT_R;
            int cy = y + ALERT_H / 2 >= HT_HEIGHT / 2 ? y + ALERT_H - ALERT_R : y + ALERT_R;
            int dx = cx - HT_WIDTH / 2, dy = cy - HT_HEIGHT / 2, room = ALERT_GLASS_R - ALERT_R - 1;
            if (dx * dx + dy * dy <= room * room) break;
            if (x + ALERT_W / 2 > HT_WIDTH / 2) x--; else if (x + ALERT_W / 2 < HT_WIDTH / 2) x++;
            if (y + ALERT_H / 2 > HT_HEIGHT / 2) y--; else if (y + ALERT_H / 2 < HT_HEIGHT / 2) y++;
        }
        *box = (ht_rect_t){x, y, ALERT_W, ALERT_H};
    }
    return true;
}
bool ht_focus_alert_shown(const ht_character_face_t *f, const char *recap, ht_rect_t *at)
{
    if (code_alert(f, recap, at)) return true;
    uint32_t step = 0;
    const ht_pet_scene_t *a = alert_scene(f, recap, &step, NULL);
    if (!a) return false;
    const ht_pet_scene_t *work = working_scene(f, recap);
    if (!work) return false;
    if (at) {   // the step's bubble on the glass (nothing while it has not popped in yet)
        const ht_cell_frame_t *b = &a->overlay->frames[a->overlay->loop[step]];
        int ox, oy;
        scene_origin(work, 4, &ox, &oy);
        bool none = !a->overlay->at[step][0] && !a->overlay->at[step][1];
        *at = none ? (ht_rect_t){0} : (ht_rect_t){ox + a->overlay->at[step][0], oy + a->overlay->at[step][1],
                                                  b->cols * b->cell, b->rows * b->cell};
    }
    return true;
}
uint32_t ht_focus_alert_pop_ms(const ht_character_face_t *f)
{
    // The steps before the count shows: the bubble popping in, which a second notice does not play again.
    const ht_pet_t *pet = pet_for(f);
    const ht_pet_scene_t *a = pet ? pet->alert_scene : NULL;
    if (!a || !a->count_at) return 0;
    unsigned k = 0;
    while (k < a->steps && !a->count_at[k][0] && !a->count_at[k][1]) k++;
    return k * (uint32_t)a->step_ms;
}
// The first and one past the last row of a cell frame that holds ink; both 0 when it holds none.
static void cell_ink_rows(const ht_cell_frame_t *fr, int *first, int *end)
{
    *first = *end = 0;
    for (int r = 0; r < fr->rows; r++)
        for (int c = 0; c < fr->cols; c++)
            if (ht_cell_at(fr, c, r)) {
                if (*end == 0) *first = r;
                *end = r + 1;
                break;
            }
}
/*
 * The name's ink foot over a drawing `half` px either side of the glass's centre (owner, 2026-10-07: "the gap from the
 * name to the pet's head should match the pet's feet to the text"). The name runs on a circle about the centre, its
 * cells' foot at TITLE_BOTTOM at the top of the curve, so over a wide pet it reaches lower: measured at 2x, 65 px
 * over Claude's shoulders against 44 at the top, which left 18 px above the head and 70 under the feet. Only as far
 * out as the name goes: a short one stays high.
 */
static int title_foot(const ht_scene_t *s, int run, int half)
{
    ht_rect_t b = ht_run_bounds(&s->runs[run]);
    int reach = b.w ? HT_WIDTH / 2 - b.x : 0, r = HT_HEIGHT / 2 - TITLE_BOTTOM;
    if (half > reach) half = reach;
    if (half >= r) half = r - 1;
    return HT_HEIGHT / 2 - (int)sqrtf((float)(r * r - half * half));
}
static unsigned scene_step(const ht_pet_scene_t *sc, uint32_t clock_ms)
{
    return (clock_ms / sc->step_ms) % sc->steps;
}
// The scene's frame at this clock; `level` picks the listening scene's loop (the working one has one).
static const ht_cell_frame_t *scene_frame(const ht_pet_scene_t *sc, unsigned level, uint32_t clock_ms)
{
    if (level >= HT_PET_SCENE_LEVELS) level = HT_PET_SCENE_LEVELS - 1;
    return &sc->frames[sc->loop[level * sc->steps + scene_step(sc, clock_ms)]];
}
// The frame's own offset at this level and clock (ht_pet_scene_t.step_dy), in px down.
static int scene_dy(const ht_pet_scene_t *sc, unsigned level, uint32_t clock_ms)
{
    if (!sc->step_dy) return 0;
    if (level >= HT_PET_SCENE_LEVELS) level = HT_PET_SCENE_LEVELS - 1;
    return sc->step_dy[level * sc->steps + scene_step(sc, clock_ms)];
}
// Where the scene's top-left sits on the glass: centred, `bias` px lower (the slot's own nudge), moved by its dx, dy.
static void scene_origin(const ht_pet_scene_t *sc, int bias, int *x, int *y)
{
    *x = (HT_WIDTH - sc->w) / 2 + sc->dx;
    *y = HT_HEIGHT / 2 - sc->h / 2 + bias + sc->dy;
}
// The scene's overlay as ONE run, in a slot that is empty whenever the scene shows: its frame at this level
// and clock, `at` px from the scene's origin; an empty text run when the scene has none.
static void scene_overlay(ht_scene_t *s, const ht_pet_scene_t *sc, int bias, unsigned level, uint32_t clock_ms,
                          const ht_font_t *font)
{
    if (!sc || !sc->overlay) { ht_text(s, 0, 0, 1, font, s->background, s->background, ""); return; }
    if (level >= HT_PET_SCENE_LEVELS) level = HT_PET_SCENE_LEVELS - 1;
    unsigned i = level * sc->steps + scene_step(sc, clock_ms);
    int x, y;
    scene_origin(sc, bias, &x, &y);
    ht_cell_sprite(s, x + sc->overlay->at[i][0], y + sc->overlay->at[i][1], &sc->overlay->frames[sc->overlay->loop[i]]);
}
/*
 * A scene's bars (pets.h ht_pet_bars_t): bar j's height at this clock and level, h = round(min + swing * a *
 * level / 4) with a = (sin(2 pi t / period + j * phase) + 1) / 2; the box is h + 1 px tall, top at cy - h / 2.
 */
enum { BARS_TICK_MS = 50 };    // redraw cadence while the bars move
static int bar_height(const ht_pet_bars_t *b, int j, unsigned level, uint32_t clock_ms)
{
    if (level >= HT_PET_SCENE_LEVELS) level = HT_PET_SCENE_LEVELS - 1;
    float t = (float)(clock_ms % b->period_ms);
    float a = (sinf(6.2831853f * t / (float)b->period_ms + (float)j * b->phase) + 1.0f) * 0.5f;
    return (int)floorf((float)b->min_h + (float)b->swing * a * (float)level / (float)(HT_PET_SCENE_LEVELS - 1) + 0.5f);
}
static void scene_bar(ht_scene_t *s, const ht_pet_scene_t *sc, int bias, int j, unsigned level, uint32_t clock_ms)
{
    const ht_pet_bars_t *b = sc->bars;
    int x, y, h = bar_height(b, j, level, clock_ms);
    scene_origin(sc, bias, &x, &y);
    ht_box(s, x + b->x[j], y + b->cy - h / 2, b->w, h + 1, b->radius, b->fill[j], b->fill[j]);
}
/*
 * A scene's waves (pets.h ht_pet_waves_t): arc k of side `side` (0 = right, 1 = left) at this clock and level, as a
 * ring arc over the scene's origin. u = (t / period + k / count) mod 1 carries it from r_far in to r_near; its
 * brightness a = sin(pi u) * (0.4 + 0.6 * level / 4) scales the colour over the black ground (opaque, no blend of
 * the colour with the ground), and below WAVE_HIDDEN it is not drawn: an empty ring in the same slot.
 */
enum { WAVES_TICK_MS = 50 };     // redraw cadence while the waves glide
static const float WAVE_HIDDEN = 0.12f;
static void scene_wave(ht_scene_t *s, const ht_pet_scene_t *sc, int bias, int side, int k, unsigned level, uint32_t clock_ms)
{
    const ht_pet_waves_t *w = sc->waves;
    if (level >= HT_PET_SCENE_LEVELS) level = HT_PET_SCENE_LEVELS - 1;
    float u = (float)(clock_ms % w->period_ms) / (float)w->period_ms + (float)k / (float)w->count;
    if (u >= 1.0f) u -= 1.0f;
    float a = sinf(3.14159265f * u) * (0.4f + 0.6f * (float)level / (float)(HT_PET_SCENE_LEVELS - 1));
    int x, y;
    scene_origin(sc, bias, &x, &y);
    int cx16 = x * 16 + w->cx16 + (side ? -w->gap16 : w->gap16), cy16 = y * 16 + w->cy16;
    if (a < WAVE_HIDDEN) { ht_ring_arc(s, cx16, cy16, 0, 0, 0, 0, 0); return; }
    int r16 = (int)floorf((float)w->r_far16 - (float)(w->r_far16 - w->r_near16) * u + 0.5f);
    unsigned c[3];
    for (int i = 0; i < 3; i++) c[i] = (unsigned)floorf((float)w->rgb[i] * a + 0.5f);
    ht_ring_arc(s, cx16, cy16, r16, w->w16, side ? 180 : 0, w->half_deg, ht_rgb(c[0] << 16 | c[1] << 8 | c[2]));
}
// A scene's shape k at this clock (pets.h ht_pet_shapes_t) as one ring arc over the scene's origin; an empty slot
// (w16 0) is an empty ring at its centre. The frame's step_dy moves the frame alone, not its shapes.
static void scene_shape(ht_scene_t *s, const ht_pet_scene_t *sc, int bias, unsigned k, uint32_t clock_ms)
{
    const ht_pet_shape_t *p = &sc->shapes->at[scene_step(sc, clock_ms) * sc->shapes->count + k];
    int x, y;
    scene_origin(sc, bias, &x, &y);
    ht_ring_arc(s, x * 16 + p->cx16, y * 16 + p->cy16, p->r16, p->w16, p->mid_deg, p->half_deg, p->rgb);
}
/*
 * THE LISTENING WORD on the lower arc of the voice face (owner, 2026-10-02: rhythm B, mockup/listening_arc.py):
 * the word at 30 % brightness, a band two letters wide sweeping left to right in 900 ms, then 400 ms at rest —
 * 1300 ms, drawn in 20 steps of 65 ms. Letter i is 0.3 + 0.7 * max(0, 1 - |i - head| / 2) bright, the head
 * -2 + (n + 4) * t / 900 letters along while sweeping. Integers: the head in 1/900 letters.
 */
#define LISTENING_WORD "Listening"
enum { SWEEP_MS = 900, SWEEP_PERIOD_MS = 1300, SWEEP_STEP_MS = 65, SWEEP_LETTERS = 9 };
_Static_assert(sizeof LISTENING_WORD - 1 == (unsigned)SWEEP_LETTERS && (int)SWEEP_LETTERS <= (int)HT_ARC_GAINS, "one gain per letter");
static void sweep_gains(uint32_t clock_ms, uint8_t gain[HT_ARC_GAINS])
{
    uint32_t t = clock_ms % SWEEP_PERIOD_MS / SWEEP_STEP_MS * SWEEP_STEP_MS;
    int head = t < SWEEP_MS ? -2 * SWEEP_MS + (SWEEP_LETTERS + 4) * (int)t : -100 * SWEEP_MS;
    for (int i = 0; i < HT_ARC_GAINS; i++) {
        int d = i * SWEEP_MS - head, near;
        if (d < 0) d = -d;
        near = 2 * SWEEP_MS - d;                      // 1 - |i - head| / 2, in 1/(2 * 900)
        if (near < 0) near = 0;
        gain[i] = i < SWEEP_LETTERS ? (uint8_t)((255 * (3 * 2 * SWEEP_MS + 7 * near) + 5 * SWEEP_MS) / (10 * 2 * SWEEP_MS)) : 255;
    }
}
// When the sweep's drawn gains next change, from this clock; 0 = never.
static uint32_t sweep_next_ms(uint32_t clock_ms)
{
    uint8_t now[HT_ARC_GAINS], then[HT_ARC_GAINS];
    sweep_gains(clock_ms, now);
    for (unsigned i = 1; i <= SWEEP_PERIOD_MS / SWEEP_STEP_MS; i++) {
        uint32_t at = (clock_ms / SWEEP_STEP_MS + i) * SWEEP_STEP_MS;
        sweep_gains(at, then);
        if (memcmp(now, then, sizeof now)) return at;
    }
    return 0;
}
// The listening scene, when this is the voice screen recording on an engine that has one.
static const ht_pet_scene_t *listening_scene(const ht_character_face_t *f)
{
    const ht_pet_t *pet = pet_for(f);
    return pet && f->voice && f->mood == HT_CHARACTER_LISTENING ? pet->listening_scene : NULL;
}
// The sending scene, when this is the voice screen sending (not recording) on an engine that has one.
static const ht_pet_scene_t *sending_scene(const ht_character_face_t *f)
{
    const ht_pet_t *pet = pet_for(f);
    return pet && f->voice && f->mood != HT_CHARACTER_LISTENING && !pet_holds(f) ? pet->sending_scene : NULL;
}
// Whether steps a and b of the loop starting at `at` draw the same: the scene's frame, its overlay's and its shapes.
static bool step_same(const ht_pet_scene_t *sc, unsigned at, unsigned a, unsigned b)
{
    if (sc->loop[at + a] != sc->loop[at + b]) return false;
    if (sc->step_dy && sc->step_dy[at + a] != sc->step_dy[at + b]) return false;
    if (sc->shapes)
        for (unsigned k = 0; k < sc->shapes->count; k++) {
            const ht_pet_shape_t *p = &sc->shapes->at[(at + a) * sc->shapes->count + k],
                                 *q = &sc->shapes->at[(at + b) * sc->shapes->count + k];
            if (p->cx16 != q->cx16 || p->cy16 != q->cy16 || p->r16 != q->r16 || p->w16 != q->w16 ||
                p->mid_deg != q->mid_deg || p->half_deg != q->half_deg || p->rgb != q->rgb) return false;
        }
    const ht_pet_overlay_t *o = sc->overlay;
    return !o || (o->loop[at + a] == o->loop[at + b] && o->at[at + a][0] == o->at[at + b][0] &&
                  o->at[at + a][1] == o->at[at + b][1]);
}
// When the scene's drawn frame (or its overlay) next changes, in the loop of this level; 0 = never.
static uint32_t scene_next_ms(const ht_pet_scene_t *sc, unsigned level, uint32_t clock_ms)
{
    uint32_t now = clock_ms / sc->step_ms;
    unsigned at = level * sc->steps;
    for (unsigned i = 1; i <= sc->steps; i++)
        if (!step_same(sc, at, (now + i) % sc->steps, now % sc->steps)) return (now + i) * sc->step_ms;
    return 0;
}

uint32_t ht_focus_pet_next_ms(const ht_character_face_t *f, const char *recap)
{
    const ht_pet_t *pet = pet_for(f);
    if (!pet || pet_holds(f)) return 0;
    if (f->voice) {
        const ht_pet_scene_t *ls = listening_scene(f);
        unsigned level = f->pose.level >= HT_PET_SCENE_LEVELS ? HT_PET_SCENE_LEVELS - 1 : f->pose.level;
        if (ls) {   // the scene's next frame or the word's next sweep step, whichever comes first
            uint32_t frame = scene_next_ms(ls, level, f->clock_ms), sweep = sweep_next_ms(f->clock_ms);
            if (ls->waves) {   // the arcs glide with the clock at every level (0.4 of the brightness at level 0)
                uint32_t tick = (f->clock_ms / WAVES_TICK_MS + 1) * WAVES_TICK_MS;
                if (!frame || tick < frame) frame = tick;
            }
            if (ls->bars && level) {   // the bars move with the clock: wake every tick (flat at level 0, no wake)
                uint32_t tick = (f->clock_ms / BARS_TICK_MS + 1) * BARS_TICK_MS;
                if (!frame || tick < frame) frame = tick;
            }
            return frame && frame < sweep ? frame : sweep;
        }
        const ht_pet_scene_t *ss = sending_scene(f);
        return ss ? scene_next_ms(ss, 0, f->clock_ms) : 0;
    }
    uint32_t alert_step;
    bool held;
    const ht_pet_scene_t *alert = alert_scene(f, recap, &alert_step, &held);
    const ht_pet_scene_t *sc = working_scene(f, recap);
    if (alert && !held && sc) {   // its next step (the last one then holds), or the work's next frame if that comes first
        uint32_t next = f->notice_ms + (alert_step + 1) * alert->step_ms, work = scene_next_ms(sc, 0, f->clock_ms);
        return work && work < next ? work : next;
    }
    if (sc) return scene_next_ms(sc, 0, f->clock_ms);
    const ht_pet_scene_t *rs = relaxing_scene(f, recap);
    if (rs) return scene_next_ms(rs, 0, f->clock_ms);
    ht_pet_state_t state = pet_state(f, recap);
    uint32_t each = pet->step_ms[state], now = f->clock_ms / each;
    unsigned steps = ht_pet_steps(pet);
    const ht_pet_step_t *cur = &pet->loops[state][now % steps];
    for (unsigned i = 1; i <= steps; i++) {
        const ht_pet_step_t *p = &pet->loops[state][(now + i) % steps];
        if (p->frame != cur->frame || p->dy != cur->dy) return (now + i) * each;
    }
    return 0;
}

bool ht_focus_engine_mark(const char *engine, char out[4], uint32_t *ink)
{
    if (!engine || !*engine) return false;
    for (unsigned i = 0; i < sizeof ENGINES / sizeof ENGINES[0]; i++) {
        if (strcmp(engine, ENGINES[i])) continue;
        uint32_t cp = HT_ENGINE_FIRST + i;
        *ink = ENGINE_INK[i];
        out[0] = (char)(0xe0 | (cp >> 12));
        out[1] = (char)(0x80 | ((cp >> 6) & 0x3f));
        out[2] = (char)(0x80 | (cp & 0x3f));
        out[3] = 0;
        return true;
    }
    return false;
}

/*
 * THE VOICE SCREEN: the waveform, or the three sparkles, and nothing else.
 *
 * The device drew it this way before habitat — a green meter on black while it listens, then three
 * marks while the words are on their way — and there is nothing else worth saying on a screen whose
 * whole job is to show that it is hearing you. So this branch emits the face's eight runs with the
 * other six empty, which is what keeps ht_damage() on its cheap path; see the note at the top.
 *
 * Nine bars from six heights, indexed by the 0..4 level that already reaches every skin through
 * pose.level. The shape is a hill: loud makes it taller, not wider.
 */
/*
 * THE RECORDING METER, as the old firmware drew it.
 *
 * Seven bars, six pixels wide, on a 22.4 px pitch about the screen's middle, resting at heights
 * 16/52/79/121/79/52/16 — the Figma measurements the deleted ui_screens.c carried — with a crest
 * travelling left to right. There it was seven LVGL rectangles whose heights an animation timer
 * drove every 40 ms; here each bar is one run of ht_wave, whose cell IS one bar in sixteen heights,
 * so the same picture costs seven runs and no allocation.
 *
 * The travelling wave is a table rather than a sine at runtime. The old tick advanced a phase 12°
 * every 40 ms and offset each bar by 40°, scaling its rest height between 0.35x and 1.0x; that is a
 * closed form over fifteen frames and seven bars, so it is evaluated once, by
 * scripts/gen_habitat_fonts.py's sibling arithmetic, and lives here as 105 bytes of level indices.
 * No trigonometry, no floating point, and the cycle is the old 1.2 s exactly — see
 * ht_focus_motion_tick for why fifteen frames at this duration land there.
 */
enum { WAVE_BARS = 7, WAVE_FRAMES = 15, WAVE_PITCH_X10 = 224 };
static const uint8_t WAVE[WAVE_FRAMES][WAVE_BARS] = {
    {  1,  6, 10, 14,  8,  3,  1 },
    {  1,  6, 10, 13,  6,  3,  0 },
    {  2,  6,  9, 11,  5,  2,  0 },
    {  2,  6,  8,  9,  4,  2,  1 },
    {  2,  6,  7,  7,  3,  2,  1 },
    {  2,  5,  5,  6,  3,  3,  1 },
    {  1,  4,  4,  5,  4,  4,  1 },
    {  1,  3,  3,  5,  5,  4,  2 },
    {  1,  2,  3,  6,  6,  5,  2 },
    {  1,  2,  4,  8,  7,  6,  2 },
    {  1,  2,  4, 10,  9,  6,  2 },
    {  0,  2,  6, 12,  9,  6,  1 },
    {  0,  3,  7, 14, 10,  6,  1 },
    {  1,  4,  8, 15,  9,  5,  1 },
    {  1,  5,  9, 15,  9,  4,  1 },
};

// One ht_wave codepoint as UTF-8. Sixteen levels, so this is never a multi-branch encoder.
static void wave_glyph(unsigned level, char out[4])
{
    uint32_t cp = HT_WAVE_FIRST + (level >= HT_WAVE_LEVELS ? HT_WAVE_LEVELS - 1 : level);
    out[0] = (char)(0xe0 | (cp >> 12));
    out[1] = (char)(0x80 | ((cp >> 6) & 0x3f));
    out[2] = (char)(0x80 | (cp & 0x3f));
    out[3] = 0;
}

static void no_text(ht_scene_t *s, const ht_font_t *font);

static void voice_face(ht_scene_t *s, const ht_character_face_t *f, uint8_t frame)
{
    bool listening = f->mood == HT_CHARACTER_LISTENING;
    // A pet with a listening scene (Claude's headphones Clawd) draws it, nodding with the mic level,
    // in place of the seven bars; its step follows the face's clock (140 ms), 0 when there is none.
    const ht_pet_scene_t *scene = listening ? listening_scene(f) : NULL;
    // Sending with one (Claude's Clawd posting a letter) takes the same slot, centred, and the sparkles go empty.
    const ht_pet_scene_t *launch = listening ? NULL : sending_scene(f);

    /*
     * ELEVEN RUNS, ALWAYS, IN THIS ORDER — seven bars, the scene's slot, three sparkles — whichever
     * half is showing; the bars are empty under a scene and the slot is empty without one. A scene's
     * extras sit in slots it leaves empty: the first bar's is the "Listening" arc (a listening scene), the
     * first sparkle's the scene's overlay (Codex's plane), after the scene's own run. A scene with BARS
     * (Codex's listening bubble) uses runs 0 (the arc), 1 (the bubble, before the scene: the robot's ink
     * never reaches the bubble's box, so the order does not show) and 8, 9, 10 (the three bar boxes, over
     * the bubble); the rest stay empty. A scene with WAVES (Muse's listening scene) uses run 0 (the arc),
     * runs 1-6 (its six ring arcs, three on the right then three on the left, before the scene: the body
     * never reaches the band, so the order does not show; an arc that is dim enough to be hidden is an
     * empty ring in its slot) and the scene's run 7; sparkles 8-10 stay empty.
     *
     * ht_damage() diffs run index against run index and repaints all 466x466 the moment the count or
     * the order moves, so the half that is idle is emitted empty rather than skipped. Recording and
     * sending are then a change of text and colour, not a reshape, and the damage is the cells that
     * actually moved.
     */
    int mid_y = (HT_HEIGHT - ht_wave.height) / 2;
    uint16_t voice = ht_rgb(HT_THEME_VOICE);
    for (int k = 0; k < WAVE_BARS; k++) {
        if (k == 0 && scene) {
            uint8_t gain[HT_ARC_GAINS];
            sweep_gains(f->clock_ms, gain);
            ht_arc_status_sweep(s, ht_rgb(FOCUS_VOICE), LISTENING_WORD, &ht_arc_inter_lower, gain);
            continue;
        }
        if (k == 1 && scene && scene->bars) {
            scene_overlay(s, scene, -6, f->pose.level, f->clock_ms, &ht_wave);
            continue;
        }
        if (scene && scene->waves && k >= 1 && k <= 2 * (int)scene->waves->count) {
            scene_wave(s, scene, -6, (k - 1) / scene->waves->count, (k - 1) % scene->waves->count, f->pose.level, f->clock_ms);
            continue;
        }
        char bar[4] = {0};
        if (listening && !scene) wave_glyph(WAVE[frame % WAVE_FRAMES][k], bar);
        int x = HT_WIDTH / 2 + (k - WAVE_BARS / 2) * WAVE_PITCH_X10 / 10 - ht_wave.width / 2;
        ht_text(s, x, mid_y, ht_wave.width, &ht_wave, voice, s->background, bar);
    }

    int sx, sy;
    if (scene) {
        scene_origin(scene, -6, &sx, &sy);
        ht_cell_sprite(s, sx, sy + scene_dy(scene, f->pose.level, f->clock_ms), scene_frame(scene, f->pose.level, f->clock_ms));
    } else if (launch) {
        scene_origin(launch, 0, &sx, &sy);
        ht_cell_sprite(s, sx, sy + scene_dy(launch, 0, f->clock_ms), scene_frame(launch, 0, f->clock_ms));
    } else no_text(s, &ht_wave);

    /*
     * And the sending sweep: three filled sparkles on a 66 px pitch, the lit one travelling across
     * them. That pitch and that artwork are the old screen's; what is gone is its 1.3x pop on the
     * lit mark, because a glyph has one size and scaling it would mean a second atlas for a state
     * that already reads from the colour alone. White idle, the meter's own green lit.
     */
    int spark_y = (HT_HEIGHT - ht_spark.height) / 2;
    int lit = (frame % WAVE_FRAMES) / 5;      // three steps, 200 ms each, per the old busy sweep
    for (int i = 0; i < 3; i++) {
        if (scene && scene->bars) {
            scene_bar(s, scene, -6, i, f->pose.level, f->clock_ms);
            continue;
        }
        if (i == 0 && (scene ? scene : launch) && (scene ? scene : launch)->overlay) {
            scene_overlay(s, scene ? scene : launch, scene ? -6 : 0, scene ? f->pose.level : 0, f->clock_ms, &ht_spark);
            continue;
        }
        ht_text(s, HT_WIDTH / 2 + (i - 1) * 66 - ht_spark.width / 2, spark_y,
                ht_spark.width, &ht_spark,
                listening || launch ? s->background : i == lit ? voice : f->foreground, s->background,
                listening || launch ? "" : HT_SPARK);
    }
}

/*
 * The microphone level, in one run.
 *
 * Nine cells, indexed by the 0..4 level that already reaches every skin through pose.level (fed from
 * audio_client_input_level()). Deliberately NOT a background-filled bar whose width tracks the
 * level: a run whose `w` changes every frame trips the reshape path in ht_damage() and forfeits
 * banded damage for the entire scene. A fixed-width string changes only its cells.
 */
static const char *meter(unsigned level)
{
    // Nine cells that grow outward from the middle. A mono cell has one height, so this is a shape
    // that widens rather than a waveform that rises — the honest version of the old face's bars.
    static const char *const bars[5] = {
        "    -    ", "   -|-   ", "  -|I|-  ", " -|III|- ", "-|IIIII|-"
    };
    return bars[level > 4 ? 4 : level];
}

// Placeholders that keep the run count constant: an invisible box and an empty text run.
static void no_box(ht_scene_t *s) { ht_box(s, 0, 0, 1, 1, 0, s->background, s->background); }
static void no_text(ht_scene_t *s, const ht_font_t *font)
{
    ht_text(s, 0, 0, 1, font, s->background, s->background, "");
}
/*
 * A laid-out label's lines as runs, `runs` of them always: line n at (x + its centring, y + n *
 * pitch). The line's bytes are the label's own, trailing space and all,
 * because LVGL centred on them.
 */
static void label_runs(ht_scene_t *s, const ht_lv_label_t *l, int runs, int x, int y, int pitch,
                       const ht_font_t *font, uint16_t ink, uint16_t bg)
{
    for (int n = 0; n < runs; n++) {
        if (n >= l->lines || !l->line[n].len) { no_text(s, font); continue; }
        const ht_lv_line_t *ln = &l->line[n];
        char text[HT_TEXT_BYTES];
        size_t len = ln->len < sizeof text ? ln->len : sizeof text - 1;
        memcpy(text, l->text + ln->at, len);
        while (len && (text[len - 1] == '\n' || text[len - 1] == '\r')) len--;
        text[len] = 0;
        ht_text(s, x + ln->x, y + n * pitch, ln->w > 0 ? ln->w : 1, font, ink, bg, text);
    }
}

// "34s", then "1m 05s" — the old firmware's fmt_elapsed.
static void elapsed_text(char *out, size_t cap, unsigned sec)
{
    if (sec < 60) snprintf(out, cap, "%us", sec);
    else snprintf(out, cap, "%um %02us", sec / 60, sec % 60);
}

/*
 * THE WORKING LINE. The verb is the engine's own when the cable carried one; "Working" — the
 * placeholder render_home() uses when it did not — becomes the old firmware's rotating gerund,
 * one every six seconds, so a long turn does not read as stuck on a word.
 */
static const char *const GERUNDS[] = {
    "Working", "Brewing", "Cooking", "Churning", "Frosting", "Simmering", "Tinkering",
    "Conjuring", "Composing", "Percolating", "Wrangling", "Hatching", "Concocting", "Puttering",
};
static const char *status_verb(const ht_character_face_t *f)
{
    const char *verb = f->activity;
    if (!strcmp(verb, "Working"))
        verb = GERUNDS[(f->elapsed / 6) % (sizeof GERUNDS / sizeof GERUNDS[0])];
    return verb;
}
static void status_text(char *out, size_t cap, const ht_character_face_t *f)
{
    const char *verb = status_verb(f);
    if (!f->elapsed) { snprintf(out, cap, "%s\xe2\x80\xa6", verb); return; }
    char when[16];
    elapsed_text(when, sizeof when, f->elapsed);
    snprintf(out, cap, "%s\xe2\x80\xa6 %s", verb, when);
}
/*
 * The working line where the room is short — the scene's lower arc (`arc` set: Inter Medium 26, measured
 * in px of arc length against `limit`) or its straight line (`font` set: `limit` px). The seconds always
 * survive: the verb is cut a letter at a time and its "…" doubles as the cut.
 */
static void status_fitted(char *out, size_t cap, const ht_character_face_t *f, const ht_font_t *font,
                          const ht_arc_face_t *arc, int limit)
{
    const char *verb = status_verb(f);
    char when[16] = "";
    if (f->elapsed) elapsed_text(when, sizeof when, f->elapsed);
    size_t n = strlen(verb);
    for (;;) {
        snprintf(out, cap, "%.*s\xe2\x80\xa6%s%s", (int)n, verb, when[0] ? " " : "", when);
        if ((arc ? ht_arc_measure(arc, out) : ht_measure(font, out)) <= limit || n <= 1) return;
        do n--; while (n > 1 && ((uint8_t)verb[n] & 0xc0) == 0x80);
        while (n > 1 && verb[n - 1] == ' ') n--;
    }
}

/*
 * The recap as the face reads it: cut to the octopus's ninety codepoints, then a glyph at a time until
 * it fits four lines with its "…" — measured, since ninety short words can still need five.
 */
static void recap_cut(char *out, size_t cap, const char *recap, const ht_font_t *font, int width)
{
    size_t n = 0, glyphs = 0;
    while (recap[n] && glyphs < HT_CHARACTER_RECAP_CHARS) {
        size_t k = n + 1;
        while (recap[k] && ((uint8_t)recap[k] & 0xc0) == 0x80) k++;
        if (k + 4 > cap) break;
        n = k;
        glyphs++;
    }
    bool clipped = recap[n] != 0;
    memcpy(out, recap, n);
    out[n] = 0;
    ht_lv_label_t l;
    for (;;) {
        char probe[HT_TEXT_BYTES + 4];
        snprintf(probe, sizeof probe, "%s%s", out, clipped ? "\xe2\x80\xa6" : "");
        if (ht_lv_label(&l, font, probe, width, RECAP_LINES, false) <= RECAP_LINES || !out[0]) break;
        size_t k = strlen(out);
        do k--; while (k > 0 && ((uint8_t)out[k] & 0xc0) == 0x80);
        while (k > 0 && out[k - 1] == ' ') k--;
        out[k] = 0;
        clipped = true;
    }
    if (clipped) strcat(out, "\xe2\x80\xa6");
}

void ht_focus_face(ht_scene_t *s, const ht_character_face_t *f, uint8_t frame, uint16_t ink,
                   const char *recap)
{
    (void)ink;
    if (f->voice) { resting.showing = false; voice_face(s, f, frame); return; }
    bool has_recap = recap && *recap;
    bool working = !has_recap && f->activity && *f->activity;
    bool retry = !has_recap && !working && f->status && *f->status;

    // The live line: listening meter, the working verb and its seconds, or a status of its own.
    const ht_font_t *sf = &ht_lv_inter_30.base, *ef = &ht_lv_inter_36.base,
                    *rf = &ht_lv_inter_30.base;
    char status[HT_TEXT_BYTES] = "";
    if (!has_recap && f->mood == HT_CHARACTER_LISTENING) snprintf(status, sizeof status, "%s", meter(f->pose.level));
    else if (working) status_text(status, sizeof status, f);
    else if (retry) snprintf(status, sizeof status, "%s", f->status);
    bool empty = !has_recap && !status[0];
    if (!empty) resting.showing = false;
    const ht_pet_scene_t *relax = empty ? relaxing_scene(f, recap) : NULL;

    // The body, laid out first.
    ht_lv_label_t body;
    int recap_h = 0, recap_n = 0;
    if (has_recap) {
        char cut[HT_TEXT_BYTES];
        recap_cut(cut, sizeof cut, recap, rf, RECAP_W);
        int n = ht_lv_label(&body, rf, cut, RECAP_W, RECAP_LINES, false);
        if (n > RECAP_LINES) n = RECAP_LINES;
        recap_h = n * RECAP_PITCH;
        recap_n = n;
    } else if (status[0]) {
        ht_lv_label(&body, sf, status, COL_W, 1, true);
    } else if (relax) {
        body.lines = 0;                                  // nothing in the middle: the line is on the lower arc
    } else {
        ht_lv_label(&body, ef, resting_line(f), EMPTY_W, 2, false);
    }
    // A recap's block is centred in its fixed area, its first baseline RECAP_BASELINE under the block's
    // top; a line without a recap is centred on the glass.
    int body_y = has_recap ? RECAP_AREA_Y + (RECAP_AREA_H - recap_h) / 2 + RECAP_BASELINE - ht_pfont(rf)->ascent
                           : HT_HEIGHT / 2 - sf->height / 2;
    /*
     * THE MARK BETWEEN THE NAME AND THE RECAP (owner, 2026-10-05): a short recap is centred in the four lines' area,
     * so a mark halfway to the AREA's top left a wide gap under it. It is centred between the name and the recap's
     * first line as drawn (its capitals' top), and a pet grows into the room a short recap leaves: 2x over one line,
     * 1.75x over two, 1.5x over three (one 2x drawing, zoomed: pets.h `cells`). Without a recap, halfway to the line,
     * or resting, where a four-line recap puts it.
     */
    // Resting (no recap, no line of status) the mark stands where a full recap's does (design 2026-10-06, focus-
    // project.html "Rest": "same position as Recap"); a pet is centred over the resting line itself, its capitals'
    // top, like over a recap, and over a working line its capitals too (owner, 2026-10-07: from the full recap's place
    // it stood 35 px under the name and 66 over "Tap to talk").
    int full_cap = RECAP_AREA_Y + (RECAP_AREA_H - RECAP_LINES * RECAP_PITCH) / 2 + RECAP_BASELINE - RECAP_CAP;
    int rest_cap = body_y + ht_pfont(ef)->ascent - EMPTY_CAP;
    // A status of its own ("Try again" after a failed voice turn) is one line in the middle: the mark sizes and sits
    // as over a one-line recap (owner, 2026-10-06).
    // The recap's card: the full column, as tall as its lines (owner, 2026-10-07: "not fixed at four like before"), with
    // as much room over the first line's capitals and under the last line's baseline as from one line's baseline to the
    // next one's capitals (43 - 22 = 21 px; recap_pad.py P1). What stands above it is measured to its top.
    int card_pad = RECAP_PITCH - RECAP_CAP;
    int card_top = body_y + ht_pfont(rf)->ascent - RECAP_CAP - card_pad;
    int card_h = RECAP_CAP + (recap_n - 1) * RECAP_PITCH + 2 * card_pad;
    int below = has_recap ? card_top : retry ? body_y + ht_pfont(rf)->ascent - RECAP_CAP : empty ? full_cap : body_y;
    int size = retry ? 2 : has_recap && recap_n >= 1 && recap_n <= 3 ? 3 - recap_n : -1;   // 0 1.5x, 1 1.75x, 2 2x; -1 1x
    // Claude's block of a body reads larger than the others at the same size (owner, 2026-10-06): it stays at 1.5x
    // resting and over a recap of one to three lines, and 1x over four.
    if (f->engine && !strcmp(f->engine, "claude") && ((has_recap && recap_n <= 3) || empty || retry)) size = 0;
    // Codex's robot reads small at 1x over a full recap, and 1.5x was too big (owner, 2026-10-06): over four lines it is
    // 1.25x (the eighths nearest the asked 1.3x), placed like the sizes over a shorter recap.
    bool codex_full = f->engine && !strcmp(f->engine, "codex") && has_recap && recap_n >= 4;
    if (codex_full) size = 0;
    // Codex with no activity yet is 2x, as over a one-line recap (owner, 2026-10-07: 1x read small there).
    if (f->engine && !strcmp(f->engine, "codex") && empty) size = 2;
    int mark_top = TITLE_BOTTOM + (below - TITLE_BOTTOM - MARK_SIZE) / 2;

    // The name on the top curve, the octopus's arc; a tap there opens the pane list.
    int title_run = s->count;
    ht_arc_title_face(s, ht_rgb(FOCUS_FG), f->recipient && *f->recipient ? f->recipient : "\xe2\x80\xa6",
                      &ht_arc_inter_prop);

    // The engine's mark, where the octopus stands. An unknown engine leaves the place empty.
    int engine = ht_focus_engine_index(f->engine);
    int mark_x = (HT_WIDTH - MARK_SIZE) / 2;
    const ht_pet_t *pet = pet_for(f);
    const ht_pet_scene_t *scene = working_scene(f, recap);
    uint32_t alert_step = 0;
    const ht_pet_scene_t *alert = scene ? alert_scene(f, recap, &alert_step, NULL) : NULL;   // never without its scene
    ht_rect_t drawn_alert;
    bool coded = !alert && code_alert(f, recap, &drawn_alert);   // a custom pet's alert, drawn in code
    if (scene || relax) {
        // The working (or relaxing) scene in the mark's slot: centred on the glass, a touch low for its hat.
        const ht_pet_scene_t *sc = scene ? scene : relax;
        int sx, sy;
        scene_origin(sc, 4, &sx, &sy);
        ht_cell_sprite(s, sx, sy + scene_dy(sc, 0, f->clock_ms), scene_frame(sc, 0, f->clock_ms));
    } else if (pet) {
        // The engine's pet, centred in the mark's box, lifted by its step's hop.
        bool hold = pet_holds(f);
        ht_pet_state_t state = hold ? HT_PET_IDLE : pet_state(f, recap);
        unsigned step = hold ? 0 : (f->clock_ms / pet->step_ms[state]) % ht_pet_steps(pet);
        const ht_pet_step_t *p = &pet->loops[state][step];
        if (pet->cells) {
            // One 2x drawing, shown at 1x — or larger over a short recap, centred between the name and the recap's
            // first line, its hop scaled with it (zoom in eighths of the drawing: 4 = 1x, 6, 7, 8 = 2x).
            static const uint8_t zooms[4] = {4, 6, 7, 8};
            const ht_cell_frame_t *fr = &pet->cells[p->frame];
            int z = codex_full ? 5 : zooms[size + 1];
            int pw = (fr->cols * fr->cell * z + 7) / 8, ph = (fr->rows * fr->cell * z + 7) / 8;
            // Centred by its ink, not its box (Codex's robot has empty rows over its head), and by the loop's first
            // frame, so a pose that reaches higher does not move the pet.
            int r0, r1;
            cell_ink_rows(&pet->cells[pet->loops[state][0].frame], &r0, &r1);
            int ink_top = r0 * fr->cell * z / 8, ink_h = (r1 - r0) * fr->cell * z / 8;
            if (ink_h <= 0) { ink_top = 0; ink_h = ph; }
            int px = (HT_WIDTH - pw) / 2, top = title_foot(s, title_run, pw / 2), foot = empty ? rest_cap : status[0] && !has_recap && !retry ? body_y + ht_pfont(sf)->ascent - RECAP_CAP : below;
            int py = top + (foot - top - ink_h) / 2 - ink_top + p->dy * z / 4;
            ht_cell_sprite_zoom(s, px, py, fr, (unsigned)z);
        } else {
            int px = (HT_WIDTH - pet->w) / 2, py = mark_top + (MARK_SIZE - pet->h) / 2 + p->dy;
            ht_icon(s, px, py, &pet->frames[p->frame]);
        }
    } else if (engine >= 0) ht_icon(s, mark_x, mark_top, &ht_icon_engine56[engine]);
    else no_text(s, rf);

    // The card under a recap; without one its run stays, invisible, so the run count and order never change.
    if (has_recap) ht_box(s, COL_X, card_top, COL_W, card_h, CARD_R, ht_rgb(FOCUS_CARD), ht_rgb(FOCUS_CARD_RIM));
    else no_box(s);

    if (has_recap) label_runs(s, &body, RECAP_LINES, RECAP_X, body_y, RECAP_PITCH, rf, ht_rgb(FOCUS_RECAP),
                              ht_rgb(FOCUS_CARD));
    else for (int n = 0; n < RECAP_LINES; n++) {
        // The scene's overlay takes the first line's slot, empty without a recap; the alert's bubble the second, its
        // count the third.
        int sx = 0, sy = 0;
        if (alert && scene) scene_origin(scene, 4, &sx, &sy);
        if (alert && n == 1) {
            ht_cell_sprite(s, sx + alert->overlay->at[alert_step][0], sy + alert->overlay->at[alert_step][1],
                           &alert->overlay->frames[alert->overlay->loop[alert_step]]);
        } else if (alert && n == 2 && (alert->count_at[alert_step][0] || alert->count_at[alert_step][1])) {
            const ht_cell_frame_t *b = &alert->overlay->frames[alert->overlay->loop[alert_step]];
            // One digit in Inter Medium 26; "9+" for more, smaller, so it stays clear of the bell in the same slot.
            const ht_font_t *cf = f->notices > 9 ? &ht_lv_inter_20.base : &ht_lv_inter_med_26.base;
            char count[4];
            if (f->notices > 9) snprintf(count, sizeof count, "9+");
            else snprintf(count, sizeof count, "%u", (unsigned)f->notices);
            int cw = ht_measure(cf, count), cx = sx + alert->count_at[alert_step][0], cy = sy + alert->count_at[alert_step][1];
            // On the bubble's own fill: the colour under the slot's centre in the step's frame (panel order there).
            uint16_t p = b->palette[ht_cell_at(b, (cx - sx - alert->overlay->at[alert_step][0]) / b->cell,
                                               (cy - sy - alert->overlay->at[alert_step][1]) / b->cell)];
            uint16_t fill = (uint16_t)((p >> 8) | (p << 8));
            ht_text(s, cx - cw / 2, cy - cf->height / 2, cw, cf, ht_rgb(0x006fff), fill, count);
        } else if (coded && n == 1) {
            ht_box(s, drawn_alert.x, drawn_alert.y, ALERT_W, ALERT_H, ALERT_R, ht_rgb(ALERT_BLUE), ht_rgb(ALERT_BLUE));
        } else if (coded && n == 2) {
            // The built-in count's fonts; on this blue bubble the digit is the soft white of the bell pill's.
            const ht_font_t *cf = f->notices > 9 ? &ht_lv_inter_20.base : &ht_lv_inter_med_26.base;
            char count[4];
            if (f->notices > 9) snprintf(count, sizeof count, "9+");
            else snprintf(count, sizeof count, "%u", (unsigned)f->notices);
            int cw = ht_measure(cf, count);
            ht_text(s, drawn_alert.x + (ALERT_W - cw) / 2, drawn_alert.y + (ALERT_H - cf->height) / 2, cw, cf,
                    ht_rgb(FOCUS_FG), ht_rgb(ALERT_BLUE), count);
        } else if (n == 0 && (scene ? scene : relax) && (scene ? scene : relax)->overlay)
            scene_overlay(s, scene ? scene : relax, 4, 0, f->clock_ms, rf);
        else no_text(s, rf);
    }

    // The scene's status: on the lower curve (the bell pill is raised clear of it), or — when a footer
    // control has the bottom edge — a straight line under the scene, in this same slot.
    bool taken = f->footer_action;
    if (scene && taken) {
        const ht_font_t *lf = &ht_lv_inter_30.base;
        char line[HT_TEXT_BYTES];
        status_fitted(line, sizeof line, f, lf, NULL, COL_W);
        ht_lv_label_t l;
        ht_lv_label(&l, lf, line, COL_W, 1, false);
        label_runs(s, &l, 1, COL_X, SCENE_LINE_Y, 0, lf, ht_rgb(FOCUS_VOICE), s->background);
    } else if (status[0] && !scene)
        label_runs(s, &body, 1, COL_X, body_y, 0, sf,
                   ht_rgb(retry ? FOCUS_FG : FOCUS_VOICE), s->background);
    else no_text(s, sf);

    // Nothing yet: said in the resting grey. With nothing standing above it (no pet, no mark: design 2026-10-06
    // "No pane"), its lines are 50 px apart and centred on the glass, each baseline where a browser puts Inter's.
    bool bare = !pet && engine < 0;
    if (empty && bare) {
        int n = body.lines < 2 ? body.lines : 2, top = HT_HEIGHT / 2 - n * 50 / 2;
        label_runs(s, &body, 2, (HT_WIDTH - EMPTY_W) / 2, top + 25 + 36 * 93 / 256 - ht_pfont(ef)->ascent, 50, ef,
                   ht_rgb(FOCUS_EMPTY), s->background);
    } else if (empty && !relax) label_runs(s, &body, 2, (HT_WIDTH - EMPTY_W) / 2, body_y, ef->height, ef,
                                     ht_rgb(FOCUS_EMPTY), s->background);
    else { no_text(s, ef); no_text(s, ef); }

    // The scene's status on the lower curve (or in the slot above when a footer has the bottom); an empty slot otherwise (the count never moves).
    int before = s->count;
    if (scene && !taken) {
        char arc[HT_TEXT_BYTES];
        status_fitted(arc, sizeof arc, f, NULL, &ht_arc_inter_lower, HT_ARC_SPAN);
        ht_arc_status_face(s, ht_rgb(FOCUS_VOICE), arc, &ht_arc_inter_lower);
    } else if (relax && !f->notices && !f->footer_action)
        // The relaxing face's one line, in the working line's arc and font, quiet grey. Left out (an empty slot) when
        // the bell pill (y 400, notices > 0; this face has no bubble to tell them) or a footer control (y 389..439)
        // has the lower edge.
        ht_arc_status_face(s, ht_rgb(FOCUS_REST), relaxing_line(f), &ht_arc_inter_lower);
    if (s->count == before) no_text(s, sf);

    // The relaxing scene's shapes (Claude's balls, Muse's beach ball), after the eleven: the same count every step.
    if (relax && relax->shapes)
        for (unsigned k = 0; k < relax->shapes->count; k++) scene_shape(s, relax, 4, k, f->clock_ms);
}

void ht_focus_portrait(ht_scene_t *s, const ht_character_face_t *f, uint8_t frame, uint16_t ink,
                       ht_character_size_t size, int y)
{
    (void)frame;
    (void)size;
    const char *name = f->recipient ? f->recipient : "";
    ht_center(s, y, &ht_mono_28, ink, name);
}

bool ht_focus_motion_tick(ht_character_motion_t *m, uint32_t now, ht_character_mood_t mood,
                          bool quiet, bool visible, bool down, int x, unsigned level,
                          uint32_t activity)
{
    /*
     * Fifteen frames, and only the voice screen spends them.
     *
     * Nothing on the home face moves but the pet, which runs on clock_ms, not on these
     * frames — a skin whose subject is the work should not fidget. These are
     * the recording meter and the sending sweep, both of which the old firmware animated, and the
     * duration is picked so each lands on the cadence it had there.
     *
     * ht_character_motion_step halves the rate while the mood is LISTENING or IDLE, which is exactly
     * the mood ui_habitat.c reports while the microphone is open. So 600 ms of phase over fifteen
     * frames is 40 ms a frame recording — the old wave_tick's timer period, 1.2 s for a full
     * travelling cycle — and 20 ms a frame sending, where the sweep steps every fifth frame and so
     * holds each sparkle for the same 200 ms the old busy sweep did.
     *
     * `ends` are cumulative marks in that phase, not frame numbers. An earlier version listed
     * 1..6 against a 900 ms duration, which put every frame boundary inside the first six
     * milliseconds and left the animation parked on its last frame for the rest of the cycle —
     * a screen that looked as dead as the `frames = 1` it replaced.
     */
    static const uint16_t ends[] = { 40, 80, 120, 160, 200, 240, 280, 320,
                                     360, 400, 440, 480, 520, 560, 600 };
    static const ht_character_animation_t sweep = { 15, 600, ends };
    return ht_character_motion_step(m, &sweep, now, mood, quiet, visible, down, x, level,
                                    activity, true);
}
