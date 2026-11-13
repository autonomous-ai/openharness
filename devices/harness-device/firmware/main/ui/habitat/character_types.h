#pragma once
#include "terminal.h"

// Application state. Artwork never owns actions.
typedef enum {
    HT_CHARACTER_IDLE, HT_CHARACTER_WORKING, HT_CHARACTER_ATTENTION, HT_CHARACTER_DONE,
    HT_CHARACTER_OFFLINE, HT_CHARACTER_ASLEEP, HT_CHARACTER_BOOPED, HT_CHARACTER_LISTENING,
    HT_CHARACTER_MOODS
} ht_character_mood_t;
typedef struct {
    int8_t look;
    uint8_t hands, level;
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
    const char *recipient, *status;
    /*
     * `engine` is on the wire and stored (agent_t.engine). `elapsed` is SECONDS SINCE THIS DIAL HEARD
     * ABOUT THE TURN, not since the turn began: `turn.started` carries no timestamp, so the device
     * stamps its own clock. A turn that predates the attach reads from zero. 0 = unknown, do not draw it (formatted by
     * fmt_elapsed, main/elapsed.h: "0:34", "1h 5m", ...).
     *
     * `activity` is what the daemon scraped off the engine's spinner footer — a gerund like
     * "Coalescing", never a tool call. The face has a row for it beside the name.
     */
    const char *engine, *activity;
    // The grey line under the name, on the inner arc: a Swarm face's chat under its project (Chat with PM's "PM", a
    // group's name), or in the machine view the app an agent runs in ("Orca"). NULL or "" for the Lead chat and
    // every other face.
    const char *chat;
    uint32_t elapsed;
    ht_character_mood_t mood;
    ht_character_pose_t pose;
    bool footer_action;
    /*
     * This face is the VOICE screen, not the home one. Its waveform cannot read that off `mood` alone:
     * HT_CHARACTER_WORKING means "an agent is busy" at home and "your words are on their way" here.
     */
    bool voice;
    /*
     * For the engine pets: this agent has an open question, and the clock its loop reads.
     * clock_ms 0 holds the pet still (quiet motion, asleep display); ui_habitat.c never sends 0 otherwise.
     */
    bool asking;
    uint32_t clock_ms;
    // The clock_ms at which the newest unread notice arrived (0 = none), and how many are unread. While the
    // working scene shows, the pet's alert bubble rings from then and stays, the count in it, until they are read.
    uint32_t notice_ms;
    uint16_t notices;
    // The working face plays the pet's second working scene (ht_pet_t.working_alt, Claude's builder) when
    // it has one. Drawn by ht_focus_pick_working as the scene starts showing, and kept while it shows.
    bool working_alt;
    uint16_t foreground;
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
