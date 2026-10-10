// The Tabs screen: an album grid on a light glass, three covers across and two rows down. Every tab is a square cover of its
// own colour with its panes drawn on it as white cards (an engine mark in each, a dot on the working and asking ones); the
// first cover is Recent (its agents' marks in a 4 x 2 grid), an empty tab is grey with a "+". The window's selected tab is
// ringed in blue, its name blue. Under each cover: the name, then "N panes". A cover whose agents are working wears a
// "Working ribbon" at its foot: a dark band with three green bars, "Working" and a white disc with the working count.
// Exactly two rows of covers a page. More than six covers scroll by pages (the frame's scroll is the first row of the page,
// so always even); a small dot column on the right edge counts the pages. While the finger drags, or the page settles after
// the release, the glue gives the pixel offset (f->tabs_off) and the grid is drawn where it is: every row that meets the
// glass, the status bar drawn last over whatever has scrolled under it. At rest only the page's two rows are drawn.
//
// Nothing here depends on the clock but the ribbon's bars, which step through three heights every POD_TABS_BAR_MS: only
// their three rects change, so the glue wakes the screen at that pace while a ribbon shows (pod_tabs_ribbon).
// When the frame is short of runs the dots go first, then the marks, then the cards of a cover, the least visible covers
// first (at rest: the last covers first) and the selected one last. The ribbon stays; only while the grid moves, as the very
// last resort, the ribbons of the least visible covers go.
#include "pod_view.h"
#include "pod_view_shared.h"
#include "../pro_canvas.h"

#include <stdio.h>
#include <string.h>

enum {
    COLS = 3, COVER = 196, COL_PITCH = 228, MARGIN_X = 34, ROW_PITCH = 280, TOP_Y = 104, COVER_R = 16,
    NAME_DY = 10, LINE_DY = 50, CAPTION_W = 226, HIT_H = 84 + COVER - 10,
    RING = 5, RING_GAP = 3, RING_R = 24,
    ROWS_PAGE = 2, PAGE_H = ROWS_PAGE * ROW_PITCH, ROW_H = COVER + LINE_DY + 28,   // a row: cover, name and count line
    SPARE_RUNS = 4,       // runs left for what pod_ui_render adds (the notice)
    STATUS_RUNS = 5,      // the status bar, drawn last: its gradient, the title, and "N working" with its triangle
    SHOWN_MAX = 4 * COLS, // two partial pages: four rows meet the glass
    DOT = 6, DOT_PITCH = 14, DOT_X = 709, DOT_MAX = 12,
    BARE = 4,             // detail bit, local: the cover is its gradient alone (its cards are dropped)
    NORIB = 8,            // detail bit, local: no ribbon (only in motion, short of runs)
    RIB_H = 38, RIB_ROUND = 32, RIB_RUNS = 8,   // band height; its rounded part; band (2), bars (3), Working, disc, count
    RIB_BAR_W = 5, RIB_BAR_PITCH = 8, RIB_DISC = 24,
    GLASS_TOP = POD_STATUS_H
};

// The greys are chosen in RGB565 (red and blue 5 bits, green 6): the green byte sits about 4 above them, else the glass reads pink.
#define FLOOR_TOP 0xf0f4f8
#define FLOOR_BOTTOM 0xe0e4e8
#define INK 0x111111
#define GREY 0x7b7d84
#define GREEN 0x2fa84f
#define AMBER 0xe08a00
#define BLUE 0x1f63d1
#define RING_BLUE 0x0a84ff

static uint16_t C(unsigned rgb) { return ht_rgb(rgb); }
static int imin(int a, int b) { return a < b ? a : b; }
static int imax(int a, int b) { return a > b ? a : b; }

// The cover colours, top to bottom, by tab order; Recent has its own blue.
static const unsigned palette[][2] = {
    {0x6f74d6, 0x2f2a8e},   // indigo
    {0xf08a84, 0xc53b67},   // coral to raspberry
    {0x4cc6a6, 0x1f7f86},   // teal
    {0xf7b04a, 0xe0701f},   // orange
    {0x579ae7, 0x1758ce},   // blue
    {0xb27ae6, 0x6b2fb8},   // violet
    {0x7bd47a, 0x2f9a4a},   // green
    {0x9aa0b0, 0x545a6c},   // slate
};
enum { PALETTE_N = sizeof palette / sizeof palette[0] };
#define RECENT_TOP 0x5ea2f2
#define RECENT_BOTTOM 0x1f63d1

static unsigned mix(unsigned a, unsigned b, int pct)   // a toward b, in percent
{
    unsigned out = 0;
    for (int sh = 16; sh >= 0; sh -= 8) {
        int ca = (int)((a >> sh) & 255), cb = (int)((b >> sh) & 255);
        out |= (unsigned)(ca + (cb - ca) * pct / 100) << sh;
    }
    return out;
}
static unsigned floor_at(int y) { return mix(FLOOR_TOP, FLOOR_BOTTOM, imax(0, y - GLASS_TOP) * 100 / (POD_W - GLASS_TOP)); }

