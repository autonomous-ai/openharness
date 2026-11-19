// App Detail and Ambient (max_ui_draw.h). App Detail (the owner's call, 18 Nov): the app column (the shown app's icon
// and name, the grid glyph to Apps, how many agents, and a dot an agent while the row scrolls), the row of agents by
// need three cells to the glass, and the bell column (the round bell, the yellow badge of unread notices). A cell: a
// status rail, a faint glow of its chip's colour from the top, its pet holding one frame, its name, the line of its
// task and its state chip; the rail, the glow and the chip loop as V3's do. The row's ends fade to black while more of
// it lies that way. An agent open (the agent page) lies across the row, the agents beside it dimmed and blurred
// slivers: its pet smaller and lower, its words gone. The row moves as V3's (max_ui_row.c): an agent opening widens
// over its neighbours as they narrow, its face fading and its panel coming in, and the row follows the finger. An
// agent between looks is drawn on the glass as a cell is, dimmed by its colours and cut to its window (max_ui_layer.c).
// Ambient: the clock large, the date, a few still stars, the agents' pets relaxing, and what the bar has to say ("All
// quiet").
#include <stdio.h>
#include <string.h>

#include "max_ui_draw.h"
#include "pod/pod_mem.h"   // EXT_RAM_BSS_ATTR: a cross-fade's runs, past the render task's frame

enum {
    APP_PAD = DX(26), APP_ICON = DY(60), GRID = DY(20), CELL_PAD = DX(22), TASK_W = DX(330),
    PET_FOOT = DY(136), PET_HALF = DX(75), PET_H = DY(108), NAME_CY = DY(164), TASK_Y = DY(186), CHIP_CY = DY(285),
    SLIVER_FOOT = DY(188), SLIVER_HALF = DX(45), SLIVER_PET_H = DY(65),   // the cell's pet at .6, 52 px lower
    SLIVER_DX = (SLIVER_W - CELL_W) / 2,                                  // the face in a sliver's middle
    GLOW_H = DY(138), BADGE = DY(24), DOT = DX(9), DOT_GAP = DX(7),
    FADE_W = DX(64), FADE_H = HT_HEIGHT - RAIL_H,   // the row's faded ends, under the rails
};

static int imin(int a, int b) { return a < b ? a : b; }
static int imax(int a, int b) { return a > b ? a : b; }

// A column's top rail and the line along its right edge.
static void rail(ht_scene_t *s, int x, int w, int h, unsigned rgb) { ht_pro_rect(s, x, 0, w, h, 0, C(rgb)); }
static void right_line(ht_scene_t *s, int x, int w) { ht_pro_rect(s, x + w - 1, 0, 1, HT_HEIGHT, 0, C(LINE)); }

// One dot an agent of the row in its chip's colour, lit while at least half of it is on the glass (easing as V3's
// dots): only while the row scrolls.
static void row_dots(ht_scene_t *s, int x, int cy, const max_place_t *row, int n, uint32_t now_ms)
{
    for (int i = 0; i < n && x + DOT <= APP_W - DX(10); i++, x += DOT + DOT_GAP) {
        const unsigned c = max_chip_ink(row[i].a);
        const int lit = row[i].look ? max_tween_at(&row[i].look->dot, now_ms) : MAX_ONE;
        max_dot(s, x, cy, DOT, lit >= MAX_ONE ? c : max_mix(c, GROUND, 28 + 72 * (unsigned)lit / MAX_ONE));
    }
}

