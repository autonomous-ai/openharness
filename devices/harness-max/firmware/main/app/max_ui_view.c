// The screen (max_ui.h), 1920 x 480 (or 415) in the Pro's dark Pets look: the room (one agent, large: max_ui_card.c),
// the other agents as lanes on their engine's gradient, and the side column: the pager over New Harness. Over the lanes
// the toast of a question that waits and the notice line. New Harness covers the room and the lanes. While a person
// talks, everything but the room rests: dimmed, and nothing to tap. Inter faces (gen_fonts.py ph_*): at the Max's
// 225 ppi they come out a little larger than on the Pro's 258.
#include <stdio.h>
#include <string.h>

#include "max_ui_draw.h"
#include "max_ui_motion.h"

static const char ELLIPSIS[] = "\xe2\x80\xa6";   // the Inter faces draw it (gen_fonts.py CONSOLE_EXTRA)

// ---- text ----

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
    // Nor an ellipsis already there: a name the model cut ends in one (max_copy_label).
    for (bool more = true; more;) {
        while (n && strchr(" ,;:", t[n - 1])) n--;
        more = n >= sizeof ELLIPSIS - 1 && !memcmp(t + n - (sizeof ELLIPSIS - 1), ELLIPSIS, sizeof ELLIPSIS - 1);
        if (more) n -= sizeof ELLIPSIS - 1;
    }
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
int max_text_right(ht_scene_t *s, int x, int cy, int w, const ht_pro_font_t *f, unsigned rgb, const char *t)
{
    char row[ROW_BYTES];
    if (!t || !t[0] || w <= 0) return 0;
    max_cut(row, t, f, w, false);
    const int tw = ht_pro_width(f, row);
    ht_pro_text(s, x - tw, max_top_of(f, cy), tw, f, C(rgb), row);
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
int max_wrap(char rows[][ROW_BYTES], int max_rows, const char *t, const ht_pro_font_t *f, int w)
{
    if (max_rows > MAX_ROWS) max_rows = MAX_ROWS;
    int n = 0;
    for (; n < max_rows && t; n++) {
        while (*t == ' ') t++;
        if (!*t) break;
        if (n == max_rows - 1) {   // the last row takes the rest
            max_cut(rows[n++], t, f, w, true);
            break;
        }
        const size_t len = max_fit(t, f, w);
        memcpy(rows[n], t, len);
        rows[n][len] = 0;
        t += len;
    }
    return n;
}
int max_paragraph(ht_scene_t *s, int x, int y, int w, const ht_pro_font_t *f, unsigned rgb, const char *t, int max_rows)
{
    char rows[MAX_ROWS][ROW_BYTES];
    const int n = max_wrap(rows, max_rows, t, f, w);
    for (int i = 0; i < n; i++) ht_pro_text(s, x, y + i * f->height, w, f, C(rgb), rows[i]);
    return y + n * f->height;
}

// ---- shapes ----

void max_box(ht_scene_t *s, int x, int y, int w, int h, int r, int line, unsigned edge, unsigned fill)
{
    if (line) {
        ht_pro_rect_aa(s, x, y, w, h, r, C(edge));
        x += line, y += line, w -= 2 * line, h -= 2 * line, r -= line;
    }
    ht_pro_rect_aa(s, x, y, w, h, r, C(fill));
}
unsigned max_mix(unsigned a, unsigned b, unsigned pct)
{
    unsigned out = 0;
    for (int sh = 0; sh <= 16; sh += 8) out |= ((((a >> sh) & 0xff) * pct + ((b >> sh) & 0xff) * (100 - pct)) / 100) << sh;
    return out;
}
void max_hit(int x, int y, int w, int h, max_hit_kind_t kind, int arg)
{
    if (max_m.hit_count >= MAX_HITS) return;
    max_m.hits[max_m.hit_count++] = (max_hit_t){(int16_t)x, (int16_t)y, (int16_t)w, (int16_t)h, (uint8_t)kind, (int8_t)arg};
}

// ---- bubbles: ph_bubble.c's papers, at the prototype's sizes ----

static const struct { unsigned fill, ink; } PAPERS[] = {
    [BUBBLE_SPEECH] = {PAPER, PAPER_INK}, [BUBBLE_BAD] = {BAD, BAD_INK}, [BUBBLE_LETTER] = {LETTER, LETTER_INK},
    [BUBBLE_YOU] = {YOU, YOU_INK}, [BUBBLE_THOUGHT] = {RAISED, INK},
};
int max_bubble_h(const max_bubble_style_t *st, int n) { return 2 * st->pad_y + n * st->f->height; }

// A thought's trail: a circle d across in the thought's fill inside its edge.
static void puff(ht_scene_t *s, int cx, int cy, int d) { max_box(s, cx - d / 2, cy - d / 2, d, d, d / 2, LINE_W, EDGE, RAISED); }
static void tri(ht_scene_t *s, int x0, int y0, int x1, int y1, int x2, int y2, unsigned rgb)
{
    pod_tri(s, x0 * 16, y0 * 16, x1 * 16, y1 * 16, x2 * 16, y2 * 16, C(rgb));
}
void max_bubble(ht_scene_t *s, max_bubble_kind_t kind, const max_bubble_style_t *st, int x, int y, int w,
                char rows[][ROW_BYTES], int n)
{
    const int h = max_bubble_h(st, n), bottom = y + h, cx = x + w / 2;
    const unsigned fill = PAPERS[kind].fill;
    // The tail towards the pet: from the left edge 34 px over the bottom (the room's), or down from the middle (a lane's).
    // A thought trails two puffs instead.
    if (kind == BUBBLE_THOUGHT && st->tail == TAIL_LEFT) puff(s, x - 14, bottom - 38, 24), puff(s, x - 36, bottom - 22, 15);
    else if (kind == BUBBLE_THOUGHT) puff(s, cx, bottom + 18, 24), puff(s, cx + 14, bottom + 38, 15);
    else if (st->tail == TAIL_LEFT) tri(s, x + 1, bottom - 46, x + 1, bottom - 22, x - 15, bottom - 34, fill);
    else tri(s, cx - 14, bottom - 1, cx + 14, bottom - 1, cx, bottom + 16, fill);
    max_box(s, x, y, w, h, st->radius, kind == BUBBLE_THOUGHT ? LINE_W : 0, EDGE, fill);
    for (int i = 0; i < n; i++) {
        const int tw = ht_pro_width(st->f, rows[i]), top = y + st->pad_y + i * st->f->height;
        ht_pro_text(s, st->tail == TAIL_DOWN ? cx - tw / 2 : x + st->pad_x, top, tw, st->f, C(PAPERS[kind].ink), rows[i]);
    }
}

// ---- the state line ----

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
void max_state_line(char *out, size_t cap, const max_agent_t *a, const char *word, uint32_t now_ms)
{
    const bool running = a->state == MAX_WORKING || a->state == MAX_ASKING;
    char clock[24];
    max_fmt_elapsed(clock, sizeof clock, running ? max_secs(a, now_ms) : -1);
    snprintf(out, cap, "%s%s%s%s", word, a->state == MAX_WORKING ? ELLIPSIS : "", clock[0] ? " " : "", clock);
}

// ---- what moves by the clock ----

static bool s_moving;   // something the last render drew moves on by the clock alone
static uint32_t s_due;  // and when it next does
void max_motion(uint32_t now_ms, uint32_t ms)
{
    const uint32_t due = now_ms + ms;
    if (!s_moving || (int32_t)(due - s_due) < 0) s_due = due;
    s_moving = true;
}
uint32_t max_motion_ms(uint32_t now_ms)
{
    if (!s_moving) return MAX_WAKE_MS;
    const int32_t left = (int32_t)(s_due - now_ms);
    return left > 0 ? (uint32_t)left : 0;
}

// ---- the side column: the pager over New Harness ----

enum { SIDE_R = 28, SIDE_GAP = 14, NEW_H = MAX_Y(104), BADGE = 16 };

// The page of lanes shown, "n/m" over the arrow to the next, all of it one tap. Greyed and no tap while there is no
// other page, or New Harness covers the lanes. A peach badge in its corner while an agent on another page asks. No
// lanes, no pager.
static void pager(ht_scene_t *s, int h, bool live)
{
    const int pages = max_pages(), x = MAX_SIDE_X, y = MAX_CARD_Y, w = MAX_SIDE_W, cx = x + w / 2, cy = y + h / 2;
    if (!pages) return;
    const bool turns = pages > 1 && !max_form_open();
    char at[16];
    snprintf(at, sizeof at, "%d/%d", max_m.page + 1, pages);
    max_box(s, x, y, w, h, SIDE_R, LINE_W, EDGE, RAISED);
    max_text_centered(s, cx, cy - 18, w - 16, &ph_sb_26, turns ? INK : MUTED, at);
    max_text_centered(s, cx, cy + 22, w - 16, &ph_sb_26, turns ? INK : MUTED, "\xe2\x86\x92");
    if (max_asks_off_page()) max_dot(s, x + w - 16 - BADGE, y + 16 + BADGE / 2, BADGE, PEACH);
    if (turns && live) max_hit(x, y, w, h, MAX_HIT_PAGE, 0);
}

// New Harness, at the foot of the column: always in reach, whatever the room shows. Outlined in ink while it is up.
static void new_button(ht_scene_t *s, bool live)
{
    const int x = MAX_SIDE_X, y = MAX_CARD_Y + MAX_CARD_H - NEW_H, w = MAX_SIDE_W, cx = x + w / 2;
    const bool open = max_form_open();
    max_box(s, x, y, w, NEW_H, SIDE_R, LINE_W, open ? INK : EDGE, GROUND);
    max_text_centered(s, cx, y + MAX_Y(35), w - 16, &ph_sb_48, INK, "+");
    max_text_centered(s, cx, y + MAX_Y(70), w - 16, &ph_sb_22, INK, "New");
    if (!open && live) max_hit(x, y, w, NEW_H, MAX_HIT_NEW, 0);
}

// New only while the computer is there to offer it; the pager takes the rest of the column.
static void side_column(ht_scene_t *s, bool live)
{
    const bool add = max_m.link && max_m.offers_form;
    pager(s, MAX_CARD_H - (add ? NEW_H + SIDE_GAP : 0), live);
    if (add) new_button(s, live);
}

// ---- a lane: the agent on its engine's gradient, a short bubble, its pet and its state ----

enum {
    LANE_PAD = 14, RING = 4,
    LANE_NAME_CY = MAX_CARD_Y + 36, LANE_META_CY = LANE_NAME_CY + 28, LANE_BUBBLE_Y = LANE_META_CY + 29,
    LANE_STATE_CY = MAX_CARD_Y + MAX_CARD_H - 31, LANE_FOOT = LANE_STATE_CY - 27,
    LANE_ROWS = 3, LANE_PET_MIN = MAX_Y(80), LANE_PET_MAX = MAX_Y(130),
    TAIL_H = 16, PUFFS_H = 46,   // under a speech bubble, under a thought
};
static const max_bubble_style_t LANE_SAY = {&ph_sb_22, 14, 10, 16, TAIL_DOWN};
static const max_bubble_style_t LANE_THINK = {&ph_sb_22, 12, 10, 22, TAIL_DOWN};

// The engine's card colours, as the Pro's ph_engine_tint (PH_TINT_*): the gradient's top and bottom.
static void tint(const char *engine, unsigned *top, unsigned *bottom)
{
    static const struct { const char *engine; unsigned top, bottom; } TINTS[] = {
        {"codex", 0x4F6CF2, 0x1C2A78}, {"claude", 0xE0805A, 0x7A3420}, {"muse", 0xC2A684, 0x56442F},
        {"kilo", 0x8F8A2A, 0x2C2A0C}};
    *top = 0x55555C, *bottom = 0x1D1D21;   // PH_TINT_OTHER
    for (size_t i = 0; i < sizeof TINTS / sizeof TINTS[0]; i++)
        if (!strcmp(engine, TINTS[i].engine)) *top = TINTS[i].top, *bottom = TINTS[i].bottom;
}

static void lane(ht_scene_t *s, int x, int w, const max_agent_t *a, uint32_t now_ms)
{
    unsigned top, bottom;
    tint(a->engine, &top, &bottom);
    const int y = MAX_CARD_Y, h = MAX_CARD_H, cx = x + w / 2, tw = w - 2 * LANE_PAD;
    const bool asks = a->state == MAX_ASKING;
    if (asks) {   // a peach ring: it waits for a person
        ht_pro_rect_aa(s, x, y, w, h, CARD_R, C(PEACH));
        pod_grad_aa_dither(s, x + RING, y + RING, w - 2 * RING, h - 2 * RING, CARD_R - RING, C(top), C(bottom));
    } else {
        pod_grad_aa_dither(s, x, y, w, h, CARD_R, C(top), C(bottom));
    }
    max_text_centered(s, cx, LANE_NAME_CY, tw, &ph_sb_26, LANE_INK, a->name);
    max_text_centered(s, cx, LANE_META_CY, tw, &ph_sb_22, max_mix(LANE_INK, top, 78), a->machine);

    const max_ask_t *k = asks ? max_ask_of(a->id) : NULL;
    char line[MAX_VERB_BYTES + 32];
    const char *word = k && k->permission ? "Permission" : max_state_word(a);
    max_state_line(line, sizeof line, a, word, now_ms);
    // Too wide with its clock (a long spinner word in a narrow lane): the word alone, rather than cut after it.
    if (ht_pro_width(&ph_sb_22, line) > tw)
        snprintf(line, sizeof line, "%s%s", word, a->state == MAX_WORKING ? ELLIPSIS : "");
    const unsigned ink = asks ? PEACH : a->state == MAX_WORKING ? MINT : a->state == MAX_FAILED ? LANE_FAIL
                       : max_mix(LANE_INK, bottom, 80);
    max_text_centered(s, cx, LANE_STATE_CY, tw, &ph_sb_22, ink, line);

    // What it says: the question on paper, what it does in a thought, a failure or a summary; rows while the pet keeps
    // its least height.
    max_bubble_kind_t kind = BUBBLE_SPEECH;
    const char *say = NULL;
    if (asks) say = a->question;
    else if (a->state == MAX_WORKING) kind = BUBBLE_THOUGHT, say = a->activity[0] ? a->activity : max_state_word(a);
    else if (a->state == MAX_FAILED) kind = BUBBLE_BAD, say = a->note[0] ? a->note : "Failed";
    else if (a->state == MAX_DONE && max_note_shown(a, now_ms)) kind = BUBBLE_LETTER, say = a->note;
    const max_bubble_style_t *st = kind == BUBBLE_THOUGHT ? &LANE_THINK : &LANE_SAY;
    const int under = kind == BUBBLE_THOUGHT ? PUFFS_H : TAIL_H;
    const int room = LANE_FOOT - LANE_PET_MIN - 8 - under - LANE_BUBBLE_Y - 2 * st->pad_y;
    int rows = room / st->f->height;
    if (rows > LANE_ROWS) rows = LANE_ROWS;
    char text[LANE_ROWS][ROW_BYTES];
    const int n = say && rows > 0 ? max_wrap(text, rows, say, st->f, tw - 2 * st->pad_x) : 0;
    int pet_top = LANE_BUBBLE_Y;
    if (n) {
        max_bubble(s, kind, st, x + LANE_PAD, LANE_BUBBLE_Y, tw, text, n);
        pet_top += max_bubble_h(st, n) + under + 8;
    }
    int max_h = LANE_FOOT - pet_top;
    if (max_h > LANE_PET_MAX) max_h = LANE_PET_MAX;
    // On the gradient's colour at the pet's middle: the player keeps one frame drawn on one colour.
    const int mid = LANE_FOOT - max_h / 2 - y;
    max_pet(s, a, max_pet_scene(a, false), cx, LANE_FOOT, (w - 2 * LANE_PAD) / 2, max_h,
            max_mix(top, bottom, (unsigned)(100 - mid * 100 / (h - 1))), now_ms, true);
}

// The lanes of the page, sharing its width. `live`: their boxes go to the finger.
static void lanes(ht_scene_t *s, uint32_t now_ms, bool live)
{
    int v[MAX_LANES];
    const int n = max_visible(v);
    if (!n) return;
    // Across pages every lane keeps a full page's width: a lane does not change size as the page turns.
    const int slots = max_pages() > 1 ? MAX_LANES : n, w = (MAX_LANES_W - (slots - 1) * MAX_LANE_GAP) / slots;
    for (int i = 0; i < n; i++) {
        const int x = MAX_LANE_X + i * (w + MAX_LANE_GAP);
        lane(s, x, w, &max_m.agents[v[i]], now_ms);
        if (!live) continue;
        max_m.lane_box[i] = (max_box_t){(int16_t)x, MAX_CARD_Y, (int16_t)w, MAX_CARD_H};
        max_copy(max_m.lane_id[i], sizeof max_m.lane_id[i], max_m.agents[v[i]].id);
        max_m.lane_hits = i + 1;
    }
}

// ---- over the lanes: the toast of a question that waits, and the notice line, on the Pro's toast navy ----

enum { TOAST_W = 680, TOAST_X = MAX_LANE_X + MAX_LANES_W - TOAST_W, TOAST_Y = 12, TOAST_H = 104, TOAST_R = 26,
       TOAST_PAD = 24, TOAST_STEP_MS = 100, BAR_H = 5, NOTICE_H = 60 };

// The toast's place: at the top right over the lanes; while New Harness is up, left of its Close and centred in the
// band above its choices, so it covers none of the form's buttons.
static max_box_t toast_box(bool form)
{
    if (!form) return (max_box_t){TOAST_X, TOAST_Y, TOAST_W, TOAST_H};
    return (max_box_t){FORM_CLOSE_X - 16 - TOAST_W, (FORM_CHOICES_Y - TOAST_H) / 2, TOAST_W, TOAST_H};
}

static void toast(ht_scene_t *s, max_box_t t, uint32_t now_ms)
{
    const max_agent_t *a = max_find(max_m.toast_id);
    max_box(s, t.x, t.y, t.w, t.h, TOAST_R, LINE_W, NAVY_EDGE, NAVY);
    const int tx = t.x + TOAST_PAD, tw = t.w - 2 * TOAST_PAD, name_cy = t.y + 30;
    const int hint = max_text_right(s, tx + tw, name_cy, tw / 3, &ph_sb_22, NAVY_MUTED, "Tap to open");
    char who[CABLE_NAME_MAX + 8];
    snprintf(who, sizeof who, "%s asks", a->name);
    max_text(s, tx, name_cy, tw - hint - 24, &ph_sb_22, NAVY_NAME, who);
    max_text(s, tx, t.y + 64, tw, &ph_sb_26, NAVY_INK, a->question);
    // The bar runs out with the toast, a step every TOAST_STEP_MS.
    const uint32_t age = now_ms - max_m.toast_from, steps = (MAX_TOAST_MS - age + TOAST_STEP_MS - 1) / TOAST_STEP_MS;
    const int bw = (int)((uint32_t)tw * steps * TOAST_STEP_MS / MAX_TOAST_MS);
    if (bw > 0) ht_pro_rect_aa(s, tx, t.y + t.h - 9 - BAR_H, bw, BAR_H, BAR_H / 2, C(NAVY_BAR));
    max_motion(now_ms, TOAST_STEP_MS - age % TOAST_STEP_MS);
}

// The notice ending at `right`, from y down.
static void notice(ht_scene_t *s, int right, int y)
{
    const ht_pro_font_t *f = &ph_sb_26;
    char row[ROW_BYTES];
    max_cut(row, max_m.notice, f, TOAST_W - 2 * TOAST_PAD, false);
    const int tw = ht_pro_width(f, row), w = tw + 2 * TOAST_PAD, x = right - w;
    max_box(s, x, y, w, NOTICE_H, TOAST_R, LINE_W, NAVY_EDGE, NAVY);
    ht_pro_text(s, x + TOAST_PAD, max_top_of(f, y + NOTICE_H / 2), tw, f, C(NAVY_INK), row);
}

// ---- the whole screen ----

static void update_screen(ht_scene_t *s)
{
    const int cx = HT_WIDTH / 2, bar_w = 800;
    char pct[16], version[MAX_VERSION_BYTES + 8];
    snprintf(pct, sizeof pct, "%d%%", max_m.update_pct);
    max_text_centered(s, cx, MAX_Y(140), 600, &ph_sb_34, INK, "Updating");
    max_text_centered(s, cx, MAX_Y(214), 400, &ph_sb_48, INK, pct);
    ht_pro_rect_aa(s, cx - bar_w / 2, MAX_Y(276), bar_w, 14, 7, C(TRACK));
    if (max_m.update_pct > 0)
        ht_pro_rect_aa(s, cx - bar_w / 2, MAX_Y(276), bar_w * max_m.update_pct / 100, 14, 7, C(GREEN));
    if (max_m.update_to[0]) {
        snprintf(version, sizeof version, "Version %s", max_m.update_to);
        max_text_centered(s, cx, MAX_Y(334), 600, &ph_sb_22, MUTED, version);
    }
}

// A veil over what rests while a person talks: 65 % of the way to the ground.
static void dim(ht_scene_t *s, int x, int y, int w, int h)
{
    const uint16_t g = C(GROUND);
    pod_veil(s, x, y, w, h, x, false, y, h, g, g, g, DIM_K);
}

void max_ui_render(ht_scene_t *s, uint32_t now_ms)
{
    s->background = C(GROUND);
    max_m.lane_hits = 0;
    max_m.hit_count = 0;
    max_m.card_id[0] = 0;
    max_m.dirty = false;
    s_moving = false;
    if (max_m.update_pct >= 0) {
        update_screen(s);
    } else {
        // While a person talks the rest of the screen holds still under a veil: nothing there can change who listens.
        const bool live = max_m.talk == MAX_TALK_IDLE, form = max_form_open();
        const bool toasting = max_m.link && max_toast_shown(now_ms);
        const max_box_t t = toast_box(form);
        if (toasting && live) max_hit(t.x, t.y, t.w, t.h, MAX_HIT_TOAST, 0);   // first: never dropped past MAX_HITS
        side_column(s, live);
        if (form) {
            max_draw_form(s);
        } else {
            max_draw_room(s, max_m.link ? max_find(max_m.selected) : NULL, now_ms);
            if (max_m.link) lanes(s, now_ms, live);
        }
        if (toasting) toast(s, t, now_ms);
        if (!live) {   // what rests: everything right of the room; over the form, the side column and the toast
            const int from = form ? MAX_SIDE_X : MAX_LANE_X;
            dim(s, from - 4, 0, HT_WIDTH - from + 4, HT_HEIGHT);
            if (form && toasting) dim(s, t.x, t.y, t.w, t.h);
        }
        if (max_notice_shown(now_ms)) {
            // In the toast's place, or under it; while the form is up, in the band above its choices, left of the toast.
            if (!form) notice(s, t.x + t.w, toasting ? t.y + t.h + 10 : t.y);
            else notice(s, toasting ? t.x - 10 : t.x + t.w, t.y + (t.h - NOTICE_H) / 2);
        }
    }
    max_m.drawn_key = max_time_key(now_ms);
}
