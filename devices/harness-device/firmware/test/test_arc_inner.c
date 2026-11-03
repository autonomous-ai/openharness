// The inner upper arc (design 2026-10-28-round-dial-swarm-chat §3): the chat name under the project on a Swarm face,
// smaller and on a tighter curve than the title. Long, short and missing names; its span and radius; its mask cache,
// made only when a chat name is drawn; and the title arc it sits under, unchanged by it.
#include "../main/ui/habitat/terminal.c"
#include "../main/ui/habitat/focus_faces.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>

static const ht_arc_face_t chat_face = {.prop = &ht_lv_inter_20, .mid = 12};
static uint16_t px[HT_WIDTH * HT_HEIGHT], other[HT_WIDTH * HT_HEIGHT];

static void raster(const ht_scene_t *scene, uint16_t *out) { ht_raster(scene, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, out); }
// The rows and columns the label inked, as the panel shows them.
static ht_rect_t inked(const uint16_t *a, uint16_t ground)
{
    int x0 = HT_WIDTH, y0 = HT_HEIGHT, x1 = -1, y1 = -1;
    for (int y = 0; y < HT_HEIGHT; y++) for (int x = 0; x < HT_WIDTH; x++)
        if (a[y * HT_WIDTH + x] != ground) { x0 = imin(x0, x); x1 = imax(x1, x); y0 = imin(y0, y); y1 = imax(y1, y); }
    return x1 < 0 ? (ht_rect_t){0} : (ht_rect_t){x0, y0, x1 - x0 + 1, y1 - y0 + 1};
}

static void missing_names(void)
{
    ht_scene_t scene; ht_scene_clear(&scene, ht_rgb(0));
    ht_arc_inner_face(&scene, ht_rgb(0xada6ad), NULL, &chat_face);
    ht_arc_inner_face(&scene, ht_rgb(0xada6ad), "", &chat_face);
    assert(scene.count == 0);
    // A mono face has no place on the inner curve: nothing is drawn rather than a misplaced label.
    ht_arc_inner_face(&scene, ht_rgb(0xada6ad), "PM", &ht_arc_geist);
    assert(scene.count == 0);
    assert(!ht_arc_inner_cache_made());   // nothing drawn, nothing allocated
    puts("inner arc: no name, an empty name or a mono face draws nothing and allocates nothing PASS");
}

static void short_name(void)
{
    ht_scene_t scene; ht_scene_clear(&scene, ht_rgb(0));
    ht_arc_inner_face(&scene, ht_rgb(0xada6ad), "PM", &chat_face);
    assert(scene.count == 1 && scene.runs[0].arc == 3 && !strcmp(scene.runs[0].text, "PM"));
    assert(!ht_arc_inner_cache_made());   // laid out, not yet drawn
    raster(&scene, px);
    assert(ht_arc_inner_cache_made());
    ht_rect_t ink = inked(px, ht_rgb(0));
    // Centred under 12 o'clock, its caps' middle on the inner curve: well inside the title's 205 px curve.
    assert(ink.w > 0 && abs(ink.x + ink.w / 2 - 233) <= 2);
    int middle = ink.y + ink.h / 2;
    assert(abs((233 - middle) - ARC_PROP_INNER) <= 6);
    assert(233 - ink.y < ARC_PROP_RADIUS - 8);
    puts("inner arc: a short name is centred at 12 o'clock on the inner curve, its cache made on first draw PASS");
}

