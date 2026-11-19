// The model: the cable's feeds and the app's own state, kept for the pages and the finger, which page is up and why,
// Inbox, and the outbox (max_ui.h). Questions are max_ui_ask.c's, New Harness max_ui_form.c's, the finger
// max_ui_touch.c's.
#include <stdio.h>
#include <string.h>

#include "max_ui_internal.h"
#include "max_ui_motion.h"
#include "pod/pod_mem.h"   // EXT_RAM_BSS_ATTR: the agents' text is tens of KB, PSRAM on the device

EXT_RAM_BSS_ATTR max_model_t max_m;
// Scratch for the feeds: the roster before an agents feed (staying agents keep their turn), and one agent before a turn
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

void max_copy_label(char *dst, size_t cap, const char *src)
{
    static const char ELLIPSIS[] = "\xe2\x80\xa6";
    max_copy(dst, cap, src);
    if (!src || strlen(dst) == strlen(src) || cap <= sizeof ELLIPSIS) return;
    max_copy(dst, cap - (sizeof ELLIPSIS - 1), src);
    size_t n = strlen(dst);
    while (n && dst[n - 1] == ' ') n--;
    memcpy(dst + n, ELLIPSIS, sizeof ELLIPSIS);
}

static bool running(max_state_t st) { return st == MAX_WORKING || st == MAX_ASKING; }
static bool reached(uint32_t at, uint32_t now_ms) { return (int32_t)(now_ms - at) >= 0; }
static void sooner(uint32_t *ms, uint32_t d)
{
    if (d < *ms) *ms = d;
}
// The wait until `at` (0 once it is reached), for the render task's sleep.
static void until(uint32_t *ms, uint32_t at, uint32_t now_ms) { sooner(ms, reached(at, now_ms) ? 0 : at - now_ms); }

max_agent_t *max_find(const char *id)
{
    for (int i = 0; id && i < max_m.count; i++)
        if (!strcmp(max_m.agents[i].id, id)) return &max_m.agents[i];
    return NULL;
}

