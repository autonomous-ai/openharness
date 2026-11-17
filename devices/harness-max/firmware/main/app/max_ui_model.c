// The lanes model: the cable's feeds and the app's own state, kept for the view and the finger, and the outbox
// (max_ui.h). Questions are max_ui_ask.c's, New Harness max_ui_form.c's.
#include <stdio.h>
#include <string.h>

#include "max_ui_internal.h"
#include "pod/pod_mem.h"   // EXT_RAM_BSS_ATTR: the agents' text is tens of KB, PSRAM on the device

EXT_RAM_BSS_ATTR max_model_t max_m;
// Scratch for the feeds: the roster before an agents feed (staying agents keep their turn), and one lane before a turn
// feed (to tell whether it changed). Both are too big for the cable_link task's stack.
static EXT_RAM_BSS_ATTR max_agent_t s_old[MAX_AGENTS];
static EXT_RAM_BSS_ATTR max_agent_t s_before;

void max_copy(char *dst, size_t cap, const char *src)
{
    if (!cap) return;
    if (!src) src = "";
    size_t n = 0;
    while (n < cap - 1 && src[n]) n++;
    // Cut inside a code point: drop its first bytes too.
    if (src[n])
        while (n > 0 && ((unsigned char)src[n] & 0xc0) == 0x80) n--;
    for (size_t i = 0; i < n; i++) {
        const unsigned char c = (unsigned char)src[i];
        dst[i] = c < 0x20 || c == 0x7f ? ' ' : (char)c;   // a newline or a tab would end or garble a one-line run
    }
    dst[n] = 0;
}

static bool running(max_state_t st) { return st == MAX_WORKING || st == MAX_ASKING; }

max_agent_t *max_find(const char *id)
{
    for (int i = 0; id && i < max_m.count; i++)
        if (!strcmp(max_m.agents[i].id, id)) return &max_m.agents[i];
    return NULL;
}

static int group(const max_agent_t *a)
{
    if (a->state == MAX_ASKING || a->state == MAX_FAILED) return 0;
    return a->state == MAX_WORKING ? 1 : 2;
}
int max_order(int out[MAX_AGENTS])
{
    int n = 0;
    for (int g = 0; g < 3; g++)
        for (int i = 0; i < max_m.count; i++)
            if (group(&max_m.agents[i]) == g) out[n++] = i;
    return n;
}

// The lanes: every agent but the room's, in lane order.
static int lane_order(int out[MAX_AGENTS])
{
    int o[MAX_AGENTS], n = max_order(o), k = 0;
    for (int i = 0; i < n; i++)
        if (strcmp(max_m.agents[o[i]].id, max_m.selected)) out[k++] = o[i];
    return k;
}

int max_pages(void)
{
    int o[MAX_AGENTS];
    return (lane_order(o) + MAX_LANES - 1) / MAX_LANES;
}

void max_clamp_page(void)
{
    const int last = max_pages() - 1;
    if (max_m.page > last) max_m.page = last;
    if (max_m.page < 0) max_m.page = 0;
}

int64_t max_secs(const max_agent_t *a, uint32_t now_ms)
{
    if (!a->clock) return -1;
    return running(a->state) ? (int64_t)a->clock_s + (uint32_t)(now_ms - a->clock_ms) / 1000u : (int64_t)a->clock_s;
}

bool max_note_shown(const max_agent_t *a, uint32_t now_ms)
{
    if (!a->note[0]) return false;
    if (a->state == MAX_FAILED) return true;
    return a->state == MAX_DONE && (int32_t)(a->note_until - now_ms) > 0;
}

bool max_notice_shown(uint32_t now_ms)
{
    return max_m.notice[0] && (int32_t)(max_m.notice_until - now_ms) > 0;
}

void max_fmt_elapsed(char *out, size_t cap, int64_t secs)
{
    if (!cap) return;
    if (secs < 0) out[0] = 0;
    else if (secs < 3600) snprintf(out, cap, "%d:%02d", (int)(secs / 60), (int)(secs % 60));
    else snprintf(out, cap, "%lld:%02d:%02d", (long long)(secs / 3600), (int)(secs / 60 % 60), (int)(secs % 60));
}

