#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdatomic.h>

// One producer, one consumer. Publish bytes only after copying; release space only after sending.
typedef struct {
    uint8_t *data;
    uint32_t capacity;
    atomic_uint head, tail;
} voice_buffer_t;
void voice_buffer_init(voice_buffer_t *b, uint8_t *storage, uint32_t capacity);
bool voice_buffer_write(voice_buffer_t *b, const uint8_t *data, size_t size);
size_t voice_buffer_peek(voice_buffer_t *b, const uint8_t **data, size_t limit);
void voice_buffer_consume(voice_buffer_t *b, size_t size);
uint32_t voice_buffer_used(voice_buffer_t *b);

typedef struct {
    uint32_t loud_samples;
    bool heard;
} voice_gate_t;
void voice_gate_feed(voice_gate_t *gate, const int16_t *pcm, size_t samples, unsigned rate);

// Visual mic envelope only. Never used to stop capture, gate speech or modify PCM.
typedef struct { uint32_t envelope; } voice_level_t;
unsigned voice_level_feed(voice_level_t *meter, const int16_t *pcm, size_t samples);
