// Pets Home: "cover cards" (the owner's mockup harness-pro-tabs-cards.html). One tab a page (the TABS frame's scroll is the tab): a 540 x 560 card
// at (90, 56) with a vertical gradient in the colours of the tab's main engine, the name on one line, the agent count in ph_num_230 with
// "agents" beside it, status pills (working with a 4-bar equaliser, asking with a pulsing dot, else "All done"), and a row of 72 px engine
// logos (asking first, then working, then done, the done ones faded) with a state dot under each; more than five agents show four and "+N".
// The neighbour tabs peek in at the sides, 86 % and faded toward the ground. No dots, bell, title or pets. One POD_A_ENTER_TAB hit over the
// card (arg = the tab, id = its id); none for a tab with 0 agents.
// Notices card (the owner's mockup, option B): while there are notices (pod_notice_count: the list the Notices screen shows) one more card comes FIRST,
// before every tab card, in the orange gradient #FF9A52 -> #9C3F10: "Notices", the count in ph_num_230 with "new" beside it and up to three rows (a 44 px engine
// logo and the notice's text, one line cut with an ellipsis). One POD_A_INBOX hit over it. It peeks beside the first tab card like any neighbour.
// Working card (the owner's mockup, option D): while an agent works one more card comes after Notices, before tab 0, in Codex's blue
// (the owner's pick): "Working" and the count in ph_bd_84, then up to three pets (their work scene, ink at most 128 px, feet on y 384) with the name and the
// elapsed time under each; the working agents newest first, three to a page (nav->work_page). One POD_A_FOLLOW hit over each pet.
// Swarm card (the owner's mockup swarm-card-v3.html, built from the Working card's frame): a desk tab linked to a Swarm (pod_model_swarm_for_tab) draws
// the Swarm instead of its tab card, and a Swarm with no desk tab is one more page after the tabs (pod_home_swarm). Purple #6B4FA3 -> #231A3B: the Swarm's name
// (cut with an ellipsis), under it one capsule: a white disc with the number of projects, then how many are stuck, need you and work ("1 stuck · 1 needs you",
// "2 working" with the equaliser; too wide: "working" shrinks to the bars and the number), or "All done"; then the Leads as pets three to a page
// (nav->swarm_page) in the Working card's slots, each in the scene of its state (ph_lead_scene), stuck first, then needs you, working, done (the Swarm's order
// inside each, so a page turn never reshuffles), with the project and the status under it: "needs you", "stuck", "done", a working Lead only its clock
// (m:ss); a Lead on another person's machine adds its owner in a smaller muted line. One POD_A_LEAD hit over each pet (arg = the Lead's index, id = the Swarm's).
// Paging: the TABS frame's scroll is the tab index, POD_HOME_NOTICES the Notices card (only while notices exist) and POD_HOME_WORKING the Working card (only
// while an agent works): the page list is pod_home_pages, so a card coming or going never moves the person to another tab: it only adds or drops a page before
// tab 0 (and when the card shown goes, Home settles on the next page to its right).
// Also here: the small helpers the other Pets screens share (the pet / logo art).
#include <stdio.h>
#include <string.h>

#include "pod/home/ph.h"
#include "pod/pod_draw.h"
#include "pod/pod_pet.h"
#include "pod/pod_view_shared.h"
#include "pro_canvas.h"

#define C(rgb) ht_rgb(rgb)
enum {
    LOGO = 72, MARK = 72,
    CARD_X = 90, CARD_Y = 56, CARD_W = 540, CARD_H = 560, CARD_R = 48, PEEK_DX = 500, PEEK_PCT = 86, PEEK_FADE = 45,   // the owner's cover-card mockup
    NAME_X = 44, NAME_Y = 40, NAME_W = CARD_W - 2 * NAME_X, NUM_X = 38, NUM_TOP = 61, NUM_SIZE = 230, NUM_BASE = 291,   // NUM_BASE: the digits' baseline, 291 down the card
    LABEL_GAP = 16, NOTE_Y = 345, NOTE_PITCH = 66, NOTE_ROWS = 3, NOTE_LOGO = 44, NOTE_GAP = 18, PILL_Y = 345, PILL_H = 46, PILL_GAP = 12, PILL_PAD = 18, ICONS_Y = 448, ICON_PITCH = 98, DOT = 12, ICONS_MAX = 5
};

pod_scene_t ph_card_scene(const pod_model_t *m, const pod_agent_t *a)
{
    pod_state_t st = pod_model_eff(m, a);
    return st == POD_WORKING ? ph_work_scene(a) : st == POD_ASKING ? POD_SCENE_ASK : POD_SCENE_REST;
}


// An engine's art for `scene` centred on (cx, cy): its pet playing the scene in a side x side square, else its 72 px logo, else a ">_" outline on `fill`.
static void art_of(ht_scene_t *s, int cx, int cy, int side, const char *engine, pod_scene_t scene, unsigned fill, uint32_t now_ms)
{
    if (pod_pet_for(engine)) {
        pod_pet_draw(s, cx - side / 2, cy - side / 2, side, engine, scene, now_ms, 0, 8);
        return;
    }
    if (pod_logo_draw(s, cx - LOGO / 2, cy - LOGO / 2, LOGO, engine)) return;
    ht_pro_rect_aa_stroke(s, cx - MARK / 2, cy - MARK / 2, MARK, MARK, 16, C(0x8A909A), C(fill));
    int w = ht_pro_width(&ph_mono_26, ">_");
    ph_text(s, cx - w / 2, cy, w + 2, &ph_mono_26, PH_INK2, ">_");
}
void ph_card_art(ht_scene_t *s, int cx, int cy, int side, const pod_model_t *m, const pod_agent_t *a, unsigned fill, uint32_t now_ms)
{
    art_of(s, cx, cy, side, a->engine, ph_card_scene(m, a), fill, now_ms);   // the scene of its state (work, ask, rest), as the agent screen plays it
}

pod_scene_t ph_lead_scene(pod_lead_state_t st)
{
    return st == POD_LEAD_WORK ? POD_SCENE_WORK : st == POD_LEAD_DONE ? POD_SCENE_REST : POD_SCENE_ASK;
}

// A Lead's status line ("working · m:ss", "needs you", "stuck", "done") and its colour; `dim` is the colour of "done" (white at 60 % over whatever the line is on).
unsigned ph_lead_status(const pod_lead_t *l, uint32_t now_ms, char *line, size_t n, unsigned dim)
{
    if (l->state == POD_LEAD_ASK) { snprintf(line, n, "needs you"); return PH_LEAD_ASK; }
    if (l->state == POD_LEAD_STUCK) { snprintf(line, n, "stuck"); return PH_LEAD_STUCK; }
    if (l->state == POD_LEAD_DONE) { snprintf(line, n, "done"); return dim; }
    if (l->local[0] || l->since_s) {   // working: a local Lead's turn runs on (a remote one has no clock)
        char t[24];
        const uint32_t into = (int32_t)(now_ms - l->since_at_ms) > 0 ? (now_ms - l->since_at_ms) / 1000 : 0;
        pod_fmt_elapsed(t, sizeof t, (int64_t)l->since_s + into);
        snprintf(line, n, "working \xc2\xb7 %s", t);
    } else snprintf(line, n, "working");
    return PH_LEAD_WORK;
}


