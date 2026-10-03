#include "../main/ui/habitat/form.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static ht_form_command_t last;
static int sent;
static bool blocked;
static bool emit(const ht_form_command_t *c, void *ctx) {
    (void)ctx;
    if (blocked) return false;
    last = *c; sent++; return true;
}
static ht_form_page_t page = {.active=true,.enabled=true,.revision=1,.total=4,.position=4,
                              .title="New Harness",.label="New Harness",.action="start"};
int main(void) {
    ht_form_t s = {0};
    assert(ht_form_open(&s,"form-one",100,emit,NULL));
    assert(s.pending && last.op==HT_FORM_OPEN);
    assert(!ht_form_command(&s,HT_FORM_ACTIVATE,0,0,101));
    assert(!ht_form_reply(&s,"wrong",s.request,true,&page,102));
    assert(!ht_form_reply(&s,"form-one",s.request+1,true,&page,102));
    assert(ht_form_reply(&s,"form-one",s.request,true,&page,102));
    assert(!ht_form_command(&s,HT_FORM_ACTIVATE,0,0,103));
    assert(ht_form_command(&s,HT_FORM_ACTIVATE,1,0,103));
    assert(last.op==HT_FORM_ACTIVATE);
    assert(!ht_form_command(&s,HT_FORM_ACTIVATE,1,0,104));
    page.busy=true; page.enabled=false; page.revision=2;
    assert(ht_form_reply(&s,"form-one",s.request,true,&page,104));
    assert(!ht_form_command(&s,HT_FORM_ACTIVATE,2,0,105));
    int n=sent; ht_form_move(&s,200,106); assert(n==sent && !s.queued);
    ht_form_tick(&s,405); assert(s.pending && last.op==HT_FORM_STATE);
    page.busy=false; page.enabled=true; page.revision=3;
    ht_form_reply(&s,"form-one",s.request,true,&page,406);
    ht_form_move(&s,125,407); assert(last.op==HT_FORM_MOVE && last.delta==2);
    for (int i=0;i<100;i++) ht_form_move(&s,460,407+i);
    assert(s.queued==8); page.revision++;
    ht_form_reply(&s,"form-one",s.request,true,&page,510);
    assert(last.op==HT_FORM_MOVE && last.delta==8 && !s.queued);
    page.revision++;
    ht_form_reply(&s,"form-one",s.request,true,&page,511);
    blocked=true; n=sent; ht_form_move(&s,80,512);
    assert(s.queued && !s.pending && sent==n);
    blocked=false; ht_form_tick(&s,513); assert(s.pending && last.op==HT_FORM_MOVE);
    assert(ht_form_tick(&s,4014) && s.failed && !s.pending && !s.queued);
    // Timeout does not retry the launch/move; only a new explicit read/open.
    n=sent; ht_form_tick(&s,8000); assert(sent==n);
    assert(ht_form_command(&s,HT_FORM_OPEN,s.page.revision,0,8001));
    page.revision++;
    ht_form_reply(&s,"form-one",s.request,false,&page,8002);
    assert(!s.failed && !s.queued); // stale-choice reply presents the new choice
    uint32_t old=s.request; ht_form_reset(&s);
    assert(ht_form_open(&s,"form-two",UINT32_MAX-100,emit,NULL));
    assert(s.request>old && !ht_form_tick(&s,1500));
    assert(ht_form_tick(&s,3499));
    assert(!ht_form_reply(&s,"form-two",s.request,true,&page,3500));
    assert(ht_form_command(&s,HT_FORM_OPEN,0,0,3501));
    page.active=false;
    assert(ht_form_reply(&s,"form-two",s.request,true,&page,3502) && !s.id[0]);
    // Back is a local escape from an opening Finder, even with a lost reply
    // or a full cable queue. Neither the open reply nor close reply revives it.
    page.active=true;
    assert(ht_form_open(&s,"find-opening",4000,emit,NULL));
    old=s.request;
    assert(ht_form_dismiss(&s));
    assert(last.op==HT_FORM_CLOSE && !s.id[0] && !s.pending);
    assert(!ht_form_reply(&s,"find-opening",old,true,&page,4010));
    assert(!ht_form_reply(&s,"find-opening",last.request,true,&page,4011));
    assert(ht_form_open(&s,"find-again",4020,emit,NULL));
    assert(s.request>old);
    blocked=true; assert(!ht_form_dismiss(&s));
    assert(!s.id[0] && !s.pending && !s.failed);
    printf("form: stale/duplicate activation, busy, bounded drag, backpressure, timeout, wraparound passed; state=%zu bytes\n",sizeof s);
}
