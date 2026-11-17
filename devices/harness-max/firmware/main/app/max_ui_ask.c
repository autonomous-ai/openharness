// A question being answered (max_ui.h): an agent's question with its options, read whole when the daemon offers the
// reviewed path, answered by the finger on its card, and the receipt. What it sends goes to the outbox.
#include <ctype.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>

#include "max_ui_internal.h"

static const char SHOWN_ONLY[] = "shown:";   // cableSession.ts SHOWN_ONLY_PREFIX: answered in the agent's own app

static bool reached(uint32_t at, uint32_t now_ms) { return (int32_t)(now_ms - at) >= 0; }

// src whole into dst[cap], or false (and dst "") when it does not fit: a key, an id or a token is echoed byte for byte.
static bool exact(char *dst, size_t cap, const char *src)
{
    const size_t n = src ? strlen(src) : cap;
    if (n >= cap) {
        dst[0] = 0;
        return false;
    }
    memcpy(dst, src, n + 1);
    return true;
}

max_ask_t *max_ask_of(const char *agent)
{
    for (int i = 0; agent && agent[0] && i < MAX_AGENTS; i++)
        if (!strcmp(max_m.asks[i].agent, agent)) return &max_m.asks[i];
    return NULL;
}

void max_ask_drop(const char *agent)
{
    max_ask_t *k = max_ask_of(agent);
    if (k) k->agent[0] = 0;
}

// A slot an agent, so one is always free for an agent of the roster.
static max_ask_t *ask_slot(const char *agent)
{
    max_ask_t *k = max_ask_of(agent);
    for (int i = 0; !k && i < MAX_AGENTS; i++)
        if (!max_m.asks[i].agent[0]) k = &max_m.asks[i];
    if (k) {
        memset(k, 0, sizeof *k);
        max_copy(k->agent, sizeof k->agent, agent);
    }
    return k;
}

// ---- a permission prompt's yes and no (cli engines/kit/questionPane.ts APPROVE_RE, REJECT_RE) ----

static bool word_char(char c) { return isalnum((unsigned char)c) || c == '_'; }
// s begins with the word w, any case, and a word ends there (the regex's \b).
static bool begins(const char *s, const char *w)
{
    const size_t n = strlen(w);
    return !strncasecmp(s, w, n) && !word_char(s[n]);
}
static bool begins_any(const char *s, const char *const words[], size_t count)
{
    for (size_t i = 0; i < count; i++)
        if (begins(s, words[i])) return true;
    return false;
}
bool max_option_approves(const char *option)
{
    static const char *const words[] = {"yes", "allow", "approve", "accept", "proceed", "run", "continue"};
    return option && begins_any(option, words, sizeof words / sizeof words[0]);
}
bool max_option_rejects(const char *option)
{
    static const char *const words[] = {"no", "reject", "deny", "decline", "cancel", "skip", "dont", "don't", "stop"};
    if (!option) return false;
    if (begins_any(option, words, sizeof words / sizeof words[0])) return true;
    if (!begins(option, "tell")) return false;   // "Tell Claude what to change"
    for (size_t i = 1; option[i]; i++)
        if (!word_char(option[i - 1]) && begins(option + i, "what to change")) return true;
    return false;
}

// ---- feeds ----

static uint32_t ask_hash(const char *request, const char *text, const pro_ask_item_t *items, int n)
{
    uint32_t h = max_fnv(2166136261u, request ? request : "", request ? strlen(request) + 1 : 1);
    h = max_fnv(h, text ? text : "", text ? strlen(text) + 1 : 1);
    for (int i = 0; i < n; i++) {
        const char *key = items[i].key ? items[i].key : "";
        h = max_fnv(h, key, strlen(key) + 1);
        h = max_fnv(h, items[i].q, strlen(items[i].q) + 1);
        for (int j = 0; j < items[i].option_count; j++) h = max_fnv(h, items[i].options[j], strlen(items[i].options[j]) + 1);
        h = max_fnv(h, &items[i].multi, sizeof items[i].multi);
    }
    return h;
}

