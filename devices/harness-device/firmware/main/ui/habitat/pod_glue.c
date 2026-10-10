#include "pod_glue.h"

#include <stdio.h>
#include <string.h>

#include "pro_canvas.h"

static void set_id(char *dst, const char *src) { strncpy(dst, src ? src : "", ID_MAX - 1); dst[ID_MAX - 1] = 0; }

void pod_ui_init(pod_ui_t *u)
{
    memset(u, 0, sizeof *u);
    pod_model_reset(&u->model);
    pod_nav_init(&u->nav);
}

static const pod_frame_t *top(const pod_ui_t *u);
static int pg_offset(pod_ui_t *u, uint32_t now_ms);

void pod_ui_render(pod_ui_t *u, ht_scene_t *scene, uint32_t now_ms)
{
    u->frame.scene = scene;
    u->frame.hit_count = 0;
    u->frame.tabs_off = 0;
    u->frame.tabs_moving = false;
    if (u->pg_mode) {   // the Tabs grid is dragged or settling: tell the view where it is
        int off = pg_offset(u, now_ms);
        if (u->pg_mode) { u->frame.tabs_moving = true; u->frame.tabs_off = off; }
    }
    pod_model_clock(&u->model, now_ms);
    pod_nav_flip_recaps(&u->nav, &u->model);   // the clock alone can end a stale Working: show the recap it opens on
    pod_render(&u->frame, &u->nav, &u->model, now_ms);
    if (u->notice_on && (int32_t)(now_ms - u->notice_until) >= 0) u->notice_on = false;
    if (u->notice_on && u->model.linked) {
        // Two runs: the dark pill and its white line. Present or absent is a different state, each constant.
        int w = ht_pro_width(&ht_pro_24, u->notice);
        if (w > 600) w = 600;
        int pw = w + 40;
        ht_pro_rect(scene, (POD_W - pw) / 2, POD_STATUS_H + 8, pw, 40, 20, ht_rgb(0x111111));
        ht_pro_text(scene, (POD_W - w) / 2, POD_STATUS_H + 8 + 7, w, &ht_pro_24, ht_rgb(0xffffff), u->notice);
    }
    u->seen_revision = u->model.revision;
    u->dirty = false;
}

static void apply_pending_focus(pod_ui_t *u);
static pod_out_t synced(pod_ui_t *u)
{
    pod_out_t o = pod_nav_sync(&u->nav, &u->model);
    apply_pending_focus(u);
    return o;
}

pod_out_t pod_ui_link(pod_ui_t *u, bool up)
{
    if (up && !u->model.linked) u->sweep.restart = true;
    if (!up) pod_ui_sweep_abort(u);
    pod_model_link(&u->model, up);
    return synced(u);
}

// The model's tabs hold roster indices, so they are rebuilt from the retained swarm frame.
static void rebuild_tabs(pod_ui_t *u)
{
    if (!u->sw_n) return;
    for (int i = 0; i < u->sw_n; i++) {
        for (int k = 0; k < u->sw_member_count[i]; k++) u->sw_ptr[i][k] = u->sw_member_id[i][k];
        u->sw_list[i] = u->sw_ptr[i];
    }
    pod_model_swarms_meta(&u->model, u->sw_items, u->sw_list, u->sw_member_count, u->sw_n, u->sw_selected, u->sw_tiles,
                          u->sw_tile_n, u->sw_meta);
}

pod_out_t pod_ui_roster(pod_ui_t *u, const pod_roster_row_t *rows, int n)
{
    pod_model_agents_begin(&u->model);
    for (int i = 0; i < n; i++) pod_model_agent(&u->model, rows[i].id, rows[i].name, rows[i].engine, rows[i].machine);
    pod_model_agents_end(&u->model);
    rebuild_tabs(u);
    return synced(u);
}

