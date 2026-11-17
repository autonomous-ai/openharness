// The screen (max_ui.h), 1920 x 480 (or 415) in the Pro's light theme: the rail, three lanes and the Talk slot, with
// the page dots or a notice under the lanes. A lane with a question, a failure or an alert opens into a card and its
// neighbours narrow (max_ui_card.c); New Harness covers the lanes. Inter faces (gen_fonts.py ph_*): at the Max's
// 225 ppi they come out a little larger than on the Pro's 258.
#include <stdio.h>
#include <string.h>

#include "max_ui_draw.h"

enum {
    ACTIVITY_ROWS = 3, STEP_GAP = 10, NARROW_PAD = 16,
    RAIL_X = 24, RAIL_TEXT_X = 46, RAIL_PITCH = MAX_Y(78), RAIL_SUB = MAX_Y(34), RAIL_ROW_H = MAX_Y(52),
    BAND_CY = (MAX_BAND_Y + HT_HEIGHT) / 2, PAGE_DOT = 10, PAGE_PITCH = 22,
    CARD_CY = MAX_CARD_Y + MAX_CARD_H / 2,
};
static const char ELLIPSIS[] = "\xe2\x80\xa6";   // the Inter faces draw it (gen_fonts.py CONSOLE_EXTRA)
static const int LANES_CX = MAX_LANE_X + MAX_LANES * MAX_LANE_W / 2;

// Whether t's first n bytes and an ellipsis fit `width` px (out: scratch).
static bool fits_cut(char out[ROW_BYTES], const char *t, size_t n, const ht_pro_font_t *f, int width)
{
    memcpy(out, t, n);
    memcpy(out + n, ELLIPSIS, sizeof ELLIPSIS);
    return ht_pro_width(f, out) <= width;
}
// t as one run of at most `width` px: whole when it fits, else as many letters as fit before an ellipsis, with no space
// or comma left before it. With `words`, between words when that keeps at least half of what fits. A wider prefix never
// measures narrower, so the cut is a binary search over the code points that fit in a run.
void max_cut(char out[ROW_BYTES], const char *t, const ht_pro_font_t *f, int width, bool words)
{
    const size_t len = strlen(t);
    if (len < ROW_BYTES) {
        memcpy(out, t, len + 1);
        if (ht_pro_width(f, out) <= width) return;
    }
    uint8_t at[ROW_BYTES];   // code point ends
    int ends = 0;
    for (size_t n = 0; t[n];) {
        size_t next = n + 1;
        while (((unsigned char)t[next] & 0xc0) == 0x80) next++;
        if (next + sizeof ELLIPSIS > ROW_BYTES) break;
        at[ends++] = (uint8_t)(n = next);
    }
    int lo = 0, hi = ends;   // the first `lo` ends fit
    while (lo < hi) {
        const int mid = (lo + hi + 1) / 2;
        if (fits_cut(out, t, at[mid - 1], f, width)) lo = mid;
        else hi = mid - 1;
    }
    size_t n = lo ? at[lo - 1] : 0, space = n;
    while (space && t[space] != ' ') space--;
    if (words && space > n / 2) n = space;
    while (n && strchr(" ,;:", t[n - 1])) n--;
    memcpy(out, t, n);
    memcpy(out + n, ELLIPSIS, sizeof ELLIPSIS);
}
void max_line(ht_scene_t *s, int x, int top, int w, const ht_pro_font_t *f, unsigned rgb, const char *t, bool words)
{
    char row[ROW_BYTES];
    if (!t || !t[0] || w <= 0) return;
    max_cut(row, t, f, w, words);
    ht_pro_text(s, x, top, w, f, C(rgb), row);
}
// The cell's baseline sits at 1/1.375 of its height.
int max_top_of(const ht_pro_font_t *f, int cy) { return cy - f->height * 15 / 32; }
int max_text(ht_scene_t *s, int x, int cy, int w, const ht_pro_font_t *f, unsigned rgb, const char *t)
{
    char row[ROW_BYTES];
    if (!t || !t[0] || w <= 0) return 0;
    max_cut(row, t, f, w, false);
    const int tw = ht_pro_width(f, row);
    ht_pro_text(s, x, max_top_of(f, cy), tw, f, C(rgb), row);
    return tw;
}
void max_text_centered(ht_scene_t *s, int cx, int cy, int w, const ht_pro_font_t *f, unsigned rgb, const char *t)
{
    char row[ROW_BYTES];
    if (!t || !t[0]) return;
    max_cut(row, t, f, w, false);
    const int tw = ht_pro_width(f, row);
    ht_pro_text(s, cx - tw / 2, max_top_of(f, cy), tw, f, C(rgb), row);
}
void max_dot(ht_scene_t *s, int x, int cy, int d, unsigned rgb) { ht_pro_rect_aa(s, x, cy - d / 2, d, d, d / 2, C(rgb)); }

