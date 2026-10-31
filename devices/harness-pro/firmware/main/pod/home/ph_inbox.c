// Pets Notices (mockup "Notices", option B): navy ground; the header at the left, "Notices" in bold with "N new" after it. Rows from y 120, 170 px
// apart, three visible, a drag scrolls by rows: a 110 px avatar box (the pet's REST frame, still; an engine without a pet: its logo or ">_"),
// a light speech bubble (470 wide, a small tail to the avatar) with the agent's name and its age at the right ("asks" for an asking agent),
// then the text in at most two rows, the second cut with an ellipsis. Order: the asking agents (model order, their question), then the unread
// entries newest first (the entry's first sentence). A tap on a row registers POD_A_OPEN_NOTIF with the agent id (the glue resolves it against
// model->unread); an asking agent has no unread entry: POD_A_FOLLOW, which the glue resolves to an index in model->agents.
// A Super Tab's question (pod_model_attention; owner's mockup pro-supertab/notify.html A3) is an asking row with three marks: the name line reads
// "<name> · <Super Tab>" (the Super Tab in purple #6B4FA3), the meta "needs you" (a decision) or "stuck", a 6 px edge inside the bubble's left side
// (amber #FFB340 / red #FF5C5C: the bubble less a copy of itself 6 px to the right, so it follows the corners; the tail, here a whole turned square,
// is drawn over it as in the mockup), and on the avatar's bottom right corner a 40 px badge (#3B2E55, radius 12, a 3 px ring of the room's ground)
// holding a diamond 16 px across in the room's ink (two triangles; the mockup's ◆ inherits that colour).
// A Swarm chat's notice (an entry with `tab`; owner's mockup pro-swarm-parity 1E) is a plain row with that same name line, "<project> · <Swarm name>" in purple,
// the Lead's pet as the avatar, and none of the question's marks (no edge, no badge); the Swarm gone from the model: no tag. A tap is POD_A_OPEN_NOTIF by the Lead's id.
#include <stdio.h>
#include <string.h>

#include "pod/home/ph.h"
#include "pod/pod_draw.h"
#include "pod/pod_view_shared.h"
#include "pro_canvas.h"

#define C(rgb) ht_rgb(rgb)
#define ELL "\xe2\x80\xa6"
enum { BG = PH_ROOM_BG, TOP = 120, PITCH = 170, SHOWN = 3, ROW_H = 150, AV_X = 60, AV_Y = 8, AV = 110, AV_ART = 92, BUB_X = 190, BUB_W = 470, PAD_X = 26, PAD_TOP = 20,
       PAD_BOT = 22, NAME_H = 30, MSG_PITCH = 39, MAX_ITEMS = 40, TAIL_X = 181, TAIL_Y = 52 };
// A Super Tab's row: the edge's width, the badge (its size, how far it hangs past the avatar's corner, its radius and ring) and the diamond's half width.
// TAG_GAP: from the name's measured end to the "·": the measured width runs ~4 px past the ink and the dot has its own bearing, so 2 px reads as
// the mockup's word space. The diamond is the mockup's glyph colour (the room's ink, inherited there).
enum { EDGE_W = 6, BADGE = 40, BADGE_OUT = 8, BADGE_R = 12, RING = 3, DIAMOND = 8, TAG_GAP = 2 };
enum { TAB_INK = 0x6B4FA3, BADGE_FILL = 0x3B2E55, DIAMOND_INK = PH_ROOM_INK, DECIDE_EDGE = 0xFFB340, STUCK_EDGE = 0xFF5C5C };
// The room's warm ground and the Notices letter's paper (owner, UI review option B): the letter card, this list and the recap are one family.
enum { BUB_FILL = PH_LETTER, INK = PH_LETTER_INK, META = PH_LETTER_WHO, AV_FILL = PH_RAISED, HEAD_INK = PH_ROOM_INK, HEAD_MUTED = PH_ROOM_MUTED };
static const ht_pro_font_t *const MSG = &ph_sb_32, *const META_F = &ph_sb_22;

typedef struct { const pod_agent_t *a; const pod_unread_t *u; int unread_index; } item_t;

// A Swarm chat's notice names no agent (its `agent` is a Lead's id, which no roster row owns): the Lead and its Swarm, either NULL when gone.
static const pod_swarm_t *notice_swarm(const pod_model_t *m, const pod_unread_t *u) { return u && u->tab[0] ? pod_model_swarm(m, u->tab) : NULL; }
static const pod_lead_t *notice_lead(const pod_swarm_t *sw, const pod_unread_t *u)
{
    const int j = sw ? pod_model_lead_index(sw, u->agent) : -1;
    return j < 0 ? NULL : &sw->leads[j];
}