// What Home shows: the top frame's scroll (a TAB frame, which Pets never reaches, shows its own tab), clamped to the page list (pod_home_pages): the tab
// index, POD_HOME_NOTICES / POD_HOME_WORKING for those cards, HOME_NONE with no page at all.
enum { HOME_NONE = -3 };
static int home_at(const pod_nav_t *nav, const pod_model_t *m)
{
    if (pod_home_pages(m, NULL, 0) < 1) return HOME_NONE;
    const pod_frame_t *f = nav->depth ? &nav->stack[nav->depth - 1] : NULL;
    return pod_home_clamp(m, !f ? 0 : f->view == POD_V_TAB ? f->tab : f->scroll);
}

// The agents of tab t (panes that name a rostered agent) and how many of them work.
static int tab_agents(const pod_model_t *m, int t, int *working)
{
    int n = 0, w = 0;
    const pod_tab_t *tab = &m->tabs[t];
    for (int k = 0; k < tab->count && k < POD_PANES_MAX; k++)
        if (tab->agent[k] >= 0 && tab->agent[k] < m->agent_count) {
            n++;
            w += pod_model_eff(m, &m->agents[tab->agent[k]]) == POD_WORKING;
        }
    if (working) *working = w;
    return n;
}


static int tab_asking(const pod_model_t *m, int t)
{
    int n = 0;
    const pod_tab_t *tab = &m->tabs[t];
    for (int k = 0; k < tab->count && k < POD_PANES_MAX; k++)
        if (tab->agent[k] >= 0 && tab->agent[k] < m->agent_count && pod_model_eff(m, &m->agents[tab->agent[k]]) == POD_ASKING) n++;
    return n;
}

// What moves on Home: a working agent's equaliser, bob and an asking agent's pulse. Nothing else, so a still tab wakes once a second.
bool ph_home_brand(const pod_nav_t *nav, const pod_model_t *m) { return home_at(nav, m) == HOME_NONE; }

bool ph_home_moves(const pod_nav_t *nav, const pod_model_t *m)
{
    int t = home_at(nav, m), working = 0;
    if (t == HOME_NONE) return true;   // the first screen's shimmer and bar
    if (t == POD_HOME_WORKING) return true;   // the pets
    if (t < 0) return false;   // the Notices card is still
    const pod_swarm_t *sw = pod_home_swarm(m, t);
    if (sw) {   // a Swarm card: a working Lead's pet and clock, the capsule's dot while a Lead needs you or is stuck
        for (int j = 0; j < sw->lead_n && j < SWARM_LEADS_MAX; j++) if (sw->leads[j].state != POD_LEAD_DONE) return true;
        return false;
    }
    tab_agents(m, t, &working);
    return working > 0 || tab_asking(m, t) > 0;
}

uint32_t ph_home_next_ms(const pod_nav_t *nav, const pod_model_t *m, uint32_t now_ms)
{
    return ph_home_moves(nav, m) ? POD_PH_ANIM_MS - now_ms % POD_PH_ANIM_MS : 1000;
}

// An engine's card colours.
void ph_engine_tint(const char *best, unsigned *c1, unsigned *c2)
{
    if (best && !strcmp(best, "codex")) { *c1 = PH_TINT_CODEX1; *c2 = PH_TINT_CODEX2; }
    else if (best && !strcmp(best, "claude")) { *c1 = PH_TINT_CLAUDE1; *c2 = PH_TINT_CLAUDE2; }
    else if (best && !strcmp(best, "muse")) { *c1 = PH_TINT_MUSE1; *c2 = PH_TINT_MUSE2; }
    else if (best && !strcmp(best, "kilo")) { *c1 = PH_TINT_KILO1; *c2 = PH_TINT_KILO2; }
    else { *c1 = PH_TINT_OTHER1; *c2 = PH_TINT_OTHER2; }
}

int ph_working_list(const pod_model_t *m, const pod_agent_t **out, int cap, uint32_t now_ms)
{
    int n = 0;
    for (int i = 0; i < m->agent_count && n < cap; i++) {
        const pod_agent_t *a = &m->agents[i];
        if (pod_model_eff(m, a) != POD_WORKING) continue;
        int k = n++;
        while (k > 0 && pod_agent_secs(a, now_ms) < pod_agent_secs(out[k - 1], now_ms)) { out[k] = out[k - 1]; k--; }   // insertion: newest turn (the least elapsed) first, a tie stays after (model order)
        out[k] = a;
    }
    return n;
}

void ph_working_tint(const pod_model_t *m, unsigned *c1, unsigned *c2)
{
    (void)m;   // the owner's pick: Codex's blue, whoever works
    ph_engine_tint("codex", c1, c2);
}

// The card's two colours by its main engine (the one with the most agents in the tab, a tie to the first in pane order).
static void tint(const pod_model_t *m, int t, unsigned *c1, unsigned *c2)
{
    const pod_tab_t *tab = &m->tabs[t];
    const char *best = NULL;
    int best_n = 0;
    for (int k = 0; k < tab->count && k < POD_PANES_MAX; k++) {
        if (tab->agent[k] < 0 || tab->agent[k] >= m->agent_count) continue;
        const char *e = m->agents[tab->agent[k]].engine;
        int n = 0;
        for (int j = 0; j < tab->count && j < POD_PANES_MAX; j++)
            if (tab->agent[j] >= 0 && tab->agent[j] < m->agent_count && !strcmp(m->agents[tab->agent[j]].engine, e)) n++;
        if (n > best_n) { best_n = n; best = e; }
    }
    if (best && !strcmp(best, "codex")) { *c1 = PH_TINT_CODEX1; *c2 = PH_TINT_CODEX2; }
    else if (best && !strcmp(best, "claude")) { *c1 = PH_TINT_CLAUDE1; *c2 = PH_TINT_CLAUDE2; }
    else if (best && !strcmp(best, "muse")) { *c1 = PH_TINT_MUSE1; *c2 = PH_TINT_MUSE2; }
    else if (best && !strcmp(best, "kilo")) { *c1 = PH_TINT_KILO1; *c2 = PH_TINT_KILO2; }
    else { *c1 = PH_TINT_OTHER1; *c2 = PH_TINT_OTHER2; }
}

// The characters ph_sb_48 bakes (gen_fonts.CONSOLE_CUT): a name with any other falls to the full 34 px face.
static bool name_fits_48(const char *t)
{
    for (; *t; t++) {
        unsigned char c = (unsigned char)*t;
        if (c >= 0x80) { if (!strncmp(t, "\xe2\x80\xa6", 3)) { t += 2; continue; } return false; }
        if (!(c == ' ' || c == '.' || c == '-' || c == '+' || c == '_' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))) return false;
    }
    return true;
}

