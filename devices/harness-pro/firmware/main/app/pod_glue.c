#include "pod_glue.h"

#include <stdio.h>
#include <string.h>

#include "pod/home/ph.h"
#include "pro_canvas.h"

static void set_id(char *dst, const char *src) { strncpy(dst, src ? src : "", ID_MAX - 1); dst[ID_MAX - 1] = 0; }

void pod_ui_init(pod_ui_t *u)
{
    memset(u, 0, sizeof *u);
    pod_model_reset(&u->model);
    pod_nav_init(&u->nav);
    u->started = true;   // the boot lands on Home and stays there; only the next link-up starts (pod_ui_start)
}

static const pod_frame_t *top(const pod_ui_t *u);
static bool toast_fits(const pod_ui_t *u);

void pod_ui_render(pod_ui_t *u, ht_scene_t *scene, uint32_t now_ms)
{
    u->frame.scene = scene;
    u->frame.hit_count = 0;
    pod_model_clock(&u->model, now_ms);
    if (u->ota) {   // the update owns the glass: no stack, no banner, no notice pill
        u->frame.banner = false;
        ph_view_ota(&u->frame, u->ota_from, u->ota_to, u->ota_pct, u->ota_restarting);
        u->seen_revision = u->model.revision;
        u->dirty = false;
        return;
    }
    pod_nav_flip_recaps(&u->nav, &u->model);   // the clock alone can end a stale Working: show the recap it opens on
    // The banner shows while its entry is still unread, the time has not run out, the cable is up and nobody is recording.
    const pod_unread_t *ban = NULL;
    // A Super Tab question's toast does not run out; Notices lists it, so once Notices is on screen it has been seen.
    if (u->ban_on && !u->ban_stay && (int32_t)(now_ms - u->ban_until) >= 0) u->ban_on = false;
    if (u->ban_on && u->ban_stay && top(u) && top(u)->view == POD_V_INBOX) u->ban_on = false;
    if (u->ban_on && !(ban = pod_model_unread_find(&u->model, u->ban_agent))) u->ban_on = false;
    if (ban && strcmp(ban->tab, u->ban_tab)) { ban = NULL; u->ban_on = false; }   // the entry was replaced by another kind
    u->frame.banner = ban && u->model.linked && !pod_ui_talking(u) && toast_fits(u);   // the toast, only over a room
    pod_render(&u->frame, &u->nav, &u->model, now_ms);
    if (u->frame.banner) {   // over everything, with the hit on top
        ph_toast(&u->frame, &u->model, ban, pod_ui_banner_shown_ms(u), now_ms);
    }
    if (u->notice_on && (int32_t)(now_ms - u->notice_until) >= 0) u->notice_on = false;
    if (u->notice_on && u->model.linked) {
        // Two runs: the pill and its line. Present or absent is a different state, each constant.
        const ht_pro_font_t *font = &ht_pro_24;
        int w = ht_pro_width(font, u->notice);
        if (w > 600) w = 600;
        const int pw = w + 40;
        const int ny = POD_TRANSPORT_Y - 8 - 40;   // the agent's name is up top
        const uint16_t bg = ht_rgb(u->notice_bad ? 0xb3261e : 0x111111);
        ht_pro_rect(scene, (POD_W - pw) / 2, ny, pw, 40, 20, bg);
        ht_pro_text(scene, (POD_W - w) / 2, ny + 7, w, font, ht_rgb(0xffffff), u->notice);
    }
    u->seen_revision = u->model.revision;
    u->dirty = false;
}

static void apply_pending_focus(pod_ui_t *u);
static void apply_lead_focus(pod_ui_t *u);
static pod_out_t synced(pod_ui_t *u)
{
    pod_out_t o = pod_nav_sync(&u->nav, &u->model);
    apply_pending_focus(u);
    apply_lead_focus(u);
    return o;
}

pod_out_t pod_ui_link(pod_ui_t *u, bool up)
{
    if (up && !u->model.linked) u->sweep.restart = true;
    if (!up) pod_ui_sweep_abort(u);
    if (!up || !u->model.linked) {   // the daemon forgets the open recap and any focus with its link: nothing queued or open carries over
        u->sup_qn = 0;
        u->sup_tab[0] = u->sup_lead[0] = u->sup_chat[0] = 0;
        u->lead_wait = false;
    }
    if (up && !u->model.linked) {   // a real down -> up transition: the start runs again on this link on swarms this link brings
        u->started = false;
        u->fresh_swarms = false;
        u->sw_prev_valid = false;
    }
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
    const bool sel_changed = u->sw_prev_valid && strcmp(u->sw_prev_sel, selected ? selected : "") != 0;
    set_id(u->sw_selected, selected);
    set_id(u->sw_prev_sel, selected);
    u->sw_prev_valid = true;
    for (int i = 0; i < n; i++) {
        int c = members ? members->count[i] : 0;
        if (c > POD_MEMBERS_MAX) c = POD_MEMBERS_MAX;
        u->sw_member_count[i] = (uint8_t)c;
        for (int k = 0; k < c; k++) set_id(u->sw_member_id[i][k], members->id[i][k]);
        for (int k = 0; k < POD_MEMBERS_MAX; k++)
            u->sw_meta[i][k] = members && k < c ? members->meta[i][k] : (pod_member_meta_t){0};
    }
    if (u->model.linked && !u->started) {   // the first swarms of this link: the start may act on them (never on the last link's retained ones)
        u->fresh_swarms = true;
        if (!n || !u->sw_member_count[0]) u->started = true;   // tab 0 has no agents: no start on this link
    }
    if (!n) {   // no tabs: rebuild_tabs() would skip it, so clear the model here
        pod_model_swarms_meta(&u->model, NULL, NULL, NULL, 0, NULL, NULL, 0, u->sw_meta);
    } else {
        rebuild_tabs(u);
    }
    if (u->followed && (uint32_t)(u->model.clock_ms - u->followed_ms) >= POD_FOLLOW_ECHO_MS) u->followed = false;   // the echo window is over
    // The app window moved to another tab without focusing an agent: the device follows (pod_nav_follow_tab), unless the person is
    // busy (a contact, TALK, the update) or a host focus landed within the echo window (it wins). Notices stays put (pod_nav_follow_tab).
    if (sel_changed && !u->ota && !u->down && !pod_ui_talking(u) &&
        !(u->followed && (uint32_t)(u->model.clock_ms - u->followed_ms) < POD_FOLLOW_ECHO_MS) &&
        pod_nav_follow_tab(&u->nav, &u->model)) {
        u->scroll_px = 0;
        u->dirty = true;
    }
    return synced(u);
}

pod_out_t pod_ui_turn(pod_ui_t *u, const char *id, const char *kind, const char *text, int elapsed_s, uint32_t now_ms)
{
    pod_model_turn(&u->model, id, kind, text, elapsed_s, now_ms);
    return synced(u);
}

