// Inbox and Apps (max_ui_draw.h): a header column, then cards in a row, newest notice or the daemon's first app first.
// What does not fit whole runs off the glass's right edge. Inbox: Close, "Inbox" and the unread count; a card per
// notice with its pet, its name in the kind's colour, its app, the word and how long ago, and its words; an unread
// card lit in its colour, with a dot that pulses (V3's: to .35 and back every 1.4 s, while any card is unread). Apps: "APPS", a card per app with its icon, name, agent count and a dot per
// agent, the shown app's card raised and marked; "+ New" last while the computer offers New Harness.
#include <stdio.h>
#include <string.h>

#include "max_ui_draw.h"

// A card, whole or cut by the glass's right edge. A cut one is drawn whole, its words and all, and the glass cuts it;
// only its box stops at the edge, its right side square there.
static void card_box(ht_scene_t *s, int x, int y, int w, int h, int r, int line, unsigned edge, unsigned fill)
{
    if (x + w <= HT_WIDTH) {
        max_box(s, x, y, w, h, r, line, edge, fill);
        return;
    }
    const int seen = HT_WIDTH - x;
    max_box(s, x, y, seen, h, r, line, edge, fill);
    if (seen <= r) return;
    ht_pro_rect(s, HT_WIDTH - r, y, r, line, 0, C(edge));
    ht_pro_rect(s, HT_WIDTH - r, y + h - line, r, line, 0, C(edge));
    ht_pro_rect(s, HT_WIDTH - r, y + line, r, h - 2 * line, 0, C(fill));
}
// A card's colour glowing out under it: a dithered ramp (light this faint bands in RGB565) with round ends, its top
// half under the card drawn over it.
static void glow_under(ht_scene_t *s, int x, int bottom, int w, unsigned ink)
{
    const int h = DY(24), inset = DX(14);
    pod_grad_aa_dither(s, x + inset, bottom - h, w - 2 * inset, 2 * h, h, C(max_mix(ink, GROUND, 40)), C(GROUND));
}

// ---- Inbox ----

enum {
    IB_HEAD_W = DX(220), IB_HEAD_X = DX(34), NOTES_X = IB_HEAD_W + DX(6), NOTE_W = DX(372), NOTE_GAP = DX(16),
    NOTE_Y = DY(24), NOTE_H = HT_HEIGHT - 2 * DY(24), NOTE_R = 28, NOTE_PAD_X = DX(24), NOTE_PAD_Y = DY(20),
    SLOT_W = DX(64), SLOT_H = DY(60), NOTE_ICON = DY(22), NOTE_DOT = DY(12),
};

static const char *kind_word(max_attn_t kind) { return kind == MAX_ATTN_ASK ? "asks" : kind == MAX_ATTN_DONE ? "is done" : "failed"; }

// One notice from x: its pet, its name in the kind's colour, its app, the word and how long ago, then its words.
static void note(ht_scene_t *s, int x, const max_inbox_t *n, uint32_t now_ms)
{
    const unsigned ink = max_kind_ink(n->kind), fill = n->unread ? NOTE_LIT : NOTE_BG;
    const int w = NOTE_W;
    if (n->unread) glow_under(s, x, NOTE_Y + NOTE_H, w, ink);
    card_box(s, x, NOTE_Y, w, NOTE_H, NOTE_R, n->unread ? 2 : 1, n->unread ? ink : NOTE_RIM, fill);
    const int top = NOTE_Y + NOTE_PAD_Y, slot_x = x + NOTE_PAD_X;
    // At rest, as the mockup's cards: the same size whatever the notice says.
    max_pet(s, n->engine, POD_SCENE_REST, slot_x + SLOT_W / 2, top + SLOT_H, SLOT_W * 3 / 5, SLOT_H, fill, 0, true);
    const int hx = slot_x + SLOT_W + DX(14), right = x + w - NOTE_PAD_X - (n->unread ? NOTE_DOT + DX(10) : 0);
    max_text(s, hx, top + DY(17), right - hx, &ph_sb_32, n->unread ? ink : max_mix(ink, fill, 75), n->name);
    const int sub_cy = top + DY(46);
    int sx = hx;
    if (n->app[0]) {
        max_app_icon(s, sx, sub_cy - NOTE_ICON / 2, NOTE_ICON, n->app, n->app);
        sx += NOTE_ICON + DX(8);
    }
    sx += max_text(s, sx, sub_cy, x + w - NOTE_PAD_X - sx, &ph_rg_24, DIM, kind_word(n->kind)) + DX(8);
    char ago[24];
    max_ago(ago, sizeof ago, n->at, now_ms);
    max_text(s, sx, sub_cy, x + w - NOTE_PAD_X - sx, &ph_rg_24, FAINT, ago);
    const int text_y = top + SLOT_H + DY(14), rows = (NOTE_Y + NOTE_H - NOTE_PAD_Y - text_y) / ph_rg_28.height;
    max_paragraph(s, x + NOTE_PAD_X, text_y, w - 2 * NOTE_PAD_X, &ph_rg_28, n->unread ? RECAP : REST, n->text,
                  rows < 4 ? rows : 4);
    if (n->unread)
        max_dot(s, x + w - DX(22) - NOTE_DOT, NOTE_Y + DY(22) + NOTE_DOT / 2, NOTE_DOT,
                max_mix_q(ink, fill, max_keyframes(max_loop(now_ms, 1400), MAX_ONE, MAX_PULSE_LOW, MAX_EASE_IN_OUT)));
}

