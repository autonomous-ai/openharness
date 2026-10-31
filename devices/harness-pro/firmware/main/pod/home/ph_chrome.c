// Pets chrome: the page dots, Home's equaliser and the room's frame. Sizes and colours are the mockup's.
#include <stdio.h>
#include <string.h>

#include "pod/home/ph.h"
#include "pro_canvas.h"

#define C(rgb) ht_rgb(rgb)
// The y that centres a face's lowercase band on cy (the cell's baseline sits at 1/1.375 of its height).
static int ty(const ht_pro_font_t *f, int cy) { return cy - f->height * 15 / 32; }
static void text(ht_scene_t *s, int x, int cy, int w, const ht_pro_font_t *f, unsigned rgb, const char *t)
{
    ht_pro_text(s, x, ty(f, cy), w, f, C(rgb), t);
}

void ph_text(ht_scene_t *s, int x, int cy, int w, const ht_pro_font_t *f, unsigned rgb, const char *t) { text(s, x, cy, w, f, rgb, t); }

// Home's equaliser: four 8 px bars 5 px apart in a 36 px box, each a triangle wave between 40 % and 100 % of its height, 900 ms.
void ph_working_mark_big(ht_scene_t *s, int x, int y, uint32_t now_ms)
{
    static const int phase[4] = {-200, -500, -100, -700};   // the same wave, in the Home line's green
    for (int i = 0; i < 4; i++) {
        int t = ((int)(now_ms % 900u) + phase[i] + 900) % 900, tri = t < 450 ? t : 900 - t;
        int h = 36 * (400 + 600 * tri / 450) / 1000;
        ht_pro_rect(s, x + i * 13, y + 36 - h, 8, h, 3, C(PH_ROOM_GREEN));
    }
}

int ph_runs(const pod_out_frame_t *f) { return f->scene->count; }

unsigned ph_mix(unsigned a, unsigned b, unsigned pct)
{
    unsigned r = 0;
    for (int sh = 0; sh <= 16; sh += 8) r |= ((((a >> sh) & 0xff) * pct + ((b >> sh) & 0xff) * (100 - pct)) / 100) << sh;
    return r;
}

// ---- The room's chrome ------------------------------------------------------------------------------------------------------

bool ph_has_recap(const pod_agent_t *a)
{
    for (int i = 0; i < a->recap_lines; i++)
        if (a->recap[a->line_at[i]]) return true;
    return false;
}

pod_scene_t ph_work_scene(const pod_agent_t *a)
{
    const ht_pet_t *p = pod_pet_for(a->engine);
    return a->work_alt && p && p->working_alt ? POD_SCENE_WORK_ALT : POD_SCENE_WORK;
}
pod_scene_t ph_room_scene(const pod_model_t *m, const pod_agent_t *a)
{
    pod_state_t st = pod_model_eff(m, a);
    if (st == POD_WORKING) return ph_work_scene(a);
    if (st == POD_ASKING) return POD_SCENE_ASK;
    if (st == POD_OFFLINE) return POD_SCENE_REST;
    const pod_unread_t *u = pod_model_unread_find(m, a->id);
    if (a->failed || (u && u->kind == POD_UNREAD_FAILED)) return POD_SCENE_REST;
    return ph_has_recap(a) || (u && u->kind == POD_UNREAD_FINISHED) ? POD_SCENE_RELAX : POD_SCENE_REST;
}

void ph_room_floor(ht_scene_t *s, int cx, int foot, int w)
{
    uint16_t shade = C(ph_mix(0x000000, PH_ROOM_BG, 12));
    int sw = w * 3 / 4;
    pod_grad_aa(s, cx - sw / 2, foot - 14, sw, 28, 14, shade, shade);
}

enum { NAME_CY = 46, NAME_MAX_W = 640 };

// A title centred on x = 360 (the room's name, Notices), cut with an ellipsis at NAME_MAX_W.
void ph_title(ht_scene_t *s, const char *t) { ph_title_ink(s, t, PH_ROOM_INK); }
void ph_title_ink(ht_scene_t *s, const char *t, unsigned rgb)
{
    char buf[sizeof((pod_agent_t *)0)->name + 4];
    snprintf(buf, sizeof buf, "%s", t);
    for (char *c = buf; *c; c++) if (*c == '\n' || *c == '\r' || *c == '\t') *c = ' ';
    const ht_pro_font_t *f = &ph_sb_26;
    if (ht_pro_width(f, buf) > NAME_MAX_W) {
        size_t len = strlen(buf);
        do {
            do len--; while (len > 0 && ((unsigned char)buf[len] & 0xC0) == 0x80);
            snprintf(buf + len, sizeof buf - len, "\xe2\x80\xa6");
        } while (len > 0 && ht_pro_width(f, buf) > NAME_MAX_W);
    }
    int w = ht_pro_width(f, buf);
    ph_text(s, (POD_W - w) / 2, NAME_CY, w + 2, f, rgb, buf);
}

void ph_room_chrome(pod_out_frame_t *f, const pod_nav_t *nav, const pod_model_t *m, const pod_agent_t *a)
{
    (void)nav; (void)m;
    f->scene->background = C(PH_ROOM_BG);
    ph_title(f->scene, a->name);
}
