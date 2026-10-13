#pragma once
#include <stddef.h>

// Complete scroll JSON, including two signed 32-bit values and a terminator.
// Phase is the wire order down=0, move=1, up=2. No allocation or retained state.
#define CABLE_SCROLL_JSON_MAX 96
// Returns payload bytes (excluding NUL), or 0 with an empty output on failure.
size_t cable_scroll_encode(char *out, size_t capacity, int phase, int dy, int velocity);
