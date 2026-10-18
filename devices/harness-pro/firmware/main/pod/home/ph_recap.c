// Pets Recap (mockup "the pet signs it", group centred): a finished (or failed) agent goes straight to its recap on a navy ground, no title. The
// recap is in a speech bubble (x 60, 600 wide, only as tall as its text: 28 px above and below, 34 at the sides, rows 46 px apart, at most 8)
// wrapped to fit, the last visible row lighter and ending with an ellipsis when the text is longer. Under it a tail (a 36 px square turned 45
// degrees, 20 px inside the bubble, centred at x 126), then the "who" row: the agent's pet (RELAX, REST when failed) in a 150 px box at x 16,
// its name (bold) to the right, centred on the pet. The whole group is centred vertically (at least 40 px clear).
// No hit, no scroll of its own: a vertical drag scrolls the host's terminal pane (pod_glue's scroll sink).
#include <stdio.h>
#include <string.h>

#include "pod/home/ph.h"
#include "pod/pod_draw.h"
#include "pod/pod_mem.h"
#include "pod/pod_pet.h"
#include "pod/pod_view_shared.h"
#include "pro_canvas.h"

#define C(rgb) ht_rgb(rgb)
enum { BG = PH_ROOM_BG, BX = 60, BW = 600, RAD = 34, PAD_X = 34, PAD_Y = 28, TEXT_W = BW - 2 * PAD_X, PITCH = 46, ROWS_VIS = 8, ROWS_MAX = 12,
       TAIL_CX = BX + 48 + 18, TAIL_OVER = 20, TAIL_HALF = 24, TAIL_DROP = 23,   // the diamond's half-diagonal 25.5, 2 px inside the edge
       ROW_GAP = 18,                        // bubble bottom to the who row: the 16 px the tail's box pokes + 2
       ROW_H = 122, PET_X = 16, PET_SIDE = 150, PET_UP = 10, NAME_X = 160, NAME_MAX_X = 660, MARGIN_MIN = 40 };
static const ht_pro_font_t *const FONT = &ph_rg_36;

// The recap as one string: its sentences joined by spaces (all of them), cut mid-thought with "..." when the source was. With no recap
// the story is the unread entry's text, else a line of its own.
static void story_text(char *out, size_t n, const pod_agent_t *a, const pod_unread_t *u)
{
    size_t pos = 0;
    out[0] = 0;
    for (int i = 0; i < a->recap_lines && pos + 1 < n; i++) {
        const char *l = a->recap + a->line_at[i];
        if (!*l) continue;
        int k = snprintf(out + pos, n - pos, "%s%s", pos ? " " : "", l);
        if (k < 0) break;
        pos += (size_t)k < n - pos ? (size_t)k : n - pos - 1;
    }
    if (pos && a->recap_cut && pos + 4 < n) { memcpy(out + pos, "...", 4); pos += 3; }
    if (!pos && u && u->text[0]) { snprintf(out, n, "%s", u->text); pos = strlen(out); }   // no recap lines: the entry's own text, while it is still unread
    if (!pos) snprintf(out, n, "%s", a->failed ? "Something went wrong." : "All done.");
    for (char *c = out; *c; c++) if (*c == '\n' || *c == '\r' || *c == '\t') *c = ' ';
}

// Word wrap to TEXT_W: each row's start offset and byte length (a row is under HT_TEXT_BYTES). Returns the row count (at most `limit`).
static int wrap_story(const char *t, int limit, uint16_t start[ROWS_MAX], uint8_t len[ROWS_MAX])
{
    char buf[HT_TEXT_BYTES];
    int n = 0;
    size_t pos = 0, total = strlen(t);
    while (n < limit && n < ROWS_MAX) {
        while (t[pos] == ' ') pos++;
        if (pos >= total) break;
        size_t fit = pos, q = pos;
        for (;;) {   // grow the row a word at a time
            while (t[q] && t[q] != ' ') q++;
            if (q - pos >= sizeof buf) break;
            memcpy(buf, t + pos, q - pos); buf[q - pos] = 0;
            if (ht_pro_width(FONT, buf) > TEXT_W) break;
            fit = q;
            if (!t[q]) break;
            while (t[q] == ' ') q++;
        }
        if (fit == pos) {   // one word wider than the row: break it at a codepoint
            size_t m = pos;
            for (;;) {
                size_t e = m + 1;
                while (t[e] && ((unsigned char)t[e] & 0xc0) == 0x80) e++;
                if (e - pos >= sizeof buf) break;
                memcpy(buf, t + pos, e - pos); buf[e - pos] = 0;
                if (ht_pro_width(FONT, buf) > TEXT_W && m > pos) break;
                m = e;
                if (!t[m]) break;
            }
            fit = m;
        }
        if (fit == pos) {   // nothing fits (a malformed or over-long sequence): skip one code point, never emit an empty row
            do { pos++; } while (t[pos] && ((unsigned char)t[pos] & 0xc0) == 0x80);
            continue;
        }
        start[n] = (uint16_t)pos;
        len[n] = (uint8_t)(fit - pos);
        n++;
        pos = fit;
    }
    return n;
}

