// The strip turn (max_turn.h) on the ESP32-P4's pixel-processing accelerator: its scale-rotate-mirror engine at scale 1,
// rotating by MAX_TURN_CCW_DEGREES, pixel for pixel what max_turn_pixels writes. The bench (bench/) checks that on the
// chip and times both.
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

// Registers the turn's PPA client, once.
esp_err_t max_turn_ppa_open(void);

// max_turn_pixels(src, w, h, dst) on the PPA, returning when dst holds the turn. `dst` is DMA-capable, aligned to the
// cache line, and `dst_bytes` long, a whole number of cache lines. On an error dst holds nothing usable.
esp_err_t max_turn_ppa(const uint16_t *src, int w, int h, uint16_t *dst, size_t dst_bytes);
