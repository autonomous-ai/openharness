// Inbox and Apps (max_ui_draw.h): a header column, then cards in a row, newest notice or the daemon's first app first.
// Inbox: Close, "Inbox" and the unread count; a card per notice with its pet, its name in the kind's colour, its app,
// the word and how long ago, and its words; an unread card lit in its colour, with a dot that pulses (V3's: to .35 and
// back every 1.4 s, while any card is unread); what does not fit whole runs off the glass's right edge. Apps: Close,
// "Apps" and how many wait; a card per app with its icon, name, agent count and a dot per agent, coloured by its
// state; "+ New" last while the computer offers New Harness; the cards share the width, or the finger drags them.
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
    // TEMP (the owner's call of 23 Nov, to try the update screen): Try update, at the column's foot level with the
    // cards' and ahead of Close, whose column it lies in, plays an update on the glass. Goes with MAX_HIT_TRY_UPDATE.
    const int try_y = NOTE_Y + NOTE_H - MAX_BUTTON_H, try_w = IB_HEAD_W - x0 - DX(20);
    max_button(s, x0, try_y, try_w, MAX_BUTTON_H, STYLE_GHOST, "Try update", false);
    max_hit(x0, try_y, try_w, MAX_BUTTON_H, MAX_HIT_TRY_UPDATE, 0);
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

// The header column as Inbox's, as wide as App Detail's app column, so Close lies where the app's icon was: Close,
// "Apps" and how many agents wait across the apps. Then a card per app, "+ New" last while the computer offers New
// Harness (the owner's A' of 25 Nov). Up to AP_FIT cards share the width, at most AP_WIDE each, centred as one group;
// more are AP_CARD_W each (wider than the 254 they were), the next one past the glass's edge, and the finger drags
// them (max_ui_row.c) under the header column. A card's colours say its state as App Detail's cells do: an app with
// agents waiting has a yellow edge along its top, a yellow glow down from it and "N waiting"; the shown one a lavender
// ring, edge and glow and "SHOWN". The 8.8" glass's 1920 x 480 is the one this is laid out for.
enum {
    AP_HEAD_W = APP_W, AP_HEAD_X = IB_HEAD_X, CARDS_X = AP_HEAD_W, CARDS_W = HT_WIDTH - DX(28) - CARDS_X,
    AP_CARD_W = DX(224), AP_WIDE = DX(308), AP_GAP = DX(16), AP_FIT = (CARDS_W + AP_GAP) / (AP_CARD_W + AP_GAP),
    APP_Y = DY(27), APP_H = HT_HEIGHT - 2 * APP_Y, APP_R = 30, APP_PAD_X = DX(23), APP_PAD_Y = DY(23),
    APP_ICON_D = DY(72), APP_DOT = DY(10), APP_DOTS = 8, APP_GLOW_H = DY(160), PILL_H = DY(34),
    PILL_CY = APP_Y + APP_H - DY(17) - PILL_H / 2, DOTS_CY = PILL_CY - PILL_H / 2 - DY(20) - APP_DOT / 2,
    PILL_PAD = DX(16), PILL_DOT = DX(8), PILL_GAP = DX(8), PAGE_DOT = DY(8),
    AP_FADE_SLOP = DX(4), AP_FADE_MS = 250,
};

static int imin(int a, int b) { return a < b ? a : b; }
static int imax(int a, int b) { return a > b ? a : b; }

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

// "N waiting" in App Detail's waiting chip (.15 over the card, its rim .4), from x, centred on cy.
static void wait_pill(ht_scene_t *s, int x, int cy, int n, int max_w)
{
    char words[24];
    snprintf(words, sizeof words, "%d waiting", n);
    const int w = imin(max_w, 2 * PILL_PAD + PILL_DOT + PILL_GAP + ht_pro_width(&ph_sb_22, words)), tx = x + PILL_PAD +
                  PILL_DOT + PILL_GAP;
    max_box(s, x, cy - PILL_H / 2, w, PILL_H, PILL_H / 2, 1, max_mix(WAIT, APP_BG, 40), max_mix(WAIT, APP_BG, 15));
    max_dot(s, x + PILL_PAD, cy, PILL_DOT, WAIT);
    max_text(s, tx, cy, x + w - PILL_PAD - tx, &ph_sb_22, WAIT, words);
}

