// Attention (max_ui_draw.h) and New Harness. Attention: an agent needs the person. A light runs around the glass's
// edge in the kind's colour; the pet on the left; "name [app] asks" (or "wants to run", "is done", "failed") and the
// question, the command in mono or the summary. When the bar takes its answers, the options as buttons (a permission
// prompt's Allow and Deny) and Say it; when it does not, where to answer it. A tap outside the buttons brings the agent
// up on the computer. New Harness over the whole glass, in the same look.
#include <stddef.h>
#include <stdio.h>
#include <string.h>

#include "max_ui_draw.h"

enum {
    EDGE_T = DY(4), EDGE_SIDE = DX(4), EDGE_RUN = DX(340), EDGE_RUN_H = DY(120), EDGE_LOOP_MS = 2000,
    EDGE_FULL_MS = 4200, EDGE_FADE_MS = 1800, EDGE_GLOW = DY(16),
    AT_PET_W = DX(300), AT_PET_HALF = DX(120), AT_PET_H = DY(230), AT_X = DX(300), AT_R = HT_WIDTH - DX(60),
    AT_W = AT_R - AT_X, AT_ICON = DY(28), BTN_H = DY(58), BTN_PAD = DX(30), BTN_GAP = DX(14), BTN_ROW_GAP = DY(12),
    BTN_MIN_W = DX(110), WHO_H = 31, BTN_TOP = DY(22),
};
static const char CHECK[] = "\xe2\x9c\x93 ";   // a chosen option of several (gen_fonts.py CONSOLE_EXTRA draws it)

// ---- the edge light ----

// A bar of the light clipped to the glass.
static void bar(ht_scene_t *s, int x, int y, int w, int h, unsigned rgb)
{
    if (x < 0) w += x, x = 0;
    if (y < 0) h += y, y = 0;
    if (x + w > HT_WIDTH) w = HT_WIDTH - x;
    if (y + h > HT_HEIGHT) h = HT_HEIGHT - y;
    if (w > 0 && h > 0) ht_pro_rect(s, x, y, w, h, 0, C(rgb));
}
// The faint track around the glass and a bright run on each side, all four going round together once every
// EDGE_LOOP_MS from when Attention came up; after EDGE_FULL_MS the light fades to a quarter, as the mockup's.
static void edge(ht_scene_t *s, unsigned rgb, uint32_t now_ms)
{
    const uint32_t age = now_ms - max_m.attn_from;
    const unsigned level = age < EDGE_FULL_MS ? 100
                         : age < EDGE_FULL_MS + EDGE_FADE_MS ? 100 - 75 * (age - EDGE_FULL_MS) / EDGE_FADE_MS : 25;
    const unsigned lit = max_mix(rgb, GROUND, level), track = max_mix(rgb, GROUND, 22 * level / 100);
    const unsigned glow = max_mix(rgb, GROUND, 35 * level / 100);
    bar(s, 0, 0, HT_WIDTH, EDGE_T, track);
    bar(s, 0, HT_HEIGHT - EDGE_T, HT_WIDTH, EDGE_T, track);
    bar(s, 0, 0, EDGE_SIDE, HT_HEIGHT, track);
    bar(s, HT_WIDTH - EDGE_SIDE, 0, EDGE_SIDE, HT_HEIGHT, track);
    const int p = (int)(age % EDGE_LOOP_MS);
    const int across = -EDGE_RUN + p * (HT_WIDTH + EDGE_RUN) / EDGE_LOOP_MS;
    const int down = -EDGE_RUN_H + p * (HT_HEIGHT + EDGE_RUN_H) / EDGE_LOOP_MS;
    // Top left to right, right side down, bottom right to left, left side up; each with a soft glow inward.
    if (across + EDGE_RUN > 0 && across < HT_WIDTH) {
        const int x = across < 0 ? 0 : across, w = (across + EDGE_RUN > HT_WIDTH ? HT_WIDTH : across + EDGE_RUN) - x;
        pod_grad_aa(s, x, 0, w, EDGE_GLOW, 0, C(glow), C(GROUND));
        const int bx = HT_WIDTH - across - EDGE_RUN, bl = bx < 0 ? 0 : bx;
        const int bw = (bx + EDGE_RUN > HT_WIDTH ? HT_WIDTH : bx + EDGE_RUN) - bl;
        if (bw > 0) pod_grad_aa(s, bl, HT_HEIGHT - EDGE_GLOW, bw, EDGE_GLOW, 0, C(GROUND), C(glow));
    }
    bar(s, across, 0, EDGE_RUN, EDGE_T, lit);
    bar(s, HT_WIDTH - across - EDGE_RUN, HT_HEIGHT - EDGE_T, EDGE_RUN, EDGE_T, lit);
    bar(s, HT_WIDTH - 3 * EDGE_SIDE, down, 2 * EDGE_SIDE, EDGE_RUN_H, glow);
    bar(s, HT_WIDTH - EDGE_SIDE, down, EDGE_SIDE, EDGE_RUN_H, lit);
    bar(s, EDGE_SIDE, HT_HEIGHT - down - EDGE_RUN_H, 2 * EDGE_SIDE, EDGE_RUN_H, glow);
    bar(s, 0, HT_HEIGHT - down - EDGE_RUN_H, EDGE_SIDE, EDGE_RUN_H, lit);
    max_motion(now_ms, MAX_EDGE_FRAME_MS);
}