static int collect(const pod_model_t *m, item_t out[MAX_ITEMS])
{
    int n = 0;
    for (int i = 0; i < m->agent_count && n < MAX_ITEMS; i++)
        if (pod_model_eff(m, &m->agents[i]) == POD_ASKING) out[n++] = (item_t){&m->agents[i], NULL, -1};
    const int first = n;
    for (int i = 0; i < m->unread_count && n < MAX_ITEMS; i++) {
        const pod_agent_t *ag = m->unread[i].tab[0] ? NULL : pod_model_find(m, m->unread[i].agent);
        if (ag && pod_model_eff(m, ag) == POD_ASKING) continue;   // it is listed above by its question; the entry waits for when it stops asking
        out[n++] = (item_t){ag, &m->unread[i], i};
    }
    for (int i = first + 1; i < n; i++) {   // newest first by the entries' own times (a stable insertion sort; the model already keeps them so)
        item_t it = out[i];
        int j = i;
        while (j > first && (int32_t)(it.u->at_ms - out[j - 1].u->at_ms) > 0) { out[j] = out[j - 1]; j--; }
        out[j] = it;
    }
    return n;
}

int ph_inbox_pitch(void) { return PITCH; }

// The notice's one-line text: an entry's first sentence ("Done"/"Failed" when it has none), an asking agent's question.
static void item_line(const item_t *it, char *out, size_t cap)
{
    if (it->u) {
        ph_first_sentence(out, cap, it->u->text);
        if (!out[0]) snprintf(out, cap, "%s", it->u->kind == POD_UNREAD_FAILED ? "Failed" : "Done");
    } else {
        snprintf(out, cap, "%s", it->a->question);
        for (char *c = out; *c; c++) if (*c == '\n' || *c == '\r' || *c == '\t') *c = ' ';
        pod_utf8_trim(out);
    }
}

int ph_notices_top(const pod_model_t *m, int max, ph_notice_line_t *out)
{
    item_t it[MAX_ITEMS];
    const int n = collect(m, it);
    int k = 0;
    for (; k < n && k < max; k++) {
        const pod_lead_t *ld = it[k].u ? notice_lead(notice_swarm(m, it[k].u), it[k].u) : NULL;
        out[k].engine = it[k].a ? it[k].a->engine : ld ? ld->engine : NULL;
        out[k].name = it[k].a ? it[k].a->name : it[k].u ? it[k].u->name : "";
        item_line(&it[k], out[k].text, sizeof out[k].text);
    }
    return k;
}

int ph_inbox_max_row(const pod_model_t *m)
{
    item_t it[MAX_ITEMS];
    int n = collect(m, it);
    return n > SHOWN ? n - SHOWN : 0;
}

// The pet's REST frame (a fixed clock: the list does not move) fitted in the avatar box, centred on (cx, cy). No pet: the logo, else ">_".
static void face_art(ht_scene_t *s, int cx, int cy, const char *engine)
{
    if (engine && pod_pet_for(engine)) {
        pod_pet_draw_flat(s, cx - AV_ART / 2, cy - AV_ART / 2, AV_ART, engine, POD_SCENE_REST, 0, 0, AV_FILL, 8);   // the avatar box is one colour: the face is baked once
        return;
    }
    if (engine && pod_logo_draw(s, cx - 24, cy - 24, 48, engine)) return;
    int w = ht_pro_width(&ph_mono_26, ">_");
    ph_text(s, cx - w / 2, cy, w + 2, &ph_mono_26, PH_ROOM_INK, ">_");
}

// The text in at most two rows of `w`; a longer one ends its second row with an ellipsis.
static int two_rows(const char *text, int w, char rows[3][POD_ROW_MAX])
{
    int n = pod_wrap(text, MSG, w, 3, rows);
    if (n == 3) {
        n = 2;
        char *r = rows[1];
        size_t len = strlen(r);
        for (;;) {
            char t[POD_ROW_MAX + 4];
            snprintf(t, sizeof t, "%s" ELL, r);
            if (ht_pro_width(MSG, t) <= w || len == 0) { snprintf(r, POD_ROW_MAX, "%s", t); break; }
            do { len--; } while (len && ((unsigned char)r[len] & 0xc0) == 0x80);
            r[len] = 0;
            while (len && r[len - 1] == ' ') r[--len] = 0;
        }
    }
    return n;
}