// Take the questions; true when every one can be echoed in a plain answer.
static bool take_items(max_ask_t *k, const pro_ask_item_t *items, int n)
{
    bool whole = n > 0;
    k->count = (uint8_t)n;
    k->step = 0;
    memset(k->choices, 0, sizeof k->choices);
    for (int i = 0; i < n; i++) {
        max_item_t *it = &k->items[i];
        const pro_ask_item_t *src = &items[i];
        const bool key = src->key && exact(it->key, sizeof it->key, src->key);
        max_copy(it->q, sizeof it->q, src->q);
        it->option_count = (uint8_t)(src->option_count < 0 ? 0 : src->option_count > PRO_ASK_OPTIONS ? PRO_ASK_OPTIONS
                                                                                                     : src->option_count);
        for (int j = 0; j < it->option_count; j++) snprintf(it->options[j], sizeof it->options[j], "%s", src->options[j]);
        it->multi = src->multi;
        it->whole = src->whole && key;
        whole = whole && it->whole && it->option_count > 0;
    }
    return whole;
}

static void start_read(max_ask_t *k, uint32_t now_ms)
{
    k->phase = MAX_ASK_READING;
    snprintf(k->fetch, sizeof k->fetch, "q%lu", (unsigned long)++max_m.ask_serial);
    k->reads = 0;
    k->due = now_ms;   // the next take sends it
    k->note[0] = 0;
}

bool max_ui_question(const char *id, const char *request, const char *text, const pro_ask_item_t *items, int n,
                     bool permission, bool review, uint32_t now_ms)
{
    max_agent_t *a = max_find(id);
    if (!a) return false;
    if (!items || n < 0 || n > PRO_ASK_ITEMS) n = 0;
    const uint32_t key = ask_hash(request, text, items, n);
    if (a->state == MAX_ASKING && a->ask_key == key) return false;   // the same question, re-sent
    max_set_state(a, MAX_ASKING, now_ms);
    max_copy(a->question, sizeof a->question, text);
    a->ask_key = key;
    a->card = false;   // the question's card replaces a failure's or a summary's
    max_ask_t *k = ask_slot(id);
    if (!k) return true;
    const bool request_ok = request && request[0] && exact(k->request, sizeof k->request, request);
    const bool whole = take_items(k, items, n);
    k->permission = permission && n > 0;
    k->phase = MAX_ASK_READY;
    if (request_ok && !strncmp(request, SHOWN_ONLY, sizeof SHOWN_ONLY - 1)) {
        k->path = MAX_PATH_SHOWN;   // its one option names the app: "In Orca"
        if (n && !strncmp(k->items[0].options[0], "In ", 3)) max_copy(k->app, sizeof k->app, k->items[0].options[0] + 3);
    } else if (!request_ok || !n) {
        k->path = MAX_PATH_NONE;
    } else if (review) {
        k->path = MAX_PATH_REVIEWED;
        start_read(k, now_ms);
    } else {
        k->path = whole ? MAX_PATH_PLAIN : MAX_PATH_NONE;
    }
    return true;
}

// Answered, here or elsewhere: the turn and its clock go on.
static void answered(max_agent_t *a)
{
    max_ask_drop(a->id);
    a->state = MAX_WORKING;
    a->question[0] = 0;
    a->ask_key = 0;
}

bool max_ui_question_close(const char *id)
{
    max_agent_t *a = max_find(id);
    if (!a || a->state != MAX_ASKING) return false;
    answered(a);
    return true;
}

bool max_ui_question_state(const char *id, const char *fetch, bool ok, const char *request, const char *token,
                           bool submitted, const char *error, const pro_ask_item_t *items, int n, uint32_t now_ms)
{
    (void)now_ms;
    max_ask_t *k = max_ask_of(id);
    if (!k || k->path != MAX_PATH_REVIEWED || k->phase != MAX_ASK_READING || !fetch || strcmp(k->fetch, fetch))
        return false;   // not the read this card waits for
    if (!ok || !items || n < 1 || n > PRO_ASK_ITEMS || !exact(k->token, sizeof k->token, token) ||
        !exact(k->request, sizeof k->request, request)) {
        k->phase = MAX_ASK_FAILED;
        max_copy(k->note, sizeof k->note, error && error[0] ? error : "Could not load the question.");
        return true;
    }
    take_items(k, items, n);   // the daemon's own copy: what the token names
    if (submitted) {           // taken already (another device, or a receipt that never came): it is not asked again
        k->phase = MAX_ASK_SENT;
        max_copy(k->note, sizeof k->note, "An answer was already sent. Check the terminal.");
    } else {
        k->phase = MAX_ASK_READY;
    }
    return true;
}

