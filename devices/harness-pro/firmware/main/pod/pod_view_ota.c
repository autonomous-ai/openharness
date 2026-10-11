// The software-update screen (owner, 2026-10-11, mockup pro-ota U1): its own screen, status bar "Updating", no
// transport (nothing to tap while the image is written). The mark (the transport's blue gradient, a white ">_"), the title, "<old> -> <new>", a bar
// on the transport's blue gradient and "%" left of "Keep the cable in"; then Restarting: a spinner-like ring,
// "Restarting...", "<new> is installed". The font has no arrow and no U+2026 (its glyphs stop at U+00FF: a "…" would draw "?"), so Restarting keeps "..." and the
// arrow is drawn like the other glyph-free icons. Run counts are constant per screen (the bar's fill keeps its
// slot at 0 %).
#include "pod_view.h"
#include "pro_canvas.h"

#include <stdio.h>
#include <string.h>

#define C(rgb) ht_rgb(rgb)

static void centered(ht_scene_t *s, int y, const ht_pro_font_t *font, uint16_t ink, const char *text)
{
    int w = ht_pro_width(font, text);
    if (w > POD_W - 40) w = POD_W - 40;
    ht_pro_text(s, (POD_W - w) / 2, y, w, font, ink, text);
}

// "<from> -> <to>" on one centred line, the arrow drawn: a 3 px shaft and a head, 30 px across.
static void versions(ht_scene_t *s, int y, const char *from, const char *to)
{
    enum { GAP = 12, ARROW = 30 };
    const ht_pro_font_t *f = &ht_pro_24;
    int wf = ht_pro_width(f, from), wt = ht_pro_width(f, to);
    int x = (POD_W - (wf + GAP + ARROW + GAP + wt)) / 2, mid = y + f->height / 2 - 1;
    ht_pro_text(s, x, y, wf, f, C(0x7b7d84), from);
    x += wf + GAP;
    ht_pro_rect(s, x, mid - 1, ARROW - 8, 3, 0, C(0x7b7d84));
    pod_play(s, x + ARROW - 16, mid - 8, 16, 16, 0, C(0x7b7d84));
    x += ARROW + GAP;
    ht_pro_text(s, x, y, wt, f, C(0x7b7d84), to);
}

void pod_view_ota(pod_out_frame_t *f, const char *from, const char *to, int pct, bool restarting)
{
    ht_scene_t *s = f->scene;
    f->hit_count = 0;
    f->unread = 0;
    f->bell_x = 0;
    pod_status(f, "Updating", false, 0);
    if (!from) from = "";
    if (!to) to = "";
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    const ht_pro_font_t *title = &ht_pro_32, *small = &ht_pro_24;
    enum { GAP = 20, MARK = 128, BAR_W = 480, BAR_H = 20 };
    const int icon = restarting ? 68 : MARK;
    const int below = restarting ? 0 : GAP + BAR_H + GAP + small->height;   // the bar and its % row
    const int h = icon + GAP + title->height + GAP + small->height + below;
    int y = POD_STATUS_H + (POD_H_BODY - h) / 2;
    if (restarting) {   // a ring with a quarter in blue, in the mark's place
        int cx = POD_W / 2, cy = y + icon / 2;
        pod_arc(s, cx * 16, cy * 16, 30 * 16, 8 * 16, 0, 180, C(0xdfe2e8));
        pod_arc(s, cx * 16, cy * 16, 30 * 16, 8 * 16, 90, 50, C(0x1f63d1));
    } else {
        // The mockup's .mark: 64 px at half size, radius 16, the transport button's gradient, a white bold ">_".
        const int mx = (POD_W - MARK) / 2;
        const int mw = ht_pro_width(&ht_pro_56, ">_");
        pod_grad(s, mx, y, MARK, MARK, 32, C(0x5ea2f2), C(0x1f63d1));
        ht_pro_text(s, mx + (MARK - mw) / 2, y + (MARK - ht_pro_56.height) / 2 - MARK / 16, mw, &ht_pro_56, C(0xffffff), ">_");
    }
    y += icon + GAP;
    centered(s, y, title, C(0x111111), restarting ? "Restarting..." : "Updating Harness Pro");
    y += title->height + GAP;
    if (restarting) {
        char line[64];
        snprintf(line, sizeof line, "%s is installed", to);
        centered(s, y, small, C(0x7b7d84), line);
        return;
    }
    versions(s, y, from, to);
    y += small->height + GAP;
    const int x0 = (POD_W - BAR_W) / 2;
    ht_pro_rect(s, x0, y, BAR_W, BAR_H, BAR_H / 2, C(0xe3e5ea));
    if (pct > 0) pod_grad(s, x0, y, BAR_W * pct / 100, BAR_H, BAR_H / 2, C(0x7db5f5), C(0x1f63d1));
    else pod_arc(s, x0 * 16, y * 16, 0, 0, 0, 0, 0);   // the fill's slot
    y += BAR_H + GAP;
    char p[8];
    snprintf(p, sizeof p, "%d%%", pct);
    ht_pro_text(s, x0, y, ht_pro_width(small, p), small, C(0x333333), p);
    const char *keep = "Keep the cable in";
    int w = ht_pro_width(small, keep);
    ht_pro_text(s, x0 + BAR_W - w, y, w, small, C(0x7b7d84), keep);
}