// The shown app, its icon over its name, the grid glyph after the name while Apps can open, how many agents it has,
// and the row's dots. With no `apps` frame the computer's name stands alone. The block is centred down the column.
static void app_column(ht_scene_t *s, const max_place_t *row, int n, uint32_t now_ms)
{
    rail(s, 0, APP_W, RAIL_H, SIDE_RAIL);
    right_line(s, 0, APP_W);
    const max_app_t *app = max_shown_app();
    const bool apps = max_m.apps_known, dots = n > MAX_CELLS;
    // Its parts in design px: the icon and its gap, the name, the count, the dots.
    const int block = (app ? 74 : 0) + 29 + (n ? 25 : 0) + (dots ? 22 : 0), top = 160 - block / 2;
    const int name_cy = DY(top + (app ? 74 : 0) + 14), count_cy = DY(top + (app ? 74 : 0) + 29 + 6 + 9);
    if (app) max_app_icon(s, APP_PAD, DY(top), APP_ICON, app->id, app->name);
    const int room = APP_W - 2 * APP_PAD + DX(10) - (apps ? GRID + DX(8) : 0);
    // A name too long for the large face (the computer's own, as "MacBook Pro") steps down before it is cut.
    const char *label = max_app_label();
    const ht_pro_font_t *f = ht_pro_width(&ph_sb_32, label) <= room ? &ph_sb_32 : &ph_sb_26;
    const int w = max_text(s, APP_PAD, name_cy, room, f, FG, label);
    if (apps) max_icon_grid(s, APP_PAD + w + DX(8), name_cy - GRID / 2, GRID, DIM);
    if (n) {
        char count[24];
        snprintf(count, sizeof count, n == 1 ? "1 agent" : "%d agents", n);
        max_text(s, APP_PAD, count_cy, APP_W - 2 * APP_PAD, &ph_rg_24, REST, count);
    }
    if (dots) row_dots(s, APP_PAD, DY(top + block - 5), row, n, now_ms);
}

// The bell in its round, and the count of unread notices on a yellow badge over its top right.
static void bell_column(ht_scene_t *s)
{
    const int x = HT_WIDTH - BELL_W, cx = x + BELL_W / 2, cy = HT_HEIGHT / 2, unread = max_unread();
    rail(s, x, BELL_W, RAIL_H, SIDE_RAIL);
    max_round(s, cx, cy, ROUND_D);
    const int icon = ROUND_D * 28 / 64;
    max_icon_bell(s, cx - icon / 2, cy - icon / 2, icon, FG);
    if (unread) {
        char n[8];
        snprintf(n, sizeof n, "%d", unread > 99 ? 99 : unread);
        const int tw = ht_pro_width(&ph_sb_22, n), w = tw + DX(12) > BADGE ? tw + DX(12) : BADGE;
        const int right = cx + ROUND_D / 2 + 3, top = cy - ROUND_D / 2 - 3;
        ht_pro_rect_aa(s, right - w, top, w, BADGE, BADGE / 2, C(WAIT));
        max_text_centered(s, right - w / 2, top + BADGE / 2, w, &ph_sb_22, 0x000000, n);
    }
    max_hit(x, 0, BELL_W, HT_HEIGHT, MAX_HIT_BELL, 0);
}

// The glow's colour at height y: pct % of ink at the top, nothing gh px down, over `under`.
static unsigned glow_at(unsigned ink, unsigned pct, unsigned under, int gh, int y)
{
    return y < gh ? max_mix(ink, under, pct * (unsigned)(gh - y) / (unsigned)gh) : under;
}
// a over b, `t` of MAX_ONE of the way to a.
static unsigned mix_q(unsigned a, unsigned b, int t) { return max_mix(a, b, (unsigned)(t * 100 / MAX_ONE)); }

// A cell's ground: the glow of its chip's colour from the top, its rail, its right line; `still` holding them as at
// the loops' start.
static void cell_ground(ht_scene_t *s, int x, int w, const max_agent_t *a, uint32_t now_ms, bool still)
{
    const unsigned pct = max_glow_pct(a), top = pct ? max_glow_top(a, GROUND, now_ms, still) : GROUND;
    if (pct) pod_grad_aa_dither(s, x, 0, w, GLOW_H, 0, C(top), C(GROUND));
    max_rail(s, x, w, a, top, now_ms, still);
    right_line(s, x, w);
}

