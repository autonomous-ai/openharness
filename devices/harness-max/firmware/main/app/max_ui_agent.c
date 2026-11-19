// The agent page (max_ui_draw.h), one page for reading and talking. The strip on top: Back (the chevron, the app's
// icon and name) and a segment per agent of the ring with its rail, the agent shown bold on a thicker, glowing one.
// Under it, left, the pet (headphones on while it listens) in a faint glow of its engine's colour, and the engine's
// name. Right of it, an agent not at work: "status · ago", what it last said (else "What's next?") and "Tap to talk";
// one at work: its spinner word large, its activity, its last steps, and at the right its turn's clock over a flow bar.
// While a recording is up the band takes the bottom: "Listening" and its clock, the waveform of the mic's level, "Tap
// to send" with the ring that fills in the quiet, and X; above it the words stay, smaller.
#include <stdio.h>
#include <string.h>

#include "max_ui_draw.h"

enum {
    STRIP_H = DY(52), BACK_W = DX(260), WHO_W = DX(260), BODY_Y = STRIP_H,
    BACK_ICON = DY(24), BACK_APP = DY(30), SEG_RAIL = DY(4), SEG_RAIL_ON = DY(6), SEG_GLOW = DY(18), SEG_CY = DY(33),
    PET_HALF = DX(110), PET_H = DY(186), PET_FOOT = DY(262), PET_FOOT_TALK = DY(279), ENGINE_CY = DY(287),
    CLOSE_HALF = WHO_W / 2 - DX(4), CLOSE_H = DY(196),
    MAIN_X = WHO_W + DX(44), MAIN_R = HT_WIDTH - DX(56), ANSWER_W = DX(1080),
    HINT_R = HT_WIDTH - DX(30), HINT_CY = HT_HEIGHT - DY(28), HINT_MIC = DY(22),
    SIDE_X = HT_WIDTH - DX(300), STEP_DOT = DY(10), STEPS_CY = HT_HEIGHT - DY(35), FLOW_H = DY(3),
    BAND_H = DY(118), BAND_Y = HT_HEIGHT - BAND_H, BAND_X = MAIN_X,
    LISTEN_CY = BAND_Y + DY(38), TALK_CLOCK_CY = BAND_Y + DY(75), LISTEN_DOT = DY(12),
    WAVE_X = BAND_X + DX(150) + DX(24), WAVE_R = HT_WIDTH - DX(26) - DX(250) - DX(24), WAVE_CY = BAND_Y + DY(39),
    WAVE_HALF = DY(26), SAY_CY = BAND_Y + DY(89),
    X_D = DY(52), X_CX = HT_WIDTH - DX(26) - X_D / 2, BAND_CY = BAND_Y + BAND_H / 2, RING_D = DY(30),
};

// ---- the strip ----

static void strip(ht_scene_t *s, const max_agent_t *shown)
{
    ht_pro_rect(s, 0, STRIP_H - 1, HT_WIDTH, 1, 0, C(LINE));
    ht_pro_rect(s, BACK_W - 1, 0, 1, STRIP_H, 0, C(LINE));
    const int cy = STRIP_H / 2;
    max_icon_back(s, DX(16), cy - BACK_ICON / 2, BACK_ICON, DIM);
    const max_app_t *app = max_shown_app();
    int x = DX(50);
    if (app) {
        max_app_icon(s, x, cy - BACK_APP / 2, BACK_APP, app->id, app->name);
        x += BACK_APP + DX(10);
    }
    max_text(s, x, cy, BACK_W - x - DX(12), &ph_sb_26, DIM, max_app_label());
    max_hit(0, 0, BACK_W, STRIP_H, MAX_HIT_BACK, 0);
    int v[MAX_SEGS];
    const int n = max_segs(v), w = n ? (HT_WIDTH - BACK_W) / n : 0;
    for (int i = 0; i < n; i++) {
        const max_agent_t *a = &max_m.agents[v[i]];
        const bool on = a == shown;
        const int sx = BACK_W + i * w, sw = i == n - 1 ? HT_WIDTH - sx : w;
        const unsigned ink = max_rail_ink(a);
        if (i) ht_pro_rect(s, sx, 0, 1, STRIP_H - 1, 0, C(LINE));
        if (on && a->state != MAX_IDLE)   // the shown one's rail glows down into its segment
            pod_grad_aa(s, sx, SEG_RAIL_ON, sw, SEG_GLOW, 0, C(max_mix(ink, GROUND, 30)), C(GROUND));
        ht_pro_rect(s, sx, 0, sw, on ? SEG_RAIL_ON : SEG_RAIL, 0, C(on ? ink : max_mix(ink, GROUND, 50)));
        max_text_centered(s, sx + sw / 2, SEG_CY, sw - DX(20), &ph_sb_22, on ? FG : FAINT, a->name);
        max_copy(max_m.seg_id[i], sizeof max_m.seg_id[i], a->id);
        max_hit(sx, 0, sw, STRIP_H, MAX_HIT_SEG, i);
    }
}