// Cover c: 0 is Recent, i + 1 is tab i.
static unsigned cover_top(int c) { return c > 0 ? palette[(c - 1) % PALETTE_N][0] : RECENT_TOP; }
static unsigned cover_bottom(int c) { return c > 0 ? palette[(c - 1) % PALETTE_N][1] : RECENT_BOTTOM; }
static bool cover_empty(const pod_model_t *m, int c) { return c > 0 && pod_tab_panes(&m->tabs[c - 1]) == 0; }
static int chosen_cover(const pod_model_t *m)   // the window's selected tab, or -1
{
    return m->tab_count && m->selected < m->tab_count ? m->selected + 1 : -1;
}

int pod_tabs_pitch(void) { return PAGE_H; }
int pod_tabs_pages(const pod_model_t *m)
{
    int rows = (1 + m->tab_count + COLS - 1) / COLS;
    return imax(1, (rows + ROWS_PAGE - 1) / ROWS_PAGE);
}
int pod_tabs_max_row(const pod_model_t *m) { return (pod_tabs_pages(m) - 1) * ROWS_PAGE; }

// What a cover says under its name.
typedef struct { char name[CABLE_NAME_MAX + 4], count[24]; int working; } caption_t;   // working: agents at work (the ribbon)
static void caption(const pod_model_t *m, int c, caption_t *cap)
{
    memset(cap, 0, sizeof *cap);
    int w = 0, q = 0;
    if (c == 0) {
        const pod_agent_t *l[POD_RECENT_MAX];
        int n = pod_model_recent(m, l, POD_RECENT_MAX);
        for (int i = 0; i < n; i++) {
            pod_state_t st = pod_model_eff(m, l[i]);
            if (st == POD_WORKING) w++; else if (st == POD_ASKING) q++;
        }
        snprintf(cap->name, sizeof cap->name, "Recent");
        snprintf(cap->count, sizeof cap->count, "%d agent%s", n, n == 1 ? "" : "s");
    } else {
        const pod_tab_t *t = &m->tabs[c - 1];
        int n = pod_tab_panes(t);
        pod_tab_counts(m, t, &w, &q);
        snprintf(cap->name, sizeof cap->name, "%s", t->name);
        if (n == 0) snprintf(cap->count, sizeof cap->count, "Empty");
        else snprintf(cap->count, sizeof cap->count, "%d pane%s", n, n == 1 ? "" : "s");
    }
    cap->working = w;
    (void)q;
}
static unsigned caption_runs(const caption_t *cap) { (void)cap; return 2u; }

// ---- the Working ribbon -----------------------------------------------------------------------------------------
// The band is black at 62% over the cover's gradient at its foot, one flat colour a cover (no alpha on rects): a rounded
// rect for the cover's bottom corners plus a square one above it.
static unsigned ribbon_ground(int c) { return mix(mix(cover_top(c), cover_bottom(c), 90), 0x000000, 62); }
static int ribbon_step(uint32_t now_ms) { return (int)(now_ms / POD_TABS_BAR_MS % 3); }
static void draw_ribbon(ht_scene_t *s, int c, int x, int y, int working, uint32_t now_ms)
{
    static const int bar_h[3] = {8, 14, 20};
    uint16_t band = C(ribbon_ground(c));
    int by = y + COVER - RIB_H, mid = y + COVER - RIB_H / 2;
    ht_pro_rect(s, x, y + COVER - RIB_ROUND, COVER, RIB_ROUND, COVER_R, band);
    ht_pro_rect(s, x, by, COVER, RIB_H - COVER_R, 0, band);
    int step = ribbon_step(now_ms);
    for (int i = 0; i < 3; i++) {
        int h = bar_h[(step + i) % 3];
        ht_pro_rect(s, x + 12 + i * RIB_BAR_PITCH, mid + 11 - h, RIB_BAR_W, h, 2, C(0x34c759));
    }
    int dx = x + COVER - 10 - RIB_DISC;
    ht_pro_text(s, x + 40, mid - ht_pro_24.height / 2, dx - 8 - (x + 40), &ht_pro_24, C(0xffffff), "Working");
    ht_pro_rect(s, dx, mid - RIB_DISC / 2, RIB_DISC, RIB_DISC, RIB_DISC / 2, C(0xffffff));
    char n[8];
    snprintf(n, sizeof n, "%d", working);
    int w = ht_pro_width(&ht_pro_24, n);
    ht_pro_text(s, dx + (RIB_DISC - w) / 2, mid - ht_pro_24.height / 2, RIB_DISC, &ht_pro_24, C(0x178a6c), n);
}
static unsigned ribbon_runs(const caption_t *cap, int detail) { return cap->working > 0 && !(detail & NORIB) ? (unsigned)RIB_RUNS : 0u; }

