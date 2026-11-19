// The open agent (max_ui_draw.h): App Detail's agent page, the cell a tap opens across the row (V3 open_agent.dart).
// On its own dark ground with its state's glow and rail: its pet (headphones on while the mic is its own), its name
// and state chip, the line of its task, the mic's band across its foot, and X at its top right. The panel is one tap:
// it opens the mic, or sends what is being said. The band, live: "Listening" and its clock, the waveform of the mic's
// level ("Say it…" until speech is heard), "Tap to send" with the ring that fills in the quiet after speech; sending,
// "Sending". At rest one quiet line: "Tap to talk", "Mic closed · tap to talk", or where to talk to an agent the bar
// cannot record for.
#include <stdio.h>
#include <string.h>

#include "max_ui_draw.h"

enum {
    PAD_L = DX(26), PAD_T = DY(20), PAD_R = DX(22), PAD_B = DY(16),
    BAND_H = DY(96), BAND_Y = HT_HEIGHT - PAD_B - BAND_H, BAND_R = DX(20), BAND_PAD = DX(22),
    TOP_H = BAND_Y - DY(12) - PAD_T, PET_W = DX(190), PET_H = DY(150), WORDS_GAP = DX(22), X_ROOM = DX(64),
    NAME_H = DY(38), NAME_GAP = DX(14), TASK_GAP = DY(10), GLOW_H = PANEL_GLOW_H,
    X_HIT_W = DX(92), X_HIT_H = DY(88), X_D = DY(52), X_ICON = DY(28), X_CY = DY(44), X_RIGHT = DX(46),
    LIVE_W = DX(140), LIVE_DOT = DX(12), LISTEN_CY = BAND_Y + DY(30), CLOCK_CY = BAND_Y + DY(62),
    WAVE_CY = BAND_Y + DY(32), WAVE_HALF = DY(21), SAY_CY = BAND_Y + DY(71),
    SEND_W = DX(190), RING_D = DX(28), MIC = DY(26),
};

// The glow's strength: a waiting agent's .18, a failure's .14, any other's .08; none at rest.
static unsigned glow_pct(const max_agent_t *a)
{
    return a->state == MAX_ASKING ? 18 : a->state == MAX_FAILED ? 14 : a->state == MAX_IDLE ? 0 : 8;
}

// ---- the band ----

// The waveform: one bar per level the mic gave, newest at the right, tallest in the middle as the mockup's shape.
static void waveform(ht_scene_t *s, int x, int r)
{
    // sin(pi u)^1.4 at MAX_LEVELS points, in percent: the mockup's envelope.
    static const uint8_t SHAPE[MAX_LEVELS] = {
        0, 3, 8, 13, 18, 24, 29, 35, 40, 46, 51, 56, 61, 66, 70, 75, 79, 82, 86, 89, 92, 94, 96, 98,
        98, 96, 94, 92, 89, 86, 82, 79, 75, 70, 66, 61, 56, 51, 46, 40, 35, 29, 24, 18, 13, 8, 3, 0};
    const int pitch = (r - x) / MAX_LEVELS, bw = pitch * 3 / 5;
    const bool live = max_m.talk == MAX_TALK_RECORDING;   // sending, the bars lie flat
    for (int i = 0; i < MAX_LEVELS; i++) {
        const int k = max_m.level_count - MAX_LEVELS + i;
        const int level = live && k >= 0 ? max_m.levels[k] : 0;
        int half = WAVE_HALF * SHAPE[i] * level / (100 * 4);
        if (half < 2) half = 2;   // a dash where it is quiet
        const unsigned ink = max_mix(VOICE, GROUND, 40 + 60 * SHAPE[i] / 100);
        ht_pro_rect(s, x + i * pitch, WAVE_CY - half, bw, 2 * half, 0, C(ink));
    }
}

