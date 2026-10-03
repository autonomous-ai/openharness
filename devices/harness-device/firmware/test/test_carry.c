#include "../main/ui/habitat/carry.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static int prepares,cancels;
static bool busy;
static bool emit(const ht_carry_command_t *c,void *ctx)
{
    (void)ctx;
    if (busy) return false;
    if (c->cancel) cancels++;
    else { prepares++; assert(!strcmp(c->agent,"source") && !strcmp(c->selection,"pick-1") && c->revision==3); }
    return true;
}
static void open_carry(ht_carry_t *c,uint32_t now)
{ ht_carry_open(c,"carry-1","source","pick-1",3,now,emit,NULL); }
int main(void)
{
    ht_carry_t c={0}; open_carry(&c,100);
    assert(c.pending && !c.active && prepares==1);
    uint32_t request=c.request;
    assert(!ht_carry_reply(&c,"old",request,true,"Source","passage",2,300000,NULL,200));
    assert(!ht_carry_reply(&c,c.id,request,true,"Source","passage",17,300000,NULL,200));
    assert(!ht_carry_reply(&c,c.id,request,true,"Source","passage",2,300001,NULL,200));
    assert(ht_carry_reply(&c,c.id,request,true,"Source","passage",2,300000,NULL,200));
    assert(c.active && !c.pending && c.rows==2 && !strcmp(c.source,"Source"));
    assert(!ht_carry_reply(&c,c.id,request,true,"Changed","wrong",1,1000,NULL,210));
    assert(!ht_carry_tick(&c,300199)); assert(ht_carry_tick(&c,300200));
    assert(!c.active && c.error[0] && !c.id[0] && cancels==1);
    ht_carry_close(&c); assert(!c.error[0]);
    open_carry(&c,UINT32_MAX-1000); request=c.request;
    assert(!ht_carry_tick(&c,2498)); assert(ht_carry_tick(&c,2499));
    assert(!c.pending && c.error[0]);
    assert(!ht_carry_reply(&c,"carry-1",request,true,"Source","late",1,1000,NULL,2500));
    open_carry(&c,5000); request=c.request; ht_carry_close(&c);
    assert(!ht_carry_reply(&c,"carry-1",request,true,"Source","late",1,1000,NULL,5001));
    busy=true; open_carry(&c,6000); assert(!c.pending && !c.active && c.error[0]);
    printf("carry: frozen identity, bounded TTL, expiry, cancellation, congestion, duplicate/stale replies and wrap passed; state=%zu bytes\n",sizeof c);
}
