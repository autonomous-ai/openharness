// The Agent screen: for an agent that is working, asking, or idle with nothing to recap. The pet as album art, the name,
// "Tab . Machine" and a state chip, then by state the live bar and the activity, or the question box.
// Also the helpers this screen, Recap and Talking share (pod_view_shared.h).
#include "pod_view_shared.h"

#include <stdio.h>
#include <string.h>

static int imin(int a, int b) { return a < b ? a : b; }
static int imax(int a, int b) { return a > b ? a : b; }
#define C pod_c

const pod_agent_t *pod_view_agent_of(const pod_nav_t *nav, const pod_model_t *m)
{
    if (!nav->depth) return NULL;
    return pod_model_find(m, nav->stack[nav->depth - 1].agent);
}

// ---- text helpers ---------------------------------------------------------------------------------------

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

void pod_text_center(ht_scene_t *s, int cx, int y, int width, const ht_pro_font_t *font, uint16_t ink, const char *text)
{
    if (!text || !*text) return;
    int w = imin(ht_pro_width(font, text), width);
    ht_pro_text(s, cx - w / 2, y, w, font, ink, text);
}

int pod_who_line(ht_scene_t *s, int x, int y, int width, const pod_nav_t *nav, const pod_model_t *m, const pod_agent_t *a)
{
    const pod_frame_t *fr = &nav->stack[nav->depth - 1];
    const pod_tab_t *tab = NULL;
    if (fr->tab >= 0 && fr->tab < m->tab_count && pod_agent_pane(m, a, &m->tabs[fr->tab])) tab = &m->tabs[fr->tab];
    if (!tab) tab = pod_tab_of(m, a);
    // The tab alone on a line in blue (ht_pro_text ends it with an ellipsis only if it does not fit the width), then the
    // machine alone under it in grey; each omitted when unknown. No engine (owner, 2026-10-10: the pet or the logo
    // already says it) and no pane number.
    int rows = 0;
    if (tab && tab->name[0]) {
        ht_pro_text(s, x, y + rows * POD_WHO_PITCH, imin(ht_pro_width(&ht_pro_24, tab->name), width), &ht_pro_24, C(0x1f63d1), tab->name);
        rows++;
    }
    if (a->machine[0]) {
        char mach[CABLE_NAME_MAX];
        snprintf(mach, sizeof mach, "%s", a->machine);
        pod_utf8_trim(mach);
        ht_pro_text(s, x, y + rows * POD_WHO_PITCH, imin(ht_pro_width(&ht_pro_24, mach), width), &ht_pro_24, C(0x7b7d84), mach);
        rows++;
    }
    return rows;
}

// The round dial's working verb (ui_screens.c GERUNDS, busy_compose): a gerund that rotates every 6 s of the turn's
// elapsed time. The cable carries no verb (turn.activity's `action` is the activity text), so the dial derives it too.
const char *pod_working_verb(uint32_t secs)
{
    static const char *const gerunds[] = {
        "Working", "Brewing", "Cooking", "Churning", "Frosting", "Simmering", "Tinkering",
        "Conjuring", "Composing", "Percolating", "Wrangling", "Hatching", "Concocting", "Puttering",
    };
    return gerunds[(secs / 6) % (sizeof gerunds / sizeof gerunds[0])];
}

// The round dial's rule (main's focus.c status_verb): the verb is the engine's own activity word, its trailing "..." or
// "\u2026" dropped, and only "Working" or nothing becomes the rotating gerund (owner, 2026-10-10: Claude's terminal said
// "Infusing" while the pill said a made-up "Churning"). Pod adds one thing: a word that does not fit the pill's
// `room` px stays in the body and the pill keeps the gerund. Copies the word into out; false otherwise.
bool pod_activity_verb(const char *text, char *out, size_t cap, int room)
{
    if (!text) return false;
    while (*text == ' ' || *text == '\t' || *text == '\r' || *text == '\n') text++;
    size_t n = strnlen(text, cap);
    if (n >= cap) return false;
    memcpy(out, text, n);
    out[n] = 0;
    while (n && (out[n - 1] == ' ' || out[n - 1] == '\t' || out[n - 1] == '\r' || out[n - 1] == '\n')) out[--n] = 0;
    if (n >= 3 && (!memcmp(out + n - 3, "...", 3) || !memcmp(out + n - 3, "\xe2\x80\xa6", 3))) { n -= 3; out[n] = 0; }
    while (n && out[n - 1] == ' ') out[--n] = 0;
    if (!n || !strcmp(out, "Working") || memchr(out, '\n', n)) return false;
    char shown[POD_VERB_MAX + 4];
    snprintf(shown, sizeof shown, "%s...", out);
    return ht_pro_width(&ht_pro_24, shown) <= room;
}

