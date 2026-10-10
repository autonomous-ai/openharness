// What every Pod screen shares: the status bar, the engine mark and its chip, the equaliser, the pane diagram,
// the Recent tile's face and the transport. The Pro fonts have no arrows, chevrons or ticks, so the icons are
// drawn from POD_TRI triangles: a play triangle is one, and a chevron or tick is two strokes with a mitered joint
// (four triangles, no round caps).
#include "pod_view.h"
#include "../pro_canvas.h"

#include <stdio.h>
#include <string.h>

static uint16_t C(unsigned rgb) { return ht_rgb(rgb); }
static int imin(int a, int b) { return a < b ? a : b; }
static int imax(int a, int b) { return a > b ? a : b; }

bool pod_hit_add(pod_out_frame_t *f, int x, int y, int w, int h, pod_action_t action, int arg)
{
    if (f->hit_count >= 32) return false;
    f->hits[f->hit_count++] = (pod_hit_t){(int16_t)x, (int16_t)y, (int16_t)w, (int16_t)h, action, (int16_t)arg, {0}};
    return true;
}
bool pod_hit_add_id(pod_out_frame_t *f, int x, int y, int w, int h, pod_action_t action, int arg, const char *id)
{
    if (!pod_hit_add(f, x, y, w, h, action, arg)) return false;
    pod_copy_str(f->hits[f->hit_count - 1].id, sizeof f->hits[0].id, id);
    return true;
}

// ---- small helpers --------------------------------------------------------------------------------------

void pod_engine_name(char *out, size_t n, const char *engine)
{
    if (!n) return;
    static const struct { const char *id, *name; } known[] = {
        {"claude", "Claude"}, {"codex", "Codex"}, {"muse", "Muse"}, {"cursor", "Cursor"},
    };
    for (unsigned i = 0; i < sizeof known / sizeof known[0]; i++)
        if (engine && !strcmp(engine, known[i].id)) { snprintf(out, n, "%s", known[i].name); return; }
    snprintf(out, n, "%s", engine ? engine : "");
    if (out[0] >= 'a' && out[0] <= 'z') out[0] = (char)(out[0] - 'a' + 'A');
}
void pod_fmt_time(char *out, size_t n, uint32_t secs)
{
    snprintf(out, n, "%u:%02u", (unsigned)(secs / 60), (unsigned)(secs % 60));
}
uint32_t pod_agent_secs(const pod_agent_t *a, uint32_t now_ms)
{
    if (!a) return 0;
    if (a->state == POD_WORKING && (int32_t)(now_ms - a->event_ms) >= 0) return a->elapsed_s + (now_ms - a->event_ms) / 1000;
    return a->elapsed_s;
}
int pod_agent_index(const pod_model_t *m, const pod_agent_t *a)
{
    if (!a || a < m->agents || a >= m->agents + m->agent_count) return -1;
    return (int)(a - m->agents);
}
void pod_tab_counts(const pod_model_t *m, const pod_tab_t *t, int *working, int *asking)
{
    int w = 0, q = 0;
    for (int k = 0; t && k < t->count && k < POD_PANES_MAX; k++) {
        int i = t->agent[k];
        if (i < 0 || i >= m->agent_count) continue;
        pod_state_t st = pod_model_eff(m, &m->agents[i]);
        if (st == POD_WORKING) w++;
        else if (st == POD_ASKING) q++;
    }
    if (working) *working = w;
    if (asking) *asking = q;
}
int pod_tab_panes(const pod_tab_t *t) { return t->panes ? t->panes : t->count; }
const pod_tab_t *pod_tab_of(const pod_model_t *m, const pod_agent_t *a)
{
    int idx = pod_agent_index(m, a);
    if (idx < 0) return NULL;
    for (int i = 0; i < m->tab_count; i++)
        for (int k = 0; k < m->tabs[i].count && k < POD_PANES_MAX; k++)
            if (m->tabs[i].agent[k] == idx) return &m->tabs[i];
    return NULL;
}
int pod_agent_pane(const pod_model_t *m, const pod_agent_t *a, const pod_tab_t *t)
{
    int idx = pod_agent_index(m, a);
    if (idx < 0 || !t) return 0;
    for (int k = 0; k < t->count && k < POD_PANES_MAX; k++)
        if (t->agent[k] == idx) return k + 1;
    return 0;
}

