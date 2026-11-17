// New Harness from the bar (max_ui.h), after the Dial's form.c: the desktop's form, opened under a name, read again
// while it is up, moved, chosen in and closed. One command at a time; moves asked for meanwhile are added up and sent
// as one. A reply that never comes fails the form; nothing is sent twice on its own.
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "max_ui_internal.h"
#include "pod/pod_mem.h"   // EXT_RAM_BSS_ATTR

static bool reached(uint32_t at, uint32_t now_ms) { return (int32_t)(now_ms - at) >= 0; }

static bool form_id_ok(const char *id)
{
    const size_t n = id ? strlen(id) : 0;
    if (n < 1 || n >= MAX_FORM_ID_BYTES) return false;
    for (size_t i = 0; i < n; i++)
        if (!isalnum((unsigned char)id[i]) && id[i] != '-') return false;
    return true;
}

const char *max_form_op_name(max_form_op_t op)
{
    static const char *const names[] = {"open", "state", "move", "activate", "back", "close"};
    return op <= MAX_FORM_CLOSE ? names[op] : "";
}

bool max_form_open(void) { return max_m.form.id[0] != 0; }

void max_form_reset(void)
{
    const uint32_t serial = max_m.form.serial;   // a late reply to the last form must not match the next one's
    memset(&max_m.form, 0, sizeof max_m.form);
    max_m.form.serial = serial;
}

static void fail(const char *why)
{
    max_form_t *f = &max_m.form;
    f->pending = false;
    f->failed = true;
    f->queued = 0;
    max_copy(f->page.error, sizeof f->page.error, why);
}

static bool send(max_form_op_t op, int delta, uint32_t now_ms)
{
    max_form_t *f = &max_m.form;
    max_out_t *o = max_out_push(MAX_OUT_FORM);
    if (!o) return false;
    f->request = ++f->serial;
    snprintf(o->fetch, sizeof o->fetch, "form-%lu", (unsigned long)f->request);
    memcpy(o->form, f->id, sizeof o->form);
    o->op = op;
    o->revision = f->page.revision;
    o->delta = delta;
    f->pending = true;
    f->pending_op = op;
    f->deadline = now_ms + MAX_FORM_WAIT_MS;
    return true;
}

// Moves asked for while a command was out, as one.
static void flush(uint32_t now_ms)
{
    const max_form_t *f = &max_m.form;
    if (!f->queued || f->pending || !f->page.active || f->page.busy || f->failed) return;
    if (send(MAX_FORM_MOVE, f->queued, now_ms)) max_m.form.queued = 0;
}

bool max_ui_offers(bool form)
{
    const bool changed = max_m.offers_form != form;
    max_m.offers_form = form;
    return changed;
}

bool max_ui_form_open(const char *form_id, uint32_t now_ms)
{
    if (!max_m.link || !form_id_ok(form_id) || max_form_open()) return false;
    max_form_reset();
    memcpy(max_m.form.id, form_id, strlen(form_id) + 1);
    if (!send(MAX_FORM_OPEN, 0, now_ms)) fail("Cable busy. Try again.");
    return true;
}

bool max_form_command(max_form_op_t op, int delta, uint32_t now_ms)
{
    max_form_t *f = &max_m.form;
    if (!f->id[0] || f->failed || !f->page.active) return false;
    if (op == MAX_FORM_MOVE) {
        if (f->page.busy || !delta) return false;
        f->queued += delta;
        if (f->queued > MAX_FORM_MOVES) f->queued = MAX_FORM_MOVES;
        if (f->queued < -MAX_FORM_MOVES) f->queued = -MAX_FORM_MOVES;
        flush(now_ms);
        return true;
    }
    if (f->pending || (op == MAX_FORM_ACTIVATE && (!f->page.enabled || f->page.busy))) return false;
    f->queued = 0;
    if (!send(op, 0, now_ms)) fail("Cable busy. Try again.");
    return true;
}

bool max_form_dismiss(void)
{
    if (!max_form_open()) return false;
    max_form_t *f = &max_m.form;
    max_out_t *o = max_out_push(MAX_OUT_FORM);   // best effort: the form leaves the bar whether or not it goes
    if (o) {
        snprintf(o->fetch, sizeof o->fetch, "form-%lu", (unsigned long)++f->serial);
        memcpy(o->form, f->id, sizeof o->form);
        o->op = MAX_FORM_CLOSE;
        o->revision = f->page.revision;
        o->delta = 0;
    }
    max_form_reset();
    return true;
}

bool max_form_can_say(void)
{
    const max_form_t *f = &max_m.form;
    return f->id[0] && !f->pending && !f->failed && f->page.active && f->page.can_query && !f->page.busy;
}

