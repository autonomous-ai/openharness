#include "pod/pod_model.h"

#include <string.h>

#include "pod/pod_mem.h"   // EXT_RAM_BSS_ATTR: the scratch below lives in PSRAM, not internal RAM


// ── strings ──────────────────────────────────────────────────────────────────────────────────────────

// Copy src into dst[cap], cutting at a UTF-8 codepoint boundary so the result is always valid.
void pod_copy_str(char *dst, size_t cap, const char *src) {
    size_t n = src ? strlen(src) : 0;
    if (n > cap - 1) {
        n = cap - 1;
        while (n > 0 && ((unsigned char)src[n] & 0xC0) == 0x80) n--;   // src[n] must start a codepoint
    }
    if (n && dst != src) memmove(dst, src, n);   // src may be (a view of) dst itself
    dst[n] = 0;
}

static void copy_str(char *dst, size_t cap, const char *src) { pod_copy_str(dst, cap, src); }

// Drop a trailing partial codepoint (what snprintf leaves when it cuts a string in the middle of one).
void pod_utf8_trim(char *s) {
    size_t n = strlen(s), i = n;
    while (i > 0 && ((unsigned char)s[i - 1] & 0xC0) == 0x80) i--;   // back to the lead byte (or ASCII)
    if (i == 0) { s[0] = 0; return; }
    unsigned char c = (unsigned char)s[i - 1];
    size_t need = c >= 0xF0 ? 4 : c >= 0xE0 ? 3 : c >= 0xC0 ? 2 : 1;
    if (n - (i - 1) < need) s[i - 1] = 0;
}

static bool same(const char *a, const char *b) { return a && b && !strcmp(a, b); }

// ── model ────────────────────────────────────────────────────────────────────────────────────────────

static void swarms_free(pod_model_t *m);
void pod_model_reset(pod_model_t *m) { swarms_free(m); memset(m, 0, sizeof *m); }

static uint32_t (*s_random)(void);
void pod_model_random(uint32_t (*rnd)(void)) { s_random = rnd; }

// The model's own idea of "now": the newest now_ms any feed or the renderer has shown it. It only moves forward
// (by signed difference, so it survives the uint32 wrap), and lets every reader apply the same stale rule.
static void unread_expire(pod_model_t *m);
static int unread_idx(const pod_model_t *m, const char *agent);
static void unread_drop(pod_model_t *m, int i);
void pod_model_clock(pod_model_t *m, uint32_t now_ms) {
    if (!m->clock_set || (int32_t)(now_ms - m->clock_ms) > 0) {
        m->clock_ms = now_ms;
        m->clock_set = true;
        unread_expire(m);   // every tick that moves the clock
    }
}

static int find_idx(const pod_model_t *m, const char *id) {
    if (!id || !*id) return -1;
    for (int i = 0; i < m->agent_count; i++)
        if (!strcmp(m->agents[i].id, id)) return i;
    return -1;
}

const pod_agent_t *pod_model_find(const pod_model_t *m, const char *id) {
    int i = find_idx(m, id);
    return i < 0 ? NULL : &m->agents[i];
}

// Remove the agents flagged in drop[], compacting the roster and the tabs' indices.
static bool remove_agents(pod_model_t *m, const bool drop[]) {
    int map[POD_AGENTS_MAX], out = 0;
    bool dropped = false;
    for (int i = 0; i < m->agent_count; i++) {
        if (!drop[i]) {
            map[i] = out;
            if (out != i) m->agents[out] = m->agents[i];
            out++;
        } else {
            map[i] = -1;
            dropped = true;
        }
    }
    if (!dropped) return false;
    memset(&m->agents[out], 0, (size_t)(m->agent_count - out) * sizeof m->agents[0]);
    m->agent_count = (uint8_t)out;
    // the tabs hold roster indices: follow the compaction
    for (int t = 0; t < m->tab_count; t++)
        for (int k = 0; k < POD_PANES_MAX; k++) {
            int8_t v = m->tabs[t].agent[k];
            if (v >= 0) m->tabs[t].agent[k] = (int8_t)map[v];
        }
    m->revision++;
    return true;
}

static uint32_t id_hash(const char *s) {
    uint32_t h = 2166136261u;
    for (; s && *s; s++) h = (h ^ (unsigned char)*s) * 16777619u;
    return h ? h : 1;
}

static bool is_member(const pod_model_t *m, const char *id) {
    uint32_t h = id_hash(id);
    for (int t = 0; t < m->tab_count; t++)
        for (int k = 0; k < POD_PANES_MAX; k++)
            if (m->tabs[t].member_hash[k] == h) return true;
    return false;
}

// The cap's ranking of a library-only agent: member of a tab, then working or asking, then most recent.
typedef struct { bool member, busy; int32_t age; } rank_t;
static int32_t age_key(int32_t a) { return a < 0 ? INT32_MAX : a; }
static bool rank_worse(rank_t a, rank_t b) {   // a ranks below b
    if (a.member != b.member) return !a.member;
    if (a.busy != b.busy) return !a.busy;
    return age_key(a.age) > age_key(b.age);
}
static rank_t rank_of(const pod_model_t *m, const pod_agent_t *a) {
    pod_state_t st = pod_model_eff(m, a);
    return (rank_t){is_member(m, a->id), st == POD_WORKING || st == POD_ASKING, a->age_s};
}

// A free slot for a new agent, or -1. When full it evicts the lowest-ranked library-only agent if the newcomer
// outranks it (always, for an agents.* agent: pass newcomer == NULL).
static int make_room(pod_model_t *m, const rank_t *newcomer) {
    if (m->agent_count < POD_AGENTS_MAX) return m->agent_count;
    int worst = -1;
    for (int i = 0; i < m->agent_count; i++) {
        if (m->agents[i].src & POD_SRC_TAB) continue;
        if (worst < 0 || rank_worse(rank_of(m, &m->agents[i]), rank_of(m, &m->agents[worst]))) worst = i;
    }
    if (worst < 0) return -1;
    if (newcomer && !rank_worse(rank_of(m, &m->agents[worst]), *newcomer)) return -1;
    bool drop[POD_AGENTS_MAX] = {false};
    drop[worst] = true;
    remove_agents(m, drop);
    return m->agent_count;
}

// ── change detection ─────────────────────────────────────────────────────────────────────────────────
// These feeds run on the cable_link task (12 KB stack, the parser takes ~7 of it): a pod_agent_t is ~2.7 KB (recap[]), so a feed must not
// hold a copy of one to see whether it changed anything. It takes a 64-bit FNV-1a signature of the agent's
// visible fields before and after instead. Left out: seen, lib_seen, src and age_s (sweep bookkeeping that is
// never a visible change); event_ms only when `with_event` is false (a fresh stamp alone is not one).
// A fresh slot (already zeroed): the turn stats are unknown, not zero.
static void init_agent(pod_agent_t *a) { a->tests_passed = a->tests_failed = a->commits = a->tokens_in = a->tokens_out = -1; a->step_total = -1; }