// ---- icons ----------------------------------------------------------------------------------------------

void pod_play(ht_scene_t *s, int x, int y, int w, int h, int dir, uint16_t ink)
{
    int mid = y * 16 + h * 8;
    if (dir) pod_tri(s, (x + w) * 16, y * 16, (x + w) * 16, (y + h) * 16, x * 16, mid, ink);
    else pod_tri(s, x * 16, y * 16, x * 16, (y + h) * 16, (x + w) * 16, mid, ink);
}
static int isqrt32(uint32_t n)
{
    uint32_t root = 0, bit = 1u << 30;
    while (bit > n) bit >>= 2;
    while (bit) {
        if (n >= root + bit) { n -= root + bit; root = (root >> 1) + bit; }
        else root >>= 1;
        bit >>= 2;
    }
    return (int)root;
}
// A stroke p0 -> p1 -> p2 (sixteenths of a px) t16 thick with a mitered joint and square ends: two quads of two
// triangles each. The edges inside the figure are inner (they bleed, so there is no seam); only the outline is
// anti-aliased.
static void miter(ht_scene_t *s, const int p[3][2], int t16, uint16_t ink)
{
    int h = t16 / 2, n[2][2];
    for (int i = 0; i < 2; i++) {
        int dx = p[i + 1][0] - p[i][0], dy = p[i + 1][1] - p[i][1], len = isqrt32((uint32_t)(dx * dx + dy * dy));
        if (!len) return;
        n[i][0] = -dy * h / len; n[i][1] = dx * h / len;
    }
    int dot = n[0][0] * n[1][0] + n[0][1] * n[1][1], den = h * h + dot;
    if (den <= 0) return;
    int mx = (n[0][0] + n[1][0]) * h * h / den, my = (n[0][1] + n[1][1]) * h * h / den;
    int a0x = p[0][0] + n[0][0], a0y = p[0][1] + n[0][1], b0x = p[0][0] - n[0][0], b0y = p[0][1] - n[0][1];
    int a1x = p[1][0] + mx, a1y = p[1][1] + my, b1x = p[1][0] - mx, b1y = p[1][1] - my;
    int a2x = p[2][0] + n[1][0], a2y = p[2][1] + n[1][1], b2x = p[2][0] - n[1][0], b2y = p[2][1] - n[1][1];
    pod_tri_inner(s, a0x, a0y, a1x, a1y, b1x, b1y, ink, 6);
    pod_tri_inner(s, a0x, a0y, b1x, b1y, b0x, b0y, ink, 1);
    pod_tri_inner(s, a1x, a1y, a2x, a2y, b2x, b2y, ink, 4);
    pod_tri_inner(s, a1x, a1y, b2x, b2y, b1x, b1y, ink, 5);
}
void pod_chevron(ht_scene_t *s, int x, int y, int a, uint16_t ink)
{
    // Tip at (x, y), legs a px across and a px up or down, 3.25 px thick.
    const int p[3][2] = {{(x + a) * 16, (y - a) * 16}, {x * 16, y * 16}, {(x + a) * 16, (y + a) * 16}};
    miter(s, p, 52, ink);
}
void pod_tick(ht_scene_t *s, int x, int y, uint16_t ink)
{
    const int p[3][2] = {{(x + 2) * 16, (y + 8) * 16}, {(x + 7) * 16 + 8, (y + 13) * 16 + 8}, {(x + 19) * 16, (y + 2) * 16}};
    miter(s, p, 48, ink);
}

// ---- status bar -----------------------------------------------------------------------------------------