pod_out_t pod_ui_swarms(pod_ui_t *u, const cable_swarm_t *items, int n, const cable_swarm_members_t *members,
                        const char *selected, const cable_tile_t *tiles, int tile_count)
{
    if (n < 0 || !items) n = 0;
    if (n > SWARMS_MAX) n = SWARMS_MAX;
    if (tile_count < 0 || !tiles) tile_count = 0;
    if (tile_count > SWARM_TILES_MAX) tile_count = SWARM_TILES_MAX;
    bool same = n == u->sw_n;
    for (int i = 0; same && i < n; i++) {
        int c = members ? members->count[i] : 0;
        same = !strcmp(items[i].id, u->sw_items[i].id) && c == u->sw_member_count[i];
        for (int k = 0; same && k < c && k < POD_MEMBERS_MAX; k++) same = !strcmp(members->id[i][k], u->sw_member_id[i][k]);
    }
    if (!same) u->sweep.restart = true;   // another tab, another set of agents to look up
    u->sw_n = n;
    u->sw_tile_n = tile_count;
    if (n) memcpy(u->sw_items, items, (size_t)n * sizeof *items);
    if (tile_count) memcpy(u->sw_tiles, tiles, (size_t)tile_count * sizeof *tiles);
    set_id(u->sw_selected, selected);
    for (int i = 0; i < n; i++) {
        int c = members ? members->count[i] : 0;
        if (c > POD_MEMBERS_MAX) c = POD_MEMBERS_MAX;
        u->sw_member_count[i] = (uint8_t)c;
        for (int k = 0; k < c; k++) set_id(u->sw_member_id[i][k], members->id[i][k]);
        for (int k = 0; k < POD_MEMBERS_MAX; k++)
            u->sw_meta[i][k] = members && k < c ? members->meta[i][k] : (pod_member_meta_t){0};
    }
    if (!n) {   // no tabs: rebuild_tabs() would skip it, so clear the model here
        pod_model_swarms_meta(&u->model, NULL, NULL, NULL, 0, NULL, NULL, 0, u->sw_meta);
    } else {
        rebuild_tabs(u);
    }
    return synced(u);
}

pod_out_t pod_ui_status(pod_ui_t *u, const char *id, const char *status, uint32_t now_ms)
{
    pod_model_library_status(&u->model, id, status, now_ms);
    return synced(u);
}

pod_out_t pod_ui_turn(pod_ui_t *u, const char *id, const char *kind, const char *text, int elapsed_s, uint32_t now_ms)
{
    pod_model_turn(&u->model, id, kind, text, elapsed_s, now_ms);
    return synced(u);
}

pod_out_t pod_ui_question(pod_ui_t *u, const char *id, const char *text)
{
    pod_model_question(&u->model, id, text);
    return synced(u);
}

pod_out_t pod_ui_question_close(pod_ui_t *u, const char *id)
{
    pod_model_question_close(&u->model, id);
    return synced(u);
}

pod_out_t pod_ui_recap(pod_ui_t *u, const char *id, const char *recap, bool restore)
{
    pod_model_recap(&u->model, id, recap, restore);
    return synced(u);
}

bool pod_ui_take_changed(pod_ui_t *u)
{
    if (u->dirty) { u->dirty = false; u->seen_revision = u->model.revision; return true; }
    if (u->model.revision == u->seen_revision) return false;
    u->seen_revision = u->model.revision;
    return true;
}

// ---- touch -------------------------------------------------------------------------------------------------

static const pod_frame_t *top(const pod_ui_t *u) { return u->nav.depth ? &u->nav.stack[u->nav.depth - 1] : NULL; }
static int iabs(int v) { return v < 0 ? -v : v; }

static bool scrolls(const pod_ui_t *u)
{
    const pod_frame_t *f = top(u);
    return f && (f->view == POD_V_TABS || f->view == POD_V_TAB || f->view == POD_V_RECAP);
}
// A horizontal swipe on the Agent, Recap and Talking screens steps panes, as on the round dial (swipe left = next, right =
// previous; ui_habitat.c): travel >= POD_SW_MIN_PX, |dx| > 1.5 |dy|, released within POD_SW_MS or leaving at POD_SW_FLICK px/s.
// Not from the transport bar (taps only). It is never also a tap or a Recap scroll.
#define POD_SW_MIN_PX 60
#define POD_SW_MS 700
#define POD_SW_FLICK 600
static bool swipes(const pod_ui_t *u)
{
    const pod_frame_t *f = top(u);
    return f && (f->view == POD_V_AGENT || f->view == POD_V_RECAP || f->view == POD_V_TALK);
}
static bool wide(int dx, int dy) { return iabs(dx) * 2 > iabs(dy) * 3; }
static bool inside(const pod_hit_t *h, int x, int y)
{
    return x >= h->x && x < h->x + h->w && y >= h->y && y < h->y + h->h;
}