// ---- who: the pet and its engine ----

static void who(ht_scene_t *s, const max_agent_t *a, bool talking, uint32_t now_ms)
{
    ht_pro_rect(s, WHO_W - 1, BODY_Y, 1, HT_HEIGHT - BODY_Y, 0, C(LINE));
    const unsigned e = max_engine_ink(a->engine);
    const int cx = WHO_W / 2, cy = (BODY_Y + HT_HEIGHT) / 2;
    // The engine's faint glow, brightest behind the pet: dithered ramps, as light this faint bands in RGB565.
    const unsigned lo = max_mix(e, GROUND, 3), hi = max_mix(e, GROUND, 10);
    pod_grad_aa_dither(s, 0, BODY_Y, WHO_W - 1, cy - BODY_Y, 0, C(lo), C(hi));
    pod_grad_aa_dither(s, 0, cy, WHO_W - 1, HT_HEIGHT - cy, 0, C(hi), C(lo));
    const pod_scene_t scene = max_pet_scene(a, true);
    // Listening, the pet is the mockup's close-up: as large as the column holds. (Sending, its scene is wider than the
    // pet: its mailbox would run into the words.)
    const bool close = scene == POD_SCENE_LISTEN;
    max_pet(s, a->engine, scene, cx, talking ? PET_FOOT_TALK : PET_FOOT, close ? CLOSE_HALF : PET_HALF,
            close ? CLOSE_H : PET_H, hi, now_ms, false);
    max_motion(now_ms, max_pet_next_ms(a->engine, scene, now_ms));
    if (talking) return;   // the band needs the room: the engine's name goes
    char label[24];
    max_text_centered(s, cx, ENGINE_CY, WHO_W - 20, &ph_sb_22, e, max_engine_label(label, sizeof label, a->engine));
}

// ---- an agent not at work: what it last said ----

// What it last said: its question, its failure or its summary; NULL for nothing.
static const char *last_said(const max_agent_t *a)
{
    if (a->state == MAX_ASKING && a->question[0]) return a->question;
    return a->note[0] && a->state != MAX_WORKING ? a->note : NULL;
}

static void reading(ht_scene_t *s, const max_agent_t *a, bool talking, uint32_t now_ms)
{
    const ht_pro_font_t *top_f = &ph_rg_28, *say_f = &ph_rg_36;
    const char *said = last_said(a);
    char rows[3][ROW_BYTES];
    const int width = MAIN_R - MAIN_X < ANSWER_W ? MAIN_R - MAIN_X : ANSWER_W;
    const int n = said ? max_wrap(rows, talking ? 2 : 3, said, say_f, width) : 1;
    if (!said) snprintf(rows[0], sizeof rows[0], "What's next?");
    // The status line over the words, the pair centred in the page (from its top while the band is up).
    const int top_h = top_f->height * 4 / 5, gap = DY(8), block = top_h + gap + n * say_f->height;
    int y = talking ? BODY_Y + DY(22) : BODY_Y + DY(20) + (HT_HEIGHT - DY(30) - BODY_Y - DY(20) - block) / 2;
    const int x = MAIN_X + max_text(s, MAIN_X, y + top_h / 2, width / 2, top_f, max_state_ink(a), max_status_word(a));
    if (a->since_ms) {
        char ago[24];
        max_ago(ago, sizeof ago, a->since_ms, now_ms);
        max_text(s, x + DX(16), y + top_h / 2, width / 2, top_f, FAINT, ago);
    }
    y += top_h + gap;
    for (int i = 0; i < n; i++)
        ht_pro_text(s, MAIN_X, y + i * say_f->height, width, say_f, C(said ? RECAP : REST), rows[i]);
}