// The y that centres a line's capitals (cap top to baseline) on the status bar, not its whole cell: the cell
// includes the descender, so a cell centred on the bar sat 4 px low ("Tabs" under its bar, owner 2026-10-10).
// Cap top and cap height measured from the Helvetica atlases (generate_fonts.py): 32 px 9 + 23, 24 px 6 + 17.
int pod_status_text_y(const ht_pro_font_t *font)
{
    int top = font == &ht_pro_32 ? 9 : 6, cap = font == &ht_pro_32 ? 23 : 17;
    return POD_STATUS_H / 2 - cap / 2 - top;
}

void pod_status(pod_out_frame_t *f, const char *title, bool back, int working)
{
    ht_scene_t *s = f->scene;
    pod_grad(s, 0, 0, POD_W, POD_STATUS_H, 0, C(0xf7f8fa), C(0xdcdee3));
    if (back) {
        pod_chevron(s, 24, 27, 13, C(0x1f63d1));
        pod_hit_add(f, 0, 0, 120, 60, POD_A_BACK, 0);
    } else if (working > 0) {
        char n[12];
        snprintf(n, sizeof n, "%d", working);
        pod_play(s, 24, 19, 14, 16, 0, C(0x7b7d84));
        ht_pro_text(s, 46, pod_status_text_y(&ht_pro_24), 60, &ht_pro_24, C(0x7b7d84), n);
    }
    int w = imin(ht_pro_width(&ht_pro_32, title), 480);
    ht_pro_text(s, (POD_W - w) / 2, pod_status_text_y(&ht_pro_32), w, &ht_pro_32, C(0x111111), title);
}

const char *pod_view_title(const pod_nav_t *nav, const pod_model_t *m)
{
    const pod_frame_t *f = nav->depth ? &nav->stack[nav->depth - 1] : NULL;
    if (!f || f->view == POD_V_TABS) return "Tabs";
    if (f->view == POD_V_RECAP) return "Recap";
    if (f->view == POD_V_TALK) {   // Listening: the title is who the words go to
        const pod_agent_t *a = pod_model_find(m, f->agent);
        return a && a->name[0] ? a->name : "Listening";
    }
    if (f->tab == POD_TAB_RECENT) return "Recent";
    return f->tab >= 0 && f->tab < m->tab_count ? m->tabs[f->tab].name : "Tab";
}

// ---- marks and the equaliser ----------------------------------------------------------------------------

unsigned pod_mark_runs(const char *engine)
{
    const pod_mark_t *m = pod_mark(engine);
    return m ? (m->light ? 2u : 1u) : (unsigned)POD_DEFAULT_MARK_RUNS;
}
bool pod_mark_chip_on(ht_scene_t *s, int x, int y, const char *engine, uint16_t ground)
{
    const pod_mark_t *m = pod_mark(engine);
    if (!m) { pod_mark_default(s, x + 1, y + 1, ground); return true; }
    if (m->light) ht_pro_rect(s, x, y, 36, 36, 8, C(0x1d1e23));
    return pod_logo_draw(s, x + 4, y + 4, POD_LOGO_CHIP, engine);
}
bool pod_mark_chip_dim_on(ht_scene_t *s, int x, int y, const char *engine, uint16_t ground)
{
    const pod_mark_t *m = pod_mark(engine);
    if (!m) { pod_mark_default(s, x + 1, y + 1, ground); return true; }   // already grey
    if (m->light) ht_pro_rect(s, x, y, 36, 36, 8, C(0xb8bab8));
    return pod_logo_draw_faded(s, x + 4, y + 4, POD_LOGO_CHIP, engine, POD_MARK_DIM);
}
bool pod_mark_chip(ht_scene_t *s, int x, int y, const char *engine)
{
    return pod_mark_chip_on(s, x, y, engine, C(0xffffff));
}
void pod_eq(ht_scene_t *s, int x, int y, uint16_t ink, uint32_t now_ms)
{
    static const uint16_t phase[3] = {0, 300, 600};
    for (int i = 0; i < 3; i++) {
        int p = (int)((now_ms + phase[i]) % 900), v = p < 450 ? p : 900 - p;
        int h = 5 + 15 * v / 450;
        ht_pro_rect(s, x + i * 9, y + 20 - h, 5, h, 1, ink);
    }
}

// ---- the pane diagram -----------------------------------------------------------------------------------