// Scroll counts rows (pod_scroll_pitch px each), not pixels: travel accumulates, half a row of it steps one row,
// and the offset stays within the screen's last valid row. True when the offset moved.
static bool scroll_rows(pod_ui_t *u, int travel_px, uint32_t now_ms)
{
    int pitch = pod_scroll_pitch(&u->nav), max = pod_scroll_max(&u->nav, &u->model);
    if (pitch <= 0) return false;
    pod_frame_t *f = &u->nav.stack[u->nav.depth - 1];
    int row = f->scroll, before = row;
    u->scroll_px += travel_px;
    while (u->scroll_px >= pitch / 2 && row < max) { row++; u->scroll_px -= pitch; }
    while (u->scroll_px <= -(pitch / 2) && row > 0) { row--; u->scroll_px += pitch; }
    if ((row == max && u->scroll_px > 0) || (row == 0 && u->scroll_px < 0)) u->scroll_px = 0;   // pushing past an end
    if (row != before) pod_nav_act(&u->nav, &u->model, POD_A_SCROLL, row - before, now_ms);
    return row != before;
}

// ---- the Tabs grid's pages ---------------------------------------------------------------------------------
// The grid is paged: two rows a page, the frame's scroll the first row of the resting page. While the finger drags, the
// offset (px from the top of page 0) is base - dy, with a third of the pull past either end (a rubber band). On the release
// the page it settles on is the nearest to the offset, or the next one in the flick's direction when the finger left
// faster than POD_PG_FLICK; the frame takes that page at once and the offset eases there in POD_PG_ANIM_MS. A render
// stamps the offset into the frame, pod_ui_wake_ms asks for a render every 16 ms while it runs.

static bool pg_on(const pod_ui_t *u)
{
    const pod_frame_t *f = top(u);
    return f && f->view == POD_V_TABS && pod_tabs_pages(&u->model) > 1;
}
static int pg_page(const pod_ui_t *u)   // the resting page, from the frame
{
    int p = top(u)->scroll / 2, last = pod_tabs_pages(&u->model) - 1;
    return p < 0 ? 0 : p > last ? last : p;
}
static int pg_band(const pod_ui_t *u, int raw)
{
    int end = (pod_tabs_pages(&u->model) - 1) * pod_tabs_pitch();
    return raw < 0 ? raw / 3 : raw > end ? end + (raw - end) / 3 : raw;
}
static int pg_ease(const pod_ui_t *u, uint32_t dt)   // ease-out cubic from pg_from to pg_to
{
    long long t = (long long)dt * 1024 / POD_PG_ANIM_MS, r = 1024 - t;
    long long e = 1024 - r * r * r / (1024 * 1024);
    return u->pg_from + (int)((long long)(u->pg_to - u->pg_from) * e / 1024);
}
// The offset to draw now; ends the animation (mode IDLE) when it has run its time or the grid is no longer the screen.
static int pg_offset(pod_ui_t *u, uint32_t now_ms)
{
    if (!pg_on(u)) { u->pg_mode = POD_PG_IDLE; return 0; }
    if (u->pg_mode == POD_PG_DRAG) return pg_band(u, u->pg_base - u->pg_dy);
    if (u->pg_t0_pending) { u->pg_t0 = now_ms; u->pg_t0_pending = false; }
    uint32_t dt = now_ms - u->pg_t0;
    if ((int32_t)dt >= (int32_t)POD_PG_ANIM_MS) { u->pg_mode = POD_PG_IDLE; return u->pg_to; }
    return pg_ease(u, (int32_t)dt < 0 ? 0 : dt);
}
static int pg_nearest(const pod_ui_t *u, int off)
{
    int last = pod_tabs_pages(&u->model) - 1, pitch = pod_tabs_pitch();
    int p = off <= 0 ? 0 : (off + pitch / 2) / pitch;
    return p > last ? last : p;
}
// The finger is up (or the contact was cancelled: no velocity): pick the page and start settling onto it.
static void pg_release(pod_ui_t *u, uint32_t now_ms, bool cancelled)
{
    int pitch = pod_tabs_pitch(), last = pod_tabs_pages(&u->model) - 1;
    int off = pg_band(u, u->pg_base - u->pg_dy), from = pg_nearest(u, u->pg_base);
    int target = pg_nearest(u, off);
    int vel = (cancelled || (int32_t)(now_ms - u->pg_last_ms) > 100) ? 0 : u->pg_vel;   // a finger that rested has no flick
    if (vel <= -POD_PG_FLICK && target <= from) target = from + 1;
    if (vel >= POD_PG_FLICK && target >= from) target = from - 1;
    target = target < 0 ? 0 : target > last ? last : target;
    int rows = (target - pg_page(u)) * 2;
    if (rows) pod_nav_act(&u->nav, &u->model, POD_A_SCROLL, rows, now_ms);
    u->pg_from = off;
    u->pg_to = target * pitch;
    u->pg_t0 = now_ms;
    u->pg_t0_pending = cancelled;
    u->pg_mode = off == u->pg_to ? POD_PG_IDLE : POD_PG_ANIM;
}

