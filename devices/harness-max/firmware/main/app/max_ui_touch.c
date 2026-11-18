// The finger on the pages (max_ui.h): a tap acts on what the last render drew (its hits first, then Overview's
// cells), a sideways swipe pages Overview's cells, walks the ring on the agent page, or moves the form's choice. A tap
// on a card's button or the form queues its message in the outbox. While a recording is up the page is its send: X
// cancels it, Back and the strip send what was heard (else drop it) and go on, any other tap sends it. The clock's
// side of a recording is max_ui_talk_due.
#include <stdio.h>
#include <string.h>

#include "max_ui_internal.h"

static int iabs(int v) { return v < 0 ? -v : v; }
static bool inside(max_box_t b, int x, int y) { return x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h; }
static bool on_hit(const max_hit_t *h, int x, int y) { return x >= h->x && x < h->x + h->w && y >= h->y && y < h->y + h->h; }
static bool reached(uint32_t at, uint32_t now_ms) { return (int32_t)(now_ms - at) >= 0; }

static max_act_t act_for(max_act_kind_t kind, const char *id)
{
    max_act_t act = {kind, "", "", 0, ""};
    max_copy(act.agent_id, sizeof act.agent_id, id);
    return act;
}
static max_act_t nothing(void) { return act_for(MAX_ACT_NONE, NULL); }

static void go(max_view_t view)
{
    if (max_show(view)) max_m.dirty = true;
}

static void show_agent(const char *id)
{
    max_copy(max_m.selected, sizeof max_m.selected, id);
    max_show(MAX_VIEW_AGENT);
    max_m.dirty = true;
}

// ---- a recording ----

// What was recorded goes, and the notice names who to (the form's spoken name needs none: the form shows it).
static max_act_t send_talk(uint32_t now_ms)
{
    if (max_m.talk_id[0]) {
        static char text[MAX_NOTICE_BYTES];   // the touch task's 1 KB frame
        const max_agent_t *a = max_find(max_m.talk_id);
        if (a) snprintf(text, sizeof text, "Sent to %s", a->name);
        else snprintf(text, sizeof text, "Sent");
        max_notice_set(text, now_ms);
    }
    max_m.dirty = true;
    return act_for(MAX_ACT_SEND, max_m.talk_id);
}

// Sent by a tap on the page or by the clock: words to an agent that asked are its answer, so the question waiting
// longest takes the glass, as after a tapped answer; else Overview. The form's spoken name leaves the page as it is.
static max_act_t send_onward(uint32_t now_ms)
{
    const max_agent_t *a = max_m.talk_id[0] ? max_find(max_m.talk_id) : NULL;
    if (a && a->state == MAX_ASKING) max_next_question(a->id, now_ms);
    else if (max_m.talk_id[0]) max_show(MAX_VIEW_OVERVIEW);
    return send_talk(now_ms);
}

// The person moved on while it recorded (Back, the strip, a swipe, its agent gone): what was heard goes, else nothing.
static max_act_t settle_talk(uint32_t now_ms)
{
    if (max_m.talk_heard) return send_talk(now_ms);
    max_m.dirty = true;
    return act_for(MAX_ACT_CANCEL, max_m.talk_id);
}

max_act_t max_ui_talk_due(uint32_t now_ms)
{
    if (max_m.talk != MAX_TALK_RECORDING || !max_m.link) return nothing();
    if (max_m.talk_id[0] && !max_find(max_m.talk_id)) {   // its agent left the ring: its page went with it
        go(MAX_VIEW_OVERVIEW);
        return settle_talk(now_ms);
    }
    if (max_m.talk_heard) {
        if (!reached(max_m.talk_quiet_from + MAX_SILENCE_MS, now_ms)) return nothing();
        return send_onward(now_ms);
    }
    if (!reached(max_m.talk_from + MAX_HEAR_MS, now_ms)) return nothing();
    max_notice_set("Mic closed \xc2\xb7 tap to talk", now_ms);   // the page stays: a tap opens it again
    max_m.dirty = true;
    return act_for(MAX_ACT_CANCEL, max_m.talk_id);
}