int max_visible(int out[MAX_LANES])
{
    int o[MAX_AGENTS], n = lane_order(o), k = 0;
    for (int i = max_m.page * MAX_LANES; i < n && k < MAX_LANES; i++) out[k++] = o[i];
    return k;
}

// What is drawn with a clock or a summary: the lanes of the page shown, then the room's agent. Returns how many.
static int drawn(int out[MAX_LANES + 1])
{
    int n = max_visible(out);
    const max_agent_t *room = max_find(max_m.selected);
    if (room) out[n++] = (int)(room - max_m.agents);
    return n;
}

bool max_room_show(const char *id)
{
    if (!strcmp(max_m.selected, id)) return false;
    max_copy(max_m.selected, sizeof max_m.selected, id);
    max_clamp_page();   // the agent it showed is back among the lanes
    return true;
}

uint32_t max_fnv(uint32_t h, const void *data, size_t n)
{
    const unsigned char *p = data;
    for (size_t i = 0; i < n; i++) h = (h ^ p[i]) * 16777619u;
    return h;
}
uint32_t max_time_key(uint32_t now_ms)
{
    uint32_t h = 2166136261u;
    int v[MAX_LANES + 1], n = drawn(v);
    for (int i = 0; i < n; i++) {
        const max_agent_t *a = &max_m.agents[v[i]];
        const int64_t secs = max_secs(a, now_ms);
        const bool note = max_note_shown(a, now_ms);
        h = max_fnv(h, &secs, sizeof secs);
        h = max_fnv(h, &note, sizeof note);
    }
    const bool notice = max_notice_shown(now_ms);
    return max_fnv(h, &notice, sizeof notice);
}

void max_ui_reset(void)
{
    memset(&max_m, 0, sizeof max_m);
    max_m.update_pct = -1;
}

// ---- the outbox ----

max_out_t *max_out_push(max_out_kind_t kind)
{
    if (max_m.out_count >= MAX_OUTBOX) return NULL;
    max_out_t *o = &max_m.outbox[max_m.out_count++];
    memset(o, 0, sizeof *o);
    o->kind = kind;
    return o;
}

int max_ui_take(max_out_t *out, int cap, max_answer_t *answer, uint32_t now_ms)
{
    if (max_m.link) {
        max_ask_due(now_ms);
        max_form_due(now_ms);
    }
    int n = 0, i = 0;
    bool answered = false;
    for (; i < max_m.out_count && n < cap; i++) {
        const max_out_t *o = &max_m.outbox[i];
        if (o->kind == MAX_OUT_ANSWER) {
            if (answered) break;   // one answer's words a take: the next take hands out the rest
            if (!max_ask_taken(o, answer, now_ms)) continue;   // its question went meanwhile
            answered = true;
            max_m.dirty = true;
        }
        out[n++] = *o;
    }
    memmove(max_m.outbox, max_m.outbox + i, (size_t)(max_m.out_count - i) * sizeof max_m.outbox[0]);
    max_m.out_count -= i;
    return n;
}

bool max_ui_unsent(const max_out_t *o, uint32_t now_ms)
{
    switch (o->kind) {
    case MAX_OUT_REVIEWED:
    case MAX_OUT_ANSWER: return max_ask_unsent(o, now_ms);
    case MAX_OUT_FORM: return max_form_unsent(o, now_ms);
    default: return false;   // a read is sent again by the clock
    }
}

// ---- feeds ----

bool max_ui_link(bool up, const char *machine, uint32_t now_ms)
{
    (void)now_ms;
    if (up) {
        char name[CABLE_NAME_MAX];
        max_copy(name, sizeof name, machine);
        const bool changed = !max_m.link || strcmp(max_m.computer, name);
        max_m.link = true;
        memcpy(max_m.computer, name, sizeof name);
        return changed;
    }
    // Everything the daemon told us goes with the link: a lane is a claim that the agent is there now. So do the
    // questions, the form and whatever was queued for a daemon that is no longer there.
    const bool changed = max_m.link || max_m.count || max_m.machine_count || max_m.computer[0] || max_form_open();
    max_m.link = false;
    max_m.computer[0] = 0;
    max_m.count = max_m.machine_count = 0;
    max_m.selected[0] = 0;
    max_m.page = 0;
    memset(max_m.asks, 0, sizeof max_m.asks);
    max_form_reset();
    max_m.out_count = 0;
    return changed;
}

