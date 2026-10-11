#pragma once
#include <stdbool.h>
#include <stdint.h>

/* Debounce the switch and quarantine an electrically noisy input. A noisy
 * pin must never stop desktop turns or qualify as a five-second power hold. */
typedef struct {
    uint32_t changed_at, window_at;
    unsigned edges;
    bool initialized, raw_down, down, noisy;
} pro_button_filter_t;

static inline bool pro_button_sample(pro_button_filter_t *s, bool down, uint32_t now)
{
    if (!s->initialized) {
        s->initialized = true;
        s->raw_down = down;
        s->changed_at = s->window_at = now;
    }
    if ((uint32_t)(now - s->window_at) >= 1000) {
        s->window_at = now;
        s->edges = 0;
    }
    if (down != s->raw_down) {
        s->raw_down = down;
        s->changed_at = now;
        if (++s->edges >= 8) s->noisy = true;
    }
    if (s->noisy) {
        s->down = false;
        if (!down && (uint32_t)(now - s->changed_at) >= 1000) {
            s->noisy = false;
            s->edges = 0;
            s->window_at = now;
        }
    } else if ((uint32_t)(now - s->changed_at) >= 80) {
        s->down = down;
    }
    return s->down;
}