bool max_ui_answer_receipt(const char *id, const char *fetch, const char *token, bool ok, bool pending,
                           const char *error, uint32_t now_ms)
{
    max_agent_t *a = max_find(id);
    max_ask_t *k = max_ask_of(id);
    if (!a || !k || k->path != MAX_PATH_REVIEWED || k->phase != MAX_ASK_SENDING || !fetch || !token ||
        strcmp(k->fetch, fetch) || strcmp(k->token, token)) return false;
    if (!ok) {
        k->phase = MAX_ASK_FAILED;
        max_copy(k->note, sizeof k->note, error && error[0] ? error : "Could not confirm the answer. Check the terminal.");
        max_notice_set(k->note, now_ms);
        return true;
    }
    max_notice_set("Sent", now_ms);
    if (pending) {   // taken, the terminal not done with it yet: the question's close ends it
        k->phase = MAX_ASK_SENT;
        k->note[0] = 0;
    } else {
        answered(a);
    }
    return true;
}

// ---- the card ----

bool max_has_card(const max_agent_t *a, uint32_t now_ms)
{
    if (a->state == MAX_ASKING) return max_ask_of(a->id) != NULL;
    return a->card && (a->state == MAX_FAILED || max_note_shown(a, now_ms));
}

int max_open_card(const int lanes[MAX_LANES], int n, uint32_t now_ms)
{
    int first = -1;
    for (int i = 0; i < n; i++) {
        const max_agent_t *a = &max_m.agents[lanes[i]];
        if (!max_has_card(a, now_ms)) continue;
        if (!strcmp(a->id, max_m.selected)) return i;
        if (first < 0) first = i;
    }
    return first;
}

uint32_t max_card_key(const max_agent_t *a)
{
    const max_ask_t *k = max_ask_of(a->id);
    uint32_t h = max_fnv(2166136261u, &a->ask_key, sizeof a->ask_key);
    h = max_fnv(h, &a->state, sizeof a->state);
    if (k) {
        h = max_fnv(h, &k->step, sizeof k->step);
        h = max_fnv(h, &k->phase, sizeof k->phase);
    }
    return h;
}

static bool submit(const max_agent_t *a, max_ask_t *k, uint32_t now_ms)
{
    max_out_t *o = max_out_push(k->path == MAX_PATH_REVIEWED ? MAX_OUT_REVIEWED : MAX_OUT_ANSWER);
    if (!o) {
        max_notice_set("Not sent", now_ms);
        return true;
    }
    max_copy(o->agent, sizeof o->agent, a->id);
    o->count = k->count;
    memcpy(o->choices, k->choices, sizeof o->choices);
    if (k->path == MAX_PATH_REVIEWED) {
        memcpy(o->fetch, k->fetch, sizeof o->fetch);
        memcpy(o->token, k->token, sizeof o->token);
        k->due = now_ms + MAX_RECEIPT_MS;
    } else {
        memcpy(o->request, k->request, sizeof o->request);
    }
    k->phase = MAX_ASK_SENDING;
    return true;
}

// The question answered: the next one, or the answer goes.
static bool advance(const max_agent_t *a, max_ask_t *k, uint32_t now_ms)
{
    if (k->step + 1 < k->count) {
        k->step++;
        return true;
    }
    return submit(a, k, now_ms);
}