static uint64_t fnv_bytes(uint64_t h, const void *p, size_t n) {
    const unsigned char *b = p;
    while (n--) h = (h ^ *b++) * 1099511628211ull;
    return h;
}
static uint64_t fnv_str(uint64_t h, const char *s) { return fnv_bytes(h, s, strlen(s) + 1); }
static uint64_t agent_sig(const pod_agent_t *a, bool with_event) {
    uint64_t h = 14695981039346656037ull;
    h = fnv_str(h, a->id);
    h = fnv_str(h, a->name);
    h = fnv_str(h, a->engine);
    h = fnv_str(h, a->machine);
    h = fnv_str(h, a->activity);
    h = fnv_str(h, a->verb);
    h = fnv_bytes(h, &a->step_count, sizeof a->step_count);
    for (int i = 0; i < a->step_count; i++) { h = fnv_str(h, a->steps[i]); h = fnv_bytes(h, &a->step_at_s[i], sizeof a->step_at_s[i]); }
    h = fnv_bytes(h, &a->failed, sizeof a->failed);
    h = fnv_bytes(h, &a->tests_passed, sizeof a->tests_passed);
    h = fnv_bytes(h, &a->tests_failed, sizeof a->tests_failed);
    h = fnv_bytes(h, &a->commits, sizeof a->commits);
    h = fnv_bytes(h, &a->tokens_in, sizeof a->tokens_in);
    h = fnv_bytes(h, &a->tokens_out, sizeof a->tokens_out);
    h = fnv_str(h, a->question);
    h = fnv_str(h, a->super_tab);
    h = fnv_bytes(h, &a->attention, sizeof a->attention);
    h = fnv_bytes(h, &a->state, sizeof a->state);
    h = fnv_bytes(h, &a->since_ms, sizeof a->since_ms);
    h = fnv_bytes(h, &a->elapsed_s, sizeof a->elapsed_s);
    if (with_event) h = fnv_bytes(h, &a->event_ms, sizeof a->event_ms);
    h = fnv_bytes(h, &a->recap_lines, sizeof a->recap_lines);
    h = fnv_bytes(h, a->line_at, sizeof a->line_at);
    h = fnv_bytes(h, a->recap, sizeof a->recap);
    h = fnv_bytes(h, &a->recap_live, sizeof a->recap_live);
    h = fnv_bytes(h, &a->recap_cut, sizeof a->recap_cut);
    return h;
}

// Whether a feed stamped now_ms is not older than the agent's last event. event_ms is a uint32 that wraps, so
// "older" is a negative signed difference; an agent that has had no event yet takes any.
static bool event_ok(const pod_agent_t *a, uint32_t now_ms) { return !a->has_event || (int32_t)(now_ms - a->event_ms) >= 0; }
// A sweep's status while a Pod send waits for its turn: working or asking is the turn (the wait is over); anything
// else is older news than the send and is not applied.
static bool sweep_applies(pod_agent_t *a, pod_state_t s) {
    if (!a->sent) return true;
    if (s != POD_WORKING && s != POD_ASKING) return false;
    a->sent = false;
    return true;
}

void pod_model_agents_begin(pod_model_t *m) {
    for (int i = 0; i < m->agent_count; i++) m->agents[i].seen = false;
}

void pod_model_agent(pod_model_t *m, const char *id, const char *name, const char *engine, const char *machine) {
    int i = find_idx(m, id);
    if (i < 0) {
        if (!id || !*id) return;
        int slot = make_room(m, NULL);
        if (slot < 0) return;
        i = m->agent_count++;
        memset(&m->agents[i], 0, sizeof m->agents[i]);
        m->agents[i].age_s = -1;
        init_agent(&m->agents[i]);
        copy_str(m->agents[i].id, sizeof m->agents[i].id, id);
        m->revision++;
    }
    pod_agent_t *a = &m->agents[i];
    uint64_t before = agent_sig(a, true);
    copy_str(a->name, sizeof a->name, name);
    copy_str(a->engine, sizeof a->engine, engine);
    copy_str(a->machine, sizeof a->machine, machine);
    a->seen = true;
    a->src |= POD_SRC_TAB;
    if (a->state == POD_OFFLINE) a->state = POD_IDLE;   // the window lists it now: its machine is not offline
    if (before != agent_sig(a, true)) m->revision++;
}

// agents.end: the window's tab is complete. Agents it did not re-send lose the TAB source; one with no source
// left goes.
void pod_model_agents_end(pod_model_t *m) {
    bool drop[POD_AGENTS_MAX] = {false};
    for (int i = 0; i < m->agent_count; i++) {
        pod_agent_t *a = &m->agents[i];
        if ((a->src & POD_SRC_TAB) && !a->seen) {
            a->src &= (uint8_t)~POD_SRC_TAB;
            if (!a->src) drop[i] = true;
        }
    }
    remove_agents(m, drop);
}

void pod_model_library_begin(pod_model_t *m) {
    for (int i = 0; i < m->agent_count; i++) m->agents[i].lib_seen = false;
}

static pod_state_t state_of_status(const char *status) {
    if (!strcmp(status, "working")) return POD_WORKING;
    if (!strcmp(status, "question")) return POD_ASKING;
    if (!strcmp(status, "finished")) return POD_DONE;
    return POD_IDLE;   // idle, failed, paused, offline, anything new
}

// A sentence the agent has moved on from joins the turn's steps (newest first, no repeats, the oldest falls off).
// Each keeps the seconds into the turn it arrived at (0xFFFF when no turn.started was seen: a rebuilt list has no times).
static void drop_step(pod_agent_t *a, int at) {
    for (int i = at; i + 1 < a->step_count; i++) {
        memcpy(a->steps[i], a->steps[i + 1], POD_STEP_BYTES);
        a->step_at_s[i] = a->step_at_s[i + 1];
    }
    a->step_count--;
}
static void push_step(pod_agent_t *a, const char *old, uint32_t now_ms) {
    if (!old[0]) return;
    char cut[POD_STEP_BYTES];
    copy_str(cut, sizeof cut, old);
    for (int i = 0; i < a->step_count; i++) if (!strcmp(a->steps[i], cut)) { drop_step(a, i); break; }
    if (a->step_count == POD_STEPS_MAX) { a->step_count--; }
    for (int i = a->step_count; i > 0; i--) {
        memcpy(a->steps[i], a->steps[i - 1], POD_STEP_BYTES);
        a->step_at_s[i] = a->step_at_s[i - 1];
    }
    memcpy(a->steps[0], cut, sizeof cut);
    const uint32_t s = (now_ms - a->since_ms) / 1000;   // unsigned: the clock wraps
    a->step_at_s[0] = !a->turn_started ? 0xFFFF : s > 0xFFFE ? 0xFFFE : (uint16_t)s;
    a->step_count++;
    if (a->step_total >= 0 && a->step_total < INT16_MAX) a->step_total++;
}

static void set_state(pod_model_t *m, pod_agent_t *a, pod_state_t s, uint32_t now_ms);