// Up to `rows` rows of t, word-wrapped to w, each centred on cx, from y down.
static void centred_rows(ht_scene_t *s, int cx, int y, int w, int rows, unsigned rgb, const char *t)
{
    const ht_pro_font_t *f = &ph_rg_24;
    char lines[2][ROW_BYTES];
    const int n = max_wrap(lines, rows < 2 ? rows : 2, t, f, w);
    for (int i = 0; i < n; i++) max_text_centered(s, cx, y + i * f->height + f->height / 2, w, f, rgb, lines[i]);
}

// What lies under a cell's face: its ground and its glow (gh px of pct % of ink from the top).
typedef struct { unsigned ink, pct, under; int gh; } under_t;

// A cell's face, a cell wide from fx (V3 _Face): its pet holding one frame, `sl` of the way to a sliver's (.6 the size,
// 52 px lower), its name, the line of its task and its chip as at now_ms; the pet `pet` (by its alpha) and the words
// `words` (by their colours) of MAX_ONE there over what lies under them, all dimmed as C() dims (max_dim).
static void face(ht_scene_t *s, int fx, const max_agent_t *a, int sl, int pet, int words, const under_t *u,
                 uint32_t now_ms)
{
    const int cx = fx + CELL_W / 2, inner = CELL_W - 2 * CELL_PAD;
    const int half = PET_HALF - (PET_HALF - SLIVER_HALF) * sl / MAX_ONE;
    const int h = PET_H - (PET_H - SLIVER_PET_H) * sl / MAX_ONE;
    const int foot = PET_FOOT + (SLIVER_FOOT - PET_FOOT) * sl / MAX_ONE;
    const int from = s->count, dim = max_dim_now();
    // Its ground as a cell's at rest, also while the panel's darkens it (by 6 levels at most): a frame below 1x is
    // resampled once a ground, not again every frame of a move.
    const unsigned ground = glow_at(u->ink, u->pct, GROUND, GLOW_H, foot - h / 2);
    max_dim(0);   // its image dims it by the pixel
    max_pet(s, a->engine, max_pet_scene(a, false), cx, foot, half, h, ground, 0, true);
    max_dim(dim);
    max_layer_pet(s, from, ground, dim, (unsigned)pet * 256 / MAX_ONE);
    const unsigned keep = (unsigned)words * 256 / MAX_ONE;
    if (!keep) return;
    max_tint(u->under, keep);
    max_text_centered(s, cx, NAME_CY, inner, &ph_sb_34, FG, a->name);
    const char *task = max_summary(a);
    centred_rows(s, cx, TASK_Y, inner < TASK_W ? inner : TASK_W, 2, task[0] ? DIM : FAINT,
                 task[0] ? task : "No task yet");
    const int chip = max_chip_w(a, false, inner);
    max_chip(s, cx - chip / 2, CHIP_CY, a, false, inner, now_ms);
    max_tint(0, 256);
}

// One agent's cell while none is open: its pet holding one frame, its name, the line of its task, its chip.
static void cell(ht_scene_t *s, int x, const max_agent_t *a, uint32_t now_ms)
{
    cell_ground(s, x, CELL_W, a, now_ms, false);
    const under_t u = {max_chip_ink(a), max_glow_pct(a), GROUND, GLOW_H};
    face(s, x, a, 0, MAX_ONE, MAX_ONE, &u, now_ms);
}

// A sliver at rest beside the open agent, before its dimming: its ground, its face in its middle, the pet smaller and
// lower, the words gone. Kept as a layer while it paints the same, so its rail and glow hold still.
static void sliver(ht_scene_t *s, int x, const void *arg)
{
    const max_agent_t *a = arg;
    cell_ground(s, x, SLIVER_W, a, 0, true);
    const under_t u = {max_chip_ink(a), max_glow_pct(a), GROUND, GLOW_H};
    face(s, x + SLIVER_DX, a, MAX_ONE, MAX_ONE, 0, &u, 0);
}

