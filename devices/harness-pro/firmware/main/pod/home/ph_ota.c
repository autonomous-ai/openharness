// Pets Update (owner, harness-pro-ui-review.html option B "Harness ring"): the device itself is updating, not an agent, so it wears the first screen's
// navy world (ph_overview.c wordmark): "Harness" on top, a progress ring with the percent inside, "Updating to <to>" and one line of status. The device
// is told the percent and whether it is restarting, nothing more, so the status reads the stage off those: writing below 100, checking at 100,
// restarting once restarting. The glue calls this instead of the stack while an update runs; it draws no hits.
#include <stdio.h>
#include <string.h>

#include "pod/home/ph.h"
#include "pod/pod_draw.h"
#include "pro_canvas.h"

#define C(rgb) ht_rgb(rgb)
enum { OTA_BG = 0x0E1B2C, OTA_INK = 0xF2F7FC, OTA_LIGHT = 0x9CC6FF, OTA_MUTED = 0x7F93AA, OTA_TRACK = 0x1B2A3D, OTA_FILL = 0x5F8FD6,
       TITLE_CY = 132, RING_CX = 360, RING_CY = 365, RING_R = 150, RING_W = 16, LINE1_CY = 590, LINE2_CY = 636, PCT_GAP = 4 };

static void centred(ht_scene_t *s, int cy, const ht_pro_font_t *f, unsigned rgb, const char *t)
{
    int w = ht_pro_width(f, t);
    if (w > POD_W - 48) w = POD_W - 48;
    ph_text(s, (POD_W - w) / 2, cy, w + 2, f, rgb, t);
}

void ph_view_ota(pod_out_frame_t *f, const char *from, const char *to, int pct, bool restarting)
{
    ht_scene_t *s = f->scene;
    (void)from;
    f->hit_count = 0;
    ht_pro_rect(s, 0, 0, POD_W, POD_W, 0, C(OTA_BG));
    if (!to) to = "";
    pct = restarting ? 100 : pct < 0 ? 0 : pct > 100 ? 100 : pct;
    centred(s, TITLE_CY, &ph_sb_48, OTA_INK, "Harness");
    // The ring: the full track, then the done part clockwise from 12 o'clock (pod_arc: 0 degrees is 3 o'clock, counter-clockwise).
    pod_arc(s, RING_CX * 16, RING_CY * 16, RING_R * 16, RING_W * 16, 90, 180, C(OTA_TRACK));
    const int span = pct * 360 / 100;
    if (span > 0) pod_arc(s, RING_CX * 16, RING_CY * 16, RING_R * 16, RING_W * 16, 90 - span / 2, span / 2, C(OTA_FILL));
    char p[8];   // the digits in the wordmark face, a smaller "%" after them, the pair centred in the ring
    snprintf(p, sizeof p, "%d", pct);
    const int dw = ht_pro_width(&ph_bd_84, p), sw = ht_pro_width(&ph_sb_48, "%"), x = RING_CX - (dw + PCT_GAP + sw) / 2;
    ph_text(s, x, RING_CY, dw + 2, &ph_bd_84, OTA_INK, p);
    ph_text(s, x + dw + PCT_GAP, RING_CY + 8, sw + 2, &ph_sb_48, OTA_INK, "%");
    char line[48];
    snprintf(line, sizeof line, "%s %.20s", restarting ? "Restarting into" : "Updating to", to);
    centred(s, LINE1_CY, &ph_sb_32, OTA_LIGHT, line);
    centred(s, LINE2_CY, &ph_rg_24, OTA_MUTED, restarting ? "Almost there" : pct >= 100 ? "Checking the new firmware \xc2\xb7 keep the cable in"
                                                                                    : "Writing the new firmware \xc2\xb7 keep the cable in");
}