static void row(pod_out_frame_t *f, const pod_model_t *m, const item_t *it, int y)
{
    ht_scene_t *s = f->scene;
    const pod_agent_t *a = it->a;
    char text[POD_UNREAD_TEXT > 320 ? POD_UNREAD_TEXT : 320], rows[3][POD_ROW_MAX], age[12];
    const char *name, *engine = a ? a->engine : NULL;
    const pod_swarm_t *sw = notice_swarm(m, it->u);   // a Swarm chat's notice: the Lead's pet and "· <Swarm name>"
    const pod_attention_t attn = it->u ? POD_ATTN_NONE : pod_model_attention(m, a);
    if (it->u) {
        ph_first_sentence(text, sizeof text, it->u->text);
        int32_t d = (int32_t)(m->clock_ms - it->u->at_ms);
        pod_fmt_age(age, sizeof age, d > 0 ? (uint32_t)d / 1000 : 0);
        name = a && a->name[0] ? a->name : it->u->name[0] ? it->u->name : "Agent";
        if (it->u->tab[0]) { const pod_lead_t *ld = notice_lead(sw, it->u); engine = ld ? ld->engine : NULL; }
    } else {
        snprintf(text, sizeof text, "%s", a->question);
        for (char *c = text; *c; c++) if (*c == '\n' || *c == '\r' || *c == '\t') *c = ' ';
        snprintf(age, sizeof age, "%s", attn == POD_ATTN_STUCK ? "stuck" : attn == POD_ATTN_DECISION ? "needs you" : "asks");
        name = a->name[0] ? a->name : "Agent";
    }
    const int tw = BUB_W - 2 * PAD_X, n = two_rows(text, tw, rows);
    const int h = PAD_TOP + NAME_H + 4 + n * MSG_PITCH + PAD_BOT;

    ht_pro_rect_aa(s, AV_X, y + AV_Y, AV, AV, 28, C(AV_FILL));
    face_art(s, AV_X + AV / 2, y + AV_Y + AV / 2, engine);
    if (attn != POD_ATTN_NONE) {   // the Super Tab badge: a ring of the ground, the purple square, the white diamond
        const int bx = AV_X + AV + BADGE_OUT - BADGE, by = y + AV_Y + AV + BADGE_OUT - BADGE, cx = bx + BADGE / 2, cy = by + BADGE / 2;
        ht_pro_rect_aa(s, bx, by, BADGE, BADGE, BADGE_R, C(BG));
        ht_pro_rect_aa(s, bx + RING, by + RING, BADGE - 2 * RING, BADGE - 2 * RING, BADGE_R - RING, C(BADGE_FILL));
        pod_tri_inner(s, (cx - DIAMOND) * 16, cy * 16, cx * 16, (cy - DIAMOND) * 16, (cx + DIAMOND) * 16, cy * 16, C(DIAMOND_INK), 4u);
        pod_tri_inner(s, (cx + DIAMOND) * 16, cy * 16, cx * 16, (cy + DIAMOND) * 16, (cx - DIAMOND) * 16, cy * 16, C(DIAMOND_INK), 4u);
        ht_pro_rect_aa(s, BUB_X, y, BUB_W, h, 30, C(attn == POD_ATTN_STUCK ? STUCK_EDGE : DECIDE_EDGE));
        ht_pro_rect_aa(s, BUB_X + EDGE_W, y, BUB_W - EDGE_W, h, 30, C(BUB_FILL));
    } else {
        ht_pro_rect_aa(s, BUB_X, y, BUB_W, h, 30, C(BUB_FILL));
    }
    {   // the tail: the left half of a 26 px square turned 45 degrees at (181, y + 52), pointing at the avatar (a Super Tab row: the whole square, over the edge)
        const int cy = y + TAIL_Y + 13, x0 = TAIL_X - 5;
        pod_tri(s, (BUB_X + 1) * 16, (cy - 18) * 16, (BUB_X + 1) * 16, (cy + 18) * 16, x0 * 16, cy * 16, C(BUB_FILL));
        if (attn != POD_ATTN_NONE)
            pod_tri_inner(s, (BUB_X + 1) * 16, (cy - 18) * 16, (BUB_X + 22) * 16, cy * 16, (BUB_X + 1) * 16, (cy + 18) * 16, C(BUB_FILL), 4u);
    }
    int aw = ht_pro_width(META_F, age), nw = ht_pro_width(META_F, name), room = tw - aw - 16;
    char tag[SUPER_TAB_MAX + 4] = "";
    int gw = 0;
    if (attn != POD_ATTN_NONE || sw) {   // "name · Super Tab" (a Swarm's notice: "project · Swarm"): the name keeps at least half the room, the tag the rest (cut with dots)
        snprintf(tag, sizeof tag, "\xc2\xb7 %s", sw ? sw->name : a->super_tab);
        const int want = ht_pro_width(META_F, tag);
        int keep = room - TAG_GAP - want;   // what the name may take beside the whole tag
        if (keep < room / 2) keep = room / 2;
        if (nw > keep) nw = keep;
        gw = room - nw - TAG_GAP;
        if (gw > want + 2) gw = want + 2;
    }
    if (nw > room) nw = room > 0 ? room : 0;
    const int ly = y + PAD_TOP;
    if (nw > 0) ht_pro_text(s, BUB_X + PAD_X, ly, nw, META_F, C(META), name);
    if (gw > 0) ht_pro_text(s, BUB_X + PAD_X + nw + TAG_GAP, ly, gw, META_F, C(TAB_INK), tag);
    ht_pro_text(s, BUB_X + BUB_W - PAD_X - aw, ly, aw + 2, META_F, C(META), age);
    for (int i = 0; i < n; i++) ht_pro_text(s, BUB_X + PAD_X, ly + NAME_H + 4 + i * MSG_PITCH, tw, MSG, C(INK), rows[i]);

    // A row with an unread entry marks it read (OPEN_NOTIF); an asking agent has none: FOLLOW opens it by id.
    const int hy = y - (PITCH - ROW_H) / 2, hh = PITCH;
    if (it->u) pod_hit_add_id(f, 0, hy < 0 ? 0 : hy, POD_W, hh, POD_A_OPEN_NOTIF, it->unread_index, it->u->agent);
    else pod_hit_add_id(f, 0, hy < 0 ? 0 : hy, POD_W, hh, POD_A_FOLLOW, (int)(a - m->agents), a->id);
}