// The row's order of need (the owner's call, 19 Nov): waiting on the person first, then at work, failed, done, resting.
static int need(const max_agent_t *a)
{
    switch (a->state) {
    case MAX_ASKING: return 0;
    case MAX_WORKING: return 1;
    case MAX_FAILED: return 2;
    case MAX_DONE: return 3;
    default: return 4;
    }
}
static bool in_held_row(const char *id)
{
    for (int h = 0; h < max_m.held_count; h++)
        if (!strcmp(max_m.held_row[h], id)) return true;
    return false;
}
int max_row(int out[MAX_AGENTS])
{
    int n = 0;
    for (int h = 0; h < max_m.held_count; h++) {
        const max_agent_t *a = max_find(max_m.held_row[h]);
        if (a) out[n++] = (int)(a - max_m.agents);
    }
    for (int g = 0; g <= 4; g++)
        for (int i = 0; i < max_m.count; i++)
            if (need(&max_m.agents[i]) == g && !in_held_row(max_m.agents[i].id)) out[n++] = i;
    return n;
}
// The agent's place in the row, or -1.
static int row_index(const char *id)
{
    int row[MAX_AGENTS];
    const int n = max_row(row);
    for (int i = 0; i < n; i++)
        if (!strcmp(max_m.agents[row[i]].id, id)) return i;
    return -1;
}
// The row as it is now, for front_if_passed to compare with.
static void see_row(void)
{
    int row[MAX_AGENTS];
    max_m.row_seen_count = max_row(row);
    for (int i = 0; i < max_m.row_seen_count; i++)
        memcpy(max_m.row_seen[i], max_m.agents[row[i]].id, ID_MAX);
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

// ---- Demo V2: which page is up ----

bool max_show(max_view_t view)
{
    if (max_m.view == view) return false;
    if (view != MAX_VIEW_AMBIENT) max_m.wake_to_apps = false;   // only the Ambient it was set for
    const max_view_t was = max_m.view;
    if (was == MAX_VIEW_INBOX)   // seen: the bell's count goes
        for (int i = 0; i < max_m.inbox_count; i++) max_m.inbox[i].unread = false;
    max_m.talk_closed = false;   // "Mic closed" belongs to the page it closed on
    max_m.view = view;
    // Opening an agent holds the row's order until it closes, so the open agent and the slivers beside it stay put as
    // states change.
    max_m.held_count = 0;
    if (view == MAX_VIEW_AGENT) {
        int row[MAX_AGENTS];
        max_m.held_count = max_row(row);
        for (int i = 0; i < max_m.held_count; i++) memcpy(max_m.held_row[i], max_m.agents[row[i]].id, ID_MAX);
    }
    if (view == MAX_VIEW_OVERVIEW) {
        // Closed, the row is by need again with the agent that was open one cell in, where it stands; from any other
        // page the row starts at its front.
        const int i = was == MAX_VIEW_AGENT ? row_index(max_m.selected) : -1;
        const int last = max_row_last();
        max_m.row_first = i - 1 < 0 ? 0 : i - 1 > last ? last : i - 1;
        see_row();
    }
    return true;
}

void max_open(const char *id)
{
    if (strcmp(max_m.selected, id)) max_m.talk_closed = false;   // "Mic closed" was the other agent's
    max_copy(max_m.selected, sizeof max_m.selected, id);
    max_show(MAX_VIEW_AGENT);
}

bool max_attn_holds(const char *id, max_attn_t why)
{
    const max_agent_t *a = max_find(id);
    const max_state_t st = why == MAX_ATTN_ASK ? MAX_ASKING : why == MAX_ATTN_DONE ? MAX_DONE : MAX_FAILED;
    return a && a->state == st;
}

void max_attention(const char *id, max_attn_t why, uint32_t now_ms)
{
    max_copy(max_m.attn_id, sizeof max_m.attn_id, id);
    max_m.attn = why;
    max_m.attn_from = now_ms;
    if (!strcmp(max_m.toast_id, id)) max_m.toast_id[0] = 0;   // what it announced is up now
    max_show(MAX_VIEW_ATTENTION);
}

// An agent that asks and has no answer on its way waits for a person.
static bool waits(const max_agent_t *a)
{
    if (a->state != MAX_ASKING || a->quiet) return false;   // a quiet one rang before: it waits on its tile
    const max_ask_t *k = max_ask_of(a->id);
    return !k || (k->phase != MAX_ASK_SENDING && k->phase != MAX_ASK_SENT);
}

// The question that has waited longest, but `except`'s; NULL when none waits.
static const max_agent_t *oldest(const char *except)
{
    const max_agent_t *best = NULL;
    for (int i = 0; i < max_m.count; i++) {
        const max_agent_t *a = &max_m.agents[i];
        if (waits(a) && strcmp(a->id, except) && (!best || (int32_t)(a->ask_since - best->ask_since) < 0)) best = a;
    }
    return best;
}

void max_next_question(const char *except, uint32_t now_ms)
{
    const max_agent_t *next = oldest(except);
    if (next) max_attention(next->id, MAX_ATTN_ASK, now_ms);
    else max_show(MAX_VIEW_OVERVIEW);
}

// A notice of who (its name, engine and app kept: the agent may leave the ring before it is read), why and its words.
// `quiet`: the same notice is left as it is (and false comes back: Inbox did not change).
static bool inbox_put(const char *id, const char *name, const char *engine, const char *app, max_attn_t why,
                      const char *words, bool quiet, uint32_t now_ms)
{
    static char text[MAX_QUESTION_BYTES];   // with the scan below, over the cable_link task's frame budget
    max_copy(text, sizeof text, words);
    int j = 0;   // the same notice again (a question re-sent after the link came back) moves up instead
    while (j < max_m.inbox_count && (max_m.inbox[j].kind != why || strcmp(max_m.inbox[j].id, id) ||
                                     strcmp(max_m.inbox[j].text, text)))
        j++;
    if (quiet && j < max_m.inbox_count) return false;
    if (j == max_m.inbox_count) {
        if (max_m.inbox_count < MAX_INBOX) max_m.inbox_count++;
        j = max_m.inbox_count - 1;   // full: the oldest goes
    }
    memmove(&max_m.inbox[1], &max_m.inbox[0], (size_t)j * sizeof max_m.inbox[0]);
    max_inbox_t *n = &max_m.inbox[0];
    memset(n, 0, sizeof *n);
    max_copy(n->id, sizeof n->id, id);
    max_copy_label(n->name, sizeof n->name, name);
    max_copy(n->engine, sizeof n->engine, engine);
    max_copy(n->app, sizeof n->app, app);
    n->kind = why;
    memcpy(n->text, text, sizeof n->text);
    n->at = now_ms;
    n->unread = true;
    return true;
}

// The notice's words: the question, or what the turn said (a failure's error, a summary's text).
static void inbox_add(const max_agent_t *a, max_attn_t why, bool quiet, uint32_t now_ms)
{
    inbox_put(a->id, a->name, a->engine, max_app_of(a), why, why == MAX_ATTN_ASK ? a->question : a->note, quiet,
              now_ms);
}

// A failure that came without words: its summary fills the newest notice of it.
static void inbox_words(const max_agent_t *a)
{
    for (int i = 0; i < max_m.inbox_count; i++) {
        max_inbox_t *n = &max_m.inbox[i];
        if (n->kind != MAX_ATTN_FAIL || strcmp(n->id, a->id)) continue;
        if (!n->text[0]) max_copy(n->text, sizeof n->text, a->note);
        return;
    }
}

void max_attend(max_agent_t *a, max_attn_t why, uint32_t now_ms)
{
    max_m.idle_from = now_ms;
    max_m.news |= why == MAX_ATTN_ASK ? MAX_NEWS_ASK : why == MAX_ATTN_FAIL ? MAX_NEWS_FAILED : MAX_NEWS_DONE;
    inbox_add(a, why, false, now_ms);
    if (why == MAX_ATTN_DONE) {   // never the glass (the owner's call, 18 Nov): the newest note, over whatever is up
        max_copy(max_m.done_id, sizeof max_m.done_id, a->id);
        max_m.done_from = now_ms;
        return;
    }
    if (max_m.talk != MAX_TALK_IDLE || max_form_open()) {   // a person talks or fills the form: only the toast
        max_copy(max_m.toast_id, sizeof max_m.toast_id, a->id);
        max_m.toast_attn = why;
        max_m.toast_from = now_ms;
        if (max_m.view == MAX_VIEW_AMBIENT) max_show(MAX_VIEW_OVERVIEW);
        return;
    }
    // Another agent's question keeps Attention: this one waits its turn, a failure stays in Inbox.
    if (max_m.view == MAX_VIEW_ATTENTION && max_m.attn == MAX_ATTN_ASK && strcmp(max_m.attn_id, a->id) &&
        max_attn_holds(max_m.attn_id, MAX_ATTN_ASK))
        return;
    max_attention(a->id, why, now_ms);
}

void max_file_question(const max_agent_t *a, uint32_t now_ms) { inbox_add(a, MAX_ATTN_ASK, true, now_ms); }

bool max_file_notice(const char *id, const char *name, const char *text, bool quiet, uint32_t now_ms)
{
    if (!quiet) {   // it rings, though its agent is not on the glass to take Attention
        max_m.idle_from = now_ms;
        max_m.news |= MAX_NEWS_ASK;
    }
    return inbox_put(id, name, "", "", MAX_ATTN_ASK, text, quiet, now_ms);
}

unsigned max_ui_take_news(void)
{
    const unsigned news = max_m.news;
    max_m.news = 0;
    return news;
}

static bool busy(void)
{
    for (int i = 0; i < max_m.count; i++)
        if (running(max_m.agents[i].state)) return true;
    return false;
}

// Overview with nothing working or waiting and nobody talking: Ambient comes MAX_AMBIENT_MS after the last touch or
// news.
static bool ambient_waits(void)
{
    return max_m.view == MAX_VIEW_OVERVIEW && max_m.talk == MAX_TALK_IDLE && !max_form_open() && !busy();
}

// The row by need can move an agent up past the cells before the glass (one just talked to starting work, one coming
// to wait on the person), out of sight: then the row goes to its front, unless a finger holds it. True when it did.
static bool front_if_passed(void)
{
    bool front = false;
    if (max_m.view == MAX_VIEW_OVERVIEW && !max_m.down && max_m.row_first > 0) {
        int row[MAX_AGENTS];
        const int n = max_row(row), before = max_m.row_first;
        for (int i = 0; i < before && !front; i++) {
            bool seen = i >= n;
            for (int j = 0; j < before && j < max_m.row_seen_count && !seen; j++)
                seen = !strcmp(max_m.row_seen[j], max_m.agents[row[i]].id);
            front = !seen;
        }
        if (front) max_m.row_first = 0;
    }
    if (max_m.view == MAX_VIEW_OVERVIEW || max_m.view == MAX_VIEW_AGENT) see_row();
    return front;
}

// The page follows what it shows: Attention whose agent moved on gives way to the next question (else Overview), a
// turn's end goes after MAX_ATTN_END_MS, the agent page goes with its agent, an idle Overview turns Ambient, and the
// row comes to its front when an agent moved up past it. True when the page changed.
static bool settle(uint32_t now_ms)
{
    const max_view_t view = max_m.view;
    const max_attn_t attn = max_m.attn;
    char attn_id[ID_MAX];
    memcpy(attn_id, max_m.attn_id, sizeof attn_id);
    if (view == MAX_VIEW_ATTENTION) {
        if (!max_attn_holds(max_m.attn_id, max_m.attn)) max_next_question(attn_id, now_ms);
        else if (max_m.attn != MAX_ATTN_ASK && reached(max_m.attn_from + MAX_ATTN_END_MS, now_ms))
            max_show(MAX_VIEW_OVERVIEW);
    } else if (view == MAX_VIEW_AGENT && !max_find(max_m.selected)) {
        max_show(MAX_VIEW_OVERVIEW);
    }
    if (ambient_waits() && reached(max_m.idle_from + MAX_AMBIENT_MS, now_ms)) max_show(MAX_VIEW_AMBIENT);
    const bool front = front_if_passed();
    return front || max_m.view != view || max_m.attn != attn || strcmp(max_m.attn_id, attn_id);
}

uint32_t max_fnv(uint32_t h, const void *data, size_t n)
{
    const unsigned char *p = data;
    for (size_t i = 0; i < n; i++) h = (h ^ p[i]) * 16777619u;
    return h;
}
void max_fmt_ago(char *out, size_t cap, uint32_t since_ms, uint32_t now_ms)
{
    const uint32_t s = (int32_t)(now_ms - since_ms) > 0 ? (now_ms - since_ms) / 1000u : 0;
    if (s < 60) snprintf(out, cap, "just now");
    else if (s < 3600) snprintf(out, cap, "%lum ago", (unsigned long)(s / 60));
    else if (s < 86400) snprintf(out, cap, "%luh ago", (unsigned long)(s / 3600));
    else snprintf(out, cap, "%lud ago", (unsigned long)(s / 86400));
}

static uint32_t fnv_ago(uint32_t h, uint32_t since_ms, uint32_t now_ms)
{
    char ago[24];
    max_fmt_ago(ago, sizeof ago, since_ms, now_ms);
    return max_fnv(h, ago, strlen(ago));
}

uint32_t max_time_key(uint32_t now_ms)
{
    uint32_t h = max_fnv(2166136261u, &max_m.view, sizeof max_m.view);
    if (max_m.view == MAX_VIEW_INBOX)
        for (int i = 0; i < max_m.inbox_count; i++) h = fnv_ago(h, max_m.inbox[i].at, now_ms);
    if (max_m.talk == MAX_TALK_RECORDING) {   // the band's frames
        const uint32_t frame = (now_ms - max_m.talk_from) / MAX_TALK_FRAME_MS;
        h = max_fnv(h, &frame, sizeof frame);
    }
    const bool notice = max_notice_shown(now_ms), toast = max_toast_shown(now_ms), done = max_done_shown(now_ms);
    h = max_fnv(h, &notice, sizeof notice);
    h = max_fnv(h, &done, sizeof done);
    return max_fnv(h, &toast, sizeof toast);
}

void max_ui_reset(void)
{
    memset(&max_m, 0, sizeof max_m);
    max_m.update_pct = -1;
    max_m.view = MAX_VIEW_AMBIENT;   // no link yet
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

// The program's mode, set once before the app starts: max_ui_reset keeps it.
static bool s_demo;
void max_ui_demo(bool on) { s_demo = on; }

bool max_ui_link(bool up, const char *machine, uint32_t now_ms)
{
    (void)now_ms;
    if (up) {
        char name[CABLE_NAME_MAX];
        max_copy_label(name, sizeof name, machine);
        const bool changed = !max_m.link || strcmp(max_m.computer, name);
        if (!max_m.link && s_demo) max_m.rest_owed = true;   // the demo opens on Ambient (max_ui_agents)
        max_m.link = true;
        memcpy(max_m.computer, name, sizeof name);
        return changed;
    }
    // Everything the daemon told us goes with the link: an agent on the bar is a claim that it is there now. So do the
    // questions, the form, the pages that showed them and whatever was queued for a daemon that is no longer there.
    // Inbox stays: what happened, happened.
    const bool changed = max_m.link || max_m.count || max_m.machine_count || max_m.computer[0] || max_form_open() ||
                         max_m.view != MAX_VIEW_AMBIENT;
    max_m.link = false;
    max_m.computer[0] = 0;
    max_m.count = max_m.machine_count = 0;
    max_m.selected[0] = max_m.attn_id[0] = max_m.toast_id[0] = max_m.done_id[0] = 0;
    max_m.row_first = 0;
    max_m.rest_owed = max_m.wake_to_apps = false;
    memset(max_m.asks, 0, sizeof max_m.asks);
    max_m.parked_count = 0;
    memset(max_m.apps, 0, sizeof max_m.apps);   // the apps too: the next list is a first one, followed by nothing
    max_m.app_count = 0;
    max_m.shown[0] = max_m.picked[0] = 0;
    max_m.apps_known = max_m.harness_own = false;
    max_form_reset();
    max_m.out_count = 0;
    max_show(MAX_VIEW_AMBIENT);
    return changed;
}

bool max_ui_agents(const pro_agent_row_t *rows, int n, uint32_t now_ms)
{
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
            a->since_ms = now_ms;
        }
        max_copy_label(a->name, sizeof a->name, r->name && r->name[0] ? r->name : r->id);
        max_copy(a->engine, sizeof a->engine, r->engine);
        max_copy(a->machine_id, sizeof a->machine_id, r->machine_id);
        max_copy_label(a->machine, sizeof a->machine, r->machine);
        max_copy(a->host, sizeof a->host, r->host);
        a->caps = max_caps_of(r->caps);
    }
    max_m.count = k;
    for (int j = 0; j < old; j++)   // a question goes with its agent, and waits off the ring for it
        if (s_old[j].state == MAX_ASKING && !max_find(s_old[j].id)) max_park_leaver(&s_old[j]);
    for (int i = 0; i < MAX_AGENTS; i++)
        if (max_m.asks[i].agent[0] && !max_find(max_m.asks[i].agent)) max_m.asks[i].agent[0] = 0;
    max_unpark_joined(now_ms);
    if (max_m.harness_own) max_m.apps[0].count = k;   // the bar's own Harness: its agents are the ring
    bool changed = k != old || memcmp(max_m.agents, s_old, (size_t)k * sizeof s_old[0]);
    if (!max_find(max_m.selected)) max_m.selected[0] = 0;   // its page goes (settle)
    if (max_m.row_first > max_row_last()) max_m.row_first = max_row_last();
    // The demo's first ring after the link came up: Ambient at once when nothing works or waits, not a quiet minute
    // later, and its tap shows every app (V3 restNow(wakeToApps)).
    const bool rest = max_m.rest_owed && !busy() && max_m.talk == MAX_TALK_IDLE && !max_form_open();
    max_m.rest_owed = false;
    if (!k && old) {   // nobody left: Ambient
        changed |= max_show(MAX_VIEW_AMBIENT);
    } else if (k && !old) {   // the first agents: Overview, and Ambient waits from now
        max_m.idle_from = now_ms;
        if (max_m.view == MAX_VIEW_AMBIENT && !rest) changed |= max_show(MAX_VIEW_OVERVIEW);
    }
    if (rest) {
        changed |= max_show(MAX_VIEW_AMBIENT);
        max_m.wake_to_apps = true;
    }
    return settle(now_ms) || changed;
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
    if (a->state != st) a->since_ms = now_ms;
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
        // An agent in another app waiting on its app's prompt: the daemon shows the wait as a question (shown only) and
        // as this start's line (devices.ts showWaits). The same wait, so it keeps its question; the close ends it.
        const max_ask_t *k = a->state == MAX_ASKING ? max_ask_of(a->id) : NULL;
        if (k && k->path == MAX_PATH_SHOWN) {
            max_copy(a->activity, sizeof a->activity, text);
            return true;
        }
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
        a->card = true;   // a failure is an alert: its card stays until the agent moves on
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
    if (!kind) return false;
    if (!a) {   // off the ring: a turn that moves on ends a question waiting for it
        if (!strcmp(kind, "started") || !strcmp(kind, "done") || !strcmp(kind, "error")) max_unpark(id);
        return false;
    }
    s_before = *a;
    if (!turn(a, kind, text, elapsed_s, now_ms) || !memcmp(&s_before, a, sizeof *a)) return settle(now_ms);
    max_m.idle_from = now_ms;
    if (!strcmp(kind, "error")) max_attend(a, MAX_ATTN_FAIL, now_ms);
    else if (running(a->state) && !running(s_before.state) && max_m.view == MAX_VIEW_AMBIENT)
        max_show(MAX_VIEW_OVERVIEW);
    settle(now_ms);
    return true;
}