pod_out_t pod_ui_turn_stats(pod_ui_t *u, const char *id, int32_t passed, int32_t failed, int32_t commits, int32_t tokens_in, int32_t tokens_out)
{
    pod_model_turn_stats(&u->model, id, passed, failed, commits, tokens_in, tokens_out);
    return synced(u);
}

pod_out_t pod_ui_sent(pod_ui_t *u, const char *id, uint32_t now_ms)
{
    pod_model_sent(&u->model, id, now_ms);
    return synced(u);
}

pod_out_t pod_ui_question(pod_ui_t *u, const char *id, const char *text, const char *super_tab, pod_attention_t attention)
{
    pod_model_question_tab(&u->model, id, text, super_tab, attention);
    return synced(u);
}

pod_out_t pod_ui_question_close(pod_ui_t *u, const char *id)
{
    pod_model_question_close(&u->model, id);
    return synced(u);
}

pod_out_t pod_ui_supertab_ids(pod_ui_t *u, const char (*ids)[ID_MAX], int n)
{
    pod_model_supertab_ids(&u->model, ids, n);
    return synced(u);
}

pod_out_t pod_ui_supertab(pod_ui_t *u, const pod_swarm_t *s, uint32_t now_ms)
{
    pod_model_supertab(&u->model, s, now_ms);
    return synced(u);
}

pod_out_t pod_ui_supertab_recap(pod_ui_t *u, const char *tab, const char *lead, const char *chat_id, const char *text, uint32_t at, bool none)
{
    pod_model_supertab_recap(&u->model, tab, lead, chat_id, text, at, none);
    return synced(u);
}

