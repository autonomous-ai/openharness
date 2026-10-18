// What Pets' screens, the app glue and the tests share: the hit list, an agent's elapsed clock, the word wrap and the age text.
#include "pod/pod_view.h"
#include "pod/pod_view_shared.h"
#include "pro_canvas.h"

#include <stdio.h>
#include <string.h>

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

uint32_t pod_agent_secs(const pod_agent_t *a, uint32_t now_ms)
{
    if (!a) return 0;
    if (a->state == POD_WORKING && (int32_t)(now_ms - a->event_ms) >= 0) return a->elapsed_s + (now_ms - a->event_ms) / 1000;
    return a->elapsed_s;
}
uint32_t pod_agent_timer_ms(const pod_agent_t *a, uint32_t now_ms)
{
    if (!a || a->state != POD_WORKING) return UINT32_MAX;   // only a working agent's clock runs; a finished turn's length is fixed
    uint32_t into = (int32_t)(now_ms - a->event_ms) >= 0 ? (now_ms - a->event_ms) % 1000 : 0;   // how far into its current second
    return pod_elapsed_next_ms(pod_agent_secs(a, now_ms)) - into;
}

const pod_agent_t *pod_view_agent_of(const pod_nav_t *nav, const pod_model_t *m)
{
    if (!nav->depth) return NULL;
    return pod_model_find(m, nav->stack[nav->depth - 1].agent);
}

void pod_fmt_age(char *out, size_t n, uint32_t secs)
{
    if (secs < 60) snprintf(out, n, "now");
    else if (secs < 3600) snprintf(out, n, "%um", (unsigned)(secs / 60));
    else if (secs < 86400) snprintf(out, n, "%uh", (unsigned)(secs / 3600));
    else snprintf(out, n, "%ud", (unsigned)(secs / 86400));
}

// A word wider than the row stays whole (the row buffer's limit drops the text).
int pod_wrap(const char *text, const ht_pro_font_t *font, int width, int max_rows, char rows[][POD_ROW_MAX])
{
    int n = 0;
    const char *p = text ? text : "";
    while (n < max_rows) {
        while (*p == ' ' || *p == '\n') p++;
        if (!*p) break;
        char *row = rows[n];
        if (n == max_rows - 1) {   // the last row takes the rest; ht_pro_text clips it with an ellipsis
            size_t len = strlen(p);
            if (len >= POD_ROW_MAX) { len = POD_ROW_MAX - 1; while (len && ((unsigned char)p[len] & 0xc0) == 0x80) len--; }
            memcpy(row, p, len);
            row[len] = 0;
            for (char *q = row; *q; q++) if (*q == '\n') *q = ' ';
            n++;
            break;
        }
        size_t used = 0;
        row[0] = 0;
        for (;;) {
            const char *w = p;
            while (*w && *w != ' ' && *w != '\n') w++;
            size_t wl = (size_t)(w - p);
            if (!wl) break;
            char cand[POD_ROW_MAX];
            if (used + (used ? 1 : 0) + wl >= POD_ROW_MAX) break;
            memcpy(cand, row, used);
            if (used) cand[used] = ' ';
            memcpy(cand + used + (used ? 1 : 0), p, wl);
            cand[used + (used ? 1 : 0) + wl] = 0;
            if (used && ht_pro_width(font, cand) > width) break;
            memcpy(row, cand, used + (used ? 1 : 0) + wl + 1);
            used += (used ? 1 : 0) + wl;
            p = w;
            while (*p == ' ') p++;
            if (*p == '\n') { p++; break; }
            if (!*p) break;
        }
        if (!used) break;
        n++;
    }
    return n;
}