// The bytes of t that fill a row of `width` px, ending at a word; a first word wider than the row is cut by letters.
size_t max_fit(const char *t, const ht_pro_font_t *f, int width)
{
    char row[ROW_BYTES];
    size_t best = 0;
    for (;;) {
        size_t e = best;
        while (t[e] == ' ') e++;
        if (!t[e]) break;
        while (t[e] && t[e] != ' ') e++;
        if (e >= sizeof row) break;
        memcpy(row, t, e);
        row[e] = 0;
        if (ht_pro_width(f, row) > width) break;
        best = e;
    }
    if (best) return best;
    size_t n = 0;
    while (t[n]) {
        size_t next = n + 1;
        while (((unsigned char)t[next] & 0xc0) == 0x80) next++;
        if (next >= sizeof row) break;
        memcpy(row, t, next);
        row[next] = 0;
        if (n && ht_pro_width(f, row) > width) break;
        n = next;
    }
    return n;
}
// t word-wrapped from y down in at most max_rows rows, the last one taking the rest (cut with an ellipsis). Returns the
// y under the last row.
int max_paragraph(ht_scene_t *s, int x, int y, int w, const ht_pro_font_t *f, unsigned rgb, const char *t, int max_rows)
{
    char row[ROW_BYTES];
    while (*t == ' ') t++;
    for (int i = 0; i < max_rows && *t; i++, y += f->height) {
        if (i == max_rows - 1) {
            max_line(s, x, y, w, f, rgb, t, true);
            continue;
        }
        const size_t len = max_fit(t, f, w);
        memcpy(row, t, len);
        row[len] = 0;
        ht_pro_text(s, x, y, w, f, C(rgb), row);
        t += len;
        while (*t == ' ') t++;
    }
    return y;
}

void max_card_frame(ht_scene_t *s, int x, int y, int w, int h, unsigned fill, unsigned edge, bool selected)
{
    if (selected) {
        ht_pro_rect_aa(s, x, y, w, h, CARD_R, C(HT_THEME_ACCENT));
        ht_pro_rect_aa(s, x + SELECT_W, y + SELECT_W, w - 2 * SELECT_W, h - 2 * SELECT_W, CARD_R - SELECT_W, C(fill));
    } else {
        ht_pro_rect_aa_stroke(s, x, y, w, h, CARD_R, C(edge), C(fill));
    }
}

void max_hit(int x, int y, int w, int h, max_hit_kind_t kind, int arg)
{
    if (max_m.hit_count >= MAX_HITS) return;
    max_m.hits[max_m.hit_count++] = (max_hit_t){(int16_t)x, (int16_t)y, (int16_t)w, (int16_t)h, (uint8_t)kind, (int8_t)arg};
}

// ---- the rail: the cabled computer and the machines, with their agents, and New Harness ----

typedef struct {
    const char *name;
    int agents;   // -1: no count to show
    bool link, offline;
} rail_row_t;

