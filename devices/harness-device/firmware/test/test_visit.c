#include "../main/ui/habitat/visit.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static bool full;
static int sends;
static ht_visit_op_t last;
static bool emit(const ht_visit_command_t *c, void *unused)
{
    (void)unused;
    if (full) return false;
    sends++; last=c->op;
    assert(c->id[0] && c->request);
    return true;
}
int main(void)
{
    ht_visit_t s={0};
    assert(ht_visit_open(&s,"visit-1","agent-a",10,emit,NULL));
    uint32_t request=s.request;
    assert(!ht_visit_open(&s,"visit-2","agent-b",11,emit,NULL));
    assert(!ht_visit_back(&s,20));
    assert(!ht_visit_reply(&s,"visit-2",request,true,"origin"));
    assert(!ht_visit_reply(&s,"visit-1",request+1,true,"origin"));
    assert(ht_visit_reply(&s,"visit-1",request,true,"origin"));
    assert(s.available && !s.pending && !strcmp(s.label,"origin"));
    assert(ht_visit_open(&s,"visit-1","agent-b",30,emit,NULL));
    assert(s.available && !strcmp(s.agent,"agent-b"));
    assert(ht_visit_reply(&s,"visit-1",s.request,true,"origin"));
    assert(ht_visit_back(&s,50)); assert(last==HT_VISIT_BACK);
    assert(ht_visit_reply(&s,"visit-1",s.request,false,""));
    assert(!s.available && !s.id[0] && !ht_visit_back(&s,60));
    assert(ht_visit_open(&s,"visit-2","agent-a",UINT32_MAX-100,emit,NULL));
    request=s.request;
    assert(!ht_visit_tick(&s,30));
    assert(ht_visit_tick(&s,3500)); assert(last==HT_VISIT_CANCEL);
    assert(!ht_visit_reply(&s,"visit-2",request,true,"late"));
    full=true;
    assert(!ht_visit_open(&s,"visit-3","agent-a",9000,emit,NULL));
    assert(!s.pending && !s.available);
    full=false;
    assert(ht_visit_latest(&s,"visit-reading","agent-a",10000,emit,NULL));
    assert(last==HT_VISIT_LATEST && s.op==HT_VISIT_LATEST);
    request=s.request;
    assert(!ht_visit_latest(&s,"visit-reading","agent-a",10001,emit,NULL));
    assert(ht_visit_reply(&s,"visit-reading",request,true,"Your reading"));
    full=true;
    assert(!ht_visit_open(&s,"visit-reading","agent-b",10020,emit,NULL));
    assert(s.available && !s.pending && !strcmp(s.agent,"agent-a"));
    full=false;
    assert(ht_visit_latest(&s,"visit-reading","agent-a",10100,emit,NULL));
    assert(!ht_visit_reply(&s,"visit-reading",request,true,"Old receipt"));
    assert(ht_visit_reply(&s,"visit-reading",s.request,true,"Your reading"));
    assert(ht_visit_back(&s,10200)); assert(s.op==HT_VISIT_BACK);
    assert(ht_visit_reply(&s,"visit-reading",s.request,false,""));
    ht_visit_close(&s);
    full=false;
    assert(ht_visit_open(&s,"visit-4","agent-a",9000,emit,NULL));
    ht_visit_close(&s); assert(last==HT_VISIT_CANCEL);
    assert(!s.pending && !s.available);
    printf("visit: correlated replies, chained visits, return, timeout/wrap, congestion, cancel; state=%zu bytes\n",sizeof s);
}