typedef pod_box_t box_t;

static int real_panes(const pod_tab_t *t) { return t->count ? t->count : t->panes; }
// A tab with no panes still draws one, holding the default mark.
static int pane_count(const pod_tab_t *t) { int n = real_panes(t); return n ? n : 1; }
static const pod_agent_t *pane_agent(const pod_model_t *m, const pod_tab_t *t, int k)
{
    if (!t->members_known || k >= t->count || k >= POD_PANES_MAX) return NULL;
    int i = t->agent[k];
    return i >= 0 && i < m->agent_count ? &m->agents[i] : NULL;
}
// Cell i of n along `len` px starting at `at`, with `gap` between cells.
static void cell(int at, int len, int gap, int n, int i, int *pos, int *size)
{
    int room = len - (n - 1) * gap;
    int a = at + i * gap + room * i / n, b = at + i * gap + room * (i + 1) / n;
    *pos = a; *size = b - a;
}
// The boxes of the panes in the side x side box at (x, y). With the desktop's own rects every pane (up to
// POD_PANES_MAX) gets its rect; else a preset grid by count: 1; 2 side by side; 3 = one tall + two; 4 = 2 x 2;
// 5-6 = 3 x 2; 7-9 = 3 x 3, row-major; beyond 9 the first 8 and a ninth cell holding "+N". Returns the pane boxes;
// *extra is the panes beyond them (their count goes in the cell out[return value]).
static int layout_pg(const pod_tab_t *t, int x, int y, int side, int pad, int g, box_t out[POD_PANES_MAX], int *extra)
{
    int n = pane_count(t);
    *extra = 0;
    int ix = x + pad, iy = y + pad, iw = side - 2 * pad;
    if (t->has_rects && real_panes(t)) {
        // The desktop's own rects (0..1000): shrink each by half a gap, over an area grown by the same.
        int hg = g / 2, ax = x + pad - hg, ay = y + pad - hg, aw = side - 2 * pad + g, shown = imin(real_panes(t), POD_PANES_MAX);
        for (int k = 0; k < shown; k++) {
            const pod_rect_t *r = &t->rect[k];
            int x0 = ax + r->x1 * aw / 1000 + hg, x1 = ax + r->x2 * aw / 1000 - hg;
            int y0 = ay + r->y1 * aw / 1000 + hg, y1 = ay + r->y2 * aw / 1000 - hg;
            out[k] = (box_t){x0, y0, imax(8, x1 - x0), imax(8, y1 - y0)};
        }
        return shown;
    }
    int half = (iw - g) / 2;
    if (n == 1) { out[0] = (box_t){ix, iy, iw, iw}; return 1; }
    if (n == 2) {
        out[0] = (box_t){ix, iy, half, iw};
        out[1] = (box_t){ix + half + g, iy, iw - half - g, iw};
        return 2;
    }
    if (n == 3) {
        out[0] = (box_t){ix, iy, half, iw};
        out[1] = (box_t){ix + half + g, iy, iw - half - g, half};
        out[2] = (box_t){ix + half + g, iy + half + g, iw - half - g, iw - half - g};
        return 3;
    }
    int cols = n == 4 ? 2 : 3, rows = n <= 4 ? 2 : n <= 6 ? 2 : 3, cells = cols * rows;
    int shown = n > 9 ? 8 : n;
    if (n > 9) *extra = n - 8;
    int total = *extra ? cells : shown;
    for (int k = 0; k < total; k++) {
        int bx, bw, by, bh;
        cell(ix, iw, g, cols, k % cols, &bx, &bw);
        cell(iy, iw, g, rows, k / cols, &by, &bh);
        out[k] = (box_t){bx, by, bw, bh};
    }
    return shown;
}
static int layout(const pod_tab_t *t, int x, int y, int side, box_t out[POD_PANES_MAX], int *extra)
{
    return layout_pg(t, x, y, side, 8, 6, out, extra);
}
static bool has_foot(const pod_model_t *m, const pod_agent_t *a)
{
    if (!a) return false;
    pod_state_t st = pod_model_eff(m, a);
    return st == POD_WORKING || st == POD_ASKING;
}
// A mark is 36 px: a pane smaller than that in either direction goes without (a mark would spill over its neighbours).
static bool mark_fits(const box_t *b) { return b->w >= 34 && b->h >= 34; }

