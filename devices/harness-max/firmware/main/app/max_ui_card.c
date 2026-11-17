// The room (max_ui_draw.h): one agent, large. Its name, engine, machine and state across the top; on the left its pet,
// which is the Talk button (Tap to talk under it); on the right its bubble (the question or the permission prompt on
// paper, what it is doing in a thought with the newest step under it, a failure or a summary on paper, "Talking to"
// while a person talks to it) and the buttons: the answers, Yes and No, Dismiss, or Cancel and Send. And New Harness
// over the room and the lanes. Every button is 80 px tall at 480 (9 mm), 69 at 415; a button the finger cannot use now
// is drawn greyed and is no hit.
#include <stdio.h>
#include <string.h>

#include "max_ui_draw.h"

enum {
    PAD_X = 24, GAP = 12, GAP_Y = MAX_Y(12), STACK_GAP = MAX_Y(20),
    HEAD_CY = MAX_CARD_Y + 38,                                            // the name and the state: 58 at 480
    BODY_Y = MAX_CARD_Y + 70, BODY_BOTTOM = MAX_CARD_Y + MAX_CARD_H - 20, // the pet and the bubble: 90..440 at 480
    PET_X = MAX_ROOM_X + PAD_X, PET_W = 220, PET_CX = PET_X + PET_W / 2,
    BODY_X = PET_X + PET_W + 22, BODY_W = MAX_ROOM_X + MAX_ROOM_W - PAD_X - BODY_X,   // 288..818
    PILL_H = 40, PILL_Y = BODY_BOTTOM - PILL_H, PET_FOOT = PILL_Y - 16, PET_MAX_H = MAX_Y(200),
    ROOM_ROWS = 3, GRID_ROWS = 3, ONE_BUTTON_W = 200, LABEL_PAD = 12,
    END_MIN_W = 90, END_MAX_W = 150,   // a permission prompt's yes and no: a finger's width, and the most they take
    STEP_GAP = 10,
    SIDE_W = 280, BACK_W = 180, ACTION_W = 240, SAY_W = 160, FORM_R = 34,
};
static const char CHECK[] = "\xe2\x9c\x93 ";   // a chosen option of several (gen_fonts.py CONSOLE_EXTRA draws it)
static const max_bubble_style_t SAY = {&ph_sb_32, 26, 18, 26, TAIL_LEFT};
static const max_bubble_style_t THINK = {&ph_sb_26, 20, 14, 22, TAIL_LEFT};
#define LABEL (&ph_sb_22)

// ---- buttons ----

int max_label_rows(const char *label, int inner)
{
    if (ht_pro_width(LABEL, label) <= inner) return 1;
    const char *rest = label + max_fit(label, LABEL, inner);
    while (*rest == ' ') rest++;
    return ht_pro_width(LABEL, rest) <= inner ? 2 : 3;
}

static const struct { unsigned fill, edge, ink; int line; } LOOKS[] = {
    [STYLE_PLAIN] = {PAPER, PAPER_EDGE, PAPER_INK, LINE_W},   // an answer: the speech bubble's paper
    [STYLE_CHOSEN] = {PAPER, GREEN, PAPER_INK, SELECT_W},     // one of several, chosen
    [STYLE_PRIMARY] = {GREEN, GREEN, GREEN_INK, 0},           // Yes, Send, the form's action
    [STYLE_REJECT] = {GROUND, NO_EDGE, NO_INK, LINE_W},       // No
    [STYLE_GHOST] = {GROUND, EDGE, INK, LINE_W},              // Dismiss, Cancel, Reload
    [STYLE_OFF] = {RAISED, EDGE, MUTED, LINE_W},              // nothing to press now
    [STYLE_NAVY] = {NAVY, NAVY_EDGE, NAVY_INK, LINE_W},       // the form's own
    [STYLE_NAVY_OFF] = {NAVY, NAVY_EDGE, NAVY_MUTED, LINE_W}, // and one of them with nothing to press now
};

