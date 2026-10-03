#include "cable_features.h"
#include "cJSON.h"
#include <string.h>

uint32_t cable_features_parse(const cJSON *welcome)
{
    const cJSON *features = cJSON_GetObjectItemCaseSensitive(welcome, "features");
    if (!cJSON_IsArray(features)) return 0;
    static const struct { const char *name; uint32_t bit; } names[] = {
        {"form", CABLE_FEATURE_FORM}, {"selection", CABLE_FEATURE_SELECTION},
        {"visit", CABLE_FEATURE_VISIT}, {"voice.draft", CABLE_FEATURE_DRAFT},
        {"question.review", CABLE_FEATURE_QUESTIONS},
        {"agents.refresh", CABLE_FEATURE_AGENTS_REFRESH},
        {"settings", CABLE_FEATURE_SETTINGS},
    };
    uint32_t result = 0;
    const cJSON *item;
    unsigned count = 0;
    cJSON_ArrayForEach(item, features) {
        if (++count > 16 || !cJSON_IsString(item)) return 0;
        for (unsigned i = 0; i < sizeof names / sizeof names[0]; i++)
            if (!strcmp(item->valuestring, names[i].name)) result |= names[i].bit;
    }
    return result;
}