bool max_ui_agents(const pro_agent_row_t *rows, int n, uint32_t now_ms)
{
    (void)now_ms;
    const int old = max_m.count;
    memcpy(s_old, max_m.agents, (size_t)old * sizeof s_old[0]);
    int k = 0;
    for (int i = 0; i < n && k < MAX_AGENTS; i++) {
        const pro_agent_row_t *r = &rows[i];
        if (!r->id || !r->id[0]) continue;
        bool twice = false;
        for (int j = 0; j < k && !twice; j++) twice = !strncmp(max_m.agents[j].id, r->id, ID_MAX - 1);
        if (twice) continue;
        max_agent_t *a = &max_m.agents[k++];
        int j = 0;
        while (j < old && strncmp(s_old[j].id, r->id, ID_MAX - 1)) j++;
        if (j < old) *a = s_old[j];   // it stays: its turn goes on
        else {
            memset(a, 0, sizeof *a);
            max_copy(a->id, sizeof a->id, r->id);
        }
        max_copy(a->name, sizeof a->name, r->name && r->name[0] ? r->name : r->id);
        max_copy(a->engine, sizeof a->engine, r->engine);
        max_copy(a->machine_id, sizeof a->machine_id, r->machine_id);
        max_copy(a->machine, sizeof a->machine, r->machine);
    }
    max_m.count = k;
    for (int i = 0; i < MAX_AGENTS; i++)   // a question goes with its agent
        if (max_m.asks[i].agent[0] && !max_find(max_m.asks[i].agent)) max_m.asks[i].agent[0] = 0;
    bool changed = k != old || memcmp(max_m.agents, s_old, (size_t)k * sizeof s_old[0]);
    if (!max_find(max_m.selected)) {   // the room's agent left, or there was none: the agent that leads the lanes
        int o[MAX_AGENTS];
        changed |= max_room_show(max_order(o) ? max_m.agents[o[0]].id : "");
    }
    max_clamp_page();
    return changed;
}

bool max_ui_machines(const cable_machine_t *rows, int count, const char *selected)
{
    (void)selected;   // the machine a new agent would start on: the bar starts none in this milestone
    if (count < 0) count = 0;
    if (count > CABLE_MAX_MACHINES) count = CABLE_MAX_MACHINES;
    bool changed = count != max_m.machine_count;
    for (int i = 0; i < count; i++) {
        cable_machine_t m;
        memset(&m, 0, sizeof m);
        max_copy(m.id, sizeof m.id, rows[i].id);
        max_copy(m.name, sizeof m.name, rows[i].name);
        max_copy(m.state, sizeof m.state, rows[i].state);
        m.local = rows[i].local;
        changed |= memcmp(&m, &max_m.machines[i], sizeof m) != 0;
        max_m.machines[i] = m;
    }
    max_m.machine_count = count;
    return changed;
}

// A state change stops the clock where it is when the turn ends, and drops it when a turn we did not see start
// begins (until the daemon says how long it has run).
void max_set_state(max_agent_t *a, max_state_t st, uint32_t now_ms)
{
    const bool was = running(a->state), will = running(st);
    if (was && !will && a->clock) {
        a->clock_s = (uint32_t)max_secs(a, now_ms);
        a->clock_ms = now_ms;
    }
    if (!was && will) a->clock = false;
    a->state = st;
}