static int agents_on(const char *machine_id)
{
    int n = 0;
    for (int i = 0; i < max_m.count; i++) n += !strcmp(max_m.agents[i].machine_id, machine_id);
    return n;
}
static void rail_row(ht_scene_t *s, int cy, const rail_row_t *r)
{
    if (r->link) max_dot(s, RAIL_X, cy, 12, HT_THEME_DONE);
    const int w = MAX_RAIL_W - RAIL_TEXT_X - 20;
    max_text(s, RAIL_TEXT_X, cy, w, &ph_sb_26, r->offline ? HT_THEME_SECONDARY : HT_THEME_TEXT, r->name);
    char sub[24];
    if (r->offline) snprintf(sub, sizeof sub, "Offline");
    else if (r->agents >= 0) snprintf(sub, sizeof sub, "%d agent%s", r->agents, r->agents == 1 ? "" : "s");
    else sub[0] = 0;
    max_text(s, RAIL_TEXT_X, cy + RAIL_SUB, w, &ph_rg_24, HT_THEME_SECONDARY, sub);
}
// New Harness, at the foot of the rail: always in reach, whatever lane is selected. Returns its top.
static int new_button(ht_scene_t *s)
{
    const int w = MAX_RAIL_W - 2 * RAIL_X, h = MAX_BUTTON_H, y = MAX_BAND_Y - h;
    const bool open = max_form_open();
    max_card_frame(s, RAIL_X, y, w, h, BUTTON_FILL, LANE_EDGE, open);
    max_text_centered(s, RAIL_X + w / 2, y + h / 2, w - 2 * MAX_PAD, &ph_sb_26, HT_THEME_TEXT, "New Harness");
    if (!open) max_hit(RAIL_X, y, w, h, MAX_HIT_NEW, 0);
    return y;
}
static void rail(ht_scene_t *s)
{
    rail_row_t rows[CABLE_MAX_MACHINES + 1];
    int n = 0;
    bool local = false;
    for (int i = 0; i < max_m.machine_count; i++) local |= max_m.machines[i].local;
    // The cabled computer leads. With no machine list it holds every agent; a list without it counts none.
    if (!local) rows[n++] = (rail_row_t){max_m.computer, max_m.machine_count ? -1 : max_m.count, true, false};
    for (int pass = 0; pass < 2; pass++)
        for (int i = 0; i < max_m.machine_count; i++) {
            const cable_machine_t *m = &max_m.machines[i];
            if (m->local != (pass == 0)) continue;
            rows[n++] = (rail_row_t){m->name, agents_on(m->id), m->local, !strcmp(m->state, "offline")};
        }
    const int bottom = (max_m.offers_form ? new_button(s) : MAX_BAND_Y) - 8;
    const int fit = (bottom - NAME_CY - RAIL_ROW_H) / RAIL_PITCH + 1;   // the rows whose two lines end above it
    const int shown = n > fit ? fit - 1 : n;
    for (int i = 0; i < shown; i++) rail_row(s, NAME_CY + i * RAIL_PITCH, &rows[i]);
    if (shown < n) {
        char more[24];
        snprintf(more, sizeof more, "+%d more", n - shown);
        max_text(s, RAIL_TEXT_X, NAME_CY + shown * RAIL_PITCH, MAX_RAIL_W - RAIL_TEXT_X - 20, &ph_rg_24, HT_THEME_SECONDARY,
                 more);
    }
}

// ---- a lane ----

const char *max_state_word(const max_agent_t *a)
{
    switch (a->state) {
    case MAX_WORKING: return a->verb[0] ? a->verb : "Working";
    case MAX_ASKING: return "Asks";
    case MAX_DONE: return "Done";
    case MAX_FAILED: return "Failed";
    default: return "Idle";
    }
}
unsigned max_state_dot(max_state_t st)
{
    switch (st) {
    case MAX_WORKING: return WORKING_INK;
    case MAX_ASKING: return ASK_DOT;
    case MAX_DONE: return HT_THEME_DONE;
    case MAX_FAILED: return HT_THEME_FAILED;
    default: return IDLE_DOT;
    }
}
static unsigned word_ink(max_state_t st)
{
    return st == MAX_FAILED ? HT_THEME_FAILED : st == MAX_IDLE ? HT_THEME_SECONDARY : HT_THEME_TEXT;
}

