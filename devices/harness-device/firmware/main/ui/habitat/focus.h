#pragma once
#include "character_layout.h"
#include "character_types.h"

/*
 * Focus: the work, and the dial's only character. It takes the whole face through the `face` pointer in
 * character.c's one-row registry.
 */
void ht_focus_face(ht_scene_t *s, const ht_character_face_t *f, uint8_t frame, uint16_t ink,
                   const char *recap);

/*
 * Whether the agent on the next ht_focus_face() takes voice (caps hold V). Without it the resting face picks only the
 * lines that teach the dial, none that invite talking. A setting rather than a face field: only Focus reads it.
 */
void ht_focus_set_voice(bool can_talk);

/* One frame, no motion. The home face's only motion is the engine's pet, which runs on clock_ms, not on
 * these frames; the other thing that animates is the compositor's own shimmer. */
bool ht_focus_motion_tick(ht_character_motion_t *m, uint32_t now, ht_character_mood_t mood,
                          bool quiet, bool visible, bool down, int x, unsigned level,
                          uint32_t activity);

// The engine's index into ht_icon_engine20 (the LVGL firmware's own marks), or -1.
int ht_focus_engine_index(const char *engine);

/*
 * The clock_ms value (f->clock_ms's clock) at which the pet's visible frame or hop next differs
 * from what this face draws, or 0 when no pet is drawn, it holds still, or its loop never changes.
 * `recap` is the same text ht_focus_face() gets. The caller redraws then.
 */
uint32_t ht_focus_pet_next_ms(const ht_character_face_t *f, const char *recap);

/*
 * Which working scene a pet with two plays (pets.h ht_pet_t.working_alt): drawn at random, once, each time the working
 * scene starts showing for `agent` (it did not on the last call, or the face was another agent's), and kept for as long
 * as it shows — never a change mid-turn or between frames. Sets f->working_alt; call it on every home render before
 * drawing the face. `rnd` is esp_random on the device, a fixed source in the host tests.
 */
typedef struct { char agent[64]; bool shown, alt; } ht_focus_working_pick_t;
void ht_focus_pick_working(ht_focus_working_pick_t *p, ht_character_face_t *f, const char *recap, const char *agent,
                           uint32_t (*rnd)(void));

// True when the pet's notice bubble shows (focus.c THE ALERT): the working scene with an unread notice; ui_habitat.c
// then draws no bell pill. `at` (may be NULL) gets the bubble's box on the glass, empty before it pops in. And how
// long that bubble takes to pop in (ms): a second notice rings it without popping.
bool ht_focus_alert_shown(const ht_character_face_t *f, const char *recap, ht_rect_t *at);
uint32_t ht_focus_alert_pop_ms(const ht_character_face_t *f);