void pod_ui_scroll_sink(pod_ui_t *u, ht_scroll_emit_t emit, void *ctx, bool reversed)
{
    u->scroll_emit = emit;
    u->scroll_ctx = ctx;
    u->scroll_reversed = reversed;
}

pod_out_t pod_ui_touch(pod_ui_t *u, bool down, int x, int y, uint32_t now_ms, bool *changed)
{
    pod_out_t none;
    memset(&none, 0, sizeof none);
    bool dummy;
    if (!changed) changed = &dummy;
    *changed = false;
    if (down && !u->down) {
        if (u->scroll_begun) { ht_scroll_cancel(&u->scroll); u->scroll_begun = false; }   // a stroke whose UP never came
        u->down = true;
        u->down_ms = now_ms;
        u->touched = true;
        u->last_touch_ms = now_ms;
        u->cancelled = u->dragging = u->hit_valid = false;
        u->start_x = x;
        u->start_y = y;
        u->anchor_y = y;
        u->scroll_px = 0;
        u->pg_dy = u->pg_vel = 0;
        u->sw_ok = swipes(u) && y < POD_TRANSPORT_Y;
        u->sw_on = false;
        u->sw_vx = 0;
        u->sw_last_x = x;
        u->sw_last_ms = now_ms;
        u->pg_last_y = y;
        u->pg_last_ms = now_ms;
        if (pg_on(u)) {   // a grid still settling is caught where it is (the touch then only stops it); else the resting page
            bool caught = u->pg_mode == POD_PG_ANIM;
            u->pg_base = caught ? pg_offset(u, now_ms) : pg_page(u) * pod_tabs_pitch();
            u->pg_mode = caught && u->pg_mode == POD_PG_ANIM ? POD_PG_DRAG : POD_PG_IDLE;
        } else {
            u->pg_mode = POD_PG_IDLE;
        }
        // The later hit is drawn on top of the earlier ones.
        for (int i = (int)u->frame.hit_count - 1; i >= 0; i--)
            if (inside(&u->frame.hits[i], x, y)) {
                u->hit = u->frame.hits[i];
                u->hit_valid = true;
                break;
            }
        return none;
    }
    if (down) {
        if (!u->down || u->cancelled) return none;
        if (iabs(x - u->start_x) > POD_TAP_SLOP || iabs(y - u->start_y) > POD_TAP_SLOP) u->hit_valid = false;
        if (u->sw_ok) {
            if ((int32_t)(now_ms - u->sw_last_ms) > 0) {
                int inst = (x - u->sw_last_x) * 1000 / (int)(now_ms - u->sw_last_ms);
                u->sw_vx = (u->sw_vx + inst) / 2;
                u->sw_last_x = x;
                u->sw_last_ms = now_ms;
            }
            if (!u->dragging && iabs(x - u->start_x) > POD_TAP_SLOP && wide(x - u->start_x, y - u->start_y)) u->sw_on = true;
        }
        if (scrolls(u) && pg_on(u) && top(u)->view == POD_V_TABS) {   // the paged grid follows the finger
            if (u->dragging || iabs(y - u->start_y) > POD_TAP_SLOP) {
                u->dragging = true;
                u->pg_mode = POD_PG_DRAG;
                int dy = y - u->start_y;
                if ((int32_t)(now_ms - u->pg_last_ms) > 0) {
                    int inst = (y - u->pg_last_y) * 1000 / (int)(now_ms - u->pg_last_ms);
                    u->pg_vel = (u->pg_vel + inst) / 2;
                    u->pg_last_y = y;
                    u->pg_last_ms = now_ms;
                }
                if (dy != u->pg_dy) { u->pg_dy = dy; *changed = true; }
            }
        } else if (scrolls(u) && !u->sw_on && (u->dragging || iabs(y - u->start_y) > POD_TAP_SLOP)) {
            // The first step carries the travel since the DOWN; each later one the travel since the last.
            int dy = y - u->anchor_y;
            u->dragging = true;
            u->anchor_y = y;
            if (top(u)->view == POD_V_RECAP && u->scroll_emit) {
                if (!u->scroll_begun) {   // from the DOWN's point and time, so the first MOVE carries the travel so far
                    ht_scroll_begin(&u->scroll, u->start_x, u->start_y, u->down_ms, u->scroll_reversed, false, u->scroll_emit,
                                    u->scroll_ctx);
                    u->scroll_begun = true;
                }
                ht_scroll_move(&u->scroll, x, y, now_ms);
            }
            if (dy && scroll_rows(u, -dy, now_ms)) *changed = true;
        }
        return none;
    }
    // UP
    bool was = u->down && !u->cancelled;
    if (u->down) { u->touched = true; u->last_touch_ms = now_ms; }
    u->down = false;
    if (u->scroll_begun) {   // the lift carries the rest of the travel and the speed it left at
        ht_scroll_end(&u->scroll, x, y, now_ms);
        u->scroll_begun = false;
    }
    if (was && u->pg_mode == POD_PG_DRAG && pg_on(u)) {   // dragged, or caught while settling: settle onto a page
        pg_release(u, now_ms, false);
        *changed = true;
        return none;
    }
    if (was && u->sw_ok && !u->dragging) {
        int dx = x - u->start_x, dy = y - u->start_y;
        bool fast = (int32_t)(now_ms - u->down_ms) <= POD_SW_MS ||
                    ((int32_t)(now_ms - u->sw_last_ms) <= 100 && iabs(u->sw_vx) >= POD_SW_FLICK && (u->sw_vx < 0) == (dx < 0));
        if (iabs(dx) >= POD_SW_MIN_PX && wide(dx, dy) && fast) {
            u->sw_ok = u->sw_on = false;
            *changed = true;
            return pod_nav_act(&u->nav, &u->model, dx < 0 ? POD_A_NEXT : POD_A_PREV, 0, now_ms);
        }
    }
    if (!was || u->dragging || !u->hit_valid || !inside(&u->hit, x, y)) return none;
    // The list can have changed since the scene was drawn: a hit that names its agent or tab is resolved now.
    int arg = u->hit.arg;
    if (u->hit.id[0] && u->hit.action == POD_A_OPEN_AGENT) {
        const pod_agent_t *l[POD_AGENTS_MAX];
        int cnt = pod_nav_list(&u->nav, &u->model, l, POD_AGENTS_MAX);
        arg = -1;
        for (int i = 0; i < cnt; i++) if (!strcmp(l[i]->id, u->hit.id)) { arg = i; break; }
    } else if (u->hit.id[0] && u->hit.action == POD_A_OPEN_TAB) {
        arg = -1;
        for (int i = 0; i < u->model.tab_count; i++) if (!strcmp(u->model.tabs[i].id, u->hit.id)) { arg = i; break; }
    }
    if (arg == -1 && u->hit.id[0]) { *changed = true; return none; }   // what it named is gone: redraw, open nothing
    if (u->hit.action == POD_A_TALK && u->nav.depth) {   // an agent of an offline machine cannot be talked to: say why
        const pod_agent_t *ag = pod_model_find(&u->model, top(u)->agent);
        if (ag && ag->state == POD_OFFLINE) {
            pod_ui_notice(u, "That machine is offline", now_ms);
            *changed = true;
            return none;
        }
    }
    pod_out_t out = pod_nav_act(&u->nav, &u->model, u->hit.action, arg, now_ms);
    *changed = true;
    return out;
}