// The name on one line: control characters as spaces, "Untitled" when empty, cut with an ellipsis to fit `w`. Returns the face (`face`, else ph_sb_48 or ph_sb_34).
static const ht_pro_font_t *shown_name(char *out, size_t n, const char *name, int w, const ht_pro_font_t *face)
{
    snprintf(out, n, "%s", name);
    for (char *p = out; *p; p++) if (*p == '\n' || *p == '\r' || *p == '\t') *p = ' ';
    if (!out[strspn(out, " ")]) snprintf(out, n, "Untitled");
    const ht_pro_font_t *font = face ? face : name_fits_48(out) ? &ph_sb_48 : &ph_sb_34;
    if (ht_pro_width(font, out) > w) {
        size_t len = strlen(out);
        do {
            do len--; while (len > 0 && ((unsigned char)out[len] & 0xC0) == 0x80);   // back one whole character
            snprintf(out + len, n - len, "\xe2\x80\xa6");
        } while (len > 0 && ht_pro_width(font, out) > w);
    }
    return font;
}

static int tri(uint32_t t, uint32_t period)   // 0..100
{
    uint32_t p = t % period, half = period / 2;
    return (int)((p < half ? p : period - p) * 100 / half);
}

// A text run whose baseline sits at `base` (the cell's baseline is 1/1.375 of its height down).
static void on_baseline(ht_scene_t *s, int x, int base, const ht_pro_font_t *f, unsigned rgb, const char *t)
{
    ht_pro_text(s, x, base - f->height * 8 / 11, ht_pro_width(f, t) + 2, f, C(rgb), t);
}

// The first screen (mockup harness-pro-boot.html, option 5 "Shimmer"): the round dial's wordmark, larger, on its own navy ground, with a
// light sweeping across the letters and a sliding pill in a short track. Shown for Home with no tabs (and no notices): before the first swarms
// of a link, after a link drop, or a machine with none. No hits. It moves, so Home wakes on the 66 ms beat while it shows (ph_home_moves).
// Geometry is the mockup's 720 px screen: word box top 300, 84 px, line-height 1 (baseline 373), letter-spacing -0.02em; track 260,430 200x6.
enum { BR_BG = 0x0E1B2C, BR_INK = 0xF2F7FC, BR_LIGHT = 0x9CC6FF, BR_TRACK = 0x1B2A3D, BR_PILL = 0x5F8FD6,
       BR_BASE = 373, BR_SPACE_X100 = 168, BR_SHINE_MS = 2400, BR_SLIDE_MS = 1400,
       BR_BAR_X = 260, BR_BAR_Y = 430, BR_BAR_W = 200, BR_BAR_H = 6, BR_PILL_W = 70 };

// Each letter is its own text run in one solid colour, so a frame damages only the letters whose colour changed plus the pill's old and new
// place. The band is the mockup's gradient: 3x the word wide, the highlight at its middle, easing back to the ink over a tenth of it each side
// (0.3 word widths), its centre running linearly from -0.5 to 2.5 word widths every 2.4 s (left to right). The 100deg slant is dropped.
static void wordmark(ht_scene_t *s, uint32_t now_ms)
{
    static const char word[] = "Harness";
    const int n = (int)sizeof word - 1;
    int total = ht_pro_width(&ph_bd_84, word) - (n * BR_SPACE_X100 + 50) / 100;
    const int x0 = (POD_W - total) / 2;
    s->background = C(BR_BG);
    const int centre = -total / 2 + (int)((uint64_t)(now_ms % BR_SHINE_MS) * 3 * (uint64_t)total / BR_SHINE_MS);   // -0.5 .. 2.5 words
    const int reach = total * 3 / 10;
    for (int i = 0; i < n; i++) {
        char one[2] = {word[i], 0}, head[8];
        memcpy(head, word, (size_t)i); head[i] = 0;
        const int x = x0 + ht_pro_width(&ph_bd_84, head) - (i * BR_SPACE_X100 + 50) / 100, mid = x - x0 + ht_pro_width(&ph_bd_84, one) / 2;
        int d = mid - centre; if (d < 0) d = -d;
        const unsigned lit = d >= reach ? 0 : (unsigned)(100 - d * 100 / reach);
        on_baseline(s, x, BR_BASE, &ph_bd_84, ph_mix(BR_LIGHT, BR_INK, lit), one);
    }
    // The loading bar: a 70 px pill slides from -70 to 200 along the track (ease-in-out), clipped to it, every 1.4 s.
    ht_pro_rect_aa(s, BR_BAR_X, BR_BAR_Y, BR_BAR_W, BR_BAR_H, 3, C(BR_TRACK));
    const int t = (int)(now_ms % BR_SLIDE_MS * 1000 / BR_SLIDE_MS), e = t * t * (3000 - 2 * t) / 1000000;   // smoothstep, 0..1000
    const int px = -BR_PILL_W + (BR_BAR_W + BR_PILL_W) * e / 1000;
    const int a = px < 0 ? 0 : px, b = px + BR_PILL_W > BR_BAR_W ? BR_BAR_W : px + BR_PILL_W;
    if (b > a) ht_pro_rect_aa(s, BR_BAR_X + a, BR_BAR_Y, b - a, BR_BAR_H, b - a >= 6 ? 3 : (b - a) / 2, C(BR_PILL));
}

static int st_of(const pod_model_t *m, const pod_agent_t *a)
{
    pod_state_t st = pod_model_eff(m, a);
    return st == POD_ASKING ? 0 : st == POD_WORKING ? 1 : 2;
}

// An engine's logo in a 72 px slot at (x, y): its 72 px art, else (the pet engines bake no 72) the 44 px one centred in the slot. False without any.
static bool slot_logo(ht_scene_t *s, int x, int y, const char *engine, unsigned opacity)
{
    return pod_logo_draw_faded(s, x, y, LOGO, engine, opacity) || pod_logo_draw_faded(s, x + (LOGO - 44) / 2, y + (LOGO - 44) / 2, 44, engine, opacity);
}

// One status pill at (x, y): fill (black 28 % over the card), a mark (equaliser, dot or none), the text. Returns its width.
// `pad` is the side padding; `bg` false draws the mark and text alone (a segment of a capsule that is already filled).
static int pill_pad(ht_scene_t *s, int x, int y, unsigned fill, int kind, unsigned ink, const char *text, uint32_t now_ms, int pad, bool bg)
{
    const int mark = kind == 1 ? 32 : kind == 2 ? 11 : 0, tw = ht_pro_width(&ph_sb_22, text), w = pad * 2 + (mark ? mark + 10 : 0) + tw;
    if (bg) ht_pro_rect_aa(s, x, y, w, PILL_H, PILL_H / 2, C(fill));
    int tx = x + pad;
    if (kind == 1) {   // four bars, 5 px wide 4 px apart, 30..100 % of 22 px, anchored at the bottom
        static const int phase[4] = {0, -300, -600, -150};
        for (int i = 0; i < 4; i++) {
            int h = 22 * (30 + 70 * tri((uint32_t)((int)(now_ms % 1000u) + phase[i] + 1000), 1000) / 100) / 100;
            ht_pro_rect(s, tx + i * 9, y + PILL_H / 2 + 11 - h, 5, h, 2, C(ink));
        }
    } else if (kind == 2) {   // a dot that pulses between 25 and 100 %
        ht_pro_rect_aa(s, tx, y + PILL_H / 2 - 5, 11, 11, 5, C(ph_mix(ink, fill, 25 + 75 * (unsigned)tri(now_ms, 1200) / 100)));
    }
    ph_text(s, tx + (mark ? mark + 10 : 0), y + PILL_H / 2, tw + 2, &ph_sb_22, ink, text);
    return w;
}
static int pill(ht_scene_t *s, int x, int y, unsigned fill, int kind, unsigned ink, const char *text, uint32_t now_ms)
{
    return pill_pad(s, x, y, fill, kind, ink, text, now_ms, PILL_PAD, true);
}

