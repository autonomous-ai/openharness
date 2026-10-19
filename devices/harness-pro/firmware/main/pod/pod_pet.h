#pragma once
// The pet player: the dial's scenes (focus.c scene_*), drawn by Pod in a square straight on the white glass (no ground).
#include "pets.h"
#include "pod_draw.h"

// WORK_ALT: the pet's second working scene (ht_pet_t.working_alt, Claude's builder), WORK for a pet without one. Which of
// the two an agent plays is drawn once as its turn starts (pod_agent_t.work_alt); ph_room_scene and ph_card_scene pick.
typedef enum { POD_SCENE_REST, POD_SCENE_WORK, POD_SCENE_ASK, POD_SCENE_RELAX, POD_SCENE_LISTEN, POD_SCENE_SEND,
               POD_SCENE_WORK_ALT } pod_scene_t;

// The engine's pet, or NULL when it has none (the player then shows its mark on a pale rounded box).
const ht_pet_t *pod_pet_for(const char *engine);
extern const ht_pet_t pod_codex_pet;   // the HD Codex (pets_codex.c, scripts/gen_pro_codex.py)
// The asking look: ASK plays pod_claude_ask (pets_ask.c, scripts/gen_pro_ask.py) for Claude and pod_codex_ask (pets_codex.c; it shares the send scene's
// frames) for Codex, the small pet's asking loop for the others. In the Agent room (zoom8 16) pod_ask_bubble, a "?" bubble, is drawn over the pet as one
// extra run: beside its head, popping in over 250 ms at each loop's start and bobbing 4 px once a loop. Cards, Inbox and Recap (zoom8 8) have none.
extern const ht_pet_scene_t pod_claude_ask, pod_codex_ask;
extern const ht_cell_frame_t pod_ask_bubble;
// Whether the engine has this scene of its own: REST and ASK need a pet; WORK, RELAX, LISTEN and SEND need the
// pet to carry that scene. pod_pet_draw falls back to REST for a scene the pet lacks.
bool pod_pet_has(const char *engine, pod_scene_t scene);
// The constant number of runs pod_pet_draw adds for this engine and scene .
unsigned pod_pet_runs(const char *engine, pod_scene_t scene);
// The scene centred in the side x side square at (x, y) on the glass, every run inside it. SEND plays once from
// started_ms and holds its last step.
// zoom8 is 8 (1x, the box as given) or 16 (2x). At 16 the box is the 2 * side square with the same centre as the
// 1x one, i.e. (x - side / 2, y - side / 2, 2 * side); the scene is placed and sized at 2x inside it (its runs are
// the same ones, every run inside that square). If the scene would not fit the 2x square at exactly 2x (a
// scene larger than side), it is drawn at the largest zoom <= 8 that fits that square. Any other zoom8 draws at 8.
void pod_pet_draw(ht_scene_t *s, int x, int y, int side, const char *engine, pod_scene_t scene,
                  uint32_t clock_ms, uint32_t started_ms, unsigned zoom8);
// Pets' draw, which pod_pet_draw is: steps shorter than the 66 ms beat last one beat (every step is drawn in turn instead of some being skipped
// when the screen redraws on the beat), and pod_pet_next_beat_ms is its pod_pet_next_step_ms. Below, the same on a
// ground that is ONE colour under the scene's main frame (everything drawn before it stays clear of it): a frame zoomed below 1x is then resampled
// once and kept (pod_cell_flat), the pixels unchanged. For the Notices faces and the recap's pet.
void pod_pet_draw_flat(ht_scene_t *s, int x, int y, int side, const char *engine, pod_scene_t scene,
                       uint32_t clock_ms, uint32_t started_ms, uint32_t ground_rgb, unsigned zoom8);
uint32_t pod_pet_next_beat_ms(const char *engine, pod_scene_t scene, uint32_t clock_ms, uint32_t started_ms);
// The same on a ground of ground_rgb (0xRRGGBB): the listening waves fade toward it instead of white.
void pod_pet_draw_on(ht_scene_t *s, int x, int y, int side, const char *engine, pod_scene_t scene,
                     uint32_t clock_ms, uint32_t started_ms, uint32_t ground_rgb, unsigned zoom8);
// The height in px of the ink block pod_pet_draw centres in its square (the scene's extent, or the small pet's ink), at the zoom it picks
// for this side and zoom8; 0 for an engine with no pet. The block's bottom (the pet's feet) is then at the square's centre + this / 2.
// How many times a scene's extent has been measured (a test hook): each (scene, level) the player asks for is measured once.
unsigned pod_pet_extent_scans(void);
int pod_pet_ink_h(const char *engine, pod_scene_t scene, int side, unsigned zoom8);
#define POD_PET_STEP_MS 33   // 1000 / 30: the frame rate of anything drawn in code from the clock
#define POD_PH_ANIM_MS 66    // Pets: the equaliser, the spinner and the working mark (about 15 fps; a new height every 66 ms)
// Milliseconds (>= 1) from clock_ms until what pod_pet_draw draws next changes, from the same step clock it draws by.
// POD_PET_STEP_MS when the scene moves every frame (bars or waves from the clock) or the engine has no pet.
uint32_t pod_pet_next_step_ms(const char *engine, pod_scene_t scene, uint32_t clock_ms, uint32_t started_ms);
// The engine's pre-rendered logo of exactly this size, or NULL (unknown engine or a size not in pod_logo_sizes).
const pod_logo_t *pod_logo_find(const char *engine, int size);
// The logo size every pet-less cover draws (POD_LOGO_COVER, whatever the side), centred.
int pod_logo_cover_size(int side);
// The logo at (x, y), size x size, as one 1:1 image run (no scaling, no byte swap). False when there is no such
// logo; nothing is added then. The chip draws POD_LOGO_CHIP; covers draw pod_logo_cover_size(side).
bool pod_logo_draw(ht_scene_t *s, int x, int y, int size, const char *engine);
bool pod_logo_draw_faded(ht_scene_t *s, int x, int y, int size, const char *engine, unsigned opacity);   // 1..254 of 255
// The mark for an engine that has none (an unknown engine, an agent the roster has not named): a rounded outline
// square with ">_" in it, on `ground` inside; at the 34 px minimum it fits the 36 px chip slot.
// POD_DEFAULT_MARK_RUNS runs.
enum { POD_DEFAULT_MARK_RUNS = 3, POD_DEFAULT_MARK_SIDE = 34 };
void pod_mark_default_big(ht_scene_t *s, int x, int y, int size, uint16_t ground);   // the same at any size (the update screen's)