void pod_ui_touch_cancel(pod_ui_t *u)
{
    if (u->down && !u->cancelled && u->pg_mode == POD_PG_DRAG && pg_on(u)) pg_release(u, u->pg_last_ms, true);
    if (u->scroll_begun) { ht_scroll_cancel(&u->scroll); u->scroll_begun = false; }
    u->down = false;
    u->cancelled = true;
    u->hit_valid = false;
}

// ---- voice and clock ---------------------------------------------------------------------------------------

bool pod_ui_talking(const pod_ui_t *u)
{
    const pod_frame_t *f = top(u);
    return f && f->view == POD_V_TALK;
}

void pod_ui_talk_over(pod_ui_t *u)
{
    pod_nav_talk_over(&u->nav);   // back on the screen TALK came from, same stack; no ABORT: nothing records
}

void pod_ui_unsend(pod_ui_t *u, uint32_t now_ms)
{
    pod_nav_unsend(&u->nav);
    pod_ui_notice(u, "Not sent", now_ms);
}

bool pod_ui_pet_on_screen(const pod_ui_t *u)
{
    const pod_frame_t *f = top(u);
    return u->model.linked && f && (f->view == POD_V_AGENT || f->view == POD_V_RECAP || f->view == POD_V_TALK);
}

// The clock's tick: the pet's step while one is on screen; 300 ms while the Tabs grid shows a Playing ribbon; 150 ms while an agent works on Tab (the
// equaliser is three rects, cheap to redraw); else the next second (the elapsed clocks).
static uint32_t unit_ms(const pod_ui_t *u, uint32_t now_ms)
{
    if (u->pg_mode == POD_PG_ANIM) return POD_PG_STEP_MS;
    if (pod_ui_pet_on_screen(u)) return POD_PET_STEP_MS;
    const pod_frame_t *f = top(u);
    if (u->model.linked && f && f->view == POD_V_TABS && u->pg_mode == POD_PG_IDLE && pod_tabs_ribbon(&u->model, pg_page(u)))
        return POD_TABS_BAR_MS;   // the Playing ribbon's bars: three tiny rects
    if (u->model.linked && f && (f->view == POD_V_TAB))
        for (int i = 0; i < u->model.agent_count; i++)
            if (pod_model_state(&u->model, &u->model.agents[i], now_ms) == POD_WORKING) return 150;
    return 1000;
}