// An engine's logo at exactly `size` (a baked one: 28, 36, 44 or 72), else a ">_" outline box of that size on `fill`.
void ph_engine_logo(ht_scene_t *s, int x, int y, int size, const char *engine, unsigned fill)
{
    if (engine && pod_logo_draw(s, x, y, size, engine)) return;
    ht_pro_rect_aa_stroke(s, x, y, size, size, size / 5, C(0x8A909A), C(fill));
    int w = ht_pro_width(&ph_mono_22, ">_");
    ph_text(s, x + (size - w) / 2, y + size / 2, w + 2, &ph_mono_22, PH_INK2, ">_");
}

// The Notices card (the owner's mockup harness-pro-notices-card.html, option A "a letter"): the only light card on Home, so it never reads as one more tab.
// Paper #F4EEE3 with two sheets stacked behind it (offset 12 and 24 px down-right), an orange envelope and "Notices" on top, the count in a round orange
// badge at the right, then up to three rows (a 44 px engine logo; the agent's name in brown over the notice's text, one line each, cut with an ellipsis)
// ruled apart, and "+N more · tap to read" (or "Tap to read") at the foot. A neighbour (full false) is the paper faded toward the ground and its name.
enum { LT_STACK = 12, LT_HEAD_CY = 78, LT_ENV_W = 46, LT_ENV_H = 34, LT_BADGE = 76, LT_LIST_Y = 140, LT_ROW = 112, LT_FOOT_CY = 520 };
static void envelope(ht_scene_t *s, int x, int y, unsigned ink, unsigned paper)
{
    ht_pro_rect_aa(s, x, y, LT_ENV_W, LT_ENV_H, 6, C(ink));
    ht_pro_rect_aa(s, x + 4, y + 4, LT_ENV_W - 8, LT_ENV_H - 8, 3, C(paper));
    const int l = (x + 6) * 16, r = (x + LT_ENV_W - 6) * 16, t = (y + 6) * 16, m = (x + LT_ENV_W / 2) * 16, v = (y + LT_ENV_H / 2 + 1) * 16, th = 5 * 16;
    pod_tri_inner(s, l, t, m, v, m, v + th, C(ink), 0);         // the flap's left stroke
    pod_tri_inner(s, l, t, l, t + th, m, v + th, C(ink), 0);
    pod_tri_inner(s, r, t, m, v + th, m, v, C(ink), 0);         // and its right one
    pod_tri_inner(s, r, t, r, t + th, m, v + th, C(ink), 0);
}
static void notices_card(pod_out_frame_t *f, const pod_model_t *m, int x, int y, int w, int h, int r, int fade, bool full)
{
    ht_scene_t *s = f->scene;
    unsigned paper = PH_LETTER;
    if (!full) {
        paper = ph_mix(paper, PH_HOME_BG, (unsigned)fade);
        ht_pro_rect_aa(s, x, y, w, h, r, C(paper));
        char name[CABLE_NAME_MAX + 4];
        const ht_pro_font_t *nf = shown_name(name, sizeof name, "Notices", NAME_W * PEEK_PCT / 100, &ph_sb_34);
        const int nx = x + NAME_X * PEEK_PCT / 100, nw = ht_pro_width(nf, name);
        if (nx < POD_W && nx + nw > 0) ht_pro_text(s, nx, y + 40 * PEEK_PCT / 100, nw + 2, nf, C(ph_mix(PH_LETTER_INK, paper, 70)), name);
        return;
    }
    // The sheets behind: only a d px sliver along the right and the bottom shows, so each is drawn as its three outer corners (2r squares, rounded; their
    // insides fall under the paper) and two straight slivers between them. Rounding is anti-aliased per pixel, so a full sheet would cost a card's worth.
    for (int k = 2; k >= 1; k--) {
        const int d = k * LT_STACK, sx = x + d, sy = y + d, c = 2 * r;
        const uint16_t ink = C(k == 2 ? PH_LETTER_BACK : PH_LETTER_MID);
        ht_pro_rect_aa(s, sx + w - c, sy, c, c, r, ink);            // top right
        ht_pro_rect_aa(s, sx + w - c, sy + h - c, c, c, r, ink);    // bottom right
        ht_pro_rect_aa(s, sx, sy + h - c, c, c, r, ink);            // bottom left
        ht_pro_rect(s, x + w, sy + r, d, h - c, 0, ink);            // the right sliver
        ht_pro_rect(s, sx + r, y + h, w - c, d, 0, ink);            // the bottom sliver
    }
    ht_pro_rect_aa(s, x, y, w, h, r, C(paper));
    envelope(s, x + NAME_X, y + LT_HEAD_CY - LT_ENV_H / 2, PH_LETTER_MARK, paper);
    ph_text(s, x + NAME_X + LT_ENV_W + 16, y + LT_HEAD_CY, 260, &ph_sb_48, PH_LETTER_INK, "Notices");
    const int count = pod_notice_count(m);
    char num[8];
    snprintf(num, sizeof num, "%d", count > 99 ? 99 : count);
    const int cw = ht_pro_width(&ph_sb_48, num), bw = cw + 36 > LT_BADGE ? cw + 36 : LT_BADGE, bx = x + w - NAME_X - bw;
    ht_pro_rect_aa(s, bx, y + LT_HEAD_CY - LT_BADGE / 2, bw, LT_BADGE, LT_BADGE / 2, C(PH_LETTER_BADGE));
    ph_text(s, bx + (bw - cw) / 2, y + LT_HEAD_CY + 2, cw + 2, &ph_sb_48, 0xFFFFFF, num);
    ph_notice_line_t line[NOTE_ROWS];
    const int n = ph_notices_top(m, NOTE_ROWS, line);
    const int tx = x + NAME_X + NOTE_LOGO + NOTE_GAP, tw = x + w - NAME_X - tx;
    for (int k = 0; k < n; k++) {
        const int ry = y + LT_LIST_Y + k * LT_ROW;
        if (k) ht_pro_rect(s, x + NAME_X, ry, w - 2 * NAME_X, 2, 0, C(PH_LETTER_RULE));
        ph_engine_logo(s, x + NAME_X, ry + LT_ROW / 2 - NOTE_LOGO / 2, NOTE_LOGO, line[k].engine, paper);
        const bool who = line[k].name && line[k].name[0];
        if (who) ph_text(s, tx, ry + 38, tw, &ph_sb_22, PH_LETTER_WHO, line[k].name);
        ph_text(s, tx, ry + (who ? 74 : LT_ROW / 2), tw, &ph_rg_24, PH_LETTER_INK, line[k].text);
    }
    char foot[40];
    if (count > n) snprintf(foot, sizeof foot, "+%d more \xc2\xb7 tap to read", count - n);
    else snprintf(foot, sizeof foot, "Tap to read");
    ph_text(s, x + NAME_X, y + LT_FOOT_CY, w - 2 * NAME_X, &ph_sb_22, PH_LETTER_MORE, foot);
}