// An agent of the row between looks: its parts at now (MAX_ONE whole).
typedef struct {
    const max_agent_t *a;
    int w, sl, words, face, dim, ground, panel;
    bool opening;   // its panel is on its way in
    bool cover;     // something drawn before spills over it: its ground first
    bool still;     // its rail and glow hold still: it is cut to its window and blurred as a layer would be
    uint32_t now;
} item_t;

// A run that hides what lies under it, the cross-fade's box: a band, a chip's pill, a round button; not a dot or a bar.
static bool box_run(const ht_run_t *r)
{
    const int k = r->pro_kind, least = DY(24);   // PRO_RECT 2, PRO_RECT_AA 4, PRO_RECT_AA_STROKE 5
    return (k == 2 || k == 4 || k == 5) && r->w >= least && r->pro_height >= least;
}
// The runs [from, mid) going and [mid, count) coming, as V3's cross-fade needs them when both fade by their colours
// toward the ground under them: both one's boxes first, the going one's under the coming one's, then both one's words
// and pets the same way. So neither one's box covers the other's words or pet (V3 stacks the two by their opacity),
// and the one coming is on top.
static void cross(ht_scene_t *s, int from, int mid)
{
    static EXT_RAM_BSS_ATTR ht_run_t runs[HT_RUNS];
    int n = 0;
    for (int pass = 0; pass < 4; pass++)
        for (int i = pass & 1 ? mid : from, end = pass & 1 ? s->count : mid; i < end; i++)
            if (box_run(&s->runs[i]) == (pass < 2)) runs[n++] = s->runs[i];
    memcpy(&s->runs[from], runs, (size_t)n * sizeof runs[0]);
}

// The whole cell as V3 stacks it: its ground going to the panel's, the glow, the rail and the line, the face (moved
// to a sliver's middle, its pet and words fading), and the open agent's panel at its opacity, crossing the face.
static void paint_item(ht_scene_t *s, int x, const void *arg)
{
    const item_t *it = arg;
    const max_agent_t *a = it->a;
    const unsigned g = mix_q(PANEL, GROUND, it->ground);
    const under_t u = {max_chip_ink(a), max_glow_pct(a), mix_q(PANEL, g, it->panel),
                       GLOW_H + (PANEL_GLOW_H - GLOW_H) * it->panel / MAX_ONE};
    if (it->cover || u.under != GROUND) ht_pro_rect(s, x, 0, it->w, HT_HEIGHT, 0, C(u.under));
    const unsigned top = u.pct ? max_glow_top(a, u.under, it->now, it->still) : u.under;
    if (u.pct) pod_grad_aa_dither(s, x, 0, it->w, u.gh, 0, C(top), C(u.under));
    max_rail(s, x, it->w, a, top, it->now, it->still);
    right_line(s, x, it->w);
    const int seen = it->face * (MAX_ONE - it->panel) / MAX_ONE, from = s->count;
    const unsigned keep = (unsigned)it->panel * 256 / MAX_ONE;
    for (int pass = 0, mid = from; pass < 2; pass++) {   // the one going first
        if ((pass == 0) == it->opening) {
            if (seen)
                face(s, x + SLIVER_DX * it->sl / MAX_ONE, a, it->sl, seen, it->words * seen / MAX_ONE, &u, it->now);
        } else if (it->panel) {
            max_agent_body(s, a, x, OPEN_W, keep, u.under, u.gh, it->now);
        }
        if (pass == 0) mid = s->count;
        else if (mid > from && s->count > mid) cross(s, from, mid);
    }
}

