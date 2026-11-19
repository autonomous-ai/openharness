// App Detail and Ambient (max_ui_draw.h). App Detail (the owner's call, 18 Nov): the app column (the shown app's icon
// and name, the grid glyph to Apps, how many agents, and a dot an agent while the row scrolls), the row of agents by
// need three cells to the glass, and the bell column (the round bell, the yellow badge of unread notices). A cell: a
// status rail, a faint glow of its chip's colour from the top, its pet holding one frame, its name, the line of its
// task and its state chip. An agent open (the agent page) lies across the row, the agents beside it dimmed slivers: its
// pet smaller and lower, its words gone. Ambient: the clock large, the date, a few still stars, the agents' pets
// relaxing, and what the bar has to say ("All quiet").
#include <stdio.h>
#include <string.h>

#include "max_ui_draw.h"

enum {
    APP_W = DX(196), BELL_W = DX(112), ROW_X = APP_W, ROW_W = HT_WIDTH - APP_W - BELL_W, CELL_W = ROW_W / MAX_CELLS,
    SLIVER_W = DX(136), OPEN_W = ROW_W - 2 * SLIVER_W,
    APP_PAD = DX(26), APP_ICON = DY(60), GRID = DY(20), CELL_PAD = DX(22), TASK_W = DX(330),
    PET_FOOT = DY(136), PET_HALF = DX(75), PET_H = DY(108), NAME_CY = DY(164), TASK_Y = DY(186), CHIP_CY = DY(285),
    SLIVER_FOOT = DY(188), SLIVER_HALF = DX(45), SLIVER_PET_H = DY(65),   // the cell's pet at .6, 52 px lower
    GLOW_H = DY(138), BADGE = DY(24), DOT = DX(9), DOT_GAP = DX(7),
    VEIL_K = 157,   // a sliver keeps 98/255 of its light: brightness .62 at opacity .62 (V3 dimMatrix)
};

// A column's top rail and the line along its right edge.
static void rail(ht_scene_t *s, int x, int w, int h, unsigned rgb) { ht_pro_rect(s, x, 0, w, h, 0, C(rgb)); }
static void right_line(ht_scene_t *s, int x, int w) { ht_pro_rect(s, x + w - 1, 0, 1, HT_HEIGHT, 0, C(LINE)); }

// One dot an agent of the row in its chip's colour, lit while it is on the glass: only while the row scrolls.
static void row_dots(ht_scene_t *s, int x, int cy, const int *row, int n, int first, int shown)
{
    for (int i = 0; i < n && x + DOT <= APP_W - DX(10); i++, x += DOT + DOT_GAP) {
        const unsigned c = max_chip_ink(&max_m.agents[row[i]]);
        max_dot(s, x, cy, DOT, i >= first && i < first + shown ? c : max_mix(c, GROUND, 28));
    }
}

// The shown app, its icon over its name, the grid glyph after the name while Apps can open, how many agents it has,
// and the row's dots. With no `apps` frame the computer's name stands alone. The block is centred down the column.
static void app_column(ht_scene_t *s, const int *row, int n, int first, int shown)
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
    if (dots) row_dots(s, APP_PAD, DY(top + block - 5), row, n, first, shown);
    if (apps) max_hit(0, 0, APP_W, HT_HEIGHT, MAX_HIT_APPS, 0);
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

// The glow's strength: a waiting agent's .18, a failure's .14, any other's .08; none at rest.
static unsigned glow_pct(const max_agent_t *a)
{
    return a->state == MAX_ASKING ? 18 : a->state == MAX_FAILED ? 14 : a->state == MAX_IDLE ? 0 : 8;
}

// A sliver's colours before its veil: saturate(.55), as the Filter Effects spec writes it, in thousandths.
static unsigned desaturate(unsigned rgb)
{
    const unsigned r = rgb >> 16 & 255, g = rgb >> 8 & 255, b = rgb & 255;
    return (646 * r + 322 * g + 32 * b) / 1000 << 16 | (96 * r + 872 * g + 32 * b) / 1000 << 8 |
           (96 * r + 322 * g + 582 * b) / 1000;
}

// A cell's ground: the glow of its chip's colour from the top, its rail, its right line. Returns the glow's colour at
// height y, for the pet's one-colour ground.
static unsigned cell_ground(ht_scene_t *s, int x, int w, const max_agent_t *a, bool sliver, int y)
{
    const unsigned pct = glow_pct(a), ink = sliver ? desaturate(max_chip_ink(a)) : max_chip_ink(a);
    if (pct) pod_grad_aa_dither(s, x, 0, w, GLOW_H, 0, C(max_mix(ink, GROUND, pct)), C(GROUND));
    rail(s, x, w, RAIL_H, sliver ? desaturate(max_rail_ink(a)) : max_rail_ink(a));
    right_line(s, x, w);
    return y < GLOW_H ? max_mix(ink, GROUND, pct * (unsigned)(GLOW_H - y) / GLOW_H) : GROUND;
}

