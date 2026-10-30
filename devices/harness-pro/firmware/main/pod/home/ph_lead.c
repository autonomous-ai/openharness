// The Lead view (Swarm cards; the owner's mockup swarm-card.html B1-B3), built from ph_recap.c: a tap on a Lead's pet on the Swarm card opens the Lead's last
// message in the Swarm chat. On the navy ground: the Swarm's name (small, purple) and the project (the title) centred at the top, a PM or group chat the desktop has open named in a small muted line under the project (the bubble stays where it is), then the message in the
// paper bubble (x 60, 600 wide, top 150, only as tall as its text: 28 px above and below, 34 at the sides, rows 46 px apart), a tail under its bottom left and
// the "who" row: the Lead's pet (150 px box at x 16, the scene of its state: WORK, ASK, REST) with "Lead" (bold) and its status line in the status colour
// ("working . m:ss" green, "needs you" orange, "stuck" red, "done" grey), a remote Lead adding its owner in a smaller muted line.
// A Lead that needs you has an 8 px orange inner left edge on the bubble (stuck: red). States of the text: LOADING draws "..." in a bubble of its own; EMPTY draws no
// bubble, "No message yet" muted in the middle and the pet resting; LOADED the text. A long message shows 7 rows at a time and scrolls by rows (the frame's
// scroll; a vertical drag, pod_scroll_pitch / pod_scroll_max; the same drag scrolls the desktop's Swarm chat), the last visible row lighter while more follows. No hit: a tap anywhere talks to a local Lead's
// harness (the glue), a horizontal swipe steps to the previous / next Lead (pod_nav_act PREV / NEXT). No page dots.
// A Lead with a Buddy side (`buddies`) adds the PM | Buddy pill (mockup pro-swarm-parity 2A: 300 x 44 at (210, 16), radius 22, the selected segment filled: PM ink, Buddy lilac) and
// the header becomes one line at cy 94 (the Swarm's name small purple, " . " muted, the project; the Swarm's name gives way first), a PM or group name moving to cy 130 under the pill; the
// bubble stays at 150. Two POD_A_SIDE hits (one per segment; the glue sends supertab.side and shows the tapped segment until the Swarm's next frame). A Lead whose chat is the Buddy's
// signs with the Buddy: its avatar (120 px in the pet's box), its name in lilac and "offline" under it while it is not live. On the Buddy side with no Buddy yet there is no bubble and
// no who row: a dashed circle with "+" and two muted lines. The Buddy's quiet notice is a 12 px lilac dot at the Buddy segment's top right while the PM side shows.
#include <stdio.h>
#include <string.h>

#include "pod/home/ph.h"
#include "pod/pod_draw.h"
#include "pod/pod_mem.h"
#include "pod/pod_pet.h"
#include "pod/pod_view_shared.h"
#include "pro_canvas.h"

#define C(rgb) ht_rgb(rgb)
#define ELL "\xe2\x80\xa6"
enum { BG = PH_ROOM_BG, BX = 60, BW = 600, BY = 150, RAD = 34, PAD_X = 34, PAD_Y = 28, TEXT_W = BW - 2 * PAD_X, PITCH = 46, ROWS_VIS = 7, ROWS_MAX = 64,
       EDGE = 8, EDGE_W = 120,   // the inner edge: a rounded block of this width in the edge colour, the bubble drawn 8 px in over it
       TAIL_CX = BX + 48 + 18, TAIL_HALF = 24, TAIL_DROP = 23,
       ROW_GAP = 18, AVATAR_D = 120, PET_X = 16, PET_SIDE = 150, PET_UP = 10, NAME_X = 160, NAME_MAX_X = 660, HEAD_W = 640,
       SW_CY = 42, PROJ_CY = 84, CHAT_CY = 120, NOMSG_CY = 330,
       PILL_X = 210, PILL_Y = 16, PILL_W = 300, PILL_H = 44, SEG_W = 150, PILL_CY = 38, HEAD_A_CY = 94, CHAT_PILL_CY = 130,   // the pill, header A, the chat name under the pill
       DOT = 12, DOT_X = 480, DOT_Y = 18, DOT_RING = 3,   // right of "Buddy", clear of its ink
       NB_CX = 360, NB_CY = 250, NB_D = 120, NB_DASHES = 12, NB_TITLE_CY = 364, NB_SUB_CY = 412,   // no Buddy yet: the dashed circle, the two lines
       TRACK = 0x34302C, BUDDY_INK = 0xC49BFF,
       EDGE_ASK = 0xFF9A52, EDGE_STUCK = 0xE5484D, SWARM_INK = 0xB79CFF };   // the mockup's #ff9a52 and a red; the Swarm name's purple
