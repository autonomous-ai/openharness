// pod_render: the one entry point. It draws the Pets screens (home/ph_view.c) and answers how the top screen scrolls and animates.
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
bool pod_home_has(const pod_model_t *m, int page)
{
    return page == POD_HOME_NOTICES ? pod_notice_count(m) > 0
         : page == POD_HOME_WORKING ? pod_home_working(m) > 0
         : page >= 0 && page < m->tab_count;
}
int pod_home_pages(const pod_model_t *m, int16_t *out, int cap)
{
    int n = 0;
    for (int p = POD_HOME_NOTICES; p < m->tab_count; p++)
        if (pod_home_has(m, p)) { if (out && n < cap) out[n] = (int16_t)p; n++; }
    return n;
}
int pod_home_clamp(const pod_model_t *m, int s)
{
    for (int p = s < POD_HOME_NOTICES ? POD_HOME_NOTICES : s; p < m->tab_count; p++) if (pod_home_has(m, p)) return p;
    for (int p = s < m->tab_count ? s : m->tab_count - 1; p >= POD_HOME_NOTICES; p--) if (pod_home_has(m, p)) return p;
    return 0;
}
int pod_tabs_pages_of(const pod_nav_t *nav, const pod_model_t *m)
{
    (void)nav;
    return pod_home_pages(m, NULL, 0);
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
