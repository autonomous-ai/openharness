#pragma once
#include <stdint.h>

typedef struct cJSON cJSON;
enum {
    CABLE_FEATURE_FORM = 1u << 0,
    CABLE_FEATURE_SELECTION = 1u << 1,
    CABLE_FEATURE_VISIT = 1u << 2,
    CABLE_FEATURE_DRAFT = 1u << 3,
    CABLE_FEATURE_QUESTIONS = 1u << 4,
    CABLE_FEATURE_AGENTS_REFRESH = 1u << 5,
    // The daemon will carry this device's preferences to the desktop app and send back changes. A
    // device that does not see it keeps its own settings screens; nothing here is load-bearing for a
    // session, so an older daemon simply never asks.
    CABLE_FEATURE_SETTINGS = 1u << 6,
};

// Optional welcome field. Older daemons omit it and retain the core voice,
// pane, tab, scroll, machine and model controls. Unknown names are ignored.
uint32_t cable_features_parse(const cJSON *welcome);