// "Tap to talk" at the bottom right ("Mic closed · tap to talk" once the clock closed it on nothing heard); for an
// agent the bar cannot record for, where to talk to it instead.
static void talk_hint(ht_scene_t *s, const max_agent_t *a)
{
    if (max_takes_voice(a)) {
        const bool closed = max_m.talk_closed && !strcmp(max_m.talk_id, a->id);
        const int w = max_text_right(s, HINT_R, HINT_CY, DX(420), &ph_rg_24, REST,
                                     closed ? "Mic closed \xc2\xb7 tap to talk" : "Tap to talk");
        max_icon_mic(s, HINT_R - w - DX(8) - HINT_MIC, HINT_CY - HINT_MIC / 2, HINT_MIC, REST);
        return;
    }
    const char *app = max_app_of(a);
    char where[CABLE_NAME_MAX + 24];
    snprintf(where, sizeof where, "Talk to it %s%s", app[0] ? "in " : "on the computer", app);
    max_text_right(s, HINT_R, HINT_CY, DX(600), &ph_rg_24, REST, where);
}

// ---- an agent at work ----

// The last steps, oldest first, the newest lit; each a dot and its words.
static void steps(ht_scene_t *s, const max_agent_t *a)
{
    const int gap = DX(28), each = (SIDE_X - DX(30) - MAIN_X - 2 * gap) / MAX_STEPS;
    int x = MAIN_X;
    for (int i = a->step_count - 1; i >= 0; i--) {
        const bool now = i == 0;
        if (now) {
            const int ring = STEP_DOT + DY(8);
            ht_pro_rect_aa(s, x - (ring - STEP_DOT) / 2, STEPS_CY - ring / 2, ring, ring, ring / 2,
                           C(max_mix(ACCENT, GROUND, 25)));
        }
        max_dot(s, x, STEPS_CY, STEP_DOT, now ? ACCENT : FAINT);
        const int tx = x + STEP_DOT + DX(10);
        x = tx + max_text(s, tx, STEPS_CY, each - STEP_DOT - DX(10), &ph_rg_24, now ? FG : FAINT, a->steps[i]) + gap;
    }
}

// The flow bar along the page's foot: a dim track and a lavender glow in its middle.
static void flow(ht_scene_t *s)
{
    static const unsigned SHADES[] = {20, 45, 100, 45, 20};
    const int y = HT_HEIGHT - FLOW_H, w = HT_WIDTH - WHO_W, part = w * 3 / 10 / 5;
    ht_pro_rect(s, WHO_W, y, w, FLOW_H, 0, C(FLOW));
    for (int i = 0; i < 5; i++)
        ht_pro_rect(s, WHO_W + (w - 5 * part) / 2 + i * part, y, part, FLOW_H, 0, C(max_mix(ACCENT, FLOW, SHADES[i])));
}

static void working(ht_scene_t *s, const max_agent_t *a, bool talking, uint32_t now_ms)
{
    const int side_bottom = talking ? BAND_Y : HT_HEIGHT;
    ht_pro_rect(s, SIDE_X, BODY_Y, 1, side_bottom - BODY_Y, 0, C(LINE));
    char clock[24];
    max_fmt_elapsed(clock, sizeof clock, max_secs(a, now_ms));
    if (clock[0]) {
        const ht_pro_font_t *f = talking ? &ph_sb_48 : &ph_bd_84;
        const int cy = talking ? BODY_Y + DY(51) : (BODY_Y + HT_HEIGHT) / 2;
        max_clock(s, (SIDE_X + HT_WIDTH - max_clock_w(f, clock)) / 2, cy, f, FG, clock);
    }
    // The spinner word in the large face when it can draw it, the activity under it.
    const char *verb = max_status_word(a);
    const ht_pro_font_t *vf = max_big_can_draw(verb) ? &ph_sb_48 : &ph_sb_34;
    const int w = SIDE_X - DX(30) - MAIN_X, verb_cy = BODY_Y + (talking ? DY(18) : DY(24)) + 34;
    max_text(s, MAIN_X, verb_cy, w, vf, ACCENT, verb);
    max_text(s, MAIN_X, verb_cy + 34 + DY(4) + 18, w, &ph_rg_28, REST, a->activity);
    if (talking) return;   // the band takes the foot: no steps, no flow
    steps(s, a);
    flow(s);
}

// ---- the band ----