pod_out_t pod_ui_supertab_focus(pod_ui_t *u, const char *tab, const char *lead, uint32_t now_ms)
{
    pod_model_clock(&u->model, now_ms);
    pod_model_supertab_focus(&u->model, tab, lead);
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

// The notice toast shows only over a room (Agent or Recap) and never for the agent that room is: not over Home, Notices, Talk (recording or
// sending) or the update. The entry stays unread whatever happens to the toast.
static bool toast_fits(const pod_ui_t *u)
{
    const pod_frame_t *f = top(u);
    if (u->ban_tab[0])   // a Swarm chat's notice: also over another Lead's view, never over the Lead it is from
        return u->ban_on && !u->ota && f && (f->view == POD_V_AGENT || f->view == POD_V_RECAP ||
               (f->view == POD_V_LEAD && (strcmp(f->swarm, u->ban_tab) || strcmp(f->lead_id, u->ban_agent))));
    return u->ban_on && !u->ota && f && (f->view == POD_V_AGENT || f->view == POD_V_RECAP) && strcmp(f->agent, u->ban_agent);
}

static bool scrolls(const pod_ui_t *u)
{
    const pod_frame_t *f = top(u);
    if (!f) return false;
    // Home pages sideways; the Inbox and a long Lead message scroll by rows; on a room or a recap a drag scrolls the host's pane
    return f->view == POD_V_INBOX || f->view == POD_V_LEAD || f->view == POD_V_AGENT || f->view == POD_V_RECAP;
}
// Whether a vertical drag on this screen also goes to the host (the scroll sink): Agent and Recap scroll the agent's pane, a Lead's view the Swarm chat
// the desktop has open (its own rows move too). The top band and the bottom zone keep their swipes (u->bar, u->edge).
static bool host_scrolls(const pod_ui_t *u)
{
    const pod_frame_t *f = top(u);
    return f && (f->view == POD_V_AGENT || f->view == POD_V_RECAP || f->view == POD_V_LEAD);
}
// A horizontal swipe on the Agent, Recap and Talking screens steps panes, as on the round dial (swipe left = next, right =
// previous): travel >= POD_SW_MIN_PX, |dx| > 1.5 |dy|, released within POD_SW_MS or leaving at POD_SW_FLICK px/s.
// It is never also a tap or a Recap scroll.
#define POD_SW_MIN_PX 60
#define POD_SW_MS 700
#define POD_SW_FLICK 600
static bool swipes(const pod_ui_t *u)
{
    const pod_frame_t *f = top(u);
    return f && (f->view == POD_V_AGENT || f->view == POD_V_RECAP || f->view == POD_V_TALK ||
                 f->view == POD_V_TABS || f->view == POD_V_INBOX || f->view == POD_V_LEAD);   // Home pages, the Inbox goes back, a Lead view steps Leads
}
// Tap to talk: only on the agent's own screens (Agent, Recap). Not in the top band, not on the back crumb or the
// Notices hit, not on an agent that asks (voice stays refused there, so the tap does not arm and no notice fires).
// Returns the agent id the tap would talk to, or NULL.
// An agent with a question to answer here, which talking must not go around. A Super Tab wait is not one: nobody answers
// it on the Pro, and talking to the agent is how a person unblocks it.
static bool asks_here(const pod_model_t *m, const pod_agent_t *a)
{
    return pod_model_eff(m, a) == POD_ASKING && pod_model_attention(m, a) == POD_ATTN_NONE;
}

static const char *talk_target(const pod_ui_t *u)
{
    const pod_frame_t *f = top(u);
    if (!f || u->ban_touch) return NULL;
    if (u->start_y < POD_BAR_H) return NULL;   // nothing in the top band talks
    if (u->hit_valid && (u->hit.action == POD_A_BACK || u->hit.action == POD_A_INBOX)) return NULL;
    const char *id = f->view == POD_V_AGENT || f->view == POD_V_RECAP || f->view == POD_V_LEAD ? f->agent : NULL;   // a Lead view's agent is its local harness (empty for a remote Lead: no talk)
    const pod_agent_t *a = id ? pod_model_find(&u->model, id) : NULL;
    return a && !asks_here(&u->model, a) ? id : NULL;
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

void pod_ui_scroll_sink(pod_ui_t *u, ht_scroll_emit_t emit, void *ctx, bool reversed)
{
    u->scroll_emit = emit;
    u->scroll_ctx = ctx;
    u->scroll_reversed = reversed;
}

static void swarm_entry_open(pod_ui_t *u, const pod_unread_t *e);

// A tap on the toast: open Notices, which lists the entry. A Swarm chat's notice opens its Lead instead.
static pod_out_t banner_open(pod_ui_t *u, uint32_t now_ms)
{
    const pod_unread_t *e = pod_model_unread_find(&u->model, u->ban_agent);
    u->ban_on = false;
    if (e && e->tab[0]) {
        pod_out_t none;
        memset(&none, 0, sizeof none);
        swarm_entry_open(u, e);
        return none;
    }
    return pod_nav_act(&u->nav, &u->model, POD_A_INBOX, 0, now_ms);   // the toast opens Notices, which lists the entry
}

// The tap's lift: talk to the agent on screen. An offline machine gets the notice instead. It runs from the touch
// samples (pod_ui_touch), the one task that also ends or aborts the recording, so a begin can never be overtaken by its end.
static pod_out_t talk_fire(pod_ui_t *u, uint32_t now_ms)
{
    pod_out_t none;
    memset(&none, 0, sizeof none);
    const pod_frame_t *t = top(u);
    if (!t || u->nav.depth != u->talk_depth || t->view != u->talk_view || strcmp(t->agent, u->talk_agent))
        return none;   // the screen or the agent changed under the finger since the DOWN: not this tap's any more
    char id[ID_MAX];
    pod_copy_str(id, sizeof id, u->talk_agent);
    const pod_agent_t *ag = pod_model_find(&u->model, id);
    if (!ag || asks_here(&u->model, ag)) return none;
    if (ag->state == POD_OFFLINE) {
        pod_ui_notice(u, "That machine is offline", now_ms);
        return none;
    }
    pod_out_t o = pod_nav_act(&u->nav, &u->model, POD_A_TALK, 0, now_ms);
    if (o.fx != POD_FX_VOICE_BEGIN) {
        u->dirty = true;
        return none;
    }
    u->hands_free = true;   // a later tap sends
    u->dirty = true;
    return o;
}

// ---- the Lead view's frames for the daemon ----
static bool sup_push_side(pod_ui_t *u, const char *t, const char *tab, const char *lead, const char *side)
{
    if (u->sup_qn >= POD_SUPERTAB_OUT_MAX) return false;   // a burst past the queue is lost, like any frame on a busy link: the caller counts it as not sent
    pod_supertab_out_t *o = &u->sup_q[u->sup_qn++];
    o->t = t;
    pod_copy_str(o->tab, sizeof o->tab, tab);
    pod_copy_str(o->lead, sizeof o->lead, lead);
    pod_copy_str(o->side, sizeof o->side, side);
    return true;
}
static bool sup_push(pod_ui_t *u, const char *t, const char *tab, const char *lead) { return sup_push_side(u, t, tab, lead, ""); }

// A tap on a Swarm chat's notice (its toast or its Notices row): read the entry and open that Lead's view, the desktop told to select it. Not Notices.
static void swarm_entry_open(pod_ui_t *u, const pod_unread_t *e)
{
    char tab[ID_MAX], lead[ID_MAX], chat[ID_MAX];
    pod_copy_str(tab, sizeof tab, e->tab);   // the read drops the entry
    pod_copy_str(lead, sizeof lead, e->agent);
    pod_copy_str(chat, sizeof chat, e->chat_id);
    pod_model_swarm_notice_read(&u->model, tab, lead, chat);
    if (pod_nav_follow_lead(&u->nav, &u->model, tab, lead)) {
        sup_push(u, "supertab.select", tab, lead);
        u->scroll_px = 0;
    }
    u->dirty = true;
}

// A Notices row whose harness is a Swarm's local Lead: read the entry and open that Lead's view the way supertab.focus does (over Home, on the Swarm's card), the
// desktop told to select it. Not the plain agent: agent.open would make the desktop open the Lead's harness in a new tab. False when no Swarm leads from it.
static bool notice_lead(pod_ui_t *u, const char *agent_id)
{
    pod_model_t *m = &u->model;
    for (int i = 0; i < m->swarm_n; i++)
        for (int j = 0; j < m->swarms[i].lead_n; j++) {
            const pod_lead_t *l = &m->swarms[i].leads[j];
            if (!l->local[0] || strcmp(l->local, agent_id)) continue;
            pod_model_unread_read(m, agent_id);
            if (pod_nav_follow_lead(&u->nav, m, m->swarms[i].id, l->id)) {
                sup_push(u, "supertab.select", m->swarms[i].id, l->id);
                u->scroll_px = 0;
            }
            return true;
        }
    return false;
}

// PREV / NEXT on the Lead view; when it landed on another Lead the daemon is told to select it.
static void lead_step(pod_ui_t *u, int dir, uint32_t now_ms)
{
    char before[ID_MAX];
    pod_copy_str(before, sizeof before, top(u)->lead_id);
    pod_nav_act(&u->nav, &u->model, dir > 0 ? POD_A_NEXT : POD_A_PREV, 0, now_ms);
    const pod_frame_t *f = top(u);
    if (f->view == POD_V_LEAD && strcmp(before, f->lead_id)) sup_push(u, "supertab.select", f->swarm, f->lead_id);
}

pod_out_t pod_ui_touch(pod_ui_t *u, bool down, int x, int y, uint32_t now_ms, bool *changed)
{
    pod_out_t none;
    memset(&none, 0, sizeof none);
    bool dummy;
    if (!changed) changed = &dummy;
    *changed = false;
    if (u->ota) return none;   // nothing to tap while the image is written
    if (down && !u->down) {
        if (u->scroll_begun) { ht_scroll_cancel(&u->scroll); u->scroll_begun = false; }   // a stroke whose UP never came
        u->down = true;
        u->down_ms = now_ms;
        u->touched = true;
        u->last_touch_ms = now_ms;
        u->cancelled = u->dragging = u->hit_valid = u->ban_touch = false;
        memset(&u->hit, 0, sizeof u->hit);   // a DOWN on nothing carries nothing over from the last contact
        if (u->hands_free && !pod_ui_talking(u)) u->hands_free = false;   // Talk ended some other way
        u->talk_armed = false;
        u->bar = !u->hands_free && y < POD_BAR_H && top(u)->view != POD_V_TALK;
        u->rows_moved = false;
        u->start_x = x;
        u->start_y = y;
        u->anchor_y = y;
        u->scroll_px = 0;
        // There is no transport line: a contact from anywhere may swipe sideways, or up (Home),
        // decided on the lift by which direction dominates.
        u->sw_ok = !u->hands_free && swipes(u);
        u->edge = !u->hands_free && (top(u)->view == POD_V_AGENT || top(u)->view == POD_V_RECAP || top(u)->view == POD_V_LEAD) && y >= POD_BOTTOM_Y;
        u->sw_on = false;
        u->sw_vx = 0;
        u->sw_last_x = x;
        u->sw_last_ms = now_ms;
        // The later hit is drawn on top of the earlier ones: the last added wins.
        int pick = -1;
        for (int i = (int)u->frame.hit_count - 1; i >= 0; i--)
            if (inside(&u->frame.hits[i], x, y)) { pick = i; break; }
        if (pick >= 0) {
            u->hit = u->frame.hits[pick];
            u->hit_valid = true;
        }
        if (u->hands_free && pod_ui_talking(u)) {   // the send tap is the whole screen's, even before Talk is drawn (u->frame is the old screen's)
            memset(&u->hit, 0, sizeof u->hit);
            u->hit.w = POD_W;
            u->hit.h = POD_W;
            u->hit.action = POD_A_TALK;
            u->hit_valid = true;
        }
        if (u->hit_valid && u->hit.action == POD_A_BANNER) {   // the toast takes the whole contact: no scroll, no swipe, no tap through it
            u->ban_touch = true;
            u->sw_ok = false;
        }
        const char *target = talk_target(u);
        if (target) {   // the tap belongs to this screen and this agent: if either changes before its lift, it does not talk
            u->talk_armed = true;
            u->talk_depth = u->nav.depth;
            u->talk_view = top(u)->view;
            pod_copy_str(u->talk_agent, sizeof u->talk_agent, target);
        }
        return none;
    }
    if (down) {
        if (!u->down || u->cancelled || u->ban_touch) return none;
        if (iabs(x - u->start_x) > POD_TAP_SLOP || iabs(y - u->start_y) > POD_TAP_SLOP) u->talk_armed = false;
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
        if (scrolls(u) && !u->sw_on && !u->bar && !u->edge && (u->dragging || iabs(y - u->start_y) > POD_TAP_SLOP)) {
            // The first step carries the travel since the DOWN; each later one the travel since the last.
            int dy = y - u->anchor_y;
            u->dragging = true;
            u->anchor_y = y;
            if (host_scrolls(u) && u->scroll_emit) {
                if (!u->scroll_begun) {   // from the DOWN's point and time, so the first MOVE carries the travel so far
                    ht_scroll_begin(&u->scroll, u->start_x, u->start_y, u->down_ms, u->scroll_reversed, u->scroll_emit,
                                    u->scroll_ctx);
                    u->scroll_begun = true;
                }
                ht_scroll_move(&u->scroll, x, y, now_ms);
            }
            if (dy && scroll_rows(u, -dy, now_ms)) { *changed = true; u->rows_moved = true; }
        }
        return none;
    }
    // UP
    bool was = u->down && !u->cancelled;
    if (u->down) { u->touched = true; u->last_touch_ms = now_ms; }
    if (was) u->started = true;   // the person is driving: a later model feed never starts over them
    u->down = false;
    const bool talk = u->talk_armed && iabs(x - u->start_x) <= POD_TAP_SLOP && iabs(y - u->start_y) <= POD_TAP_SLOP;
    u->talk_armed = false;
    if (u->scroll_begun) {   // the lift carries the rest of the travel and the speed it left at
        ht_scroll_end(&u->scroll, x, y, now_ms);
        u->scroll_begun = false;
    }
    if (u->ban_touch) {   // a contact that began on the toast: a swipe up dismisses it, a tap opens Notices
        u->ban_touch = false;
        if (!was) return none;
        int dx = x - u->start_x, dy = y - u->start_y;
        *changed = true;
        if (dy <= -POD_BANNER_SWIPE_PX && iabs(dx) < -dy) { u->ban_on = false; return none; }
        if (u->ban_on && iabs(dx) <= POD_TAP_SLOP && iabs(dy) <= POD_TAP_SLOP && inside(&u->hit, x, y)) {
            return banner_open(u, now_ms);
        }
        return none;
    }
    if (was && u->bar) {   // a swipe down from the top band opens the Inbox; on the Inbox, nothing
        int dx = x - u->start_x, dy = y - u->start_y;
        if (dy >= POD_BAR_SWIPE && iabs(dy) * 2 > iabs(dx) * 3) {
            *changed = true;
            return pod_nav_act(&u->nav, &u->model, POD_A_INBOX, 0, now_ms);
        }
    }
    if (was) {   // a swipe up (>= 80 px, vertical dominant) that began in the bottom zone is Home; on the Inbox, Back
        const pod_view_t tv = top(u)->view;
        int dx = x - u->start_x, dy = y - u->start_y;
        const bool up = dy <= -POD_EDGE_SWIPE && iabs(dy) * 2 > iabs(dx) * 3;
        // From anywhere else a vertical drag on a room scrolls the host's terminal pane and never goes Home.
        if (up && u->edge && (tv == POD_V_AGENT || tv == POD_V_RECAP || tv == POD_V_LEAD)) {
            u->edge = false;
            *changed = true;
            return pod_nav_act(&u->nav, &u->model, POD_A_TABS, 0, now_ms);
        }
        // The Inbox: up goes back unless the swipe scrolled rows (so a list that cannot scroll, or one pushed past its end, goes back).
        if (up && tv == POD_V_INBOX && !u->rows_moved) {
            *changed = true;
            return pod_nav_act(&u->nav, &u->model, POD_A_BACK, 1, now_ms);
        }
    }
    if (was && u->sw_ok && !u->dragging) {
        int dx = x - u->start_x, dy = y - u->start_y;
        bool fast = (int32_t)(now_ms - u->down_ms) <= POD_SW_MS ||
                    ((int32_t)(now_ms - u->sw_last_ms) <= 100 && iabs(u->sw_vx) >= POD_SW_FLICK && (u->sw_vx < 0) == (dx < 0));
        if (iabs(dx) >= POD_SW_MIN_PX && wide(dx, dy) && fast) {
            u->sw_ok = u->sw_on = false;
            *changed = true;
            if (top(u)->view == POD_V_TABS) {   // Home: a page a swipe, clamped, in the order of the page list
                // A swipe that starts on the Working card's pet band (more than 3 working) pages the pets, never the cards, even at either end.
                const int wp = (pod_home_working(&u->model) + 2) / 3;
                if (u->nav.depth == 1 && top(u)->scroll == POD_HOME_WORKING && wp > 1 && u->start_y >= 256 && u->start_y <= 536) {
                    const int to = (int)u->nav.work_page + (dx < 0 ? 1 : -1);
                    if (to >= 0 && to < wp) u->nav.work_page = (uint8_t)to;
                    return none;
                }
                // The Swarm card's pet band pages the Leads the same way, but past either end of the Leads the swipe goes on to the neighbouring card.
                const pod_swarm_t *sw = u->nav.depth == 1 ? pod_home_swarm(&u->model, pod_home_clamp(&u->model, top(u)->scroll)) : NULL;
                const int sp = sw ? (sw->lead_n + 2) / 3 : 0;
                if (sp > 1 && u->start_y >= 256 && u->start_y <= 536) {
                    const int to = (int)u->nav.swarm_page + (dx < 0 ? 1 : -1);
                    if (to >= 0 && to < sp) { u->nav.swarm_page = (uint8_t)to; return none; }
                }
                int16_t pg[POD_HOME_PAGES_MAX];
                const int n = pod_home_pages(&u->model, pg, POD_HOME_PAGES_MAX), cur = pod_home_clamp(&u->model, top(u)->scroll);
                int at = 0;
                while (at < n - 1 && pg[at] < cur) at++;
                const int want = at + (dx < 0 ? 1 : -1);
                if (want >= 0 && want < n) pod_nav_act(&u->nav, &u->model, POD_A_SCROLL, pg[want] - top(u)->scroll, now_ms);   // to the page itself, whatever the frame's scroll holds
                return none;
            }
            if (top(u)->view == POD_V_INBOX)   // the Inbox: either way goes back to where it was opened
                return pod_nav_act(&u->nav, &u->model, POD_A_BACK, 1, now_ms);
            if (top(u)->view == POD_V_LEAD) {   // the previous / next Lead: the desktop is told which one
                lead_step(u, dx < 0 ? 1 : -1, now_ms);
                return none;
            }
            return pod_nav_act(&u->nav, &u->model, dx < 0 ? POD_A_NEXT : POD_A_PREV, 0, now_ms);
        }
    }
    if (was && talk && !u->dragging) {   // a tap on the agent's own screen: talk to it
        *changed = true;
        return talk_fire(u, now_ms);
    }
    if (!was || u->dragging || !u->hit_valid || !inside(&u->hit, x, y)) return none;
    // The list can have changed since the scene was drawn: a hit that names its agent or tab is resolved now.
    int arg = u->hit.arg;
    if (u->hit.id[0] && u->hit.action == POD_A_OPEN_AGENT) {
        const pod_agent_t *l[POD_AGENTS_MAX];
        int cnt = pod_nav_list(&u->nav, &u->model, l, POD_AGENTS_MAX);
        arg = -1;
        for (int i = 0; i < cnt; i++) if (!strcmp(l[i]->id, u->hit.id)) { arg = i; break; }
    } else if (u->hit.id[0] && u->hit.action == POD_A_OPEN_NOTIF) {
        arg = -1;
        for (int i = 0; i < u->model.unread_count; i++) if (!strcmp(u->model.unread[i].agent, u->hit.id)) { arg = i; break; }
    } else if (u->hit.id[0] && u->hit.action == POD_A_FOLLOW) {
        arg = -1;
        for (int i = 0; i < u->model.agent_count; i++) if (!strcmp(u->model.agents[i].id, u->hit.id)) { arg = i; break; }
    } else if (u->hit.id[0] && (u->hit.action == POD_A_OPEN_TAB || u->hit.action == POD_A_ENTER_TAB)) {
        arg = -1;
        for (int i = 0; i < u->model.tab_count; i++) if (!strcmp(u->model.tabs[i].id, u->hit.id)) { arg = i; break; }
    }
    // A Swarm card's Lead pet (POD_A_LEAD: arg = the Lead's index, id = its Swarm's id): the Swarm is resolved by id now (the list can change between the draw
    // and the tap) and must still hold that index. The Lead view opens over Home and the desktop is told to select that Lead.
    if (u->hit.id[0] && u->hit.action == POD_A_LEAD) {
        const pod_swarm_t *sw = pod_model_swarm(&u->model, u->hit.id);
        arg = sw && arg >= 0 && arg < sw->lead_n ? arg : -1;
        if (arg >= 0 && pod_nav_open_lead(&u->nav, &u->model, u->hit.id, arg)) {
            sup_push(u, "supertab.select", sw->id, sw->leads[arg].id);
            u->scroll_px = 0;
            *changed = true;
            return none;
        }
    }
    if (arg == -1 && u->hit.id[0]) { *changed = true; return none; }   // what it named is gone: redraw, open nothing
    if (u->hit.action == POD_A_OPEN_NOTIF && arg >= 0 && arg < u->model.unread_count && u->model.unread[arg].tab[0]) { swarm_entry_open(u, &u->model.unread[arg]); *changed = true; return none; }
    if (u->hit.action == POD_A_OPEN_NOTIF && arg >= 0 && arg < u->model.unread_count && notice_lead(u, u->model.unread[arg].agent)) { *changed = true; return none; }
    if (u->hit.action == POD_A_TALK && u->nav.depth) {   // an agent of an offline machine cannot be talked to: say why
        const pod_agent_t *ag = pod_model_find(&u->model, top(u)->agent);
        if (ag && ag->state == POD_OFFLINE) {
            pod_out_t o = none;   // the machine went away under an open recording: discard it, send nothing
            if (pod_ui_talking(u)) {
                o.fx = POD_FX_VOICE_ABORT;
                pod_copy_str(o.agent, sizeof o.agent, top(u)->agent);
                pod_ui_talk_over(u);
            }
            pod_ui_notice(u, "That machine is offline", now_ms);
            *changed = true;
            return o;
        }
    }
    pod_out_t out = pod_nav_act(&u->nav, &u->model, u->hit.action, arg, now_ms);
    *changed = true;
    if (u->hands_free && out.fx == POD_FX_VOICE_END) u->hands_free = false;   // sent
    return out;
}

pod_out_t pod_ui_touch_cancel(pod_ui_t *u)
{
    pod_out_t none;
    memset(&none, 0, sizeof none);
    if (u->scroll_begun) { ht_scroll_cancel(&u->scroll); u->scroll_begun = false; }
    u->down = false;
    u->cancelled = true;
    u->hit_valid = false;
    u->ban_touch = false;
    // A recording a tap started does not depend on this contact: it stays open, and the next tap sends it.
    u->talk_armed = u->bar = false;
    if (!pod_ui_talking(u)) u->hands_free = false;
    return none;
}

// ---- voice and clock ---------------------------------------------------------------------------------------

uint32_t pod_ui_banner_shown_ms(const pod_ui_t *u) { return u->ban_until - (uint32_t)POD_TOAST_MS; }

bool pod_ui_talking(const pod_ui_t *u)
{
    const pod_frame_t *f = top(u);
    return f && f->view == POD_V_TALK;
}

void pod_ui_talk_over(pod_ui_t *u)
{
    pod_nav_talk_over(&u->nav);   // back on the screen TALK came from, same stack; no ABORT: nothing records
    u->hands_free = false;
}

void pod_ui_unsend(pod_ui_t *u, uint32_t now_ms)
{
    pod_nav_unsend(&u->nav);
    pod_ui_notice(u, "Not sent", now_ms);
}

bool pod_ui_pet_on_screen(const pod_ui_t *u)
{
    const pod_frame_t *f = top(u);
    if (!u->model.linked || !f) return false;
    // The hero pet is drawn on Agent and Recap (nothing when the agent has left the roster), the listening pet on Talk and, on Home, the equaliser (not a pet; it moves like one)
    if (f->view == POD_V_TALK) return true;
    if (f->view == POD_V_LEAD) return pod_nav_lead(&u->nav, &u->model, NULL) != NULL;   // the Lead's pet, once the model holds the Lead
    if (f->view == POD_V_TABS || f->view == POD_V_TAB) return ph_home_moves(&u->nav, &u->model);
    return (f->view == POD_V_AGENT || f->view == POD_V_RECAP) && pod_model_find(&u->model, f->agent);
}

// The clock's period while the screen animates on a fixed beat: 66 ms on Home while a tab's agent works (its equaliser is three
// rects, cheap to redraw); else a second.
static uint32_t unit_ms(const pod_ui_t *u)
{
    const pod_frame_t *f = top(u);
    if (f && f->view == POD_V_TABS && ((u->model.linked && ph_home_moves(&u->nav, &u->model)) || ph_home_brand(&u->nav, &u->model))) return POD_PH_ANIM_MS;
    return 1000;
}

// Milliseconds to the next edge: the pet's own next step (the screen says which pet, scene and extra animation) while
// one is on screen, else the next beat of unit_ms.
static uint32_t edge_ms(const pod_ui_t *u, uint32_t now_ms)
{
    uint32_t edge;
    if (pod_ui_pet_on_screen(u)) {
        edge = pod_view_next_ms(&u->nav, &u->model, now_ms);   // the views clamp it to their working agent's clock (pod_agent_timer_ms): no timer redraws unchanged
    }
    else if (u->model.linked && top(u) && top(u)->view == POD_V_INBOX) edge = pod_view_next_ms(&u->nav, &u->model, now_ms);   // Notices: only when an age text turns over
    else { uint32_t unit = unit_ms(u); edge = unit - now_ms % unit; }
    if (u->notice_on) {   // a notice clears on time, not at the pet's next step
        int32_t left = (int32_t)(u->notice_until - now_ms);
        if (left < 1) left = 1;
        if ((uint32_t)left < edge) edge = (uint32_t)left;
    }
    if (u->ban_on && !u->ban_stay) {   // so does the banner
        int32_t left = (int32_t)(u->ban_until - now_ms);
        if (left < 1) left = 1;
        if ((uint32_t)left < edge) edge = (uint32_t)left;
        if (u->model.linked && !pod_ui_talking(u) && !u->ota && toast_fits(u)) {   // the timer line shrinks (only while the toast is drawn): 66 ms (Home, Notices and Talk keep their own beat)
            if (edge > 66) edge = 66;
        }
    } else if (u->ban_on && u->model.linked && !pod_ui_talking(u) && !u->ota && toast_fits(u) &&
               (int32_t)(now_ms - pod_ui_banner_shown_ms(u)) < POD_TOAST_SLIDE_MS) {   // a toast that stays: its bar is still, only the slide-in moves
        if (edge > 66) edge = 66;
    }
    return edge;
}

uint32_t pod_ui_wake_ms(const pod_ui_t *u, uint32_t now_ms) { return edge_ms(u, now_ms); }

bool pod_ui_clock_tick(pod_ui_t *u, uint32_t now_ms)
{
    // clock_stamp is the time of the next edge. Due: redraw and set the next. A screen whose edge comes sooner than the
    // one waited for (a pet after a quiet screen) also redraws now.
    uint32_t next = now_ms + edge_ms(u, now_ms);
    bool due = (int32_t)(now_ms - u->clock_stamp) >= 0, sooner = (int32_t)(next - u->clock_stamp) < 0;
    if (due || sooner) u->clock_stamp = next;
    return due || sooner;
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
    u->notice_bad = false;
    u->dirty = true;
}

void pod_ui_notice_bad(pod_ui_t *u, const char *text, uint32_t now_ms)
{
    pod_ui_notice(u, text, now_ms);
    u->notice_bad = true;
}

void pod_ui_ota(pod_ui_t *u, const char *from, const char *to, int pct, bool restarting)
{
    if (pct < 0) {
        u->ota = false;
    } else {
        if (!u->ota) pod_ui_touch_cancel(u);   // a contact under way when it came up ends with it
        u->ota = true;
        pod_copy_str(u->ota_from, sizeof u->ota_from, from ? from : "");
        pod_copy_str(u->ota_to, sizeof u->ota_to, to ? to : "");
        u->ota_pct = pct > 100 ? 100 : pct;
        u->ota_restarting = restarting;
    }
    u->dirty = true;
}

bool pod_ui_updating(const pod_ui_t *u) { return u->ota; }

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
        u->scroll_px = 0;
        u->dirty = true;
        u->started = true;   // a focus that landed: the start never overrides it
        u->followed = true;
        u->followed_ms = now_ms;
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

void pod_ui_navigated(pod_ui_t *u) { u->started = true; }

bool pod_ui_start(pod_ui_t *u, uint32_t now_ms)
{
    const pod_frame_t *t = top(u);
    if (u->started || !u->fresh_swarms || !u->model.linked || u->ota || u->down) return false;
    if (u->nav.depth != 1 || !t || t->view != POD_V_TABS) { u->started = true; return false; }   // the person is already somewhere: never yank them
    // The effect (AGENT_OPEN, which only moves the desktop's focused pane) is dropped: the start is device-local.
    const pod_out_t o = pod_nav_act(&u->nav, &u->model, POD_A_ENTER_TAB, 0, now_ms);
    if (o.fx != POD_FX_AGENT_OPEN) return false;   // tab 0's agents are not on the roster yet: try again at the next model change
    u->started = true;
    u->dirty = true;
    return true;
}

// ---- notifications -----------------------------------------------------------------------------------------

bool pod_ui_notify(pod_ui_t *u, const char *agent_id, pod_tier_t tier, bool awake, uint32_t now_ms)
{
    return pod_ui_notify_text(u, agent_id, tier, NULL, false, awake, now_ms);
}

bool pod_ui_notify_text(pod_ui_t *u, const char *agent_id, pod_tier_t tier, const char *text, bool question, bool awake, uint32_t now_ms)
{
    pod_model_clock(&u->model, now_ms);
    const pod_agent_t *a = pod_model_find(&u->model, agent_id);
    if (!a || tier == POD_TIER_SILENT) return false;
    // A Super Tab's question is the agent's notice until it closes: what its turns say meanwhile is on its card, and
    // replaces neither the wait's entry nor its toast. The wait alerted once.
    // A failed turn still alerts: a crash while it waits is news.
    if (!question && !a->failed && pod_model_attention(&u->model, a) != POD_ATTN_NONE) return false;
    const pod_frame_t *t = top(u);
    const bool looking = awake && t && (t->view == POD_V_AGENT || t->view == POD_V_RECAP) && !strcmp(t->agent, a->id);
    char joined[POD_UNREAD_TEXT];
    if (!text) {
        size_t pos = 0;
        joined[0] = 0;
        for (int i = 0; i < a->recap_lines && pos + 1 < sizeof joined; i++) {   // the recap's sentences, joined
            const char *l = a->recap + a->line_at[i];
            if (!*l) continue;
            int n = snprintf(joined + pos, sizeof joined - pos, "%s%s", pos ? " " : "", l);
            if (n < 0) break;
            pos += (size_t)n < sizeof joined - pos ? (size_t)n : sizeof joined - pos - 1;
        }
        pod_utf8_trim(joined);
        text = joined;
    }
    if (question) pod_model_unread_ask(&u->model, a->id, a->name, text, now_ms);
    else pod_model_unread_add(&u->model, a->id, a->name, text, (int32_t)pod_agent_secs(a, now_ms), now_ms);
    u->dirty = true;
    if (looking) {   // its own room is on screen: shown in place, read at once, no sound, no wake, no toast
        pod_model_unread_read(&u->model, a->id);
        return false;
    }
    // The toast (alert only): none over the update, nor over the bubble that says the same. It shows only over a room, never for
    // the agent it is, and not over Home, Notices or Talk; a toast raised for the next notice replaces this one.
    if (tier == POD_TIER_ALERT && !pod_ui_talking(u) && !u->ota) {
        const bool room = t && (t->view == POD_V_AGENT || t->view == POD_V_RECAP);
        if (room && strcmp(t->agent, a->id)) {
            pod_copy_str(u->ban_agent, sizeof u->ban_agent, a->id);
            u->ban_tab[0] = 0;
            u->ban_until = now_ms + POD_TOAST_MS;
            u->ban_on = true;
            u->ban_stay = question && pod_model_attention(&u->model, a) != POD_ATTN_NONE;   // a Super Tab's question waits for you
        }
    }
    return tier == POD_TIER_ALERT;
}

bool pod_ui_swarm_notice(pod_ui_t *u, const char *tab, const char *lead, const char *chat_id, const char *text, bool awake, uint32_t now_ms)
{
    pod_model_clock(&u->model, now_ms);
    const pod_swarm_t *sw = pod_model_swarm(&u->model, tab);
    if (!sw || pod_model_lead_index(sw, lead) < 0) return false;
    const pod_frame_t *t = top(u);
    pod_model_swarm_notice(&u->model, sw->id, lead, chat_id, text, now_ms);   // filed first, so a seen one also replaces this Lead's older row
    const pod_lead_t *face = awake && t && t->view == POD_V_LEAD && !strcmp(t->swarm, sw->id) && !strcmp(t->lead_id, lead) ? &sw->leads[pod_model_lead_index(sw, lead)] : NULL;
    if (face && !strcmp(face->chat_id, chat_id ? chat_id : "")) {   // the face shows that very chat: seen at once
        pod_ui_swarm_notice_read(u, sw->id, lead, chat_id);
        return false;
    }
    u->dirty = true;
    if (!pod_ui_talking(u) && !u->ota && t && (t->view == POD_V_AGENT || t->view == POD_V_RECAP || t->view == POD_V_LEAD)) {
        pod_copy_str(u->ban_agent, sizeof u->ban_agent, lead);
        pod_copy_str(u->ban_tab, sizeof u->ban_tab, sw->id);
        u->ban_until = now_ms + POD_TOAST_MS;
        u->ban_on = true;
        u->ban_stay = false;
    }
    return true;
}

void pod_ui_swarm_notice_read(pod_ui_t *u, const char *tab, const char *lead, const char *chat_id)
{
    if (!pod_model_swarm_notice_read(&u->model, tab, lead, chat_id)) return;
    if (u->ban_on && !strcmp(u->ban_tab, tab) && !strcmp(u->ban_agent, lead)) u->ban_on = false;
    u->dirty = true;
}

void pod_ui_notif_begin(pod_ui_t *u) { pod_model_unread_clear_agents(&u->model); }   // notif.replace lists only the harness entries: a Swarm notice stays

void pod_ui_notif_row(pod_ui_t *u, const char *agent_id, const char *name, const char *token, const char *summary, uint32_t now_ms)
{
    const pod_agent_t *a = pod_model_find(&u->model, agent_id);
    pod_model_unread_append(&u->model, agent_id, a && a->name[0] ? a->name : name, token, summary, now_ms);
}

void pod_ui_notif_end(pod_ui_t *u) { u->dirty = true; }

bool pod_ui_notif_seen(pod_ui_t *u, const char *agent_id, const char *token)
{
    bool gone = pod_model_unread_seen(&u->model, agent_id, token);
    if (gone) u->dirty = true;
    return gone;
}

int pod_ui_take_reads(pod_ui_t *u, pod_read_out_t out[], int max) { return pod_model_take_reads(&u->model, out, max); }

// ---- the Swarm cards: following the desktop, and what the daemon is told ---------------------------------------------

// The Lead a focus names: itself, or for an empty one (the desktop opened the Swarm with no project) the Lead last on screen in that Swarm while it is still
// there, else the Swarm's first. NULL when the Swarm or the Lead is not in the model (yet).
static const char *focus_lead_of(const pod_ui_t *u)
{
    const pod_model_t *m = &u->model;
    const pod_swarm_t *sw = pod_model_swarm(m, m->focus_tab);
    if (m->focus_lead[0]) return pod_model_lead_index(sw, m->focus_lead) < 0 ? NULL : m->focus_lead;
    if (!sw || sw->lead_n == 0) return NULL;
    for (int i = 0; i < SWARMS_CARD_MAX; i++)
        if (!strcmp(u->lead_seen[i].swarm, sw->id) && pod_model_lead_index(sw, u->lead_seen[i].lead) >= 0) return u->lead_seen[i].lead;
    return sw->leads[0].id;
}

// Remember the Lead on screen in its Swarm: that Swarm's slot, else the first free one, else (all used) the oldest, slots being taken in turn.
static void lead_seen_note(pod_ui_t *u, const char *swarm, const char *lead)
{
    int k = -1;
    for (int i = 0; i < SWARMS_CARD_MAX && k < 0; i++) if (!strcmp(u->lead_seen[i].swarm, swarm)) k = i;
    for (int i = 0; i < SWARMS_CARD_MAX && k < 0; i++) if (!u->lead_seen[i].swarm[0]) k = i;
    if (k < 0) { k = u->lead_seen_next; u->lead_seen_next = (uint8_t)((k + 1) % SWARMS_CARD_MAX); }
    pod_copy_str(u->lead_seen[k].swarm, ID_MAX, swarm);
    pod_copy_str(u->lead_seen[k].lead, ID_MAX, lead);
}

// supertab.focus (the model's focus_pending): open that Lead's recap the way a host focus opens an agent; an empty Lead opens the Swarm on the Lead last shown
// there, else its first. Dropped, not kept, while recording or updating or when the person is driving (a touch within the quiet window, a finger down); a Lead
// (or Swarm) the Swarm list does not hold yet waits POD_FOLLOW_PENDING_MS for it.
static void apply_lead_focus(pod_ui_t *u)
{
    pod_model_t *m = &u->model;
    if (!m->focus_pending) return;
    const uint32_t now_ms = m->clock_ms;
    if (!u->lead_wait) { u->lead_wait = true; u->lead_wait_ms = now_ms; }
    const char *want = focus_lead_of(u);
    if (!want) {
        if ((int32_t)(now_ms - u->lead_wait_ms) > (int32_t)POD_FOLLOW_PENDING_MS) { m->focus_pending = false; u->lead_wait = false; }
        return;
    }
    char tab[ID_MAX], lead[ID_MAX];
    memcpy(tab, m->focus_tab, ID_MAX);
    memcpy(lead, want, ID_MAX);
    m->focus_pending = false;
    u->lead_wait = false;
    if (pod_ui_talking(u) || u->ota || u->down) return;
    const uint32_t quiet = u->nav.depth <= 1 ? POD_FOLLOW_ECHO_MS : POD_FOLLOW_QUIET_MS;   // as follow_now: the device's own selection comes back as a focus
    if (u->touched && (int32_t)(now_ms - u->last_touch_ms) < (int32_t)quiet) return;
    if (pod_nav_follow_lead(&u->nav, m, tab, lead)) {
        u->scroll_px = 0;
        u->dirty = true;
        u->started = true;   // a focus that landed: the start never overrides it
    }
}

// Make the daemon's idea of the open recap match the screen. The screen's Lead is the Lead view's, or the one a talk opened from it (the frame is the same).
static void sup_sync(pod_ui_t *u)
{
    pod_model_t *m = &u->model;
    if (!m->linked) { u->sup_tab[0] = u->sup_lead[0] = u->sup_close[0] = 0; return; }   // the daemon forgets an unplugged device's open Lead
    const pod_frame_t *f = top(u);
    const bool on = f && f->swarm[0] && (f->view == POD_V_LEAD || f->view == POD_V_TALK);
    const pod_swarm_t *sw = NULL;
    const pod_lead_t *l = on ? pod_nav_lead(&u->nav, m, &sw) : NULL;
    if (on && !l) return;   // its Lead is not in the model (yet): neither open nor closed, wait for it
    if (l) lead_seen_note(u, sw->id, l->id);
    const char *lead = l ? l->id : "";
    if (!strcmp(u->sup_lead, lead) && (!l || !strcmp(u->sup_tab, sw->id))) {   // already what the daemon was told: a frame that may have been lost is re-sent
        if (!l) {   // nothing open: a close the link dropped goes again
            if (u->sup_close[0] && sup_push(u, "supertab.open", u->sup_close, "")) u->sup_close[0] = 0;
            return;
        }
        const uint32_t now_ms = m->clock_ms;
        if (l->recap == POD_RECAP_LOADING && strcmp(u->sup_chat, l->chat_id) && u->sup_qn + 2 <= POD_SUPERTAB_OUT_MAX) {   // the chat switched: ask for its message at once
            u->sup_tries = 0;
            sup_push(u, "supertab.open", sw->id, lead);
            sup_push(u, "supertab.recap.get", sw->id, lead);
            pod_copy_str(u->sup_chat, sizeof u->sup_chat, l->chat_id);
            u->sup_at = now_ms;
            return;
        }
        if ((uint32_t)(now_ms - u->sup_at) < POD_SUPERTAB_RETRY_MS || u->sup_qn + 2 > POD_SUPERTAB_OUT_MAX) return;
        if (l->recap == POD_RECAP_LOADING) {   // no reply yet: ask again, a few times; then the "…" stays and nothing more is sent
            if (u->sup_tries >= POD_SUPERTAB_RETRIES) return;
            u->sup_tries++;
            sup_push(u, "supertab.open", sw->id, lead);
            sup_push(u, "supertab.recap.get", sw->id, lead);
            u->sup_at = now_ms;
        } else if (!u->sup_reopened) {   // answered, but the open itself might have been the lost frame: say it once more
            u->sup_reopened = true;
            sup_push(u, "supertab.open", sw->id, lead);
            u->sup_at = now_ms;
        }
        return;
    }
    if (!l) {   // closed: the frame still names the Swarm it was open in
        if (!sup_push(u, "supertab.open", u->sup_tab, "")) return;   // no room: still open as far as the daemon knows, the next sync closes it
        if (u->sup_lead[0]) pod_model_supertab_close(m, u->sup_tab, u->sup_lead);   // only the open Lead is pushed to: a closed one's text would go stale
        u->sup_tab[0] = u->sup_lead[0] = u->sup_chat[0] = 0;
        return;
    }
    const char *tab = sw->id;
    const bool ask = l->recap != POD_RECAP_LOADED;
    if (u->sup_qn + (ask ? 2 : 1) > POD_SUPERTAB_OUT_MAX) return;   // no room for the frames this needs: nothing is recorded, the next sync tries again
    if (u->sup_lead[0]) pod_model_supertab_close(m, u->sup_tab, u->sup_lead);
    sup_push(u, "supertab.open", tab, lead);
    if (ask) {   // a cold Lead: ask for its last message (the daemon's cache makes a repeat free)
        sup_push(u, "supertab.recap.get", tab, lead);
        pod_model_supertab_loading(m, tab, lead);
    }
    pod_copy_str(u->sup_tab, sizeof u->sup_tab, tab);
    pod_copy_str(u->sup_lead, sizeof u->sup_lead, lead);
    pod_copy_str(u->sup_chat, sizeof u->sup_chat, l->chat_id);
    u->sup_close[0] = 0;   // the open replaces any close still owed
    u->sup_at = m->clock_ms;
    u->sup_tries = 0;
    u->sup_reopened = false;
}

int pod_ui_take_supertab(pod_ui_t *u, pod_supertab_out_t out[], int max)
{
    sup_sync(u);
    int n = u->sup_qn < max ? u->sup_qn : max;
    if (n > 0) memcpy(out, u->sup_q, (size_t)n * sizeof out[0]);
    if (n < u->sup_qn) memmove(u->sup_q, u->sup_q + n, (size_t)(u->sup_qn - n) * sizeof u->sup_q[0]);
    u->sup_qn = (uint8_t)(u->sup_qn - n);
    return n;
}

bool pod_ui_supertab_side(pod_ui_t *u, const char *tab, pod_side_t side)
{
    if (!tab || !tab[0] || (side != POD_SIDE_PM && side != POD_SIDE_BUDDY)) return false;
    return sup_push_side(u, "supertab.side", tab, "", side == POD_SIDE_BUDDY ? "buddy" : "pm");
}

void pod_ui_supertab_unsent(pod_ui_t *u, const pod_supertab_out_t *frame)
{
    if (!frame || !frame->t) return;
    const char *t = frame->t;
    if (!strcmp(t, "supertab.open") && !frame->lead[0]) {   // the close: the daemon would keep the Lead open and send every later drag to its chat
        if (!u->sup_lead[0]) pod_copy_str(u->sup_close, sizeof u->sup_close, frame->tab);
        return;
    }
    if (!u->sup_lead[0]) return;
    if (!strcmp(t, "supertab.recap.get")) {
        if (u->sup_tries) u->sup_tries--;   // a failed retry does not use one up
        u->sup_at = u->model.clock_ms;      // and the next waits the usual 3 s
    } else if (!strcmp(t, "supertab.open")) {
        u->sup_reopened = false;
        u->sup_at = u->model.clock_ms;
    }
}
