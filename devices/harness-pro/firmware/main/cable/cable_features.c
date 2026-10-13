#include "cable_features.h"
#include "cJSON.h"
#include <string.h>

uint32_t cable_features_parse(const cJSON *welcome)
{
    const cJSON *features = cJSON_GetObjectItemCaseSensitive(welcome, "features");
    if (!cJSON_IsArray(features)) return 0;
    uint32_t result = 0;
    const cJSON *item;
    unsigned count = 0;
    cJSON_ArrayForEach(item, features) {
        if (++count > 16 || !cJSON_IsString(item)) return 0;
        if (!strcmp(item->valuestring, "player.library")) result |= CABLE_FEATURE_PLAYER_LIBRARY;
    }
    return result;
}
