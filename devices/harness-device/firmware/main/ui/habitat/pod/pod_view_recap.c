// The Recap screen: a small cover, the name and status, then the whole recap as plain wrapped text, scrolled by a
// vertical drag when it is longer than the space.
#include "pod_view_shared.h"

#include <stdio.h>
#include <string.h>

#include "pod/pod_mem.h"

#define C pod_c

enum { COVER = 132, COVER_X = 46, COVER_Y = 76, TEXT_X = 201, BODY_X = 40, BODY_W = 640, ROWS_ALL = 64, NAME_PITCH = 40, RECAP_WORDS = 50 };

static EXT_RAM_BSS_ATTR char pod_recap_rows[ROWS_ALL][POD_ROW_MAX];
// The recap's lines (stored NUL-separated) joined with spaces and wrapped. In PSRAM: the render task is the only
// writer and the touch task reads the row count, both under display_lock.
// The body follows the head down (owner, 2026-10-10: with the engine line gone it stayed put and left a hole): 22 px
// under the head's last ink, the status line or the pet's cover, whichever is lower. The head's lines are laid out as
// in pod_view_recap() below: the name, the tab and the machine, then the status (the LCD pill while working).
static int name_rows_of(const pod_agent_t *a)
{
    char rows[2][POD_ROW_MAX];
    return pod_wrap(a->name, &ht_pro_32, 680 - TEXT_X, 2, rows);
}
static int body_y(const pod_agent_t *a)
{
    const int name_n = name_rows_of(a);
    const int name_last_y = name_n > 1 ? 70 + NAME_PITCH : 104 - ht_pro_32.height / 2;
    const int who_y = pod_under_32(name_last_y), rows = 1 + (a->machine[0] ? 1 : 0);
    const int wy = who_y + rows * POD_WHO_PITCH;
    const int head_bottom = a->state == POD_WORKING ? wy + 6 + POD_LCD_H : wy + 6 + 17;
    const int cap_top = (head_bottom > COVER_Y + COVER ? head_bottom : COVER_Y + COVER) + 22;
    return cap_top - 9;   // a 32 px cell's capitals start 9 px in
}
static int body_rows(const pod_agent_t *a) { return (POD_TRANSPORT_Y - 8 - body_y(a)) / ht_pro_32.height; }
static int layout(const pod_agent_t *a)
{
    static EXT_RAM_BSS_ATTR char joined[POD_RECAP_BYTES + POD_RECAP_LINES + 4];
    size_t n = 0;
    for (int i = 0; i < a->recap_lines; i++) {
        size_t len = strlen(a->recap + a->line_at[i]);
        if (n + len + 2 > sizeof joined) break;
        if (n) joined[n++] = ' ';
        memcpy(joined + n, a->recap + a->line_at[i], len);
        n += len;
    }
    joined[n] = 0;
    // At most RECAP_WORDS words (split on ASCII whitespace, which never occurs inside a UTF-8 sequence); more ends with "...".
    int words = 0;
    for (size_t i = 0; i < n;) {
        while (i < n && (joined[i] == ' ' || joined[i] == '\n' || joined[i] == '\t' || joined[i] == '\r')) i++;
        if (i >= n) break;
        if (++words > RECAP_WORDS) {
            while (i && (joined[i - 1] == ' ' || joined[i - 1] == '\n' || joined[i - 1] == '\t' || joined[i - 1] == '\r')) i--;
            memcpy(joined + i, "...", 4);
            break;
        }
        while (i < n && joined[i] != ' ' && joined[i] != '\n' && joined[i] != '\t' && joined[i] != '\r') i++;
    }
    return pod_wrap(joined, &ht_pro_32, BODY_W, ROWS_ALL, pod_recap_rows);
}
static bool shows_recap(const pod_model_t *m, const pod_agent_t *a)
{
    pod_state_t st = pod_model_eff(m, a);
    return st != POD_WORKING && st != POD_ASKING && a->recap_lines;
}
// A row followed by "..." (the font has no "…"), trimmed at a word or codepoint so the whole of it still fits the width.
static void with_dots(char out[POD_ROW_MAX], const char *row, int width)
{
    snprintf(out, POD_ROW_MAX, "%s", row);
    size_t n = strlen(out);
    while (n && (out[n - 1] == ' ' || out[n - 1] == '.' || out[n - 1] == ',')) out[--n] = 0;
    for (;;) {
        char t[POD_ROW_MAX + 4];
        snprintf(t, sizeof t, "%s...", out);
        if (n == 0 || ht_pro_width(&ht_pro_32, t) <= width) { snprintf(out, POD_ROW_MAX, "%s", t); return; }
        size_t w = n;
        while (w > 0 && out[w - 1] != ' ') w--;
        if (w > 0) n = w - 1;
        else { n--; while (n > 0 && ((unsigned char)out[n] & 0xC0) == 0x80) n--; }
        out[n] = 0;
        while (n && out[n - 1] == ' ') out[--n] = 0;
    }
}
int pod_recap_max_row(const pod_nav_t *nav, const pod_model_t *m)
{
    const pod_agent_t *a = pod_view_agent_of(nav, m);
    if (!a || !shows_recap(m, a)) return 0;
    int over = layout(a) - body_rows(a);
    return over > 0 ? over : 0;
}