void ph_view_inbox(pod_out_frame_t *f, const pod_nav_t *nav, pod_model_t *m, uint32_t now_ms)
{
    (void)now_ms;
    ht_scene_t *s = f->scene;
    s->background = C(BG);
    item_t it[MAX_ITEMS];
    int n = collect(m, it);
    {   // "Notices" at the left, "N new" 14 px after it, on the same baseline
        const int w = ht_pro_width(&ph_sb_34, "Notices");
        ht_pro_text(s, 60, 40, w + 2, &ph_sb_34, C(HEAD_INK), "Notices");
        if (n > 0) {
            char cnt[16];
            snprintf(cnt, sizeof cnt, "%d new", n);
            ht_pro_text(s, 60 + w + 14, 40 + (ph_sb_34.height - ph_sb_26.height) * 4 / 5, ht_pro_width(&ph_sb_26, cnt) + 2, &ph_sb_26, C(HEAD_MUTED), cnt);
        }
    }
    if (n == 0) {
        const char *msg = "Nothing new";
        int w = ht_pro_width(&ph_rg_36, msg);
        ph_text(s, (POD_W - w) / 2, POD_W / 2, w + 2, &ph_rg_36, PH_ROOM_MUTED, msg);
        return;
    }
    const pod_frame_t *fr = &nav->stack[nav->depth - 1];
    int max = ph_inbox_max_row(m);
    int first = fr->scroll < 0 ? 0 : fr->scroll > max ? max : fr->scroll;
    for (int i = first; i < n && i < first + SHOWN; i++) row(f, m, &it[i], TOP + (i - first) * PITCH);
}

// Ms to the next change of what Notices shows: a visible entry's age text ("now", then minutes, hours, days) turns over at a whole minute, hour or day.
// Nothing else on the screen moves, so it is not redrawn (nor its scene rebuilt under the lock) until then, or until the model changes it.
uint32_t ph_inbox_next_ms(const pod_nav_t *nav, const pod_model_t *m, uint32_t now_ms)
{
    item_t it[MAX_ITEMS];
    const int n = collect(m, it), max = n > SHOWN ? n - SHOWN : 0;
    const pod_frame_t *fr = nav->depth ? &nav->stack[nav->depth - 1] : NULL;
    const int scroll = fr ? fr->scroll : 0, first = scroll < 0 ? 0 : scroll > max ? max : scroll;
    int64_t next = 60000;   // nothing visible has an age: the model's own changes redraw it
    for (int i = first; i < n && i < first + SHOWN; i++) {
        if (!it[i].u) continue;
        const int64_t d = (int32_t)(now_ms - it[i].u->at_ms);   // ms since the entry, as row() reads it (negative: still "now")
        const int64_t secs = d > 0 ? d / 1000 : 0;
        const int64_t edge = secs < 60 ? 60 : secs < 3600 ? (secs / 60 + 1) * 60 : secs < 86400 ? (secs / 3600 + 1) * 3600 : (secs / 86400 + 1) * 86400;
        const int64_t ms = edge * 1000 - d;
        if (ms < next) next = ms;
    }
    return next < 1 ? 1u : (uint32_t)next;
}