void pod_lcd_pill(ht_scene_t *s, int x, int y, int width, const pod_agent_t *a, uint32_t now_ms)
{
    const uint32_t secs = pod_agent_secs(a, now_ms);
    // The LCD (owner's S5, 2026-10-10): content only, no shape. The Pod screen is cleared to the canvas (0xeeede5), not
    // white, so the old fill showed as a white patch; the rim went too. The three bars, the verb and the time sit
    // where they did inside the POD_LCD_H box, which still reserves the space.
    pod_eq(s, x + 16, y + (POD_LCD_H - 20) / 2, C(0x2a9a57), now_ms);
    char t[12], verb[40];
    pod_fmt_time(t, sizeof t, secs);
    char own[POD_VERB_MAX];
    const int room = pod_lcd_verb_room(width);
    snprintf(verb, sizeof verb, "%s\xe2\x80\xa6", pod_activity_verb(a->verb, own, sizeof own, room) ? own : pod_working_verb(secs));
    const int ty = y + (POD_LCD_H - ht_pro_24.height) / 2, tw = ht_pro_width(&ht_pro_24, t);
    const int vx = x + 16 + 33, vw = imin(ht_pro_width(&ht_pro_24, verb), width - 16 - tw - 12 - (vx - x));
    if (vw > 0) ht_pro_text(s, vx, ty, vw, &ht_pro_24, C(0x26292b), verb);
    ht_pro_text(s, x + width - 16 - tw, ty, tw, &ht_pro_24, C(0x1f9d4c), t);
}

// ---- the screen -----------------------------------------------------------------------------------------

// Option A, "iPod classic Now Playing": the pet as album art on the left, the name and state chip beside it, then the
// live bar and the activity text across the full width.
enum { ART_X = 26, ART_Y = 84, ART = 196, ART_PET = 180, HEAD_X = 248, HEAD_R = 694, BAR_X = 28, BAR_W = 664,
       BODY_Y = ART_Y + ART + 14, ACT_ROWS = 8, ACT_PITCH = 34 };

// The scene the agent shows now: SEND once after a send, else by state. Idle and done rest (REST, not the relaxing
// face: owner, 2026-10-10).
static pod_scene_t scene_for(const pod_nav_t *nav, const pod_agent_t *a, pod_state_t st, uint32_t now_ms)
{
    if (!strcmp(nav->sent_agent, a->id) && pod_pet_has(a->engine, POD_SCENE_SEND)) {
        const ht_pet_scene_t *sc = pod_pet_for(a->engine)->sending_scene;
        if ((int32_t)(now_ms - nav->send_started_ms) >= 0 && now_ms - nav->send_started_ms < (uint32_t)sc->steps * sc->step_ms)
            return POD_SCENE_SEND;
    }
    return st == POD_WORKING ? POD_SCENE_WORK : st == POD_ASKING ? POD_SCENE_ASK : POD_SCENE_REST;
}

// End a row with "…" that fits the width (drops whole codepoints to make room). For text the model had to cut.
static void ellipsize(char row[POD_ROW_MAX], int width)
{
    static const char dots[] = "\xe2\x80\xa6";
    size_t n = strlen(row);
    if (n >= 3 && !memcmp(row + n - 3, dots, 3)) return;
    for (;;) {
        if (n + sizeof dots <= POD_ROW_MAX) {
            memcpy(row + n, dots, sizeof dots);
            if (!n || ht_pro_width(&ht_pro_24, row) <= width) return;
        }
        if (!n) return;
        do n--; while (n && ((unsigned char)row[n] & 0xc0) == 0x80);
        row[n] = 0;
    }
}


// The chip: a pill with a dot and the state text. Always 3 runs.
static void state_chip(ht_scene_t *s, int x, int y, uint16_t fill, uint16_t ink, const char *label)
{
    const int h = 38;
    int tw = ht_pro_width(&ht_pro_24, label), w = 16 + 12 + 8 + tw + 16;
    ht_pro_rect(s, x, y, w, h, h / 2, fill);
    ht_pro_rect(s, x + 16, y + h / 2 - 6, 12, 12, 6, ink);
    ht_pro_text(s, x + 36, y + (h - ht_pro_24.height) / 2, tw, &ht_pro_24, ink, label);
}

