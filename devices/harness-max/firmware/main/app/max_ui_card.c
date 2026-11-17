// The open card (max_ui_draw.h): a lane's question with its options as buttons, a permission prompt in the daemon's
// own words, a question only its app or the computer can answer, a finished or failed turn; and New Harness over the
// lanes. Every button is 80 px tall at 480 (9 mm), 69 at 415; a button the finger cannot use now is drawn greyed and
// is no hit.
#include <stdio.h>
#include <string.h>

#include "max_ui_draw.h"

enum {
    GAP = 12, GAP_Y = MAX_Y(12),
    CARD_TEXT_Y = MAX_CARD_Y + MAX_Y(80),                          // the body under the header row: 94 at 480
    GRID_BOTTOM = MAX_CARD_Y + MAX_CARD_H - MAX_Y(20),             // the buttons' last row ends here: 414 at 480
    GRID_ROWS = 3,                                                 // and over it a line of the question, at 415 too
    ONE_BUTTON_W = 200,
    SIDE_W = 280, CLOSE_W = 160, BACK_W = 180, ACTION_W = 240,     // the form's neighbours and buttons
};
static const char CHECK[] = "\xe2\x9c\x93 ";   // a chosen option of several (gen_fonts.py CONSOLE_EXTRA draws it)

typedef enum { STYLE_PLAIN, STYLE_CHOSEN, STYLE_PRIMARY, STYLE_REJECT, STYLE_OFF } style_t;

// A button's words: one line of sb_26, else of sb_22, else two of rg_24 (WRAP), the second cut.
#define WRAP (&ph_rg_24)
static const ht_pro_font_t *face_for(const char *label, int inner)
{
    if (ht_pro_width(&ph_sb_26, label) <= inner) return &ph_sb_26;
    return ht_pro_width(&ph_sb_22, label) <= inner ? &ph_sb_22 : WRAP;
}
// What is left for a second line once the first is filled.
static const char *second_line(const char *label, int inner)
{
    const char *rest = label + max_fit(label, WRAP, inner);
    while (*rest == ' ') rest++;
    return rest;
}
// Whether a label reads whole in a button `inner` px wide.
static bool fits(const char *label, int inner)
{
    return face_for(label, inner) != WRAP || ht_pro_width(WRAP, second_line(label, inner)) <= inner;
}

// `face`: the one its row of buttons shares, or NULL for the label's own.
static void button(ht_scene_t *s, int x, int y, int w, int h, style_t style, const char *label, const ht_pro_font_t *face)
{
    unsigned ink = HT_THEME_TEXT;
    switch (style) {
    case STYLE_PRIMARY:
        ht_pro_rect_aa(s, x, y, w, h, BUTTON_R, C(HT_THEME_ACCENT));
        ink = HT_THEME_CANVAS;
        break;
    case STYLE_CHOSEN:
        ht_pro_rect_aa(s, x, y, w, h, BUTTON_R, C(HT_THEME_ACCENT));
        ht_pro_rect_aa(s, x + SELECT_W, y + SELECT_W, w - 2 * SELECT_W, h - 2 * SELECT_W, BUTTON_R - SELECT_W,
                       C(BUTTON_FILL));
        break;
    case STYLE_REJECT:
        ht_pro_rect_aa_stroke(s, x, y, w, h, BUTTON_R, C(FAIL_EDGE), C(BUTTON_FILL));
        ink = HT_THEME_FAILED;
        break;
    case STYLE_OFF:
        ht_pro_rect_aa_stroke(s, x, y, w, h, BUTTON_R, C(LANE_EDGE), C(LANE_FILL));
        ink = HT_THEME_SECONDARY;
        break;
    default:
        ht_pro_rect_aa_stroke(s, x, y, w, h, BUTTON_R, C(LANE_EDGE), C(BUTTON_FILL));
        break;
    }
    const int inner = w - 2 * GAP, cx = x + w / 2, cy = y + h / 2;
    const ht_pro_font_t *f = face ? face : face_for(label, inner);
    const char *rest = f == WRAP ? second_line(label, inner) : "";
    if (!rest[0]) {
        max_text_centered(s, cx, cy, inner, f, ink, label);
        return;
    }
    char row[ROW_BYTES];
    snprintf(row, sizeof row, "%.*s", (int)(rest - label), label);
    max_text_centered(s, cx, cy - f->height / 2, inner, f, ink, row);
    max_text_centered(s, cx, cy + f->height / 2, inner, f, ink, rest);
}

