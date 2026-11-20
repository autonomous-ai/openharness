#pragma once
#include <stdint.h>

typedef struct cJSON cJSON;
// The Pro reads four welcome features: the player library (the daemon answers `player.library.get`), `resync`,
// `apps.switch` and `question.tier`.
enum {
    CABLE_FEATURE_PLAYER_LIBRARY = 1u << 0,
    CABLE_FEATURE_RESYNC = 1u << 1,   // the daemon answers `resync` with a full snapshot (older ones do not know it)
    CABLE_FEATURE_APPS_SWITCH = 1u << 2,     // the daemon lists the window's apps and takes an `app.pick` (older ones ignore it)
    CABLE_FEATURE_QUESTION_TIER = 1u << 3,   // a re-told question comes as `tier: "list"`; without it every one is an alert
};

// Optional welcome field. Older daemons omit it; unknown names are ignored. More than 16 entries, or an
// entry that is not a string, makes the whole result 0.
uint32_t cable_features_parse(const cJSON *welcome);