bool max_ui_summary(const char *id, const char *text, const char *recap, bool restore, pod_tier_t tier,
                    uint32_t now_ms)
{
    max_agent_t *a = max_find(id);
    if (!a || restore) return false;   // history filled back in: never news
    s_before = *a;
    // "done" is the daemon's placeholder when the turn had nothing to say: the recap speaks instead.
    const char *say = text && text[0] && strcmp(text, "done") ? text : recap && recap[0] ? recap : NULL;
    const bool failed = a->state == MAX_FAILED;
    if (failed) {
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
        a->card = tier == POD_TIER_ALERT && say;   // the loud tier takes Attention; list only shows on its page
    }
    if (!memcmp(&s_before, a, sizeof *a)) return settle(now_ms);
    max_m.idle_from = now_ms;
    if (failed) inbox_words(a);
    else if (a->card) max_attend(a, MAX_ATTN_DONE, now_ms);
    settle(now_ms);
    return true;
}

// The computer focused an agent: the bar keeps the page it shows (the person chose it, or Attention holds it).
bool max_ui_focus(const char *id)
{
    (void)id;
    return false;
}

// ---- the app's own state ----

bool max_notice_set(const char *text, uint32_t now_ms) { return max_ui_notice(text, MAX_NOTICE_MS, now_ms); }