// The marks the first `marks` panes draw count; a pane past that is a tint. See pod_panes_runs.
unsigned pod_panes_runs(const pod_model_t *m, const pod_tab_t *t, int side, int detail)
{
    box_t b[POD_PANES_MAX];
    int extra, shown = layout(t, 0, 0, side, b, &extra);
    unsigned n = (detail & POD_DETAIL_BORDER) ? 2u : 1u;
    for (int k = 0; k < shown; k++) {
        const pod_agent_t *a = pane_agent(m, t, k);
        n++;
        if ((detail & POD_DETAIL_FEET) && has_foot(m, a)) n++;
        if ((detail & POD_DETAIL_MARKS) && mark_fits(&b[k])) n += pod_mark_runs(a ? a->engine : NULL);
    }
    return n + (extra > 0 ? 2u : 0u);
}
void pod_panes_ex(ht_scene_t *s, int x, int y, int side, const pod_model_t *m, const pod_tab_t *t, int detail)
{
    if (detail & POD_DETAIL_BORDER) {
        ht_pro_rect(s, x, y, side, side, 12, C(0xd9dbe0));
        ht_pro_rect(s, x + 1, y + 1, side - 2, side - 2, 11, C(0xffffff));
    } else {
        ht_pro_rect(s, x, y, side, side, 12, C(0xf6f7f9));
    }
    box_t b[POD_PANES_MAX];
    int extra, n = layout(t, x, y, side, b, &extra);
    for (int k = 0; k < n; k++) {
        const pod_agent_t *a = pane_agent(m, t, k);
        pod_state_t st = a ? pod_model_eff(m, a) : POD_IDLE;
        unsigned tint = st == POD_WORKING ? 0xe2edfd : st == POD_ASKING ? 0xfff1dc : 0xebefeb;   // neutral in RGB565: 0xf0f1f4 came out pink (R and B have 5 bits, G 6)
        ht_pro_rect(s, b[k].x, b[k].y, b[k].w, b[k].h, 7, C(tint));
        if ((detail & POD_DETAIL_FEET) && has_foot(m, a))
            ht_pro_rect(s, b[k].x + 3, b[k].y + b[k].h - 4, b[k].w - 6, 4, 2, C(st == POD_WORKING ? 0x1f63d1 : 0xff9f0a));
        if ((detail & POD_DETAIL_MARKS) && mark_fits(&b[k]))   // an unknown member or engine gets the default mark
            (st == POD_OFFLINE ? pod_mark_chip_dim_on : pod_mark_chip_on)(s, b[k].x + (b[k].w - 36) / 2, b[k].y + (b[k].h - 36) / 2, a ? a->engine : NULL, C(tint));
    }
    if (extra > 0) {   // the ninth cell: the rest, as a count
        char more[12];
        snprintf(more, sizeof more, "+%d", extra);
        int w = ht_pro_width(&ht_pro_24, more);
        ht_pro_rect(s, b[n].x, b[n].y, b[n].w, b[n].h, 7, C(0xebefeb));
        ht_pro_text(s, b[n].x + (b[n].w - w) / 2, b[n].y + (b[n].h - ht_pro_24.height) / 2, w, &ht_pro_24, C(0x111111), more);
    }
}
void pod_panes(ht_scene_t *s, int x, int y, int side, const pod_model_t *m, const pod_tab_t *t)
{
    pod_panes_ex(s, x, y, side, m, t, POD_DETAIL_FULL);
}

// ---- a tab as an album cover ----------------------------------------------------------------------------

