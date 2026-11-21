#include "pod/pod_nav.h"
#include "pod/pod_view.h"

#include <string.h>

static void set_id(char *dst, const char *src) { size_t n = strnlen(src, ID_MAX - 1); memcpy(dst, src, n); dst[n] = 0; }
static pod_out_t out_none(void) { pod_out_t o; memset(&o, 0, sizeof o); return o; }
static pod_out_t out_fx(pod_effect_t fx, const char *agent) {
    pod_out_t o = out_none();
    o.fx = fx;
    if (agent) set_id(o.agent, agent);
    return o;
}

static int tab_list(const pod_model_t *m, int tab, const pod_agent_t *out[], int max) {
    int n = 0;
    if (tab == POD_TAB_RECENT) return pod_model_recent(m, out, max < POD_RECENT_MAX ? max : POD_RECENT_MAX);
    if (tab < 0 || tab >= m->tab_count) return 0;
    const pod_tab_t *t = &m->tabs[tab];
    for (int k = 0; k < t->count && k < POD_PANES_MAX && n < max; k++) {
        int a = t->agent[k];
        if (a >= 0 && a < m->agent_count) out[n++] = &m->agents[a];
    }
    return n;
}

// The app card at Home's page, or -1 (a page that is not a card, or Home lists tabs): its index into m->apps.
static int home_card(const pod_nav_t *n, const pod_model_t *m, int page)
{
    uint8_t c[POD_APPS_MAX];
    const int k = page - POD_HOME_APP0;
    if (k < 0 || !pod_home_apps(n, m) || k >= pod_home_app_cards(m, c, POD_APPS_MAX)) return -1;
    return c[k];
}
// home_app follows the page Home is on, so the next apps frame re-finds that card by id.
static void home_app_follows(pod_nav_t *n, const pod_model_t *m)
{
    const int a = home_card(n, m, n->stack[0].scroll);
    pod_copy_str(n->home_app, sizeof n->home_app, a >= 0 ? m->apps[a].id : "");
}
// Home on the app's card, Apps chosen when the pill shows; an app that is not a card leaves Home's page to the clamp.
static void home_on_app(pod_nav_t *n, const pod_model_t *m, const char *id)
{
    uint8_t c[POD_APPS_MAX];
    const int cn = pod_home_app_cards(m, c, POD_APPS_MAX);
    int k = 0;
    while (k < cn && strcmp(m->apps[c[k]].id, id)) k++;
    if (k < cn && pod_home_switch(m)) n->home_apps = true;
    pod_frame_t *h = &n->stack[0];
    h->scroll = (int16_t)pod_home_clamp(n, m, k < cn && pod_home_apps(n, m) ? POD_HOME_APP0 + k : h->scroll);
    home_app_follows(n, m);
}
// Home on a tab's card lists Tabs (the mirror of home_on_app): left on Apps, Home would draw the first card and the next sync jump to home_app.
static void home_on_tab(pod_nav_t *n, int tab)
{
    n->stack[0].scroll = (int16_t)tab;
    n->home_apps = false;
    n->home_app[0] = 0;
}

// Home pages: the TABS frame's scroll is a page of pod_home_pages: the tab index (or POD_HOME_APP0 + k for an app card), or POD_HOME_NOTICES / POD_HOME_WORKING, which exist only while there
// are notices / working agents, so they are positions that do not move when they come or go: the tab under the person stays the tab under the person.
// Leaving a room for Home lands on that room's tab card (an app's ring: its app card), never on the Notices or Working card.
static void land_on_tab(pod_nav_t *n, const pod_model_t *m, const pod_frame_t *from)
{
    if (n->depth != 1 || n->stack[0].view != POD_V_TABS) return;
    if (n->stack[0].scroll == POD_HOME_WORKING) return;   // a room opened from the Working card: Home stays on that card
    if (from->tab == POD_TAB_APP) { home_on_app(n, m, from->tab_id); return; }
    int idx = -1;
    if (from->tab_id[0]) {
        for (int t = 0; t < m->tab_count; t++) if (!strcmp(m->tabs[t].id, from->tab_id)) { idx = t; break; }
    } else if (from->tab >= 0 && from->tab < m->tab_count) {
        idx = from->tab;
    }
    if (idx >= 0) home_on_tab(n, idx);
    else if (n->stack[0].scroll < 0) n->stack[0].scroll = 0;   // Recent has no card: the first tab
}