static void lane_frame(ht_scene_t *s, int x, int w, const max_agent_t *a)
{
    unsigned fill = LANE_FILL, edge = LANE_EDGE;
    if (a->state == MAX_ASKING) fill = ASK_FILL, edge = ASK_EDGE;
    if (a->state == MAX_FAILED) fill = FAIL_FILL, edge = FAIL_EDGE;
    max_card_frame(s, x, MAX_CARD_Y, w, MAX_CARD_H, fill, edge, !strcmp(max_m.selected, a->id));
}

static void lane(ht_scene_t *s, int col_x, int col_w, const max_agent_t *a, uint32_t now_ms)
{
    const int x = col_x + MAX_INSET, w = col_w - 2 * MAX_INSET, tw = w - 2 * MAX_PAD;
    lane_frame(s, x, w, a);
    const int tx = x + MAX_PAD;
    max_text(s, tx, NAME_CY, tw, &ph_sb_32, HT_THEME_TEXT, a->name);
    char meta[64];
    snprintf(meta, sizeof meta, "%s%s%s", a->engine, a->engine[0] && a->machine[0] ? " \xc2\xb7 " : "", a->machine);
    max_text(s, tx, META_CY, tw, &ph_rg_24, HT_THEME_SECONDARY, meta);

    max_dot(s, tx, STATE_CY, DOT, max_state_dot(a->state));
    char clock[24];
    max_fmt_elapsed(clock, sizeof clock, max_secs(a, now_ms));
    const int cw = clock[0] ? ht_pro_width(&ph_mono_26, clock) : 0;
    const int word_x = tx + DOT + 10;
    max_text(s, word_x, STATE_CY, tx + tw - word_x - (cw ? cw + 16 : 0), &ph_sb_26, word_ink(a->state), max_state_word(a));
    if (cw) max_text(s, tx + tw - cw, STATE_CY, cw, &ph_mono_26, HT_THEME_SECONDARY, clock);

    const int rows = (CARD_BOTTOM - BODY_Y) / ph_rg_28.height;
    switch (a->state) {
    case MAX_WORKING: {
        int by = max_paragraph(s, tx, BODY_Y, tw, &ph_rg_28, HT_THEME_TEXT, a->activity, ACTIVITY_ROWS);
        if (a->activity[0]) by += STEP_GAP;
        for (int i = 0; i < a->step_count && by + ph_mono_22.height <= CARD_BOTTOM; i++, by += ph_mono_22.height)
            max_line(s, tx, by, tw, &ph_mono_22, HT_THEME_SECONDARY, a->steps[i], false);
        break;
    }
    case MAX_ASKING:
        max_paragraph(s, tx, BODY_Y, tw, &ph_rg_28, HT_THEME_TEXT, a->question, rows);
        break;
    case MAX_FAILED:
    case MAX_DONE:
        if (max_note_shown(a, now_ms))
            max_paragraph(s, tx, BODY_Y, tw, &ph_rg_28, a->state == MAX_FAILED ? HT_THEME_ERROR : HT_THEME_TEXT, a->note,
                          rows);
        break;
    default:
        break;
    }
}

// A lane beside an open card: who, and how it is doing.
static void narrow_lane(ht_scene_t *s, int col_x, int col_w, const max_agent_t *a, uint32_t now_ms)
{
    const int x = col_x + MAX_INSET, w = col_w - 2 * MAX_INSET, tx = x + NARROW_PAD, tw = w - 2 * NARROW_PAD;
    lane_frame(s, x, w, a);
    max_text(s, tx, NAME_CY, tw, &ph_sb_26, HT_THEME_TEXT, a->name);
    max_text(s, tx, META_CY, tw, &ph_rg_24, HT_THEME_SECONDARY, a->engine);
    max_dot(s, tx, STATE_CY, DOT, max_state_dot(a->state));
    max_text(s, tx + DOT + 8, STATE_CY, tw - DOT - 8, &ph_sb_22, word_ink(a->state), max_state_word(a));
    char clock[24];
    max_fmt_elapsed(clock, sizeof clock, max_secs(a, now_ms));
    max_text(s, tx, STATE_CY + MAX_Y(40), tw, &ph_mono_22, HT_THEME_SECONDARY, clock);
}

