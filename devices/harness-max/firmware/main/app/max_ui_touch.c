// The finger on the pages (max_ui.h): a tap acts on what the last render drew (its hits first, then App Detail's
// cells or the slivers beside the open agent), a sideways drag on the row moves it with the finger (max_ui_row.c), a
// sideways swipe moves the form's choice. A tap on a card's button or the form queues its message in the outbox.
// While a recording is up the glass is its send: X cancels it, any other tap sends it (a sliver too: it opens
// nothing). Only the Dial's tap counts then (MAX_TAP_*): a hold or a slide is the dead zone, and the mic stays open. A
// touch that opens the mic lets go before MAX_HOLD_MS, and touches that begin within MAX_GUARD_MS of a voice action are
// part of it. The clock's side of a recording is max_ui_talk_due.
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
    max_open(id);
    max_m.dirty = true;
}

// ---- the Dial's touch around the mic ----

// A voice action (the mic opening, a send, a cancel): the touches that begin within MAX_GUARD_MS are part of it, so a
// double tap is one intent (the Dial's ht_gesture_guard).
static void guard(uint32_t now_ms)
{
    max_m.guarding = true;
    max_m.guard_until = now_ms + MAX_GUARD_MS;
}

// The clock ended the talk: a finger on the glass then acts on nothing (the Dial cancels a live gesture when its view
// changes), and the next touches within the guard are part of it.
static void void_contact(uint32_t now_ms)
{
    if (max_m.down) max_m.held = true;
    guard(now_ms);
}

// While the mic is open, whether the contact let go at now_ms sends: the Dial's tap. Anything else is the dead zone.
static bool send_tap(uint32_t now_ms)
{
    const uint32_t d = now_ms - max_m.down_at;
    return !max_m.held && d >= MAX_TAP_MIN_MS && d <= MAX_TAP_MAX_MS && max_m.far2 <= MAX_TAP_FAR2;
}

// Whether the contact let go at now_ms may open the mic: let go before MAX_HOLD_MS, and not part of the last voice
// action.
static bool start_tap(uint32_t now_ms) { return !max_m.held && now_ms - max_m.down_at < MAX_HOLD_MS; }

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
    guard(now_ms);
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

// The recording's agent left the ring, or the done note took the person elsewhere: what was heard goes, else nothing.
static max_act_t settle_talk(uint32_t now_ms)
{
    if (max_m.talk_heard) return send_talk(now_ms);
    guard(now_ms);
    max_m.dirty = true;
    return act_for(MAX_ACT_CANCEL, max_m.talk_id);
}

// A cell's tap opened its agent: at talk_soon_at its mic opens, while its page is still up. The page gone first, the
// link down, or an agent the bar can no longer listen for: the wait ends with nothing.
static max_act_t talk_soon_due(uint32_t now_ms)
{
    const max_agent_t *a = max_find(max_m.talk_id);
    const bool page = max_m.view == MAX_VIEW_AGENT && a && !strcmp(max_m.selected, a->id);
    if (page && max_m.link && !max_form_open() && max_can_talk(a) && max_takes_voice(a)) {
        if (!reached(max_m.talk_soon_at, now_ms)) return nothing();
        max_m.talk_soon = false;
        max_m.dirty = true;
        void_contact(now_ms);   // a finger on the glass as the mic opens acts on nothing: its lift would send
        return act_for(MAX_ACT_TALK, a->id);
    }
    max_m.talk_soon = false;
    max_m.dirty = true;
    return nothing();
}

