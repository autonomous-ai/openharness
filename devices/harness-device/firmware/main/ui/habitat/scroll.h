#pragma once
#include <stdbool.h>
#include <stdint.h>

// No allocation or I/O. The caller queues reports on the same worker as focus changes.
typedef enum { HT_SCROLL_DOWN, HT_SCROLL_MOVE, HT_SCROLL_UP } ht_scroll_phase_t;
typedef bool (*ht_scroll_emit_t)(ht_scroll_phase_t phase, int dy, int velocity, void *ctx);
typedef struct {
    int sx, sy, y, pending, velocity, sign;
    uint32_t at;
    unsigned axis; // 0 undecided, 1 vertical, 2 horizontal
    bool live;
    ht_scroll_emit_t emit;
    void *ctx;
} ht_scroll_t;
void ht_scroll_begin(ht_scroll_t *g, int x, int y, uint32_t now, bool reversed,
                     ht_scroll_emit_t emit, void *ctx);
void ht_scroll_move(ht_scroll_t *g, int x, int y, uint32_t now);
// True means vertical travel owns the gesture, even if it ended back at its starting point.
bool ht_scroll_end(ht_scroll_t *g, int x, int y, uint32_t now);
void ht_scroll_cancel(ht_scroll_t *g);
// Conservative tap-to-brake window for the desktop's 0.002/second decay and 40px/s stop.
uint32_t ht_scroll_coast_ms(int velocity);