// ---- the answers ----

typedef struct {
    char label[PRO_OPTION_BYTES + sizeof CHECK];
    max_style_t style;
    max_hit_kind_t kind;
    int arg, w;
    bool mic, live;
} btn_t;

// The question's buttons: its options (a permission prompt's yes and no as Allow and Deny), the question before and
// Send (several choices, or Next before the last), Say it. Returns how many.
static int answers(btn_t b[], const max_agent_t *a, const max_ask_t *k)
{
    const max_item_t *it = &k->items[k->step];
    const bool ready = k->phase == MAX_ASK_READY;
    const uint8_t chosen = k->choices[k->step];
    int n = 0, yes = -1, no = -1;
    for (int j = 0; k->permission && j < it->option_count; j++) {
        if (yes < 0 && max_option_approves(it->options[j])) yes = j;
        if (no < 0 && max_option_rejects(it->options[j])) no = j;
    }
    if (yes >= 0 && no >= 0) {
        b[n++] = (btn_t){.label = "Allow", .style = STYLE_PRIMARY, .kind = MAX_HIT_OPTION, .arg = yes};
        b[n++] = (btn_t){.label = "Deny", .style = STYLE_REJECT, .kind = MAX_HIT_OPTION, .arg = no};
    } else {
        for (int j = 0; j < it->option_count; j++, n++) {
            const bool on = chosen & (1u << j);
            b[n] = (btn_t){.style = on ? STYLE_CHOSEN : STYLE_PLAIN, .kind = MAX_HIT_OPTION, .arg = j};
            snprintf(b[n].label, sizeof b[n].label, "%s%s", on && it->multi ? CHECK : "", it->options[j]);
        }
    }
    if (k->step) b[n++] = (btn_t){.label = "Back", .style = STYLE_GHOST, .kind = MAX_HIT_STEP_BACK};
    if (it->multi) {
        b[n] = (btn_t){.label = "Send", .style = chosen ? STYLE_PRIMARY : STYLE_OFF, .kind = MAX_HIT_SEND};
        if (k->step + 1 < k->count) snprintf(b[n].label, sizeof b[n].label, "Next");
        n++;
    }
    if (!k->permission && max_takes_voice(a))
        b[n++] = (btn_t){.label = "Say it", .style = STYLE_PLAIN, .kind = MAX_HIT_SAY_IT, .mic = true};
    for (int i = 0; i < n; i++) {
        // While an answer is read, goes or went, what was chosen stays lit and nothing can be pressed.
        b[i].live = ready && b[i].style != STYLE_OFF;
        if (!ready && b[i].style != STYLE_CHOSEN) b[i].style = STYLE_OFF;
        b[i].w = max_button_w(b[i].label, b[i].mic, BTN_PAD);
        if (b[i].w < BTN_MIN_W) b[i].w = BTN_MIN_W;
    }
    return n;
}