// A cell or a sliver the finger can open, as on the glass.
static void cell_hit(int x, int w, const max_agent_t *a)
{
    const int i = max_m.cell_hits;
    if (i >= MAX_ROW_HITS) return;
    max_m.cell_box[i] = (max_box_t){(int16_t)x, 0, (int16_t)w, (int16_t)HT_HEIGHT};
    max_copy(max_m.cell_id[i], sizeof max_m.cell_id[i], a->id);
    max_m.cell_hits = i + 1;
}
// The hits recorded from h on cut to the glass's [l, r); none when they are not the open agent's (V3's panel takes
// no finger while it fades out).
static void cut_hits(int h, int l, int r, bool keep)
{
    int k = h;
    for (int i = h; keep && i < max_m.hit_count; i++) {
        max_hit_t t = max_m.hits[i];
        const int x0 = imax(t.x, l), x1 = imin(t.x + t.w, r);
        if (x1 <= x0) continue;
        t.x = (int16_t)x0;
        t.w = (int16_t)(x1 - x0);
        max_m.hits[k++] = t;
    }
    max_m.hit_count = k;
}

typedef enum { AS_CELL, AS_SLIVER, AS_OPEN, AS_ON_GLASS, AS_MOVING } kind_t;
static kind_t kind_of(const item_t *it)
{
    if (!it->sl && !it->dim && it->words == MAX_ONE && it->face == MAX_ONE && !it->ground && !it->panel &&
        it->w == CELL_W)
        return AS_CELL;
    if (it->sl == MAX_ONE && it->dim == MAX_ONE && !it->words && it->face == MAX_ONE && !it->ground && !it->panel &&
        it->w == SLIVER_W)
        return AS_SLIVER;
    if (!it->sl && !it->dim && !it->face && it->ground == MAX_ONE && it->panel == MAX_ONE && it->w == OPEN_W)
        return AS_OPEN;
    // Not dimmed, at least a cell wide and its face at its left: as it is. Else cut to its window and dimmed.
    return !it->dim && !it->sl && it->w >= CELL_W ? AS_ON_GLASS : AS_MOVING;
}
// Its pet's size and dim (its image's key) by the motion's frames (max_tween_frame), the rest by the clock.
static item_t item_of(const max_place_t *p, uint32_t now_ms)
{
    const max_look_t *l = p->look;
    return (item_t){p->a, p->w, max_tween_frame(&l->sl, now_ms), max_tween_at(&l->words, now_ms),
                    max_tween_at(&l->face, now_ms), max_tween_frame(&l->dim, now_ms), max_tween_at(&l->ground, now_ms),
                    max_tween_at(&l->panel, now_ms), l->panel.to == MAX_ONE, false, false, now_ms};
}
// How far right of x what is drawn on the glass for it reaches: the open agent's panel is laid out at its full width.
static int reach(const item_t *it, kind_t k)
{
    return k == AS_CELL ? CELL_W : imax(it->w, it->panel ? OPEN_W : CELL_W);
}

// The row's faded ends (V3 _Fade): black from .9 at the row's end to clear FADE_W in, from under the rails down, each
// by its own opacity (max_row_step eases them).
static void fades(ht_scene_t *s, uint32_t now_ms)
{
    static EXT_RAM_BSS_ATTR uint16_t black[FADE_W * FADE_H];   // nothing but black
    static EXT_RAM_BSS_ATTR uint8_t alpha[2][FADE_W * FADE_H];
    static bool made;
    if (!made) {   // .9 of 255 at the pixel's middle, i + .5 of FADE_W from the end
        for (int i = 0; i < FADE_W; i++) {
            const uint8_t a = (uint8_t)((459 * (2 * FADE_W - 2 * i - 1) + 2 * FADE_W) / (4 * FADE_W));
            for (int y = 0; y < FADE_H; y++) alpha[0][y * FADE_W + i] = alpha[1][y * FADE_W + FADE_W - 1 - i] = a;
        }
        made = true;
    }
    const int32_t on[2] = {max_tween_at(&max_m.row.fade_l, now_ms), max_tween_at(&max_m.row.fade_r, now_ms)};
    for (int k = 0; k < 2; k++) {
        const unsigned opacity = (unsigned)on[k] * 255 / MAX_ONE;
        const ht_pro_bitmap_t b = {black, alpha[k], FADE_W, FADE_H, 1, NULL};
        const int x = k ? ROW_X + ROW_W - FADE_W : ROW_X;
        if (opacity >= 255) ht_pro_image(s, x, RAIL_H, &b);
        else if (opacity) ht_pro_image_faded(s, x, RAIL_H, &b, opacity);
    }
}