// The panes' cards on a cover scale with it: the padding is 9% of the side and the gap 3.6%.
static int cover_pad(int side) { return side * 9 / 100; }
static int cover_gap(int side) { return side * 36 / 1000; }
int pod_cover_layout(const pod_tab_t *t, int side, pod_box_t out[POD_PANES_MAX], int *extra)
{
    return layout_pg(t, 0, 0, side, cover_pad(side), cover_gap(side), out, extra);
}
unsigned pod_cover_cards_runs(const pod_model_t *m, const pod_tab_t *t, int side, int detail)
{
    box_t b[POD_PANES_MAX];
    int extra, shown = layout_pg(t, 0, 0, side, cover_pad(side), cover_gap(side), b, &extra);
    unsigned n = 0;
    for (int k = 0; k < shown; k++) {
        const pod_agent_t *a = pane_agent(m, t, k);
        n += 1u;
        if ((detail & POD_COVER_FEET) && has_foot(m, a)) n++;
        if ((detail & POD_COVER_MARKS) && mark_fits(&b[k])) n += pod_mark_runs(a ? a->engine : NULL);
    }
    return n + (extra > 0 ? 2u : 0u);
}
void pod_cover_cards(ht_scene_t *s, int x, int y, int side, const pod_model_t *m, const pod_tab_t *t, int detail)
{
    box_t b[POD_PANES_MAX];
    int extra, n = layout_pg(t, x, y, side, cover_pad(side), cover_gap(side), b, &extra);
    for (int k = 0; k < n; k++) {
        const pod_agent_t *a = pane_agent(m, t, k);
        ht_pro_rect(s, b[k].x, b[k].y, b[k].w, b[k].h, 8, C(0xffffff));
        if ((detail & POD_COVER_MARKS) && mark_fits(&b[k]))   // an unknown member or engine gets the default mark
            (a && pod_model_eff(m, a) == POD_OFFLINE ? pod_mark_chip_dim_on : pod_mark_chip_on)(s, b[k].x + (b[k].w - 36) / 2, b[k].y + (b[k].h - 36) / 2, a ? a->engine : NULL, C(0xffffff));
        if ((detail & POD_COVER_FEET) && has_foot(m, a))   // working: green; asking: amber
            ht_pro_rect(s, b[k].x + b[k].w - 18, b[k].y + 6, 12, 12, 6, C(pod_model_eff(m, a) == POD_WORKING ? 0x34c759 : 0xff9f0a));
    }
    if (extra > 0) {
        char more[12];
        snprintf(more, sizeof more, "+%d", extra);
        int w = ht_pro_width(&ht_pro_24, more);
        ht_pro_rect(s, b[n].x, b[n].y, b[n].w, b[n].h, 8, C(0xffffff));
        ht_pro_text(s, b[n].x + (b[n].w - w) / 2, b[n].y + (b[n].h - ht_pro_24.height) / 2, w, &ht_pro_24, C(0x111111), more);
    }
}

