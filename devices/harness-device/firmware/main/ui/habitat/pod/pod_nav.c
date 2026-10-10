#include "pod/pod_nav.h"

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

static bool is_agent_view(pod_view_t v) { return v == POD_V_AGENT || v == POD_V_RECAP || v == POD_V_TALK; }

// The list a frame's agent steps through. For an agent frame in the Recent tab the open agent stays in the list
// (at the end, if it has dropped out of the newest 8) even after it falls off, so the user is not thrown out of it.
static int frame_list(const pod_model_t *m, const pod_frame_t *f, const pod_agent_t *out[], int max) {
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

static pod_view_t view_for(const pod_model_t *m, const pod_agent_t *a) { return pod_model_opens_on_recap(m, a) ? POD_V_RECAP : POD_V_AGENT; }

static pod_out_t step(pod_nav_t *n, const pod_model_t *m, int dir) {
    pod_frame_t *f = &n->stack[n->depth - 1];
    const pod_agent_t *l[POD_AGENTS_MAX];
    int cnt = frame_list(m, f, l, POD_AGENTS_MAX), at = -1;
    for (int i = 0; i < cnt; i++) if (!strcmp(l[i]->id, f->agent)) { at = i; break; }
    if (at < 0) return out_none();
    bool talking = f->view == POD_V_TALK;
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
    return o;
}

pod_out_t pod_nav_act(pod_nav_t *n, pod_model_t *m, pod_action_t a, int arg, uint32_t now_ms) {
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
        if (push(n, &t)) {
            pod_model_opened(m, t.agent, now_ms);   // the Recent list ranks by it
            return out_fx(POD_FX_AGENT_OPEN, t.agent);
        }
        break;
    }
    case POD_A_PREV:
    case POD_A_NEXT:
        if (is_agent_view(f->view)) return step(n, m, a == POD_A_NEXT ? 1 : -1);
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
            f->view = POD_V_AGENT;
            n->send_started_ms = now_ms;
            n->send_hold = true;
            set_id(n->sent_agent, f->agent);
            return out_fx(POD_FX_VOICE_END, f->agent);
        }
        break;
    case POD_A_BACK:
    case POD_A_PANES:
    case POD_A_TABS: {
        bool from_agent = a != POD_A_BACK;
        // TABS pops to the root; BACK and PANES pop one frame (an agent screen's parent is its tab's list).
        uint8_t to = a == POD_A_TABS ? 1 : n->depth > 1 ? (uint8_t)(n->depth - 1) : 1;
        if (f->view == POD_V_TALK) {
            pod_out_t o = out_fx(POD_FX_VOICE_ABORT, f->agent);
            n->depth = to;
            return o;
        }
        if (from_agent && !is_agent_view(f->view)) break;
        n->depth = to;
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
        f->scroll = (int16_t)(s < 0 ? 0 : s > 32767 ? 32767 : s);
        break;
    }
    case POD_A_NONE:
        break;
    }
    return out_none();
}

void pod_nav_talk_over(pod_nav_t *n) {
    if (!n->depth) return;
    pod_frame_t *f = &n->stack[n->depth - 1];
    if (f->view != POD_V_TALK) return;
    f->view = n->talk_prev == POD_V_RECAP ? POD_V_RECAP : POD_V_AGENT;
}

void pod_nav_unsend(pod_nav_t *n) {
    n->sent_agent[0] = 0;
    n->send_hold = false;
}

// Whether SEND still holds the view on AGENT for this frame. It lasts until the agent's next turn starts (its
// since_ms is then at or after the send) or 15 s have passed on the model's clock, whichever comes first.
static bool send_holds(pod_nav_t *n, const pod_model_t *m, const pod_frame_t *f) {
    if (!n->send_hold) return false;
    const pod_agent_t *a = pod_model_find(m, n->sent_agent);
    bool turn_began = a && pod_model_eff(m, a) == POD_WORKING && (int32_t)(a->since_ms - n->send_started_ms) >= 0;
    if (!a || turn_began || (int32_t)(m->clock_ms - n->send_started_ms) > 15000) {
        n->send_hold = false;
        return false;
    }
    return !strcmp(f->agent, n->sent_agent);
}

