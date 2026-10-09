#pragma once
#include "terminal.h"

/*
 * The pets on the Focus agent screen (pets.c, scripts/gen_pets.py): per engine, four loops of 24 steps,
 * each step a de-duplicated frame and a vertical offset in px, advanced every step_ms[state].
 */
typedef enum { HT_PET_IDLE, HT_PET_WORKING, HT_PET_DONE, HT_PET_ASKING, HT_PET_STATES } ht_pet_state_t;
typedef struct { uint8_t frame; int8_t dy; } ht_pet_step_t;
enum { HT_PET_STEPS = 24 };   // the loops' room; a pet's own length is ht_pet_steps()

/*
 * A large scene a pet can play in place of its small self (Claude, Codex, Muse): `loop` indexes `frames` (cell
 * sprites, w x h px), one step per step_ms. The working, sending and relaxing scenes' loop is [step]; the listening
 * scene's is [level 0..HT_PET_SCENE_LEVELS - 1][step].
 *
 * A scene may carry an OVERLAY (Codex: the sandbox bubble, the equalizer bubble, the paper plane): a second,
 * small sprite drawn after the scene's own, its `loop` and `at` indexed exactly like the scene's loop (level *
 * steps + step), `at` = where its frame sits, x then y in px from the scene's top-left. An overlay frame is
 * transparent where it leaves the scene as drawn, and a 1 x 1 transparent one stands for "nothing now".
 * `dx`, `dy` move the scene from the home position focus.c centres it at (0 for Claude's, which is
 * centred); the Codex art is placed as the mockup's canvas places it.
 */
enum { HT_PET_SCENE_LEVELS = 5 };
typedef struct {
    const ht_cell_frame_t *frames;
    const uint8_t *loop;
    const int16_t (*at)[2];
} ht_pet_overlay_t;
/*
 * Bars drawn in code over a scene, instead of stored frames (Codex's listening bubble: three bars that follow the
 * mic level). Bar j is a rounded box `w` px wide, x[j] px from the scene's top-left, centred on `cy`, height
 * h + 1 with h = round(min_h + swing * a * level / (HT_PET_SCENE_LEVELS - 1)), a = (sin(2 pi t / period_ms +
 * j * phase) + 1) / 2, t the scene clock; flat at min_h on level 0. Fills are native RGB565 (as ht_rgb() returns, for ht_box), not the palettes' panel order.
 */
typedef struct {
    int16_t x[3], cy;
    uint8_t w, radius, min_h, swing;
    uint16_t fill[3];
    uint16_t period_ms;
    float phase;
} ht_pet_bars_t;
/*
 * Sound waves drawn in code beside a scene (Muse's listening scene): `count` arcs on each side of a centre, `half_deg`
 * either side of 0 and 180 degrees (3 and 9 o'clock), `width` px thick, in `rgb`. Positions are sixteenths of a px
 * from the scene's top-left, like the overlay's `at`. Arc k travels from r_far to r_near and back in `period_ms`:
 * with u = (t / period + k / count) mod 1 its radius is r_far - (r_far - r_near) u and its brightness
 * sin(pi u) * (0.4 + 0.6 * level / (HT_PET_SCENE_LEVELS - 1)); below 0.12 it is not drawn (focus.c).
 */
typedef struct {
    int16_t cx16, cy16;
    uint16_t r_far16, r_near16, w16;
    uint8_t half_deg, count;
    uint8_t rgb[3];
    uint16_t period_ms;
    int16_t gap16;   // each side's arcs centred this far out from the centre (Claude's cups); 0 = one centre (Muse)
} ht_pet_waves_t;
/*
 * Shapes drawn in code over a scene, a few per step, instead of stored props (the relaxing scenes: Claude's three
 * juggling balls, Muse's beach ball; mockup/relaxing.html "For the firmware", mockup/muse-play.html D). Step s draws `count` ring arcs
 * (ht_ring_arc), shape k at at[s * count + k]: its centre in sixteenths of a px from the scene's top-left (like the
 * waves'), the band `w16` wide around radius `r16`, over mid_deg +- half_deg (anticlockwise from 3 o'clock; a disc is
 * half_deg 180 with the band reaching the centre), in `rgb` (native RGB565, as ht_rgb() returns). w16 0 is an empty
 * slot at that centre, so every step emits the same `count` runs (focus.c).
 */
typedef struct {
    int16_t cx16, cy16;
    uint16_t r16, w16;
    int16_t mid_deg;
    uint8_t half_deg;
    uint16_t rgb;
} ht_pet_shape_t;
typedef struct {
    uint8_t count;
    const ht_pet_shape_t *at;                    // [steps][count]
} ht_pet_shapes_t;
typedef struct {
    uint16_t w, h;
    const ht_cell_frame_t *frames;
    const uint8_t *loop;
    uint8_t steps;
    uint16_t step_ms;
    const ht_pet_overlay_t *overlay;             // NULL: none (zero when left out of the initializer)
    int16_t dx, dy;
    const ht_pet_bars_t *bars;                   // NULL: none (only Codex's listening scene)
    const ht_pet_waves_t *waves;                 // NULL: none (Muse's and Claude's listening scenes)
    const int8_t *step_dy;                       // per (level, step) like `loop`: the frame's offset in px, down; NULL = 0
                                                 // (Claude: a hop or a nod moves one stored pose instead of storing more)
    const int16_t (*count_at)[2];                // an alert's: per step, the centre of the bubble's count slot from the
                                                 // working scene's origin, {0,0} = no count yet; NULL for other scenes
    const ht_pet_shapes_t *shapes;               // NULL: none (the relaxing scenes of Claude and Muse)
} ht_pet_scene_t;

typedef struct {
    const char *engine;                          // focus.c ENGINES name: "claude", "codex"
    uint16_t w, h;                               // the 1x size (the cells are drawn at 2x: focus.c zooms them)
    const ht_icon_t *frames;                     // RGB565 + alpha8 frames; NULL when `cells` holds them
    const ht_pet_step_t (*loops)[HT_PET_STEPS];  // [HT_PET_STATES][HT_PET_STEPS]
    const uint16_t *step_ms;                     // [HT_PET_STATES]
    const ht_pet_scene_t *working_scene;         // NULL: the small pet and the centred working line
    const ht_pet_scene_t *listening_scene;       // NULL: the voice screen's meter
    const ht_pet_scene_t *sending_scene;         // NULL: the voice screen's three sparkles
    const ht_cell_frame_t *cells;                // the small pet as cell frames drawn at 2x, shown with ht_cell_sprite_zoom at
                                                 // 1x (w x h), 1.5x, 1.75x or 2x; `frames` is NULL then (every pet now)
    const ht_pet_scene_t *alert_scene;           // played once over the working scene when a notice arrives while it
                                                 // works, its last step held until read (gen_pets.py THE ALERT); its
                                                 // overlay is the bubble
    uint8_t steps;                               // the loops' length, <= HT_PET_STEPS; 0 = HT_PET_STEPS (Muse's is 18)
    const ht_pet_scene_t *relaxing_scene;        // NULL: today's resting face (the small pet and the resting line); else
                                                 // the resting face is laid out like the working one, this scene in the
                                                 // middle and a quiet line on the lower arc (focus.c THE RELAXING FACE)
} ht_pet_t;
// A pet's loop length.
static inline unsigned ht_pet_steps(const ht_pet_t *pet) { return pet->steps ? pet->steps : HT_PET_STEPS; }
extern const ht_pet_t ht_pets[];
extern const unsigned ht_pet_count;