// ---- the Talk slot ----

// A microphone: the capsule in its cradle on a stand, top at y. ground: the card's fill, which hollows the cradle.
static void mic(ht_scene_t *s, int cx, int y, unsigned ink, unsigned ground)
{
    ht_pro_rect_aa(s, cx - 27, y + 16, 54, 58, 27, C(ink));
    ht_pro_rect_aa(s, cx - 22, y + 6, 44, 63, 22, C(ground));
    ht_pro_rect_aa(s, cx - 15, y, 30, 56, 15, C(ink));
    ht_pro_rect(s, cx - 3, y + 74, 6, 14, 0, C(ink));
    ht_pro_rect_aa(s, cx - 18, y + 88, 36, 6, 3, C(ink));
}
static void talk_slot(ht_scene_t *s)
{
    const int x = MAX_TALK_X + MAX_INSET, w = MAX_TALK_W - 2 * MAX_INSET, cx = x + w / 2;
    const bool form = max_form_open();
    const max_agent_t *who = max_find(max_m.talk == MAX_TALK_IDLE ? max_m.selected : max_m.talk_id);
    unsigned fill = HT_THEME_ACCENT, ink = HT_THEME_CANVAS, sub = TALK_SUB;
    const char *label = form ? "Say" : "Talk", *line = who ? who->name : NULL;
    char find[64];
    if (form) {   // a spoken name for the field, as the Dial says it
        const max_page_t *p = &max_m.form.page;
        snprintf(find, sizeof find, "Find %.48s", !strcmp(p->title, "New Harness") ? p->label : p->title);
        line = find;
    }
    if (max_m.talk == MAX_TALK_RECORDING) fill = HT_THEME_FAILED, ink = 0xffffff, sub = 0xf6d5d2, label = "Listening";
    else if (max_m.talk == MAX_TALK_SENDING) fill = HT_THEME_SECONDARY, sub = 0xd8d7cf, label = "Sending";
    else if (form ? !max_form_can_say() : !who) fill = LANE_FILL, ink = sub = HT_THEME_SECONDARY, line = form ? NULL : "Tap a lane";
    if (fill == LANE_FILL) ht_pro_rect_aa_stroke(s, x, MAX_CARD_Y, w, MAX_CARD_H, CARD_R, C(LANE_EDGE), C(fill));
    else ht_pro_rect_aa(s, x, MAX_CARD_Y, w, MAX_CARD_H, CARD_R, C(fill));
    mic(s, cx, CARD_CY - 92, ink, fill);
    max_text_centered(s, cx, CARD_CY + 58, w - 2 * MAX_PAD, &ph_sb_34, ink, label);
    max_text_centered(s, cx, CARD_CY + 102, w - 2 * MAX_PAD, &ph_rg_24, sub, line);
    max_m.talk_box = (max_box_t){(int16_t)x, MAX_CARD_Y, (int16_t)w, MAX_CARD_H};
    max_m.talk_hit = true;
}

// ---- the band under the lanes: a notice, else the page dots ----

static void band(ht_scene_t *s, uint32_t now_ms)
{
    if (max_notice_shown(now_ms)) {
        const ht_pro_font_t *f = &ph_sb_22;
        char row[ROW_BYTES];
        max_cut(row, max_m.notice, f, MAX_LANES * MAX_LANE_W - 2 * MAX_INSET - 40, false);
        const int tw = ht_pro_width(f, row);
        ht_pro_rect_aa(s, LANES_CX - tw / 2 - 20, BAND_CY - 18, tw + 40, 36, 18, C(HT_THEME_ACCENT));
        ht_pro_text(s, LANES_CX - tw / 2, max_top_of(f, BAND_CY), tw, f, C(HT_THEME_CANVAS), row);
        return;
    }
    const int pages = max_pages();
    if (pages < 2 || max_form_open()) return;
    const int x0 = LANES_CX - ((pages - 1) * PAGE_PITCH + PAGE_DOT) / 2;
    for (int p = 0; p < pages; p++)
        max_dot(s, x0 + p * PAGE_PITCH, BAND_CY, PAGE_DOT, p == max_m.page ? HT_THEME_ACCENT : IDLE_DOT);
}