void pod_model_library_row(pod_model_t *m, const char *id, const char *name, const char *engine, const char *machine,
                           const char *status, int32_t age_s, uint32_t now_ms) {
    if (!id || !*id) return;
    pod_model_clock(m, now_ms);
    pod_state_t st = state_of_status(status ? status : "idle");
    int i = find_idx(m, id);
    if (i < 0) {
        rank_t r = {is_member(m, id), st == POD_WORKING || st == POD_ASKING, age_s};
        if (make_room(m, &r) < 0) return;
        i = m->agent_count++;
        memset(&m->agents[i], 0, sizeof m->agents[i]);
        init_agent(&m->agents[i]);
        copy_str(m->agents[i].id, sizeof m->agents[i].id, id);
        m->revision++;
    }
    pod_agent_t *a = &m->agents[i];
    uint64_t before = agent_sig(a, true);   // the age ticks every sweep: not part of the signature
    bool tab_owned = (a->src & POD_SRC_TAB) != 0;   // agents.* is authoritative for what it lists
    if (!tab_owned || !a->name[0]) copy_str(a->name, sizeof a->name, name);
    if (!tab_owned || !a->engine[0]) copy_str(a->engine, sizeof a->engine, engine);
    if (!tab_owned || !a->machine[0]) copy_str(a->machine, sizeof a->machine, machine);
    a->src |= POD_SRC_LIBRARY;
    a->lib_seen = true;
    a->age_s = age_s;
    // Capped at 20 days: idle_for() compares in signed 32-bit ms (24.8 days), and an older age wrapped to "now".
    if (age_s >= 0) { a->lib_ms = now_ms - (uint32_t)(age_s < POD_LIB_AGE_MAX_S ? age_s : POD_LIB_AGE_MAX_S) * 1000u; a->has_lib = true; }
    if (before != agent_sig(a, true)) m->revision++;
    if (event_ok(a, now_ms) && status && sweep_applies(a, st)) {
        uint64_t was = agent_sig(a, false);   // a fresh stamp alone is not a visible change
        set_state(m, a, st, now_ms);
        if (was != agent_sig(a, false)) m->revision++;
    }
}

void pod_model_library_end(pod_model_t *m) {
    bool drop[POD_AGENTS_MAX] = {false};
    for (int i = 0; i < m->agent_count; i++) {
        pod_agent_t *a = &m->agents[i];
        if ((a->src & POD_SRC_LIBRARY) && !a->lib_seen) {
            a->src &= (uint8_t)~POD_SRC_LIBRARY;
            if (!a->src) drop[i] = true;
        }
    }
    remove_agents(m, drop);
}

// The tab members that only the daemon's metadata knows. Members of an offline machine, listed by no roster source, join as
// POD_OFFLINE with the META source; the source is dropped every frame and given back to the ones still listed (and still
// offline), and an agent left with no source goes. Runs before the tabs are built, so their indices see the result.
static void sync_meta_members(pod_model_t *m, const char *const *agent_ids[], const uint8_t counts[], int n,
                              const pod_member_meta_t (*meta)[POD_PANES_MAX]) {
    for (int i = 0; i < m->agent_count; i++) m->agents[i].src &= (uint8_t)~POD_SRC_TAB_META;
    for (int t = 0; t < n; t++) {
        int ids = counts && agent_ids && agent_ids[t] ? counts[t] : 0;
        if (ids > POD_PANES_MAX) ids = POD_PANES_MAX;
        for (int k = 0; k < ids; k++) {
            const pod_member_meta_t *mm = &meta[t][k];
            if (!mm->has || !agent_ids[t][k] || !*agent_ids[t][k]) continue;
            int i = find_idx(m, agent_ids[t][k]);
            if (i < 0) {
                if (mm->online) continue;   // an online agent arrives with the library; only the offline ones need this
                if (make_room(m, NULL) < 0) continue;
                i = m->agent_count++;
                memset(&m->agents[i], 0, sizeof m->agents[i]);
                m->agents[i].age_s = -1;
                init_agent(&m->agents[i]);
                m->agents[i].state = POD_OFFLINE;
                copy_str(m->agents[i].id, sizeof m->agents[i].id, agent_ids[t][k]);
                copy_str(m->agents[i].name, sizeof m->agents[i].name, mm->name);
                copy_str(m->agents[i].engine, sizeof m->agents[i].engine, mm->engine);
                copy_str(m->agents[i].machine, sizeof m->agents[i].machine, mm->machine);
                m->agents[i].src = POD_SRC_TAB_META;
                m->revision++;
            } else if (m->agents[i].state == POD_OFFLINE) {   // one of ours from an earlier frame
                m->agents[i].src |= POD_SRC_TAB_META;
                if (mm->online) { m->agents[i].state = POD_IDLE; m->revision++; }   // the machine is back; the library fills in the rest
            }
        }
    }
    bool drop[POD_AGENTS_MAX] = {false};
    for (int i = 0; i < m->agent_count; i++) if (!m->agents[i].src) drop[i] = true;
    remove_agents(m, drop);
}

void pod_model_swarms(pod_model_t *m, const cable_swarm_t *items, const char *const *agent_ids[],
                      const uint8_t agent_id_counts[], int n, const char *selected,
                      const cable_tile_t *tiles, int tile_count) {
    pod_model_swarms_meta(m, items, agent_ids, agent_id_counts, n, selected, tiles, tile_count, NULL);
}

void pod_model_swarms_meta(pod_model_t *m, const cable_swarm_t *items, const char *const *agent_ids[],
                           const uint8_t agent_id_counts[], int n, const char *selected,
                           const cable_tile_t *tiles, int tile_count, const pod_member_meta_t (*meta)[POD_PANES_MAX]) {
    // ~9.7 KB: far over the cable_link task's 12 KB stack, so it is file-static. Every model feed is single-writer
    // (the cable task, under pro_app_lock), so one scratch is never used by two callers at once.
    static EXT_RAM_BSS_ATTR pod_tab_t nt[POD_TABS_MAX];
    memset(nt, 0, sizeof nt);
    if (n < 0 || !items) n = 0;
    if (n > POD_TABS_MAX) n = POD_TABS_MAX;
    if (meta) sync_meta_members(m, agent_ids, agent_id_counts, n, meta);
    if (tile_count < 0 || !tiles) tile_count = 0;
    if (tile_count > POD_PANES_MAX) tile_count = POD_PANES_MAX;

    int sel = -1;
    for (int i = 0; i < n; i++)
        if (same(items[i].id, selected)) { sel = i; break; }
    if (sel < 0) sel = 0;

    // A tab with no agent (only shells or viewers, or nothing at all) is not shown: nothing on the Pod can drive it.
    int out = 0, nsel_out = -1;
    for (int i = 0; i < n; i++) {
        int ids = (agent_ids && agent_id_counts && agent_ids[i]) ? agent_id_counts[i] : 0;
        bool has_agent = items[i].agents > 0 || ids > 0;
        if (i == sel) for (int k = 0; k < tile_count && !has_agent; k++) if (tiles[k].agent_id[0]) has_agent = true;
        if (!has_agent) continue;
        if (i == sel) nsel_out = out;
        pod_tab_t *t = &nt[out++];
        copy_str(t->id, sizeof t->id, items[i].id);
        copy_str(t->name, sizeof t->name, items[i].name);
        int panes = items[i].panes < 0 ? 0 : items[i].panes > 255 ? 255 : items[i].panes;
        t->panes = (uint8_t)panes;
        for (int k = 0; k < POD_PANES_MAX; k++) t->agent[k] = -1;

        if (ids > 0) {
            if (ids > POD_PANES_MAX) ids = POD_PANES_MAX;
            t->members_known = true;
            t->count = (uint8_t)ids;
            for (int k = 0; k < ids; k++) {
                t->agent[k] = (int8_t)find_idx(m, agent_ids[i][k]);
                t->member_hash[k] = id_hash(agent_ids[i][k]);
            }
        } else {
            int c = items[i].agents < 0 ? 0 : items[i].agents > 255 ? 255 : items[i].agents;
            t->count = (uint8_t)c;
        }

        if (i == sel && tile_count > 0) {
            // The tiles are the layout, and they say who sits where: agent[k] stays aligned with rect[k], so a
            // shell or viewer tile is -1 and holds its place, and the daemon's agentIds order (which is not the
            // tile order) never moves a mark. The ids only add members that have no tile.
            t->has_rects = true;
            for (int k = 0; k < POD_PANES_MAX; k++) { t->agent[k] = -1; t->member_hash[k] = 0; }
            for (int k = 0; k < tile_count; k++) {
                t->rect[k] = (pod_rect_t){tiles[k].x1, tiles[k].y1, tiles[k].x2, tiles[k].y2};
                t->agent[k] = (int8_t)find_idx(m, tiles[k].agent_id);
                if (tiles[k].agent_id[0]) t->member_hash[k] = id_hash(tiles[k].agent_id);
            }
            int slot = tile_count;
            for (int j = 0; j < ids && slot < POD_PANES_MAX; j++) {
                uint32_t h = id_hash(agent_ids[i][j]);
                bool have = false;
                for (int k = 0; k < slot; k++) if (t->member_hash[k] == h) { have = true; break; }
                if (!have) t->member_hash[slot++] = h;
            }
            t->members_known = true;
            t->count = (uint8_t)tile_count;
        }
    }

    // The window's tab hidden here: selected points past the list, so no tab is marked current.
    uint8_t nsel = (uint8_t)(nsel_out >= 0 ? nsel_out : out);
    if (out != m->tab_count || nsel != m->selected || memcmp(nt, m->tabs, sizeof nt)) {
        memcpy(m->tabs, nt, sizeof nt);
        m->tab_count = (uint8_t)out;
        m->selected = nsel;
        m->revision++;
    }
}