static void push_step(max_agent_t *a, const char *text)
{
    char step[MAX_STEP_BYTES];
    max_copy(step, sizeof step, text);
    for (int i = 0; i < a->step_count; i++)
        if (!strcmp(a->steps[i], step)) {
            memmove(a->steps[i], a->steps[i + 1], (size_t)(a->step_count - 1 - i) * MAX_STEP_BYTES);
            a->step_count--;
            break;
        }
    if (a->step_count == MAX_STEPS) a->step_count--;
    memmove(a->steps[1], a->steps[0], (size_t)a->step_count * MAX_STEP_BYTES);
    memcpy(a->steps[0], step, sizeof step);
    a->step_count++;
}

// The spinner word without its dots ("Infusing..." reads "Infusing").
static void set_verb(max_agent_t *a, const char *text)
{
    char w[MAX_VERB_BYTES];
    max_copy(w, sizeof w, text);
    size_t b = 0, n = strlen(w);
    while (w[b] == ' ') b++;
    while (n > b && w[n - 1] == ' ') n--;
    if (n >= b + 3 && (!memcmp(w + n - 3, "...", 3) || !memcmp(w + n - 3, "\xe2\x80\xa6", 3))) n -= 3;
    while (n > b && w[n - 1] == ' ') n--;
    w[n] = 0;
    if (n > b) memcpy(a->verb, w + b, n - b + 1);
}

static bool turn(max_agent_t *a, const char *kind, const char *text, int elapsed_s, uint32_t now_ms)
{
    const bool said = text && text[0];
    if (!strcmp(kind, "started")) {
        max_set_state(a, MAX_WORKING, now_ms);
        a->clock = true;
        a->clock_s = 0;
        a->clock_ms = now_ms;
        max_copy(a->activity, sizeof a->activity, text);
        a->verb[0] = a->question[0] = a->note[0] = 0;
        a->step_count = 0;
        a->ask_key = 0;
        a->card = false;
        max_ask_drop(a->id);
        return true;
    }
    if (!strcmp(kind, "done")) {
        if (a->state != MAX_DONE) a->note[0] = 0;   // the summary that follows says what it did
        max_set_state(a, MAX_DONE, now_ms);
        a->question[0] = 0;
        a->card = false;
        max_ask_drop(a->id);
        return true;
    }
    if (!strcmp(kind, "error")) {
        max_set_state(a, MAX_FAILED, now_ms);
        a->question[0] = 0;
        max_copy(a->note, sizeof a->note, text);
        a->card = true;   // a failure is an alert: its card stays until dismissed
        max_ask_drop(a->id);
        return true;
    }
    // Progress waits while the agent asks: only turn.started or the question's close ends a question.
    if (a->state == MAX_ASKING) return false;
    if (!strcmp(kind, "verb")) {
        max_set_state(a, MAX_WORKING, now_ms);
        if (said) set_verb(a, text);
    } else if (!strcmp(kind, "activity")) {
        max_set_state(a, MAX_WORKING, now_ms);
        // An empty reading says nothing: the daemon sends one when the terminal shows no footer.
        if (said) max_copy(a->activity, sizeof a->activity, text);
        if (elapsed_s >= 0 && max_secs(a, now_ms) != elapsed_s) {
            a->clock = true;
            a->clock_s = (uint32_t)elapsed_s;
            a->clock_ms = now_ms;
        }
    } else if (!strcmp(kind, "step")) {
        if (!said) return false;
        max_set_state(a, MAX_WORKING, now_ms);
        push_step(a, text);
    } else {
        return false;
    }
    return true;
}

bool max_ui_turn(const char *id, const char *kind, const char *text, int elapsed_s, uint32_t now_ms)
{
    max_agent_t *a = max_find(id);
    if (!a || !kind) return false;
    s_before = *a;
    return turn(a, kind, text, elapsed_s, now_ms) && memcmp(&s_before, a, sizeof *a) != 0;
}

