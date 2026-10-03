// The deployed single-producer/single-consumer ring under actual parallel
// execution, variable chunk sizes, backpressure and 32-bit counter wrap.
#include "../main/voice_buffer.h"
#include <assert.h>
#include <pthread.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static voice_buffer_t buffer;
static atomic_bool done;
static uint32_t total;
static unsigned seed;
static uint32_t random_step(uint32_t *r) { *r ^= *r << 13; *r ^= *r >> 17; *r ^= *r << 5; return *r; }
static void *produce(void *unused)
{
    (void)unused;uint8_t bytes[800];uint32_t sent=0,rng=seed;
    while(sent<total) {
        unsigned cap=buffer.capacity<sizeof bytes?buffer.capacity:sizeof bytes;
        size_t n=1+random_step(&rng)%cap;
        if(n>total-sent)n=total-sent;
        for(size_t i=0;i<n;i++)bytes[i]=(uint8_t)(sent+i);
        if(voice_buffer_write(&buffer,bytes,n))sent+=(uint32_t)n;
        else sched_yield();
        if(!(rng&31))sched_yield();
    }
    atomic_store_explicit(&done,true,memory_order_release);return NULL;
}
static void *consume(void *unused)
{
    (void)unused;uint32_t received=0,rng=seed^0x84813;
    while(received<total) {
        const uint8_t *bytes;
        size_t n=voice_buffer_peek(&buffer,&bytes,1+random_step(&rng)%1200);
        if(!n){sched_yield();continue;}
        for(size_t i=0;i<n;i++)assert(bytes[i]==(uint8_t)(received+i));
        // Keep ownership of bytes while the producer fills remaining space.
        if(!(rng&15))sched_yield();
        voice_buffer_consume(&buffer,n);received+=(uint32_t)n;
    }
    return NULL;
}
int main(void)
{
    static const unsigned sizes[]={32,256,1024,32768};
    const char *amount=getenv("VOICE_THREAD_BYTES");
    total=amount?(uint32_t)strtoul(amount,NULL,10):2*1024*1024;
    assert(total&&total<UINT32_MAX/2);
    uint64_t verified=0;
    for(unsigned cycle=0;cycle<8;cycle++) {
        unsigned cap=sizes[cycle%4];uint8_t *storage=malloc(cap+16);assert(storage);
        memset(storage,0xa5,cap+16);voice_buffer_init(&buffer,storage+8,cap);done=false;
        if(cycle&1){atomic_store(&buffer.head,UINT32_MAX-255);atomic_store(&buffer.tail,UINT32_MAX-255);}
        seed=0x4d6a1985u+cycle*38119u;
        pthread_t producer,consumer;
        assert(!pthread_create(&producer,NULL,produce,NULL));
        assert(!pthread_create(&consumer,NULL,consume,NULL));
        assert(!pthread_join(producer,NULL)&&!pthread_join(consumer,NULL));
        assert(atomic_load_explicit(&done,memory_order_acquire)&&!voice_buffer_used(&buffer));
        for(int i=0;i<8;i++)assert(storage[i]==0xa5&&storage[cap+8+i]==0xa5);
        free(storage);verified+=total;
    }
    printf("Voice ring threads: %llu bytes in exact order across four capacities, backpressure and counter wrap PASS\n",(unsigned long long)verified);
}
