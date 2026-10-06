#pragma once
#include "terminal.h"

// Application state, shared by every character. Artwork never owns actions.
typedef enum {
    HT_CHARACTER_IDLE, HT_CHARACTER_WORKING, HT_CHARACTER_ATTENTION, HT_CHARACTER_DONE,
    HT_CHARACTER_OFFLINE, HT_CHARACTER_ASLEEP, HT_CHARACTER_BOOPED, HT_CHARACTER_LISTENING,
    HT_CHARACTER_MOODS
} ht_character_mood_t;
typedef struct { uint8_t stage, colour, mark; } ht_companion_style_t;
typedef struct {
    int8_t look;
    uint8_t hands, level, mail; // 0: no letter, 1: holding, 2: briefly lifting it.
    bool blink, pressed;
} ht_character_pose_t;
typedef struct {
    ht_character_pose_t pose;
    ht_character_mood_t mood;
    uint32_t next_blink, blink_until, reaction_at, reaction_until, release_until;
    uint32_t activity, sequence, next_ms, level_at;
    bool initialized, was_down;
} ht_character_reaction_t;
typedef struct {
    const char *recipient, *status, *hint, *detail;
    ht_companion_style_t companion_style;
    /*
     * Three facts a creature has no use for, and the Focus skin is built out of.
     *
     * `tab` is the pane this agent belongs to — it stands in for the repo name the old firmware drew,
     * which does not exist anywhere in the cable vocabulary. `engine` is on the wire and stored
     * (agent_t.engine) and until now was drawn nowhere. `elapsed` is SECONDS SINCE THIS DIAL HEARD
     * ABOUT THE TURN, not since the turn began: `turn.started` carries no timestamp, so the device
     * stamps its own clock. A turn that predates the attach reads from zero. 0 = do not draw it.
     *
     * `activity` is what the daemon scraped off the engine's spinner footer — a gerund like
     * "Coalescing", never a tool call. The creature skins fold it into `recipient` on a rotation,
     * because they have one text seat; a skin with two reads it here instead.
     */
    const char *tab, *engine, *activity;
    uint16_t elapsed;
    ht_character_mood_t mood;
    ht_character_pose_t pose;
    bool focus, carrying, footer_action, straight_title, unread, primary_title, roomy_reading, single_label;
    /*
     * This face is the VOICE screen, not the home one. The creature skins do not need to be told —
     * they draw the same companion on both and let its mood carry the difference — but a skin whose
     * voice screen is a waveform and nothing else cannot read that off `mood` alone: HT_CHARACTER_
     * WORKING means "an agent is busy" at home and "your words are on their way" here.
     */
    bool voice;
    /*
     * Focus only, for the engine pets: this agent has an open question, and the clock its loop reads.
     * clock_ms 0 holds the pet still (quiet motion, asleep display); ui_habitat.c never sends 0 otherwise.
     */
    bool asking;
    uint32_t clock_ms;
    // Focus only: the clock_ms at which the newest unread notice arrived (0 = none). While the working scene shows,
    // the pet's alert scene plays once from then (focus.c), and ui_habitat.c flies the dot up after it.
    uint32_t notice_ms;
    uint16_t ink, foreground, dim;
} ht_character_face_t;

typedef struct {
    uint16_t frames, duration;
    const uint16_t *ends;
} ht_character_animation_t;
typedef struct {
    ht_character_reaction_t reaction;
    uint32_t last_ms, next_ms;
    uint16_t phase;
    uint8_t frame, remainder, rate;
    bool initialized, running;
    const ht_character_animation_t *animation;
} ht_character_motion_t;

bool ht_character_reaction_tick(ht_character_reaction_t *m, uint32_t now, ht_character_mood_t mood,
                                bool quiet, bool visible, bool down, int x, unsigned level, uint32_t activity);
// One pause/resume, touch, microphone, quiet-mode and wrap-safe clock for all art.
bool ht_character_motion_step(ht_character_motion_t *m, const ht_character_animation_t *animation,
                              uint32_t now, ht_character_mood_t mood, bool quiet, bool visible,
                              bool down, int x, unsigned level, uint32_t activity, bool animate);