void max_draw_overview(ht_scene_t *s, uint32_t now_ms)
{
    max_row_step(now_ms);
    static max_place_t row[MAX_AGENTS];   // the render task's 4 KB frame holds less
    const int n = max_row_layout(now_ms, row, NULL);
    max_m.row.drawn = true;
    // What is drawn on the glass itself and reaches past the row's ends: the columns are drawn after the row then,
    // each over its own ground.
    bool spill_l = false, spill_r = false;
    for (int i = 0; i < n; i++) {
        const item_t it = item_of(&row[i], now_ms);
        const kind_t k = kind_of(&it);
        if (k == AS_SLIVER || k == AS_MOVING || row[i].x + row[i].w <= ROW_X || row[i].x >= ROW_X + ROW_W) continue;
        spill_l |= row[i].x < ROW_X;
        spill_r |= row[i].x + reach(&it, k) > ROW_X + ROW_W;
    }
    if (max_m.apps_known) max_hit(0, 0, APP_W, HT_HEIGHT, MAX_HIT_APPS, 0);   // the first hit, wherever it is drawn
    if (!spill_l) app_column(s, row, n, now_ms);
    if (!n) {
        max_text_centered(s, ROW_X + ROW_W / 2, HT_HEIGHT / 2, ROW_W - 40, &ph_rg_36, REST,
                          max_m.link ? "No agents yet" : "Not connected");
        bell_column(s);
        return;
    }
    max_layer_frame();
    int drawn = ROW_X;   // how far right what was drawn on the glass reaches
    for (int i = 0; i < n; i++) {
        const max_place_t *p = &row[i];
        const int l = imax(p->x, ROW_X), r = imin(p->x + p->w, ROW_X + ROW_W);
        if (l >= r) continue;
        item_t it = item_of(p, now_ms);
        const kind_t k = kind_of(&it);
        const bool open = !strcmp(p->a->id, max_m.row.open);
        const int h = max_m.hit_count;
        if (open) {
            max_m.row.open_l = (int16_t)l;
            max_m.row.open_r = (int16_t)r;
        } else {
            cell_hit(l, r - l, p->a);
        }
        it.cover = p->x < drawn;
        if (it.cover && (k == AS_CELL || k == AS_OPEN)) ht_pro_rect(s, l, 0, r - l, HT_HEIGHT, 0, C(GROUND));
        if (k == AS_CELL) cell(s, p->x, p->a, now_ms);
        else if (k == AS_SLIVER) max_layer_kept(s, p->x, l, r, sliver, p->a);
        else if (k == AS_OPEN) max_draw_agent(s, p->a, p->x, OPEN_W, now_ms);
        else if (k == AS_ON_GLASS) paint_item(s, p->x, &it);
        else {
            const int from = s->count;
            it.still = true;
            max_dim(it.dim);
            paint_item(s, p->x, &it);
            max_dim(0);
            max_layer_cut(s, from, p->x, p->w, l, r, it.dim);
        }
        if (k != AS_SLIVER && k != AS_MOVING) drawn = imax(drawn, p->x + reach(&it, k));
        cut_hits(h, l, r, open);
    }
    fades(s, now_ms);
    if (spill_l) {
        ht_pro_rect(s, 0, 0, APP_W, HT_HEIGHT, 0, C(GROUND));
        app_column(s, row, n, now_ms);
    }
    if (spill_r) ht_pro_rect(s, ROW_X + ROW_W, 0, BELL_W, HT_HEIGHT, 0, C(GROUND));
    bell_column(s);
    if (max_row_moving(now_ms)) {
        max_motion(now_ms, MAX_ROW_FRAME_MS);
        max_m.row.moves++;
    }
}