static void update_screen(ht_scene_t *s)
{
    const int cx = HT_WIDTH / 2, bar_w = 800;
    char pct[16], version[MAX_VERSION_BYTES + 8];
    snprintf(pct, sizeof pct, "%d%%", max_m.update_pct);
    max_text_centered(s, cx, MAX_Y(140), 600, &ph_sb_34, HT_THEME_TEXT, "Updating");
    max_text_centered(s, cx, MAX_Y(214), 400, &ph_sb_48, HT_THEME_TEXT, pct);
    ht_pro_rect_aa(s, cx - bar_w / 2, MAX_Y(276), bar_w, 14, 7, C(HT_THEME_SELECTION));
    if (max_m.update_pct > 0)
        ht_pro_rect_aa(s, cx - bar_w / 2, MAX_Y(276), bar_w * max_m.update_pct / 100, 14, 7, C(HT_THEME_ACCENT));
    if (max_m.update_to[0]) {
        snprintf(version, sizeof version, "Version %s", max_m.update_to);
        max_text_centered(s, cx, MAX_Y(334), 600, &ph_rg_24, HT_THEME_SECONDARY, version);
    }
}

// The lanes of the page: three equal columns, or the open card's wide one with its neighbours narrow beside it.
static void lanes(ht_scene_t *s, uint32_t now_ms)
{
    int v[MAX_LANES];
    const int n = max_visible(v), open = max_open_card(v, n, now_ms);
    for (int col = 0, x = MAX_LANE_X; col < n; col++) {
        const max_agent_t *a = &max_m.agents[v[col]];
        int w = MAX_LANE_W;
        if (open >= 0) w = col == open ? MAX_TALK_X - MAX_LANE_X - (n - 1) * MAX_NARROW_W : MAX_NARROW_W;
        if (col == open) max_draw_card(s, x, w, a, now_ms);
        else if (open >= 0) narrow_lane(s, x, w, a, now_ms);
        else lane(s, x, w, a, now_ms);
        max_m.lane_box[col] = (max_box_t){(int16_t)(x + MAX_INSET), MAX_CARD_Y, (int16_t)(w - 2 * MAX_INSET), MAX_CARD_H};
        max_copy(max_m.lane_id[col], sizeof max_m.lane_id[col], a->id);
        max_m.lane_hits = col + 1;
        x += w;
    }
}

void max_ui_render(ht_scene_t *s, uint32_t now_ms)
{
    s->background = C(HT_THEME_CANVAS);
    max_m.lane_hits = 0;
    max_m.talk_hit = false;
    max_m.hit_count = 0;
    max_m.card_id[0] = 0;
    max_m.dirty = false;
    if (max_m.update_pct >= 0) {
        update_screen(s);
    } else if (!max_m.link) {
        max_text_centered(s, HT_WIDTH / 2, CARD_CY, 800, &ph_sb_34, HT_THEME_SECONDARY, "Not connected");
        band(s, now_ms);
    } else {
        rail(s);
        if (max_form_open()) {
            max_draw_form(s);
            talk_slot(s);
        } else if (!max_m.count) {
            max_text_centered(s, LANES_CX, CARD_CY, 800, &ph_sb_34, HT_THEME_SECONDARY, "No agents");
        } else {
            lanes(s, now_ms);
            talk_slot(s);
        }
        band(s, now_ms);
    }
    max_m.drawn_key = max_time_key(now_ms);
}
