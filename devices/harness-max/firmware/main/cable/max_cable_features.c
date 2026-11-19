// The welcome's features as Harness Max reads them: the Pro's (cable_features_parse, compiled as it is) and the Max's
// own (cable/max_cable.h), from the same list by the same rule.
// pro_fork relies on: devices/harness-pro/firmware/main/cable/cable_features.c
// pro_fork blob: cf66638a6226b0da27d4874fa924d4e9463d8bc8 (main 91f60b6a7b)
// pro_fork relies on: devices/harness-pro/firmware/main/cable/cable_features.h
// pro_fork blob: 56d2a47237b75d9f5a38578b6878242b2218e34d (main 91f60b6a7b)
// scripts/check_pro_forks.py fails once either is no longer that blob: check that the rule below is still the Pro's and
// that the Pro's bits stay below the Max's, then record its new blob on these lines and in main/pro_fork/upstream.txt.
#include "cable/max_cable.h"

#include <string.h>

#include "cJSON.h"

_Static_assert((CABLE_FEATURE_PLAYER_LIBRARY | CABLE_FEATURE_RESYNC) < CABLE_FEATURE_FORM, "the Max's bits are the Pro's");

uint32_t max_cable_features_parse(const cJSON *welcome)
{
    const uint32_t pro = cable_features_parse(welcome);
    const cJSON *features = cJSON_GetObjectItemCaseSensitive(welcome, "features");
    if (!cJSON_IsArray(features)) return pro;
    uint32_t result = 0;
    const cJSON *item;
    unsigned count = 0;
    cJSON_ArrayForEach(item, features) {
        if (++count > 16 || !cJSON_IsString(item)) return 0;   // as the Pro's: then the list names none of them
        if (!strcmp(item->valuestring, "form")) result |= CABLE_FEATURE_FORM;
        if (!strcmp(item->valuestring, "question.review")) result |= CABLE_FEATURE_QUESTION_REVIEW;
        if (!strcmp(item->valuestring, "question.tier")) result |= CABLE_FEATURE_QUESTION_TIER;
    }
    return pro | result;
}