// The card's content or, for a neighbour, only its gradient and name.
static void card(pod_out_frame_t *f, const pod_model_t *m, int t, int x, int y, int w, int h, int r, int fade, bool full, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    unsigned c1, c2;
    tint(m, t, &c1, &c2);
    if (fade) { c1 = ph_mix(c1, PH_HOME_BG, (unsigned)fade); c2 = ph_mix(c2, PH_HOME_BG, (unsigned)fade); }
    pod_grad_aa_dither(s, x, y, w, h, r, C(c1), C(c2));   // Pets only: no banding on the card
    char name[CABLE_NAME_MAX + 4];
    const ht_pro_font_t *nf = shown_name(name, sizeof name, m->tabs[t].name, full ? NAME_W : NAME_W * PEEK_PCT / 100, full ? NULL : &ph_sb_34);
    const int nx = x + (full ? NAME_X : NAME_X * PEEK_PCT / 100), nw = ht_pro_width(nf, name);
    if (!full) {   // a neighbour: the name only, faded (most of it is off the glass)
        if (nx < POD_W && nx + nw > 0) ht_pro_text(s, nx, y + 40 * PEEK_PCT / 100, nw + 2, nf, C(ph_mix(PH_CARD_INK, c1, 80)), name);
        return;
    }
    ph_text(s, nx, y + NAME_Y + nf->height / 2, NAME_W, nf, PH_CARD_INK, name);

    int working, count = tab_agents(m, t, &working), asking = tab_asking(m, t);
    char num[8];
    snprintf(num, sizeof num, "%d", count);
    const int nw2 = ht_pro_width(&ph_num_230, num);
    ht_pro_text(s, x + NUM_X, y + NUM_TOP, nw2 + 2, &ph_num_230, C(PH_CARD_INK), num);
    on_baseline(s, x + NUM_X + nw2 + LABEL_GAP, y + NUM_BASE, &ph_sb_26, ph_mix(0xFFFFFF, ph_mix(c1, c2, 100 - NUM_BASE * 100 / h), 85), count == 1 ? "agent" : "agents");

    const unsigned fill = ph_mix(0x000000, ph_mix(c1, c2, 100 - (PILL_Y + PILL_H / 2) * 100 / h), 28);
    char txt[24];
    int px = x + NAME_X;
    if (working > 0) { snprintf(txt, sizeof txt, "%d working", working); px += pill(s, px, y + PILL_Y, fill, 1, PH_PILL_WORK, txt, now_ms) + PILL_GAP; }
    if (asking > 0) { snprintf(txt, sizeof txt, "%d asking", asking); px += pill(s, px, y + PILL_Y, fill, 2, PH_PILL_ASK, txt, now_ms) + PILL_GAP; }
    if (!working && !asking) pill(s, px, y + PILL_Y, fill, 0, ph_mix(0xFFFFFF, fill, 80), "\xe2\x9c\x93 All done", now_ms);

    // the engine logos: asking, working, then done; more than five show four and "+N"
    const pod_agent_t *ord[POD_PANES_MAX];
    int n = 0;
    for (int pass = 0; pass < 3; pass++)
        for (int k = 0; k < m->tabs[t].count && k < POD_PANES_MAX; k++) {
            int ai = m->tabs[t].agent[k];
            if (ai >= 0 && ai < m->agent_count && st_of(m, &m->agents[ai]) == pass) ord[n++] = &m->agents[ai];
        }
    const int shown = n > ICONS_MAX ? ICONS_MAX - 1 : n, iy = y + ICONS_Y;
    const unsigned bottom = ph_mix(c1, c2, 100 - (ICONS_Y + LOGO + 12) * 100 / h);
    for (int k = 0; k < shown; k++) {
        const int ix = x + NAME_X + k * ICON_PITCH, st = st_of(m, ord[k]);
        const int bob = st == 1 ? -6 * tri(now_ms, 1800) / 100 : 0;
        bool drawn = slot_logo(s, ix, iy + bob, ord[k]->engine, st == 2 ? 140 : 255);
        if (!drawn) {
            ht_pro_rect_aa_stroke(s, ix, iy + bob, MARK, MARK, 16, C(st == 2 ? ph_mix(0x8A909A, c1, 55) : 0x8A909A), C(c1));
            int gw = ht_pro_width(&ph_mono_26, ">_");
            ph_text(s, ix + MARK / 2 - gw / 2, iy + bob + MARK / 2, gw + 2, &ph_mono_26, PH_INK2, ">_");
        }
        unsigned dot = st == 1 ? 0x5FE08F : st == 0 ? ph_mix(0xFF9A52, bottom, 25 + 75 * (unsigned)tri(now_ms, 1200) / 100) : ph_mix(0xFFFFFF, bottom, 35);
        ht_pro_rect_aa(s, ix + LOGO / 2 - DOT / 2, iy + LOGO + 6, DOT, DOT, DOT / 2, C(dot));
    }
    if (n > ICONS_MAX) {
        char more[8];
        snprintf(more, sizeof more, "+%d", n - shown);
        const int mx = x + NAME_X + shown * ICON_PITCH;
        ph_text(s, mx, iy + LOGO / 2, ht_pro_width(&ph_sb_32, more) + 2, &ph_sb_32, ph_mix(0xFFFFFF, bottom, 80), more);
    }
}

// The Working card (see the header). A neighbour (full false) is the faded gradient and "Working", like a tab's.
enum { WK_TITLE_Y = 80, WK_SLOT_PITCH = 165, WK_FEET = 384, WK_INK = 128, WK_SIDE = WK_INK + 6, WK_NAME_Y = 422 - 7, WK_TIME_Y = 456 - 7,   // the mockup's tops are the glyphs' ink; a text run starts 7 px above that
       WK_NAME_W = 158, WK_PER_PAGE = 3, WK_SHADOW_H = 14, WK_HIT_Y = 200, WK_HIT_W = 150, WK_HIT_H = 280 };