bool max_ui_notice(const char *text, uint32_t duration_ms, uint32_t now_ms)
{
    if (!text || !text[0]) {
        const bool changed = max_m.notice[0] != 0;
        max_m.notice[0] = 0;
        return changed;
    }
    if (!max_notice_shown(now_ms)) max_m.notice_from = now_ms;   // a notice already up only changes its words
    max_copy(max_m.notice, sizeof max_m.notice, text);
    max_m.notice_until = now_ms + duration_ms;
    return true;
}

bool max_ui_talk(max_talk_t state, uint32_t now_ms)
{
    const bool changed = max_m.talk != state;
    if (changed && state == MAX_TALK_RECORDING) {   // a new recording: its clock, and nothing heard yet
        max_m.talk_from = max_m.talk_quiet_from = now_ms;
        max_m.talk_heard = false;
        max_m.talk_closed = false;
        max_m.level_count = 0;
    }
    max_m.talk = state;
    return changed;
}

bool max_ui_wall(bool known, int hour, int min, int wday, int mday, int mon)
{
    const bool ok = known && hour >= 0 && hour < 24 && min >= 0 && min < 60 && wday >= 0 && wday < 7 && mday >= 1 &&
                    mday <= 31 && mon >= 0 && mon < 12;
    const bool changed = ok != max_m.wall_known ||
                         (ok && (hour != max_m.wall_hour || min != max_m.wall_min || mday != max_m.wall_mday));
    max_m.wall_known = ok;
    if (ok) {
        max_m.wall_hour = (uint8_t)hour, max_m.wall_min = (uint8_t)min, max_m.wall_wday = (uint8_t)wday;
        max_m.wall_mday = (uint8_t)mday, max_m.wall_mon = (uint8_t)mon;
    }
    return changed;
}

