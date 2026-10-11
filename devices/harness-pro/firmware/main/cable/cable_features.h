#pragma once
#include <stdint.h>

typedef struct cJSON cJSON;
// The Pro reads one welcome feature: the player library (the daemon answers `player.library.get`).
enum {
    CABLE_FEATURE_PLAYER_LIBRARY = 1u << 0,
};

// Optional welcome field. Older daemons omit it; unknown names are ignored. More than 16 entries, or an
// entry that is not a string, makes the whole result 0.
uint32_t cable_features_parse(const cJSON *welcome);