// One row of up to three pets standing on a card, centred on it (one or two sit in the middle, not in the first slots), each with its shadow, feet on y + feet.
// Claude's work scenes are wide and draw small in a `side` square, so its square is twice as big (the owner's pick). The scenes are played for `now_ms`; a
// pet-less engine shows its logo on the same line. Each pet's centre is left in cx[k] for the text and the hit under it.
static void pet_at(ht_scene_t *s, int y, int h, unsigned c1, unsigned c2, int feet, int side0, int cx, const char *engine, pod_scene_t scene, uint32_t now_ms)
{
    const int side = !strcmp(engine, "claude") ? 2 * side0 : side0;
    const int ink = pod_pet_ink_h(engine, scene, side, 8);
    const int shw = (ink ? ink : LOGO) * 4 / 5;   // ponytail: the shadow follows the ink's height (the pets are about as wide as tall); a measured width if one ever looks off
    ht_pro_rect_aa(s, cx - shw / 2, y + feet - 6, shw, WK_SHADOW_H, WK_SHADOW_H / 2, C(ph_mix(0x000000, c2, 35)));
    const int cy = y + feet - (ink ? ink : LOGO) / 2;   // a pet-less engine: its logo, feet on the same line
    if (pod_pet_for(engine))   // the gradient is slow: its colour at the pet's centre is the ground, so each frame is resampled once (baked) and then copied
        pod_pet_draw_flat(s, cx - side / 2, cy - side / 2, side, engine, scene, now_ms, 0, ph_mix(c1, c2, (unsigned)((cy - y) * 100 / h)), 8);
    else art_of(s, cx, cy, side0, engine, scene, ph_mix(c1, c2, 60), now_ms);
}
static void pet_row(ht_scene_t *s, int x, int y, int w, int h, unsigned c1, unsigned c2, int feet, int side0, int shown, const char *const *engine, const pod_scene_t *scene, int *cx, uint32_t now_ms)
{
    for (int k = 0; k < shown; k++) {
        cx[k] = x + w / 2 + (2 * k - (shown - 1)) * WK_SLOT_PITCH / 2;
        pet_at(s, y, h, c1, c2, feet, side0, cx[k], engine[k], scene[k], now_ms);
    }
}

static void working_card(pod_out_frame_t *f, const pod_nav_t *nav, const pod_model_t *m, int x, int y, int w, int h, int r, int fade, bool full, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    unsigned c1, c2;
    ph_working_tint(m, &c1, &c2);
    if (fade) { c1 = ph_mix(c1, PH_HOME_BG, (unsigned)fade); c2 = ph_mix(c2, PH_HOME_BG, (unsigned)fade); }
    pod_grad_aa_dither(s, x, y, w, h, r, C(c1), C(c2));
    if (!full) {
        const int nx = x + NAME_X * PEEK_PCT / 100, nw = ht_pro_width(&ph_sb_34, "Working");
        if (nx < POD_W && nx + nw > 0) ht_pro_text(s, nx, y + 40 * PEEK_PCT / 100, nw + 2, &ph_sb_34, C(ph_mix(PH_CARD_INK, c1, 80)), "Working");
        return;
    }
    const pod_agent_t *list[POD_AGENTS_MAX];
    const int n = ph_working_list(m, list, POD_AGENTS_MAX, now_ms), pages = (n + WK_PER_PAGE - 1) / WK_PER_PAGE;
    const int page = nav->work_page < pages ? nav->work_page : pages > 0 ? pages - 1 : 0;   // the working set may have shrunk since the person swiped
    char txt[CABLE_NAME_MAX + 4];
    ph_text(s, x + NAME_X, y + WK_TITLE_Y, 260, &ph_sb_48, PH_CARD_INK, "Working");
    snprintf(txt, sizeof txt, "%d", n);
    ph_text(s, x + 496 - ht_pro_width(&ph_bd_84, txt), y + WK_TITLE_Y, ht_pro_width(&ph_bd_84, txt) + 2, &ph_bd_84, PH_CARD_INK, txt);   // the count in the bold face (its digits are baked)
    const int shown = n - page * WK_PER_PAGE < WK_PER_PAGE ? n - page * WK_PER_PAGE : WK_PER_PAGE;
    const char *engine[WK_PER_PAGE] = {0};
    pod_scene_t scene[WK_PER_PAGE] = {0};
    int cx[WK_PER_PAGE] = {0};
    for (int k = 0; k < shown; k++) { engine[k] = list[page * WK_PER_PAGE + k]->engine; scene[k] = ph_card_scene(m, list[page * WK_PER_PAGE + k]); }
    pet_row(s, x, y, w, h, c1, c2, WK_FEET, WK_SIDE, shown, engine, scene, cx, now_ms);
    for (int k = 0; k < shown; k++) {
        const pod_agent_t *a = list[page * WK_PER_PAGE + k];
        shown_name(txt, sizeof txt, a->name, WK_NAME_W, &ph_sb_22);
        ht_pro_text(s, cx[k] - ht_pro_width(&ph_sb_22, txt) / 2, y + WK_NAME_Y, ht_pro_width(&ph_sb_22, txt) + 2, &ph_sb_22, C(PH_CARD_INK), txt);
        pod_fmt_elapsed(txt, sizeof txt, pod_agent_secs(a, now_ms));
        ht_pro_text(s, cx[k] - ht_pro_width(&ph_sb_22, txt) / 2, y + WK_TIME_Y, ht_pro_width(&ph_sb_22, txt) + 2, &ph_sb_22, C(PH_PILL_WORK), txt);
        pod_hit_add_id(f, cx[k] - WK_HIT_W / 2, y + WK_HIT_Y, WK_HIT_W, WK_HIT_H, POD_A_FOLLOW, (int)(a - m->agents), a->id);
    }
}