// The header row: the name and where it runs on the left; the state, the question's step and the clock on the right.
static void header(ht_scene_t *s, int tx, int tw, const max_agent_t *a, const char *word, unsigned word_ink,
                   const char *step, uint32_t now_ms)
{
    int right = tx + tw;
    char clock[24];
    max_fmt_elapsed(clock, sizeof clock, max_secs(a, now_ms));
    if (clock[0]) {
        const int cw = ht_pro_width(&ph_mono_26, clock);
        max_text(s, right - cw, NAME_CY, cw, &ph_mono_26, HT_THEME_SECONDARY, clock);
        right -= cw + 24;
    }
    if (step && step[0]) {
        const int sw = ht_pro_width(&ph_rg_24, step);
        max_text(s, right - sw, NAME_CY, sw, &ph_rg_24, HT_THEME_SECONDARY, step);
        right -= sw + 24;
    }
    const int ww = ht_pro_width(&ph_sb_26, word);
    max_text(s, right - ww, NAME_CY, ww, &ph_sb_26, word_ink, word);
    right -= ww + 10 + DOT;
    max_dot(s, right, NAME_CY, DOT, max_state_dot(a->state));
    right -= 32;
    const int name_w = max_text(s, tx, NAME_CY, (right - tx) * 3 / 5, &ph_sb_32, HT_THEME_TEXT, a->name);
    char meta[64];
    snprintf(meta, sizeof meta, "%s%s%s", a->engine, a->engine[0] && a->machine[0] ? " \xc2\xb7 " : "", a->machine);
    max_text(s, tx + name_w + 20, NAME_CY, right - tx - name_w - 20, &ph_rg_24, HT_THEME_SECONDARY, meta);
}

// The body: as many rows as fit between the header and `bottom`.
static void body(ht_scene_t *s, int tx, int tw, int bottom, unsigned ink, const char *t)
{
    const int rows = (bottom - CARD_TEXT_Y) / ph_rg_28.height;
    if (rows > 0) max_paragraph(s, tx, CARD_TEXT_Y, tw, &ph_rg_28, ink, t, rows);
}

// The last row when it holds no grid: a line (two when it must) and, at the right, one button or none.
static void footer(ht_scene_t *s, int tx, int tw, unsigned ink, const char *line, const char *label, max_hit_kind_t kind)
{
    const int y = GRID_BOTTOM - MAX_BUTTON_H, bw = label ? ONE_BUTTON_W : 0, lw = tw - (bw ? bw + 24 : 0);
    const ht_pro_font_t *f = &ph_rg_24;
    if (line && ht_pro_width(f, line) > lw) max_paragraph(s, tx, y + MAX_BUTTON_H / 2 - f->height, lw, f, ink, line, 2);
    else max_text(s, tx, y + MAX_BUTTON_H / 2, lw, &ph_sb_26, ink, line);
    if (!label) return;
    button(s, tx + tw - bw, y, bw, MAX_BUTTON_H, STYLE_PLAIN, label, NULL);
    max_hit(tx + tw - bw, y, bw, MAX_BUTTON_H, kind, 0);
}

static const char *ask_word(const max_ask_t *k)
{
    if (k->phase == MAX_ASK_SENDING) return "Sending";
    if (k->phase == MAX_ASK_SENT) return "Sent";
    return k->permission ? "Permission" : "Asks";
}

typedef struct {
    char label[PRO_OPTION_BYTES + sizeof CHECK];
    style_t style;
    max_hit_kind_t kind;
    int arg, slot;
} cell_t;