void max_draw_inbox(ht_scene_t *s, uint32_t now_ms)
{
    const int round_cy = DY(114), x0 = IB_HEAD_X;
    max_round(s, x0 + ROUND_D / 2, round_cy, ROUND_D);
    const int icon = ROUND_D * 28 / 64;
    max_icon_x(s, x0 + ROUND_D / 2 - icon / 2, round_cy - icon / 2, icon, FG);
    max_text(s, x0, DY(180), IB_HEAD_W - x0, &ph_sb_34, FG, "Inbox");
    const int unread = max_unread();
    if (unread) {
        char line[24];
        snprintf(line, sizeof line, "%d unread", unread);
        max_text(s, x0, DY(225), IB_HEAD_W - x0, &ph_rg_24, WAIT, line);
    }
    max_hit(0, 0, IB_HEAD_W, HT_HEIGHT, MAX_HIT_CLOSE, 0);
    if (!max_m.inbox_count)
        max_text_centered(s, (NOTES_X + HT_WIDTH) / 2, HT_HEIGHT / 2, HT_WIDTH - NOTES_X - 40, &ph_rg_36, REST,
                          "Nothing new");
    for (int i = 0, x = NOTES_X; i < max_m.inbox_count && x < HT_WIDTH - NOTE_PAD_X - SLOT_W; i++, x += NOTE_W + NOTE_GAP) {
        note(s, x, &max_m.inbox[i], now_ms);
        max_hit(x, NOTE_Y, x + NOTE_W <= HT_WIDTH ? NOTE_W : HT_WIDTH - x, NOTE_H, MAX_HIT_NOTE, i);
    }
}

// ---- Apps ----

enum {
    AP_HEAD_W = DX(210), AP_HEAD_X = DX(34), CARDS_X = DX(211), APP_CARD_W = DX(176), APP_GAP = DX(16),
    APP_Y = DY(33), APP_H = DY(244), APP_RAISE = DY(6), APP_R = 28, APP_PAD_X = DX(20), APP_PAD_Y = DY(22),
    APP_ICON_D = DY(72), APP_DOT = DY(10), APP_DOTS = 8,
};

// The dots of an app's agents: the ring's own states for the shown app; for another, its waiting ones in yellow and
// the rest faint (the daemon counts them, it does not send their states).
static void app_dots(ht_scene_t *s, int x, int cy, const max_app_t *app, bool shown)
{
    const int n = shown ? max_m.count : app->count;
    for (int i = 0; i < n && i < APP_DOTS; i++) {
        const unsigned ink = shown ? max_state_ink(&max_m.agents[i]) : i < app->waiting ? WAIT : FAINT;
        max_dot(s, x + i * (APP_DOT + DX(6)), cy, APP_DOT, ink);
    }
}

// One card from x: an app (app != NULL) or "+ New".
static void app_card(ht_scene_t *s, int x, const max_app_t *app)
{
    const bool shown = app && !strcmp(app->id, max_m.shown);
    const int y = APP_Y - (shown ? APP_RAISE : 0), w = APP_CARD_W;
    if (shown) glow_under(s, x, y + APP_H, w, ACCENT);   // raised, in a lavender ring that glows out under it
    card_box(s, x, y, w, APP_H, APP_R, shown ? 2 : 1, shown ? ACCENT : APP_RIM, APP_BG);
    const int ix = x + APP_PAD_X, iy = y + APP_PAD_Y;
    if (app) {
        max_app_icon(s, ix, iy, APP_ICON_D, app->id, app->name);
    } else {
        max_box(s, ix, iy, APP_ICON_D, APP_ICON_D, APP_ICON_D * 14 / 60, 1, RIM, APP_BG);
        max_text_centered(s, ix + APP_ICON_D / 2, iy + APP_ICON_D / 2, APP_ICON_D, &ph_sb_48, DIM, "+");
    }
    const int tw = w - 2 * APP_PAD_X, name_cy = iy + APP_ICON_D + DY(32);
    max_text(s, ix, name_cy, tw, &ph_sb_32, FG, app ? app->name : "New");
    if (!app) return;
    char count[24];
    if (app->count == 1) snprintf(count, sizeof count, "1 agent");
    else if (app->count) snprintf(count, sizeof count, "%d agents", app->count);
    else snprintf(count, sizeof count, "No agents");
    max_text(s, ix, name_cy + DY(28), tw, &ph_rg_24, DIM, count);
    app_dots(s, ix, y + APP_H - APP_PAD_Y - APP_DOT / 2, app, shown);
    if (shown) max_text_right(s, x + w - DX(18), y + DY(28), tw / 2, &ph_sb_22, ACCENT, "Shown");
}

void max_draw_apps(ht_scene_t *s)
{
    static const char LETTERS[] = "APPS";
    int hx = AP_HEAD_X;
    for (int i = 0; LETTERS[i]; i++) {   // spaced out, as the mockup's 0.14 em
        const char one[2] = {LETTERS[i], 0};
        hx += max_text(s, hx, HT_HEIGHT / 2, DX(60), &ph_sb_26, DIM, one) + DX(3);
    }
    max_hit(0, 0, AP_HEAD_W, HT_HEIGHT, MAX_HIT_CLOSE, 0);
    const bool add = max_m.link && max_m.offers_form;
    const int cards = max_m.app_count + (add ? 1 : 0);
    for (int i = 0, x = CARDS_X; i < cards && x < HT_WIDTH - APP_PAD_X - APP_ICON_D / 2; i++, x += APP_CARD_W + APP_GAP) {
        const max_app_t *app = i < max_m.app_count ? &max_m.apps[i] : NULL;
        app_card(s, x, app);
        max_hit(x, APP_Y - APP_RAISE, x + APP_CARD_W <= HT_WIDTH ? APP_CARD_W : HT_WIDTH - x, APP_H + APP_RAISE,
                app ? MAX_HIT_APP : MAX_HIT_NEW, app ? i : 0);
    }
}