// The waveform: one bar per level the mic gave, newest at the right, tallest in the middle as the mockup's shape.
static void waveform(ht_scene_t *s)
{
    // sin(pi u)^1.4 at MAX_LEVELS points, in percent: the mockup's envelope.
    static const uint8_t SHAPE[MAX_LEVELS] = {
        0, 3, 8, 13, 18, 24, 29, 35, 40, 46, 51, 56, 61, 66, 70, 75, 79, 82, 86, 89, 92, 94, 96, 98,
        98, 96, 94, 92, 89, 86, 82, 79, 75, 70, 66, 61, 56, 51, 46, 40, 35, 29, 24, 18, 13, 8, 3, 0};
    const int pitch = (WAVE_R - WAVE_X) / MAX_LEVELS, bw = pitch * 3 / 5;
    for (int i = 0; i < MAX_LEVELS; i++) {
        const int k = max_m.level_count - MAX_LEVELS + i;
        const int level = k >= 0 ? max_m.levels[k] : 0;
        int half = WAVE_HALF * SHAPE[i] * level / (100 * 4);
        if (half < 2) half = 2;   // a dash where it is quiet
        ht_pro_rect(s, WAVE_X + i * pitch, WAVE_CY - half, bw, 2 * half, 0, C(max_mix(VOICE, GROUND, 40 + 60 * SHAPE[i] / 100)));
    }
}

// The send ring: a dark track, and the green that fills it from the top while the person is quiet after speaking.
static void send_ring(ht_scene_t *s, int cx, uint32_t now_ms)
{
    const int r16 = (RING_D - RING_D * 3 / 22) * 8, w16 = RING_D * 3 * 16 / 22, cx16 = cx * 16, cy16 = BAND_CY * 16;
    pod_arc(s, cx16, cy16, r16, w16, 0, 180, C(TRACK));
    const uint32_t quiet = now_ms - max_m.talk_quiet_from;
    const int deg = max_m.talk_heard ? (int)((quiet < MAX_SILENCE_MS ? quiet : MAX_SILENCE_MS) * 180u / MAX_SILENCE_MS) : 0;
    if (deg) pod_arc(s, cx16, cy16, r16, w16, 90 - deg, deg, C(VOICE));
    else max_dot(s, cx - w16 / 32, BAND_CY - r16 / 16, w16 / 16 > 2 ? w16 / 16 : 2, VOICE);   // the stroke's round cap
}

static void band(ht_scene_t *s, uint32_t now_ms)
{
    const bool recording = max_m.talk == MAX_TALK_RECORDING;
    max_dot(s, BAND_X, LISTEN_CY, LISTEN_DOT, VOICE);
    max_text(s, BAND_X + LISTEN_DOT + DX(10), LISTEN_CY, DX(150), &ph_sb_26, VOICE,
             recording ? "Listening" : "Sending\xe2\x80\xa6");
    char clock[24];
    max_fmt_elapsed(clock, sizeof clock, (now_ms - max_m.talk_from) / 1000u);
    max_text(s, BAND_X, TALK_CLOCK_CY, DX(150), &ph_rg_36, FG, clock);
    waveform(s);
    if (!recording) return;   // sent: nothing to tap until it is through
    if (!max_m.talk_heard) max_text(s, WAVE_X, SAY_CY, WAVE_R - WAVE_X, &ph_rg_28, FAINT, "Say it\xe2\x80\xa6");
    max_round(s, X_CX, BAND_CY, X_D);
    const int icon = DY(28);
    max_icon_x(s, X_CX - icon / 2, BAND_CY - icon / 2, icon, FG);
    const int ring_cx = X_CX - X_D / 2 - DX(14) - RING_D / 2;
    send_ring(s, ring_cx, now_ms);
    max_text_right(s, ring_cx - RING_D / 2 - DX(14), BAND_CY, DX(200), &ph_sb_22, VOICE, "Tap to send");
    max_hit(X_CX - X_D / 2 - DX(8), BAND_Y, HT_WIDTH - (X_CX - X_D / 2 - DX(8)), BAND_H, MAX_HIT_TALK_CANCEL, 0);
    max_motion(now_ms, MAX_TALK_FRAME_MS);
}

void max_draw_agent(ht_scene_t *s, const max_agent_t *a, uint32_t now_ms)
{
    const bool talking = max_m.talk != MAX_TALK_IDLE && !strcmp(max_m.talk_id, a->id);
    strip(s, a);
    who(s, a, talking, now_ms);
    if (a->state == MAX_WORKING) working(s, a, talking, now_ms);
    else reading(s, a, talking, now_ms);
    if (talking) band(s, now_ms);
    else talk_hint(s, a);
    // The rest of the page: a tap sends what is being said, or opens the mic.
    if (max_m.talk == MAX_TALK_RECORDING ? talking : max_m.talk == MAX_TALK_IDLE && max_takes_voice(a))
        max_hit(0, BODY_Y, HT_WIDTH, HT_HEIGHT - BODY_Y, MAX_HIT_BODY, 0);
}