static void question(ht_scene_t *s, int tx, int tw, const max_agent_t *a, const max_ask_t *k)
{
    const max_item_t *it = k->count ? &k->items[k->step] : NULL;
    const char *prompt = it ? it->q : a->question;
    if (k->path == MAX_PATH_SHOWN || k->path == MAX_PATH_NONE || k->phase == MAX_ASK_FAILED || !it) {
        char where[CABLE_NAME_MAX + 16];
        snprintf(where, sizeof where, "Answer it %s%s", k->app[0] ? "in " : "on the computer", k->app);
        const bool failed = k->phase == MAX_ASK_FAILED;
        body(s, tx, tw, GRID_BOTTOM - MAX_BUTTON_H - GAP_Y, HT_THEME_TEXT, prompt);
        footer(s, tx, tw, failed ? HT_THEME_ERROR : HT_THEME_SECONDARY, failed ? k->note : where,
               failed && k->path == MAX_PATH_REVIEWED ? "Reload" : NULL, MAX_HIT_RELOAD);
        return;
    }
    // The buttons: the options, then the question before and Send (several choices, or Next before the last).
    const bool ready = k->phase == MAX_ASK_READY;
    const uint8_t chosen = k->choices[k->step];
    cell_t cells[PRO_ASK_OPTIONS + 2];
    int n = 0;
    for (int j = 0; j < it->option_count; j++, n++) {
        cell_t *c = &cells[n];
        const bool on = chosen & (1u << j);
        snprintf(c->label, sizeof c->label, "%s%s", on && it->multi ? CHECK : "", it->options[j]);
        // A permission prompt's yes (its first option, as the daemon reads one) and its no stand out.
        c->style = on ? STYLE_CHOSEN : !ready ? STYLE_OFF
                 : k->permission && !j && max_option_approves(it->options[j]) ? STYLE_PRIMARY
                 : k->permission && max_option_rejects(it->options[j]) ? STYLE_REJECT : STYLE_PLAIN;
        c->kind = MAX_HIT_OPTION;
        c->arg = j;
    }
    const int options = n;
    if (k->step) cells[n++] = (cell_t){"Back", ready ? STYLE_PLAIN : STYLE_OFF, MAX_HIT_STEP_BACK, 0, 0};
    if (it->multi) {
        cells[n] = (cell_t){"Send", ready && chosen ? STYLE_PRIMARY : STYLE_OFF, MAX_HIT_SEND, 0, 0};
        if (k->step + 1 < k->count) snprintf(cells[n].label, sizeof cells[n].label, "Next");
        n++;
    }
    // One row for up to four buttons, two for more; more rows while a label would be cut, the question keeping a line.
    int rows = n <= 4 ? 1 : 2, cols, cell_w;
    for (;; rows++) {
        cols = (n + rows - 1) / rows;
        cell_w = (tw - (cols - 1) * GAP) / cols;
        bool whole = true;
        for (int i = 0; i < n && whole; i++) whole = fits(cells[i].label, cell_w - 2 * GAP);
        if (whole || rows == GRID_ROWS || cols == 1) break;
    }
    // One face for the grid: the largest every label takes on one line, else two lines each.
    const ht_pro_font_t *face = &ph_sb_26;
    for (int i = 0; i < n; i++) {
        const ht_pro_font_t *f = face_for(cells[i].label, cell_w - 2 * GAP);
        if (f == WRAP || (f == &ph_sb_22 && face == &ph_sb_26)) face = f;
    }
    // The options from the first slot, Back and Send in the last ones: Send is always at the bottom right.
    for (int i = 0; i < n; i++) cells[i].slot = i < options ? i : rows * cols - (n - i);
    const int top = GRID_BOTTOM - rows * MAX_BUTTON_H - (rows - 1) * GAP_Y;
    for (int i = 0; i < n; i++) {
        const cell_t *c = &cells[i];
        const int x = tx + c->slot % cols * (cell_w + GAP), y = top + c->slot / cols * (MAX_BUTTON_H + GAP_Y);
        button(s, x, y, cell_w, MAX_BUTTON_H, c->style, c->label, face);
        if (ready && c->style != STYLE_OFF) max_hit(x, y, cell_w, MAX_BUTTON_H, c->kind, c->arg);
    }
    int bottom = top - GAP_Y;
    if (k->note[0]) {   // what the daemon said of an answer already in
        max_text(s, tx, bottom - ph_rg_24.height / 2, tw, &ph_rg_24, HT_THEME_SECONDARY, k->note);
        bottom -= ph_rg_24.height;
    }
    body(s, tx, tw, bottom, HT_THEME_TEXT, prompt);
}

