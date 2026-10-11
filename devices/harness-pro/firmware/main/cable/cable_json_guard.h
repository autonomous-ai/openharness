#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "cable_frame.h"

enum { CABLE_JSON_MAX = CABLE_MAX_PAYLOAD + 1, CABLE_JSON_DEPTH = 12,
       CABLE_JSON_TOKENS = 512 };

// Bound recursive JSON parsing before it reaches cJSON. The cable vocabulary
// uses at most a few object/array layers; the parser's default 1000-level limit
// cannot fit the device's 6 KiB reader stack. No allocation or recursion here.
// Lexical values/keys/containers also have a budget: a flat array must not
// spend the whole internal heap on cJSON nodes. No extra payload copy is needed.
// This checks framing/shape only; cJSON still validates the complete grammar.
bool cable_json_guard(const uint8_t *bytes, size_t length);