bool max_ui_level(unsigned level, uint32_t now_ms)
{
    if (max_m.talk != MAX_TALK_RECORDING) return false;
    if (level > 4) level = 4;
    if (max_m.level_count == MAX_LEVELS) memmove(max_m.levels, max_m.levels + 1, --max_m.level_count);
    max_m.levels[max_m.level_count++] = (uint8_t)level;
    if (level >= MAX_SPEECH_LEVEL) {
        max_m.talk_heard = true;
        max_m.talk_quiet_from = now_ms;
    }
    return true;   // the waveform moved
}

static const char HARNESS[] = "harness";   // cableHost.ts: the window's own app

bool max_ui_apps(const char *shown, const pro_app_row_t *rows, int n, uint32_t now_ms)
{
    if (!rows || n < 0) n = 0;
    if (n > PRO_APPS_MAX) n = PRO_APPS_MAX;
    static max_app_t apps[PRO_APPS_MAX];   // over the 1 KB frame budget of the cable_link task
    memset(apps, 0, sizeof apps);
    int harness = -1;
    for (int i = 0; i < n; i++) {
        max_copy(apps[i].id, sizeof apps[i].id, rows[i].id);
        const char *name = rows[i].name && rows[i].name[0] ? rows[i].name : max_app_name(apps[i].id);
        max_copy_label(apps[i].name, sizeof apps[i].name, name ? name : apps[i].id);
        apps[i].count = rows[i].count < 0 ? 0 : rows[i].count;
        apps[i].waiting = rows[i].waiting < 0 ? 0 : rows[i].waiting;
        if (harness < 0 && !strcmp(apps[i].id, HARNESS)) harness = i;
    }
    char id[PRO_APP_ID_BYTES];
    max_copy(id, sizeof id, shown);
    // Harness first (V3's list). The window's tab shows it from a list that leaves it out (cableHost.ts tabApps): the
    // bar adds it, the last row giving way when the list is full; its agents are the ring's.
    const bool own = harness < 0 && !strcmp(id, HARNESS);
    if (harness > 0 || own) {
        max_app_t first;
        memset(&first, 0, sizeof first);
        int moved = harness;   // the rows before it step down one
        if (own) {
            max_copy(first.id, sizeof first.id, HARNESS);
            max_copy(first.name, sizeof first.name, max_app_name(HARNESS));
            first.count = max_m.count;   // waiting stays 0: the shown app's dots are the ring's own states
            moved = n < PRO_APPS_MAX ? n++ : n - 1;
        } else {
            first = apps[harness];
        }
        memmove(&apps[1], &apps[0], (size_t)moved * sizeof apps[0]);
        apps[0] = first;
    }
    const bool turned = strcmp(id, max_m.shown) != 0;
    if (turned) max_m.row_first = 0;   // another app's agents: from the row's front
    // The computer turned the bar to the app in front (V3's rule): never the first list, never the app the person just
    // picked here, never over a person talking.
    if (turned && max_m.apps_known && id[0]) {
        if (strcmp(id, max_m.picked) && max_m.talk != MAX_TALK_RECORDING) {
            const char *name = id;
            for (int i = 0; i < n; i++)
                if (!strcmp(apps[i].id, id)) name = apps[i].name;
            char text[MAX_NOTICE_BYTES];
            snprintf(text, sizeof text, "Following %s on your Mac", name);
            max_ui_notice(text, MAX_NOTICE_MS, now_ms);
        }
        max_m.picked[0] = 0;
    }
    const bool changed = !max_m.apps_known || n != max_m.app_count || turned || memcmp(apps, max_m.apps, sizeof apps);
    memcpy(max_m.apps, apps, sizeof apps);
    max_m.app_count = n;
    memcpy(max_m.shown, id, sizeof id);
    max_m.apps_known = true;
    max_m.harness_own = own;
    return changed;
}