// The send ring: a dark track, and the green that fills it from the top while the person is quiet after speaking.
static void send_ring(ht_scene_t *s, int cx, int cy, uint32_t now_ms)
{
    const int r16 = (RING_D - RING_D * 3 / 22) * 8, w16 = RING_D * 3 * 16 / 22, cx16 = cx * 16, cy16 = cy * 16;
    pod_arc(s, cx16, cy16, r16, w16, 0, 180, C(TRACK));
    const uint32_t quiet = now_ms - max_m.talk_quiet_from, full = quiet < MAX_SILENCE_MS ? quiet : MAX_SILENCE_MS;
    const int deg = max_m.talk_heard ? (int)(full * 180u / MAX_SILENCE_MS) : 0;
    if (deg) pod_arc(s, cx16, cy16, r16, w16, 90 - deg, deg, C(VOICE));
    else max_dot(s, cx - w16 / 32, cy - r16 / 16, w16 / 16 > 2 ? w16 / 16 : 2, VOICE);   // the stroke's round cap
}

// The mic records for this agent, or sends what it recorded.
static void live_band(ht_scene_t *s, int x, int r, uint32_t now_ms)
{
    const bool listening = max_m.talk == MAX_TALK_RECORDING;
    const unsigned ink = listening ? VOICE : REST;
    max_dot(s, x, LISTEN_CY, LIVE_DOT, ink);
    max_text(s, x + LIVE_DOT + DX(10), LISTEN_CY, LIVE_W - LIVE_DOT - DX(10), &ph_sb_26, ink,
             listening ? "Listening" : "Sending");
    char clock[24];
    max_fmt_elapsed(clock, sizeof clock, (now_ms - max_m.talk_from) / 1000u);
    max_text(s, x, CLOCK_CY, LIVE_W, &ph_rg_36, FG, clock);
    const int wave_x = x + LIVE_W + DX(22), wave_r = r - SEND_W - DX(22);
    waveform(s, wave_x, wave_r);
    max_motion(now_ms, MAX_TALK_FRAME_MS);
    if (!listening) return;   // sent: nothing to tap for until it is through
    if (!max_m.talk_heard) max_text(s, wave_x, SAY_CY, wave_r - wave_x, &ph_rg_28, FAINT, "Say it\xe2\x80\xa6");
    const int ring_cx = r - RING_D / 2, cy = BAND_Y + BAND_H / 2;
    send_ring(s, ring_cx, cy, now_ms);
    // Once speech was heard the quiet counts toward the send.
    const bool soon = max_m.talk_heard && now_ms != max_m.talk_quiet_from;
    const ht_pro_font_t *f = &ph_sb_22;
    char rows[2][ROW_BYTES];
    const int words_r = ring_cx - RING_D / 2 - DX(12);
    const int n = max_wrap(rows, 2, soon ? "Sending soon \xc2\xb7 tap to send now" : "Tap to send", f,
                           SEND_W - RING_D - DX(12));
    for (int i = 0; i < n; i++)
        max_text_right(s, words_r, cy + (2 * i - (n - 1)) * f->height / 2, SEND_W, f, VOICE, rows[i]);
}

// The band at rest: why the mic is closed, or how to talk to the agent.
static void quiet_band(ht_scene_t *s, const max_agent_t *a, int x, int r)
{
    const int cy = BAND_Y + BAND_H / 2;
    const bool closed = max_m.talk_closed && !strcmp(max_m.talk_id, a->id);
    if (!closed && !max_takes_voice(a)) {
        const char *app = max_app_of(a);
        char where[CABLE_NAME_MAX + 24];
        snprintf(where, sizeof where, "Talk to it %s%s", app[0] ? "in " : "on the computer", app);
        max_text(s, x, cy, r - x, &ph_rg_28, REST, where);
        return;
    }
    max_icon_mic(s, x, cy - MIC / 2, MIC, REST);
    max_text(s, x + MIC + DX(12), cy, r - x - MIC - DX(12), &ph_rg_28, REST,
             closed ? "Mic closed \xc2\xb7 tap to talk" : "Tap to talk");
}

static void band(ht_scene_t *s, const max_agent_t *a, int x, int w, bool talking, uint32_t now_ms)
{
    const int bx = x + PAD_L, bw = w - PAD_L - PAD_R;
    if (talking) max_box(s, bx, BAND_Y, bw, BAND_H, BAND_R, 1, max_mix(VOICE, GROUND, 30), max_mix(VOICE, GROUND, 6));
    else max_box(s, bx, BAND_Y, bw, BAND_H, BAND_R, 1, APP_RIM, BAND_BG);
    if (talking) live_band(s, bx + BAND_PAD, bx + bw - BAND_PAD, now_ms);
    else quiet_band(s, a, bx + BAND_PAD, bx + bw - BAND_PAD);
}