// Recent's cover: up to 8 agents' marks, 4 x 2, each in a white rounded square, a dot on the working and asking ones.
enum { RECENT_COLS = 4 };
static void recent_cell(int side, int i, int *x, int *y, int *w)
{
    int pad = cover_pad(side), gap = cover_gap(side), iw = side - 2 * pad;
    *w = (iw - (RECENT_COLS - 1) * gap) / RECENT_COLS;
    int top = (side - (2 * *w + gap)) / 2;
    *x = pad + (i % RECENT_COLS) * (*w + gap);
    *y = top + (i / RECENT_COLS) * (*w + gap);
}
unsigned pod_cover_recent_runs(const pod_model_t *m, int side, int detail)
{
    const pod_agent_t *l[POD_RECENT_MAX];
    int n = pod_model_recent(m, l, POD_RECENT_MAX);
    unsigned runs = 0;
    for (int i = 0; i < n; i++) {
        runs += 1u;
        if (detail & POD_COVER_MARKS) runs += pod_mark_runs(l[i]->engine);
        if ((detail & POD_COVER_FEET) && has_foot(m, l[i])) runs++;
    }
    (void)side;
    return runs;
}
void pod_cover_recent(ht_scene_t *s, int x, int y, int side, const pod_model_t *m, int detail)
{
    const pod_agent_t *l[POD_RECENT_MAX];
    int n = pod_model_recent(m, l, POD_RECENT_MAX);
    for (int i = 0; i < n; i++) {
        int cx, cy, w;
        recent_cell(side, i, &cx, &cy, &w);
        cx += x; cy += y;
        ht_pro_rect(s, cx, cy, w, w, 9, C(0xffffff));
        if (detail & POD_COVER_MARKS) pod_mark_chip_on(s, cx + (w - 36) / 2, cy + (w - 36) / 2, l[i]->engine, C(0xffffff));
        if ((detail & POD_COVER_FEET) && has_foot(m, l[i]))
            ht_pro_rect(s, cx + w - 13, cy + 1, 12, 12, 6, C(pod_model_eff(m, l[i]) == POD_WORKING ? 0x34c759 : 0xff9f0a));
    }
}
// An empty tab's cover: a grey gradient with a big white "+" in a ring. Four runs.
unsigned pod_cover_empty_runs(void) { return 4; }
void pod_cover_empty(ht_scene_t *s, int x, int y, int side, int radius)
{
    pod_grad(s, x, y, side, side, radius, C(0xa4a8b3), C(0x666a78));
    int cx = x + side / 2, cy = y + side / 2, r = side * 19 / 100, w = imax(4, side / 40);
    pod_arc(s, cx * 16, cy * 16, (r - w / 2) * 16, w * 16, 0, 180, C(0xffffff));
    int arm = r * 11 / 20;
    ht_pro_rect(s, cx - arm, cy - w / 2, 2 * arm, w, w / 2, C(0xffffff));
    ht_pro_rect(s, cx - w / 2, cy - arm, w, 2 * arm, w / 2, C(0xffffff));
}

// ---- the Recent tile's face -----------------------------------------------------------------------------

// A gradient with a small clock: a ring and two hands, centred. Four runs.
unsigned pod_recent_face_runs(void) { return 4; }
void pod_recent_face(ht_scene_t *s, int x, int y, int side) { pod_recent_face_r(s, x, y, side, 12); }
void pod_recent_face_r(ht_scene_t *s, int x, int y, int side, int radius)
{
    pod_grad(s, x, y, side, side, radius, C(0x5ea2f2), C(0x1f63d1));
    int cx = x + side / 2, cy = y + side / 2, r = side * 5 / 24, w = imax(4, side / 40), hw = imax(3, side / 52);
    pod_arc(s, cx * 16, cy * 16, (r - w / 2) * 16, w * 16, 0, 180, C(0xffffff));
    ht_pro_rect(s, cx - hw / 2, cy - r * 6 / 10, hw, r * 6 / 10 + hw / 2 + 1, hw / 2, C(0xffffff));   // minute hand, up
    ht_pro_rect(s, cx - hw / 2, cy - hw / 2, r * 45 / 100 + hw / 2, hw, hw / 2, C(0xffffff));         // hour hand, right
}

// ---- the transport --------------------------------------------------------------------------------------

static void centered(ht_scene_t *s, int cx, int y, const ht_pro_font_t *font, uint16_t ink, const char *text)
{
    int w = ht_pro_width(font, text);
    ht_pro_text(s, cx - w / 2, y, w, font, ink, text);
}
// Material Symbols' "send" (Apache 2.0) on its 24 unit grid, as four triangles (the notch makes it concave), tilted up
// 25 degrees like a plane taking off, the box of its ink centred on (cx, cy) (owner, 2026-10-10: offset toward the tail
// it read as sitting low and right). Each triangle marks the edges it shares with a neighbour (pod_tri_inner) so the
// seams do not show.
static void send_plane(ht_scene_t *s, int cx, int cy, int size)
{
    static const signed char tri[4][6] = {{2, 3, 23, 12, 17, 12}, {2, 3, 17, 12, 2, 10},
                                          {2, 21, 23, 12, 17, 12}, {2, 21, 17, 12, 2, 14}};
    static const unsigned char inner[4] = {6, 1, 6, 1};
    const float co = 0.906308f, si = 0.422618f, k = (float)size / 24.0f;
    float px[4][3], py[4][3], x0 = 1e9f, x1 = -1e9f, y0 = 1e9f, y1 = -1e9f;
    for (int i = 0; i < 4; i++)
        for (int j = 0; j < 3; j++) {
            float x = (float)tri[i][2 * j] * k, y = (float)tri[i][2 * j + 1] * k;
            px[i][j] = x * co + y * si;
            py[i][j] = -x * si + y * co;
            if (px[i][j] < x0) x0 = px[i][j];
            if (px[i][j] > x1) x1 = px[i][j];
            if (py[i][j] < y0) y0 = py[i][j];
            if (py[i][j] > y1) y1 = py[i][j];
        }
    const float ox = (float)cx - (x0 + x1) / 2, oy = (float)cy - (y0 + y1) / 2;
    for (int i = 0; i < 4; i++) {
        int v[6];
        for (int j = 0; j < 3; j++) {
            v[2 * j] = (int)((ox + px[i][j]) * 16.0f + 0.5f);
            v[2 * j + 1] = (int)((oy + py[i][j]) * 16.0f + 0.5f);
        }
        pod_tri_inner(s, v[0], v[1], v[2], v[3], v[4], v[5], C(0xffffff), inner[i]);
    }
}