void max_ui_app_picked(const char *app) { max_copy(max_m.picked, sizeof max_m.picked, app); }

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

bool max_ui_tick(uint32_t now_ms)
{
    const bool moved = settle(now_ms);
    return moved || max_m.dirty || max_time_key(now_ms) != max_m.drawn_key || !max_motion_ms(now_ms);
}

uint32_t max_ui_next_wake_ms(uint32_t now_ms)
{
    if (max_m.dirty) return 1;
    uint32_t ms = MAX_WAKE_MS;
    for (int i = 0; max_m.view == MAX_VIEW_INBOX && i < max_m.inbox_count; i++)
        sooner(&ms, 60000u - (uint32_t)(now_ms - max_m.inbox[i].at) % 60000u);
    if (max_m.talk == MAX_TALK_RECORDING) {   // the band, and the send or the close the clock owes (max_ui_talk_due)
        sooner(&ms, MAX_TALK_FRAME_MS);
        if (max_m.talk_heard) {
            until(&ms, max_m.talk_quiet_from + MAX_SILENCE_MS, now_ms);
            until(&ms, max_m.talk_from + MAX_TALK_MAX_MS, now_ms);
        } else {
            until(&ms, max_m.talk_from + MAX_HEAR_MS, now_ms);
        }
    }
    if (max_m.view == MAX_VIEW_ATTENTION && max_m.attn != MAX_ATTN_ASK)
        until(&ms, max_m.attn_from + MAX_ATTN_END_MS, now_ms);
    if (ambient_waits()) until(&ms, max_m.idle_from + MAX_AMBIENT_MS, now_ms);
    if (max_notice_shown(now_ms)) until(&ms, max_m.notice_until, now_ms);
    if (max_toast_shown(now_ms)) until(&ms, max_m.toast_from + MAX_TOAST_MS, now_ms);
    if (max_done_shown(now_ms)) until(&ms, max_m.done_from + MAX_DONE_NOTE_MS, now_ms);
    if (max_m.link) ms = max_form_wake(now_ms, max_ask_wake(now_ms, ms));   // a read again, a poll, a reply overdue
    sooner(&ms, max_motion_ms(now_ms));   // the drawing's own motion
    return ms ? ms : 1;
}

const char *max_ui_selected(void)
{
    const char *id = max_m.view == MAX_VIEW_AGENT       ? max_m.selected
                     : max_m.view == MAX_VIEW_ATTENTION ? max_m.attn_id
                                                        : "";
    return id[0] ? id : NULL;
}

bool max_toast_shown(uint32_t now_ms)
{
    return max_m.toast_id[0] && max_attn_holds(max_m.toast_id, max_m.toast_attn) &&
           now_ms - max_m.toast_from < MAX_TOAST_MS;
}

bool max_done_shown(uint32_t now_ms)
{
    return max_m.done_id[0] && max_attn_holds(max_m.done_id, MAX_ATTN_DONE) &&
           now_ms - max_m.done_from < MAX_DONE_NOTE_MS;
}

bool max_can_talk(const max_agent_t *a)
{
    if (!a || !max_m.link || max_m.talk != MAX_TALK_IDLE || max_form_open()) return false;
    const max_ask_t *k = a->state == MAX_ASKING ? max_ask_of(a->id) : NULL;
    return !k || (!k->permission && k->phase != MAX_ASK_SENDING && k->phase != MAX_ASK_SENT);
}