void max_draw_card(ht_scene_t *s, int col_x, int col_w, const max_agent_t *a, uint32_t now_ms)
{
    const int x = col_x + MAX_INSET, w = col_w - 2 * MAX_INSET, tx = x + MAX_PAD, tw = w - 2 * MAX_PAD;
    const max_ask_t *k = a->state == MAX_ASKING ? max_ask_of(a->id) : NULL;
    unsigned fill = LANE_FILL, edge = LANE_EDGE;
    if (k) fill = ASK_FILL, edge = ASK_EDGE;
    if (a->state == MAX_FAILED) fill = FAIL_FILL, edge = FAIL_EDGE;
    max_card_frame(s, x, MAX_CARD_Y, w, MAX_CARD_H, fill, edge, !strcmp(max_m.selected, a->id));
    max_copy(max_m.card_id, sizeof max_m.card_id, a->id);
    max_m.card_key = max_card_key(a);
    if (k) {
        char step[16] = "";
        if (k->count > 1) snprintf(step, sizeof step, "%d / %d", k->step + 1, k->count);
        header(s, tx, tw, a, ask_word(k), HT_THEME_TEXT, step, now_ms);
        question(s, tx, tw, a, k);
        return;
    }
    const bool failed = a->state == MAX_FAILED;
    header(s, tx, tw, a, max_state_word(a), failed ? HT_THEME_FAILED : HT_THEME_TEXT, NULL, now_ms);
    body(s, tx, tw, GRID_BOTTOM - MAX_BUTTON_H - GAP_Y, failed ? HT_THEME_ERROR : HT_THEME_TEXT, a->note);
    footer(s, tx, tw, HT_THEME_SECONDARY, NULL, "Dismiss", MAX_HIT_DISMISS);
}

// ---- New Harness ----

// A neighbour of the focused choice: the arrow and its words, a tap away.
static void side(ht_scene_t *s, int x, int y, int w, int h, const char *arrow, const char *t, bool on, int delta)
{
    if (!t[0]) return;
    ht_pro_rect_aa_stroke(s, x, y, w, h, BUTTON_R, C(LANE_EDGE), C(LANE_FILL));
    const int tx = x + MAX_PAD, tw = w - 2 * MAX_PAD;
    max_text(s, tx, y + MAX_Y(36), tw, &ph_sb_26, on ? HT_THEME_TEXT : HT_THEME_SECONDARY, arrow);
    const int rows = (h - MAX_Y(64)) / ph_rg_24.height;
    max_paragraph(s, tx, y + MAX_Y(58), tw, &ph_rg_24, HT_THEME_SECONDARY, t, rows);
    if (on) max_hit(x, y, w, h, MAX_HIT_FORM_MOVE, delta);
}

// The detail's lines, each wrapped, in at most `rows` rows.
static void detail(ht_scene_t *s, int x, int y, int w, int rows, unsigned ink, const char *t)
{
    char part[sizeof max_m.form.page.detail];
    while (*t && rows > 0) {
        const char *end = strchr(t, '\n');
        const size_t n = end ? (size_t)(end - t) : strlen(t);
        snprintf(part, sizeof part, "%.*s", (int)n, t);
        const int below = max_paragraph(s, x, y, w, &ph_rg_24, ink, part, rows);
        rows -= (below - y) / ph_rg_24.height;
        y = below;
        t += n + (end ? 1 : 0);
    }
}

