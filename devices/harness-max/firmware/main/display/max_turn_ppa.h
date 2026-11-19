// The strip turn (max_turn.h) on the ESP32-P4's pixel-processing accelerator: its scale-rotate-mirror engine at scale 1,
// rotating by MAX_TURN_CCW_DEGREES, pixel for pixel what max_turn_pixels writes. The bench (bench/) checks that on the
// chip and times both.
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

// One PPA client a task that turns strips (max_strips.h's workers), each with room for two turns queued.
#define MAX_TURN_PPA_LANES 2

// Registers the lanes' PPA clients, once.
esp_err_t max_turn_ppa_open(void);

// The turn of `src` (w x h, rows packed) into the block at (x, y) of the portrait picture `pic` (pic_w x pic_h RGB565,
// pic_bytes long), on `lane`'s client. With `landed`, queued: returns at once, and `landed` is given (from the PPA's
// interrupt) when the pixels are in `pic`; `src` must stay as it is until then. Without, it returns when they are.
// `pic` is DMA-capable, aligned to the cache line and a whole number of lines long; the CPU keeps no line of it.
esp_err_t max_turn_ppa_into(int lane, const uint16_t *src, int w, int h, uint16_t *pic, int pic_w, int pic_h,
                            size_t pic_bytes, int x, int y, SemaphoreHandle_t landed);

// The queued turns (max_turn_ppa_into with `landed`) of every lane that have not landed yet.
int max_turn_ppa_queued(void);

// Starts a queued turn the driver left waiting on an idle PPA. ESP-IDF 5.5's driver frees the PPA when its interrupt
// finds no turn queued behind the one that landed; a turn queued from the other core between that look and the freeing
// finds the PPA still taken and waits in the queue for the next turn to land, which, if none is queued after it, never
// comes. The kick is such a next turn: a few pixels, on a client of its own, into a buffer nobody reads. Queued, never
// waited for; ESP_OK when the PPA took it.
esp_err_t max_turn_ppa_kick(void);

// max_turn_pixels(src, w, h, dst) on the PPA (lane 0), returning when dst holds the turn: dst is the h x w picture.
// On an error dst holds nothing usable.
esp_err_t max_turn_ppa(const uint16_t *src, int w, int h, uint16_t *dst, size_t dst_bytes);