// One card from x, w wide: an app (app != NULL) or "+ New". The glass cuts one past its right edge; of one that starts
// left of the glass, under the header column, only a sliver of its box shows past the column.
static void app_card(ht_scene_t *s, int x, int w, const max_app_t *app)
{
    const bool shown = app && !strcmp(app->id, max_m.shown);
    const int waiting = app ? app->waiting : 0, line = shown ? 2 : 1;
    const unsigned ink = shown ? ACCENT : waiting ? WAIT : 0;
    const unsigned rim = shown ? ACCENT : waiting ? max_mix(WAIT, APP_BG, 34) : APP_RIM;
    if (x < 0) {
        max_box(s, 0, APP_Y, x + w, APP_H, APP_R, line, rim, APP_BG);
        return;
    }
    // The state's edge: a box in its colour under the card, which lies RAIL_H lower, shows along the card's top.
    const int top = ink ? RAIL_H : 0;
    if (ink) card_box(s, x, APP_Y, w, APP_H, APP_R, 0, ink, ink);
    card_box(s, x, APP_Y + top, w, APP_H - top, APP_R, line, rim, APP_BG);
    if (ink)
        pod_grad_aa_dither(s, x + line, APP_Y + top + line, w - 2 * line, APP_GLOW_H, APP_R - line,
                           C(max_mix(ink, APP_BG, shown ? 17 : 10)), C(APP_BG));
    const int ix = x + APP_PAD_X, iy = APP_Y + APP_PAD_Y, tw = w - 2 * APP_PAD_X;
    if (app) {
        max_app_icon(s, ix, iy, APP_ICON_D, app->id, app->name);
    } else {
        max_box(s, ix, iy, APP_ICON_D, APP_ICON_D, APP_ICON_D * 14 / 60, 1, RIM, APP_BG);
        max_text_centered(s, ix + APP_ICON_D / 2, iy + APP_ICON_D / 2, APP_ICON_D, &ph_sb_48, DIM, "+");
    }
    if (shown) max_text_right(s, x + w - DX(18), APP_Y + DY(28), tw / 2, &ph_sb_22, ACCENT, "SHOWN");
    const int name_cy = iy + APP_ICON_D + DY(32);
    max_text(s, ix, name_cy, tw, &ph_sb_32, FG, app ? app->name : "New");
    char count[24];
    if (!app) snprintf(count, sizeof count, "Harness agent");
    else if (app->count == 1) snprintf(count, sizeof count, "1 agent");
    else if (app->count) snprintf(count, sizeof count, "%d agents", app->count);
    else snprintf(count, sizeof count, "No agents");
    max_text(s, ix, name_cy + DY(28), tw, &ph_rg_24, DIM, count);
    if (!app) return;
    app_dots(s, ix, DOTS_CY, app, shown);
    if (waiting) wait_pill(s, x + APP_PAD_X - DX(5), PILL_CY, waiting, w - 2 * (APP_PAD_X - DX(5)));
}

// Where the cards rest as Apps comes up: from the first, or as little further as puts the shown app's card whole on
// the glass, a card's edge on the cards' left edge.
static int fresh_px(int w, int end)
{
    const int step = w + AP_GAP;
    for (int i = 0; i < max_m.app_count; i++) {
        if (strcmp(max_m.apps[i].id, max_m.shown)) continue;
        const int need = i * step + w - CARDS_W;
        return need > 0 ? imin((need + step - 1) / step * step, end) : 0;
    }
    return 0;
}

