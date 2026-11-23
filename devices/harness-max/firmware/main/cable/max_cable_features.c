// The welcome's features as Harness Max reads them: the Pro's (cable_features_parse, compiled as it is; question.tier
// among them) and the Max's own (cable/max_cable.h), from the same list by the same rule.
// pro_fork relies on: devices/harness-pro/firmware/main/cable/cable_features.c
// pro_fork blob: f41b727ff4736546162f5aa45345a78adeec944b (main fc16e78f94)
// pro_fork relies on: devices/harness-pro/firmware/main/cable/cable_features.h
// pro_fork blob: 686d3f8507add485197e7d528c5d21ea5627edd4 (main fc16e78f94)
// scripts/check_pro_forks.py fails once either is no longer that blob: check that the rule below is still the Pro's and
// that the Pro's bits stay below the Max's, then record its new blob on these lines and in main/pro_fork/upstream.txt.
#include "cable/max_cable.h"

#include <string.h>

#include "cJSON.h"

_Static_assert((CABLE_FEATURE_PLAYER_LIBRARY | CABLE_FEATURE_RESYNC | CABLE_FEATURE_APPS_SWITCH | CABLE_FEATURE_QUESTION_TIER) <
                   CABLE_FEATURE_FORM,
               "the Max's bits are the Pro's");

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
    }
    return pro | result;
}