static int index_in(const pod_model_t *m, int tab, const char *id);

static bool is_agent_view(pod_view_t v) { return v == POD_V_AGENT || v == POD_V_RECAP || v == POD_V_TALK; }

// The list a frame's agent steps through. For an agent frame in the Recent tab the open agent stays in the list
// (at the end, if it has dropped out of the newest 8) even after it falls off, so the user is not thrown out of it.
// An app's ring keeps nobody: a room whose agent leaves it closes.
static int frame_list(const pod_model_t *m, const pod_frame_t *f, const pod_agent_t *out[], int max) {
    if (f->tab == POD_TAB_APP) return pod_app_agents(m, f->tab_id, out, max);
    int n = tab_list(m, f->tab, out, max);
    if (f->tab != POD_TAB_RECENT || !is_agent_view(f->view)) return n;
    for (int i = 0; i < n; i++) if (!strcmp(out[i]->id, f->agent)) return n;
    const pod_agent_t *a = pod_model_find(m, f->agent);
    if (!a || n >= max) return n;
    out[n] = a;
    return n + 1;
}

void pod_nav_init(pod_nav_t *n) {
    memset(n, 0, sizeof *n);
    n->depth = 1;
    n->stack[0].view = POD_V_TABS;
}

int pod_nav_list(const pod_nav_t *n, const pod_model_t *m, const pod_agent_t *out[], int max) {
    if (!n->depth) return 0;
    const pod_frame_t *f = &n->stack[n->depth - 1];
    if (f->view == POD_V_TABS) return 0;
    return frame_list(m, f, out, max);
}

static bool push(pod_nav_t *n, const pod_frame_t *f) {
    if (n->depth >= 4) return false;
    n->stack[n->depth++] = *f;
    return true;
}

// The list an agent opens in when no list was tapped (follow, a notice, a Working-card pet): the window's selected tab when it
// holds the agent, else the first tab that does, else the app's ring when it is one of the app shown's agents, else Recent.
static int list_of(const pod_model_t *m, const char *id)
{
    if (m->selected < m->tab_count && index_in(m, m->selected, id) >= 0) return m->selected;
    for (int t = 0; t < m->tab_count; t++) if (index_in(m, t, id) >= 0) return t;
    const pod_agent_t *l[POD_AGENTS_MAX];
    const int cnt = pod_app_agents(m, m->app_shown, l, POD_AGENTS_MAX);
    for (int i = 0; i < cnt; i++) if (!strcmp(l[i]->id, id)) return POD_TAB_APP;
    return POD_TAB_RECENT;
}
static void set_tab(pod_frame_t *f, const pod_model_t *m, int tab)
{
    f->tab = (int8_t)tab;
    pod_copy_str(f->tab_id, sizeof f->tab_id, tab >= 0 ? m->tabs[tab].id : tab == POD_TAB_APP ? m->app_shown : "");
}

static pod_view_t view_for(const pod_model_t *m, const pod_agent_t *a) { return pod_model_opens_on_recap(m, a) ? POD_V_RECAP : POD_V_AGENT; }

// An agent shown on the Pod is read: its unread entry goes (and a token one is queued for notif.read).
// It is read only when the recap is what is on screen (a RECAP frame on top): a room has no recap to show.
static void opened(const pod_nav_t *n, pod_model_t *m, const char *id)
{
    if (n->depth && n->stack[n->depth - 1].view == POD_V_RECAP) pod_model_unread_read(m, id);
}


