// pod_render: the one entry point. Dispatches on the top navigation frame.
#include "pod_view.h"
#include "pro_canvas.h"

void pod_render(pod_out_frame_t *f, const pod_nav_t *nav, pod_model_t *m, uint32_t now_ms)
{
    pod_model_clock(m, now_ms);
    f->hit_count = 0;
    ht_scene_t *s = f->scene;
    const pod_frame_t *top = nav->depth ? &nav->stack[nav->depth - 1] : NULL;
    // The bell: every screen with a status bar while something is unread, but not the Inbox itself and never over a recording.
    f->unread = !m->linked ? 0 : !top || (top->view != POD_V_INBOX && top->view != POD_V_TALK) ? (m->unread_count > 99 ? 99 : m->unread_count) : 0;
    f->bell_x = 0;
    if (!m->linked) {
        // No cable: the stack stays where it is and comes back on reconnect. Only BACK is live.
        pod_status(f, pod_view_title(nav, m), nav->depth > 1, 0);
        const char *text = "Connecting…";
        int w = ht_pro_width(&ht_pro_32, text);
        ht_pro_text(s, (POD_W - w) / 2, 346, w, &ht_pro_32, ht_rgb(0x7b7d84), text);
        return;
    }
    switch (top ? top->view : POD_V_TABS) {
    case POD_V_TAB: pod_view_tab(f, nav, m, now_ms); break;
    case POD_V_AGENT: pod_view_agent(f, nav, m, now_ms); break;
    case POD_V_RECAP: pod_view_recap(f, nav, m, now_ms); break;
    case POD_V_TALK: pod_view_talk(f, nav, m, now_ms); break;
    case POD_V_INBOX: pod_view_inbox(f, nav, m, now_ms); break;
    default: pod_view_tabs(f, nav, m, now_ms); break;
    }
}

uint32_t pod_view_next_ms(const pod_nav_t *nav, const pod_model_t *m, uint32_t now_ms)
{
    const pod_frame_t *top = nav->depth ? &nav->stack[nav->depth - 1] : NULL;
    switch (top ? top->view : POD_V_TABS) {
    case POD_V_AGENT: return pod_view_agent_next_ms(nav, m, now_ms);
    case POD_V_RECAP: return pod_view_recap_next_ms(nav, m, now_ms);
    case POD_V_TALK: return pod_view_talk_next_ms(nav, m, now_ms);
    default: return POD_PET_STEP_MS;
    }
}

int pod_scroll_pitch(const pod_nav_t *nav)
{
    const pod_frame_t *top = nav->depth ? &nav->stack[nav->depth - 1] : NULL;
    if (!top) return 0;
    return top->view == POD_V_TABS ? pod_tabs_pitch() :
           top->view == POD_V_TAB ? pod_tab_pitch() :
           top->view == POD_V_INBOX ? pod_inbox_pitch() :
           top->view == POD_V_RECAP ? ht_pro_32.height : 0;
}
int pod_scroll_max(const pod_nav_t *nav, const pod_model_t *m)
{
    const pod_frame_t *top = nav->depth ? &nav->stack[nav->depth - 1] : NULL;
    if (!top) return 0;
    return top->view == POD_V_TABS ? pod_tabs_max_row(m) :
           top->view == POD_V_TAB ? pod_tab_max_row(nav, m) :
           top->view == POD_V_INBOX ? pod_inbox_max_row(m) :
           top->view == POD_V_RECAP ? pod_recap_max_row(nav, m) : 0;
}
