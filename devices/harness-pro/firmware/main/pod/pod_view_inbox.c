// The Inbox (the unread notifications as the Tab list's rows) and the notification banner (a card that drops under the
// status bar when a turn ends). Both read model->unread; the bell that opens the Inbox is in pod_chrome.c.
#include "pod_view_shared.h"

#include <stdio.h>
#include <string.h>

enum { ROWS_Y = POD_STATUS_H, ROW_H = 84, ROWS_MAX = (POD_W - POD_STATUS_H) / ROW_H };   // 7 rows, as the Tab list

#define C pod_c
static int imin(int a, int b) { return a < b ? a : b; }
static int imax(int a, int b) { return a > b ? a : b; }

void pod_fmt_age(char *out, size_t n, uint32_t secs)
{
    if (secs < 60) snprintf(out, n, "now");
    else if (secs < 3600) snprintf(out, n, "%um", (unsigned)(secs / 60));
    else if (secs < 86400) snprintf(out, n, "%uh", (unsigned)(secs / 3600));
    else snprintf(out, n, "%ud", (unsigned)(secs / 86400));
}
static uint32_t age_s(const pod_model_t *m, const pod_unread_t *u)
{
    int32_t d = (int32_t)(m->clock_ms - u->at_ms);
    return d > 0 ? (uint32_t)d / 1000 : 0;
}
// Name and engine: the roster's when it knows the agent, else what the notification carried.
static const char *name_of(const pod_model_t *m, const pod_unread_t *u)
{
    const pod_agent_t *a = pod_model_find(m, u->agent);
    return a && a->name[0] ? a->name : u->name[0] ? u->name : "Agent";
}
static const char *engine_of(const pod_model_t *m, const pod_unread_t *u)
{
    const pod_agent_t *a = pod_model_find(m, u->agent);
    return a ? a->engine : NULL;
}
static void one_line(char *out, size_t cap, const char *text)
{
    snprintf(out, cap, "%s", text);
    pod_utf8_trim(out);
    for (char *c = out; *c; c++) if (*c == '\n' || *c == '\r' || *c == '\t') *c = ' ';
}

static unsigned row_runs(const pod_model_t *m, const pod_unread_t *u)
{
    return 1u + 1u + pod_mark_runs(engine_of(m, u)) + 1u + 1u + 1u;   // rule, dot, chip, name, age, line
}

static void row(pod_out_frame_t *f, const pod_model_t *m, const pod_unread_t *u, int index, int y0)
{
    ht_scene_t *s = f->scene;
    char age[8], line[POD_UNREAD_TEXT];
    pod_fmt_age(age, sizeof age, age_s(m, u));
    ht_pro_rect(s, 24, y0 + ROW_H / 2 - 8, 16, 16, 8, C(0x1f63d1));   // unread
    pod_mark_chip_on(s, 66, y0 + 24, engine_of(m, u), C(0xffffff));
    int aw = ht_pro_width(&ht_pro_24, age), right = 698, room = right - 118 - aw - 16;
    ht_pro_text(s, right - aw, y0 + 30, aw, &ht_pro_24, C(0x7b7d84), age);
    ht_pro_text(s, 118, y0 + 8, room, &ht_pro_32, C(0x111111), name_of(m, u));
    one_line(line, sizeof line, u->text);
    ht_pro_text(s, 118, y0 + 46, room, &ht_pro_24, C(0x7b7d84), line);
    ht_pro_rect(s, 0, y0 + ROW_H - 1, POD_W, 1, 0, C(0xe5e6ea));
    pod_hit_add_id(f, 0, y0, POD_W, ROW_H, POD_A_OPEN_NOTIF, index, u->agent);
}