uint32_t pod_ui_wake_ms(const pod_ui_t *u, uint32_t now_ms)
{
    uint32_t step = unit_ms(u, now_ms);
    return step - now_ms % step;
}

bool pod_ui_clock_tick(pod_ui_t *u, uint32_t now_ms)
{
    uint32_t unit = unit_ms(u, now_ms);
    // The units differ, so a screen change alone can repeat a stamp: fold the unit in.
    uint32_t stamp = (now_ms / unit) * 8 + (unit == POD_PET_STEP_MS ? 1 : unit == 150 ? 2 : unit == POD_PG_STEP_MS ? 3 : unit == POD_TABS_BAR_MS ? 4 : 0);
    if (stamp == u->clock_stamp) return false;
    u->clock_stamp = stamp;
    return true;
}

// ---- the library sweep -------------------------------------------------------------------------------------

bool pod_ui_sweeping(const pod_ui_t *u) { return u->sweep.active; }

bool pod_ui_sweep_due(const pod_ui_t *u, uint32_t now_ms)
{
    if (!u->model.linked) return false;
    if (u->sweep.active) return (int32_t)(now_ms - u->sweep.started_ms) > (int32_t)POD_SWEEP_MS;   // stalled: start over
    return u->sweep.restart || !u->sweep.ever || (int32_t)(now_ms - u->sweep.started_ms) >= (int32_t)POD_SWEEP_MS;
}

