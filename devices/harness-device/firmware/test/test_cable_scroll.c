#include "cable_scroll.h"
#include "cJSON.h"
#include <assert.h>
#include <limits.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static unsigned allocations, live;
static void *allocate(size_t n) { void *p=malloc(n); allocations++; if(p)live++; return p; }
static void release(void *p) { if(p) { assert(live);live--;free(p); } }
static char *original(int phase,int dy,int v) {
    static const char *names[]={"down","move","up"};
    cJSON *root=cJSON_CreateObject();assert(root);
    assert(cJSON_AddStringToObject(root,"t","scroll"));
    assert(cJSON_AddStringToObject(root,"phase",names[phase]));
    assert(cJSON_AddNumberToObject(root,"dy",dy));
    if(phase==2)assert(cJSON_AddNumberToObject(root,"v",v));
    char *out=cJSON_PrintUnformatted(root);cJSON_Delete(root);assert(out);return out;
}
static uint32_t rng=0x914819;
static int random_int(void) {
    rng^=rng<<13;rng^=rng>>17;rng^=rng<<5;
    int32_t result;memcpy(&result,&rng,sizeof result);return result;
}
static void compare(int phase,int dy,int v) {
    char *expected=original(phase,dy,v),out[CABLE_SCROLL_JSON_MAX];
    unsigned count=allocations;
    size_t n=cable_scroll_encode(out,sizeof out,phase,dy,v);
    assert(n==strlen(expected)&&!strcmp(out,expected)&&allocations==count);
    cJSON_free(expected);assert(!live);
}
static void *concurrent(void *arg) {
    unsigned id=(unsigned)(uintptr_t)arg;
    char first[CABLE_SCROLL_JSON_MAX],next[CABLE_SCROLL_JSON_MAX];
    size_t n=cable_scroll_encode(first,sizeof first,id%3,(int)id-5,INT_MIN+(int)id);
    for(unsigned i=0;i<20000;i++) {
        assert(cable_scroll_encode(next,sizeof next,id%3,(int)id-5,INT_MIN+(int)id)==n);
        assert(!strcmp(first,next));
    }
    return NULL;
}
int main(void) {
    cJSON_Hooks hooks={.malloc_fn=allocate,.free_fn=release};cJSON_InitHooks(&hooks);
    const int edges[]={INT_MIN,INT_MIN+1,-6000,-1,0,1,6000,INT_MAX-1,INT_MAX};
    for(int p=0;p<3;p++)for(unsigned i=0;i<sizeof edges/sizeof *edges;i++)
        for(unsigned j=0;j<sizeof edges/sizeof *edges;j++)compare(p,edges[i],edges[j]);
    for(unsigned i=0;i<50000;i++)compare(i%3,random_int(),random_int());
    unsigned baseline_calls[3];
    for(int p=0;p<3;p++) {
        unsigned before=allocations;char *s=original(p,0,0);cJSON_free(s);
        baseline_calls[p]=allocations-before;
        for(size_t cap=0;cap<=CABLE_SCROLL_JSON_MAX;cap++) {
            unsigned char guard[CABLE_SCROLL_JSON_MAX+2];memset(guard,0xa7,sizeof guard);
            char *out=(char*)guard+1;
            size_t n=cable_scroll_encode(out,cap,p,INT_MIN,INT_MAX);
            assert(guard[0]==0xa7&&guard[cap+1]==0xa7);
            for(size_t i=cap+1;i<sizeof guard;i++)assert(guard[i]==0xa7);
            if(n)assert(n<cap&&out[n]==0);else if(cap)assert(out[0]==0);
        }
    }
    assert(!cable_scroll_encode(NULL,0,0,0,0)&&!cable_scroll_encode(NULL,96,0,0,0));
    char out[CABLE_SCROLL_JSON_MAX];
    for(int p=3;p<100;p++){strcpy(out,"before");assert(!cable_scroll_encode(out,sizeof out,p,1,2)&&!out[0]);}
    assert(!cable_scroll_encode(out,sizeof out,INT_MIN,1,2));
    cJSON_InitHooks(NULL);pthread_t threads[8];
    for(uintptr_t i=0;i<8;i++)assert(!pthread_create(&threads[i],NULL,concurrent,(void*)i));
    for(unsigned i=0;i<8;i++)assert(!pthread_join(threads[i],NULL));
    printf("Scroll JSON: 50243 exact original messages, every capacity/32-bit edge, 160000 concurrent encodes; allocations %u/%u/%u -> 0 PASS\n",
        baseline_calls[0],baseline_calls[1],baseline_calls[2]);
}
