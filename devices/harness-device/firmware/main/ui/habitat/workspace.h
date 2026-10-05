#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef enum { HT_WORKSPACE_IDLE, HT_WORKSPACE_WAIT_TAB, HT_WORKSPACE_REFRESH,
               HT_WORKSPACE_WAIT_SNAPSHOT, HT_WORKSPACE_READY } ht_workspace_phase_t;
typedef struct {
    bool touching, moved, cancelled;
    int x, y, origin, choice, count;
    uint32_t began;
    char pending[64];
    uint32_t serial, deadline, floor;
    ht_workspace_phase_t phase;
} ht_workspace_t;

void ht_workspace_touch(ht_workspace_t *, int index, int count, int x, int y, uint32_t now);
bool ht_workspace_move(ht_workspace_t *, int x, int y, unsigned axis, uint32_t now);
// -1 means no navigation; the UI handles a stationary tap by opening its list.
int ht_workspace_release(ht_workspace_t *, int x, int y, unsigned axis, uint32_t now);
void ht_workspace_cancel_touch(ht_workspace_t *);
bool ht_workspace_request(ht_workspace_t *, const char *id, uint32_t now);
bool ht_workspace_selected(ht_workspace_t *, const char *id);
bool ht_workspace_refresh(ht_workspace_t *, uint32_t serial, uint32_t generation);
bool ht_workspace_applied(ht_workspace_t *, const char *id, uint32_t generation);
void ht_workspace_cancel_request(ht_workspace_t *);
bool ht_workspace_tick(ht_workspace_t *, uint32_t now);

// Thumb-driven tab pages. Position is in glass pixels; all easing is integer.
// The UI sends the centered tab as it changes, including during drag and settling.
// The return from end only identifies a settled tap; Done closes the picker.
enum { HT_TAB_PITCH = 228, HT_TAB_DRAG_GAIN = 2, HT_TAB_SETTLE_MS = 192 };
typedef struct {
    int count, position, from, target, origin, x, last_x, velocity;
    uint32_t began, sampled, animation_at;
    bool touching, moved, animating, braking;
} ht_tab_carousel_t;
void ht_tab_carousel_reset(ht_tab_carousel_t *, int count, int index);
int ht_tab_carousel_index(const ht_tab_carousel_t *);
void ht_tab_carousel_cancel(ht_tab_carousel_t *);
void ht_tab_carousel_begin(ht_tab_carousel_t *, int x, uint32_t now);
bool ht_tab_carousel_move(ht_tab_carousel_t *, int x, uint32_t now);
bool ht_tab_carousel_end(ht_tab_carousel_t *, int x, bool horizontal, uint32_t now);
bool ht_tab_carousel_tick(ht_tab_carousel_t *, uint32_t now);
