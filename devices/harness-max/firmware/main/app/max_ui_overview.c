// Overview and Ambient (max_ui_draw.h). Overview: the app column (the shown app's icon and name, the grid glyph to
// Apps), up to five agent cells (a status rail, a faint glow of its colour from the top, the pet, the name and the status
// word), the page dots under them, and the bell column (the round bell, the yellow badge of unread notices). Ambient: the
// clock large, the date, a few still stars, the agents' pets relaxing, and what the bar has to say ("All quiet").
#include <stdio.h>
#include <string.h>

#include "max_ui_draw.h"

enum {
    APP_W = DX(196), BELL_W = DX(112), CELLS_X = APP_W, CELLS_W = HT_WIDTH - APP_W - BELL_W,
    APP_PAD = DX(26), APP_ICON = DY(60), GRID = DY(20), CELL_PAD = DX(14),
    PET_FOOT = DY(174), PET_HALF = DX(86), PET_H = DY(112), NAME_CY = DY(206), WORD_CY = DY(241),
    GLOW_H = DY(138), BADGE = DY(24), DOT = DY(8), DOTS_CY = HT_HEIGHT - DY(18),
};

// A column's top rail and the line along its right edge.
static void rail(ht_scene_t *s, int x, int w, int h, unsigned rgb) { ht_pro_rect(s, x, 0, w, h, 0, C(rgb)); }
static void right_line(ht_scene_t *s, int x, int w) { ht_pro_rect(s, x + w - 1, 0, 1, HT_HEIGHT, 0, C(LINE)); }

// The shown app, its icon over its name, the grid glyph after the name while Apps can open. With no `apps` frame the
// computer's name stands alone.
static void app_column(ht_scene_t *s)
{
    rail(s, 0, APP_W, RAIL_H, SIDE_RAIL);
    right_line(s, 0, APP_W);
    const max_app_t *app = max_shown_app();
    const bool apps = max_m.apps_known;
    const int name_cy = app ? HT_HEIGHT / 2 + DY(37) : HT_HEIGHT / 2;
    if (app) max_app_icon(s, APP_PAD, HT_HEIGHT / 2 - DY(52), APP_ICON, app->id, app->name);
    const int room = APP_W - 2 * APP_PAD + DX(10) - (apps ? GRID + DX(8) : 0);
    // A name too long for the large face (the computer's own, as "MacBook Pro") steps down before it is cut.
    const char *label = max_app_label();
    const ht_pro_font_t *f = ht_pro_width(&ph_sb_32, label) <= room ? &ph_sb_32 : &ph_sb_26;
    const int w = max_text(s, APP_PAD, name_cy, room, f, FG, label);
    if (!apps) return;
    max_icon_grid(s, APP_PAD + w + DX(8), name_cy - GRID / 2, GRID, DIM);
    max_hit(0, 0, APP_W, HT_HEIGHT, MAX_HIT_APPS, 0);
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

// One agent: its rail, the glow of its colour from the top (none at rest), its pet holding one frame, its name and its
// status word.
static void cell(ht_scene_t *s, int x, int w, const max_agent_t *a)
{
    const unsigned ink = max_state_ink(a), pct = a->state == MAX_ASKING ? 18 : a->state == MAX_IDLE ? 0 : 8;
    if (pct) pod_grad_aa_dither(s, x, 0, w, GLOW_H, 0, C(max_mix(ink, GROUND, pct)), C(GROUND));
    rail(s, x, w, RAIL_H, max_rail_ink(a));
    right_line(s, x, w);
    const int cx = x + w / 2, half = w / 2 - CELL_PAD < PET_HALF ? w / 2 - CELL_PAD : PET_HALF;
    // The glow's colour at the pet's middle: the player keeps one frame drawn on one colour.
    const int mid = PET_FOOT - PET_H / 2;
    const unsigned ground = mid < GLOW_H ? max_mix(ink, GROUND, pct * (unsigned)(GLOW_H - mid) / GLOW_H) : GROUND;
    max_pet(s, a->engine, max_pet_scene(a, false), cx, PET_FOOT, half, PET_H, ground, 0, true);
    max_text_centered(s, cx, NAME_CY, w - 2 * CELL_PAD, &ph_sb_34, FG, a->name);
    max_text_centered(s, cx, WORD_CY, w - 2 * CELL_PAD, &ph_rg_28, ink, max_status_word(a));
}

// The pages of cells: the page shown wider, a page where an agent waits in yellow.
static void page_dots(ht_scene_t *s, int pages)
{
    const int gap = DX(10), w = (pages + 1) * DOT + (pages - 1) * gap;
    int x = CELLS_X + (CELLS_W - w) / 2;
    for (int p = 0; p < pages; p++) {
        const bool at = p == max_m.cell_page, waits = max_page_waits(p);
        const int dw = at ? 2 * DOT : DOT;
        ht_pro_rect_aa(s, x, DOTS_CY - DOT / 2, dw, DOT, DOT / 2, C(waits ? WAIT : at ? FG : FAINT));
        x += dw + gap;
    }
}

void max_draw_overview(ht_scene_t *s, uint32_t now_ms)
{
    (void)now_ms;   // nothing on Overview moves: its pets hold one frame
    app_column(s);
    bell_column(s);
    int v[MAX_CELLS];
    const int n = max_m.link ? max_cells(v) : 0, pages = max_m.link ? max_cell_pages() : 0;
    if (!n) {
        max_text_centered(s, CELLS_X + CELLS_W / 2, HT_HEIGHT / 2, CELLS_W - 40, &ph_rg_36, REST,
                          max_m.link ? "No agents yet" : "Not connected");
        return;
    }
    // Across pages every cell keeps a full page's width: a cell does not change size as the page turns.
    const int slots = pages > 1 ? MAX_CELLS : n, w = CELLS_W / slots;
    for (int i = 0; i < n; i++) {
        const max_agent_t *a = &max_m.agents[v[i]];
        const int x = CELLS_X + i * w;
        cell(s, x, w, a);
        max_m.cell_box[i] = (max_box_t){(int16_t)x, 0, (int16_t)w, (int16_t)HT_HEIGHT};
        max_copy(max_m.cell_id[i], sizeof max_m.cell_id[i], a->id);
        max_m.cell_hits = i + 1;
    }
    if (pages > 1) page_dots(s, pages);
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
