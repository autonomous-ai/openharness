// Pets notice toast (the owner's mockup harness-pro-notice-toast.html): a card at (40, 24), 640 x 118, over the room that is on screen when a notice arrives.
// Fill #1B2A3D with a 2 px #2A3D55 edge (no shadow: a blurred shadow costs a pass over the glass); inside, 26 px from the left, the agent's engine logo in a
// 56 px slot (the 44 px baked one centred in it), then the agent's name (ph_sb_26, #FFB36B) over the notice's first sentence (ph_rg_28, #F2F7FC), each on one
// line cut with an ellipsis. Along the bottom a 7 px progress bar (a white 8 % track, #FF8A3D fill) shrinks from full to nothing over POD_TOAST_MS; it is
// inset 26 px each side and lifted 10 px so its ends clear the card's rounded corners. The card slides in from y -170 over POD_TOAST_SLIDE_MS (ease out).
// One POD_A_BANNER hit over the card (the glue opens Notices on a tap, a swipe up dismisses it). At most 9 runs.
#include <stdio.h>
#include <string.h>

#include "pod/home/ph.h"
#include "pod/pod_view_shared.h"
#include "pro_canvas.h"

#define C(rgb) ht_rgb(rgb)
enum { TX = 40, TY = 24, TW = 640, TH = 118, TR = 30, EDGE = 2, PAD = 26, SLOT = 56, LOGO = 44, GAP = 18, FROM_Y = -170,
       BAR_H = 7, BAR_LIFT = 10 };

int ph_toast(pod_out_frame_t *f, const pod_model_t *m, const pod_unread_t *u, uint32_t shown_ms, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    int32_t age = (int32_t)(now_ms - shown_ms);
    if (age < 0) age = 0;
    int y = TY;
    if (age < POD_TOAST_SLIDE_MS) {   // ease out (cubic): fast at first, settling at TY
        const int p = (int)(age * 1000 / POD_TOAST_SLIDE_MS), q = 1000 - p;
        const int e = 1000 - (int)((long)q * q * q / 1000000);
        y = FROM_Y + (TY - FROM_Y) * e / 1000;
    }
    const pod_agent_t *a = pod_model_find(m, u->agent);
    ht_pro_rect_aa(s, TX, y, TW, TH, TR, C(PH_TOAST_EDGE));
    ht_pro_rect_aa(s, TX + EDGE, y + EDGE, TW - 2 * EDGE, TH - 2 * EDGE, TR - EDGE, C(PH_TOAST_FILL));
    ph_engine_logo(s, TX + PAD + (SLOT - LOGO) / 2, y + (TH - LOGO) / 2, LOGO, a ? a->engine : NULL, PH_TOAST_FILL);
    const int tx = TX + PAD + SLOT + GAP, tw = TX + TW - PAD - tx;
    const char *name = a && a->name[0] ? a->name : u->name[0] ? u->name : "Agent";
    char line[160];
    ph_first_sentence(line, sizeof line, u->text);
    if (!line[0]) snprintf(line, sizeof line, "%s", u->kind == POD_UNREAD_FAILED ? "Failed" : "Done");
    ph_text(s, tx, y + 42, tw, &ph_sb_26, PH_TOAST_NAME, name);
    ph_text(s, tx, y + 77, tw, &ph_rg_28, PH_TOAST_INK, line);
    // the bar: a track the full width of the inset, the fill the share of the time left
    const int bx = TX + PAD, bw = TW - 2 * PAD, by = y + TH - BAR_H - BAR_LIFT;
    ht_pro_rect(s, bx, by, bw, BAR_H, BAR_H / 2, C(ph_mix(0xFFFFFF, PH_TOAST_FILL, 8)));
    const int32_t left = POD_TOAST_MS - age;
    const int fw = left <= 0 ? 0 : left >= (int32_t)POD_TOAST_MS ? bw : (int)((int64_t)bw * left / POD_TOAST_MS);
    if (fw > 0) ht_pro_rect(s, bx, by, fw, BAR_H, fw < BAR_H ? fw / 2 : BAR_H / 2, C(PH_TOAST_BAR));
    pod_hit_add_id(f, TX, TY, TW, TH, POD_A_BANNER, 0, u->agent);
    return TH;
}
