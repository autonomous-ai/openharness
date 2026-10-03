#pragma once
// Standalone visual study. No cable, agent, audio, or allocation dependencies.
#include "terminal.h"

#define HT_ORIGINAL_CREATURES 10
#define HT_CREATURES 20
#define HT_GALLERY_START HT_ORIGINAL_CREATURES
#define HT_CREATURE_MOODS 4
#define HT_CREATURE_COLS 25
#define HT_CREATURE_ROWS 9

typedef struct {
    uint8_t creature, mood;
    bool down, moved, dirty, booped;
    int16_t start_x, start_y, last_x, last_y;
    uint32_t entered, touched, boop_until, tick;
} ht_gallery_t;

extern const ht_font_t ht_ascii_art_12, ht_ascii_art_14, ht_ascii_art_16, ht_ascii_art_20;
extern const ht_font_t ht_ascii_art_28, ht_ascii_art_48;
extern const ht_font_t ht_block_art_16, ht_block_art_square_10;
const char *ht_gallery_name(unsigned creature);
const char *ht_gallery_mood(unsigned mood);
void ht_gallery_init(ht_gallery_t *g, uint32_t now);
void ht_gallery_touch(ht_gallery_t *g, bool down, int x, int y, uint32_t now);
// Drop the current contact. The touch driver suppresses its remaining samples/UP.
void ht_gallery_cancel(ht_gallery_t *g);
void ht_gallery_tick(ht_gallery_t *g, uint32_t now);
uint32_t ht_gallery_wake(const ht_gallery_t *g, uint32_t now);
bool ht_gallery_take(ht_gallery_t *g, ht_scene_t *scene, uint32_t now);
void ht_gallery_render(const ht_gallery_t *g, ht_scene_t *scene, uint32_t now);
