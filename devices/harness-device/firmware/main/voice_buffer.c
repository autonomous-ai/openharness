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
void voice_gate_feed(voice_gate_t *gate, const int16_t *pcm, size_t samples, unsigned rate)
{
    if (gate->heard || !samples)
        return;
    uint32_t energy = 0;
    for (size_t i = 0; i < samples; i++) {
        int v = pcm[i];
        energy += (uint32_t)(v < 0 ? -v : v);
    }
    if (energy / samples > 600)
        gate->loud_samples += (uint32_t)samples;
    else
        gate->loud_samples = 0;
    if (gate->loud_samples >= rate * 320 / 1000)
        gate->heard = true;
}

unsigned voice_level_feed(voice_level_t *meter, const int16_t *pcm, size_t samples)
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
    uint32_t value = meter->envelope;
    return value < 64 ? 0 : value < 180 ? 1 : value < 500 ? 2 : value < 1600 ? 3 : 4;
}
