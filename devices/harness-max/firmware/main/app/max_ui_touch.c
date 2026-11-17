// The finger on the lanes (max_ui.h): a tap acts on what the last render drew, a sideways swipe turns the page.
#include <string.h>

#include "max_ui_internal.h"

static int iabs(int v) { return v < 0 ? -v : v; }
static bool inside(max_box_t b, int x, int y) { return x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h; }

static max_act_t act_for(max_act_kind_t kind, const char *id)
{
    max_act_t act = {kind, ""};
    max_copy(act.agent_id, sizeof act.agent_id, id);
    return act;
}

static max_act_t tap(int x, int y)
{
    for (int i = 0; i < max_m.lane_hits; i++) {
        if (!inside(max_m.lane_box[i], x, y)) continue;
        // The lane the person saw, even if the order moved since; gone from the roster, it opens nothing.
        if (!max_find(max_m.lane_id[i])) break;
        if (strcmp(max_m.selected, max_m.lane_id[i])) max_m.dirty = true;
        max_copy(max_m.selected, sizeof max_m.selected, max_m.lane_id[i]);
        return act_for(MAX_ACT_OPEN, max_m.selected);
    }
    if (max_m.talk_hit && inside(max_m.talk_box, x, y)) {
        if (max_m.talk == MAX_TALK_RECORDING) return act_for(MAX_ACT_SEND, max_m.talk_id);
        if (max_m.talk == MAX_TALK_IDLE && max_find(max_m.selected)) {
            max_copy(max_m.talk_id, sizeof max_m.talk_id, max_m.selected);
            return act_for(MAX_ACT_TALK, max_m.talk_id);
        }
    }
    return act_for(MAX_ACT_NONE, NULL);
}

max_act_t max_ui_touch(bool down, int x, int y, uint32_t now_ms)
{
    (void)now_ms;
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
    if (!max_m.down || max_m.update_pct >= 0) {   // no contact, or nothing to touch while the image is written
        max_m.down = false;
        return act_for(MAX_ACT_NONE, NULL);
    }
    max_m.down = false;
    const int dx = x - max_m.down_x, dy = y - max_m.down_y;
    if (!max_m.moved && iabs(dx) <= MAX_TAP_SLOP && iabs(dy) <= MAX_TAP_SLOP) return tap(max_m.down_x, max_m.down_y);
    if (iabs(dx) >= MAX_SWIPE_PX && iabs(dx) * 2 > iabs(dy) * 3) {   // sideways: to the left shows the next page
        const int was = max_m.page;
        max_m.page += dx < 0 ? 1 : -1;
        max_clamp_page();
        if (max_m.page != was) max_m.dirty = true;
    }
    return act_for(MAX_ACT_NONE, NULL);
}

void max_ui_touch_cancel(void) { max_m.down = false; }
