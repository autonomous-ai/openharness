// Real Focus scene transitions: rastering only ht_damage()'s rectangles onto the previous frame must give exactly
// a full raster of the new frame. Scenes come from ht_character_face(), the call the board makes, over recaps,
// moods, engines (every pet), activity lines and animation clocks.
#include "../main/ui/habitat/character.h"
#include "../main/ui/habitat/pets.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static uint16_t frame[HT_WIDTH * HT_HEIGHT], full[HT_WIDTH * HT_HEIGHT], scratch[HT_WIDTH * HT_HEIGHT];
static uint32_t seed = 0xf0c05;
static unsigned next(void) { seed = seed * 1664525u + 1013904223u; return seed >> 8; }

int main(void)
{
    static const char *recaps[] = {"", "Done.", "Shipped the retry queue and the webhook tests.",
        ("Flashed 0.0.91 to both dials and verified the image on each. All 44 host checks pass, "
         "including the new reader tests. Nothing is committed yet."),
        ("Flashed 0.0.91 to both dials and verified the image on each. All 44 host checks pass, "
         "including the new reader tests. Nothing is committed yet; say commit and I will push it."),
        "Caf\xc3\xa9 \xe2\x80\x94 \xe2\x80\x9cready\xe2\x80\x9d: 1/3 checks pass."};
    static const char *names[] = {"Payments refactor", "M2", "A pane with a rather long name that must be cut", "Parser helper"};
    static const char *acts[] = {"", "Working", "Coalescing", "Reading files"};
    ht_character_t c = {0};
    assert(ht_character_select(&c, HT_CHARACTER_FOCUS));
    assert(ht_pet_count > 0);
    unsigned changed = 0, transitions = 0;
    ht_scene_t a, b;
    ht_scene_clear(&a, 0);
    ht_raster(&a, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, frame);
    for (unsigned n = 0; n < 600; n++) {
        const char *engine = next() % 8 ? ht_pets[next() % ht_pet_count].engine : (next() % 2 ? "" : "unknown-engine");
        unsigned mood = next() % 4;
        ht_character_face_t f = {.recipient = names[next() % 4], .engine = engine, .activity = acts[next() % 4],
            .elapsed = next() % 90, .status = "", .foreground = 0xffff,
            .mood = mood == 0 ? HT_CHARACTER_DONE : HT_CHARACTER_IDLE, .asking = mood == 1,
            .clock_ms = next() % 20000 + 1};
        const char *recap = recaps[next() % 6];
        ht_scene_clear(&b, 0);
        ht_character_face(&b, &c, &f, 0xffff, recap);

        ht_damage_t d; ht_damage(&a, &b, &d);
        assert(d.count <= HT_DAMAGE_MAX);
        for (unsigned i = 0; i < d.count; i++) {
            ht_rect_t r = d.rect[i];
            assert(r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 && r.x + r.w <= HT_WIDTH && r.y + r.h <= HT_HEIGHT);
            assert(!((r.x | r.y | r.w | r.h) & 1));
            ht_raster(&b, r, scratch);
            for (int y = 0; y < r.h; y++) memcpy(frame + (r.y + y) * HT_WIDTH + r.x, scratch + y * r.w, r.w * sizeof *frame);
        }
        ht_raster(&b, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, full);
        assert(!memcmp(frame, full, sizeof frame));
        if (d.count) changed++;
        transitions++;
        a = b;
    }
    assert(transitions >= 200 && changed > transitions / 2);
    printf("Damage on Focus faces: %u real scene transitions (%u redrew something) rebuild the full frame from ht_damage() alone PASS\n",
           transitions, changed);
}