void pod_view_agent(pod_out_frame_t *f, const pod_nav_t *nav, const pod_model_t *m, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    pod_status(f, "Recap", true, 0);   // the tab name is in the head; this screen is the entry to the recap
    const pod_agent_t *a = pod_view_agent_of(nav, m);
    if (a) {
        pod_state_t st = pod_model_eff(m, a);
        bool ask = st == POD_ASKING, working = st == POD_WORKING;
        // The art: pet-less engines keep their own cover at this size; a pet stands on the glass itself (owner,
        // 2026-10-10: the mockup's pale lavender square read as a white patch behind the pet on the device).
        if (pod_pet_for(a->engine)) {
            pod_pet_draw(s, ART_X + (ART - ART_PET) / 2, ART_Y + (ART - ART_PET) / 2, ART_PET, a->engine,
                         scene_for(nav, a, st, now_ms), now_ms, nav->send_started_ms);
        } else {
            pod_pet_draw(s, ART_X, ART_Y, ART, a->engine, scene_for(nav, a, st, now_ms), now_ms, nav->send_started_ms);
        }
        // The name, up to two lines, then "<Tab> . <Machine>", then the chip.
        char name_rows[2][POD_ROW_MAX];
        int nn = pod_wrap(a->name, &ht_pro_32, HEAD_R - HEAD_X, 2, name_rows);
        const int pitch = ht_pro_32.height + 4;
        for (int i = 0; i < nn; i++)
            ht_pro_text(s, HEAD_X, 92 + i * pitch, HEAD_R - HEAD_X, &ht_pro_32, C(0x111111), name_rows[i]);
        int down = nn > 1 ? pitch : 0;
        const int who_y = pod_under_32(92 + down);
        int who_rows = pod_who_line(s, HEAD_X, who_y, HEAD_R - HEAD_X, nav, m, a);
        // The status goes one gap under the last line's baseline (6 + 17 into its cell): the LCD pill when working,
        // else a small chip. The engine is its own line above the tab, not after the chip.
        const int status_y = who_y + (who_rows ? (who_rows - 1) * POD_WHO_PITCH + 6 + 17 : -POD_LINE_GAP) + POD_LINE_GAP;
        const int chip_y = status_y - 2;
        // The bar and body sit at 304 / 327 unless the head (a two line name) reaches them: then they move down.
        const int head_end = status_y + (working ? POD_LCD_H : 38);
        const int shift = imax(0, head_end + 8 - 304);
        if (working) {
            pod_lcd_pill(s, HEAD_X, status_y, HEAD_R - HEAD_X, a, now_ms);
        } else if (ask) {
            state_chip(s, HEAD_X, chip_y, C(0xfff1dc), C(0xb46a00), "Needs you");
        } else if (st == POD_OFFLINE) {
            state_chip(s, HEAD_X, chip_y, C(0xeceeec), C(0xa0a4a0), "Offline");
        } else {
            state_chip(s, HEAD_X, chip_y, C(0xeceeec), C(0x7b7d84), st == POD_DONE ? "Done" : "Idle");
        }

        if (ask) {
            const int h32 = ht_pro_32.height, h24 = ht_pro_24.height;
            char rows[3][POD_ROW_MAX];
            int n = pod_wrap(a->question, &ht_pro_32, BAR_W - 36, 3, rows);
            int top = 306 + shift, box_h = 16 + n * h32 + 8 + h24 + 16;
            ht_pro_rect(s, BAR_X, top, BAR_W, box_h, 14, C(0xfff1dc));
            for (int i = 0; i < n; i++)
                ht_pro_text(s, BAR_X + 18, top + 16 + i * h32, BAR_W - 36, &ht_pro_32, C(0x111111), rows[i]);
            int ay = top + 16 + n * h32 + 8, aw = ht_pro_width(&ht_pro_24, "Answer in the Harness app");
            ht_pro_rect(s, BAR_X + 18, ay + h24 / 2 - 7, 14, 14, 7, C(0xff9f0a));
            ht_pro_text(s, BAR_X + 40, ay, aw, &ht_pro_24, C(0xb46a00), "Answer in the Harness app");
        } else if (working) {
            // Only a working agent has a body: its activity, right under the head (no live bar: the LCD pill already
            // plays, owner 2026-10-10). An idle or done one has nothing under the head.
            char rows[ACT_ROWS][POD_ROW_MAX];
            // Rows between the head and the transport; the previous steps (at most two lines reserved) share them.
            const int top = BODY_Y + shift, avail = imin(ACT_ROWS, (POD_TRANSPORT_Y - 6 - top) / ACT_PITCH);
            const int reserve = imin(a->step_count, 2);
            // The footer's word (a->verb) is the pill's; the body is always the progress sentence.
            int n = pod_wrap(a->activity, &ht_pro_24, BAR_W, avail - reserve, rows);
            if (a->activity_cut && a->activity[0] && n > 0) ellipsize(rows[n - 1], BAR_W);
            for (int i = 0; i < n; i++)
                ht_pro_text(s, BAR_X, top + i * ACT_PITCH, BAR_W, &ht_pro_24, C(0x111111), rows[i]);
            // What the agent did before, newest first, one grey line each (ht_pro_text ends a long one with an ellipsis):
            // the tools it started (`turn.activity` `step`) and the sentences it wrote, in the order they came.
            for (int i = 0; i < a->step_count && n + i < avail; i++) {
                const char *step = a->steps[i];
                ht_pro_text(s, BAR_X, top + (n + i) * ACT_PITCH, imin(ht_pro_width(&ht_pro_24, step), BAR_W), &ht_pro_24, C(0x7b7d84), step);
            }
        }
    }
    pod_transport(f, false);
}