// ---- Ambient ----

enum {
    CLOCK_X = DX(64), CLOCK_CY = DY(142), DATE_CY = DY(239), WORDS_R = HT_WIDTH - DX(56), WORDS_CY = DY(143),
    PETS_L = DX(560), PETS_R = DX(1110), PETS_FOOT = DY(298), AMBIENT_PET_H = PETS_FOOT - DY(24), AMBIENT_HALF = DX(133),
    AMBIENT_PETS = 3, STARS = 120,
};

static int isqrt(int v)
{
    int r = v, next = (v + 1) / 2;
    while (next < r) {
        r = next;
        next = (r + v / r) / 2;
    }
    return r;
}

// A still sky as the mockup's: STARS streaks in its three tints, each pointing out from the glass's middle and longer
// toward its edges, at places a fixed sequence picks, none over the pets.
static void stars(ht_scene_t *s)
{
    static const unsigned TINTS[] = {ACCENT, CLAUDE, CODEX};
    const int mx = HT_WIDTH / 2, my = HT_HEIGHT / 2;
    uint32_t r = 0x2545F491u;
    for (int i = 0; i < STARS; i++) {
        r = r * 1664525u + 1013904223u;
        const int x = 4 + (int)(r >> 8) % (HT_WIDTH - 8), y = 4 + (int)(r >> 20) % (HT_HEIGHT - 8);
        if (x > PETS_L - 40 && x < PETS_R + 40 && y > PETS_FOOT - DY(200)) continue;
        const int dx = x - mx, dy = y - my, d = isqrt(dx * dx + dy * dy);
        if (!d) continue;
        // The direction out from the middle in sixteenths of a px, so one step of it is a px long.
        const int ux = dx * 16 / d, uy = dy * 16 / d, len = 3 + d * 10 / mx;
        pod_tri(s, x * 16 - ux * len, y * 16 - uy * len, x * 16 - uy, y * 16 + ux, x * 16 + uy, y * 16 - ux,
                C(max_mix(TINTS[i % 3], GROUND, 35 + (r >> 4) % 50)));
    }
}

void max_draw_ambient(ht_scene_t *s)
{
    static const char *const DAYS[] = {"Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"};
    static const char *const MONTHS[] = {"January", "February", "March", "April", "May", "June", "July", "August",
                                         "September", "October", "November", "December"};
    stars(s);
    if (max_m.wall_known) {
        char clock[8], date[40];
        snprintf(clock, sizeof clock, "%02u:%02u", max_m.wall_hour, max_m.wall_min);
        snprintf(date, sizeof date, "%s %u %s", DAYS[max_m.wall_wday], max_m.wall_mday, MONTHS[max_m.wall_mon]);
        max_clock(s, CLOCK_X, CLOCK_CY, &ph_num_230, INK, clock);
        max_text(s, CLOCK_X, DATE_CY, DX(520), &ph_rg_28, REST, date);
    }
    const char *words = !max_m.link ? "Not connected" : !max_m.count ? "No agents yet" : "All quiet";
    max_text_right(s, WORDS_R, WORDS_CY, DX(320), &ph_sb_34, INK, words);
    // The first agents of the ring, relaxing, holding one frame.
    const int n = max_m.link && max_m.count < AMBIENT_PETS ? max_m.count : max_m.link ? AMBIENT_PETS : 0;
    const int slot = n ? (PETS_R - PETS_L) / n : 0;
    for (int i = 0; i < n; i++)
        max_pet(s, max_m.agents[i].engine, POD_SCENE_RELAX, PETS_L + slot * i + slot / 2, PETS_FOOT, AMBIENT_HALF,
                AMBIENT_PET_H, GROUND, 0, true);
    max_hit(0, 0, HT_WIDTH, HT_HEIGHT, MAX_HIT_WAKE, 0);
}