// The buttons on one row when they fit as wide as their words, else on two; a row too narrow shares its width out.
// Returns the rows.
static int lay_out(btn_t b[], int n, int row_of[])
{
    int total = (n - 1) * BTN_GAP;
    for (int i = 0; i < n; i++) total += b[i].w;
    const int rows = total <= AT_W || n < 2 ? 1 : 2, first = rows == 1 ? n : (n + 1) / 2;
    for (int r = 0; r < rows; r++) {
        const int from = r ? first : 0, to = r ? n : first;
        int sum = (to - from - 1) * BTN_GAP;
        for (int i = from; i < to; i++) sum += b[i].w, row_of[i] = r;
        if (sum <= AT_W) continue;
        for (int i = from; i < to; i++) b[i].w = (AT_W - (to - from - 1) * BTN_GAP) / (to - from);
    }
    return rows;
}

static void draw_buttons(ht_scene_t *s, const btn_t b[], int n, const int row_of[], int top)
{
    int x = AT_X, row = 0;
    for (int i = 0; i < n; i++) {
        if (row_of[i] != row) row = row_of[i], x = AT_X;
        const int y = top + row * (BTN_H + BTN_ROW_GAP);
        max_button(s, x, y, b[i].w, BTN_H, b[i].style, b[i].label, b[i].mic);
        if (b[i].live) max_hit(x, y, b[i].w, BTN_H, b[i].kind, b[i].arg);
        x += b[i].w + BTN_GAP;
    }
}

// ---- Attention ----

// What a permission prompt asks to run: the words after its first ": " ("Approve Bash command: make flash").
static const char *command_of(const char *prompt)
{
    const char *at = strstr(prompt, ": ");
    return at && at[2] ? at + 2 : prompt;
}