// ---- the panel ----

// The name and the chip beside it, then the task in three rows at most, the block centred beside the pet.
static void words(ht_scene_t *s, const max_agent_t *a, int x, int r)
{
    const ht_pro_font_t *name_f = max_big_can_draw(a->name) ? &ph_sb_48 : &ph_sb_34, *task_f = &ph_rg_28;
    const char *task = max_summary(a);
    char rows[3][ROW_BYTES];
    const int n = max_wrap(rows, 3, task[0] ? task : "No task yet", task_f, r - x);
    const int block = NAME_H + TASK_GAP + n * task_f->height, top = PAD_T + (TOP_H - block) / 2;
    const int chip = max_chip_w(a, true, (r - x) / 2), name_cy = top + NAME_H / 2;
    const int nw = max_text(s, x, name_cy, r - x - chip - NAME_GAP, name_f, FG, a->name);
    max_chip(s, x + nw + NAME_GAP, name_cy, a, true, chip);
    for (int i = 0; i < n; i++)
        ht_pro_text(s, x, top + NAME_H + TASK_GAP + i * task_f->height, r - x, task_f, C(task[0] ? RECAP : FAINT),
                    rows[i]);
}

void max_draw_agent(ht_scene_t *s, const max_agent_t *a, int x, int w, uint32_t now_ms)
{
    const unsigned pct = glow_pct(a), ink = max_chip_ink(a);
    ht_pro_rect(s, x, 0, w - 1, HT_HEIGHT, 0, C(PANEL));
    if (pct) pod_grad_aa_dither(s, x, 0, w - 1, GLOW_H, 0, C(max_mix(ink, PANEL, pct)), C(PANEL));
    ht_pro_rect(s, x, 0, w, RAIL_H, 0, C(max_rail_ink(a)));
    ht_pro_rect(s, x + w - 1, 0, 1, HT_HEIGHT, 0, C(LINE));
    max_agent_body(s, a, x, w, 256, PANEL, GLOW_H, now_ms);
}

void max_agent_body(ht_scene_t *s, const max_agent_t *a, int x, int w, unsigned keep, unsigned under, int glow_h,
                    uint32_t now_ms)
{
    const bool talking = max_m.talk != MAX_TALK_IDLE && !strcmp(max_m.talk_id, a->id);
    const unsigned pct = glow_pct(a), ink = max_chip_ink(a);
    // The pet, centred down the space over the band, on the glow's colour at its middle; coming in, veiled toward the
    // glow under it.
    const int pet_cx = x + PAD_L + PET_W / 2, mid = PAD_T + TOP_H / 2;
    const unsigned ground =
        mid < glow_h ? max_mix(ink, under, pct * (unsigned)(glow_h - mid) / (unsigned)glow_h) : under;
    const pod_scene_t scene = max_pet_scene(a, true);
    const int from = s->count;
    max_pet(s, a->engine, scene, pet_cx, mid + PET_H / 2, PET_W / 2, PET_H, ground, now_ms, false);
    if (keep < 256) max_fade_runs(s, from, max_mix(ink, under, pct), under, glow_h, keep);
    max_tint(under, keep);
    max_motion(now_ms, max_pet_next_ms(a->engine, scene, now_ms));
    words(s, a, x + PAD_L + PET_W + WORDS_GAP, x + w - PAD_R - X_ROOM);
    band(s, a, x, w, talking, now_ms);
    // X, its reach past the button on every side: a miss there is not harmless, it sends what is being said.
    const int x_cx = x + w - X_RIGHT;
    max_round(s, x_cx, X_CY, X_D);
    max_icon_x(s, x_cx - X_ICON / 2, X_CY - X_ICON / 2, X_ICON, FG);
    max_hit(x + w - X_HIT_W, 0, X_HIT_W, X_HIT_H, MAX_HIT_AGENT_X, 0);
    // The rest of the panel: a tap sends what is being said, or opens the mic.
    if (max_m.talk == MAX_TALK_RECORDING ? talking : max_m.talk == MAX_TALK_IDLE && max_takes_voice(a))
        max_hit(x, 0, w, HT_HEIGHT, MAX_HIT_BODY, 0);
    max_tint(0, 256);
}