bool max_ask_hit(max_agent_t *a, max_hit_kind_t kind, int arg, uint32_t now_ms)
{
    if (kind == MAX_HIT_DISMISS) {
        if (!a->card) return false;
        a->card = false;
        if (a->state == MAX_DONE) a->note_until = now_ms;   // read on its card: the lane does not show it again
        return true;
    }
    max_ask_t *k = max_ask_of(a->id);
    if (!k || a->state != MAX_ASKING) return false;
    if (kind == MAX_HIT_RELOAD) {
        if (k->path != MAX_PATH_REVIEWED || k->phase != MAX_ASK_FAILED) return false;
        start_read(k, now_ms);
        return true;
    }
    if (k->phase != MAX_ASK_READY || (k->path != MAX_PATH_PLAIN && k->path != MAX_PATH_REVIEWED) || k->step >= k->count)
        return false;
    const max_item_t *it = &k->items[k->step];
    switch (kind) {
    case MAX_HIT_OPTION:
        if (arg < 0 || arg >= it->option_count) return false;
        if (it->multi) {
            k->choices[k->step] ^= (uint8_t)(1u << arg);
            return true;
        }
        k->choices[k->step] = (uint8_t)(1u << arg);   // one tap is the answer
        return advance(a, k, now_ms);
    case MAX_HIT_SEND:
        return k->choices[k->step] && advance(a, k, now_ms);
    case MAX_HIT_STEP_BACK:
        if (!k->step) return false;
        k->step--;
        return true;
    default:
        return false;
    }
}

// ---- the clock and the outbox ----

void max_ask_due(uint32_t now_ms)
{
    for (int i = 0; i < MAX_AGENTS; i++) {
        max_ask_t *k = &max_m.asks[i];
        if (!k->agent[0] || !reached(k->due, now_ms)) continue;
        if (k->phase == MAX_ASK_READING) {
            if (k->reads >= MAX_READS) {
                k->phase = MAX_ASK_FAILED;
                max_copy(k->note, sizeof k->note, "No reply. Check Harness on your computer.");
                max_m.dirty = true;
                continue;
            }
            max_out_t *o = max_out_push(MAX_OUT_READ);
            if (!o) continue;   // the outbox is full: the next take tries again
            max_copy(o->agent, sizeof o->agent, k->agent);
            memcpy(o->fetch, k->fetch, sizeof o->fetch);
            k->reads++;
            k->due = now_ms + MAX_READ_MS;
        } else if (k->phase == MAX_ASK_SENDING && k->path == MAX_PATH_REVIEWED) {
            k->phase = MAX_ASK_FAILED;   // never sent again: the daemon takes one answer a token
            max_copy(k->note, sizeof k->note, "No reply. Check the terminal.");
            max_m.dirty = true;
        }
    }
}

uint32_t max_ask_wake(uint32_t now_ms, uint32_t ms)
{
    for (int i = 0; i < MAX_AGENTS; i++) {
        const max_ask_t *k = &max_m.asks[i];
        const bool timed = k->phase == MAX_ASK_READING || (k->phase == MAX_ASK_SENDING && k->path == MAX_PATH_REVIEWED);
        if (!k->agent[0] || !timed) continue;
        const uint32_t left = reached(k->due, now_ms) ? 1 : k->due - now_ms;
        if (left < ms) ms = left;
    }
    return ms;
}

// A plain answer handed out: its words, and the card says it went (no reply ever comes).
bool max_ask_taken(const max_out_t *o, max_answer_t *answer, uint32_t now_ms)
{
    max_ask_t *k = max_ask_of(o->agent);
    if (!k || k->phase != MAX_ASK_SENDING || strcmp(k->request, o->request)) return false;
    answer->count = k->count;
    for (int i = 0; i < k->count; i++) {
        const max_item_t *it = &k->items[i];
        memcpy(answer->keys[i], it->key, sizeof answer->keys[i]);
        char *v = answer->values[i];
        v[0] = 0;
        for (int j = 0; j < it->option_count; j++) {
            if (!(k->choices[i] & (1u << j))) continue;
            const size_t len = strlen(v);
            snprintf(v + len, MAX_VALUE_BYTES - len, "%s%s", len ? ", " : "", it->options[j]);
        }
    }
    k->phase = MAX_ASK_SENT;
    k->note[0] = 0;
    max_notice_set("Sent", now_ms);
    return true;
}

bool max_ask_unsent(const max_out_t *o, uint32_t now_ms)
{
    max_ask_t *k = max_ask_of(o->agent);
    if (!k) return false;
    const bool mine = o->kind == MAX_OUT_REVIEWED ? k->phase == MAX_ASK_SENDING && !strcmp(k->fetch, o->fetch)
                                                  : k->phase == MAX_ASK_SENT && !strcmp(k->request, o->request);
    if (!mine) return false;
    k->phase = MAX_ASK_READY;   // nothing went: the same choices can go again
    max_notice_set("Not sent", now_ms);
    return true;
}
