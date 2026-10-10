// Host-test stand-in for ESP-IDF's cJSON.h: cable_client.h includes it, but the pure Pod model only
// needs the cable_swarm_t / cable_tile_t shapes, never a cJSON call.
#pragma once
typedef struct cJSON cJSON;