// Every state feed carries the clock; the newest by event_ms wins (equal: the later call). A feed older
// than the agent's current event is ignored.
static pod_agent_t *fresh_agent(pod_model_t *m, const char *id, uint32_t now_ms) {
    pod_model_clock(m, now_ms);
    int i = find_idx(m, id);
    if (i < 0 || !event_ok(&m->agents[i], now_ms)) return NULL;
    return &m->agents[i];
}

static void set_state(pod_model_t *m, pod_agent_t *a, pod_state_t s, uint32_t now_ms) {
    // A Super Tab's question is the agent's work waiting on a person, not a dialog in its pane: a turn that starts or
    // ends, a library sweep or a send does not end it. Only question.close (or the link going) does.
    if (a->state == POD_ASKING && a->super_tab[0] && s != POD_ASKING) { a->wait_after = (uint8_t)s; return; }
    if (s == POD_WORKING && a->state != POD_WORKING) a->since_ms = now_ms;
    if (s != POD_ASKING) {
        a->question[0] = 0;
        a->super_tab[0] = 0;
        a->attention = POD_ATTN_NONE;
        if (a->state == POD_ASKING) {   // the question is over, however: its toast entry is stale
            int u = unread_idx(m, a->id);
            if (u >= 0 && m->unread[u].ask) unread_drop(m, u);
        }
    }
    if (s == POD_WORKING && a->state != POD_WORKING && a->state != POD_ASKING) {   // a new turn without a turn.started
        a->failed = false;
        a->step_total = -1;
        a->work_alt = s_random && (s_random() & 1u);   // chef or builder, for the whole turn
    }
    if (s != POD_WORKING) { a->activity[0] = 0; a->verb[0] = 0; a->step_count = 0; a->turn_started = false; }
    // A task starting or ending is news; idle <-> done <-> offline from a sweep (a machine back, a boot's first look) is not.
    bool busy_now = s == POD_WORKING || s == POD_ASKING, busy_was = a->state == POD_WORKING || a->state == POD_ASKING;
    if (a->state != s && (busy_now || busy_was)) { a->act_ms = now_ms; a->has_act = true; }
    a->state = s;
    a->event_ms = now_ms;
    a->has_event = true;
}

void pod_model_library_status(pod_model_t *m, const char *id, const char *status, uint32_t now_ms) {
    pod_agent_t *a = fresh_agent(m, id, now_ms);
    if (!a || !status) return;
    pod_state_t s;
    if (!strcmp(status, "working")) s = POD_WORKING;
    else if (!strcmp(status, "question")) s = POD_ASKING;
    else if (!strcmp(status, "finished")) s = POD_DONE;
    else s = POD_IDLE;   // idle, failed, paused, offline, anything new
    if (!sweep_applies(a, s)) return;
    uint64_t before = agent_sig(a, true);
    set_state(m, a, s, now_ms);
    if (before != agent_sig(a, true)) m->revision++;
}

void pod_model_turn(pod_model_t *m, const char *id, const char *kind, const char *text, int elapsed_s, uint32_t now_ms) {
    pod_agent_t *a = fresh_agent(m, id, now_ms);
    if (!a || !kind) return;
    uint64_t before = agent_sig(a, true);
    const bool was_busy = a->state == POD_WORKING || a->state == POD_ASKING;
    a->sent = false;   // the daemon speaks for the turn now
    if (!strcmp(kind, "started")) {
        set_state(m, a, POD_WORKING, now_ms);
        a->since_ms = now_ms;
        a->elapsed_s = 0;
        a->activity[0] = 0;
        a->verb[0] = 0;
        a->step_count = 0;
        a->step_total = 0;
        a->turn_started = true;
        a->failed = false;
        a->tests_passed = a->tests_failed = a->commits = a->tokens_in = a->tokens_out = -1;
    } else if (!strcmp(kind, "verb")) {
        if (a->state == POD_ASKING) return;
        set_state(m, a, POD_WORKING, now_ms);
        // Same rule as the sentence: an empty read says nothing. The word keeps its text, not its dots.
        if (text && *text) {
            char w[POD_VERB_BYTES + 8];
            copy_str(w, sizeof w, text);
            size_t b = 0, n = strlen(w);
            while (w[b] == ' ' || w[b] == '\t' || w[b] == '\r' || w[b] == '\n') b++;
            while (n > b && (w[n - 1] == ' ' || w[n - 1] == '\t' || w[n - 1] == '\r' || w[n - 1] == '\n')) n--;
            if (n >= b + 3 && (!memcmp(w + n - 3, "...", 3) || !memcmp(w + n - 3, "\xe2\x80\xa6", 3))) n -= 3;
            while (n > b && w[n - 1] == ' ') n--;
            w[n] = 0;
            if (n > b) copy_str(a->verb, sizeof a->verb, w + b);
        }
    } else if (!strcmp(kind, "activity")) {
        if (a->state == POD_ASKING) return;   // only turn.started or question.close ends a question
        set_state(m, a, POD_WORKING, now_ms);
        // An empty read says nothing: the daemon sends turn.activity with no text when the terminal shows no footer
        // (every ~3 s, and right after each turn.started heartbeat), and a missing reading is not "no activity". Only
        // a text replaces the line; a new turn (started) or a state change away from working is what clears it.
        // Blanking here made the body text appear with the heartbeat and vanish ~40 ms later, every 3-5 s.
        if (text && *text) {
            if (strcmp(text, a->activity)) push_step(a, a->activity, now_ms);
            copy_str(a->activity, sizeof a->activity, text);
            a->activity_cut = strlen(text) >= sizeof a->activity;
            for (int i = 0; i < a->step_count; i++) if (!strcmp(a->steps[i], a->activity)) { drop_step(a, i); break; }
        }
        a->elapsed_s = elapsed_s < 0 ? 0 : (uint32_t)elapsed_s;
    } else if (!strcmp(kind, "step")) {
        // A tool the turn just started ("Read · pod_model.c"): the newest grey line. A turn of tool calls and no
        // prose had nothing else to show, and the body stayed empty through all of it.
        if (a->state == POD_ASKING) return;
        if (text && *text) { set_state(m, a, POD_WORKING, now_ms); push_step(a, text, now_ms); }
    } else if (!strcmp(kind, "done")) {
        set_state(m, a, POD_DONE, now_ms);
    } else if (!strcmp(kind, "error")) {
        set_state(m, a, POD_IDLE, now_ms);
        a->failed = true;
    }
    // A task's clock: only an event inside a turn. A stray done for an idle agent (the daemon's focus read, a replay)
    // is not a task, and stamping it put agents with no turn at the top of Recent (owner, 2026-10-11).
    const bool busy = a->state == POD_WORKING || a->state == POD_ASKING;
    if ((was_busy || busy) && (!strcmp(kind, "started") || !strcmp(kind, "activity") || !strcmp(kind, "verb") ||
                               !strcmp(kind, "step") || !strcmp(kind, "done") || !strcmp(kind, "error"))) {
        a->act_ms = now_ms; a->has_act = true;
    }
    if (before != agent_sig(a, true)) m->revision++;
}

