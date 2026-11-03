#pragma once
#include <stdint.h>

typedef struct cJSON cJSON;
// The Pro reads three welcome features: the player library (the daemon answers `player.library.get`), `resync` and `swarm.remote`.
enum {
    CABLE_FEATURE_PLAYER_LIBRARY = 1u << 0,
    CABLE_FEATURE_RESYNC = 1u << 1,   // the daemon answers `resync` with a full snapshot (older ones do not know it)
    CABLE_FEATURE_SWARM_REMOTE = 1u << 2,   // the daemon routes a voice turn named with a Lead's Swarm id (a Lead on another machine, or its Buddy)
};

// Optional welcome field. Older daemons omit it; unknown names are ignored. More than 16 entries, or an
// entry that is not a string, makes the whole result 0.
uint32_t cable_features_parse(const cJSON *welcome);