// The Swarm card (see the header). A neighbour (full false) is the faded gradient and the Swarm's name, like a tab's.
enum { SW_PEEK_SHOW = 56, SW_PEEK_FADE = 102, SW_PILL_Y = 116, SW_CAP_H = 58, SW_DISC = 46, SW_SEG_PAD = 13, SW_OWNER_Y = WK_TIME_Y + 30, SW_HIT_Y = 186, SW_HIT_H = 296 };
// Centred on cx, the run's top at y.
static void centred(ht_scene_t *s, int cx, int y, const ht_pro_font_t *f, unsigned rgb, const char *t)
{
    ht_pro_text(s, cx - ht_pro_width(f, t) / 2, y, ht_pro_width(f, t) + 2, f, C(rgb), t);
}
// The order the card shows the Leads in: ord[] = indices into sw->leads, the Swarm's order (the app's, as the cable put them) whatever their state, so a Lead
// keeps its place as it changes; cnt[0..3] = how many are stuck, need you, working, done.
static int lead_order(const pod_swarm_t *sw, int *ord, int *cnt)
{
    static const pod_lead_state_t rank[4] = {POD_LEAD_STUCK, POD_LEAD_ASK, POD_LEAD_WORK, POD_LEAD_DONE};
    int n = 0;
    cnt[0] = cnt[1] = cnt[2] = cnt[3] = 0;
    for (int j = 0; j < sw->lead_n && j < SWARM_LEADS_MAX; j++) {
        ord[n++] = j;
        for (int r = 0; r < 4; r++) if (sw->leads[j].state == rank[r]) cnt[r]++;
    }
    return n;
}
// A Lead's status line on this card: "needs you", "stuck", "done", a working Lead's clock alone (ph_lead_status's line less its "working · "). Returns its colour.
static unsigned swarm_status(const pod_lead_t *l, uint32_t now_ms, char *line, size_t n, unsigned dim)
{
    char full[CABLE_NAME_MAX + 4];
    const unsigned ink = ph_lead_status(l, now_ms, full, sizeof full, dim);
    const char *dot = l->state == POD_LEAD_WORK ? strstr(full, "\xc2\xb7 ") : NULL;
    snprintf(line, n, "%s", dot ? dot + 3 : full);
    return l->state == POD_LEAD_WORK ? PH_PILL_WORK : ink;   // the clock in the Working card's green
}
static void swarm_card(pod_out_frame_t *f, const pod_nav_t *nav, const pod_swarm_t *sw, int x, int y, int w, int h, int r, int fade, bool full, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    unsigned c1 = PH_SWARM1, c2 = PH_SWARM2;
    if (fade) { c1 = ph_mix(c1, PH_HOME_BG, (unsigned)fade); c2 = ph_mix(c2, PH_HOME_BG, (unsigned)fade); }
    pod_grad_aa_dither(s, x, y, w, h, r, C(c1), C(c2));
    char name[CABLE_NAME_MAX + 4];
    const ht_pro_font_t *nf = shown_name(name, sizeof name, sw->name, full ? NAME_W : NAME_W * PEEK_PCT / 100, full ? NULL : &ph_sb_34);
    const int nx = x + (full ? NAME_X : NAME_X * PEEK_PCT / 100), nw = ht_pro_width(nf, name);
    if (!full) {   // a neighbour: the name only, faded
        if (nx < POD_W && nx + nw > 0) ht_pro_text(s, nx, y + 40 * PEEK_PCT / 100, nw + 2, nf, C(ph_mix(PH_CARD_INK, c1, 80)), name);
        return;
    }
    ph_text(s, nx, y + NAME_Y + nf->height / 2, NAME_W, nf, PH_CARD_INK, name);

    int ord[SWARM_LEADS_MAX], cnt[4];
    const int lead_n = lead_order(sw, ord, cnt);
    char txt[CABLE_NAME_MAX + 4];
    if (!lead_n) {   // a Swarm with no project yet
        const char *e = "No projects yet", *e2 = "Start one in the app";
        centred(s, x + w / 2, y + 300, &ph_sb_34, ph_mix(0xFFFFFF, c1, 88), e);
        centred(s, x + w / 2, y + 350, &ph_sb_22, ph_mix(0xFFFFFF, ph_mix(c1, c2, 40), 62), e2);
        return;
    }

    // The capsule: black 30 % over the card, a white disc with the number of projects, then "stuck · needs you" (one segment, red when anything is stuck,
    // else orange, with a pulsing dot), "working" (the equaliser, green), or "All done" when nothing is. Too wide: "working" gives way to the bars and the number.
    const unsigned fill = ph_mix(0x000000, ph_mix(c1, c2, 100 - (SW_PILL_Y + SW_CAP_H / 2) * 100 / h), 30);
    char seg[2][CABLE_NAME_MAX];
    int kind[2], ink[2], ns = 0, work = -1;
    const char *needs = cnt[1] == 1 ? "needs" : "need";
    if (cnt[0] && cnt[1]) snprintf(seg[ns], sizeof seg[0], "%d stuck \xc2\xb7 %d %s you", cnt[0], cnt[1], needs);
    else if (cnt[0]) snprintf(seg[ns], sizeof seg[0], "%d stuck", cnt[0]);
    else if (cnt[1]) snprintf(seg[ns], sizeof seg[0], "%d %s you", cnt[1], needs);
    if (cnt[0] || cnt[1]) { kind[ns] = 2; ink[ns] = cnt[0] ? PH_LEAD_STUCK : PH_LEAD_ASK; ns++; }
    if (cnt[2]) { snprintf(seg[ns], sizeof seg[0], "%d working", cnt[2]); kind[ns] = 1; ink[ns] = PH_PILL_WORK; work = ns++; }
    if (!ns) { snprintf(seg[ns], sizeof seg[0], "All done"); kind[ns] = 0; ink[ns] = ph_mix(0xFFFFFF, fill, 86); ns++; }
    snprintf(txt, sizeof txt, "%d", sw->count > 99 ? 99 : sw->count);
    const int dw = ht_pro_width(&ph_sb_34, txt), disc = dw + 24 > SW_DISC ? dw + 24 : SW_DISC;   // a disc, widening to a lozenge for two digits
    const int x0 = x + NAME_X, inset = (SW_CAP_H - SW_DISC) / 2;
    int segw[2], total;
    for (;;) {
        total = inset + disc + 6 + 8;
        for (int i = 0; i < ns; i++) {
            const int mark = kind[i] == 1 ? 32 : kind[i] == 2 ? 11 : 0;
            segw[i] = SW_SEG_PAD * 2 + (mark ? mark + 10 : 0) + ht_pro_width(&ph_sb_22, seg[i]);
            total += segw[i];
        }
        if (total <= NAME_W || work < 0 || !strchr(seg[work], ' ')) break;
        snprintf(seg[work], sizeof seg[0], "%d", cnt[2]);
    }
    const int ccy = y + SW_PILL_Y + SW_CAP_H / 2;
    ht_pro_rect_aa(s, x0, ccy - SW_CAP_H / 2, total, SW_CAP_H, SW_CAP_H / 2, C(fill));
    ht_pro_rect_aa(s, x0 + inset, ccy - SW_DISC / 2, disc, SW_DISC, SW_DISC / 2, C(ph_mix(0xFFFFFF, fill, 92)));
    ph_text(s, x0 + inset + (disc - dw) / 2, ccy + 1, dw + 2, &ph_sb_34, c2, txt);
    int sx = x0 + inset + disc + 6;
    for (int i = 0; i < ns; i++) {
        pill_pad(s, sx, ccy - PILL_H / 2, fill, kind[i], ink[i], seg[i], now_ms, SW_SEG_PAD, false);
        sx += segw[i];
    }

    // the Leads, three to a page, in the card's order
    const int pages = (lead_n + WK_PER_PAGE - 1) / WK_PER_PAGE;
    const int page = nav->swarm_page < pages ? nav->swarm_page : pages > 0 ? pages - 1 : 0;
    const int first = page * WK_PER_PAGE, shown = lead_n - first < WK_PER_PAGE ? lead_n - first : WK_PER_PAGE;
    const char *engine[WK_PER_PAGE] = {0};
    pod_scene_t scene[WK_PER_PAGE] = {0};
    int cx[WK_PER_PAGE] = {0};
    for (int k = 0; k < shown; k++) { engine[k] = sw->leads[ord[first + k]].engine; scene[k] = ph_lead_scene(sw->leads[ord[first + k]].state); }
    // the page's neighbour Lead peeks in at the card's edge (the next page's first at the right, the previous page's last at the left): faded, clipped to
    // the card by a veil (it paints the ground over what spilled past the edge), no text. Drawn first so the page's own pets stand over it.
    for (int side = -1; side <= 1; side += 2) {
        if (side > 0 ? first + shown >= lead_n : page == 0) continue;
        const pod_lead_t *l = &sw->leads[ord[side > 0 ? first + shown : first - 1]];
        const pod_scene_t sc = ph_lead_scene(l->state);
        const int sd = !strcmp(l->engine, "claude") ? 2 * WK_SIDE : WK_SIDE;
        const int cxp = side > 0 ? x + w - SW_PEEK_SHOW + sd / 2 : x + SW_PEEK_SHOW - sd / 2;
        const int ink = pod_pet_ink_h(l->engine, sc, sd, 8), top = y + WK_FEET - (ink ? ink : LOGO) - 12;
        pet_at(s, y, h, c1, c2, WK_FEET, WK_SIDE, cxp, l->engine, sc, now_ms);
        const int vx = side > 0 ? x + w - SW_PEEK_SHOW - 4 : x - sd, vw = SW_PEEK_SHOW + 4 + sd;
        pod_veil(s, vx, top, vw, y + WK_FEET + WK_SHADOW_H - top, side > 0 ? x + w : x, side > 0, y, h, C(c1), C(c2), C(PH_HOME_BG), SW_PEEK_FADE);
    }
    pet_row(s, x, y, w, h, c1, c2, WK_FEET, WK_SIDE, shown, engine, scene, cx, now_ms);
    for (int k = 0; k < shown; k++) {
        const pod_lead_t *l = &sw->leads[ord[first + k]];
        shown_name(txt, sizeof txt, l->project, WK_NAME_W, &ph_sb_22);
        centred(s, cx[k], y + WK_NAME_Y, &ph_sb_22, PH_CARD_INK, txt);
        const unsigned dim = ph_mix(0xFFFFFF, ph_mix(c1, c2, 100 - (WK_TIME_Y + 11) * 100 / h), 60);   // white at 60 % over the card
        char line[CABLE_NAME_MAX + 4];
        const unsigned ink = swarm_status(l, now_ms, line, sizeof line, dim);
        shown_name(txt, sizeof txt, line, WK_NAME_W + 6, &ph_sb_22);
        centred(s, cx[k], y + WK_TIME_Y, &ph_sb_22, ink, txt);
        if (l->owner[0]) {   // someone else's machine: whose, small and muted
            shown_name(txt, sizeof txt, l->owner, WK_NAME_W, &ph_mono_18);
            centred(s, cx[k], y + SW_OWNER_Y, &ph_mono_18, ph_mix(0xFFFFFF, ph_mix(c1, c2, 100 - (SW_OWNER_Y + 12) * 100 / h), 55), txt);
        }
        pod_hit_add_id(f, cx[k] - WK_HIT_W / 2, y + SW_HIT_Y, WK_HIT_W, SW_HIT_H, POD_A_LEAD, ord[first + k], sw->id);
    }
}

