#include "cable_features.h"
#include "cJSON.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>

static unsigned allocations;
static void *allocate(size_t bytes) { allocations++; return malloc(bytes); }
static void check(const char *json, uint32_t expected)
{
    cJSON *welcome = cJSON_Parse(json);
    assert(welcome);
    unsigned before = allocations;
    assert(cable_features_parse(welcome) == expected);
    assert(allocations == before);
    cJSON_Delete(welcome);
}
int main(void)
{
    cJSON_Hooks hooks = {.malloc_fn=allocate, .free_fn=free};
    cJSON_InitHooks(&hooks);
    assert(!cable_features_parse(NULL));
    check("{}", 0);
    check("{\"features\":null}", 0);
    check("{\"features\":true}", 0);
    check("{\"features\":\"form\"}", 0);
    check("{\"features\":[]}", 0);
    check("{\"features\":[\"form\",\"form\",\"future\"]}", CABLE_FEATURE_FORM);
    check("{\"features\":[\"Form\",\"FORM\",\"form.2\"]}", 0);
    check("{\"features\":[\"form\",null]}", 0);
    check("{\"features\":[\"form\",{}]}", 0);
    check("{\"features\":[\"form\",[\"visit\"]]}", 0);
    check("{\"features\":[\"agents.refresh\"]}", CABLE_FEATURE_AGENTS_REFRESH);
    static const char *names[] = {"form", "selection", "visit", "voice.draft", "question.review", "agents.refresh"};
    for (unsigned mask=0; mask<64; mask++) {
        cJSON *root=cJSON_CreateObject(), *array=cJSON_AddArrayToObject(root,"features");
        assert(root && array);
        for (unsigned i=0;i<6;i++) if (mask & (1u<<i))
            assert(cJSON_AddItemToArray(array,cJSON_CreateString(names[i])));
        assert(cable_features_parse(root)==mask);
        cJSON_Delete(root);
    }
    cJSON *root=cJSON_CreateObject(), *array=cJSON_AddArrayToObject(root,"features");
    assert(root && array);
    for (int i=0;i<16;i++) assert(cJSON_AddItemToArray(array,cJSON_CreateString("form")));
    assert(cable_features_parse(root)==CABLE_FEATURE_FORM);
    assert(cJSON_AddItemToArray(array,cJSON_CreateString("form")));
    assert(cable_features_parse(root)==0);
    cJSON_Delete(root);
    puts("host features: PASS (legacy default, 64 combinations, unknown/type/size bounds, no allocations)");
}