void pod_ui_sweep_begin(pod_ui_t *u, uint32_t now_ms)
{
    u->sweep.active = true;
    u->sweep.ever = true;
    u->sweep.restart = false;
    u->sweep.last_next = 0;
    u->sweep.started_ms = now_ms;
    pod_model_library_begin(&u->model);
}

void pod_ui_sweep_abort(pod_ui_t *u) { u->sweep.active = false; }

pod_out_t pod_ui_library_rows(pod_ui_t *u, const pod_library_row_t *rows, int count, uint32_t now_ms)
{
    for (int i = 0; i < count; i++)
        pod_model_library_row(&u->model, rows[i].id, rows[i].name, rows[i].engine, rows[i].machine, rows[i].status,
                              rows[i].age_s, now_ms);
    rebuild_tabs(u);   // new agents may be members of a tab
    return synced(u);
}

int pod_ui_library_page(pod_ui_t *u, const pod_library_row_t *rows, int count, int offset, int total,
                        uint32_t now_ms, pod_out_t *fx)
{
    pod_out_t o = pod_ui_library_rows(u, rows, count, now_ms);
    int next = offset + count;
    // The daemon clamps an offset past the last full page, so the page's own offset + count is where it ended.
    if (!u->sweep.active || count <= 0 || next >= total || next <= u->sweep.last_next) {
        if (u->sweep.active) {
            pod_model_library_end(&u->model);
            rebuild_tabs(u);
            pod_out_t e = synced(u);
            if (o.fx == POD_FX_NONE) o = e;
            u->sweep.active = false;
        }
        next = -1;
    } else {
        u->sweep.last_next = next;
    }
    if (fx) *fx = o;
    return next;
}

void pod_ui_notice(pod_ui_t *u, const char *text, uint32_t now_ms)
{
    pod_copy_str(u->notice, sizeof u->notice, text);
    u->notice_until = now_ms + 3000;
    u->notice_on = u->notice[0] != 0;
    u->dirty = true;
}

// ---- following the host ------------------------------------------------------------------------------------

static bool follow_now(pod_ui_t *u, const char *id, uint32_t now_ms)
{
    if (pod_ui_talking(u)) return true;   // recording: dropped, not kept
    // They are driving: a touch within the quiet window. On the Tabs screen itself there is nothing to disturb (the usual way
    // there is a tap on Tabs, then the hand goes to the desktop app), so only the daemon's echo of the device's own last
    // move (POD_FOLLOW_ECHO_MS) is ignored there; elsewhere the full window protects what the person is reading.
    uint32_t quiet = u->nav.depth <= 1 ? POD_FOLLOW_ECHO_MS : POD_FOLLOW_QUIET_MS;
    if (u->touched && (int32_t)(now_ms - u->last_touch_ms) < (int32_t)quiet) return true;
    if (u->down) return true;
    if (pod_nav_follow(&u->nav, &u->model, id, now_ms)) {
        u->pg_mode = POD_PG_IDLE;
        u->scroll_px = 0;
        u->dirty = true;
    }
    return true;
}

static void apply_pending_focus(pod_ui_t *u)
{
    if (!u->pending_focus[0]) return;
    uint32_t now_ms = u->model.clock_ms;
    if ((int32_t)(now_ms - u->pending_focus_ms) > (int32_t)POD_FOLLOW_PENDING_MS) { u->pending_focus[0] = 0; return; }
    if (!pod_model_find(&u->model, u->pending_focus)) return;
    char id[ID_MAX];
    memcpy(id, u->pending_focus, ID_MAX);
    u->pending_focus[0] = 0;
    follow_now(u, id, now_ms);
}

pod_out_t pod_ui_focus(pod_ui_t *u, const char *agent_id, uint32_t now_ms)
{
    pod_out_t none;
    memset(&none, 0, sizeof none);
    if (!agent_id || !*agent_id) return none;
    pod_model_clock(&u->model, now_ms);
    if (!pod_model_find(&u->model, agent_id)) {   // not in the roster yet: apply when it arrives
        set_id(u->pending_focus, agent_id);
        u->pending_focus_ms = now_ms;
        return none;
    }
    u->pending_focus[0] = 0;
    follow_now(u, agent_id, now_ms);
    return none;
}
