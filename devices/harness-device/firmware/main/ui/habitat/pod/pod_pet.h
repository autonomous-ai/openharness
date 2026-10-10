#pragma once
// The pet player: the dial's scenes (focus.c scene_*), drawn by Pod in a square straight on the white glass (no ground).
#include "pets.h"
#include "pod_draw.h"

typedef enum { POD_SCENE_REST, POD_SCENE_WORK, POD_SCENE_ASK, POD_SCENE_RELAX, POD_SCENE_LISTEN, POD_SCENE_SEND } pod_scene_t;

// The engine's pet, or NULL when it has none (the player then shows its mark on a pale rounded box).
const ht_pet_t *pod_pet_for(const char *engine);
// Whether the engine has this scene of its own: REST and ASK need a pet; WORK, RELAX, LISTEN and SEND need the
// pet to carry that scene. pod_pet_draw falls back to REST for a scene the pet lacks.
bool pod_pet_has(const char *engine, pod_scene_t scene);
// The constant number of runs pod_pet_draw adds for this engine and scene .
unsigned pod_pet_runs(const char *engine, pod_scene_t scene);
// The scene centred in the side x side square at (x, y) on the glass, every run inside it. SEND plays once from
// started_ms and holds its last step.
void pod_pet_draw(ht_scene_t *s, int x, int y, int side, const char *engine, pod_scene_t scene,
                  uint32_t clock_ms, uint32_t started_ms);
// The engine's pre-rendered logo of exactly this size, or NULL (unknown engine or a size not in pod_logo_sizes).
const pod_logo_t *pod_logo_find(const char *engine, int size);
// The logo size every pet-less cover draws (POD_LOGO_COVER, whatever the side), centred.
int pod_logo_cover_size(int side);
// The logo at (x, y), size x size, as one 1:1 image run (no scaling, no byte swap). False when there is no such
// logo; nothing is added then. The chip draws POD_LOGO_CHIP; covers draw pod_logo_cover_size(side).
bool pod_logo_draw(ht_scene_t *s, int x, int y, int size, const char *engine);
bool pod_logo_draw_faded(ht_scene_t *s, int x, int y, int size, const char *engine, unsigned opacity);   // 1..254 of 255
// The mark for an engine that has none (an unknown engine, an agent the roster has not named): a 34 x 34 rounded
// outline square with ">_" in it (ht_pro_24 does not fit a 27 px one), on `ground` inside; it fits the 36 px chip slot.
// POD_DEFAULT_MARK_RUNS runs.
enum { POD_DEFAULT_MARK_RUNS = 3, POD_DEFAULT_MARK_SIDE = 34 };
void pod_mark_default(ht_scene_t *s, int x, int y, uint16_t ground);