static void long_name(void)
{
    ht_scene_t scene; ht_scene_clear(&scene, ht_rgb(0));
    ht_arc_inner_face(&scene, ht_rgb(0xada6ad), "Fix the login redirect loop on Safari and Chrome", &chat_face);
    const ht_run_t *r = &scene.runs[0];
    assert(scene.count == 1 && r->arc == 3);
    // Cut to the inner span at a word, ending in "…", as every arc label is (the title's rule, owner 2026-10-03).
    assert(!strcmp(r->text, "Fix the login\xe2\x80\xa6"));
    assert(arc_prop_width16(chat_face.prop, r->text) <= ARC_INNER_SPAN16);
    // One long word has no word to end at: it is cut by letters, still inside the span.
    ht_scene_clear(&scene, ht_rgb(0));
    ht_arc_inner_face(&scene, ht_rgb(0xada6ad), "Internationalisationsprojektgruppe", &chat_face);
    size_t n = strlen(scene.runs[0].text);
    assert(n > 3 && !strcmp(scene.runs[0].text + n - 3, "\xe2\x80\xa6") && !strncmp(scene.runs[0].text, "Internation", 11));
    assert(arc_prop_width16(chat_face.prop, scene.runs[0].text) <= ARC_INNER_SPAN16);
    ht_scene_clear(&scene, ht_rgb(0));
    ht_arc_inner_face(&scene, ht_rgb(0xada6ad), "Fix the login redirect loop on Safari and Chrome", &chat_face);
    r = &scene.runs[0];
    raster(&scene, px);
    ht_rect_t ink = inked(px, ht_rgb(0));
    // The ends stay clear of the pet below: no ink lower than the gap above it.
    assert(ink.y + ink.h <= 92);
    // A 48-byte name of Vietnamese capitals, the tallest marks: whatever is let through fits the mask and draws.
    ht_scene_clear(&scene, ht_rgb(0));
    ht_arc_inner_face(&scene, ht_rgb(0xada6ad), "\xe1\xba\xa4\xe1\xba\xa6\xe1\xba\xa8\xe1\xba\xaa\xe1\xba\xac\xe1\xba\xae\xe1\xba\xb0\xe1\xba\xb2\xe1\xba\xb4\xe1\xba\xb6\xe1\xba\xa4\xe1\xba\xa6\xe1\xba\xa8\xe1\xba\xaa\xe1\xba\xac\xe1\xba\xae", &chat_face);
    arc_span_t spans[HT_ARC_HEIGHT][2];
    assert(scene.count == 1 && arc_prop_geometry(&scene.runs[0], chat_face.prop, spans) <= ARC_MASK_BYTES);
    raster(&scene, px);
    assert(inked(px, ht_rgb(0)).w > 0);
    puts("inner arc: a long name is cut to the inner span with an ellipsis, clear of the pet; the hardest marks fit the mask PASS");
}

static void title_unchanged(void)
{
    // The title alone, then the title with a chat name under it: every title pixel outside the chat's ink is the same.
    ht_scene_t a, b;
    ht_scene_clear(&a, ht_rgb(0)); ht_scene_clear(&b, ht_rgb(0));
    ht_arc_title_face(&a, ht_rgb(0xeaeaf0), "Round dial firmware release", &ht_arc_inter_prop);
    ht_arc_title_face(&b, ht_rgb(0xeaeaf0), "Round dial firmware release", &ht_arc_inter_prop);
    ht_arc_inner_face(&b, ht_rgb(0xada6ad), "Fix login", &chat_face);
    assert(a.runs[0].arc == 1 && b.runs[0].arc == 1 && b.runs[1].arc == 3);
    assert(!memcmp(&a.runs[0], &b.runs[0], sizeof a.runs[0]));
    raster(&a, px); raster(&b, other);
    ht_scene_t chat; ht_scene_clear(&chat, ht_rgb(0));
    ht_arc_inner_face(&chat, ht_rgb(0xada6ad), "Fix login", &chat_face);
    static uint16_t alone[HT_WIDTH * HT_HEIGHT];
    raster(&chat, alone);
    int same = 0, changed = 0;
    for (int i = 0; i < HT_WIDTH * HT_HEIGHT; i++) {
        if (alone[i] != ht_rgb(0)) continue;   // the chat's own ink
        assert(px[i] == other[i]);
        same++;
    }
    for (int i = 0; i < HT_WIDTH * HT_HEIGHT; i++) changed += px[i] != other[i];
    assert(same > 0 && changed > 0);
    // Drawn again, the title's cached mask is not rebuilt for the chat name: each arc keeps its own cache.
    uint32_t builds = ht_arc_cache_builds();
    raster(&b, other);
    assert(ht_arc_cache_builds() == builds);
    puts("inner arc: the title above it is laid out and drawn exactly as alone, and both masks stay cached PASS");
}

int main(void)
{
    missing_names();
    short_name();
    long_name();
    title_unchanged();
    return 0;
}