void max_button(ht_scene_t *s, int x, int y, int w, int h, max_style_t style, const char *label)
{
    max_box(s, x, y, w, h, BUTTON_R, LOOKS[style].line, LOOKS[style].edge, LOOKS[style].fill);
    const int inner = w - 2 * LABEL_PAD, cx = x + w / 2;
    char rows[2][ROW_BYTES];
    const int n = max_wrap(rows, 2, label, LABEL, inner);
    for (int i = 0; i < n; i++)
        max_text_centered(s, cx, y + h / 2 + (2 * i - (n - 1)) * LABEL->height / 2, inner, LABEL, LOOKS[style].ink, rows[i]);
}

// ---- the room ----

// A microphone, 14 x 22 px from (x, y): the capsule in its cradle on a stand.
static void mic(ht_scene_t *s, int x, int y, unsigned ink)
{
    ht_pro_rect_aa(s, x + 3, y, 8, 13, 4, C(ink));
    pod_arc(s, (x + 7) * 16, (y + 9) * 16, 6 * 16, 2 * 16, 270, 90, C(ink));
    ht_pro_rect(s, x + 6, y + 15, 2, 4, 0, C(ink));
    ht_pro_rect_aa(s, x + 2, y + 19, 10, 3, 1, C(ink));
}
// Tap to talk, under the pet: the pet and the pill are one hit.
static void talk_pill(ht_scene_t *s)
{
    static const char WORDS[] = "Tap to talk";
    const int tw = ht_pro_width(LABEL, WORDS), w = 12 + 14 + 10 + tw + 18, x = PET_CX - w / 2;
    max_box(s, x, PILL_Y, w, PILL_H, PILL_H / 2, LINE_W, EDGE, RAISED);
    mic(s, x + 12, PILL_Y + (PILL_H - 22) / 2, INK);
    max_text(s, x + 12 + 14 + 10, PILL_Y + PILL_H / 2, tw, LABEL, INK, WORDS);
}

// "Claude", "Codex": the engine as the header names it.
static void engine_name(char *out, size_t cap, const char *engine)
{
    snprintf(out, cap, "%s", engine);
    if (out[0] >= 'a' && out[0] <= 'z') out[0] = (char)(out[0] - 'a' + 'A');
}
// The header: the name and where it runs on the left; the question's step and the state on the right.
static void header(ht_scene_t *s, const max_agent_t *a, const char *state, unsigned state_ink, const char *step)
{
    const int left = PET_X;
    int right = BODY_X + BODY_W;
    right -= max_text_right(s, right, HEAD_CY, BODY_W / 2, LABEL, state_ink, state) + 20;
    if (step && step[0]) right -= max_text_right(s, right, HEAD_CY, 120, LABEL, MUTED, step) + 20;
    const int name_w = max_text(s, left, HEAD_CY, (right - left) * 3 / 5, &ph_sb_26, INK, a->name);
    char engine[16], meta[64];
    engine_name(engine, sizeof engine, a->engine);
    snprintf(meta, sizeof meta, "%s%s%s", engine, engine[0] && a->machine[0] ? " \xc2\xb7 " : "", a->machine);
    max_text(s, left + name_w + 14, HEAD_CY, right - left - name_w - 14, LABEL, MUTED, meta);
}