// A neighbour page of Home: the faded card of page p.
static void peek(pod_out_frame_t *f, const pod_nav_t *nav, const pod_model_t *m, int p, int x, int y, int w, int h, int r, uint32_t now_ms)
{
    if (p == POD_HOME_NOTICES) notices_card(f, m, x, y, w, h, r, PEEK_FADE, false);
    else if (p == POD_HOME_WORKING) working_card(f, nav, m, x, y, w, h, r, PEEK_FADE, false, now_ms);
    else if (p >= 0 && pod_home_swarm(m, p)) swarm_card(f, nav, pod_home_swarm(m, p), x, y, w, h, r, PEEK_FADE, false, now_ms);
    else if (p >= 0) card(f, m, p, x, y, w, h, r, PEEK_FADE, false, now_ms);
}

void ph_view_home(pod_out_frame_t *f, const pod_nav_t *nav, pod_model_t *m, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    s->background = C(PH_HOME_BG);
    const int t = home_at(nav, m);
    if (t == HOME_NONE) { wordmark(s, now_ms); return; }
    const int pw = CARD_W * PEEK_PCT / 100, ph = CARD_H * PEEK_PCT / 100, py = CARD_Y + CARD_H / 2 - ph / 2;
    const int lx = CARD_X + CARD_W / 2 - PEEK_DX - pw / 2, rx = CARD_X + CARD_W / 2 + PEEK_DX - pw / 2, pr = CARD_R * PEEK_PCT / 100;
    // The page t's neighbours are the adjacent entries of the page list.
    int16_t pg[POD_HOME_PAGES_MAX];
    const int n = pod_home_pages(m, pg, POD_HOME_PAGES_MAX);
    int at = 0;
    while (at < n - 1 && pg[at] < t) at++;
    const int prev = at > 0 ? pg[at - 1] : HOME_NONE, next = at + 1 < n ? pg[at + 1] : HOME_NONE;
    const pod_swarm_t *own = t >= 0 ? pod_home_swarm(m, t) : NULL;
    // A Swarm card with a Lead peeking in clips it with a veil over the neighbours' side, so the neighbours are drawn after it (2 px further out, clear of its edge).
    const bool after = own && own->lead_n > WK_PER_PAGE && t != POD_HOME_WORKING && t != POD_HOME_NOTICES;
    if (!after) {
        peek(f, nav, m, prev, lx, py, pw, ph, pr, now_ms);
        peek(f, nav, m, next, rx, py, pw, ph, pr, now_ms);
    }
    if (t == POD_HOME_WORKING) {
        working_card(f, nav, m, CARD_X, CARD_Y, CARD_W, CARD_H, CARD_R, 0, true, now_ms);
        return;
    }
    if (t == POD_HOME_NOTICES) {
        notices_card(f, m, CARD_X, CARD_Y, CARD_W, CARD_H, CARD_R, 0, true);
        pod_hit_add(f, CARD_X, CARD_Y, CARD_W, CARD_H, POD_A_INBOX, 0);
        return;
    }
    const pod_swarm_t *sw = pod_home_swarm(m, t);
    if (sw) {   // a Swarm's card: its own page, or in place of its desk tab's
        swarm_card(f, nav, sw, CARD_X, CARD_Y, CARD_W, CARD_H, CARD_R, 0, true, now_ms);
        if (after) {
            peek(f, nav, m, prev, lx - 2, py, pw, ph, pr, now_ms);
            peek(f, nav, m, next, rx + 2, py, pw, ph, pr, now_ms);
        }
        return;
    }
    card(f, m, t, CARD_X, CARD_Y, CARD_W, CARD_H, CARD_R, 0, true, now_ms);
    if (tab_agents(m, t, NULL) > 0) pod_hit_add_id(f, CARD_X, CARD_Y, CARD_W, CARD_H, POD_A_ENTER_TAB, t, m->tabs[t].id);
}