// Does a ribbon show on the resting page `page`? The glue wakes at POD_TABS_BAR_MS while one does.
bool pod_tabs_ribbon(const pod_model_t *m, int page)
{
    int covers = 1 + m->tab_count;
    for (int c = page * ROWS_PAGE * COLS; c < covers && c < (page + 1) * ROWS_PAGE * COLS; c++) {
        caption_t cap;
        caption(m, c, &cap);
        if (cap.working > 0) return true;
    }
    return false;
}

static void draw_cover(ht_scene_t *s, const pod_model_t *m, int c, int x, int y, int detail)
{
    if (detail & BARE) {   // only while the grid is in motion and short of runs
        pod_grad(s, x, y, COVER, COVER, COVER_R, C(cover_empty(m, c) ? 0xa4a8b3 : cover_top(c)), C(cover_empty(m, c) ? 0x666a78 : cover_bottom(c)));
        return;
    }
    if (cover_empty(m, c)) { pod_cover_empty(s, x, y, COVER, COVER_R); return; }
    if (c == 0) {
        const pod_agent_t *l[POD_RECENT_MAX];
        if (pod_model_recent(m, l, POD_RECENT_MAX) == 0) { pod_recent_face_r(s, x, y, COVER, COVER_R); return; }
        pod_grad(s, x, y, COVER, COVER, COVER_R, C(RECENT_TOP), C(RECENT_BOTTOM));
        pod_cover_recent(s, x, y, COVER, m, detail);
        return;
    }
    pod_grad(s, x, y, COVER, COVER, COVER_R, C(cover_top(c)), C(cover_bottom(c)));
    pod_cover_cards(s, x, y, COVER, m, &m->tabs[c - 1], detail);
}
static unsigned total_cover_runs(const pod_model_t *m, int c, int detail)
{
    if (detail & BARE) return 1;
    if (cover_empty(m, c)) return pod_cover_empty_runs();
    if (c == 0) {
        const pod_agent_t *l[POD_RECENT_MAX];
        if (pod_model_recent(m, l, POD_RECENT_MAX) == 0) return pod_recent_face_runs();
        return 1u + pod_cover_recent_runs(m, COVER, detail);
    }
    return 1u + pod_cover_cards_runs(m, &m->tabs[c - 1], COVER, detail);
}

typedef struct { int c, x, y, vis, detail; caption_t cap; } slot_t;

