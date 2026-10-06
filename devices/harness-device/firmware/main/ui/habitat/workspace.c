#include "workspace.h"
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

void ht_workspace_cancel_touch(ht_workspace_t *w)
{
    w->touching = w->moved = w->cancelled = false;
}
void ht_workspace_touch(ht_workspace_t *w, int index, int count, int x, int y, uint32_t now)
{
    ht_workspace_cancel_touch(w);
    if (w->phase != HT_WORKSPACE_IDLE || index < 0 || index >= count || count > 24) return;
    w->touching = true; w->x = x; w->y = y; w->origin = w->choice = index;
    w->count = count; w->began = now;
}
bool ht_workspace_move(ht_workspace_t *w, int x, int y, unsigned axis, uint32_t now)
{
    if (!w->touching || w->cancelled) return false;
    bool before = w->moved;
    int choice = w->choice;
    if (axis == 1 || abs(y - w->y) > 64 || now - w->began >= 5000) {
        w->cancelled = true; return true;
    }
    if (axis == 2) {
        w->moved = true;
        // Match the pane swipe direction: pulling left reveals the next tab.
        int target = w->origin + (w->x - x) / 56;
        w->choice = target < 0 ? 0 : target >= w->count ? w->count - 1 : target;
    }
    return before != w->moved || choice != w->choice;
}
int ht_workspace_release(ht_workspace_t *w, int x, int y, unsigned axis, uint32_t now)
{
    ht_workspace_move(w,x,y,axis,now);
    int selected = w->touching && w->moved && !w->cancelled && now - w->began >= 25 &&
        w->choice != w->origin ? w->choice : -1;
    ht_workspace_cancel_touch(w);
    return selected;
}
void ht_workspace_cancel_request(ht_workspace_t *w)
{
    w->pending[0] = 0; w->phase = HT_WORKSPACE_IDLE; w->deadline = 0;
}
bool ht_workspace_request(ht_workspace_t *w, const char *id, uint32_t now)
{
    if (w->phase != HT_WORKSPACE_IDLE || !id || !*id || strlen(id) >= sizeof w->pending) return false;
    snprintf(w->pending,sizeof w->pending,"%s",id);
    w->serial++; if (!w->serial) w->serial++;
    w->deadline = now + 8000; w->phase = HT_WORKSPACE_WAIT_TAB;
    return true;
}
bool ht_workspace_selected(ht_workspace_t *w, const char *id)
{
    if (w->phase != HT_WORKSPACE_WAIT_TAB || !id || strcmp(w->pending,id)) return false;
    w->phase = HT_WORKSPACE_REFRESH; return true;
}
bool ht_workspace_refresh(ht_workspace_t *w, uint32_t serial, uint32_t generation)
{
    if (w->phase != HT_WORKSPACE_REFRESH || w->serial != serial) return false;
    w->floor = generation; w->phase = HT_WORKSPACE_WAIT_SNAPSHOT; return true;
}
bool ht_workspace_applied(ht_workspace_t *w, const char *id, uint32_t generation)
{
    if (w->phase != HT_WORKSPACE_WAIT_SNAPSHOT || !id || strcmp(w->pending,id) ||
        (int32_t)(generation - w->floor) <= 0) return false;
    w->phase = HT_WORKSPACE_READY; return true;
}
bool ht_workspace_tick(ht_workspace_t *w, uint32_t now)
{
    if (w->phase == HT_WORKSPACE_IDLE || (int32_t)(now - w->deadline) < 0) return false;
    ht_workspace_cancel_request(w); return true;
}

static int bounded(int value, int low, int high)
{
    return value < low ? low : value > high ? high : value;
}
int ht_tab_carousel_index(const ht_tab_carousel_t *c)
{
    return c->count ? bounded((c->position + HT_TAB_PITCH / 2) / HT_TAB_PITCH, 0, c->count - 1) : -1;
}
void ht_tab_carousel_reset(ht_tab_carousel_t *c, int count, int index)
{
    count = bounded(count, 0, 24);
    *c = (ht_tab_carousel_t){.count=count};
    c->position = c->target = count ? bounded(index, 0, count - 1) * HT_TAB_PITCH : 0;
}
void ht_tab_carousel_cancel(ht_tab_carousel_t *c)
{
    ht_tab_carousel_reset(c, c->count, ht_tab_carousel_index(c));
}
bool ht_tab_carousel_tick(ht_tab_carousel_t *c, uint32_t now)
{
    if (!c->animating) return false;
    int previous = c->position;
    uint32_t elapsed = now - c->animation_at;
    if (elapsed >= HT_TAB_SETTLE_MS) {
        c->position = c->target; c->animating = false;
    } else {
        int left = HT_TAB_SETTLE_MS - (int)elapsed;
        c->position = c->target + (c->from - c->target) * left * left /
            (HT_TAB_SETTLE_MS * HT_TAB_SETTLE_MS);
    }
    return previous != c->position;
}
void ht_tab_carousel_begin(ht_tab_carousel_t *c, int x, uint32_t now)
{
    bool moving = c->animating;
    ht_tab_carousel_tick(c, now);
    c->braking = moving;
    c->animating = c->moved = false;
    c->touching = c->count > 0;
    c->origin = c->position;
    c->x = c->last_x = x;
    c->began = c->sampled = now;
    c->velocity = 0;
}
bool ht_tab_carousel_move(ht_tab_carousel_t *c, int x, uint32_t now)
{
    if (!c->touching) return false;
    int travel = bounded(c->x - x, -466, 466);
    if (!c->moved && abs(travel) < 12) return false;
    c->moved = true;
    // A slow 57 px swipe reaches the next page; no need to cross the dial.
    int old = c->position, position = c->origin + travel * HT_TAB_DRAG_GAIN;
    int end = (c->count - 1) * HT_TAB_PITCH;
    // Soft edges, with no accumulated overscroll to undo on reversal.
    c->position = position < 0 ? position / 4 : position > end ? end + (position - end) / 4 : position;
    uint32_t dt = now - c->sampled;
    if (dt) {
        int speed = dt > 100 ? 0 : bounded((c->last_x - x) * 1000 / (int)dt, -3000, 3000) * HT_TAB_DRAG_GAIN;
        c->velocity = dt > 100 ? 0 : (speed * 3 + c->velocity * 2) / 5;
        c->last_x = x; c->sampled = now;
    }
    return old != c->position;
}
void ht_tab_carousel_go(ht_tab_carousel_t *c, int index, uint32_t now)
{
    if (c->touching || c->count <= 0) return;
    ht_tab_carousel_tick(c, now);
    c->target = bounded(index, 0, c->count - 1) * HT_TAB_PITCH;
    c->from = c->position;
    c->animation_at = now;
    c->animating = c->position != c->target;
}
bool ht_tab_carousel_end(ht_tab_carousel_t *c, int x, bool horizontal, uint32_t now)
{
    if (!c->touching) return false;
    if (horizontal) ht_tab_carousel_move(c, x, now);
    c->touching = false;
    bool open = !c->moved && !c->braking;
    int projected = c->position;
    if (c->moved && now - c->began >= 25) {
        int momentum = now - c->sampled < 100 ?
            bounded(c->velocity * 120 / 1000, -HT_TAB_PITCH / 2, HT_TAB_PITCH / 2) : 0;
        projected += momentum;
    }
    int index = bounded((projected + HT_TAB_PITCH / 2) / HT_TAB_PITCH, 0, c->count - 1);
    c->target = index * HT_TAB_PITCH;
    c->from = c->position;
    c->animation_at = now;
    c->animating = c->position != c->target;
    return open && !c->animating;
}
