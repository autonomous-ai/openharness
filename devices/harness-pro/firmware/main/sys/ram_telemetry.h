#pragma once

#include <stddef.h>

// Install the global PSRAM-first cJSON allocator and initialize RAM counters.
// Call once at the very start of app_main(), before any cJSON use.
void ram_telemetry_init(void);

// Log internal 8-bit heap, PSRAM, cJSON fallback, and current-task stack
// high-water data. Safe at any point of boot.
void ram_telemetry_checkpoint(const char *tag);

// Periodic checkpoint. Every tenth call also records the known long-lived task
// stack high-water marks.
void ram_telemetry_periodic(const char *tag);

// A PSRAM-only application allocation. It never silently consumes internal RAM
// and records a failure in the telemetry counters.
void *ram_psram_alloc(size_t bytes, const char *owner);