void pod_model_turn_stats(pod_model_t *m, const char *id, int32_t passed, int32_t failed, int32_t commits, int32_t tokens_in, int32_t tokens_out) {
    int i = find_idx(m, id);
    if (i < 0) return;
    pod_agent_t *a = &m->agents[i];
    uint64_t before = agent_sig(a, true);
    if (passed >= 0) a->tests_passed = passed;
    if (failed >= 0) a->tests_failed = failed;
    if (commits >= 0) a->commits = commits;
    if (tokens_in >= 0) a->tokens_in = tokens_in;
    if (tokens_out >= 0) a->tokens_out = tokens_out;
    if (before != agent_sig(a, true)) m->revision++;
}

// question / question_close carry no clock, so they leave event_ms alone (the library status that
// accompanies a question refreshes it).
void pod_model_question(pod_model_t *m, const char *id, const char *text) { pod_model_question_tab(m, id, text, NULL, POD_ATTN_NONE); }

void pod_model_question_tab(pod_model_t *m, const char *id, const char *text, const char *super_tab, pod_attention_t attention) {
    int i = find_idx(m, id);
    if (i < 0) return;
    pod_agent_t *a = &m->agents[i];
    uint64_t before = agent_sig(a, true);
    if (a->state != POD_ASKING && m->clock_set) { a->act_ms = m->clock_ms; a->has_act = true; }
    a->sent = false;
    const bool tab = super_tab && super_tab[0];
    // A plain question that ends goes back to work (question_close); a Super Tab wait to what it held back.
    if (tab && !(a->state == POD_ASKING && a->super_tab[0]))
        a->wait_after = (uint8_t)(a->state == POD_ASKING ? POD_WORKING : a->state);
    a->state = POD_ASKING;
    a->activity[0] = 0;
    copy_str(a->question, sizeof a->question, text);
    copy_str(a->super_tab, sizeof a->super_tab, tab ? super_tab : "");
    a->attention = (uint8_t)(!tab ? POD_ATTN_NONE : attention == POD_ATTN_STUCK ? POD_ATTN_STUCK : POD_ATTN_DECISION);
    if (before != agent_sig(a, true)) m->revision++;
}

pod_attention_t pod_model_attention(const pod_model_t *m, const pod_agent_t *a) {
    if (!a || !a->super_tab[0] || pod_model_eff(m, a) != POD_ASKING) return POD_ATTN_NONE;
    return a->attention == POD_ATTN_STUCK ? POD_ATTN_STUCK : POD_ATTN_DECISION;
}

void pod_model_question_close(pod_model_t *m, const char *id) {
    int i = find_idx(m, id);
    if (i < 0 || m->agents[i].state != POD_ASKING) return;
    pod_agent_t *a = &m->agents[i];
    // A plain question is answered mid-turn: the turn goes on. A Super Tab wait outlived its turns, so the agent takes
    // the state they left it in: idle or done, not a Working nobody is doing.
    const pod_state_t next = a->super_tab[0] ? (pod_state_t)a->wait_after : POD_WORKING;
    a->state = next == POD_ASKING ? POD_WORKING : next;
    if (a->state != POD_WORKING) { a->activity[0] = 0; a->verb[0] = 0; a->step_count = 0; a->turn_started = false; }
    m->agents[i].question[0] = 0;
    m->agents[i].super_tab[0] = 0;
    m->agents[i].attention = POD_ATTN_NONE;
    int u = unread_idx(m, id);
    if (u >= 0 && m->unread[u].ask) unread_drop(m, u);   // answered: its toast entry is stale
    m->revision++;
}

// ── recap ────────────────────────────────────────────────────────────────────────────────────────────

// The recap is stored as up to POD_RECAP_LINES NUL-terminated lines, back to back. A line ends at ". ",
// "! ", "? " (the mark stays, the space goes), at the end of the text, or at a newline.
//
// There is no "…" in the font, so a cut is a FLAG (recap_cut) the Recap view turns into "...". It is set when
// the source says it was cut (a trailing "…" or the daemon's old " +" marker, both removed here) and when this
// function has to drop text itself (out of bytes or lines; the cut is at a word, never inside a codepoint).
static void split_recap(pod_agent_t *a, const char *s) {
    memset(a->recap, 0, sizeof a->recap);
    memset(a->line_at, 0, sizeof a->line_at);
    a->recap_lines = 0;
    a->recap_cut = false;
    if (!s) return;
    size_t len = strlen(s);
    while (len && (s[len - 1] == ' ' || s[len - 1] == '\t' || s[len - 1] == '\r' || s[len - 1] == '\n')) len--;
    for (;;) {   // markers of a cut source, however many were stacked
        if (len >= 2 && s[len - 2] == ' ' && s[len - 1] == '+') len -= 2;
        else if (len >= 3 && !memcmp(s + len - 3, "\xE2\x80\xA6", 3)) len -= 3;
        else if (len >= 3 && !memcmp(s + len - 3, "...", 3)) len -= 3;
        else break;
        a->recap_cut = true;
        while (len && (s[len - 1] == ' ' || s[len - 1] == '\t' || s[len - 1] == '\r' || s[len - 1] == '\n')) len--;
    }
    const char *end = s + len;
    size_t pos = 0, cap = sizeof a->recap;

    while (s < end) {
        while (s < end && (*s == ' ' || *s == '\t' || *s == '\r' || *s == '\n')) s++;
        if (s >= end) break;
        const char *e = s;
        while (e < end && *e != '\n' && *e != '\r') {
            if ((*e == '.' || *e == '!' || *e == '?') && (e + 1 == end || e[1] == ' ' || e[1] == '\n' || e[1] == '\r')) {
                e++;
                break;
            }
            e++;
        }
        if (a->recap_lines >= POD_RECAP_LINES || pos + 1 >= cap) { a->recap_cut = true; break; }   // pos == cap: the last line filled it
        size_t n = (size_t)(e - s), ls = pos;
        if (pos + n + 1 <= cap) {
            memcpy(a->recap + pos, s, n);
            pos += n;
            a->recap[pos] = 0;
        } else {
            // out of room: keep what fits, back to a word (or at least a codepoint boundary)
            size_t room = cap - 1 - pos;
            while (room > 0 && ((unsigned char)s[room] & 0xC0) == 0x80) room--;
            size_t w = room;
            while (w > 0 && s[w] != ' ') w--;
            if (w > room / 2) room = w;
            while (room > 0 && s[room - 1] == ' ') room--;
            memcpy(a->recap + pos, s, room);
            pos += room;
            a->recap[pos] = 0;
            if (room) a->line_at[a->recap_lines++] = (uint16_t)ls;
            a->recap_cut = true;
            return;
        }
        a->line_at[a->recap_lines++] = (uint16_t)ls;
        pos++;   // the line's NUL
        s = e;
    }
}