void pod_view_inbox(pod_out_frame_t *f, const pod_nav_t *nav, const pod_model_t *m, uint32_t now_ms)
{
    (void)now_ms;
    ht_scene_t *s = f->scene;
    const pod_frame_t *fr = &nav->stack[nav->depth - 1];
    int n = m->unread_count;
    pod_status(f, pod_view_title(nav, m), true, 0);
    if (n == 0) {
        const char *msg = "No notifications";
        int mw = ht_pro_width(&ht_pro_32, msg);
        ht_pro_text(s, (POD_W - mw) / 2, POD_STATUS_H + (POD_W - POD_STATUS_H - ht_pro_32.height) / 2, mw, &ht_pro_32, C(0x7b7d84), msg);
        return;
    }
    int first = imax(0, imin(fr->scroll, n - ROWS_MAX));
    int shown = imin(ROWS_MAX, n - first);
    int budget = HT_RUNS - s->count - 4 - pod_spare_runs(f);
    for (; shown > 0; shown--) {
        unsigned runs = 0;
        for (int i = 0; i < shown; i++) runs += row_runs(m, &m->unread[first + i]);
        if ((int)runs <= budget) break;
    }
    for (int i = 0; i < shown; i++) row(f, m, &m->unread[first + i], first + i, ROWS_Y + i * ROW_H);
}

int pod_inbox_pitch(void) { return ROW_H; }
int pod_inbox_max_row(const pod_model_t *m) { return imax(0, m->unread_count - ROWS_MAX); }

// ---- the banner ----------------------------------------------------------------------------------------------

// "2m 14s", "45s", "1h 02m".
static void fmt_elapsed(char *out, size_t n, int32_t secs)
{
    if (secs < 60) snprintf(out, n, "%ds", (int)secs);
    else if (secs < 3600) snprintf(out, n, "%dm %02ds", (int)(secs / 60), (int)(secs % 60));
    else snprintf(out, n, "%dh %02dm", (int)(secs / 3600), (int)(secs % 3600 / 60));
}

int pod_banner(pod_out_frame_t *f, const pod_model_t *m, const pod_unread_t *u, uint32_t now_ms)
{
    (void)now_ms;
    ht_scene_t *s = f->scene;
    const int x = POD_BANNER_X, y = POD_BANNER_Y, w = POD_BANNER_W, tx = x + 20 + 36 + 14, right = x + w - 20;
    const int h32 = ht_pro_32.height, h24 = ht_pro_24.height;
    char rows[2][POD_ROW_MAX], line[POD_UNREAD_TEXT], age[8], done[32], el[16];
    one_line(line, sizeof line, u->text);
    int n = pod_wrap(line, &ht_pro_24, right - tx, 2, rows);
    int h = 14 + h32 + 2 + n * h24 + 6 + h24 + 14;
    ht_pro_rect(s, x, y, w, h, 28, C(0xe5e6ea));              // a 1 px edge
    ht_pro_rect(s, x + 1, y + 1, w - 2, h - 2, 27, C(0xffffff));
    pod_mark_chip_on(s, x + 20, y + 16, engine_of(m, u), C(0xffffff));
    pod_fmt_age(age, sizeof age, age_s(m, u));
    int aw = ht_pro_width(&ht_pro_24, age);
    ht_pro_text(s, right - aw, y + 14 + 6, aw, &ht_pro_24, C(0x7b7d84), age);
    ht_pro_text(s, tx, y + 14, right - tx - aw - 12, &ht_pro_32, C(0x111111), name_of(m, u));
    int ry = y + 14 + h32 + 2;
    for (int i = 0; i < n; i++) ht_pro_text(s, tx, ry + i * h24, right - tx, &ht_pro_24, C(0x333333), rows[i]);
    int dy = ry + n * h24 + 6;
    pod_tick(s, tx, dy + 2, C(0x34c759));
    if (u->elapsed_s >= 0) { fmt_elapsed(el, sizeof el, u->elapsed_s); snprintf(done, sizeof done, "Done \xc2\xb7 %s", el); }
    else snprintf(done, sizeof done, "Done");
    ht_pro_text(s, tx + 30, dy, right - tx - 30, &ht_pro_24, C(0x34c759), done);
    pod_hit_add_id(f, x, y, w, h, POD_A_BANNER, 0, u->agent);
    return h;
}