// pro_cable already cut each string to the desktop's bound; a detail keeps its line breaks ("agent\nproject").
static void take_text(char *dst, size_t cap, const char *src, bool lines)
{
    snprintf(dst, cap, "%s", src ? src : "");
    for (char *c = dst; *c; c++)
        if (((unsigned char)*c < 0x20 && !(lines && *c == '\n')) || *c == 0x7f) *c = ' ';
}
static void take_page(max_page_t *p, const pro_form_page_t *src)
{
    take_text(p->title, sizeof p->title, src->title, false);
    take_text(p->label, sizeof p->label, src->label, false);
    take_text(p->detail, sizeof p->detail, src->detail, true);
    take_text(p->previous, sizeof p->previous, src->previous, false);
    take_text(p->next, sizeof p->next, src->next, false);
    take_text(p->error, sizeof p->error, src->error, false);
    take_text(p->status, sizeof p->status, src->status, false);
    take_text(p->action, sizeof p->action, src->action, false);
    take_text(p->query, sizeof p->query, src->query, false);
    p->revision = src->revision;
    p->position = src->position;
    p->total = src->total;
    p->active = src->active;
    p->busy = src->busy;
    p->enabled = src->enabled;
    p->can_query = src->can_query;
}

// "form-<n>" as this bar names its commands.
static bool request_serial(const char *request, uint32_t *serial)
{
    if (!request || strncmp(request, "form-", 5) || !isdigit((unsigned char)request[5])) return false;
    char *end = NULL;
    const unsigned long long n = strtoull(request + 5, &end, 10);
    if (!end || *end || n > UINT32_MAX) return false;
    *serial = (uint32_t)n;
    return true;
}

// The page before a reply, to tell a poll that changed nothing (too big for the cable_link task's stack).
static EXT_RAM_BSS_ATTR max_page_t s_was;

bool max_ui_form_state(const char *request, const char *form_id, bool ok, const pro_form_page_t *page, uint32_t now_ms)
{
    max_form_t *f = &max_m.form;
    uint32_t serial;
    if (!f->pending || !page || !form_id || strcmp(f->id, form_id) || !request_serial(request, &serial) ||
        serial != f->request) return false;
    const bool poll = f->pending_op == MAX_FORM_STATE;
    s_was = f->page;
    f->pending = false;
    take_page(&f->page, page);
    if (ok && !page->active) {   // started, or backed out of: the new agent arrives as a lane
        max_form_reset();
        return true;
    }
    if (!ok) {
        fail(f->page.error[0] ? f->page.error : "Could not open New Harness.");
        return true;
    }
    f->poll = now_ms + (page->busy ? MAX_FORM_BUSY_MS : MAX_FORM_POLL_MS);
    flush(now_ms);
    // A poll that read the same page changes nothing drawn; any other reply re-enables the buttons it held.
    return !poll || memcmp(&s_was, &f->page, sizeof s_was) != 0;
}

bool max_ui_voice_form(const char *form_id, bool ok, const pro_form_page_t *page, uint32_t now_ms)
{
    max_form_t *f = &max_m.form;
    if (!page || !form_id || !f->id[0] || strcmp(f->id, form_id)) return false;
    if (ok && !page->active) {
        max_form_reset();
        return true;
    }
    if (page->active) take_page(&f->page, page);
    else take_text(f->page.error, sizeof f->page.error, page->error[0] ? page->error : "Say the name again.", false);
    // The words stay up a while before a poll could replace them, as on the Dial.
    f->poll = now_ms + (f->page.error[0] ? 6000u : MAX_FORM_POLL_MS);
    return true;
}

void max_form_due(uint32_t now_ms)
{
    max_form_t *f = &max_m.form;
    if (!f->id[0]) return;
    if (f->pending && reached(f->deadline, now_ms)) {
        fail("No reply. Check Harness on desktop.");   // the desktop's own words for its timeout
        max_m.dirty = true;
        return;
    }
    flush(now_ms);
    // Not while a spoken name is out: the desktop takes one command at a time, and the name's would be refused.
    if (!f->pending && !f->failed && f->page.active && reached(f->poll, now_ms) && max_m.talk == MAX_TALK_IDLE)
        send(MAX_FORM_STATE, 0, now_ms);
}

uint32_t max_form_wake(uint32_t now_ms, uint32_t ms)
{
    const max_form_t *f = &max_m.form;
    if (!f->id[0] || f->failed) return ms;
    uint32_t at;
    if (f->pending) at = f->deadline;
    else if (f->page.active) at = f->poll;
    else return ms;
    const uint32_t left = reached(at, now_ms) ? 1 : at - now_ms;
    return left < ms ? left : ms;
}

bool max_form_unsent(const max_out_t *o, uint32_t now_ms)
{
    max_form_t *f = &max_m.form;
    uint32_t serial;
    if (!f->pending || strcmp(o->form, f->id) || !request_serial(o->fetch, &serial) || serial != f->request) return false;
    if (o->op == MAX_FORM_STATE) {   // a poll the port had no room for: read again later
        f->pending = false;
        f->poll = now_ms + MAX_FORM_POLL_MS;
        return false;
    }
    fail("Cable busy. Try again.");
    return true;
}
