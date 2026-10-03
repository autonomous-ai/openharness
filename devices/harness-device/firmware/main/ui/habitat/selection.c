#include "selection.h"
#include <stdio.h>
#include <string.h>

static int clamp(int n, int min, int max) { return n < min ? min : n > max ? max : n; }
static bool send(ht_selection_t *s, ht_select_op_t op, int delta, uint32_t now)
{
    ht_select_command_t c = {op, s->id, s->agent, ++s->serial, s->revision, delta};
    if (!s->emit || !s->emit(&c, s->ctx)) {
        snprintf(s->error, sizeof(s->error), "Device busy. Choose again.");
        return false;
    }
    s->request = c.request;
    s->pending = true;
    s->deadline = now + 3500;
    return true;
}
void ht_selection_close(ht_selection_t *s)
{
    if (s->active && s->announced && s->emit) {
        ht_select_command_t c = {HT_SELECT_CANCEL, s->id, s->agent, ++s->serial, s->revision, 0};
        s->emit(&c, s->ctx);
    }
    uint32_t serial = s->serial;
    memset(s, 0, sizeof(*s));
    s->serial = serial;
}
void ht_selection_open(ht_selection_t *s, const char *id, const char *agent, uint32_t now,
                       ht_select_emit_t emit, void *ctx)
{
    ht_selection_close(s);
    if (!id || !*id || !agent || !*agent) return;
    snprintf(s->id, sizeof(s->id), "%s", id);
    snprintf(s->agent, sizeof(s->agent), "%s", agent);
    s->active = true; s->emit = emit; s->ctx = ctx;
    s->announced = send(s, HT_SELECT_BEGIN, 0, now);
}
static void flush(ht_selection_t *s, uint32_t now)
{
    if (!s->active || s->pending || s->error[0] || !s->queued) return;
    int delta = s->queued;
    if (send(s, s->query[0] ? HT_SELECT_MATCH : HT_SELECT_STEP, delta, now)) s->queued = 0;
}
void ht_selection_move(ht_selection_t *s, int pixels, uint32_t now)
{
    if (!s->active || s->error[0]) return;
    s->remainder += clamp(pixels, -466, 466);
    int distance = s->query[0] ? 60 : 20;
    int steps = s->remainder / distance;
    s->remainder %= distance;
    // One outstanding request and at most eight queued rows. A stalled app
    // cannot accumulate a giant jump, and voice waits for the latest reply.
    s->queued = clamp(s->queued + steps, -8, 8);
    flush(s, now);
}
void ht_selection_extend(ht_selection_t *s, uint32_t now)
{
    if (ht_selection_ready(s) && s->rows)
        send(s, s->query[0] ? HT_SELECT_LINES : s->extending ? HT_SELECT_LINE : HT_SELECT_EXTEND, 0, now);
}
static bool valid_result(const ht_selection_t *s, const char *id, uint32_t revision,
                         int rows, const char *query, int match, int matches)
{
    if (!id || strcmp(id, s->id) || revision != s->revision + 1 || rows > 16) return false;
    if (query && *query) {
        if (strlen(query) >= sizeof s->query || matches < 0 || match < 0 || match > matches) return false;
        if (!matches) return match == 0 && rows == 0;
        return match > 0 && rows >= 1;
    }
    return rows >= 1 && match == 0 && matches == 0;
}
static void apply_result(ht_selection_t *s, uint32_t revision, const char *excerpt, int rows,
                         bool extending, const char *query, int match, int matches)
{
    s->revision = revision; s->rows = rows; s->extending = extending;
    s->match = match; s->matches = matches; s->error[0] = 0;
    bool changed_mode = !!s->query[0] != !!(query && *query);
    snprintf(s->query, sizeof s->query, "%s", query ? query : "");
    if (changed_mode) s->remainder = s->queued = 0;
    snprintf(s->excerpt, sizeof(s->excerpt), "%s", excerpt ? excerpt : "");
}
bool ht_selection_reply_search(ht_selection_t *s, uint32_t request, const char *id, bool ok,
                        uint32_t revision, const char *excerpt, int rows, bool extending,
                        const char *error, const char *query, int match, int matches, uint32_t now)
{
    if (!s->active || !s->pending || request != s->request) return false;
    if (ok && !valid_result(s, id, revision, rows, query, match, matches)) return false;
    s->pending = false;
    if (!ok) {
        snprintf(s->error, sizeof(s->error), "%s", error && *error ? error : "Choose the text again.");
        s->queued = 0;
        return true;
    }
    apply_result(s, revision, excerpt, rows, extending, query, match, matches);
    flush(s, now);
    return true;
}
bool ht_selection_reply(ht_selection_t *s, uint32_t request, const char *id, bool ok,
                        uint32_t revision, const char *excerpt, int rows, bool extending,
                        const char *error, uint32_t now)
{
    return ht_selection_reply_search(s, request, id, ok, revision, excerpt, rows, extending,
                                     error, NULL, 0, 0, now);
}
bool ht_selection_found(ht_selection_t *s, const char *id, const char *agent,
                        uint32_t revision, const char *excerpt, int rows,
                        const char *query, int match, int matches)
{
    if (!ht_selection_ready(s) || !agent || strcmp(agent, s->agent) || !query || !*query ||
        !valid_result(s, id, revision, rows, query, match, matches)) return false;
    apply_result(s, revision, excerpt, rows, false, query, match, matches);
    s->queued = s->remainder = 0;
    return true;
}
bool ht_selection_tick(ht_selection_t *s, uint32_t now)
{
    if (!s->active || !s->pending || (int32_t)(now - s->deadline) < 0) return false;
    s->pending = false; s->queued = 0;
    snprintf(s->error, sizeof(s->error), "The app did not answer. Choose again.");
    if (s->emit) {
        ht_select_command_t c = {HT_SELECT_CANCEL, s->id, s->agent, ++s->serial, s->revision, 0};
        if (s->emit(&c, s->ctx)) s->announced = false;
    }
    return true;
}
bool ht_selection_ready(const ht_selection_t *s)
{
    return s->active && !s->pending && !s->queued && !s->error[0] && s->revision > 0;
}
