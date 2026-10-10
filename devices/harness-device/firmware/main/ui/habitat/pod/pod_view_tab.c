// The Tab screen: its agents in pane order, 84 px a row, right under the status bar (whose title names the tab). The
// Recent list is the same screen over the agents most recently interacted with.
#include "pod_view.h"
#include "../pro_canvas.h"

#include <stdio.h>
#include <string.h>

enum { ROWS_Y = POD_STATUS_H, ROW_H = 84, ROWS_MAX = (POD_W - POD_STATUS_H) / ROW_H };   // 7 rows

static uint16_t C(unsigned rgb) { return ht_rgb(rgb); }
static int imin(int a, int b) { return a < b ? a : b; }
static int imax(int a, int b) { return a > b ? a : b; }

static unsigned row_runs(const pod_model_t *m, const pod_agent_t *a)
{
    pod_state_t st = pod_model_eff(m, a);
    // done: the tick is 4 runs and the time one; idle says nothing (owner, 2026-10-10: "Idle" on every row was noise)
    unsigned meta = st == POD_WORKING ? 1u : st == POD_ASKING ? 2u : st == POD_DONE ? 5u : st == POD_OFFLINE ? 1u : 0u;
    return 1u + (st == POD_WORKING ? 3u : 1u) + pod_mark_runs(a->engine) + 1u + 1u + meta;
}

static bool off_row(const pod_model_t *m, const pod_agent_t *a) { return pod_model_eff(m, a) == POD_OFFLINE; }

static void row(pod_out_frame_t *f, const pod_model_t *m, const pod_agent_t *a, int index, int pane, bool prefix,
                int y0, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    uint16_t dim = C(0x7b7d84), ink = C(0x111111), blue = C(0x1f63d1);
    pod_state_t st = pod_model_eff(m, a);
    bool working = st == POD_WORKING;
    if (working) {
        pod_eq(s, 25, y0 + 32, blue, now_ms);
    } else {
        char n[12];
        snprintf(n, sizeof n, "%d", pane);
        int w = ht_pro_width(&ht_pro_32, n);
        ht_pro_text(s, 37 - w / 2, y0 + 26, w, &ht_pro_32, dim, n);
    }
    (off_row(m, a) ? pod_mark_chip_dim_on : pod_mark_chip_on)(s, 66, y0 + 24, a->engine, C(0xffffff));

    // The right side first: it decides how much room the name has.
    char meta[16] = "", t[12];
    pod_fmt_time(t, sizeof t, pod_agent_secs(a, now_ms));
    int extra = 0;
    if (working) snprintf(meta, sizeof meta, "%s", t);
    else if (st == POD_ASKING) { snprintf(meta, sizeof meta, "Asks"); extra = 24; }
    else if (st == POD_DONE) { snprintf(meta, sizeof meta, "%s", t); extra = 28; }
    else if (st == POD_OFFLINE) snprintf(meta, sizeof meta, "Offline");
    bool off = st == POD_OFFLINE;
    uint16_t grey = C(0xa0a4a0);
    int mw = meta[0] ? ht_pro_width(&ht_pro_24, meta) : 0, right = 698;
    int mx = right - mw;
    if (st == POD_ASKING) ht_pro_rect(s, mx - 24, y0 + 35, 14, 14, 7, C(0xff9f0a));
    if (st == POD_DONE) pod_tick(s, mx - 28, y0 + 34, C(0x34c759));
    if (meta[0]) ht_pro_text(s, mx, y0 + 30, mw, &ht_pro_24, off ? grey : dim, meta);

    int room = right - 118 - mw - extra - 16;
    ht_pro_text(s, 118, y0 + 8, room, &ht_pro_32, off ? grey : working ? blue : ink, a->name);
    char eng[16], sub[96];
    pod_engine_name(eng, sizeof eng, a->engine);
    const pod_tab_t *tab = prefix ? pod_tab_of(m, a) : NULL;
    if (tab) snprintf(sub, sizeof sub, "%s \xc2\xb7 %s \xc2\xb7 %s", tab->name, eng, a->machine);
    else snprintf(sub, sizeof sub, "%s \xc2\xb7 %s", eng, a->machine);
    pod_utf8_trim(sub);
    ht_pro_text(s, 118, y0 + 46, room, &ht_pro_24, off ? grey : dim, sub);
    ht_pro_rect(s, 0, y0 + ROW_H - 1, POD_W, 1, 0, C(0xe5e6ea));
    pod_hit_add_id(f, 0, y0, POD_W, ROW_H, POD_A_OPEN_AGENT, index, a->id);
}

void pod_view_tab(pod_out_frame_t *f, const pod_nav_t *nav, const pod_model_t *m, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    const pod_frame_t *fr = &nav->stack[nav->depth - 1];
    bool is_recent = fr->tab == POD_TAB_RECENT;
    const pod_tab_t *tab = !is_recent && fr->tab >= 0 && fr->tab < m->tab_count ? &m->tabs[fr->tab] : NULL;
    const pod_agent_t *list[POD_AGENTS_MAX];
    int n = pod_nav_list(nav, m, list, POD_AGENTS_MAX);

    pod_status(f, pod_view_title(nav, m), true, 0);

    int first = imax(0, imin(fr->scroll, n - ROWS_MAX));
    int shown = imin(ROWS_MAX, n - first);

    // The rows start right under the status bar (its title names the tab); fewer rows only if they do not fit the runs.
    int budget = HT_RUNS - s->count - 4;   // 4: what pod_ui_render adds (the notice)
    for (; shown > 0; shown--) {
        unsigned rows = 0;
        for (int i = 0; i < shown; i++) rows += row_runs(m, list[first + i]);
        if ((int)rows <= budget) break;
    }

    if (n == 0) {
        const char *msg = is_recent ? "No recent agents" : "No panes in this tab";
        int mw = ht_pro_width(&ht_pro_32, msg);
        ht_pro_text(s, (POD_W - mw) / 2, POD_STATUS_H + (POD_W - POD_STATUS_H - ht_pro_32.height) / 2, mw, &ht_pro_32, C(0x7b7d84), msg);
        return;
    }
    for (int i = 0; i < shown; i++) {
        const pod_agent_t *a = list[first + i];
        int pane = is_recent ? first + i + 1 : pod_agent_pane(m, a, tab);
        row(f, m, a, first + i, pane ? pane : first + i + 1, is_recent, ROWS_Y + i * ROW_H, now_ms);
    }
}

// Scrolling (see pod_scroll_pitch): a row is ROW_H px and the last offset shows the last ROWS_MAX agents.
int pod_tab_pitch(void) { return ROW_H; }
int pod_tab_max_row(const pod_nav_t *nav, const pod_model_t *m)
{
    const pod_agent_t *list[POD_AGENTS_MAX];
    return imax(0, pod_nav_list(nav, m, list, POD_AGENTS_MAX) - ROWS_MAX);
}
