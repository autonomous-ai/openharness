// The Pets entry point: ph_render paints the ground and dispatches on the top frame.
#include "pod/home/ph.h"
#include "pro_canvas.h"

void ph_render(pod_out_frame_t *f, const pod_nav_t *nav, pod_model_t *m, uint32_t now_ms)
{
    pod_model_clock(m, now_ms);
    f->hit_count = 0;
    f->scene->background = ht_rgb(PH_GROUND);   // the scene's own clear colour: no 720 x 720 ground rect to overdraw
    const pod_frame_t *top = nav->depth ? &nav->stack[nav->depth - 1] : NULL;
    if (!top || top->view == POD_V_TABS || top->view == POD_V_TAB) ph_view_home(f, nav, m, now_ms);   // a TAB frame is never reached in Pets: if one shows, it draws Home
    else if (top->view == POD_V_AGENT) ph_view_agent(f, nav, m, now_ms);
    else if (top->view == POD_V_RECAP) ph_view_recap(f, nav, m, now_ms);
    else if (top->view == POD_V_TALK) ph_view_talk(f, nav, m, now_ms);
    else if (top->view == POD_V_INBOX) ph_view_inbox(f, nav, m, now_ms);
    else if (top->view == POD_V_LEAD) ph_view_lead(f, nav, m, now_ms);
}