max_act_t max_ui_talk_due(uint32_t now_ms)
{
    if (max_m.talk_soon && max_m.talk != MAX_TALK_RECORDING) return talk_soon_due(now_ms);
    if (max_m.talk != MAX_TALK_RECORDING || !max_m.link) return nothing();
    if (max_m.talk_id[0] && !max_find(max_m.talk_id)) {   // its agent left the ring: its page went with it
        if (max_m.view == MAX_VIEW_AGENT) go(MAX_VIEW_OVERVIEW);
        void_contact(now_ms);
        return settle_talk(now_ms);
    }
    if (max_m.talk_heard) {
        const bool quiet = reached(max_m.talk_quiet_from + MAX_SILENCE_MS, now_ms);
        if (!quiet && !reached(max_m.talk_from + MAX_TALK_MAX_MS, now_ms)) return nothing();
        void_contact(now_ms);
        return send_onward(now_ms);
    }
    if (!reached(max_m.talk_from + MAX_HEAR_MS, now_ms)) return nothing();
    // The page stays and says so ("Mic closed · tap to talk"); the form's spoken name has no band: the notice says it.
    if (max_m.talk_id[0]) max_m.talk_closed = true;
    else max_notice_set("Mic closed", now_ms);
    void_contact(now_ms);
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
static max_act_t talk_to(const max_agent_t *a, max_act_kind_t kind, uint32_t now_ms)
{
    max_copy(max_m.talk_id, sizeof max_m.talk_id, a->id);
    max_m.talk_soon = false;   // a tap on the page while a cell's wait runs: the mic now
    guard(now_ms);
    return act_for(kind, a->id);
}

// A cell, or a sliver beside the open agent, as drawn: the agent opens across the row (the computer opens it too), even
// if the ring moved since, and its mic MAX_TALK_DELAY_MS later (max_ui_talk_due): the person sees the page before it
// listens. Gone from the ring, it opens nothing. One that asks opens Attention.
static max_act_t open_cell(const char *id, uint32_t now_ms)
{
    const max_agent_t *a = max_find(id);
    if (!a || !start_tap(now_ms)) return nothing();
    if (a->state == MAX_ASKING) {   // its question first: nothing is recorded
        max_attention(a->id, MAX_ATTN_ASK, now_ms);
        max_m.dirty = true;
        return nothing();
    }
    show_agent(a->id);
    if (max_can_talk(a) && max_takes_voice(a)) {
        const max_act_t act = talk_to(a, MAX_ACT_OPEN_TALK, now_ms);
        max_m.talk_soon = true;
        max_m.talk_soon_at = now_ms + MAX_TALK_DELAY_MS;
        return act;
    }
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

// The done note: its agent open across the row with the mic closed, to read what it did, and its done notices read;
// one gone from the ring since leaves Inbox, where its notice still is. A note already read or replaced opens nothing.
static void open_done(void)
{
    char id[ID_MAX];
    memcpy(id, max_m.done_id, sizeof id);
    max_m.done_id[0] = 0;
    max_m.dirty = true;
    if (!id[0]) return;
    if (!max_find(id)) {
        go(MAX_VIEW_INBOX);
        return;
    }
    for (int i = 0; i < max_m.inbox_count; i++)
        if (max_m.inbox[i].kind == MAX_ATTN_DONE && !strcmp(max_m.inbox[i].id, id)) max_m.inbox[i].unread = false;
    show_agent(id);
}

// An app listed besides the one shown, to pick on Apps (V3 hasOtherApps).
static bool other_apps(void)
{
    for (int i = 0; max_m.apps_known && i < max_m.app_count; i++)
        if (strcmp(max_m.apps[i].id, max_m.shown)) return true;
    return false;
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
        if (!max_m.apps[h->arg].count) {   // listed with no agents (the demo lists every app): Apps stays, and says why
            static char text[MAX_NOTICE_BYTES];   // the touch task's 1 KB frame
            snprintf(text, sizeof text, "No agents in %s", max_m.apps[h->arg].name);
            max_notice_set(text, now_ms);
            max_m.dirty = true;
            break;
        }
        max_act_t act = act_for(MAX_ACT_PICK, NULL);
        max_copy(act.app, sizeof act.app, max_m.apps[h->arg].id);
        go(MAX_VIEW_OVERVIEW);
        return act;
    }
    case MAX_HIT_CLOSE: go(MAX_VIEW_OVERVIEW); break;
    case MAX_HIT_WAKE:   // the demo's first Ambient shows every app, while there is another to pick
        go(max_m.wake_to_apps && other_apps() ? MAX_VIEW_APPS : MAX_VIEW_OVERVIEW);
        break;
    case MAX_HIT_AGENT_X:   // the row comes back
        if (view == MAX_VIEW_AGENT) go(MAX_VIEW_OVERVIEW);
        break;
    case MAX_HIT_NOTE: return open_note(h->arg, now_ms);
    case MAX_HIT_DONE_NOTE: open_done(); break;
    case MAX_HIT_BODY: {   // the mic, or the computer when the bar cannot listen for it now
        const max_agent_t *a = view == MAX_VIEW_AGENT ? max_find(max_m.selected) : NULL;
        if (!a || !start_tap(now_ms)) break;
        if (max_can_talk(a) && max_takes_voice(a)) return talk_to(a, MAX_ACT_TALK, now_ms);
        return act_for(MAX_ACT_OPEN, a->id);
    }
    case MAX_HIT_SAY_IT: {   // the answer in words, on the agent's page (a permission prompt takes Yes or No only)
        const bool asks = view == MAX_VIEW_ATTENTION && max_m.attn == MAX_ATTN_ASK;
        const max_agent_t *a = asks ? max_find(max_m.attn_id) : NULL;
        if (!a || !max_can_talk(a) || !max_takes_voice(a) || !start_tap(now_ms)) break;
        show_agent(a->id);
        return talk_to(a, MAX_ACT_TALK, now_ms);
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
        if (!page || !max_form_can_say() || !start_tap(now_ms)) break;
        max_m.talk_id[0] = 0;
        guard(now_ms);
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

// A tap while a recording is up. X drops it whatever the touch: the open agent's closes too, and says so when words
// were heard; the form's Cancel leaves the form as it is. Else only the Dial's tap acts: the toast sends it, then opens
// its Attention; the done note sends what was heard (else drops it), then opens its agent; anything else, even bare
// glass or a sliver, sends it now.
static max_act_t recording_tap(const max_hit_t *h, uint32_t now_ms)
{
    if (h && (h->kind == MAX_HIT_TALK_CANCEL || h->kind == MAX_HIT_AGENT_X)) {
        if (h->kind == MAX_HIT_AGENT_X) {
            if (max_m.talk_heard) max_notice_set("Cancelled, nothing sent", now_ms);
            go(MAX_VIEW_OVERVIEW);
        }
        guard(now_ms);
        max_m.dirty = true;
        return act_for(MAX_ACT_CANCEL, max_m.talk_id);
    }
    if (!send_tap(now_ms)) return nothing();   // the dead zone: the mic stays open
    if (h && h->kind == MAX_HIT_TOAST) {   // the words first (a tap never loses them), then what the toast announced
        char id[ID_MAX];
        const max_attn_t why = max_m.toast_attn;
        memcpy(id, max_m.toast_id, sizeof id);
        const max_act_t act = send_onward(now_ms);
        if (id[0] && max_attn_holds(id, why)) {
            max_form_dismiss();
            max_attention(id, why, now_ms);
        }
        return act;
    }
    if (h && h->kind == MAX_HIT_DONE_NOTE) {
        const max_act_t act = settle_talk(now_ms);
        open_done();
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
    for (int i = 0; i < max_m.cell_hits && i < MAX_ROW_HITS; i++)
        if (inside(max_m.cell_box[i], x, y)) return open_cell(max_m.cell_id[i], now_ms);
    return nothing();
}

// A sideways swipe of dx px over the form: to the left is its next choice. (The row follows the finger itself.)
static max_act_t swipe(int dx, uint32_t now_ms)
{
    const int step = dx < 0 ? 1 : -1;
    if (max_m.talk == MAX_TALK_RECORDING) return nothing();   // a slide is the dead zone: the mic stays open
    // Over the page: its choice moves, unless a spoken name is on its way.
    if (max_form_open() && max_m.talk == MAX_TALK_IDLE && max_m.form.page.revision == max_m.form_revision &&
        max_form_command(MAX_FORM_MOVE, step, now_ms))
        max_m.dirty = true;
    return nothing();
}

// How far the contact went from where it went down: the Dial's tap stays within MAX_TAP_FAR2.
static void reach(int x, int y)
{
    const int dx = x - max_m.down_x, dy = y - max_m.down_y, d2 = dx * dx + dy * dy;
    if (d2 > max_m.far2) max_m.far2 = d2;
}

max_act_t max_ui_touch(bool down, int x, int y, uint32_t now_ms)
{
    if (down) {
        if (!max_m.down) {
            max_m.down = true;
            max_m.moved = false;
            max_m.down_x = x;
            max_m.down_y = y;
            max_m.down_at = now_ms;
            max_m.far2 = 0;
            max_m.held = max_m.guarding && !reached(max_m.guard_until, now_ms);
            max_row_down(x, now_ms);
        } else {
            reach(x, y);
            if (iabs(x - max_m.down_x) > MAX_TAP_SLOP || iabs(y - max_m.down_y) > MAX_TAP_SLOP)
                max_m.moved = true;   // out and back is still a drag
            max_row_move(x, now_ms);
        }
        return nothing();
    }
    max_m.idle_from = now_ms;   // a person at the bar: Ambient waits for them
    if (!max_m.down || max_m.update_pct >= 0) {   // no contact, or nothing to touch while the image is written
        max_m.down = false;
        max_row_cancel();
        return nothing();
    }
    reach(x, y);
    max_m.down = false;
    if (max_row_up(x, now_ms)) return nothing();   // it dragged the row: the row settles, nothing else happens
    const int dx = x - max_m.down_x, dy = y - max_m.down_y;
    if (!max_m.moved && iabs(dx) <= MAX_TAP_SLOP && iabs(dy) <= MAX_TAP_SLOP) return tap(max_m.down_x, max_m.down_y, now_ms);
    if (iabs(dx) >= MAX_SWIPE_PX && iabs(dx) * 2 > iabs(dy) * 3) return swipe(dx, now_ms);
    return nothing();
}

void max_ui_touch_cancel(void)
{
    max_m.down = false;
    max_row_cancel();
}