static pod_out_t step(pod_nav_t *n, pod_model_t *m, int dir) {
    pod_frame_t *f = &n->stack[n->depth - 1];
    const pod_agent_t *l[POD_AGENTS_MAX];
    int cnt = frame_list(m, f, l, POD_AGENTS_MAX), at = -1;
    for (int i = 0; i < cnt; i++) if (!strcmp(l[i]->id, f->agent)) { at = i; break; }
    if (at < 0) return out_none();
    bool talking = f->view == POD_V_TALK;
    n->sending = false;
    pod_out_t o = talking ? out_fx(POD_FX_VOICE_ABORT, f->agent) : out_none();
    const pod_agent_t *to = l[(at + dir + cnt) % cnt];
    int8_t tab = f->tab;
    char tab_id[SWARM_ID_MAX];
    memcpy(tab_id, f->tab_id, sizeof tab_id);
    memset(f, 0, sizeof *f);
    f->view = view_for(m, to);
    f->tab = tab;
    memcpy(f->tab_id, tab_id, sizeof tab_id);
    set_id(f->agent, to->id);
    if (!talking) o = out_fx(POD_FX_AGENT_OPEN, to->id);
    opened(n, m, f->agent);
    return o;
}

static pod_out_t nav_act(pod_nav_t *n, pod_model_t *m, pod_action_t a, int arg, uint32_t now_ms) {
    if (!n->depth) pod_nav_init(n);
    pod_frame_t *f = &n->stack[n->depth - 1];
    switch (a) {
    case POD_A_OPEN_TAB:
        if (f->view != POD_V_TABS) break;
        if (arg != POD_TAB_RECENT && (arg < 0 || arg >= m->tab_count)) break;
        { pod_frame_t t; memset(&t, 0, sizeof t); t.view = POD_V_TAB; t.tab = (int8_t)arg;
          if (arg != POD_TAB_RECENT) { size_t k = strnlen(m->tabs[arg].id, SWARM_ID_MAX - 1); memcpy(t.tab_id, m->tabs[arg].id, k); }
          push(n, &t); }
        break;
    case POD_A_ENTER_TAB: {   // Home: a tab opens straight on its first agent, with the TAB frame below it (never drawn)
        if (f->view != POD_V_TABS || arg < 0 || arg >= m->tab_count || n->depth + 2 > 4) break;
        const pod_agent_t *l[POD_AGENTS_MAX];
        if (tab_list(m, arg, l, POD_AGENTS_MAX) < 1) break;
        pod_frame_t t, af;
        memset(&t, 0, sizeof t);
        t.view = POD_V_TAB;
        t.tab = (int8_t)arg;
        { size_t k = strnlen(m->tabs[arg].id, SWARM_ID_MAX - 1); memcpy(t.tab_id, m->tabs[arg].id, k); }
        af = t;
        af.view = view_for(m, l[0]);
        set_id(af.agent, l[0]->id);
        push(n, &t);
        push(n, &af);
        opened(n, m, af.agent);
        return out_fx(POD_FX_AGENT_OPEN, af.agent);
    }
    case POD_A_OPEN_AGENT: {
        if (f->view != POD_V_TAB) break;
        const pod_agent_t *l[POD_AGENTS_MAX];
        int cnt = tab_list(m, f->tab, l, POD_AGENTS_MAX);
        if (arg < 0 || arg >= cnt) break;
        pod_frame_t t; memset(&t, 0, sizeof t);
        t.view = view_for(m, l[arg]);
        t.tab = f->tab;
        memcpy(t.tab_id, f->tab_id, sizeof t.tab_id);
        set_id(t.agent, l[arg]->id);
        if (push(n, &t)) { opened(n, m, t.agent); return out_fx(POD_FX_AGENT_OPEN, t.agent); }
        break;
    }
    case POD_A_INBOX: {
        if (f->view == POD_V_TALK || f->view == POD_V_INBOX) break;
        pod_frame_t t; memset(&t, 0, sizeof t);
        t.view = POD_V_INBOX;
        t.tab = POD_TAB_RECENT;   // the agents opened from here step through Recent
        if (n->depth >= 4) { n->stack[1] = t; n->depth = 2; }   // the stack is full: the Inbox sits right over Home, as OPEN_NOTIF does
        else push(n, &t);
        break;
    }
    case POD_A_OPEN_NOTIF: {
        if (f->view != POD_V_INBOX || arg < 0 || arg >= m->unread_count) break;
        char id[ID_MAX];
        set_id(id, m->unread[arg].agent);
        const pod_agent_t *ag = pod_model_find(m, id);
        if (!ag) pod_model_unread_read(m, id);   // an agent shown on its recap reads it there (opened, below)
        if (!ag) break;   // not on the roster: nothing to open, but it is read
        pod_frame_t t; memset(&t, 0, sizeof t);
        const pod_state_t st = pod_model_eff(m, ag);
        t.view = st != POD_WORKING && st != POD_ASKING && st != POD_OFFLINE ? POD_V_RECAP : view_for(m, ag);   // an entry is a finished or failed run, told by the recap
        set_tab(&t, m, list_of(m, id));   // the agent's own list, so a sideways swipe stays among its tab-mates
        set_id(t.agent, id);
        if (n->depth >= 4) { n->stack[1] = *f; n->depth = 2; }   // the stack is full: drop what the Inbox was opened over
        if (push(n, &t)) {
            opened(n, m, id);
            return out_fx(POD_FX_AGENT_OPEN, id);
        }
        break;
    }
    case POD_A_PREV:
    case POD_A_NEXT:
        if (is_agent_view(f->view)) return step(n, m, a == POD_A_NEXT ? 1 : -1);
        break;
    case POD_A_FOLLOW:
        if (arg >= 0 && arg < m->agent_count) {
            const bool card = n->depth == 1 && f->view == POD_V_TABS && f->scroll == POD_HOME_WORKING;
            if (!pod_nav_follow(n, m, m->agents[arg].id, now_ms)) break;
            if (card) { n->stack[1] = n->stack[2]; n->depth = 2; }   // a pet on the Working card: the room sits right over Home, so Back lands on the card, not a tab
            return out_fx(POD_FX_AGENT_OPEN, m->agents[arg].id);
        }
        break;
    case POD_A_TALK:
        if (f->view == POD_V_AGENT || f->view == POD_V_RECAP) {
            const pod_agent_t *talk_to = pod_model_find(m, f->agent);
            if (!talk_to || talk_to->state == POD_OFFLINE) break;   // an offline machine has nobody to hear it
            n->talk_prev = f->view;
            f->view = POD_V_TALK;
            n->talk_started_ms = now_ms;
            return out_fx(POD_FX_VOICE_BEGIN, f->agent);
        }
        if (f->view == POD_V_TALK) {
            if (n->sending) break;   // already sent: no second recording
            n->sending = true;       // stay on the voice screen; pod_nav_flip_recaps releases it
            n->sent_seen = false;
            n->send_started_ms = now_ms;
            set_id(n->sent_agent, f->agent);
            return out_fx(POD_FX_VOICE_END, f->agent);
        }
        break;
    case POD_A_BACK:
    case POD_A_PANES:
    case POD_A_TABS: {
        bool from_agent = a != POD_A_BACK;
        // TABS pops to the root; BACK and PANES pop one frame (an agent screen's parent is its tab's list).
        int up = a == POD_A_BACK && arg > 1 ? arg : 1;   // BACK's arg: levels to pop
        uint8_t to = a == POD_A_TABS ? 1 : n->depth > up ? (uint8_t)(n->depth - up) : 1;
        // The TAB frame is never drawn: back from a room goes Home, or to the Notices it was opened over.
        if (a != POD_A_TABS && up == 1 && is_agent_view(f->view))
            to = n->depth >= 2 && n->stack[n->depth - 2].view == POD_V_INBOX ? (uint8_t)(n->depth - 1) : 1;
        if (f->view == POD_V_TALK) {
            pod_out_t o = out_fx(POD_FX_VOICE_ABORT, f->agent);
            n->sending = false;
            n->depth = to;
            if (is_agent_view(f->view)) land_on_tab(n, m, f);
            return o;
        }
        if (from_agent && !is_agent_view(f->view) && a != POD_A_TABS) break;   // TABS is home from any screen
        n->depth = to;
        if (is_agent_view(f->view)) land_on_tab(n, m, f);
        break;
    }
    case POD_A_RECAP:
        if (f->view == POD_V_AGENT || f->view == POD_V_RECAP) {
            const pod_agent_t *ag = pod_model_find(m, f->agent);
            if (!ag || pod_model_opens_on_recap(m, ag)) break;
            f->view = f->view == POD_V_AGENT ? POD_V_RECAP : POD_V_AGENT;
        }
        break;
    case POD_A_SCROLL: {
        long s = (long)f->scroll + arg;
        if (f->view == POD_V_TABS) {
            f->scroll = (int16_t)pod_home_clamp(n, m, s < -32768 ? -32768 : s > 32767 ? 32767 : (int)s);
            n->work_page = 0;
            home_app_follows(n, m);
            break;
        }
        f->scroll = (int16_t)(s < 0 ? 0 : s > 32767 ? 32767 : s);
        break;
    }
    case POD_A_HOME_APPS:
        if (n->depth != 1 || f->view != POD_V_TABS || !pod_home_switch(m) || n->home_apps) break;
        n->home_apps = true;
        f->scroll = POD_HOME_APP0;
        home_app_follows(n, m);
        break;
    case POD_A_HOME_TABS:
        if (n->depth != 1 || f->view != POD_V_TABS || !n->home_apps) break;
        n->home_apps = false;
        f->scroll = (int16_t)(m->selected < m->tab_count ? m->selected : pod_home_clamp(n, m, 0));
        n->home_app[0] = 0;
        break;
    case POD_A_PICK_APP:   // the Mac shows that app's ring; the room opens when the ring lands, at once when it is already here
        if (n->depth != 1 || f->view != POD_V_TABS || arg < 0 || arg >= m->app_count || !m->apps[arg].count) break;
        if (strcmp(m->apps[arg].id, POD_APP_HARNESS)) pod_nav_open_app(n, m, m->apps[arg].id);   // Harness's agents are the tabs
        return out_fx(POD_FX_APP_PICK, m->apps[arg].id);
    case POD_A_NONE:
    case POD_A_BANNER:
        break;
    }
    return out_none();
}