// A restore (the daemon replays each agent's last recap once per link) is older history. It fills an
// empty recap or replaces another restore, but never a live summary: a live one is always newer, even when
// the restore arrives later. A live summary always replaces whatever is there.
void pod_model_recap(pod_model_t *m, const char *id, const char *recap, bool restore) {
    int i = find_idx(m, id);
    if (i < 0) return;
    pod_agent_t *a = &m->agents[i];
    if (restore && a->recap_live) return;
    uint64_t before = agent_sig(a, true);
    split_recap(a, recap);
    a->recap_live = !restore;
    if (before != agent_sig(a, true)) m->revision++;
}

void pod_model_link(pod_model_t *m, bool up) {
    if (m->linked == up) return;
    m->linked = up;
    if (!up) {   // a drop forgets every open question (pro_app clears them): the daemon re-sends what is still owed
        for (int i = m->unread_count - 1; i >= 0; i--)
            if (m->unread[i].ask) unread_drop(m, i);
        // A Super Tab wait becomes a plain question, which the next turn or sweep ends as any other: nothing vouches
        // for it with the cable gone, and the daemon asks it again on the next link if it still waits.
        for (int i = 0; i < m->agent_count; i++) {
            m->agents[i].super_tab[0] = 0;
            m->agents[i].attention = POD_ATTN_NONE;
        }
        swarms_free(m);   // the daemon sends the Swarm list again on the next link, and the open recap is asked for again
        m->swarm_n = 0;
        m->want_n = 0;
        m->swarm_ids = false;
        m->focus_pending = false;
    }
    m->revision++;
}

// ---- the Swarm cards ----
#include "pod/pod_mem.h"   // pod_big_alloc: a Lead's recap text lives in PSRAM
#ifndef ESP_PLATFORM
int pod_big_alloc_fail;
#endif

static void lead_free_text(pod_lead_t *l) { free(l->text); l->text = NULL; }
static void swarms_free(pod_model_t *m) {
    for (int i = 0; i < m->swarm_n && i < SWARMS_CARD_MAX; i++)
        for (int j = 0; j < m->swarms[i].lead_n && j < SWARM_LEADS_MAX; j++) lead_free_text(&m->swarms[i].leads[j]);
}

int pod_model_lead_index(const pod_swarm_t *s, const char *lead_id) {
    if (!s || !lead_id || !*lead_id) return -1;
    for (int j = 0; j < s->lead_n; j++)
        if (!strcmp(s->leads[j].id, lead_id)) return j;
    return -1;
}

const pod_swarm_t *pod_model_swarm(const pod_model_t *m, const char *swarm_id) {
    if (!swarm_id || !*swarm_id) return NULL;
    for (int i = 0; i < m->swarm_n; i++)
        if (!strcmp(m->swarms[i].id, swarm_id)) return &m->swarms[i];
    return NULL;
}

const pod_swarm_t *pod_model_swarm_for_tab(const pod_model_t *m, const char *tab_id) {
    if (!tab_id || !*tab_id) return NULL;
    for (int i = 0; i < m->swarm_n; i++)
        if (!strcmp(m->swarms[i].tab, tab_id)) return &m->swarms[i];
    return NULL;
}

static int want_idx(const pod_model_t *m, const char *id) {
    for (int i = 0; i < m->want_n; i++)
        if (!strcmp(m->want[i], id)) return i;
    return -1;
}

void pod_model_supertab_ids(pod_model_t *m, const char (*ids)[ID_MAX], int n) {
    static EXT_RAM_BSS_ATTR pod_swarm_t tmp;   // one Swarm (3 KB) is too much for the cable_link stack
    if (!ids || n < 0) n = 0;
    m->swarm_ids = true;
    m->want_n = 0;
    for (int i = 0; i < n && m->want_n < SWARMS_CARD_MAX; i++) {
        if (!ids[i][0] || memchr(ids[i], 0, ID_MAX) == NULL || want_idx(m, ids[i]) >= 0) continue;
        memcpy(m->want[m->want_n++], ids[i], ID_MAX);
    }
    int k = 0;   // keep the listed ones, free the rest
    for (int i = 0; i < m->swarm_n; i++) {
        if (want_idx(m, m->swarms[i].id) < 0) {
            for (int j = 0; j < m->swarms[i].lead_n; j++) lead_free_text(&m->swarms[i].leads[j]);
            continue;
        }
        if (k != i) m->swarms[k] = m->swarms[i];   // ownership of the texts moves with the struct
        k++;
    }
    if (k < m->swarm_n) memset(&m->swarms[k], 0, (size_t)(m->swarm_n - k) * sizeof m->swarms[0]);
    m->swarm_n = (uint8_t)k;
    for (int t = 0; t < m->swarm_n; t++) {   // selection sort by the list's order
        int best = t;
        for (int i = t + 1; i < m->swarm_n; i++)
            if (want_idx(m, m->swarms[i].id) < want_idx(m, m->swarms[best].id)) best = i;
        if (best == t) continue;
        tmp = m->swarms[t]; m->swarms[t] = m->swarms[best]; m->swarms[best] = tmp;
    }
    m->revision++;
}

void pod_model_supertab(pod_model_t *m, const pod_swarm_t *s, uint32_t now_ms) {
    if (!s || !s->id[0]) return;
    const int w = want_idx(m, s->id);
    if (w < 0) return;   // not in the last id list (the list comes first)
    pod_model_clock(m, now_ms);
    int at = -1;
    for (int i = 0; i < m->swarm_n; i++)
        if (!strcmp(m->swarms[i].id, s->id)) at = i;
    if (at < 0) {   // new: slot it in before the first received Swarm that the list puts after it
        at = m->swarm_n;
        for (int i = 0; i < m->swarm_n; i++)
            if (want_idx(m, m->swarms[i].id) > w) { at = i; break; }
        if (m->swarm_n >= SWARMS_CARD_MAX) return;
        memmove(&m->swarms[at + 1], &m->swarms[at], (size_t)(m->swarm_n - at) * sizeof m->swarms[0]);
        memset(&m->swarms[at], 0, sizeof m->swarms[0]);
        m->swarm_n++;
    }
    pod_swarm_t *d = &m->swarms[at];
    struct { pod_recap_state_t recap; char *text; uint32_t text_at; } carry[SWARM_LEADS_MAX];
    memset(carry, 0, sizeof carry);
    const int ln = s->lead_n > SWARM_LEADS_MAX ? SWARM_LEADS_MAX : s->lead_n;
    for (int j = 0; j < ln; j++) {
        const int k = pod_model_lead_index(d, s->leads[j].id);
        if (k < 0) continue;
        pod_lead_t *ol = &d->leads[k];   // taken over: the old copy no longer owns the text
        carry[j].recap = ol->recap; carry[j].text = ol->text; carry[j].text_at = ol->text_at;
        ol->text = NULL;
        if (strcmp(ol->chat_id, s->leads[j].chat_id)) {   // another chat: the old message is not its message
            free(carry[j].text);
            carry[j].text = NULL; carry[j].text_at = 0;
            if (carry[j].recap != POD_RECAP_NONE) carry[j].recap = POD_RECAP_LOADING;   // asked for (open): "…" until the daemon pushes the new chat's
        }
    }
    for (int j = 0; j < d->lead_n; j++) lead_free_text(&d->leads[j]);   // the ones that left
    *d = *s;
    d->lead_n = (uint8_t)ln;
    for (int j = 0; j < SWARM_LEADS_MAX; j++) {
        pod_lead_t *l = &d->leads[j];
        if (j >= ln) { memset(l, 0, sizeof *l); continue; }
        l->text = carry[j].text;
        l->recap = carry[j].recap;
        l->text_at = carry[j].text_at;
        l->since_at_ms = now_ms;
    }
    m->revision++;
}

