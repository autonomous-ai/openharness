#pragma once
#include <stdbool.h>
#include <stdint.h>

// A tap is a completed contact, never a DOWN. Motion permanently owns a contact.
// Pure arithmetic; scrolling never waits for a tap window.
typedef enum { HT_TOUCH_NONE, HT_TOUCH_TAP, HT_TOUCH_HOLD } ht_touch_result_t;
typedef struct {
    int x, y;
    uint32_t began, guard_until;
    unsigned axis;
    bool live, moved, guarded, guard_valid;
} ht_gesture_t;
void ht_gesture_begin(ht_gesture_t *g, int x, int y, uint32_t now, uint32_t context);
void ht_gesture_move(ht_gesture_t *g, int x, int y);
ht_touch_result_t ht_gesture_end(ht_gesture_t *g, int x, int y, uint32_t now);
void ht_gesture_cancel(ht_gesture_t *g);
// A voice action consumes a rapid double/triple tap as one intent, across view transitions.
void ht_gesture_guard(ht_gesture_t *g, uint32_t now);