// ---- the pages ----

// The agent opens on the computer (the daemon turns to its app), and the bar says where.
static max_act_t bring_up(const char *id, const char *name, const char *app, uint32_t now_ms)
{
    static char text[MAX_NOTICE_BYTES];   // the touch task's 1 KB frame
    if (app && app[0]) snprintf(text, sizeof text, "%s is up in %s", name, app);
    else snprintf(text, sizeof text, "%s is up", name);
    max_notice_set(text, now_ms);
    go(MAX_VIEW_OVERVIEW);
    max_m.dirty = true;
    return act_for(MAX_ACT_OPEN, id);
}

// The mic for this agent, from the page that shows it.
static max_act_t talk_to(const max_agent_t *a, max_act_kind_t kind)
{
    max_copy(max_m.talk_id, sizeof max_m.talk_id, a->id);
    return act_for(kind, a->id);
}

// A cell, as drawn: the cell's agent even if the ring moved since; gone from the ring, it opens nothing.
static max_act_t open_cell(const char *id, uint32_t now_ms)
{
    const max_agent_t *a = max_find(id);
    if (!a) return nothing();
    if (a->state == MAX_ASKING) {   // its question first: nothing is recorded
        max_attention(a->id, MAX_ATTN_ASK, now_ms);
        max_m.dirty = true;
        return nothing();
    }
    show_agent(a->id);
    if (max_can_talk(a) && max_takes_voice(a)) return talk_to(a, MAX_ACT_OPEN_TALK);
    return act_for(MAX_ACT_OPEN, a->id);   // no voice now: "Talk to it in <App>"
}

// An Inbox card: a question still open that the bar answers is its Attention; anything else is brought up on the
// computer, under the name and app the notice kept (its agent may have left the ring).
static max_act_t open_note(int i, uint32_t now_ms)
{
    if (max_m.view != MAX_VIEW_INBOX || i < 0 || i >= max_m.inbox_count) return nothing();
    const max_inbox_t *n = &max_m.inbox[i];
    if (!max_m.link) {   // nobody to bring it up
        max_notice_set("Not connected", now_ms);
        max_m.dirty = true;
        return nothing();
    }
    const max_agent_t *a = max_find(n->id);
    if (a && a->state == MAX_ASKING && max_takes_answers(a)) {
        max_attention(a->id, MAX_ATTN_ASK, now_ms);
        max_m.dirty = true;
        return nothing();
    }
    return bring_up(n->id, n->name, n->app, now_ms);
}

