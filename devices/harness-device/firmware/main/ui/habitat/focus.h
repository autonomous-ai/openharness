#pragma once
#include "character_layout.h"
#include "character_types.h"

/*
 * The Focus skin: the work, not a companion.
 *
 * Tim and Tux are portraits with words arranged around them, so ht_character_layout() owns the seats
 * and hands the artwork one rectangle. Focus has no artwork — the arrangement IS the skin — so it
 * takes the whole face through the `face` pointer in character.c's registry.
 */
void ht_focus_face(ht_scene_t *s, const ht_character_face_t *f, uint8_t frame, uint16_t ink,
                   const char *recap);

/*
 * The painter half of the registry row. Focus never draws a portrait, but ht_character_portrait()
 * calls `paint` directly and every registry entry must answer it; this draws the name alone, which is
 * the only sensible thing a portrait of "no companion" can be.
 */
void ht_focus_portrait(ht_scene_t *s, const ht_character_face_t *f, uint8_t frame, uint16_t ink,
                       ht_character_size_t size, int y);

/* One frame, no motion. The home face's only motion is the engine's pet, which runs on clock_ms, not on
 * these frames; the other thing that animates is the compositor's own shimmer. */
bool ht_focus_motion_tick(ht_character_motion_t *m, uint32_t now, ht_character_mood_t mood,
                          bool quiet, bool visible, bool down, int x, unsigned level,
                          uint32_t activity);

/*
 * The engine's badge: `out` gets its ht_engine glyph as UTF-8, `ink` its own colour as 0xRRGGBB, or 0
 * for "no colour of its own — draw it in the row's ink". False, and nothing written, for an engine
 * this build has no mark for; an unknown engine gets no badge rather than a wrong one.
 */
bool ht_focus_engine_mark(const char *engine, char out[4], uint32_t *ink);
// The engine's index into ht_icon_engine20 / ht_icon_engine28 (the LVGL firmware's own marks), or -1.
int ht_focus_engine_index(const char *engine);

/*
 * The clock_ms value (f->clock_ms's clock) at which the pet's visible frame or hop next differs
 * from what this face draws, or 0 when no pet is drawn, it holds still, or its loop never changes.
 * `recap` is the same text ht_focus_face() gets. The caller redraws then.
 */
uint32_t ht_focus_pet_next_ms(const ht_character_face_t *f, const char *recap);

// True when the face plays the pet's working scene; the bell pill is raised clear of its lower-arc status.
bool ht_focus_scene_shown(const ht_character_face_t *f, const char *recap);