pod_out_t pod_nav_act(pod_nav_t *n, pod_model_t *m, pod_action_t a, int arg, uint32_t now_ms) {
    pod_out_t o = nav_act(n, m, a, arg, now_ms);
    // A RECAP frame on top (opened or toggled to by any action) has its recap on screen: that agent's unread entry is read.
    if (n->depth && n->stack[n->depth - 1].view == POD_V_RECAP) pod_model_unread_read(m, n->stack[n->depth - 1].agent);
    return o;
}

void pod_nav_talk_over(pod_nav_t *n) {
    if (!n->depth) return;
    pod_frame_t *f = &n->stack[n->depth - 1];
    if (f->view != POD_V_TALK) return;
    n->sending = false;
    f->view = n->talk_prev == POD_V_RECAP ? POD_V_RECAP : POD_V_AGENT;
}

void pod_nav_unsend(pod_nav_t *n) {
    n->sent_agent[0] = 0;
    pod_nav_talk_over(n);
}

// While sending, TALK is released once the send is done and the agent's turn has really begun: Working and not the
// optimistic pod_model_sent (a turn event clears `sent`). A turn is real if it started after the stop tap, or if the model
// marked the send (sent_seen) and the daemon has spoken since. With none in POD_SENT_WAIT_MS it goes back anyway.
static void release_send(pod_nav_t *n, const pod_model_t *m, pod_frame_t *f) {
    const pod_agent_t *a = pod_model_find(m, n->sent_agent);
    if (a && a->sent) n->sent_seen = true;
    bool turn = a && a->state == POD_WORKING && !a->sent && (n->sent_seen || (int32_t)(a->since_ms - n->send_started_ms) >= 0);
    if (turn || !a || (int32_t)(m->clock_ms - n->send_started_ms) >= (int32_t)POD_SENT_WAIT_MS) {
        n->sending = false;
        f->view = turn ? POD_V_AGENT : n->talk_prev == POD_V_RECAP ? POD_V_RECAP : POD_V_AGENT;
    }
}