void max_draw_attention(ht_scene_t *s, const max_agent_t *a, uint32_t now_ms)
{
    const max_attn_t kind = max_m.attn;
    const unsigned ink = max_kind_ink(kind);
    edge(s, ink, now_ms);
    // The pet, centred in its column, moving.
    const pod_scene_t scene = max_pet_scene(a, false);
    const int pet_h = max_pet_h(a->engine, scene, AT_PET_HALF, AT_PET_H, false);
    max_pet(s, a->engine, scene, AT_PET_W / 2, HT_HEIGHT / 2 + pet_h / 2, AT_PET_HALF, AT_PET_H, GROUND, now_ms, false);
    max_motion(now_ms, max_pet_next_ms(a->engine, scene, now_ms));

    const max_ask_t *k = kind == MAX_ATTN_ASK && a->state == MAX_ASKING ? max_ask_of(a->id) : NULL;
    const max_item_t *it = k && k->count ? &k->items[k->step] : NULL;
    const bool answers_here = it && max_takes_answers(a);
    max_copy(max_m.card_id, sizeof max_m.card_id, a->id);
    max_m.card_key = max_card_key(a);

    // What it says, and how: the question, the command in mono, or the turn's summary in the recap's ink.
    const char *say = kind == MAX_ATTN_ASK ? (it ? it->q : a->question) : a->note;
    const bool permission = k && k->permission;
    const ht_pro_font_t *f = permission ? &ph_mono_26 : &ph_rg_36;
    const unsigned say_ink = permission ? MONO_INK : kind == MAX_ATTN_ASK ? FG : RECAP;
    if (permission) say = command_of(say);
    btn_t b[PRO_ASK_OPTIONS + 3];
    int row_of[PRO_ASK_OPTIONS + 3], n = 0, rows = 0;
    const char *row_note = NULL;   // beside the buttons: why it failed, or what the daemon said of an answer in
    unsigned note_ink = REST;
    if (answers_here) {
        if (k->phase == MAX_ASK_FAILED) {
            if (k->path == MAX_PATH_REVIEWED) {
                b[n] = (btn_t){.label = "Reload", .style = STYLE_GHOST, .kind = MAX_HIT_RELOAD, .live = true};
                b[n].w = max_button_w(b[n].label, false, BTN_PAD), row_of[n] = 0, n++;
            }
            row_note = k->note, note_ink = FAIL;
        } else {
            n = answers(b, a, k);
            if (k->phase == MAX_ASK_SENT && k->note[0]) row_note = k->note;
        }
        rows = n ? lay_out(b, n, row_of) : 0;
        // The notice at the foot already says it: not twice on one glass.
        if (row_note && max_notice_shown(now_ms) && !strcmp(max_m.notice, row_note)) row_note = NULL;
    }
    const char *hint = NULL;
    char where[CABLE_NAME_MAX + 24];
    if (kind == MAX_ATTN_ASK && !answers_here) {
        const char *app = k && k->app[0] ? k->app : max_app_of(a);
        snprintf(where, sizeof where, "Answer it %s%s", app[0] ? "in " : "on the computer", app);
        hint = where;
    }
    // The daemon's line for a wait the bar only shows ends in " · answer in <App>" (devices.ts showWaits), which the hint
    // under it already says: not twice on one glass.
    char line[MAX_QUESTION_BYTES];
    if (hint && say) {
        static const char TAIL[] = " \xc2\xb7 answer in ";
        const char *cut = NULL;
        for (const char *at = strstr(say, TAIL); at; at = strstr(at + 1, TAIL)) cut = at;
        if (cut && cut > say) {
            max_copy(line, sizeof line, say);
            line[cut - say < (ptrdiff_t)sizeof line ? cut - say : (ptrdiff_t)sizeof line - 1] = 0;
            say = line;
        }
    }
    // Rows of words: three alone, two over a row of buttons, one over two.
    char text[3][ROW_BYTES];
    const int most = rows == 2 ? 1 : rows || (hint || (row_note && !n)) ? 2 : 3;
    const int lines = say && say[0] ? max_wrap(text, most, say, f, AT_W) : 0;
    const int buttons_h = rows ? BTN_TOP + rows * BTN_H + (rows - 1) * BTN_ROW_GAP : 0;
    const int after_h = rows ? buttons_h : hint || row_note ? BTN_TOP + ph_rg_28.height : 0;
    const int block = WHO_H + DY(12) + lines * f->height + after_h;
    int y = (HT_HEIGHT - block) / 2;

    // "name [app] asks": the name in the kind's colour, the app's icon, the verb (or the answer's phase).
    const char *verb = kind == MAX_ATTN_DONE ? "is done" : kind == MAX_ATTN_FAIL ? "failed"
                     : k && k->phase == MAX_ASK_SENDING ? "Sending\xe2\x80\xa6" : k && k->phase == MAX_ASK_SENT ? "Sent"
                     : permission ? "wants to run" : "asks";
    const int who_cy = y + WHO_H / 2;
    int x = AT_X + max_text(s, AT_X, who_cy, AT_W / 2, &ph_sb_26, ink, a->name) + DX(12);
    const char *app_id = a->host[0] ? a->host : max_m.shown;
    if (app_id[0]) {
        const max_app_t *shown = max_shown_app();
        max_app_icon(s, x, who_cy - AT_ICON / 2, AT_ICON, app_id, shown && !strcmp(shown->id, app_id) ? shown->name : "");
        x += AT_ICON + DX(12);
    }
    x += max_text(s, x, who_cy, AT_R - x, &ph_rg_28, DIM, verb);
    if (k && k->count > 1) {
        char step[16];
        snprintf(step, sizeof step, "%d / %d", k->step + 1, k->count);
        max_text(s, x + DX(12), who_cy, AT_R - x - DX(12), &ph_rg_28, FAINT, step);
    }
    y += WHO_H + DY(12);
    for (int i = 0; i < lines; i++) ht_pro_text(s, AT_X, y + i * f->height, AT_W, f, C(say_ink), text[i]);
    y += lines * f->height + BTN_TOP;

    if (n) draw_buttons(s, b, n, row_of, y);
    if (row_note && row_note[0]) {   // after the last button, or alone where the buttons would be
        int left = AT_X;
        for (int i = 0; i < n; i++)
            if (row_of[i] == rows - 1) left += b[i].w + BTN_GAP;
        const int cy = n ? y + (rows - 1) * (BTN_H + BTN_ROW_GAP) + BTN_H / 2 : y + ph_rg_28.height / 2;
        max_text(s, left + (n ? DX(10) : 0), cy, AT_R - left, &ph_rg_28, note_ink, row_note);
    }
    if (hint) max_text(s, AT_X, y + ph_rg_28.height / 2, AT_W, &ph_rg_28, REST, hint);
    max_hit(0, 0, HT_WIDTH, HT_HEIGHT, MAX_HIT_AWAY, 0);   // last: anywhere else brings the agent up on the computer
}

