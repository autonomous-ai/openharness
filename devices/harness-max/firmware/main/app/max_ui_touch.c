// The finger on the screen (max_ui.h): a tap acts on what the last render drew, a sideways swipe turns the page of
// lanes, or moves the form's choice. A tap on a card's button or the form queues its message in the outbox. While a
// recording is up, only its Send and Cancel act.
#include <string.h>

#include "max_ui_internal.h"

static int iabs(int v) { return v < 0 ? -v : v; }
static bool inside(max_box_t b, int x, int y) { return x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h; }
static bool on_hit(const max_hit_t *h, int x, int y) { return x >= h->x && x < h->x + h->w && y >= h->y && y < h->y + h->h; }

static max_act_t act_for(max_act_kind_t kind, const char *id)
{
    max_act_t act = {kind, "", "", 0};
    max_copy(act.agent_id, sizeof act.agent_id, id);
    return act;
}

// The person chose an agent (a lane, the toast): the room shows it and the computer opens it. What the toast announced
// waits in its lane. New Harness, when up, closes first: it would cover the room they asked to see.
static max_act_t open_in_room(const char *id)
{
    max_form_dismiss();
    max_m.toast_id[0] = 0;
    max_room_show(id);
    max_m.dirty = true;
    return act_for(MAX_ACT_OPEN, max_m.selected);
}

// A button of the room, the toast, the card or the form. The card must still be the one the person saw: the same
// question, at the same step, in the same phase; the form's page the one drawn.
static max_act_t press(const max_hit_t *h, uint32_t now_ms)
{
    const max_form_t *f = &max_m.form;
    const bool page = max_form_open() && f->page.revision == max_m.form_revision;
    bool changed = false;
    switch ((max_hit_kind_t)h->kind) {
    case MAX_HIT_TALK: {   // the room's pet: voice for its agent
        const max_agent_t *a = max_find(max_m.selected);
        if (!max_can_talk(a)) break;
        max_copy(max_m.talk_id, sizeof max_m.talk_id, a->id);
        return act_for(MAX_ACT_TALK, max_m.talk_id);
    }
    case MAX_HIT_TALK_SEND:
    case MAX_HIT_TALK_CANCEL: break;   // only while recording (talking)
    case MAX_HIT_TOAST: {   // the question that waited
        const max_agent_t *a = max_find(max_m.toast_id);
        if (a) return open_in_room(a->id);
        break;
    }
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
    default: {
        max_agent_t *a = max_find(max_m.card_id);
        changed = a && max_card_key(a) == max_m.card_key && max_ask_hit(a, (max_hit_kind_t)h->kind, h->arg, now_ms);
        break;
    }
    }
    if (changed) max_m.dirty = true;
    return act_for(MAX_ACT_NONE, NULL);
}

// A tap while a recording is up: Send or Cancel; everything else rests until it ends. While it is sent, nothing acts.
static max_act_t talking(int x, int y)
{
    for (int i = 0; max_m.talk == MAX_TALK_RECORDING && i < max_m.hit_count; i++) {
        const max_hit_t *h = &max_m.hits[i];
        if (!on_hit(h, x, y)) continue;
        if (h->kind == MAX_HIT_TALK_CANCEL) return act_for(MAX_ACT_CANCEL, NULL);
        if (h->kind != MAX_HIT_TALK_SEND) continue;
        // Spoken to an agent that asked: its answer, and the room moves on as after a tapped one.
        const max_agent_t *a = max_find(max_m.talk_id);
        if (a && a->state == MAX_ASKING && max_room_answered(a->id)) max_m.dirty = true;
        return act_for(MAX_ACT_SEND, max_m.talk_id);
    }
    return act_for(MAX_ACT_NONE, NULL);
}

static max_act_t tap(int x, int y, uint32_t now_ms)
{
    if (max_m.talk != MAX_TALK_IDLE) return talking(x, y);
    for (int i = 0; i < max_m.hit_count; i++)
        if (on_hit(&max_m.hits[i], x, y)) return press(&max_m.hits[i], now_ms);
    for (int i = 0; i < max_m.lane_hits; i++) {
        if (!inside(max_m.lane_box[i], x, y)) continue;
        // The lane the person saw, even if the order moved since; gone from the roster, it opens nothing.
        if (!max_find(max_m.lane_id[i])) break;
        return open_in_room(max_m.lane_id[i]);
    }
    return act_for(MAX_ACT_NONE, NULL);
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
        return act_for(MAX_ACT_NONE, NULL);
    }
    max_m.touched = true;   // a person is at the bar: for MAX_QUIET_MS no question takes the room from them
    max_m.touched_ms = now_ms;
    if (!max_m.down || max_m.update_pct >= 0) {   // no contact, or nothing to touch while the image is written
        max_m.down = false;
        return act_for(MAX_ACT_NONE, NULL);
    }
    max_m.down = false;
    const int dx = x - max_m.down_x, dy = y - max_m.down_y;
    if (!max_m.moved && iabs(dx) <= MAX_TAP_SLOP && iabs(dy) <= MAX_TAP_SLOP) return tap(max_m.down_x, max_m.down_y, now_ms);
    if (max_m.talk != MAX_TALK_IDLE) return act_for(MAX_ACT_NONE, NULL);   // the page and the form rest while it records
    if (iabs(dx) >= MAX_SWIPE_PX && iabs(dx) * 2 > iabs(dy) * 3) {   // sideways: to the left shows what comes next
        if (max_form_open()) {
            if (max_m.form.page.revision == max_m.form_revision && max_form_command(MAX_FORM_MOVE, dx < 0 ? 1 : -1, now_ms))
                max_m.dirty = true;
            return act_for(MAX_ACT_NONE, NULL);
        }
        const int was = max_m.page;
        max_m.page += dx < 0 ? 1 : -1;
        max_clamp_page();
        if (max_m.page != was) max_m.dirty = true;
    }
    return act_for(MAX_ACT_NONE, NULL);
}

void max_ui_touch_cancel(void) { max_m.down = false; }
