// The device's capability heaps on Linux (esp/esp.c): one heap, malloc's. The free-size queries answer 0: Linux has no
// fixed internal RAM or PSRAM to report.
#pragma once

#include <stddef.h>
#include <stdint.h>

#define MALLOC_CAP_DMA (1 << 3)
#define MALLOC_CAP_8BIT (1 << 2)
#define MALLOC_CAP_SPIRAM (1 << 10)
#define MALLOC_CAP_INTERNAL (1 << 11)

void *heap_caps_malloc(size_t size, uint32_t caps);
// `alignment` a power of two, as the device's.
void *heap_caps_aligned_alloc(size_t alignment, size_t size, uint32_t caps);
void heap_caps_free(void *ptr);
size_t heap_caps_get_free_size(uint32_t caps);
size_t heap_caps_get_minimum_free_size(uint32_t caps);
size_t heap_caps_get_largest_free_block(uint32_t caps);