// ---- New Harness ----

enum { SIDE_W = 280, BACK_W = 180, ACTION_W = 240, SAY_W = 160, FORM_R = 34 };
#define LABEL (&ph_sb_22)

// A neighbour of the focused choice: the arrow and its words, a tap away.
static void side(ht_scene_t *s, int x, int y, int w, int h, const char *arrow, const char *t, bool on, int delta)
{
    if (!t[0]) return;
    max_box(s, x, y, w, h, BUTTON_R, 1, RIM, CARD);
    const int tx = x + FORM_PAD, tw = w - 2 * FORM_PAD;
    max_text(s, tx, y + MAX_Y(36), tw, &ph_sb_26, on ? FG : FAINT, arrow);
    const int rows = (h - MAX_Y(64)) / ph_rg_24.height;
    max_paragraph(s, tx, y + MAX_Y(58), tw, &ph_rg_24, DIM, t, rows);
    if (on) max_hit(x, y, w, h, MAX_HIT_FORM_MOVE, delta);
}

// The detail's lines, each wrapped, in at most `rows` rows.
static void detail(ht_scene_t *s, int x, int y, int w, int rows, unsigned ink, const char *t)
{
    char part[sizeof max_m.form.page.detail];
    while (*t && rows > 0) {
        const char *end = strchr(t, '\n');
        const size_t n = end ? (size_t)(end - t) : strlen(t);
        snprintf(part, sizeof part, "%.*s", (int)n, t);
        const int below = max_paragraph(s, x, y, w, &ph_rg_24, ink, part, rows);
        rows -= (below - y) / ph_rg_24.height;
        y = below;
        t += n + (end ? 1 : 0);
    }
}