// The Story's wrapped rows; the render task is the only user. The buffers live in PSRAM. s_text is also the cache key: the same text is not
// wrapped again (a pet's frames redraw the screen many times a second).
static EXT_RAM_BSS_ATTR char s_text[POD_RECAP_BYTES + 8], s_new[POD_RECAP_BYTES + 8];
static EXT_RAM_BSS_ATTR uint16_t s_start[ROWS_MAX];
static EXT_RAM_BSS_ATTR uint8_t s_len[ROWS_MAX];
static int s_rows = -1;

// A row that does not end the text, cut short with an ellipsis so it still fits TEXT_W.
static void ellipsise(char *row, size_t cap)
{
    size_t n = strlen(row);
    while (n && row[n - 1] == ' ') row[--n] = 0;
    for (;;) {
        char t[HT_TEXT_BYTES];
        snprintf(t, sizeof t, "%s\xe2\x80\xa6", row);
        if (ht_pro_width(FONT, t) <= TEXT_W || !n) { snprintf(row, cap, "%s", t); return; }
        do { n--; } while (n && ((unsigned char)row[n] & 0xc0) == 0x80);
        row[n] = 0;
    }
}

// One filled triangle (screen px).
static void tri(ht_scene_t *s, int x0, int y0, int x1, int y1, int x2, int y2, unsigned rgb)
{
    pod_tri(s, x0 * 16, y0 * 16, x1 * 16, y1 * 16, x2 * 16, y2 * 16, C(rgb));
}

void ph_view_recap(pod_out_frame_t *f, const pod_nav_t *nav, pod_model_t *m, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    s->background = C(BG);
    const pod_agent_t *a = pod_view_agent_of(nav, m);
    if (!a) return;
    const pod_unread_t *u = pod_model_unread_find(m, a->id);
    const bool failed = a->failed || (u && u->kind == POD_UNREAD_FAILED);
    const unsigned fill = failed ? 0xF3D9DA : PH_LETTER, ink = failed ? 0x9B5A5F : PH_LETTER_INK, fade = failed ? 0xC9A0A4 : PH_LETTER_MORE;   // the Notices letter's paper

    story_text(s_new, sizeof s_new, a, u);
    if (s_rows < 0 || strcmp(s_new, s_text)) {   // wrap only when the text changed
        memcpy(s_text, s_new, sizeof s_text);
        s_rows = wrap_story(s_text, ROWS_VIS + 1, s_start, s_len);   // one past the last visible row tells whether the text is longer
    }
    const int rows = s_rows, vis = rows > ROWS_VIS ? ROWS_VIS : rows;

    // The group: bubble (28 + rows * 46 + 28), the tail's 16 px, 2 px, the who row (122); centred, 40 px clear at least.
    const int bh = 2 * PAD_Y + vis * PITCH, gh = bh + ROW_GAP + ROW_H;
    int by = (720 - gh) / 2;
    if (by < MARGIN_MIN) by = MARGIN_MIN;
    const int bb = by + bh, row_top = bb + ROW_GAP;

    tri(s, TAIL_CX - TAIL_HALF, bb - 1, TAIL_CX + TAIL_HALF, bb - 1, TAIL_CX, bb + TAIL_DROP, fill);   // the lower half of the turned square
    ht_pro_rect_aa(s, BX, by, BW, bh, RAD, C(fill));
    const int lead = (PITCH - FONT->height) / 2;
    for (int i = 0; i < vis; i++) {
        char row[HT_TEXT_BYTES];
        memcpy(row, s_text + s_start[i], s_len[i]);
        row[s_len[i]] = 0;
        const bool last = i == ROWS_VIS - 1 && rows > ROWS_VIS;
        if (last) ellipsise(row, sizeof row);
        ht_pro_text(s, BX + PAD_X, by + PAD_Y + i * PITCH + lead, TEXT_W, FONT, C(last ? fade : ink), row);
    }

    const pod_scene_t scene = failed ? POD_SCENE_REST : POD_SCENE_RELAX;
    const int pet_y = row_top - PET_UP;
    if (pod_pet_for(a->engine)) pod_pet_draw_flat(s, PET_X, pet_y, PET_SIDE, a->engine, scene, now_ms, 0, BG, 8);   // the navy ground is clear of the pet: each frame is resampled once
    else ph_card_art(s, PET_X + PET_SIDE / 2, pet_y + PET_SIDE / 2, 72, m, a, BG, now_ms);

    char name[HT_TEXT_BYTES];   // one line, control characters as spaces, cut with an ellipsis before the right margin
    snprintf(name, sizeof name, "%s", a->name);
    for (char *c = name; *c; c++) if ((unsigned char)*c < 0x20) *c = ' ';
    const int max_w = NAME_MAX_X - NAME_X;
    if (ht_pro_width(&ph_sb_34, name) > max_w) {
        size_t n = strlen(name);
        for (;;) {
            char t[HT_TEXT_BYTES];
            snprintf(t, sizeof t, "%s\xe2\x80\xa6", name);
            if (ht_pro_width(&ph_sb_34, t) <= max_w || !n) { snprintf(name, sizeof name, "%s", t); break; }
            do { n--; } while (n && ((unsigned char)name[n] & 0xc0) == 0x80);
            name[n] = 0;
        }
    }
    ph_text(s, NAME_X, pet_y + PET_SIDE / 2, max_w + 2, &ph_sb_34, PH_ROOM_INK, name);   // the name centred on the pet
}