// An open agent that now opens on its recap shows it (never while talking or sending). The other way round,
// an agent open on its Recap that STARTS working or asking shows its Agent screen: on the edge only, so a Recap the
// person chose on a working agent (POD_A_RECAP) stays. TALK neither flips nor updates what was seen, so the edge
// that happened under it still fires when the talk is over.
void pod_nav_flip_recaps(pod_nav_t *n, pod_model_t *m) {
    if (n->depth <= 1) { n->seen_agent[0] = 0; n->seen_active = false; return; }
    pod_frame_t *f = &n->stack[n->depth - 1];
    if (f->view == POD_V_TALK && n->sending) release_send(n, m, f);
    if (f->view == POD_V_TALK) return;
    const pod_agent_t *a = pod_model_find(m, f->agent);
    pod_state_t st = a ? pod_model_eff(m, a) : POD_IDLE;
    bool active = st == POD_WORKING || st == POD_ASKING;
    if (f->view == POD_V_RECAP) {
        if (active && !n->seen_active && !strcmp(n->seen_agent, f->agent)) f->view = POD_V_AGENT;
    } else if (f->view == POD_V_AGENT) {
        if (a && pod_model_opens_on_recap(m, a)) f->view = POD_V_RECAP;
    }
    if (f->view == POD_V_RECAP) pod_model_unread_read(m, f->agent);   // the recap is on screen: read
    if (is_agent_view(f->view) && a) { set_id(n->seen_agent, f->agent); n->seen_active = active; }
    else { n->seen_agent[0] = 0; n->seen_active = false; }
}