void pod_view_tabs(pod_out_frame_t *f, const pod_nav_t *nav, const pod_model_t *m, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    const pod_agent_t *wl[POD_AGENTS_MAX];
    int wn = pod_model_working(m, wl, POD_AGENTS_MAX);
    pod_grad(s, 0, GLASS_TOP, POD_W, POD_W - GLASS_TOP, 0, C(FLOOR_TOP), C(FLOOR_BOTTOM));

    int covers = 1 + m->tab_count, sel = chosen_cover(m), pages = pod_tabs_pages(m);
    int rows = (covers + COLS - 1) / COLS;
    int page = nav->depth ? nav->stack[0].scroll / ROWS_PAGE : 0;
    page = imax(0, imin(page, pages - 1));
    int off = page * PAGE_H;
    bool moving = false;
    if (f->tabs_moving && pages > 1) {
        off = imax(-PAGE_H / 2, imin(f->tabs_off, (pages - 1) * PAGE_H + PAGE_H / 2));
        if (off % PAGE_H == 0) page = off / PAGE_H;   // exactly on a page: the resting screen
        else moving = true;
    }

    // The covers that meet the glass: at rest the page's two rows, in motion every row that shows.
    slot_t sl[SHOWN_MAX];
    int n = 0;
    for (int r = moving ? 0 : page * ROWS_PAGE; r < rows && r < (moving ? rows : (page + 1) * ROWS_PAGE); r++) {
        int y = TOP_Y + r * ROW_PITCH - off;
        if (moving && (y + ROW_H <= GLASS_TOP || y - RING - RING_GAP >= POD_W)) continue;
        for (int k = 0; k < COLS && r * COLS + k < covers && n < SHOWN_MAX; k++) {
            slot_t *e = &sl[n++];
            e->c = r * COLS + k;
            e->x = MARGIN_X + k * COL_PITCH;
            e->y = y;
            e->vis = imax(0, imin(y + ROW_H, POD_W) - imax(y, GLASS_TOP));
            e->detail = POD_COVER_FULL;
            caption(m, e->c, &e->cap);
        }
    }

    // What fits: the dots go first, then the marks, then the cards; the least visible covers first (at rest the last
    // ones), and the selected one last.
    int dots = pages > 1 ? imin(pages, DOT_MAX) : 0;
    int base = s->count + SPARE_RUNS + STATUS_RUNS + dots;
    for (int i = 0; i < n; i++) base += (int)caption_runs(&sl[i].cap) + (sl[i].c == sel ? 2 : 0);   // 2: a ring
    static const int stage[4] = {POD_COVER_FEET, POD_COVER_MARKS, BARE, NORIB};
    for (int st = 0; st < (moving ? 4 : 3); st++)
        for (int pass = 0; pass < 2; pass++)
            for (;;) {
                int total = base;
                for (int k = 0; k < n; k++) total += (int)(total_cover_runs(m, sl[k].c, sl[k].detail) + ribbon_runs(&sl[k].cap, sl[k].detail));
                if (total <= HT_RUNS) goto fitted;
                int pick = -1;
                for (int i = 0; i < n; i++) {
                    bool has = st == 3 ? ribbon_runs(&sl[i].cap, sl[i].detail) > 0 : st == 2 ? !(sl[i].detail & BARE) : (sl[i].detail & stage[st]) != 0;
                    if (!has || (sl[i].c == sel) != (pass == 1)) continue;
                    if (pick < 0 || sl[i].vis <= sl[pick].vis) pick = i;
                }
                if (pick < 0) break;
                if (st >= 2) sl[pick].detail |= stage[st]; else sl[pick].detail &= ~stage[st];
            }
fitted:

    for (int i = 0; i < n; i++) {
        const slot_t *e = &sl[i];
        int c = e->c, x = e->x, y = e->y;
        bool on = c == sel, cover_on = y + COVER > GLASS_TOP && y < POD_W;   // in motion a cover can be off the glass with its caption on
        if (on && cover_on) {   // a blue ring with a small gap, over the glass's own colour
            ht_pro_rect(s, x - RING - RING_GAP, y - RING - RING_GAP, COVER + 2 * (RING + RING_GAP), COVER + 2 * (RING + RING_GAP), RING_R + RING_GAP, C(RING_BLUE));
            ht_pro_rect(s, x - RING_GAP, y - RING_GAP, COVER + 2 * RING_GAP, COVER + 2 * RING_GAP, RING_R - RING, C(floor_at(y + COVER / 2)));
        }
        if (cover_on) draw_cover(s, m, c, x, y, e->detail);
        if (cover_on && ribbon_runs(&e->cap, e->detail)) draw_ribbon(s, c, x, y, e->cap.working, now_ms);
        int ny = y + COVER + NAME_DY, ly = y + COVER + LINE_DY;
        const caption_t *cap = &e->cap;
        if (ny + ht_pro_32.height > GLASS_TOP && ny < POD_W)
            ht_pro_text(s, x, ny, CAPTION_W, &ht_pro_32, C(on ? RING_BLUE : INK), cap->name);
        if (ly + ht_pro_24.height > GLASS_TOP && ly < POD_W) {
            ht_pro_text(s, x, ly, CAPTION_W, &ht_pro_24, C(GREY), cap->count);
        }
        int hy = imax(y, GLASS_TOP), hb = imin(y + HIT_H, POD_W);   // the part of the cover on the glass
        if (hb - hy >= 40)
            pod_hit_add_id(f, x, hy, COVER, hb - hy, POD_A_OPEN_TAB, c ? c - 1 : POD_TAB_RECENT, c ? m->tabs[c - 1].id : "");
    }

    if (dots) {   // the page dots, a column on the right edge: the page nearest the offset is dark
        int cur = imax(0, imin(pages - 1, (off + PAGE_H / 2 + PAGE_H) / PAGE_H - 1));
        int y0 = GLASS_TOP + (POD_W - GLASS_TOP - (dots * DOT_PITCH - (DOT_PITCH - DOT))) / 2;
        for (int i = 0; i < dots; i++)
            ht_pro_rect(s, DOT_X, y0 + i * DOT_PITCH, DOT, DOT, DOT / 2, C(i == imin(cur, dots - 1) ? 0x4a4e5a : 0xc4c8d0));
    }

    // The status bar last: what has scrolled up under it is covered.
    pod_status(f, "Tabs", false, 0);
    if (wn > 0) {   // "N working" in green on the right, and the play triangle on the left
        char nbuf[24];
        snprintf(nbuf, sizeof nbuf, "%d working", wn);
        int w = ht_pro_width(&ht_pro_24, nbuf);
        pod_play(s, 24, 19, 14, 16, 0, C(BLUE));
        ht_pro_text(s, POD_W - 24 - w, pod_status_text_y(&ht_pro_24), w, &ht_pro_24, C(GREEN), nbuf);
    }
}
