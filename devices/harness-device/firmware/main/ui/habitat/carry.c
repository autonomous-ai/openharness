#include "carry.h"
#include <stdio.h>
#include <string.h>

void ht_carry_close(ht_carry_t *s)
{
    if (s->id[0] && s->emit) {
        ht_carry_command_t c = {.id=s->id, .agent="", .selection="", .cancel=true};
        s->emit(&c, s->ctx);
    }
    uint32_t serial = s->serial;
    memset(s, 0, sizeof(*s));
    s->serial = serial;
}
void ht_carry_open(ht_carry_t *s, const char *id, const char *agent, const char *selection,
                   uint32_t revision, uint32_t now, ht_carry_emit_t emit, void *ctx)
{
    ht_carry_close(s);
    if (!id || !*id || strlen(id) >= sizeof(s->id) || !agent || !*agent ||
        !selection || !*selection || !revision) return;
    snprintf(s->id, sizeof(s->id), "%s", id);
    s->emit=emit; s->ctx=ctx; s->request=++s->serial;
    ht_carry_command_t c = {.id=s->id, .agent=agent, .selection=selection,
                            .request=s->request, .revision=revision};
    if (!emit || !emit(&c, ctx)) {
        snprintf(s->error, sizeof(s->error), "Device busy. Choose the text again.");
        return;
    }
    s->pending=true; s->deadline=now+3500;
}
bool ht_carry_reply(ht_carry_t *s, const char *id, uint32_t request, bool ok,
                    const char *source, const char *excerpt, int rows, uint32_t ttl,
                    const char *error, uint32_t now)
{
    if (!s->pending || !id || strcmp(s->id,id) || s->request!=request) return false;
    if (ok && (!source || !excerpt || rows<1 || rows>16 || !ttl || ttl>300000)) return false;
    s->pending=false;
    if (!ok) {
        snprintf(s->error,sizeof(s->error),"%s",error && *error ? error : "Choose the text again.");
        return true;
    }
    s->active=true; s->rows=rows; s->deadline=now+ttl;
    snprintf(s->source,sizeof(s->source),"%s",source);
    snprintf(s->excerpt,sizeof(s->excerpt),"%s",excerpt);
    return true;
}
bool ht_carry_tick(ht_carry_t *s, uint32_t now)
{
    if ((!s->pending && !s->active) || (int32_t)(now-s->deadline)<0) return false;
    bool pending=s->pending;
    ht_carry_close(s);
    snprintf(s->error,sizeof(s->error),"%s",pending ? "No reply. Choose the text again." :
             "Carried text expired. Select it again or drop text.");
    return true;
}