// An open agent that now opens on its recap shows it (never while talking, nor right after SEND). The other way round,
// an agent open on its Recap that STARTS working or asking shows its Agent screen: on the edge only, so a Recap the
// person chose on a working agent (POD_A_RECAP) stays. TALK neither flips nor updates what was seen, so the edge
// that happened under it still fires when the talk is over.
void pod_nav_flip_recaps(pod_nav_t *n, const pod_model_t *m) {
    if (n->depth <= 1) { n->seen_agent[0] = 0; n->seen_active = false; return; }
    pod_frame_t *f = &n->stack[n->depth - 1];
    if (f->view == POD_V_TALK) return;
    const pod_agent_t *a = pod_model_find(m, f->agent);
    pod_state_t st = a ? pod_model_eff(m, a) : POD_IDLE;
    bool active = st == POD_WORKING || st == POD_ASKING;
    if (f->view == POD_V_RECAP) {
        if (active && !n->seen_active && !strcmp(n->seen_agent, f->agent)) f->view = POD_V_AGENT;
    } else if (f->view == POD_V_AGENT) {
        bool hold = send_holds(n, m, f);   // always evaluated: seeing the turn start is what releases it
        if (a && pod_model_opens_on_recap(m, a) && !hold) f->view = POD_V_RECAP;
    }
    if (is_agent_view(f->view) && a) { set_id(n->seen_agent, f->agent); n->seen_active = active; }
    else { n->seen_agent[0] = 0; n->seen_active = false; }
}

pod_out_t pod_nav_sync(pod_nav_t *n, const pod_model_t *m) {
    if (!n->depth) { pod_nav_init(n); return out_none(); }
    uint8_t keep = n->depth;
    for (uint8_t i = 1; i < n->depth; i++) {
        pod_frame_t *f = &n->stack[i];
        if (f->tab != POD_TAB_RECENT) {
            int idx = -1;
            if (f->tab_id[0]) {
                for (int t = 0; t < m->tab_count; t++) if (!strcmp(m->tabs[t].id, f->tab_id)) { idx = t; break; }
            } else if (f->tab >= 0 && f->tab < m->tab_count) {
                idx = f->tab;
            }
            if (idx < 0) { keep = i; break; }   // the tab is closed: this frame and everything above it go
            f->tab = (int8_t)idx;
        }
        if (f->view == POD_V_TAB) continue;
        const pod_agent_t *l[POD_AGENTS_MAX];
        int cnt = frame_list(m, f, l, POD_AGENTS_MAX);
        bool found = false;
        for (int k = 0; k < cnt; k++) if (!strcmp(l[k]->id, f->agent)) { found = true; break; }
        if (!found) { keep = i > 1 ? (uint8_t)(i) : 1; break; }
    }
    pod_out_t o = out_none();
    if (keep < n->depth) {
        const pod_frame_t *top = &n->stack[n->depth - 1];
        if (top->view == POD_V_TALK) o = out_fx(POD_FX_VOICE_ABORT, top->agent);
        n->depth = keep;
    }
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
    if (!agent_id || !*agent_id) return false;
    if (!n->depth) pod_nav_init(n);
    const pod_agent_t *a = pod_model_find(m, agent_id);
    if (!a) return false;
    const pod_frame_t *cur = &n->stack[n->depth - 1];
    if (cur->view == POD_V_TALK) return false;
    if ((cur->view == POD_V_AGENT || cur->view == POD_V_RECAP) && !strcmp(cur->agent, a->id)) return false;
    int tab = POD_TAB_RECENT;
    if (m->selected < m->tab_count && index_in(m, m->selected, a->id) >= 0) tab = m->selected;
    else for (int t = 0; t < m->tab_count; t++) if (index_in(m, t, a->id) >= 0) { tab = t; break; }
    pod_model_opened(m, a->id, now_ms);   // before the row is looked up: Recent ranks by it
    int row = index_in(m, tab, a->id);
    pod_frame_t tabs, tf, af;
    memset(&tabs, 0, sizeof tabs); memset(&tf, 0, sizeof tf); memset(&af, 0, sizeof af);
    tabs.view = POD_V_TABS;
    tabs.scroll = n->stack[0].scroll;   // the grid stays on the page it was on
    tf.view = POD_V_TAB;
    tf.tab = (int8_t)tab;
    if (tab != POD_TAB_RECENT) set_id(tf.tab_id, m->tabs[tab].id);
    tf.scroll = (int16_t)(row > 3 ? row - 3 : 0);   // the view clamps it at the list's end; the row stays in sight
    af = tf;
    af.view = view_for(m, a);
    af.scroll = 0;
    set_id(af.agent, a->id);
    n->stack[0] = tabs; n->stack[1] = tf; n->stack[2] = af;
    n->depth = 3;
    n->send_hold = false;
    pod_nav_flip_recaps(n, m);
    return true;
}
