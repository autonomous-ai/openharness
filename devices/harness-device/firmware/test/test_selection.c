#include "../main/ui/habitat/selection.h"
#include <assert.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>

static ht_select_command_t last;
static char last_id[48];
static int count;
static bool blocked;
static bool emit(const ht_select_command_t *c, void *ctx)
{
    (void)ctx;
    if (blocked) return false;
    last = *c; snprintf(last_id, sizeof(last_id), "%s", c->id); last.id = last_id;
    count++;
    return true;
}
static void reply(ht_selection_t *s, uint32_t now)
{
    assert(ht_selection_reply(s, s->request, s->id, true, s->revision + 1, "a selected line", 1,
        last.op == HT_SELECT_EXTEND, NULL, now));
}
int main(void)
{
    ht_selection_t s = {0};
    ht_selection_open(&s, "pick-one", "agent-a", 10, emit, NULL);
    assert(last.op == HT_SELECT_BEGIN && s.pending && !ht_selection_ready(&s));
    uint32_t stale = s.request;
    // Contacts continue while desktop is replying, without a flood of requests.
    for (int i = 0; i < 1000; i++) ht_selection_move(&s, -466, 20);
    assert(count == 1 && s.queued == -8);
    reply(&s, 21);
    assert(last.op == HT_SELECT_STEP && last.delta == -8 && s.pending);
    assert(!ht_selection_reply(&s, stale, s.id, true, 1, "old", 1, false, NULL, 22));
    reply(&s, 23);
    assert(ht_selection_ready(&s));
    ht_selection_extend(&s, 24); assert(!ht_selection_ready(&s));
    reply(&s, 25); assert(s.extending);
    // Wrong id, revision and oversized ranges cannot enable voice.
    ht_selection_move(&s, 20, 26);
    assert(!ht_selection_reply(&s, s.request, "wrong", true, s.revision + 1, "x", 1, false, NULL, 27));
    assert(!ht_selection_reply(&s, s.request, s.id, true, s.revision + 2, "x", 1, false, NULL, 27));
    assert(!ht_selection_reply(&s, s.request, s.id, true, s.revision + 1, "x", 17, false, NULL, 27));
    assert(!ht_selection_ready(&s));
    reply(&s, 28);
    ht_selection_close(&s);
    assert(last.op == HT_SELECT_CANCEL && !s.active && !ht_selection_ready(&s));
    // Cancel before begin is acknowledged still names the cursor being created.
    ht_selection_open(&s, "pick-two", "agent-a", 30, emit, NULL);
    stale = s.request;
    ht_selection_close(&s);
    assert(last.op == HT_SELECT_CANCEL && !strcmp(last.id, "pick-two"));
    assert(!ht_selection_reply(&s, stale, "pick-two", true, 1, "late", 1, false, NULL, 31));
    // Queue failure is a retryable screen; it never drops into bare dictation.
    blocked = true;
    ht_selection_open(&s, "blocked", "a", 40, emit, NULL);
    assert(s.error[0] && !s.announced && !ht_selection_ready(&s));
    ht_selection_close(&s); blocked = false;
    // Timeout works across the millisecond wrap, emits one cancel, stays quiet.
    ht_selection_open(&s, "timeout", "a", UINT32_MAX - 1000, emit, NULL);
    assert(!ht_selection_tick(&s, UINT32_MAX - 500));
    assert(ht_selection_tick(&s, 2500));
    assert(last.op == HT_SELECT_CANCEL && s.error[0]);
    int after_timeout = count;
    ht_selection_close(&s); assert(count == after_timeout);
    ht_selection_open(&s,"search","a",3000,emit,NULL); reply(&s,3001);
    assert(!ht_selection_found(&s,"search","b",2,"match",1,"error",1,3));
    assert(!ht_selection_found(&s,"search","a",3,"match",1,"error",1,3));
    assert(ht_selection_found(&s,"search","a",2,"first error",1,"error",1,3));
    int before = count;
    ht_selection_move(&s,59,3002); assert(count==before);
    ht_selection_move(&s,1,3003); assert(last.op==HT_SELECT_MATCH && last.delta==1);
    ht_selection_move(&s,120,3004); assert(s.queued==2);
    assert(ht_selection_reply_search(&s,s.request,s.id,true,3,"second error",1,false,NULL,"error",2,3,3005));
    assert(last.op==HT_SELECT_MATCH && last.delta==2 && s.pending);
    assert(ht_selection_reply_search(&s,s.request,s.id,true,4,"first error",1,false,NULL,"error",1,3,3006));
    ht_selection_extend(&s,3007); assert(last.op==HT_SELECT_LINES);
    reply(&s,3008); assert(!s.query[0]);
    assert(!ht_selection_found(&s,"search","a",6,"",0,"missing",1,0));
    assert(ht_selection_found(&s,"search","a",6,"",0,"missing",0,0));
    assert(ht_selection_ready(&s) && !s.excerpt[0]);
    before=count; ht_selection_extend(&s,3009); assert(count==before);
    assert(ht_selection_found(&s,"search","a",7,"found again",1,"found",1,1));
    ht_selection_close(&s); assert(!ht_selection_found(&s,"search","a",8,"late",1,"found",1,1));
    puts("selection: bounded movement, identity, cancellation, queue failure and wraparound passed");
}
