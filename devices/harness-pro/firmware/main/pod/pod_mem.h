#pragma once
// Where Pod's big scratch buffers live. On the device EXT_RAM_BSS_ATTR puts a static in PSRAM, which keeps tens of
// KB of internal RAM free; the host has one memory, so it is empty there.
#ifdef ESP_PLATFORM
#include "esp_attr.h"
#else
#define EXT_RAM_BSS_ATTR
#endif

// A heap block for text that lives a while (a Lead's cached recap): PSRAM on the device, malloc on the host. NULL when out of memory.
#include <stdlib.h>
#ifdef ESP_PLATFORM
#include "esp_heap_caps.h"
static inline void *pod_big_alloc(size_t n) {
    void *p = heap_caps_malloc(n, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    return p ? p : malloc(n);   // free() takes either
}
#else
extern int pod_big_alloc_fail;   // host tests only: while set, pod_big_alloc reports out of memory
static inline void *pod_big_alloc(size_t n) { return pod_big_alloc_fail ? NULL : malloc(n); }
#endif