// The bubble's rows: as many as leave `below` px under it (and a gap) in the body, at most ROOM_ROWS, at least one.
static int bubble_rows(char rows[][ROW_BYTES], const max_bubble_style_t *st, const char *t, int below)
{
    int fit = (BODY_BOTTOM - BODY_Y - (below ? below + STACK_GAP : 0) - 2 * st->pad_y) / st->f->height;
    if (fit > ROOM_ROWS) fit = ROOM_ROWS;
    if (fit < 1) fit = 1;
    return max_wrap(rows, fit, t, st->f, BODY_W - 2 * st->pad_x);
}
// The bubble and `below` px under it, the pair centred in the body. Returns the y under the bubble (and its gap).
static int bubble(ht_scene_t *s, max_bubble_kind_t kind, const char *t, int below, const char *step)
{
    const max_bubble_style_t *st = kind == BUBBLE_THOUGHT ? &THINK : &SAY;
    char rows[ROOM_ROWS][ROW_BYTES];
    const int extra = step && step[0] ? STEP_GAP + ph_mono_18.height : 0;
    const int n = bubble_rows(rows, st, t, below + extra);
    const int h = n ? max_bubble_h(st, n) : 0, stack = h + extra + (below && n ? STACK_GAP : 0) + below;
    int y = BODY_Y + (BODY_BOTTOM - BODY_Y - stack) / 2;
    if (y < BODY_Y) y = BODY_Y;
    if (n) max_bubble(s, kind, st, BODY_X, y, BODY_W, rows, n);
    if (extra) max_line(s, BODY_X + st->pad_x, y + h + STEP_GAP, BODY_W - 2 * st->pad_x, &ph_mono_18, MUTED, step, false);
    return y + h + extra + (n ? STACK_GAP : 0);
}

// The last row when it holds no grid: a line (two when it must) and, at the right, one button or none.
static void footer(ht_scene_t *s, int y, unsigned ink, const char *line, const char *label, max_hit_kind_t kind)
{
    const int bw = label ? ONE_BUTTON_W : 0, lw = BODY_W - (bw ? bw + 24 : 0), cy = y + MAX_BUTTON_H / 2;
    if (line && ht_pro_width(LABEL, line) > lw) max_paragraph(s, BODY_X, cy - LABEL->height, lw, LABEL, ink, line, 2);
    else max_text(s, BODY_X, cy, lw, LABEL, ink, line);
    if (!label) return;
    max_button(s, BODY_X + BODY_W - bw, y, bw, MAX_BUTTON_H, STYLE_GHOST, label);
    max_hit(BODY_X + BODY_W - bw, y, bw, MAX_BUTTON_H, kind, 0);
}

static const char *ask_word(const max_ask_t *k)
{
    if (k->phase == MAX_ASK_SENDING) return "Sending\xe2\x80\xa6";
    if (k->phase == MAX_ASK_SENT) return "Sent";
    return k->permission ? "Permission" : "Asks";
}

typedef struct {
    char label[PRO_OPTION_BYTES + sizeof CHECK];
    max_style_t style;
    max_hit_kind_t kind;
    int arg, x, w, row;   // where it stands: from x, w wide, in that row
} cell_t;

// A permission prompt's three options on one row (yes, the lasting yes "don't ask again for: …", no): the ends as wide
// as their words on one row, END_MIN_W to END_MAX_W, the middle one the rest, the widest. A label longer than its
// button takes two rows, cut after them.
static void permission_row(cell_t c[3])
{
    for (int i = 0; i < 3; i += 2) {
        const int w = ht_pro_width(LABEL, c[i].label) + 2 * LABEL_PAD;
        c[i].w = w < END_MIN_W ? END_MIN_W : w > END_MAX_W ? END_MAX_W : w;
    }
    c[1].w = BODY_W - c[0].w - c[2].w - 2 * GAP;
    c[1].x = BODY_X + c[0].w + GAP;
    c[2].x = BODY_X + BODY_W - c[2].w;
}

