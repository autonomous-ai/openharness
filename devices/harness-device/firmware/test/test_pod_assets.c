// Task 2: the pets and engine marks Pod copies from the dial.
#include <assert.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include "pod/pets.h"
#include "pod/pod_types.h"
#include "pod/pod_pet.h"

int main(void) {
    assert(ht_pet_count >= 3);
    const char *three[] = {"claude", "codex", "muse"};
    for (unsigned k = 0; k < 3; k++) {
        const ht_pet_t *p = NULL;
        for (unsigned i = 0; i < ht_pet_count; i++)
            if (!strcmp(ht_pets[i].engine, three[k])) p = &ht_pets[i];
        assert(p);
        assert(p->working_scene && p->listening_scene && p->sending_scene && p->relaxing_scene && p->cells);
    }
    assert(pod_mark("muse") && pod_logo_find("muse", 28) && pod_logo_find("muse", 28)->size == 28);
    assert(pod_mark("cursor") && pod_mark("cursor")->light);
    assert(pod_mark("claude") && !pod_mark("claude")->light);
    assert(pod_mark("nope") == NULL);
    assert(pod_mark_count == 14);
    // The light list: marks that vanish on the white glass and so sit on the dark chip / cover.
    static const char *const light[] = {"cursor", "devin", "opencode"};   // from the logo art; see scripts/pod_gen_logos.py
    for (unsigned i = 0; i < pod_mark_count; i++) {
        bool want = false;
        for (unsigned k = 0; k < sizeof light / sizeof *light; k++) want |= !strcmp(pod_marks[i].engine, light[k]);
        assert(pod_marks[i].light == want);
    }
    // Every size Pod draws a mark at exists for all 14 engines, with both arrays: the chip (28) and the one cover
    // size (72) for the cover sides the views use (Recap 132, Agent 270 and 230 asking, Talking 260).
    static const int cover_sides[] = {132, 270, 230, 260};
    for (unsigned i = 0; i < pod_mark_count; i++) {
        const char *e = pod_marks[i].engine;
        assert(pod_logo_find(e, POD_LOGO_CHIP) && pod_logo_find(e, POD_LOGO_CHIP)->px && pod_logo_find(e, POD_LOGO_CHIP)->a);
        for (unsigned k = 0; k < sizeof cover_sides / sizeof *cover_sides; k++) {
            int sz = pod_logo_cover_size(cover_sides[k]);
            const pod_logo_t *l = pod_logo_find(e, sz);
            assert(l && l->size == sz && l->px && l->a);
        }
        // any cover side gets a generated size: nothing is ever scaled at runtime
        for (int side = 40; side <= 720; side++) assert(pod_logo_find(e, pod_logo_cover_size(side)));
    }
    assert(pod_logo_find("cursor", 99) == NULL && pod_logo_find("nope", 28) == NULL && pod_logo_find(NULL, 28) == NULL);
    assert(pod_logo_cover_size(132) == 72 && pod_logo_cover_size(270) == 72 && pod_logo_cover_size(230) == 72 && pod_logo_cover_size(260) == 72 && POD_LOGO_NSIZES == 2);
    for (unsigned i = 0; i < pod_mark_count; i++) assert(strlen(pod_marks[i].engine) < 12);   // fits pod_agent_t.engine[12]
    puts("pod assets ok");
    return 0;
}
