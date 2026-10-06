#include "../main/ui/habitat/draft.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static bool congested;
static int commands;
static ht_draft_command_t sent;
static bool emit(const ht_draft_command_t *c,void *ctx) { (void)ctx;if(congested)return false;sent=*c;commands++;return true; }
int main(void)
{
    ht_draft_t draft={0};
    ht_draft_page_t page={.id="one",.revision=1,.active=true,.can_send=true,.position=1,.total=2,.text="Hello"};
    ht_draft_open(&draft,&page,emit,NULL);
    assert(!ht_draft_command(&draft,HT_DRAFT_SEND,0,0,100));
    assert(!ht_draft_command(&draft,HT_DRAFT_UNDO,1,0,100));
    congested=true;assert(!ht_draft_command(&draft,HT_DRAFT_SEND,1,0,100));assert(!draft.pending);congested=false;
    assert(ht_draft_command(&draft,HT_DRAFT_MOVE,1,1,100));assert(draft.pending && commands==1);
    assert(!ht_draft_command(&draft,HT_DRAFT_SEND,1,0,200));
    assert(!ht_draft_reply(&draft,"other",sent.request,true,&page));
    assert(!ht_draft_reply(&draft,"one",sent.request+1,true,&page));
    assert(!ht_draft_tick(&draft,5099));assert(ht_draft_tick(&draft,5100));assert(draft.failed && !draft.pending);
    assert(!ht_draft_command(&draft,HT_DRAFT_SEND,1,0,5200));
    assert(!ht_draft_reply(&draft,"one",sent.request,true,&page)); // Timed-out receipt cannot release a newer contact.
    assert(ht_draft_command(&draft,HT_DRAFT_STATE,1,0,5300));
    page.revision=2;page.position=2;
    assert(ht_draft_reply(&draft,"one",sent.request,true,&page));assert(!draft.failed && draft.page.revision==2);
    page.can_send=false;ht_draft_open(&draft,&page,emit,NULL);
    assert(!ht_draft_command(&draft,HT_DRAFT_SEND,2,0,5400));
    page.can_send=true;ht_draft_open(&draft,&page,emit,NULL);
    assert(ht_draft_command(&draft,HT_DRAFT_SEND,2,0,5400));
    page.locked=true;strcpy(page.error,"Could not confirm");
    assert(ht_draft_reply(&draft,"one",sent.request,false,&page));
    assert(!ht_draft_command(&draft,HT_DRAFT_SEND,2,0,5500));
    assert(ht_draft_command(&draft,HT_DRAFT_STATE,2,0,5600));page.active=false;
    assert(ht_draft_reply(&draft,"one",sent.request,true,&page));assert(!draft.page.active);
    unsigned old=sent.request;
    page.active=true;page.locked=false;page.error[0]=0;ht_draft_open(&draft,&page,emit,NULL);
    assert(ht_draft_command(&draft,HT_DRAFT_DISCARD,2,0,5700));assert(sent.request>old);
    page.active=false;assert(ht_draft_reply(&draft,"one",sent.request,false,&page));assert(!draft.page.active);
    // Deadline arithmetic remains valid when the millisecond counter wraps.
    page.active=true;ht_draft_open(&draft,&page,emit,NULL);
    assert(ht_draft_command(&draft,HT_DRAFT_STATE,2,0,UINT32_MAX-100));
    assert(!ht_draft_tick(&draft,2000));assert(ht_draft_tick(&draft,4900));
    // Detachment permanently revokes mutations and keeps the last visible part.
    page.active=true;page.can_send=page.can_undo=true;page.locked=false;
    ht_draft_open(&draft,&page,emit,NULL);assert(ht_draft_command(&draft,HT_DRAFT_SEND,2,0,100));
    unsigned interrupted=sent.request;ht_draft_detach(&draft);
    assert(draft.read_only&&!draft.pending&&draft.page.locked&&!draft.page.can_send&&!draft.page.can_undo);
    assert(!ht_draft_reply(&draft,"one",interrupted,true,&page));
    for(int op=HT_DRAFT_UNDO;op<=HT_DRAFT_SEND;op++)assert(!ht_draft_command(&draft,(ht_draft_op_t)op,2,0,100));
    assert(ht_draft_command(&draft,HT_DRAFT_STATE,2,0,100));page.active=false;
    assert(ht_draft_reply(&draft,"one",sent.request,true,&page)&&draft.page.active&&draft.read_only);
    assert(ht_draft_command(&draft,HT_DRAFT_STATE,2,0,100));page.active=true;
    assert(ht_draft_reply(&draft,"one",sent.request,true,&page)&&draft.read_only&&!draft.page.can_send&&!draft.page.can_undo);
    assert(ht_draft_command(&draft,HT_DRAFT_MOVE,2,-1,100));assert(ht_draft_tick(&draft,5100));
    assert(draft.page.active&&draft.read_only&&!strcmp(draft.page.error,"Full message unavailable."));
    printf("draft: PASS (revision/receipt ownership, transport refusal, timeout, recovery, at-most-once send and wraparound); state=%zu bytes\n",sizeof draft);
}