void pod_transport(pod_out_frame_t *f, bool talking)
{
    ht_scene_t *s = f->scene;
    const int top = POD_TRANSPORT_Y, mid = top + 63;
    pod_grad(s, 0, top, POD_W, POD_TRANSPORT_H, 0, C(0xf7f8fa), C(0xdcdee3));
    ht_pro_rect(s, 0, top, POD_W, 1, 0, C(0xc9cbd1));
    // TABS and PANES, the two small buttons: an icon over its word.
    for (int i = 0; i < 4; i++)   // the Tabs screen's grid, 2 x 2
        ht_pro_rect(s, 62 - 18 + (i % 2) * 21, mid - 36 + (i / 2) * 21, 15, 15, 3, C(0x111111));
    centered(s, 62, mid + 6, &ht_pro_24, C(0x7b7d84), "TABS");
    centered(s, 658, mid - 41, &ht_pro_42, C(0x111111), "#");
    centered(s, 658, mid + 6, &ht_pro_24, C(0x7b7d84), "PANES");
    // Previous and next: a 3 px bar and a triangle each, 33 px across, centred on the buttons.
    ht_pro_rect(s, 236 - 16, mid - 16, 3, 32, 0, C(0x111111));
    pod_play(s, 236 - 16 + 5, mid - 16, 28, 32, 1, C(0x111111));
    pod_play(s, 484 - 17, mid - 16, 28, 32, 0, C(0x111111));
    ht_pro_rect(s, 484 - 17 + 30, mid - 16, 3, 32, 0, C(0x111111));
    // The big one, icon only, on the same blue gradient: ▶, or while listening the send button's paper plane.
    if (talking) {
        pod_grad(s, 310, mid - 50, 100, 100, 50, C(0x5ea2f2), C(0x1f63d1));
        send_plane(s, 360, mid, 60);
    } else {
        pod_grad(s, 310, mid - 50, 100, 100, 50, C(0x5ea2f2), C(0x1f63d1));
        pod_play(s, 360 - 35 / 2 + 35 / 12, mid - 20, 35, 40, 0, C(0xffffff));   // optically centred: a triangle sits left of its box
        // Three empty slots: the plane is four triangles, the play one, so both faces add the same runs (POD_TRANSPORT_RUNS).
        for (int i = 0; i < 3; i++) pod_arc(s, 360 * 16, mid * 16, 0, 0, 0, 0, 0);
    }
    pod_hit_add(f, 10, top, 104, POD_TRANSPORT_H, POD_A_TABS, 0);
    pod_hit_add(f, 190, mid - 50, 96, 100, POD_A_PREV, 0);
    pod_hit_add(f, 300, mid - 50, 120, 100, POD_A_TALK, 0);
    pod_hit_add(f, 434, mid - 50, 96, 100, POD_A_NEXT, 0);
    pod_hit_add(f, 606, top, 104, POD_TRANSPORT_H, POD_A_PANES, 0);
}
