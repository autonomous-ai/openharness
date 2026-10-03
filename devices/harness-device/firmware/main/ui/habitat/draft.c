#include "draft.h"
#include <stdio.h>
#include <string.h>
void ht_draft_reset(ht_draft_t *s)
{
    uint32_t serial=s->serial;
    memset(s,0,sizeof *s);s->serial=serial;
}
void ht_draft_open(ht_draft_t *s,const ht_draft_page_t *page,ht_draft_emit_t emit,void *ctx)
{
    ht_draft_reset(s);s->page=*page;s->emit=emit;s->ctx=ctx;
}
bool ht_draft_command(ht_draft_t *s,ht_draft_op_t op,uint32_t revision,int delta,uint32_t now)
{
    if (!s->page.active || !s->page.id[0] || s->pending || revision!=s->page.revision) return false;
    if (op!=HT_DRAFT_STATE && op!=HT_DRAFT_DISCARD && (s->failed || s->page.locked)) return false;
    if (op==HT_DRAFT_SEND && !s->page.can_send) return false;
    if (op==HT_DRAFT_UNDO && !s->page.can_undo) return false;
    if (op==HT_DRAFT_MOVE && (delta!=1 && delta!=-1)) return false;
    ht_draft_command_t command={s->page.id,++s->serial,revision,op,delta};
    if (!s->emit || !s->emit(&command,s->ctx)) return false;
    s->pending=true;s->request=command.request;s->deadline=now+5000;s->op=op;s->delta=delta;
    return true;
}
bool ht_draft_reply(ht_draft_t *s,const char *id,uint32_t request,bool ok,const ht_draft_page_t *page)
{
    if (!s->pending || !id || strcmp(s->page.id,id) || s->request!=request) return false;
    s->pending=false;
    if (!page->active) { ht_draft_reset(s);return true; }
    if (strcmp(page->id,s->page.id)) {
        s->failed=true;snprintf(s->page.error,sizeof s->page.error,"Draft unavailable. Check the terminal.");return true;
    }
    s->page=*page;s->failed=!ok;
    return true;
}
bool ht_draft_tick(ht_draft_t *s,uint32_t now)
{
    if (!s->pending || (int32_t)(now-s->deadline)<0) return false;
    s->pending=false;s->failed=true;
    snprintf(s->page.error,sizeof s->page.error,"No reply. Check the draft status.");return true;
}