pod_out_t pod_nav_sync(pod_nav_t *n, pod_model_t *m) {
    if (!n->depth) { pod_nav_init(n); return out_none(); }
    if (n->stack[0].view == POD_V_TABS) {   // tabs that went away take their pages with them
        pod_frame_t *h = &n->stack[0];
        if (!pod_home_switch(m)) n->home_apps = false;   // the pill went: Apps is no longer a choice
        if (pod_home_apps(n, m)) {   // the card under the person, found again by id (the list can reorder)
            uint8_t c[POD_APPS_MAX];
            const int cn = pod_home_app_cards(m, c, POD_APPS_MAX);
            for (int k = 0; k < cn && n->home_app[0]; k++)
                if (!strcmp(m->apps[c[k]].id, n->home_app)) { h->scroll = (int16_t)(POD_HOME_APP0 + k); break; }
        } else if (h->scroll >= POD_HOME_APP0) {   // the list turned from apps to tabs: the selected tab (the PM's rule), else the first
            h->scroll = (int16_t)(m->selected < m->tab_count ? m->selected : 0);
        }
        h->scroll = (int16_t)pod_home_clamp(n, m, h->scroll);   // Home: the scroll is a page of the list
        home_app_follows(n, m);
        const int pages = (pod_home_working(m) + 2) / 3;   // the Working card's pet pages: the stored page follows the working set down
        if (n->depth != 1 || n->stack[0].scroll != POD_HOME_WORKING) n->work_page = 0;
        else if (n->work_page >= pages) n->work_page = (uint8_t)(pages > 0 ? pages - 1 : 0);
    }
    uint8_t keep = n->depth;
    for (uint8_t i = 1; i < n->depth; i++) {
        pod_frame_t *f = &n->stack[i];
        if (f->tab != POD_TAB_RECENT && f->tab != POD_TAB_APP) {   // an app's ring is no tab: its agent alone keeps it
            int idx = -1;
            if (f->tab_id[0]) {
                for (int t = 0; t < m->tab_count; t++) if (!strcmp(m->tabs[t].id, f->tab_id)) { idx = t; break; }
            } else if (f->tab >= 0 && f->tab < m->tab_count) {
                idx = f->tab;
            }
            if (idx < 0) { keep = i; break; }   // the tab is closed: this frame and everything above it go
            f->tab = (int8_t)idx;
        }
        if (f->view == POD_V_TAB || f->view == POD_V_INBOX) continue;
        const pod_agent_t *l[POD_AGENTS_MAX];
        int cnt = frame_list(m, f, l, POD_AGENTS_MAX);
        bool found = false;
        for (int k = 0; k < cnt; k++) if (!strcmp(l[k]->id, f->agent)) { found = true; break; }
        if (!found) { keep = i > 1 ? (uint8_t)(i) : 1; break; }
    }
    pod_out_t o = out_none();
    const uint8_t was = n->depth;
    if (keep < n->depth) {
        const pod_frame_t *gone = &n->stack[n->depth - 1];
        if (gone->view == POD_V_TALK) o = out_fx(POD_FX_VOICE_ABORT, gone->agent);
        n->sending = false;
        n->depth = keep;
    }
    // The TAB frame is never shown: an agent popped from under it (or a tab closed) lands on Home.
    if (n->depth > 1 && n->stack[n->depth - 1].view == POD_V_TAB) n->depth = 1;
    // The ring went: Home on that app's card while it is listed. The frame just above Home holds the app id even when
    // the top was something else (the Inbox over the room); a pop leaves the stack's memory as it was.
    if (was > 1 && n->depth == 1 && n->stack[1].tab == POD_TAB_APP) land_on_tab(n, m, &n->stack[1]);
    pod_nav_flip_recaps(n, m);
    return o;
}

