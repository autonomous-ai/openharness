#include "voice_buffer.h"
#include <assert.h>
#include <string.h>
void voice_buffer_init(voice_buffer_t *b, uint8_t *storage, uint32_t capacity)
{
    assert(capacity && !(capacity & (capacity - 1)));
    b->data = storage;
    b->capacity = capacity;
    atomic_store(&b->head, 0);
    atomic_store(&b->tail, 0);
}
bool voice_buffer_write(voice_buffer_t *b, const uint8_t *data, size_t size)
{
    uint32_t head = atomic_load_explicit(&b->head, memory_order_relaxed);
    uint32_t tail = atomic_load_explicit(&b->tail, memory_order_acquire);
    if (size > b->capacity - (uint32_t)(head - tail))
        return false;
    uint32_t pos = head & (b->capacity - 1);
    size_t first = b->capacity - pos;
    if (first > size)
        first = size;
    memcpy(b->data + pos, data, first);
    memcpy(b->data, data + first, size - first);
    atomic_store_explicit(&b->head, head + (uint32_t)size, memory_order_release);
    return true;
}
size_t voice_buffer_peek(voice_buffer_t *b, const uint8_t **data, size_t limit)
{
    uint32_t tail = atomic_load_explicit(&b->tail, memory_order_relaxed);
    uint32_t head = atomic_load_explicit(&b->head, memory_order_acquire);
    uint32_t pos = tail & (b->capacity - 1);
    size_t size = head - tail;
    if (size > b->capacity - pos)
        size = b->capacity - pos;
    if (size > limit)
        size = limit;
    *data = b->data + pos;
    return size;
}
void voice_buffer_consume(voice_buffer_t *b, size_t size)
{
    assert(size <= voice_buffer_used(b));
    atomic_fetch_add_explicit(&b->tail, (unsigned)size, memory_order_release);
}
uint32_t voice_buffer_used(voice_buffer_t *b)
{
    // Called by either owner for telemetry, never to decide overwrite permission.
    uint32_t tail = atomic_load_explicit(&b->tail, memory_order_acquire);
    return atomic_load_explicit(&b->head, memory_order_acquire) - tail;
}
// The gate's loud level and the meter's steps, by the gain they hold at. 37.5 dB: set by ear. 30 dB: the design
// doc's gate of 250 (the formula gives 253) and each 37.5 dB step scaled by 10^(-7.5/20). A table, not a formula,
// so the daemon's copy (cli/src/cable/voiceLevel.ts) holds the same integers; test/vectors/voice_gate.txt pins both.
static const struct {
    float gain_db;
    uint32_t loud, steps[4];
} levels[] = {
    {37.5f, 600, {64, 180, 500, 1600}},
    {30.0f, 250, {27, 76, 211, 675}},
};

static unsigned levels_at(float mic_gain_db)
{
    for (unsigned i = 0; i < sizeof(levels) / sizeof(levels[0]); i++)
        if (levels[i].gain_db == mic_gain_db)
            return i;
    return 0;
}

void voice_gate_feed(voice_gate_t *gate, const int16_t *pcm, size_t samples, unsigned rate, float mic_gain_db)
{
    if (gate->heard || !samples)
        return;
    uint32_t energy = 0;
    for (size_t i = 0; i < samples; i++) {
        int v = pcm[i];
        energy += (uint32_t)(v < 0 ? -v : v);
    }
    if (energy / samples > levels[levels_at(mic_gain_db)].loud)
        gate->loud_samples += (uint32_t)samples;
    else
        gate->loud_samples = 0;
    if (gate->loud_samples >= rate * 320 / 1000)
        gate->heard = true;
}

unsigned voice_level_feed(voice_level_t *meter, const int16_t *pcm, size_t samples, float mic_gain_db)
{
    if (!samples) return 0;
    int lo = pcm[0], hi = pcm[0];
    for (size_t i = 1; i < samples; i++) {
        if (pcm[i] < lo) lo = pcm[i];
        if (pcm[i] > hi) hi = pcm[i];
    }
    // Peak-to-peak rejects DC offsets; release smoothing survives the slower visual sampling.
    uint32_t span = (uint32_t)(hi - lo);
    meter->envelope = meter->envelope * 31 / 32;
    if (span > meter->envelope) meter->envelope = span;
    // The level is the number of steps the envelope has reached.
    const uint32_t *steps = levels[levels_at(mic_gain_db)].steps;
    unsigned level = 0;
    while (level < 4 && meter->envelope >= steps[level])
        level++;
    return level;
}