bool max_ui_summary(const char *id, const char *text, const char *recap, bool restore, pod_tier_t tier,
                    uint32_t now_ms)
{
    max_agent_t *a = max_find(id);
    if (!a || restore) return false;   // history filled back in: never news
    s_before = *a;
    // "done" is the daemon's placeholder when the turn had nothing to say: the recap speaks instead.
    const char *say = text && text[0] && strcmp(text, "done") ? text : recap && recap[0] ? recap : NULL;
    if (a->state == MAX_FAILED) {
        if (!a->note[0]) max_copy(a->note, sizeof a->note, say);   // the error first; with none, what happened
    } else {
        if (a->state != MAX_DONE) {   // a live summary ends the turn
            a->note[0] = 0;
            a->question[0] = 0;
            max_set_state(a, MAX_DONE, now_ms);
            max_ask_drop(a->id);
        }
        if (tier != POD_TIER_SILENT && say) {   // silent: nothing new to say
            max_copy(a->note, sizeof a->note, say);
            a->note_until = now_ms + MAX_DONE_MS;
        }
        a->card = tier == POD_TIER_ALERT && say;   // the loud tier opens a card; list only shows it on the lane
    }
    return memcmp(&s_before, a, sizeof *a) != 0;
}

bool max_ui_focus(const char *id) { return max_find(id) && max_room_show(id); }

// ---- the app's own state ----

bool max_notice_set(const char *text, uint32_t now_ms) { return max_ui_notice(text, MAX_NOTICE_MS, now_ms); }

bool max_ui_notice(const char *text, uint32_t duration_ms, uint32_t now_ms)
{
    if (!text || !text[0]) {
        const bool changed = max_m.notice[0] != 0;
        max_m.notice[0] = 0;
        return changed;
    }
    max_copy(max_m.notice, sizeof max_m.notice, text);
    max_m.notice_until = now_ms + duration_ms;
    return true;
}

bool max_ui_talk(max_talk_t state)
{
    const bool changed = max_m.talk != state;
    max_m.talk = state;
    return changed;
}

bool max_ui_update(int pct, const char *to)
{
    if (pct < -1) pct = -1;
    if (pct > 100) pct = 100;
    char version[MAX_VERSION_BYTES];
    max_copy(version, sizeof version, pct < 0 ? NULL : to);
    const bool changed = pct != max_m.update_pct || strcmp(max_m.update_to, version);
    max_m.update_pct = pct;
    memcpy(max_m.update_to, version, sizeof version);
    return changed;
}

// ---- the clock ----

bool max_ui_tick(uint32_t now_ms) { return max_m.dirty || max_time_key(now_ms) != max_m.drawn_key; }

uint32_t max_ui_next_wake_ms(uint32_t now_ms)
{
    if (max_m.dirty) return 1;
    uint32_t ms = MAX_WAKE_MS;
    int v[MAX_LANES + 1], n = drawn(v);
    for (int i = 0; i < n; i++) {
        const max_agent_t *a = &max_m.agents[v[i]];
        if (a->clock && running(a->state)) {
            const uint32_t step = 1000u - (uint32_t)(now_ms - a->clock_ms) % 1000u;   // to the next second
            if (step < ms) ms = step;
        }
        if (a->state == MAX_DONE && max_note_shown(a, now_ms) && a->note_until - now_ms < ms) ms = a->note_until - now_ms;
    }
    if (max_notice_shown(now_ms) && max_m.notice_until - now_ms < ms) ms = max_m.notice_until - now_ms;
    if (max_m.link) ms = max_form_wake(now_ms, max_ask_wake(now_ms, ms));   // a read again, a poll, a reply overdue
    return ms ? ms : 1;
}

const char *max_ui_selected(void) { return max_m.selected[0] ? max_m.selected : NULL; }

bool max_toast_shown(uint32_t now_ms)
{
    const max_agent_t *a = max_m.toast_id[0] ? max_find(max_m.toast_id) : NULL;
    return a && a->state == MAX_ASKING && now_ms - max_m.toast_from < MAX_TOAST_MS;
}

bool max_can_talk(const max_agent_t *a)
{
    if (!a || !max_m.link || max_m.talk != MAX_TALK_IDLE || max_form_open()) return false;
    const max_ask_t *k = a->state == MAX_ASKING ? max_ask_of(a->id) : NULL;
    return !k || (!k->permission && k->phase != MAX_ASK_SENDING);
}
