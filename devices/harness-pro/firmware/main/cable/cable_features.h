#pragma once
#include <stdint.h>

typedef struct cJSON cJSON;
// The welcome features the boards read: the player library (the daemon answers `player.library.get`), `resync`, and
// what the Max answers and starts agents with.
enum {
    CABLE_FEATURE_PLAYER_LIBRARY = 1u << 0,
    CABLE_FEATURE_RESYNC = 1u << 1,            // the daemon answers `resync` with a full snapshot (older ones do not know it)
    CABLE_FEATURE_FORM = 1u << 2,              // New Harness: `form` reaches the desktop's form
    CABLE_FEATURE_QUESTION_REVIEW = 1u << 3,   // `question.read` and `answer.reviewed`
};

// Optional welcome field. Older daemons omit it; unknown names are ignored. More than 16 entries, or an
// entry that is not a string, makes the whole result 0.
uint32_t cable_features_parse(const cJSON *welcome);
