#pragma once
#include <stdint.h>

typedef struct cJSON cJSON;
// The Pro reads two welcome features: the player library (the daemon answers `player.library.get`) and `resync`.
enum {
    CABLE_FEATURE_PLAYER_LIBRARY = 1u << 0,
    CABLE_FEATURE_RESYNC = 1u << 1,   // the daemon answers `resync` with a full snapshot (older ones do not know it)
};

// Optional welcome field. Older daemons omit it; unknown names are ignored. More than 16 entries, or an
// entry that is not a string, makes the whole result 0.
uint32_t cable_features_parse(const cJSON *welcome);