static int index_in(const pod_model_t *m, int tab, const char *id) {
    const pod_agent_t *l[POD_AGENTS_MAX];
    int cnt = tab_list(m, tab, l, POD_AGENTS_MAX);
    for (int i = 0; i < cnt; i++) if (!strcmp(l[i]->id, id)) return i;
    return -1;
}

bool pod_nav_follow(pod_nav_t *n, pod_model_t *m, const char *agent_id, uint32_t now_ms) {
    (void)now_ms;
    if (!agent_id || !*agent_id) return false;
    if (!n->depth) pod_nav_init(n);
    const pod_agent_t *a = pod_model_find(m, agent_id);
    if (!a) return false;
    const pod_frame_t *cur = &n->stack[n->depth - 1];
    if (cur->view == POD_V_TALK) return false;
    if ((cur->view == POD_V_AGENT || cur->view == POD_V_RECAP) && !strcmp(cur->agent, a->id)) return false;
    const int tab = list_of(m, a->id);
    int row = index_in(m, tab, a->id);
    pod_frame_t tabs, tf, af;
    memset(&tabs, 0, sizeof tabs); memset(&tf, 0, sizeof tf); memset(&af, 0, sizeof af);
    tabs.view = POD_V_TABS;
    tabs.scroll = n->stack[0].scroll;   // the grid stays on the page it was on
    tf.view = POD_V_TAB;
    set_tab(&tf, m, tab);
    tf.scroll = (int16_t)(row > 3 ? row - 3 : 0);   // the view clamps it at the list's end; the row stays in sight
    af = tf;
    af.view = view_for(m, a);
    af.scroll = 0;
    set_id(af.agent, a->id);
    n->stack[0] = tabs; n->stack[1] = tf; n->stack[2] = af;
    n->depth = 3;
    n->sending = false;
    n->work_page = 0;
    opened(n, m, a->id);
    pod_nav_flip_recaps(n, m);
    return true;
}