void pod_model_supertab_recap(pod_model_t *m, const char *tab, const char *lead, const char *chat_id, const char *text, uint32_t at, bool none) {
    const pod_swarm_t *s = pod_model_swarm(m, tab);
    const int j = pod_model_lead_index(s, lead);
    if (j < 0) return;
    pod_lead_t *l = &((pod_swarm_t *)s)->leads[j];
    if (chat_id && chat_id[0] && l->chat_id[0] && strcmp(chat_id, l->chat_id)) return;   // a reply for a chat the face has left (both name one)
    if (l->recap == POD_RECAP_NONE) return;   // a Lead nobody asked for or has left: a late reply would only sit there stale
    lead_free_text(l);
    l->text_at = at;
    if (none || !text) {
        l->recap = POD_RECAP_EMPTY;
    } else {
        l->text = pod_big_alloc(SWARM_TEXT_MAX);
        if (!l->text) { l->recap = POD_RECAP_LOADING; m->revision++; return; }   // out of memory: still waiting, so the retry asks again
        pod_copy_str(l->text, SWARM_TEXT_MAX, text);
        l->recap = POD_RECAP_LOADED;
    }
    m->revision++;
}

void pod_model_supertab_loading(pod_model_t *m, const char *tab, const char *lead) {
    const pod_swarm_t *s = pod_model_swarm(m, tab);
    const int j = pod_model_lead_index(s, lead);
    if (j < 0 || s->leads[j].recap != POD_RECAP_NONE) return;
    ((pod_swarm_t *)s)->leads[j].recap = POD_RECAP_LOADING;
    m->revision++;
}

void pod_model_supertab_close(pod_model_t *m, const char *tab, const char *lead) {
    const pod_swarm_t *s = pod_model_swarm(m, tab);
    const int j = pod_model_lead_index(s, lead);
    if (j < 0 || s->leads[j].recap == POD_RECAP_NONE) return;
    pod_lead_t *l = &((pod_swarm_t *)s)->leads[j];
    lead_free_text(l);
    l->recap = POD_RECAP_NONE;
    m->revision++;
}

void pod_model_supertab_focus(pod_model_t *m, const char *tab, const char *lead) {
    if (!tab || !*tab || !lead) return;   // an empty lead is kept: the Swarm opens on the Lead last shown there
    pod_copy_str(m->focus_tab, sizeof m->focus_tab, tab);
    pod_copy_str(m->focus_lead, sizeof m->focus_lead, lead);
    m->focus_pending = true;
    m->revision++;
}

void pod_model_sent(pod_model_t *m, const char *id, uint32_t now_ms) {
    pod_model_clock(m, now_ms);
    int i = find_idx(m, id);
    if (i < 0) return;
    pod_agent_t *a = &m->agents[i];
    uint64_t before = agent_sig(a, true);
    if (a->state != POD_WORKING) { set_state(m, a, POD_WORKING, now_ms); a->elapsed_s = 0; }
    a->sent = true;
    a->sent_ms = now_ms;
    if (before != agent_sig(a, true)) m->revision++;
}

// ── queries ──────────────────────────────────────────────────────────────────────────────────────────

// How long ago the agent last had a task, in ms at the model's clock; UINT32_MAX when nothing is known.
static uint32_t idle_for(const pod_model_t *m, const pod_agent_t *a) {
    uint32_t best = UINT32_MAX;
    const struct { bool has; uint32_t t; } at[2] = {{a->has_act, a->act_ms}, {a->has_lib, a->lib_ms}};
    for (int k = 0; k < 2; k++) {
        if (!at[k].has) continue;
        int32_t d = (int32_t)(m->clock_ms - at[k].t);
        uint32_t age = d < 0 ? 0u : (uint32_t)d;
        if (age < best) best = age;
    }
    return best;
}
static bool busy_eff(const pod_model_t *m, const pod_agent_t *a) {
    pod_state_t st = pod_model_eff(m, a);
    return st == POD_WORKING || st == POD_ASKING;
}
// `a` comes before `b` when it is busy and b is not (only when picking the set), or is more recent; roster order breaks ties.
static bool recent_before(const pod_model_t *m, int a, int b, bool busy_first) {
    if (busy_first && busy_eff(m, &m->agents[a]) != busy_eff(m, &m->agents[b])) return busy_eff(m, &m->agents[a]);
    uint32_t ia = idle_for(m, &m->agents[a]), ib = idle_for(m, &m->agents[b]);
    return ia != ib ? ia < ib : a < b;
}
int pod_model_recent(const pod_model_t *m, const pod_agent_t *out[], int max) {
    if (max > POD_RECENT_MAX) max = POD_RECENT_MAX;
    int idx[POD_AGENTS_MAX], n = 0;
    for (int i = 0; i < m->agent_count; i++)   // an offline agent never had a task here
        if (m->agents[i].state != POD_OFFLINE && idle_for(m, &m->agents[i]) != UINT32_MAX) idx[n++] = i;
    // The set: busy first, then most recent. Then the chosen ones newest first.
    for (int pass = 0; pass < 2; pass++) {
        for (int i = 1; i < n; i++) {
            int v = idx[i], j = i;
            for (; j > 0 && recent_before(m, v, idx[j - 1], pass == 0); j--) idx[j] = idx[j - 1];
            idx[j] = v;
        }
        if (pass == 0 && n > max) n = max;
    }
    if (n > max) n = max;
    for (int i = 0; i < n; i++) out[i] = &m->agents[idx[i]];
    return n < 0 ? 0 : n;
}

int pod_model_working(const pod_model_t *m, const pod_agent_t *out[], int max) {
    int n = 0;
    for (int i = 0; i < m->agent_count && n < max; i++) {
        pod_state_t st = pod_model_eff(m, &m->agents[i]);
        if (st == POD_WORKING || st == POD_ASKING) out[n++] = &m->agents[i];
    }
    return n;
}

pod_state_t pod_model_state(const pod_model_t *m, const pod_agent_t *a, uint32_t now_ms) {
    (void)m;
    if (!a) return POD_IDLE;
    if (a->state == POD_WORKING && a->sent && (int32_t)(now_ms - a->sent_ms) > (int32_t)POD_SENT_WAIT_MS) return POD_IDLE;
    return a->state;
}