void pod_view_recap(pod_out_frame_t *f, const pod_nav_t *nav, const pod_model_t *m, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    pod_status(f, pod_view_title(nav, m), true, 0);
    const pod_agent_t *a = pod_view_agent_of(nav, m);
    if (!a) { pod_transport(f, false); return; }
    const pod_frame_t *fr = &nav->stack[nav->depth - 1];
    pod_state_t st = pod_model_eff(m, a);
    bool working = st == POD_WORKING;
    pod_pet_draw(s, COVER_X, COVER_Y, COVER, a->engine, working ? POD_SCENE_WORK : POD_SCENE_REST, now_ms, 0);

    // The name in 32, wrapped onto a second line before it is cut; the lines under it move down for a second line.
    char name_rows[2][POD_ROW_MAX];
    int name_n = pod_wrap(a->name, &ht_pro_32, 680 - TEXT_X, 2, name_rows);
    for (int i = 0; i < name_n; i++)
        ht_pro_text(s, TEXT_X, (name_n > 1 ? 70 : 104 - ht_pro_32.height / 2) + i * NAME_PITCH, 680 - TEXT_X, &ht_pro_32,
                    C(0x111111), name_rows[i]);
    const int name_last_y = (name_n > 1 ? 70 : 104 - ht_pro_32.height / 2) + (name_n > 1 ? NAME_PITCH : 0);
    const int who_y = pod_under_32(name_last_y);
    int who_rows = pod_who_line(s, TEXT_X, who_y, 680 - TEXT_X, nav, m, a);
    int wy = who_y + who_rows * POD_WHO_PITCH, wx = TEXT_X;
    char t[12], when[32];
    pod_fmt_time(t, sizeof t, pod_agent_secs(a, now_ms));
    if (st == POD_DONE) {
        pod_tick(s, wx, wy + 2, C(0x34c759));
        wx += 30;
        snprintf(when, sizeof when, "Done \xc2\xb7 %s", t);
    } else if (working) {
        pod_lcd_pill(s, TEXT_X, wy + 6, 680 - TEXT_X, a, now_ms);
        when[0] = 0;
    } else {
        snprintf(when, sizeof when, "Idle");
    }
    if (when[0]) ht_pro_text(s, wx, wy, 680 - wx, &ht_pro_24, C(0x7b7d84), when);

    if (!shows_recap(m, a)) {
        const char *msg = st == POD_IDLE || st == POD_DONE ? "No recap yet." : "The recap comes when this turn ends.";
        ht_pro_text(s, BODY_X, body_y(a), BODY_W, &ht_pro_32, C(0x111111), msg);
        pod_transport(f, false);
        return;
    }

    const int pitch = ht_pro_32.height, visible = body_rows(a), total = layout(a);
    int first = fr->scroll < 0 ? 0 : fr->scroll, max = total > visible ? total - visible : 0;
    if (first > max) first = max;
    for (int r = 0; r < visible && first + r < total; r++) {
        const char *row = pod_recap_rows[first + r];
        // The last row on screen ends with "..." while there is more below it; the text's own last row, when the
        // text itself was cut.
        bool more_below = r == visible - 1 && first + r + 1 < total;
        bool cut_end = first + r == total - 1 && a->recap_cut;
        char dotted[POD_ROW_MAX];
        if (more_below || cut_end) { with_dots(dotted, row, BODY_W); row = dotted; }
        ht_pro_text(s, BODY_X, body_y(a) + r * pitch, BODY_W, &ht_pro_32, C(0x111111), row);
    }
    pod_transport(f, false);
}