static const ht_pro_font_t *const FONT = &ph_rg_36;

// Word wrap to TEXT_W (ph_recap.c's wrapper, up to ROWS_MAX rows): each row's start offset and byte length (a row is under HT_TEXT_BYTES).
static int wrap_text(const char *t, uint16_t start[ROWS_MAX], uint8_t len[ROWS_MAX])
{
    char buf[HT_TEXT_BYTES];
    int n = 0;
    size_t pos = 0, total = strlen(t);
    while (n < ROWS_MAX) {
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
        if (fit == pos) {   // nothing fits (a malformed sequence): skip one code point, never emit an empty row
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

// The message's wrapped rows; pro_app's lock keeps the touch task (pod_scroll_max) and the render task from using them at once. The buffers live in PSRAM (no
// big stack frame on either task). s_raw is the cache key: the same text is not wrapped again (a pet's frames redraw the screen many times a second).
static EXT_RAM_BSS_ATTR char s_raw[SWARM_TEXT_MAX + 8], s_text[SWARM_TEXT_MAX + 8];
static EXT_RAM_BSS_ATTR uint16_t s_start[ROWS_MAX];
static EXT_RAM_BSS_ATTR uint8_t s_len[ROWS_MAX];
static int s_rows = -1;

// The Lead's text as it is drawn (control characters as spaces, in s_text) wrapped; returns the row count (0 for no text).
static int rows_of(const char *text)
{
    if (!text) text = "";
    if (s_rows < 0 || strncmp(text, s_raw, sizeof s_raw - 1) || strlen(text) >= sizeof s_raw - 1) {
        snprintf(s_raw, sizeof s_raw, "%s", text);
        memcpy(s_text, s_raw, sizeof s_text);
        for (char *c = s_text; *c; c++) if ((unsigned char)*c < 0x20) *c = ' ';
        s_rows = wrap_text(s_text, s_start, s_len);
    }
    return s_rows;
}

int ph_lead_pitch(void) { return PITCH; }

// The side the pill shows: the segment just tapped on this Swarm if the daemon has not answered yet, else the Swarm's own (NONE counts as PM).
static pod_side_t side_shown(const pod_model_t *m, const pod_swarm_t *sw)
{
    pod_side_t side = m->side_press != POD_SIDE_NONE && !strcmp(m->side_press_swarm, sw->id) ? m->side_press : sw->side;
    return side == POD_SIDE_BUDDY ? POD_SIDE_BUDDY : POD_SIDE_PM;
}
// The Buddy side of a Lead that has none: no bubble, no who row.
static bool no_buddy(const pod_model_t *m, const pod_swarm_t *sw, const pod_lead_t *l)
{
    return l->buddies && !l->has_buddy && side_shown(m, sw) == POD_SIDE_BUDDY;
}

int ph_lead_max_row(const pod_nav_t *nav, const pod_model_t *m)
{
    const pod_swarm_t *sw = NULL;
    const pod_lead_t *l = pod_nav_lead(nav, m, &sw);
    if (!l || l->recap != POD_RECAP_LOADED || (sw && no_buddy(m, sw, l))) return 0;
    const int rows = rows_of(l->text);
    return rows > ROWS_VIS ? rows - ROWS_VIS : 0;
}

// One filled triangle (screen px).
static void tri(ht_scene_t *s, int x0, int y0, int x1, int y1, int x2, int y2, unsigned rgb)
{
    pod_tri(s, x0 * 16, y0 * 16, x1 * 16, y1 * 16, x2 * 16, y2 * 16, C(rgb));
}

// `src` on one line, control characters as spaces, cut with an ellipsis to w px.
static void fit_line(char *out, size_t n, const char *src, const ht_pro_font_t *f, int w)
{
    snprintf(out, n, "%s", src);
    for (char *c = out; *c; c++) if ((unsigned char)*c < 0x20) *c = ' ';
    if (ht_pro_width(f, out) <= w) return;
    size_t k = strlen(out);
    for (;;) {
        char t[HT_TEXT_BYTES];
        snprintf(t, sizeof t, "%s" ELL, out);
        if (ht_pro_width(f, t) <= w || !k) { snprintf(out, n, "%s", t); return; }
        do { k--; } while (k && ((unsigned char)out[k] & 0xc0) == 0x80);
        out[k] = 0;
    }
}

// Centred on x 360, vertically on cy.
static void centred(ht_scene_t *s, int cy, const ht_pro_font_t *f, unsigned rgb, const char *t)
{
    const int w = ht_pro_width(f, t);
    ph_text(s, (POD_W - w) / 2, cy, w + 2, f, rgb, t);
}

// The pill: the track, the selected segment filled, "PM" and "Buddy", the two hits and, while the Buddy spoke and the PM side shows, the lilac dot with its track-coloured ring.
static void draw_pill(pod_out_frame_t *f, const pod_swarm_t *sw, pod_side_t side, bool dot)
{
    ht_scene_t *s = f->scene;
    const bool pm = side == POD_SIDE_PM;
    ht_pro_rect_aa(s, PILL_X, PILL_Y, PILL_W, PILL_H, PILL_H / 2, C(TRACK));
    ht_pro_rect_aa(s, PILL_X + (pm ? 0 : SEG_W), PILL_Y, SEG_W, PILL_H, PILL_H / 2, C(pm ? PH_ROOM_INK : BUDDY_INK));
    const char *label[2] = { "PM", "Buddy" };
    for (int i = 0; i < 2; i++) {
        const bool on = (i == 0) == pm;
        const int w = ht_pro_width(&ph_sb_22, label[i]);
        ph_text(s, PILL_X + i * SEG_W + (SEG_W - w) / 2, PILL_CY, w + 2, &ph_sb_22, on ? PH_ROOM_BG : PH_ROOM_MUTED, label[i]);
        pod_hit_add_id(f, PILL_X + i * SEG_W, PILL_Y - 8, SEG_W, PILL_H + 16, POD_A_SIDE, i ? POD_SIDE_BUDDY : POD_SIDE_PM, sw->id);   // a taller target than the pill, inside the status band
    }
    if (dot) {
        ht_pro_rect_aa(s, DOT_X - DOT_RING, DOT_Y - DOT_RING, DOT + 2 * DOT_RING, DOT + 2 * DOT_RING, (DOT + 2 * DOT_RING) / 2, C(TRACK));
        ht_pro_rect_aa(s, DOT_X, DOT_Y, DOT, DOT, DOT / 2, C(BUDDY_INK));
    }
}

// Header A: the Swarm's name (ph_sb_26, purple), " . " (muted) and the project (ph_sb_34) on one line centred at cy 94, the whole line within HEAD_W: the Swarm's name is
// shortened first, the project's end last.
static void head_a(ht_scene_t *s, const char *swarm, const char *project)
{
    char name[HT_TEXT_BYTES], proj[HT_TEXT_BYTES];
    fit_line(proj, sizeof proj, project, &ph_sb_34, HEAD_W);
    const char *sep = " \xc2\xb7 ";
    const int sepw = ht_pro_width(&ph_sb_34, sep), ellw = ht_pro_width(&ph_sb_26, ELL);
    int room = HEAD_W - sepw - ht_pro_width(&ph_sb_34, proj);   // what the name may have
    if (room < ellw) {   // the project alone is too long beside even a bare ellipsis: it gives up its end
        room = ellw;
        fit_line(proj, sizeof proj, project, &ph_sb_34, HEAD_W - sepw - ellw);
    }
    fit_line(name, sizeof name, swarm, &ph_sb_26, room);
    const int nw = ht_pro_width(&ph_sb_26, name), pw = ht_pro_width(&ph_sb_34, proj);
    int x = (POD_W - (nw + sepw + pw)) / 2;
    ph_text(s, x, HEAD_A_CY, nw + 2, &ph_sb_26, SWARM_INK, name);
    ph_text(s, x + nw, HEAD_A_CY, sepw + 2, &ph_sb_34, PH_ROOM_MUTED, sep);
    ph_text(s, x + nw + sepw, HEAD_A_CY, pw + 2, &ph_sb_34, PH_ROOM_INK, proj);
}

// The Buddy's who row: its avatar (d 120, centred in the pet's 150 px box) with its name in lilac, and "offline" under it while it is not live.
static void who_buddy(ht_scene_t *s, const pod_lead_t *l, int cy)
{
    char line[HT_TEXT_BYTES];
    ph_buddy_avatar(s, PET_X + (PET_SIDE - AVATAR_D) / 2, cy - AVATAR_D / 2, AVATAR_D, l->buddy.cells, l->buddy.color, BG);
    fit_line(line, sizeof line, l->buddy.name, &ph_sb_34, NAME_MAX_X - NAME_X);
    ph_text(s, NAME_X, cy - 17, NAME_MAX_X - NAME_X, &ph_sb_34, BUDDY_INK, line);
    if (!l->buddy.live) ph_text(s, NAME_X, cy + 22, NAME_MAX_X - NAME_X, &ph_sb_22, PH_ROOM_MUTED, "offline");
}

// No Buddy yet: a dashed circle (twelve short arcs) with a "+", then two muted lines.
static void draw_no_buddy(ht_scene_t *s)
{
    for (int k = 0; k < NB_DASHES; k++)
        pod_arc(s, NB_CX * 16, NB_CY * 16, (NB_D / 2 - 2) * 16, 4 * 16, k * 360 / NB_DASHES, 360 / NB_DASHES / 4, C(PH_ROOM_MUTED));
    centred(s, NB_CY, &ph_sb_48, PH_ROOM_MUTED, "+");
    centred(s, NB_TITLE_CY, &ph_sb_34, PH_ROOM_MUTED, "No Buddy here yet");
    centred(s, NB_SUB_CY, &ph_rg_28, PH_ROOM_MUTED, "Add one in the Harness app.");
}

void ph_view_lead(pod_out_frame_t *f, const pod_nav_t *nav, pod_model_t *m, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    s->background = C(BG);
    const pod_swarm_t *sw = NULL;
    const pod_lead_t *l = pod_nav_lead(nav, m, &sw);
    if (!l) return;   // the link dropped or the list has not come back: nothing to say yet (the view stays; pod_nav_sync decides when it goes)
    char line[HT_TEXT_BYTES];
    const pod_side_t side = side_shown(m, sw);
    if (l->buddies) {   // the pill, and the header on one line under it
        draw_pill(f, sw, side, l->buddy_unread && side == POD_SIDE_PM);
        head_a(s, sw->name, l->project);
    } else {
        fit_line(line, sizeof line, sw->name, &ph_sb_22, HEAD_W);
        centred(s, SW_CY, &ph_sb_22, SWARM_INK, line);
        fit_line(line, sizeof line, l->project, &ph_sb_34, HEAD_W);
        centred(s, PROJ_CY, &ph_sb_34, PH_ROOM_INK, line);
    }
    if ((l->chat == POD_CHAT_PM || l->chat == POD_CHAT_GROUP) && l->chat_name[0]) {   // the chat the desktop has open (a PM or a group; the Lead's own chat adds nothing)
        fit_line(line, sizeof line, l->chat_name, &ph_sb_22, HEAD_W);
        centred(s, l->buddies ? CHAT_PILL_CY : CHAT_CY, &ph_sb_22, PH_ROOM_MUTED, line);
    }
    if (no_buddy(m, sw, l)) { draw_no_buddy(s); return; }

    // The bubble: the text (loaded), "..." (loading) or nothing (no message yet, or not asked yet: the same "..." as loading)
    const bool empty = l->recap == POD_RECAP_EMPTY, loaded = l->recap == POD_RECAP_LOADED;
    const int rows = loaded ? rows_of(l->text) : 0;
    const int vis = loaded ? (rows > ROWS_VIS ? ROWS_VIS : rows) : 1;
    int first = nav->stack[nav->depth - 1].scroll;
    if (first > rows - vis) first = rows - vis;
    if (first < 0) first = 0;
    const int bh = 2 * PAD_Y + vis * PITCH;
    int bb = BY + bh;   // the bubble's bottom: where the who row hangs from
    if (empty) bb = BY + 2 * PAD_Y + 4 * PITCH;   // no bubble: the row sits where a four-row message's would
    else {
        const unsigned fill = PH_LETTER, ink = PH_LETTER_INK;
        tri(s, TAIL_CX - TAIL_HALF, bb - 1, TAIL_CX + TAIL_HALF, bb - 1, TAIL_CX, bb + TAIL_DROP, fill);
        const bool edge = l->state == POD_LEAD_ASK || l->state == POD_LEAD_STUCK;
        if (edge) ht_pro_rect_aa(s, BX, BY, EDGE_W, bh, RAD, C(l->state == POD_LEAD_ASK ? EDGE_ASK : EDGE_STUCK));
        ht_pro_rect_aa(s, edge ? BX + EDGE : BX, BY, edge ? BW - EDGE : BW, bh, RAD, C(fill));
        const int lead = (PITCH - FONT->height) / 2;
        for (int i = 0; i < vis; i++) {
            char row[HT_TEXT_BYTES];
            const char *t = ELL;
            if (loaded) { memcpy(row, s_text + s_start[first + i], s_len[first + i]); row[s_len[first + i]] = 0; t = row; }
            const bool more = loaded && i == vis - 1 && first + vis < rows;   // the last visible row is lighter while the message goes on
            ht_pro_text(s, BX + PAD_X, BY + PAD_Y + i * PITCH + lead, TEXT_W, FONT, C(more ? PH_LETTER_MORE : ink), t);
        }
    }
    if (empty) centred(s, NOMSG_CY, &ph_sb_34, PH_ROOM_MUTED, "No message yet");

    // The who row: the pet in its state's scene (resting when there is nothing to say), "Lead" and the status line beside it
    const pod_scene_t scene = empty ? POD_SCENE_REST : ph_lead_scene(l->state);
    const int pet_y = bb + ROW_GAP - PET_UP, cy = pet_y + PET_SIDE / 2;
    if (l->chat == POD_CHAT_BUDDY && l->has_buddy) { who_buddy(s, l, cy); return; }   // the Buddy signs its own chat
    if (pod_pet_for(l->engine)) pod_pet_draw_flat(s, PET_X, pet_y, PET_SIDE, l->engine, scene, now_ms, 0, BG, 8);
    else ph_engine_logo(s, PET_X + PET_SIDE / 2 - 36, cy - 36, 72, l->engine, BG);
    const int max_w = NAME_MAX_X - NAME_X;
    const bool owner = l->owner[0] != 0;
    ph_text(s, NAME_X, cy - (owner ? 30 : 17), max_w, &ph_sb_34, PH_ROOM_INK, "Lead");
    char st[HT_TEXT_BYTES];
    const unsigned ink = ph_lead_status(l, now_ms, st, sizeof st, ph_mix(0xFFFFFF, BG, 60));
    ph_text(s, NAME_X, cy + (owner ? 4 : 22), max_w, &ph_sb_22, ink, st);
    if (owner) {   // someone else's machine: whose, small and muted
        fit_line(line, sizeof line, l->owner, &ph_mono_18, max_w);
        ph_text(s, NAME_X, cy + 34, max_w, &ph_mono_18, PH_ROOM_MUTED, line);
    }
}

uint32_t ph_lead_next_ms(const pod_nav_t *nav, const pod_model_t *m, uint32_t now_ms)
{
    const pod_lead_t *l = pod_nav_lead(nav, m, NULL);
    if (!l) return POD_PET_STEP_MS;
    uint32_t ms = pod_pet_next_beat_ms(l->engine, l->recap == POD_RECAP_EMPTY ? POD_SCENE_REST : ph_lead_scene(l->state), now_ms, 0);
    if (ms < POD_PH_ANIM_MS) ms = POD_PH_ANIM_MS - now_ms % POD_PH_ANIM_MS;   // a pet redraws a lot: no faster than the Pets beat
    if (l->state == POD_LEAD_WORK && l->since_s) {   // the status line's clock: when its seconds next change
        const uint32_t into = (int32_t)(now_ms - l->since_at_ms) > 0 ? now_ms - l->since_at_ms : 0, t = 1000 - into % 1000;
        if (ms > t) ms = t;
    }
    return ms;
}
