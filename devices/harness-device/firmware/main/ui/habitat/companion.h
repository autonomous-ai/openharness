#pragma once
// The desktop's saved life, not a second collection. No NVS, network or timers.
#include "character.h"
struct cJSON;
#define HT_COMPANION_COLS 56
#define HT_COMPANION_ROWS 30
#define HT_COMPANION_FRAMES 8
#define HT_COMPANION_CELLS (HT_COMPANION_COLS * HT_COMPANION_ROWS)
// A ready egg's explicit hatch row sits between the voice surface and bell.
enum { HT_COMPANION_HATCH_TOP = 350, HT_COMPANION_HATCH_TEXT = 365,
       HT_COMPANION_HATCH_BOTTOM = 404 };
typedef struct {
    char key[160];
    uint32_t transfer;
    uint16_t palette[8], frame_ms;
    uint8_t count, received, cols, rows;
    bool loop, complete;
    char ink[HT_COMPANION_FRAMES][HT_COMPANION_CELLS];
    char mats[HT_COMPANION_FRAMES][HT_COMPANION_CELLS];
} ht_companion_clip_t;
typedef struct {
    bool managed, enabled, motion, transient, connected;
    char window[81], uid[65], name[25], emotion[17], reason[49];
    char egg_uid[65], action_id[49], action_error[65];
    bool pending;
    uint32_t action_deadline;
    char egg[25], stage[13], phase[10], art[160], reaction[257];
    uint64_t serial, revision;
    uint32_t epoch, began, expires, now;
    uint8_t active, frame, brightness;
    ht_companion_clip_t clips[2];
} ht_companion_t;
void ht_companion_reset(ht_companion_t *c);
void ht_companion_disconnect(ht_companion_t *c);
bool ht_companion_receive(ht_companion_t *c, const struct cJSON *message, uint32_t now);
bool ht_companion_tick(ht_companion_t *c, uint32_t now, bool quiet, bool visible);
// Wraps the existing layout; bell, recap, caption and voice targets stay intact.
void ht_companion_face(ht_scene_t *s, const ht_companion_t *c,
                       const ht_character_face_t *face, const char *recap);
void ht_companion_portrait(ht_scene_t *s, const ht_companion_t *c,
                           const ht_character_face_t *face,
                           ht_character_size_t size, int y);