void max_draw_apps(ht_scene_t *s, uint32_t now_ms)
{
    max_strip_t *st = &max_m.strip;
    const bool add = max_m.link && max_m.offers_form;
    const int n = max_m.app_count + (add ? 1 : 0);
    const bool fit = n <= AP_FIT;
    const int w = !n ? AP_WIDE : fit ? imin(AP_WIDE, (CARDS_W - (n - 1) * AP_GAP) / n) : AP_CARD_W;
    const int total = n ? n * w + (n - 1) * AP_GAP : 0, end = fit ? 0 : total - CARDS_W;
    st->end = end;
    st->step = w + AP_GAP;
    st->left = CARDS_X;
    if (!st->had) {   // a fresh page: the cards where they rest, the finger off them
        max_tween_rest(&st->px, fresh_px(w, end));
        st->grab = st->drag = false;
    }
    const int px = max_strip_px(now_ms);
    // The header column's hits first: they lie over the cards that went under it. TEMP (the owner's call of 20 Nov, to
    // try Ambient): Relax, unseen, right under "Apps", opens Ambient, ahead of Close, whose column it lies in. Goes with
    // MAX_HIT_RELAX.
    max_hit(AP_HEAD_X - DX(14), DY(180) + DY(22), DX(150), MAX_BUTTON_H, MAX_HIT_RELAX, 0);
    max_hit(0, 0, AP_HEAD_W, HT_HEIGHT, MAX_HIT_CLOSE, 0);
    const int x0 = (fit ? CARDS_X + (CARDS_W - total) / 2 : CARDS_X) - px;
    for (int i = 0, x = x0; i < n && x < HT_WIDTH; i++, x += w + AP_GAP) {
        if (x + w <= CARDS_X) continue;   // all of it under the header column
        const max_app_t *app = i < max_m.app_count ? &max_m.apps[i] : NULL;
        app_card(s, x, w, app);
        const int l = imax(x, CARDS_X), r = imin(x + w, HT_WIDTH);
        if (r - l >= DX(32)) max_hit(l, APP_Y, r - l, APP_H, app ? MAX_HIT_APP : MAX_HIT_NEW, app ? i : 0);
    }
    // The header column, over what of the cards went under it.
    if (px > 0) ht_pro_rect(s, 0, 0, AP_HEAD_W, HT_HEIGHT, 0, C(GROUND));
    const int round_cy = DY(114), hx = AP_HEAD_X;
    max_round(s, hx + ROUND_D / 2, round_cy, ROUND_D);
    const int icon = ROUND_D * 28 / 64;
    max_icon_x(s, hx + ROUND_D / 2 - icon / 2, round_cy - icon / 2, icon, FG);
    max_text(s, hx, DY(180), AP_HEAD_W - hx, &ph_sb_34, FG, "Apps");
    int waiting = 0;
    for (int i = 0; i < max_m.app_count; i++) waiting += max_m.apps[i].waiting;
    if (waiting) {
        char line[24];
        snprintf(line, sizeof line, "%d waiting", waiting);
        max_text(s, hx, DY(225), AP_HEAD_W - hx, &ph_rg_24, WAIT, line);
    }
    // Past the glass: the ends fade where more cards lie that way, and a dot a glass of cards, the one on the glass lit.
    const int32_t left = px > AP_FADE_SLOP ? MAX_ONE : 0, right = px < end - AP_FADE_SLOP ? MAX_ONE : 0;
    if (!st->had) {
        max_tween_rest(&st->fade_l, left);
        max_tween_rest(&st->fade_r, right);
    } else {
        max_tween_to(&st->fade_l, left, AP_FADE_MS, MAX_EASE, now_ms);
        max_tween_to(&st->fade_r, right, AP_FADE_MS, MAX_EASE, now_ms);
    }
    max_fade_end(s, CARDS_X, false, max_tween_at(&st->fade_l, now_ms));
    max_fade_end(s, HT_WIDTH, true, max_tween_at(&st->fade_r, now_ms));
    if (end > 0) {
        const int pages = (n + AP_FIT - 1) / AP_FIT, on = (px * (pages - 1) + end / 2) / end;
        for (int i = 0; i < pages; i++)
            max_dot(s, hx + i * (PAGE_DOT + DX(8)), PILL_CY, PAGE_DOT, i == on ? FG : RIM);
    }
    if (!max_tween_done(&st->px, now_ms) || !max_tween_done(&st->fade_l, now_ms) ||
        !max_tween_done(&st->fade_r, now_ms))
        max_motion(now_ms, MAX_ROW_FRAME_MS);
    st->drawn = true;
}
