#pragma once
#include "character_types.h"
// Compatibility names for existing Tim snapshots and benchmark APIs.
typedef ht_character_mood_t ht_tim_mood_t;
typedef ht_character_pose_t ht_tim_pose_t;
typedef ht_character_reaction_t ht_tim_motion_t;
typedef ht_character_face_t ht_tim_face_t;
#define HT_TIM_CONTENT HT_CHARACTER_IDLE
#define HT_TIM_WORKING HT_CHARACTER_WORKING
#define HT_TIM_ATTENTION HT_CHARACTER_ATTENTION
#define HT_TIM_DONE HT_CHARACTER_DONE
#define HT_TIM_OFFLINE HT_CHARACTER_OFFLINE
#define HT_TIM_ASLEEP HT_CHARACTER_ASLEEP
#define HT_TIM_BOOPED HT_CHARACTER_BOOPED
#define HT_TIM_LISTENING HT_CHARACTER_LISTENING
// Sparse blink deadlines and finite event reactions. No heap, animation thread or hidden-screen work.
bool ht_tim_motion_tick(ht_tim_motion_t *m, uint32_t now, ht_tim_mood_t mood,
                        bool quiet, bool visible, bool down, int x, unsigned level, uint32_t activity);
void ht_tim_portrait(ht_scene_t *scene, int y, ht_tim_mood_t mood, uint16_t ink);
void ht_tim_face(ht_scene_t *scene, const ht_tim_face_t *face);