static void question(ht_scene_t *s, const max_agent_t *a, const max_ask_t *k)
{
    const max_item_t *it = k->count ? &k->items[k->step] : NULL;
    const char *prompt = it ? it->q : a->question;
    if (k->path == MAX_PATH_SHOWN || k->path == MAX_PATH_NONE || k->phase == MAX_ASK_FAILED || !it) {
        char where[CABLE_NAME_MAX + 16];
        snprintf(where, sizeof where, "Answer it %s%s", k->app[0] ? "in " : "on the computer", k->app);
        const bool failed = k->phase == MAX_ASK_FAILED;
        const int y = bubble(s, BUBBLE_SPEECH, prompt, MAX_BUTTON_H, NULL);
        footer(s, y, failed ? FAIL_INK : MUTED, failed ? k->note : where,
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
    if (k->step)
        cells[n++] = (cell_t){.label = "Back", .style = ready ? STYLE_GHOST : STYLE_OFF, .kind = MAX_HIT_STEP_BACK};
    if (it->multi) {
        cells[n] = (cell_t){.label = "Send", .style = ready && chosen ? STYLE_PRIMARY : STYLE_OFF, .kind = MAX_HIT_SEND};
        if (k->step + 1 < k->count) snprintf(cells[n].label, sizeof cells[n].label, "Next");
        n++;
    }
    // One row for up to four buttons, two for more; more rows while a label would be cut, as long as a line of the
    // question stays over them. A permission prompt's three options keep one row.
    const bool one_row = k->permission && options == 3 && n == 3;
    const int most = (BODY_BOTTOM - BODY_Y - STACK_GAP - max_bubble_h(&SAY, 1) + GAP_Y) / (MAX_BUTTON_H + GAP_Y);
    int rows = n <= 4 ? 1 : 2, cols, cell_w, label_rows;
    for (;; rows++) {
        cols = (n + rows - 1) / rows;
        cell_w = (BODY_W - (cols - 1) * GAP) / cols;
        label_rows = 1;
        for (int i = 0; i < n; i++) {
            const int r = max_label_rows(cells[i].label, cell_w - 2 * LABEL_PAD);
            if (r > label_rows) label_rows = r;
        }
        if (one_row || label_rows < 3 || rows >= GRID_ROWS || rows >= most || cols == 1) break;
    }
    // The options from the first slot, Back and Send in the last ones: Send is always at the bottom right.
    for (int i = 0; i < n; i++) {
        const int slot = i < options ? i : rows * cols - (n - i);
        cells[i].x = BODY_X + slot % cols * (cell_w + GAP), cells[i].w = cell_w, cells[i].row = slot / cols;
    }
    if (one_row) permission_row(cells);
    const int grid_h = rows * MAX_BUTTON_H + (rows - 1) * GAP_Y, note_h = k->note[0] ? LABEL->height : 0;
    int top = bubble(s, BUBBLE_SPEECH, prompt, grid_h + note_h, NULL);
    if (note_h) {   // what the daemon said of an answer already in
        max_text(s, BODY_X, top + note_h / 2 - GAP_Y, BODY_W, LABEL, MUTED, k->note);
        top += note_h;
    }
    for (int i = 0; i < n; i++) {
        const cell_t *c = &cells[i];
        const int y = top + c->row * (MAX_BUTTON_H + GAP_Y);
        max_button(s, c->x, y, c->w, MAX_BUTTON_H, c->style, c->label);
        if (ready && c->style != STYLE_OFF) max_hit(c->x, y, c->w, MAX_BUTTON_H, c->kind, c->arg);
    }
}

// Two buttons side by side under the bubble, left and right.
static void pair(ht_scene_t *s, int y, const char *left, max_style_t ls, max_hit_kind_t lk, const char *right,
                 max_style_t rs, max_hit_kind_t rk)
{
    const int w = (BODY_W - GAP) / 2, rx = BODY_X + w + GAP;
    max_button(s, BODY_X, y, w, MAX_BUTTON_H, ls, left);
    max_hit(BODY_X, y, w, MAX_BUTTON_H, lk, 0);
    max_button(s, rx, y, w, MAX_BUTTON_H, rs, right);
    max_hit(rx, y, w, MAX_BUTTON_H, rk, 0);
}

void max_draw_room(ht_scene_t *s, const max_agent_t *a, uint32_t now_ms)
{
    const bool talking = a && max_m.talk != MAX_TALK_IDLE && !strcmp(max_m.talk_id, a->id);
    const max_ask_t *k = a && a->state == MAX_ASKING ? max_ask_of(a->id) : NULL;
    const unsigned edge = talking ? YOU : a && a->state == MAX_ASKING ? PEACH : EDGE;
    max_box(s, MAX_ROOM_X, MAX_CARD_Y, MAX_ROOM_W, MAX_CARD_H, CARD_R, LINE_W, edge, GROUND);
    if (!a) {
        const char *say = !max_m.link ? "Waiting for the computer" : max_m.count ? "Tap a lane" : "No agents";
        max_text_centered(s, MAX_ROOM_X + MAX_ROOM_W / 2, MAX_CARD_Y + MAX_CARD_H / 2, MAX_ROOM_W - 2 * PAD_X, &ph_sb_26,
                          MUTED, say);
        return;
    }
    // The header's state.
    char state[MAX_VERB_BYTES + 32], step[16] = "";
    unsigned ink = MUTED;
    if (talking) snprintf(state, sizeof state, "%s", max_m.talk == MAX_TALK_RECORDING ? "Listening" : "Sending\xe2\x80\xa6"), ink = YOU;
    else if (k) max_state_line(state, sizeof state, a, ask_word(k), now_ms), ink = PEACH;
    else max_state_line(state, sizeof state, a, max_state_word(a), now_ms);
    if (!talking && a->state == MAX_WORKING) ink = GREEN;
    if (!talking && a->state == MAX_FAILED) ink = FAIL_INK;
    if (!talking && k && k->count > 1) snprintf(step, sizeof step, "%d / %d", k->step + 1, k->count);
    header(s, a, state, ink, step);

    // The pet, which takes voice: Tap to talk under it.
    const pod_scene_t scene = max_pet_scene(a, true);
    max_pet(s, a, scene, PET_CX, PET_FOOT, PET_W / 2, PET_FOOT - BODY_Y < PET_MAX_H ? PET_FOOT - BODY_Y : PET_MAX_H,
            GROUND, now_ms, false);
    max_motion(now_ms, max_pet_next_ms(a, scene, now_ms));
    if (max_can_talk(a)) {
        talk_pill(s);
        max_hit(PET_X, BODY_Y, PET_W, BODY_BOTTOM - BODY_Y, MAX_HIT_TALK, 0);
    }

    // The bubble and its buttons.
    if (talking) {
        char words[CABLE_NAME_MAX + 24];
        const size_t len = strlen(a->name);
        // A name the model cut already ends in an ellipsis (max_copy_label): one is enough.
        const bool cut = len >= 3 && !strcmp(a->name + len - 3, "\xe2\x80\xa6");
        snprintf(words, sizeof words, "Talking to %s%s", a->name, cut ? "" : "\xe2\x80\xa6");
        const bool recording = max_m.talk == MAX_TALK_RECORDING;
        const int y = bubble(s, BUBBLE_YOU, words, recording ? MAX_BUTTON_H : 0, NULL);
        if (recording) pair(s, y, "Cancel", STYLE_GHOST, MAX_HIT_TALK_CANCEL, "Send", STYLE_PRIMARY, MAX_HIT_TALK_SEND);
        return;
    }
    max_copy(max_m.card_id, sizeof max_m.card_id, a->id);
    max_m.card_key = max_card_key(a);
    if (k) {
        question(s, a, k);
        return;
    }
    switch (a->state) {
    case MAX_ASKING:   // the prompt the cable gave, with no way to answer it here
        bubble(s, BUBBLE_SPEECH, a->question, 0, NULL);
        break;
    case MAX_WORKING:
        bubble(s, BUBBLE_THOUGHT, a->activity[0] ? a->activity : max_state_word(a), 0, a->step_count ? a->steps[0] : NULL);
        break;
    case MAX_FAILED:
    case MAX_DONE: {
        if (!max_note_shown(a, now_ms)) break;
        const bool dismiss = max_has_card(a, now_ms);
        const int y = bubble(s, a->state == MAX_FAILED ? BUBBLE_BAD : BUBBLE_LETTER, a->note, dismiss ? MAX_BUTTON_H : 0, NULL);
        if (!dismiss) break;
        max_button(s, BODY_X, y, ONE_BUTTON_W, MAX_BUTTON_H, STYLE_GHOST, "Dismiss");
        max_hit(BODY_X, y, ONE_BUTTON_W, MAX_BUTTON_H, MAX_HIT_DISMISS, 0);
        break;
    }
    default:
        break;
    }
}

// ---- New Harness, on the toast's navy ----

// A neighbour of the focused choice: the arrow and its words, a tap away.
static void side(ht_scene_t *s, int x, int y, int w, int h, const char *arrow, const char *t, bool on, int delta)
{
    if (!t[0]) return;
    max_box(s, x, y, w, h, BUTTON_R, LINE_W, NAVY_EDGE, NAVY_RAISED);
    const int tx = x + FORM_PAD, tw = w - 2 * FORM_PAD;
    max_text(s, tx, y + MAX_Y(36), tw, &ph_sb_26, on ? NAVY_INK : NAVY_MUTED, arrow);
    const int rows = (h - MAX_Y(64)) / ph_rg_24.height;
    max_paragraph(s, tx, y + MAX_Y(58), tw, &ph_rg_24, NAVY_MUTED, t, rows);
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
    const int x = MAX_ROOM_X, w = MAX_LANE_X + MAX_LANES_W - MAX_ROOM_X, tx = x + FORM_PAD, tw = w - 2 * FORM_PAD;
    max_box(s, x, MAX_CARD_Y, w, MAX_CARD_H, FORM_R, LINE_W, NAVY_EDGE, NAVY);
    max_m.form_revision = p->revision;
    // A recording: a spoken name for the field (Say starts it, talk_id ""), or one for an agent the form now covers.
    // Cancel and Send stay at hand; nothing else acts until it ends, so the rest shows it cannot be pressed.
    const bool talking = max_m.talk != MAX_TALK_IDLE;
    const bool live = p->active && !f->failed;                          // a page the finger can work
    const bool idle = live && !f->pending && !p->busy && !talking;      // and nothing in flight

    // The title, where in the form, and Close.
    const int head_y = FORM_HEAD_Y, head_cy = head_y + MAX_BUTTON_H / 2;
    max_button(s, FORM_CLOSE_X, head_y, FORM_CLOSE_W, MAX_BUTTON_H, talking ? STYLE_NAVY_OFF : STYLE_NAVY, "Close");
    if (!talking) max_hit(FORM_CLOSE_X, head_y, FORM_CLOSE_W, MAX_BUTTON_H, MAX_HIT_FORM_CLOSE, 0);
    const int title_w = max_text(s, tx, head_cy, tw - FORM_CLOSE_W - 240, &ph_sb_26, NAVY_INK, p->title[0] ? p->title : "New Harness");
    char where[24] = "";
    if (p->total) snprintf(where, sizeof where, "%d / %d", (int)p->position, (int)p->total);
    max_text(s, tx + title_w + 24, head_cy, tw - FORM_CLOSE_W - title_w - 48, LABEL, NAVY_MUTED, p->query[0] ? p->query : where);

    // The choices: the one before, the focused one, the one after.
    const int foot_y = MAX_CARD_Y + MAX_CARD_H - MAX_Y(16) - MAX_BUTTON_H;
    const int top = FORM_CHOICES_Y, h = foot_y - MAX_Y(16) - top;
    const bool moves = live && !p->busy && !talking;
    side(s, tx, top, SIDE_W, h, "\xe2\x86\x90", p->previous, moves, -1);
    side(s, tx + tw - SIDE_W, top, SIDE_W, h, "\xe2\x86\x92", p->next, moves, 1);
    const int fx = tx + SIDE_W + 16, fw = tw - 2 * (SIDE_W + 16);
    max_box(s, fx, top, fw, h, BUTTON_R, LINE_W, live ? NAVY_FOCUS : NAVY_EDGE, NAVY_RAISED);
    const char *label = p->label[0] ? p->label : f->failed ? "Could not open" : "Opening\xe2\x80\xa6";
    const int label_cy = top + MAX_Y(40);
    max_text(s, fx + FORM_PAD, label_cy, fw - 2 * FORM_PAD, &ph_sb_34, p->label[0] ? NAVY_INK : NAVY_MUTED, label);
    const int detail_y = label_cy + ph_sb_34.height / 2 + 4;
    detail(s, fx + FORM_PAD, detail_y, fw - 2 * FORM_PAD, (top + h - MAX_Y(12) - detail_y) / ph_rg_24.height, NAVY_MUTED,
           p->detail);
    if (idle && p->enabled) max_hit(fx, top, fw, h, MAX_HIT_FORM_PICK, 0);

    // Back, what is happening, Say and the action; while a name is spoken, Cancel and Send.
    if (!f->failed) {
        max_button(s, tx, foot_y, BACK_W, MAX_BUTTON_H, idle ? STYLE_NAVY : STYLE_NAVY_OFF, "Back");
        if (idle) max_hit(tx, foot_y, BACK_W, MAX_BUTTON_H, MAX_HIT_FORM_BACK, 0);
    }
    const int action_x = tx + tw - ACTION_W, say_x = action_x - 24 - SAY_W, foot_cy = foot_y + MAX_BUTTON_H / 2;
    const bool say = !talking && max_form_can_say();
    const int mid_x = f->failed ? tx : tx + BACK_W + 24, mid_w = (say || talking ? say_x : action_x) - 24 - mid_x;
    if (talking) max_text(s, mid_x, foot_cy, mid_w, LABEL, YOU, max_m.talk == MAX_TALK_RECORDING ? "Listening" : "Sending\xe2\x80\xa6");
    else if (p->error[0]) max_text(s, mid_x, foot_cy, mid_w, LABEL, FAIL_INK, p->error);
    else if (p->status[0]) max_text(s, mid_x, foot_cy, mid_w, LABEL, NAVY_MUTED, p->status);
    if (talking) {
        if (max_m.talk != MAX_TALK_RECORDING) return;
        max_button(s, say_x, foot_y, SAY_W, MAX_BUTTON_H, STYLE_NAVY, "Cancel");
        max_hit(say_x, foot_y, SAY_W, MAX_BUTTON_H, MAX_HIT_TALK_CANCEL, 0);
        max_button(s, action_x, foot_y, ACTION_W, MAX_BUTTON_H, STYLE_PRIMARY, "Send");
        max_hit(action_x, foot_y, ACTION_W, MAX_BUTTON_H, MAX_HIT_TALK_SEND, 0);
        return;
    }
    if (say) {
        max_button(s, say_x, foot_y, SAY_W, MAX_BUTTON_H, STYLE_NAVY, "Say");
        max_hit(say_x, foot_y, SAY_W, MAX_BUTTON_H, MAX_HIT_FORM_SAY, 0);
    }
    char action[32];
    snprintf(action, sizeof action, "%s", f->failed ? "Retry" : p->busy ? "Wait" : p->action[0] ? p->action : "Choose");
    if (action[0] >= 'a' && action[0] <= 'z') action[0] = (char)(action[0] - 'a' + 'A');   // "check status": "Check status"
    const bool act = f->failed || (idle && p->enabled);
    max_button(s, action_x, foot_y, ACTION_W, MAX_BUTTON_H, act ? STYLE_PRIMARY : STYLE_NAVY_OFF, action);
    if (act) max_hit(action_x, foot_y, ACTION_W, MAX_BUTTON_H, f->failed ? MAX_HIT_FORM_RETRY : MAX_HIT_FORM_PICK, 0);
}
