#include "../main/voice_buffer.h"
#include "../main/audio_capture.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// The shared vectors (vectors/voice_gate.txt and .pcm). The daemon's copy of the gate is held to the same files, so
// the two gates cannot drift apart.
typedef struct { float db; int loud, steps[4]; } gain_line_t;
typedef struct { char name[32]; long first, samples; int heard[2]; } clip_line_t;
static unsigned rate;
static gain_line_t gains[2];
static clip_line_t clips[16];
static int gain_count, clip_count;
static int16_t *shared;
static long shared_samples;

static void read_vectors(const char *txt, const char *pcm)
{
    FILE *f = fopen(txt, "r");
    assert(f);
    char line[256];
    while (fgets(line, sizeof(line), f)) {
        if (line[0] == '#' || line[0] == '\n')
            continue;
        gain_line_t g;
        clip_line_t c;
        if (sscanf(line, "rate %u", &rate) == 1)
            continue;
        if (sscanf(line, "gain %f %d %d %d %d %d", &g.db, &g.loud, &g.steps[0], &g.steps[1], &g.steps[2],
                   &g.steps[3]) == 6) {
            assert(gain_count < 2);
            gains[gain_count++] = g;
            continue;
        }
        int n = sscanf(line, "clip %31s %ld %ld %d %d", c.name, &c.first, &c.samples, &c.heard[0], &c.heard[1]);
        assert(n == 3 + gain_count && clip_count < 16);
        clips[clip_count++] = c;
    }
    fclose(f);
    assert(rate && gain_count == 2 && clip_count);
    f = fopen(pcm, "rb");
    assert(f);
    assert(!fseek(f, 0, SEEK_END));
    long bytes = ftell(f);
    assert(bytes > 0 && bytes % 2 == 0);
    rewind(f);
    uint8_t *raw = malloc((size_t)bytes);
    assert(raw && fread(raw, 1, (size_t)bytes, f) == (size_t)bytes);
    fclose(f);
    shared_samples = bytes / 2;
    shared = malloc((size_t)bytes);
    assert(shared);
    for (long i = 0; i < shared_samples; i++) // the file is little-endian, whatever the host is
        shared[i] = (int16_t)(uint16_t)(raw[2 * i] | raw[2 * i + 1] << 8);
    free(raw);
}

// Fed rate / 100 samples a call, as the dial's capture loop feeds it.
static bool heard_pcm(const int16_t *pcm, long samples, float db)
{
    voice_gate_t gate = {0};
    long block = (long)rate / 100;
    for (long at = 0; at < samples; at += block)
        voice_gate_feed(&gate, pcm + at, (size_t)(samples - at < block ? samples - at : block), rate, db);
    return gate.heard;
}

// 400 ms of alternating +-amplitude: each block's mean |sample| is the amplitude itself.
static bool heard_tone(int amplitude, float db)
{
    long samples = (long)rate * 400 / 1000;
    int16_t *pcm = malloc((size_t)samples * sizeof(*pcm));
    assert(pcm);
    for (long i = 0; i < samples; i++)
        pcm[i] = (int16_t)(i % 2 ? -amplitude : amplitude);
    bool heard = heard_pcm(pcm, samples, db);
    free(pcm);
    return heard;
}

// A fresh meter, one block whose peak-to-peak is the span.
static unsigned level_of_span(int span, float db)
{
    voice_level_t meter = {0};
    int16_t pcm[2] = {0, (int16_t)span};
    return voice_level_feed(&meter, pcm, 2, db);
}

static bool has_gain_line(float db)
{
    for (int i = 0; i < gain_count; i++)
        if (gains[i].db == db)
            return true;
    return false;
}

int main(int argc, char **argv)
{
    assert(argc == 3);
    read_vectors(argv[1], argv[2]);
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
            voice_gate_feed(&gate, pcm, chunk, 16000, AUDIO_MIC_GAIN_DB);
            elapsed += chunk;
        }
        assert(gate.heard);
    }
    voice_gate_t gate = {0};
    voice_gate_feed(&gate, pcm, 640, 16000, AUDIO_MIC_GAIN_DB);
    memset(pcm, 0, sizeof(pcm));
    voice_gate_feed(&gate, pcm, 640, 16000, AUDIO_MIC_GAIN_DB);
    assert(!gate.heard && !gate.loud_samples);
    voice_level_t meter={0};
    assert(voice_level_feed(&meter,pcm,0,37.5f)==0);
    for(int i=0;i<640;i++) pcm[i]=1500; // DC offset is not a mic signal
    assert(voice_level_feed(&meter,pcm,640,37.5f)==0);
    pcm[0]=-32768; pcm[1]=32767;
    assert(voice_level_feed(&meter,pcm,640,37.5f)==4);
    assert(pcm[0]==-32768 && pcm[1]==32767); // meter never modifies captured audio
    memset(pcm,0,sizeof(pcm));
    assert(voice_level_feed(&meter,pcm,160,37.5f)==4); // fast attack, slow release
    for(int i=0;i<300;i++) voice_level_feed(&meter,pcm,160,37.5f);
    assert(voice_level_feed(&meter,pcm,160,37.5f)==0);
    pcm[0]=-150; pcm[1]=150;
    assert(voice_level_feed(&meter,pcm,160,37.5f)==2); // quiet input remains visible

    for (int g = 0; g < gain_count; g++) {
        int loud = gains[g].loud;
        assert(!heard_tone(loud, gains[g].db) && heard_tone(loud + 1, gains[g].db));
        for (unsigned i = 0; i < 4; i++)
            assert(level_of_span(gains[g].steps[i] - 1, gains[g].db) == i &&
                   level_of_span(gains[g].steps[i], gains[g].db) == i + 1);
    }
    for (int c = 0; c < clip_count; c++) {
        assert(clips[c].first >= 0 && clips[c].samples > 0 && clips[c].first + clips[c].samples <= shared_samples);
        for (int g = 0; g < gain_count; g++)
            if (heard_pcm(shared + clips[c].first, clips[c].samples, gains[g].db) != (bool)clips[c].heard[g]) {
                fprintf(stderr, "voice_buffer: %s at %g dB disagrees with the shared vectors\n", clips[c].name,
                        (double)gains[g].db);
                return 1;
            }
    }
    assert(has_gain_line(AUDIO_MIC_GAIN_DB)); // the shipped gain has levels of its own
    assert(!heard_tone(600, 27.0f) && heard_tone(601, 27.0f)); // a gain with no row reads as 37.5 dB
    assert(level_of_span(63, 27.0f) == 0 && level_of_span(64, 27.0f) == 1);
    free(shared);
    printf("voice_buffer: byte order, backpressure, wraparound, overflow refusal and 320ms gate, the gate and meter "
           "at each mic gain, and the daemon's gate on %d shared clips passed\n", clip_count);
}