pod_state_t pod_model_eff(const pod_model_t *m, const pod_agent_t *a) { return pod_model_state(m, a, m->clock_ms); }

bool pod_model_opens_on_recap(const pod_model_t *m, const pod_agent_t *a) {
    if (!a) return false;
    pod_state_t st = pod_model_eff(m, a);
    return (st == POD_DONE || st == POD_IDLE) && a->recap_lines > 0;
}

// ── unread notifications ─────────────────────────────────────────────────────────────────────────────

static int unread_idx(const pod_model_t *m, const char *agent) {
    if (!agent || !*agent) return -1;
    for (int i = 0; i < m->unread_count; i++) if (!strcmp(m->unread[i].agent, agent)) return i;
    return -1;
}
static void unread_drop(pod_model_t *m, int i) {
    memmove(&m->unread[i], &m->unread[i + 1], (size_t)(m->unread_count - i - 1) * sizeof m->unread[0]);
    m->unread_count--;
    m->revision++;
}

// An entry older than POD_UNREAD_TTL_MS since receipt goes; the signed difference survives the uint32 wrap.
static void unread_expire(pod_model_t *m) {
    for (int i = m->unread_count - 1; i >= 0; i--)
        if ((int32_t)(m->clock_ms - m->unread[i].at_ms) >= (int32_t)POD_UNREAD_TTL_MS) unread_drop(m, i);
}

void pod_model_unread_add(pod_model_t *m, const char *agent, const char *name, const char *text, int32_t elapsed_s, uint32_t now_ms) {
    if (!agent || !*agent || strnlen(agent, ID_MAX) >= ID_MAX) return;
    pod_model_clock(m, now_ms);
    int i = unread_idx(m, agent);
    if (i >= 0) unread_drop(m, i);
    else if (m->unread_count >= POD_UNREAD_MAX) unread_drop(m, m->unread_count - 1);   // the oldest
    memmove(&m->unread[1], &m->unread[0], (size_t)m->unread_count * sizeof m->unread[0]);
    pod_unread_t *u = &m->unread[0];
    memset(u, 0, sizeof *u);
    pod_copy_str(u->agent, sizeof u->agent, agent);
    pod_copy_str(u->name, sizeof u->name, name);
    pod_copy_str(u->text, sizeof u->text, text);
    u->at_ms = now_ms;
    u->elapsed_s = elapsed_s;
    const pod_agent_t *a = pod_model_find(m, agent);
    u->kind = a && a->failed ? POD_UNREAD_FAILED : POD_UNREAD_FINISHED;
    m->unread_count++;
    m->revision++;
}

void pod_model_unread_ask(pod_model_t *m, const char *agent, const char *name, const char *text, uint32_t now_ms) {
    pod_model_unread_add(m, agent, name, text, -1, now_ms);
    int i = unread_idx(m, agent);
    if (i >= 0) m->unread[i].ask = true;
}

void pod_model_swarm_notice(pod_model_t *m, const char *tab, const char *lead, const char *chat_id, const char *text, uint32_t now_ms) {
    if (!tab || !*tab || !lead || !*lead) return;
    const pod_swarm_t *sw = pod_model_swarm(m, tab);
    const int j = pod_model_lead_index(sw, lead);
    if (j < 0) return;
    char project[CABLE_NAME_MAX];
    pod_copy_str(project, sizeof project, sw->leads[j].project);
    pod_model_unread_add(m, lead, project, text, -1, now_ms);
    pod_unread_t *u = &m->unread[0];   // add puts it on top
    pod_copy_str(u->tab, sizeof u->tab, sw->id);
    pod_copy_str(u->chat_id, sizeof u->chat_id, chat_id);
}

bool pod_model_swarm_notice_read(pod_model_t *m, const char *tab, const char *lead, const char *chat_id) {
    int i = unread_idx(m, lead);
    if (i < 0 || !tab || strcmp(m->unread[i].tab, tab) || strcmp(m->unread[i].chat_id, chat_id ? chat_id : "")) return false;
    unread_drop(m, i);
    return true;
}

int pod_notice_count(const pod_model_t *m) {
    int n = 0;
    for (int i = 0; i < m->agent_count; i++) n += pod_model_eff(m, &m->agents[i]) == POD_ASKING;
    for (int i = 0; i < m->unread_count; i++) {
        const pod_agent_t *ag = pod_model_find(m, m->unread[i].agent);
        n += !(ag && pod_model_eff(m, ag) == POD_ASKING);   // an asking agent is listed by its question; its entry waits
    }
    return n;
}

void pod_model_unread_clear(pod_model_t *m) {
    m->unread_count = 0;
    m->revision++;
}

void pod_model_unread_clear_agents(pod_model_t *m) {   // a Swarm notice (tab set) is not in a notif.replace list: it stays
    int k = 0;
    for (int i = 0; i < m->unread_count; i++)
        if (m->unread[i].tab[0]) m->unread[k++] = m->unread[i];
    m->unread_count = k;
    m->revision++;
}

void pod_model_unread_append(pod_model_t *m, const char *agent, const char *name, const char *token, const char *text, uint32_t now_ms) {
    if (!agent || !*agent || strnlen(agent, ID_MAX) >= ID_MAX || m->unread_count >= POD_UNREAD_MAX || unread_idx(m, agent) >= 0) return;
    pod_model_clock(m, now_ms);
    pod_unread_t *u = &m->unread[m->unread_count++];
    memset(u, 0, sizeof *u);
    pod_copy_str(u->agent, sizeof u->agent, agent);
    pod_copy_str(u->name, sizeof u->name, name);
    pod_copy_str(u->token, sizeof u->token, token);
    pod_copy_str(u->text, sizeof u->text, text);
    u->at_ms = now_ms;
    u->elapsed_s = -1;
    m->revision++;
}

bool pod_model_unread_seen(pod_model_t *m, const char *agent, const char *token) {
    int i = unread_idx(m, agent);
    if (i < 0) return false;
    if (token && *token && (!m->unread[i].token[0] || strcmp(token, m->unread[i].token))) return false;   // another occurrence: a newer turn is not eaten
    unread_drop(m, i);
    return true;
}

bool pod_model_unread_read(pod_model_t *m, const char *agent) {
    int i = unread_idx(m, agent);
    if (i < 0) return false;
    if (m->unread[i].token[0]) {
        if (m->read_count >= POD_READS_MAX) {   // a full queue loses its oldest
            memmove(&m->reads[0], &m->reads[1], (POD_READS_MAX - 1) * sizeof m->reads[0]);
            m->read_count--;
        }
        pod_read_out_t *r = &m->reads[m->read_count++];
        pod_copy_str(r->agent, sizeof r->agent, m->unread[i].agent);
        pod_copy_str(r->token, sizeof r->token, m->unread[i].token);
    }
    unread_drop(m, i);
    return true;
}

const pod_unread_t *pod_model_unread_find(const pod_model_t *m, const char *agent) {
    int i = unread_idx(m, agent);
    return i < 0 ? NULL : &m->unread[i];
}

int pod_model_take_reads(pod_model_t *m, pod_read_out_t out[], int max) {
    int n = m->read_count < max ? m->read_count : max;
    memcpy(out, m->reads, (size_t)n * sizeof out[0]);
    memmove(&m->reads[0], &m->reads[n], (size_t)(m->read_count - n) * sizeof m->reads[0]);
    m->read_count = (uint8_t)(m->read_count - n);
    return n;
}