void max_draw_form(ht_scene_t *s)
{
    const max_form_t *f = &max_m.form;
    const max_page_t *p = &f->page;
    const int x = FORM_X, w = FORM_W, tx = x + FORM_PAD, tw = w - 2 * FORM_PAD;
    max_box(s, x, MAX_CARD_Y, w, MAX_CARD_H, FORM_R, 1, RIM, GROUND);
    max_m.form_revision = p->revision;
    // A recording: a spoken name for the field (Say starts it, talk_id ""), or one for an agent the form now covers.
    // Cancel and Send stay at hand; nothing else acts until it ends, so the rest shows it cannot be pressed.
    const bool talking = max_m.talk != MAX_TALK_IDLE;
    const bool live = p->active && !f->failed;                          // a page the finger can work
    const bool idle = live && !f->pending && !p->busy && !talking;      // and nothing in flight

    // The title, where in the form, and Close.
    const int head_y = FORM_HEAD_Y, head_cy = head_y + MAX_BUTTON_H / 2;
    max_button(s, FORM_CLOSE_X, head_y, FORM_CLOSE_W, MAX_BUTTON_H, talking ? STYLE_OFF : STYLE_PLAIN, "Close", false);
    if (!talking) max_hit(FORM_CLOSE_X, head_y, FORM_CLOSE_W, MAX_BUTTON_H, MAX_HIT_FORM_CLOSE, 0);
    const int title_w = max_text(s, tx, head_cy, tw / 3, &ph_sb_26, FG, p->title[0] ? p->title : "New Harness");
    char where[24] = "";
    if (p->total) snprintf(where, sizeof where, "%d / %d", (int)p->position, (int)p->total);
    max_text(s, tx + title_w + 24, head_cy, tw / 3 - 24, LABEL, DIM, p->query[0] ? p->query : where);

    // The choices: the one before, the focused one, the one after.
    const int foot_y = MAX_CARD_Y + MAX_CARD_H - MAX_Y(16) - MAX_BUTTON_H;
    const int top = FORM_CHOICES_Y, h = foot_y - MAX_Y(16) - top;
    const bool moves = live && !p->busy && !talking;
    side(s, tx, top, SIDE_W, h, "\xe2\x86\x90", p->previous, moves, -1);
    side(s, tx + tw - SIDE_W, top, SIDE_W, h, "\xe2\x86\x92", p->next, moves, 1);
    const int fx = tx + SIDE_W + 16, fw = tw - 2 * (SIDE_W + 16);
    max_box(s, fx, top, fw, h, BUTTON_R, live ? 2 : 1, live ? ACCENT : RIM, CARD);
    const char *label = p->label[0] ? p->label : f->failed ? "Could not open" : "Opening\xe2\x80\xa6";
    const int label_cy = top + MAX_Y(40);
    max_text(s, fx + FORM_PAD, label_cy, fw - 2 * FORM_PAD, &ph_sb_34, p->label[0] ? FG : DIM, label);
    const int detail_y = label_cy + ph_sb_34.height / 2 + 4;
    detail(s, fx + FORM_PAD, detail_y, fw - 2 * FORM_PAD, (top + h - MAX_Y(12) - detail_y) / ph_rg_24.height, DIM,
           p->detail);
    if (idle && p->enabled) max_hit(fx, top, fw, h, MAX_HIT_FORM_PICK, 0);

    // Back, what is happening, Say and the action; while a name is spoken, Cancel and Send.
    if (!f->failed) {
        max_button(s, tx, foot_y, BACK_W, MAX_BUTTON_H, idle ? STYLE_PLAIN : STYLE_OFF, "Back", false);
        if (idle) max_hit(tx, foot_y, BACK_W, MAX_BUTTON_H, MAX_HIT_FORM_BACK, 0);
    }
    const int action_x = tx + tw - ACTION_W, say_x = action_x - 24 - SAY_W, foot_cy = foot_y + MAX_BUTTON_H / 2;
    const bool say = !talking && max_form_can_say();
    const int mid_x = f->failed ? tx : tx + BACK_W + 24, mid_w = (say || talking ? say_x : action_x) - 24 - mid_x;
    if (talking) max_text(s, mid_x, foot_cy, mid_w, LABEL, VOICE, max_m.talk == MAX_TALK_RECORDING ? "Listening" : "Sending\xe2\x80\xa6");
    else if (p->error[0]) max_text(s, mid_x, foot_cy, mid_w, LABEL, FAIL, p->error);
    else if (p->status[0]) max_text(s, mid_x, foot_cy, mid_w, LABEL, DIM, p->status);
    if (talking) {
        if (max_m.talk != MAX_TALK_RECORDING) return;
        max_button(s, say_x, foot_y, SAY_W, MAX_BUTTON_H, STYLE_PLAIN, "Cancel", false);
        max_hit(say_x, foot_y, SAY_W, MAX_BUTTON_H, MAX_HIT_TALK_CANCEL, 0);
        max_button(s, action_x, foot_y, ACTION_W, MAX_BUTTON_H, STYLE_PRIMARY, "Send", false);
        max_hit(action_x, foot_y, ACTION_W, MAX_BUTTON_H, MAX_HIT_TALK_SEND, 0);
        return;
    }
    if (say) {
        max_button(s, say_x, foot_y, SAY_W, MAX_BUTTON_H, STYLE_PLAIN, "Say", true);
        max_hit(say_x, foot_y, SAY_W, MAX_BUTTON_H, MAX_HIT_FORM_SAY, 0);
    }
    char action[32];
    snprintf(action, sizeof action, "%s", f->failed ? "Retry" : p->busy ? "Wait" : p->action[0] ? p->action : "Choose");
    if (action[0] >= 'a' && action[0] <= 'z') action[0] = (char)(action[0] - 'a' + 'A');   // "check status": "Check status"
    const bool act = f->failed || (idle && p->enabled);
    max_button(s, action_x, foot_y, ACTION_W, MAX_BUTTON_H, act ? STYLE_PRIMARY : STYLE_OFF, action, false);
    if (act) max_hit(action_x, foot_y, ACTION_W, MAX_BUTTON_H, f->failed ? MAX_HIT_FORM_RETRY : MAX_HIT_FORM_PICK, 0);
}
