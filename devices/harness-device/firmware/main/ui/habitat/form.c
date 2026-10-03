#include "form.h"
#include <stdio.h>
#include <string.h>

void ht_form_reset(ht_form_t *s)
{
    uint32_t serial = s->serial;
    memset(s, 0, sizeof *s);
    s->serial = serial;
}
bool ht_form_dismiss(ht_form_t *s)
{
    bool sent = false;
    if (s->id[0] && s->emit) {
        ht_form_command_t c = {HT_FORM_CLOSE, s->id, ++s->serial, s->page.revision, 0};
        sent = s->emit(&c, s->ctx);
    }
    ht_form_reset(s);
    return sent;
}
static bool send(ht_form_t *s, ht_form_op_t op, int delta, uint32_t now)
{
    ht_form_command_t c = {op, s->id, ++s->serial, s->page.revision, delta};
    if (!s->emit || !s->emit(&c, s->ctx)) return false;
    s->request = c.request; s->pending = true; s->pending_op = op;
    s->deadline = now + 3500;
    return true;
}
bool ht_form_open(ht_form_t *s, const char *id, uint32_t now, ht_form_emit_t emit, void *ctx)
{
    if (!id || !*id || strlen(id) >= sizeof s->id || s->pending) return false;
    ht_form_reset(s);
    snprintf(s->id, sizeof s->id, "%s", id);
    s->emit = emit; s->ctx = ctx;
    if (send(s, HT_FORM_OPEN, 0, now)) return true;
    s->failed = true;
    snprintf(s->page.error, sizeof s->page.error, "Cable busy. Try again.");
    return false;
}
bool ht_form_command(ht_form_t *s, ht_form_op_t op, uint32_t revision, int delta, uint32_t now)
{
    if (!s->id[0] || s->pending) return false;
    if (op == HT_FORM_OPEN || op == HT_FORM_STATE) return send(s, op, 0, now);
    if (s->failed || !s->page.active || revision != s->page.revision) return false;
    if (op == HT_FORM_ACTIVATE && (!s->page.enabled || s->page.busy)) return false;
    if (op == HT_FORM_MOVE && (s->page.busy || !delta || delta < -8 || delta > 8)) return false;
    s->queued = 0; s->remainder = 0;
    return send(s, op, delta, now);
}
static void flush(ht_form_t *s, uint32_t now)
{
    if (!s->queued || s->pending || !s->page.active || s->page.busy || s->failed) return;
    int delta = s->queued;
    if (send(s, HT_FORM_MOVE, delta, now)) s->queued = 0;
}
void ht_form_move(ht_form_t *s, int pixels, uint32_t now)
{
    if (!s->page.active || s->page.busy || s->failed || pixels < -466 || pixels > 466) return;
    s->remainder += pixels;
    int steps = s->remainder / 42;
    s->remainder %= 42;
    s->queued += steps;
    if (s->queued > 8) s->queued = 8;
    if (s->queued < -8) s->queued = -8;
    flush(s, now);
}
bool ht_form_reply(ht_form_t *s, const char *id, uint32_t request, bool ok,
                   const ht_form_page_t *page, uint32_t now)
{
    if (!s->pending || !id || strcmp(s->id, id) || request != s->request) return false;
    s->pending = false;
    s->page = *page;
    s->failed = !ok && !page->active;
    if (!ok) { s->queued = 0; s->remainder = 0; }
    if (ok && !page->active) { ht_form_reset(s); return true; }
    s->poll = now + (page->busy ? 300 : 1000);
    flush(s, now);
    // Completing a read changes interaction state even when every page field
    // is identical. A frame drawn during that read disabled the buttons; its
    // hit targets must be rebuilt when pending clears. The compositor skips
    // unchanged pixels, so ordinary polling still has no display transfer.
    return true;
}
bool ht_form_tick(ht_form_t *s, uint32_t now)
{
    if (!s->id[0]) return false;
    if (s->pending && (int32_t)(now - s->deadline) >= 0) {
        s->pending = false; s->failed = true; s->queued = 0; s->remainder = 0;
        snprintf(s->page.error, sizeof s->page.error, "No reply. Check Harness on desktop.");
        return true;
    }
    flush(s, now);
    if (!s->pending && !s->failed && s->page.active && (int32_t)(now - s->poll) >= 0)
        send(s, HT_FORM_STATE, 0, now);
    return false;
}
