// pod_render: the one entry point. It draws the Pets screens (home/ph_view.c) and answers how the top screen scrolls and animates.

#include <string.h>

#include "pod_view.h"
#include "pro_canvas.h"
#include "pod/home/ph.h"

void pod_render(pod_out_frame_t *f, const pod_nav_t *nav, pod_model_t *m, uint32_t now_ms)
{
    ph_render(f, nav, m, now_ms);
}

uint32_t pod_view_next_ms(const pod_nav_t *nav, const pod_model_t *m, uint32_t now_ms)
{
    const pod_frame_t *top = nav->depth ? &nav->stack[nav->depth - 1] : NULL;
    switch (top ? top->view : POD_V_TABS) {
    case POD_V_TABS:
    case POD_V_TAB: return ph_home_next_ms(nav, m, now_ms);   // Home: 66 ms while the equaliser shows, else 1000
    case POD_V_AGENT:
    case POD_V_RECAP: return ph_room_next_ms(nav, m, now_ms);   // the room's pet and its seconds
    case POD_V_TALK: return ph_talk_next_ms(nav, m, now_ms);   // the pet's own animation is all that moves, on its beat
    case POD_V_INBOX: return ph_inbox_next_ms(nav, m, now_ms);   // Notices: when an age text changes
    default: return POD_PET_STEP_MS;
    }
}

int pod_home_working(const pod_model_t *m)
{
    int n = 0;
    for (int i = 0; i < m->agent_count; i++) n += pod_model_eff(m, &m->agents[i]) == POD_WORKING;
    return n;
}
static bool other_app(const pod_app_t *a) { return a->count > 0 && strcmp(a->id, POD_APP_HARNESS); }
bool pod_home_switch(const pod_model_t *m)
{
    if (!m->has_window || !m->apps_switch) return false;
    for (int i = 0; i < m->app_count; i++) if (other_app(&m->apps[i])) return true;
    return false;
}
int pod_home_app_cards(const pod_model_t *m, uint8_t *out, int cap)
{
    const bool pill = pod_home_switch(m);
    int n = 0;
    for (int i = 0; i < m->app_count; i++)
        if (pill ? other_app(&m->apps[i]) : m->apps[i].count > 0) { if (out && n < cap) out[n] = (uint8_t)i; n++; }
    return n;
}
bool pod_home_apps(const pod_nav_t *nav, const pod_model_t *m)
{
    if (!m->has_window) return pod_home_app_cards(m, NULL, 0) > 0;
    return pod_home_switch(m) && nav->home_apps;
}
int pod_app_agents(const pod_model_t *m, const char *app_id, const pod_agent_t *out[], int max)
{
    if (!app_id || !app_id[0] || strcmp(app_id, m->app_shown)) return 0;
    int n = 0;
    for (int i = 0; i < m->agent_count && n < max; i++) if (!strcmp(m->agents[i].host, app_id)) out[n++] = &m->agents[i];
    return n;
}
// The list's first page and its end: the tabs, or the app cards.
static int list_end(const pod_nav_t *nav, const pod_model_t *m, int *first)
{
    if (!pod_home_apps(nav, m)) { *first = 0; return m->tab_count; }
    *first = POD_HOME_APP0;
    return POD_HOME_APP0 + pod_home_app_cards(m, NULL, 0);
}
bool pod_home_has(const pod_nav_t *nav, const pod_model_t *m, int page)
{
    if (page == POD_HOME_NOTICES) return pod_notice_count(m) > 0;
    if (page == POD_HOME_WORKING) return pod_home_working(m) > 0;
    int first;
    const int end = list_end(nav, m, &first);
    return page >= first && page < end;
}
static void put(int16_t *out, int cap, int *n, int page) { if (out && *n < cap) out[*n] = (int16_t)page; (*n)++; }
int pod_home_pages(const pod_nav_t *nav, const pod_model_t *m, int16_t *out, int cap)
{
    int n = 0, first;
    const int end = list_end(nav, m, &first);
    if (pod_notice_count(m) > 0) put(out, cap, &n, POD_HOME_NOTICES);
    if (pod_home_working(m) > 0) put(out, cap, &n, POD_HOME_WORKING);
    for (int p = first; p < end; p++) put(out, cap, &n, p);
    return n;
}
int pod_home_clamp(const pod_nav_t *nav, const pod_model_t *m, int s)
{
    int16_t pg[POD_HOME_PAGES_MAX];
    const int n = pod_home_pages(nav, m, pg, POD_HOME_PAGES_MAX);
    for (int i = 0; i < n; i++) if (pg[i] >= s) return pg[i];
    return n > 0 ? pg[n - 1] : 0;
}
int pod_tabs_pages_of(const pod_nav_t *nav, const pod_model_t *m)
{
    return pod_home_pages(nav, m, NULL, 0);
}

int pod_scroll_pitch(const pod_nav_t *nav)
{
    const pod_frame_t *top = nav->depth ? &nav->stack[nav->depth - 1] : NULL;
    return top && top->view == POD_V_INBOX ? ph_inbox_pitch() : 0;   // Home pages with a swipe and a recap is the host's pane: no device scroll
}
int pod_scroll_max(const pod_nav_t *nav, const pod_model_t *m)
{
    const pod_frame_t *top = nav->depth ? &nav->stack[nav->depth - 1] : NULL;
    if (!top) return 0;
    if (top->view == POD_V_INBOX) return ph_inbox_max_row(m);
    if (top->view == POD_V_TABS) return m->tab_count > 0 ? m->tab_count - 1 : 0;   // Home's scroll is the tab index
    return 0;
}