// A button of a page, the toast, the card or the form. A page's buttons act only while that page is up (a tap can land
// between a change and the redraw). The card must still be the one the person saw: the same question, at the same
// step, in the same phase; the form's page the one drawn.
static max_act_t press(const max_hit_t *h, uint32_t now_ms)
{
    const max_form_t *f = &max_m.form;
    const bool page = max_form_open() && f->page.revision == max_m.form_revision;
    const max_view_t view = max_m.view;
    bool changed = false;
    switch ((max_hit_kind_t)h->kind) {
    case MAX_HIT_BELL: go(MAX_VIEW_INBOX); break;
    case MAX_HIT_APPS:
        if (max_m.apps_known) go(MAX_VIEW_APPS);
        break;
    case MAX_HIT_APP: {   // the daemon turns to it, and its next `apps` names it shown
        if (view != MAX_VIEW_APPS || h->arg < 0 || h->arg >= max_m.app_count) break;
        max_act_t act = act_for(MAX_ACT_PICK, NULL);
        max_copy(act.app, sizeof act.app, max_m.apps[h->arg].id);
        go(MAX_VIEW_OVERVIEW);
        return act;
    }
    case MAX_HIT_CLOSE:
    case MAX_HIT_WAKE:
    case MAX_HIT_BACK: go(MAX_VIEW_OVERVIEW); break;
    case MAX_HIT_NOTE: return open_note(h->arg, now_ms);
    case MAX_HIT_SEG:
        if (view == MAX_VIEW_AGENT && h->arg >= 0 && h->arg < MAX_SEGS && max_find(max_m.seg_id[h->arg]))
            show_agent(max_m.seg_id[h->arg]);
        break;
    case MAX_HIT_BODY: {   // the mic, or the computer when the bar cannot listen for it now
        const max_agent_t *a = view == MAX_VIEW_AGENT ? max_find(max_m.selected) : NULL;
        if (!a) break;
        if (max_can_talk(a) && max_takes_voice(a)) return talk_to(a, MAX_ACT_TALK);
        return act_for(MAX_ACT_OPEN, a->id);
    }
    case MAX_HIT_SAY_IT: {   // the answer in words, on the agent's page (a permission prompt takes Yes or No only)
        const bool asks = view == MAX_VIEW_ATTENTION && max_m.attn == MAX_ATTN_ASK;
        const max_agent_t *a = asks ? max_find(max_m.attn_id) : NULL;
        if (!a || !max_can_talk(a) || !max_takes_voice(a)) break;
        show_agent(a->id);
        return talk_to(a, MAX_ACT_TALK);
    }
    case MAX_HIT_AWAY: {
        if (view != MAX_VIEW_ATTENTION) break;
        const max_agent_t *a = max_find(max_m.attn_id);
        if (a) return bring_up(a->id, a->name, max_app_of(a), now_ms);
        go(MAX_VIEW_OVERVIEW);
        break;
    }
    case MAX_HIT_TOAST:   // what needed the person while they talked; New Harness, when up, closes first
        if (!max_m.toast_id[0] || !max_attn_holds(max_m.toast_id, max_m.toast_attn)) break;
        max_form_dismiss();
        max_attention(max_m.toast_id, max_m.toast_attn, now_ms);
        changed = true;
        break;
    case MAX_HIT_TALK_CANCEL: break;   // only while recording
    case MAX_HIT_FORM_SAY: {   // a spoken name for the form's field
        if (!page || !max_form_can_say()) break;
        max_m.talk_id[0] = 0;
        max_act_t act = act_for(MAX_ACT_SAY, NULL);
        memcpy(act.form_id, f->id, sizeof act.form_id);
        act.revision = f->page.revision;
        return act;
    }
    case MAX_HIT_NEW:
        if (!max_form_open()) return act_for(MAX_ACT_NEW, NULL);
        break;
    case MAX_HIT_FORM_MOVE: changed = page && max_form_command(MAX_FORM_MOVE, h->arg, now_ms); break;
    case MAX_HIT_FORM_PICK: changed = page && max_form_command(MAX_FORM_ACTIVATE, 0, now_ms); break;
    case MAX_HIT_FORM_BACK: changed = page && max_form_command(MAX_FORM_BACK, 0, now_ms); break;
    case MAX_HIT_FORM_CLOSE: changed = max_form_dismiss(); break;
    case MAX_HIT_FORM_RETRY:
        if (!max_form_open() || !f->failed) break;
        max_form_reset();
        max_m.dirty = true;
        return act_for(MAX_ACT_NEW, NULL);
    case MAX_HIT_OPTION:
    case MAX_HIT_SEND:
    case MAX_HIT_STEP_BACK:
    case MAX_HIT_RELOAD: {
        max_agent_t *a = max_find(max_m.card_id);
        changed = a && max_card_key(a) == max_m.card_key && max_ask_hit(a, (max_hit_kind_t)h->kind, h->arg, now_ms);
        break;
    }
    default: break;   // the lanes' buttons: no page draws them
    }
    if (changed) max_m.dirty = true;
    return nothing();
}