void max_draw_form(ht_scene_t *s)
{
    const max_form_t *f = &max_m.form;
    const max_page_t *p = &f->page;
    const int x = MAX_LANE_X + MAX_INSET, w = MAX_TALK_X - MAX_LANE_X - 2 * MAX_INSET;
    const int tx = x + MAX_PAD, tw = w - 2 * MAX_PAD;
    max_card_frame(s, x, MAX_CARD_Y, w, MAX_CARD_H, LANE_FILL, LANE_EDGE, false);
    max_m.form_revision = p->revision;
    const bool live = p->active && !f->failed;              // a page the finger can work
    const bool idle = live && !f->pending && !p->busy;      // and nothing in flight

    // The title, where in the form, and Close.
    const int head_y = MAX_CARD_Y + MAX_Y(16), head_cy = head_y + MAX_BUTTON_H / 2;
    button(s, tx + tw - CLOSE_W, head_y, CLOSE_W, MAX_BUTTON_H, STYLE_PLAIN, "Close", NULL);
    max_hit(tx + tw - CLOSE_W, head_y, CLOSE_W, MAX_BUTTON_H, MAX_HIT_FORM_CLOSE, 0);
    const int title_w = max_text(s, tx, head_cy, tw - CLOSE_W - 240, &ph_sb_32, HT_THEME_TEXT,
                                 p->title[0] ? p->title : "New Harness");
    char where[24] = "";
    if (p->total) snprintf(where, sizeof where, "%d / %d", (int)p->position, (int)p->total);
    max_text(s, tx + title_w + 24, head_cy, tw - CLOSE_W - title_w - 48, &ph_rg_24, HT_THEME_SECONDARY,
             p->query[0] ? p->query : where);

    // The choices: the one before, the focused one, the one after.
    const int foot_y = MAX_CARD_Y + MAX_CARD_H - MAX_Y(16) - MAX_BUTTON_H;
    const int top = head_y + MAX_BUTTON_H + MAX_Y(16), h = foot_y - MAX_Y(16) - top;
    const bool moves = live && !p->busy;
    side(s, tx, top, SIDE_W, h, "\xe2\x86\x90", p->previous, moves, -1);
    side(s, tx + tw - SIDE_W, top, SIDE_W, h, "\xe2\x86\x92", p->next, moves, 1);
    const int fx = tx + SIDE_W + 16, fw = tw - 2 * (SIDE_W + 16);
    max_card_frame(s, fx, top, fw, h, BUTTON_FILL, LANE_EDGE, live);
    const char *label = p->label[0] ? p->label : f->failed ? "Could not open" : "Opening\xe2\x80\xa6";
    const int label_cy = top + MAX_Y(40);
    max_text(s, fx + MAX_PAD, label_cy, fw - 2 * MAX_PAD, &ph_sb_34, p->label[0] ? HT_THEME_TEXT : HT_THEME_SECONDARY, label);
    const int detail_y = label_cy + ph_sb_34.height / 2 + 4;
    detail(s, fx + MAX_PAD, detail_y, fw - 2 * MAX_PAD, (top + h - MAX_Y(12) - detail_y) / ph_rg_24.height,
           HT_THEME_SECONDARY, p->detail);
    if (idle && p->enabled) max_hit(fx, top, fw, h, MAX_HIT_FORM_PICK, 0);

    // Back, what is happening, and the action.
    if (!f->failed) {
        button(s, tx, foot_y, BACK_W, MAX_BUTTON_H, idle ? STYLE_PLAIN : STYLE_OFF, "Back", NULL);
        if (idle) max_hit(tx, foot_y, BACK_W, MAX_BUTTON_H, MAX_HIT_FORM_BACK, 0);
    }
    const int mid_x = f->failed ? tx : tx + BACK_W + 24, mid_w = tx + tw - ACTION_W - 24 - mid_x;
    const int foot_cy = foot_y + MAX_BUTTON_H / 2;
    if (p->error[0]) max_text(s, mid_x, foot_cy, mid_w, &ph_rg_24, HT_THEME_ERROR, p->error);
    else if (p->status[0]) max_text(s, mid_x, foot_cy, mid_w, &ph_rg_24, HT_THEME_SECONDARY, p->status);
    char action[32];
    snprintf(action, sizeof action, "%s", f->failed ? "Retry" : p->busy ? "Wait" : p->action[0] ? p->action : "Choose");
    if (action[0] >= 'a' && action[0] <= 'z') action[0] = (char)(action[0] - 'a' + 'A');   // "check status": "Check status"
    const bool act = f->failed || (idle && p->enabled);
    button(s, tx + tw - ACTION_W, foot_y, ACTION_W, MAX_BUTTON_H, act ? STYLE_PRIMARY : STYLE_OFF, action, NULL);
    if (act) max_hit(tx + tw - ACTION_W, foot_y, ACTION_W, MAX_BUTTON_H, f->failed ? MAX_HIT_FORM_RETRY : MAX_HIT_FORM_PICK, 0);
}