// Up to `rows` rows of t, word-wrapped to w, each centred on cx, from y down.
static void centred_rows(ht_scene_t *s, int cx, int y, int w, int rows, unsigned rgb, const char *t)
{
    const ht_pro_font_t *f = &ph_rg_24;
    char lines[2][ROW_BYTES];
    const int n = max_wrap(lines, rows < 2 ? rows : 2, t, f, w);
    for (int i = 0; i < n; i++) max_text_centered(s, cx, y + i * f->height + f->height / 2, w, f, rgb, lines[i]);
}

// One agent's cell while none is open: its pet holding one frame, its name, the line of its task, its chip.
static void cell(ht_scene_t *s, int x, int w, const max_agent_t *a)
{
    const unsigned ground = cell_ground(s, x, w, a, false, PET_FOOT - PET_H / 2);
    const int cx = x + w / 2, inner = w - 2 * CELL_PAD, half = inner / 2 < PET_HALF ? inner / 2 : PET_HALF;
    max_pet(s, a->engine, max_pet_scene(a, false), cx, PET_FOOT, half, PET_H, ground, 0, true);
    max_text_centered(s, cx, NAME_CY, inner, &ph_sb_34, FG, a->name);
    const char *task = max_summary(a);
    const int task_w = inner < TASK_W ? inner : TASK_W;
    centred_rows(s, cx, TASK_Y, task_w, 2, task[0] ? DIM : FAINT, task[0] ? task : "No task yet");
    const int chip = max_chip_w(a, false, inner);
    max_chip(s, cx - chip / 2, CHIP_CY, a, false, inner);
}

// An agent beside the open one: dimmed (its colours desaturated, then all of it veiled), its pet smaller and lower in
// the sliver's middle, its words gone.
static void sliver(ht_scene_t *s, int x, const max_agent_t *a)
{
    const unsigned ground = cell_ground(s, x, SLIVER_W, a, true, SLIVER_FOOT - SLIVER_PET_H / 2);
    max_pet(s, a->engine, max_pet_scene(a, false), x + SLIVER_W / 2, SLIVER_FOOT, SLIVER_HALF, SLIVER_PET_H, ground, 0,
            true);
    pod_veil(s, x, 0, SLIVER_W, HT_HEIGHT, x + SLIVER_W, true, 0, HT_HEIGHT, C(GROUND), C(GROUND), C(GROUND), VEIL_K);
}

// A cell or a sliver the finger can open, as drawn.
static void cell_hit(int x, int w, const max_agent_t *a)
{
    const int i = max_m.cell_hits;
    if (i >= MAX_CELLS) return;
    max_m.cell_box[i] = (max_box_t){(int16_t)x, 0, (int16_t)w, (int16_t)HT_HEIGHT};
    max_copy(max_m.cell_id[i], sizeof max_m.cell_id[i], a->id);
    max_m.cell_hits = i + 1;
}

void max_draw_overview(ht_scene_t *s, uint32_t now_ms)
{
    int row[MAX_AGENTS];
    const int n = max_m.link ? max_row(row) : 0;
    const max_agent_t *open = max_m.view == MAX_VIEW_AGENT ? max_find(max_m.selected) : NULL;
    int at = -1;   // the open agent's place in the row
    for (int i = 0; open && i < n; i++)
        if (&max_m.agents[row[i]] == open) at = i;
    if (at < 0) open = NULL;
    const int last = n > MAX_CELLS ? n - MAX_CELLS : 0, scrolled = max_m.row_first > last ? last : max_m.row_first;
    const int first = open ? max_open_first(at, n) : scrolled < 0 ? 0 : scrolled;
    const int shown = n - first < MAX_CELLS ? n - first : MAX_CELLS;
    app_column(s, row, n, first, shown);
    if (!n) {
        max_text_centered(s, ROW_X + ROW_W / 2, HT_HEIGHT / 2, ROW_W - 40, &ph_rg_36, REST,
                          max_m.link ? "No agents yet" : "Not connected");
        bell_column(s);
        return;
    }
    int x = ROW_X;
    for (int i = first; i < first + shown; i++) {
        const max_agent_t *a = &max_m.agents[row[i]];
        if (!open) {
            cell(s, x, CELL_W, a);
            cell_hit(x, CELL_W, a);
            x += CELL_W;
        } else if (a == open) {
            max_draw_agent(s, a, x, OPEN_W, now_ms);
            x += OPEN_W;
        } else {
            sliver(s, x, a);
            cell_hit(x, SLIVER_W, a);
            x += SLIVER_W;
        }
    }
    bell_column(s);
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