// A tap while a recording is up: X drops it and the page stays; Back and the strip send what was heard (else drop it)
// and go where they go, with the mic closed; anything else, even bare glass, sends it now.
static max_act_t recording_tap(const max_hit_t *h, uint32_t now_ms)
{
    if (h && h->kind == MAX_HIT_TALK_CANCEL) {
        max_m.dirty = true;
        return act_for(MAX_ACT_CANCEL, max_m.talk_id);
    }
    if (h && h->kind == MAX_HIT_BACK) {
        go(MAX_VIEW_OVERVIEW);
        return settle_talk(now_ms);
    }
    if (h && h->kind == MAX_HIT_SEG && max_m.view == MAX_VIEW_AGENT && h->arg >= 0 && h->arg < MAX_SEGS &&
        max_find(max_m.seg_id[h->arg])) {
        const max_act_t act = settle_talk(now_ms);
        show_agent(max_m.seg_id[h->arg]);
        return act;
    }
    return send_onward(now_ms);
}

static max_act_t tap(int x, int y, uint32_t now_ms)
{
    const max_hit_t *h = NULL;
    for (int i = 0; i < max_m.hit_count && !h; i++)
        if (on_hit(&max_m.hits[i], x, y)) h = &max_m.hits[i];
    if (max_m.talk == MAX_TALK_RECORDING) return recording_tap(h, now_ms);
    if (h) return press(h, now_ms);
    for (int i = 0; i < max_m.cell_hits && i < MAX_CELLS; i++)
        if (inside(max_m.cell_box[i], x, y)) return open_cell(max_m.cell_id[i], now_ms);
    return nothing();
}

// The next agent of the ring (step +1) or the one before (-1), round its ends, from the agent page's.
static void browse(int step)
{
    const max_agent_t *a = max_find(max_m.selected);
    if (!a || max_m.count < 2) return;
    const int i = (int)(a - max_m.agents);
    show_agent(max_m.agents[(i + step + max_m.count) % max_m.count].id);
}

// A sideways swipe: to the left shows what comes next.
static max_act_t swipe(int step, uint32_t now_ms)
{
    if (max_m.talk == MAX_TALK_RECORDING) {   // only the agent page moves on, with what was heard
        if (max_m.view != MAX_VIEW_AGENT || max_m.count < 2 || !max_find(max_m.selected)) return nothing();
        const max_act_t act = settle_talk(now_ms);
        browse(step);
        return act;
    }
    if (max_form_open()) {   // over the page: its choice moves, unless a spoken name is on its way
        if (max_m.talk == MAX_TALK_IDLE && max_m.form.page.revision == max_m.form_revision &&
            max_form_command(MAX_FORM_MOVE, step, now_ms))
            max_m.dirty = true;
        return nothing();
    }
    if (max_m.view == MAX_VIEW_OVERVIEW) {
        int page = max_m.cell_page + step;
        const int last = max_cell_pages() - 1;
        if (page > last) page = last;
        if (page < 0) page = 0;
        if (page != max_m.cell_page) {
            max_m.cell_page = page;
            max_m.dirty = true;
        }
    } else if (max_m.view == MAX_VIEW_AGENT) {
        browse(step);
    }
    return nothing();
}

max_act_t max_ui_touch(bool down, int x, int y, uint32_t now_ms)
{
    if (down) {
        if (!max_m.down) {
            max_m.down = true;
            max_m.moved = false;
            max_m.down_x = x;
            max_m.down_y = y;
        } else if (iabs(x - max_m.down_x) > MAX_TAP_SLOP || iabs(y - max_m.down_y) > MAX_TAP_SLOP) {
            max_m.moved = true;   // out and back is still a drag
        }
        return nothing();
    }
    max_m.idle_from = now_ms;   // a person at the bar: Ambient waits for them
    if (!max_m.down || max_m.update_pct >= 0) {   // no contact, or nothing to touch while the image is written
        max_m.down = false;
        return nothing();
    }
    max_m.down = false;
    const int dx = x - max_m.down_x, dy = y - max_m.down_y;
    if (!max_m.moved && iabs(dx) <= MAX_TAP_SLOP && iabs(dy) <= MAX_TAP_SLOP) return tap(max_m.down_x, max_m.down_y, now_ms);
    if (iabs(dx) >= MAX_SWIPE_PX && iabs(dx) * 2 > iabs(dy) * 3) return swipe(dx < 0 ? 1 : -1, now_ms);
    return nothing();
}

void max_ui_touch_cancel(void) { max_m.down = false; }
