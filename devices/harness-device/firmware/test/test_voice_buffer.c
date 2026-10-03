#include "../main/voice_buffer.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
int main(void)
{
    voice_buffer_t b;
    uint8_t storage[1024], input[400];
    voice_buffer_init(&b, storage, sizeof(storage));
    uint32_t produced = 0, consumed = 0;
    for (int i = 0; i < 20000; i++) {
        size_t size = (unsigned)(i * 29) % sizeof(input) + 1;
        for (size_t j = 0; j < size; j++)
            input[j] = (uint8_t)(produced + j);
        if (voice_buffer_write(&b, input, size))
            produced += (uint32_t)size;
        const uint8_t *p;
        size_t n = voice_buffer_peek(&b, &p, (unsigned)(i * 13) % 300 + 1);
        for (size_t j = 0; j < n; j++)
            assert(p[j] == (uint8_t)(consumed + j));
        voice_buffer_consume(&b, n);
        consumed += (uint32_t)n;
        assert(voice_buffer_used(&b) == produced - consumed);
    }
    // Unsigned counters also wrap safely after long-running use.
    voice_buffer_init(&b, storage, sizeof(storage));
    atomic_store(&b.head, UINT32_MAX - 255);
    atomic_store(&b.tail, UINT32_MAX - 255);
    memset(input, 0x6a, sizeof(input));
    assert(voice_buffer_write(&b, input, sizeof(input)));
    const uint8_t *p;
    size_t n = voice_buffer_peek(&b, &p, 1024);
    assert(n == 256);
    voice_buffer_consume(&b, n);
    n = voice_buffer_peek(&b, &p, 1024);
    assert(n == 144);
    for (size_t j = 0; j < n; j++)
        assert(p[j] == 0x6a);
    voice_buffer_consume(&b, n);
    assert(!voice_buffer_used(&b));
    int16_t pcm[640];
    for (int i = 0; i < 640; i++)
        pcm[i] = 2000;
    for (int chunk = 160; chunk <= 640; chunk *= 2) {
        voice_gate_t gate = {0};
        int elapsed = 0;
        while (elapsed < 5120) {
            assert(!gate.heard);
            voice_gate_feed(&gate, pcm, chunk, 16000);
            elapsed += chunk;
        }
        assert(gate.heard);
    }
    voice_gate_t gate = {0};
    voice_gate_feed(&gate, pcm, 640, 16000);
    memset(pcm, 0, sizeof(pcm));
    voice_gate_feed(&gate, pcm, 640, 16000);
    assert(!gate.heard && !gate.loud_samples);
    voice_level_t meter={0};
    assert(voice_level_feed(&meter,pcm,0)==0);
    for(int i=0;i<640;i++) pcm[i]=1500; // DC offset is not a mic signal
    assert(voice_level_feed(&meter,pcm,640)==0);
    pcm[0]=-32768; pcm[1]=32767;
    assert(voice_level_feed(&meter,pcm,640)==4);
    assert(pcm[0]==-32768 && pcm[1]==32767); // meter never modifies captured audio
    memset(pcm,0,sizeof(pcm));
    assert(voice_level_feed(&meter,pcm,160)==4); // fast attack, slow release
    for(int i=0;i<300;i++) voice_level_feed(&meter,pcm,160);
    assert(voice_level_feed(&meter,pcm,160)==0);
    pcm[0]=-150; pcm[1]=150;
    assert(voice_level_feed(&meter,pcm,160)==2); // quiet input remains visible
    puts("voice_buffer: byte order, backpressure, wraparound, overflow refusal and 320ms gate "
         "passed");
}