// The app window's selected tab changed (the model's `selected`). Device-local, so no effect is emitted. On Home the card follows. In a room
// of another tab the device moves with the app: the same agent when it is a member of the new tab (only the frames' tab is updated, so sideways
// stays inside it), else the new tab's first agent (TABS -> TAB -> room). A room on Recent (an agent no tab holds) keeps its list, a tab with no agents
// and a selection that is not a model tab (hidden) leave the screen alone. Returns whether the stack changed.
bool pod_nav_follow_tab(pod_nav_t *n, pod_model_t *m) {
    if (n->depth < 1 || m->selected < 0 || m->selected >= m->tab_count) return false;
    const int sel = m->selected;
    pod_frame_t *cur = &n->stack[n->depth - 1];
    if (cur->view == POD_V_TABS && n->depth == 1) {
        if (cur->scroll == sel || pod_home_apps(n, m)) return false;   // Home listing apps has no tab card to move to
        cur->scroll = (int16_t)sel;
        n->work_page = 0;
        return true;
    }
    if (cur->view != POD_V_AGENT && cur->view != POD_V_RECAP) return false;
    if (cur->tab < 0 || n->depth < 2) return false;   // Recent (an agent no tab holds): its own list
    if (!strcmp(cur->tab_id, m->tabs[sel].id)) return false;
    if (index_in(m, sel, cur->agent) >= 0) {
        for (int i = 1; i < n->depth; i++) {
            if (n->stack[i].view != POD_V_TAB && n->stack[i].view != POD_V_AGENT && n->stack[i].view != POD_V_RECAP) continue;
            n->stack[i].tab = (int8_t)sel;
            set_id(n->stack[i].tab_id, m->tabs[sel].id);
        }
        if (n->stack[0].scroll != POD_HOME_WORKING) home_on_tab(n, sel);   // a room opened from the Working card keeps Home on it
        return true;
    }
    const pod_agent_t *l[POD_AGENTS_MAX];
    if (tab_list(m, sel, l, POD_AGENTS_MAX) < 1) return false;
    pod_frame_t tabs, tf, af;
    memset(&tabs, 0, sizeof tabs); memset(&tf, 0, sizeof tf);
    tabs.view = POD_V_TABS;
    tf.view = POD_V_TAB;
    tf.tab = (int8_t)sel;
    set_id(tf.tab_id, m->tabs[sel].id);
    af = tf;
    af.view = view_for(m, l[0]);
    set_id(af.agent, l[0]->id);
    n->stack[0] = tabs; n->stack[1] = tf; n->stack[2] = af;
    home_on_tab(n, sel);
    n->depth = 3;
    n->sending = false;
    opened(n, m, af.agent);
    pod_nav_flip_recaps(n, m);
    return true;
}

bool pod_nav_open_app(pod_nav_t *n, pod_model_t *m, const char *app_id) {
    if (!n->depth) pod_nav_init(n);
    if (n->stack[n->depth - 1].view == POD_V_TALK) return false;
    const pod_agent_t *l[POD_AGENTS_MAX];
    if (pod_app_agents(m, app_id, l, POD_AGENTS_MAX) < 1) return false;
    pod_frame_t tabs, tf, af;
    memset(&tabs, 0, sizeof tabs); memset(&tf, 0, sizeof tf);
    tabs.view = POD_V_TABS;
    tabs.scroll = n->stack[0].scroll;
    tf.view = POD_V_TAB;
    set_tab(&tf, m, POD_TAB_APP);
    af = tf;
    af.view = view_for(m, l[0]);
    set_id(af.agent, l[0]->id);
    n->stack[0] = tabs; n->stack[1] = tf; n->stack[2] = af;
    n->depth = 3;
    n->sending = false;
    n->work_page = 0;
    home_on_app(n, m, app_id);
    opened(n, m, af.agent);
    pod_nav_flip_recaps(n, m);
    return true;
}

const char *pod_nav_origin(const pod_nav_t *n, const pod_model_t *m) {
    if (n->depth < 2) return "Back";
    const pod_frame_t *p = &n->stack[n->depth - 2];
    if (p->view == POD_V_TABS) return "Tabs";
    if (p->view == POD_V_INBOX) return "Inbox";
    if (p->view != POD_V_TAB) return "Back";
    if (p->tab == POD_TAB_RECENT) return "Recent";
    if (p->tab_id[0])   // the id names the tab; the index is only a cache
        for (int i = 0; i < m->tab_count; i++) if (!strcmp(m->tabs[i].id, p->tab_id)) return m->tabs[i].name[0] ? m->tabs[i].name : "Back";
    if (p->tab >= 0 && p->tab < m->tab_count && m->tabs[p->tab].name[0]) return m->tabs[p->tab].name;
    return "Back";
}
