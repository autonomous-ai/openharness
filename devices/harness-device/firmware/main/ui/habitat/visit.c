#include "visit.h"
#include <stdio.h>
#include <string.h>

static bool send(ht_visit_t *s, ht_visit_op_t op, uint32_t now)
{
    ht_visit_command_t c = {op, s->id, s->agent, ++s->serial};
    if (!s->emit || !s->emit(&c, s->ctx)) return false;
    s->request = c.request;
    s->op = op;
    s->pending = true;
    s->deadline = now + 3500;
    return true;
}
void ht_visit_close(ht_visit_t *s)
{
    if (s->id[0] && s->emit) {
        ht_visit_command_t c = {HT_VISIT_CANCEL, s->id, s->agent, ++s->serial};
        s->emit(&c, s->ctx);
    }
    uint32_t serial = s->serial;
    memset(s, 0, sizeof(*s));
    s->serial = serial;
}
static bool begin(ht_visit_t *s, const char *id, const char *agent, uint32_t now,
                  ht_visit_emit_t emit, void *ctx, ht_visit_op_t op)
{
    if (s->pending || !id || !*id || !agent || !*agent || strlen(id) >= sizeof s->id || strlen(agent) >= sizeof s->agent) return false;
    if (strcmp(id, s->id)) ht_visit_close(s);
    char previous_agent[sizeof s->agent];
    memcpy(previous_agent, s->agent, sizeof previous_agent);
    snprintf(s->id, sizeof s->id, "%s", id);
    snprintf(s->agent, sizeof s->agent, "%s", agent);
    s->emit = emit; s->ctx = ctx;
    if (send(s, op, now)) return true;
    memcpy(s->agent, previous_agent, sizeof s->agent);
    return false;
}
bool ht_visit_open(ht_visit_t *s, const char *id, const char *agent, uint32_t now, ht_visit_emit_t emit, void *ctx)
{
    return begin(s,id,agent,now,emit,ctx,HT_VISIT_OPEN);
}
bool ht_visit_latest(ht_visit_t *s, const char *id, const char *agent, uint32_t now, ht_visit_emit_t emit, void *ctx)
{
    return begin(s,id,agent,now,emit,ctx,HT_VISIT_LATEST);
}
bool ht_visit_back(ht_visit_t *s, uint32_t now)
{
    return s->available && !s->pending && send(s, HT_VISIT_BACK, now);
}
bool ht_visit_reply(ht_visit_t *s, const char *id, uint32_t request, bool available, const char *label)
{
    if (!s->pending || !id || strcmp(id, s->id) || request != s->request) return false;
    s->pending = false; s->available = available;
    snprintf(s->label, sizeof s->label, "%s", label ? label : "");
    if (!available) { s->id[0] = 0; s->agent[0] = 0; }
    return true;
}
bool ht_visit_tick(ht_visit_t *s, uint32_t now)
{
    if (!s->pending || (int32_t)(now - s->deadline) < 0) return false;
    ht_visit_close(s);
    return true;
}
