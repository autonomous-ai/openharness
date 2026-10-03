// Direct ASCII decoding must retain every pixel from the generic Unicode path,
// including clipping inside a cell, eviction, font/palette changes and fallback.
#include "../main/ui/habitat/octopus.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static uint16_t cached[HT_WIDTH * HT_HEIGHT + 2], original[HT_WIDTH * HT_HEIGHT + 2];
static uint32_t seed = 0x4593082;
static unsigned next(void) { seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5; return seed; }
static void compare(const ht_scene_t *scene, ht_rect_t clip)
{
    size_t end = (size_t)clip.w * clip.h + 1;
    cached[0] = original[0] = 0xabcd; cached[end] = original[end] = 0xdcba;
    ht_raster_fast_ascii(false); ht_raster(scene, clip, original + 1);
    ht_raster_fast_ascii(true); ht_raster(scene, clip, cached + 1);
    assert(!memcmp(cached, original, (end + 1) * sizeof *cached));
    assert(cached[0] == 0xabcd && cached[end] == 0xdcba);
}
int main(void)
{
    const ht_font_t *fonts[] = {&ht_octopus_font_2, &ht_octopus_font_4,
        &ht_octopus_font_6, &ht_octopus_font_8, &ht_octopus_font_10, &ht_mono_20};
    char alphabet[128];
    for (int i = 0; i < 95; i++) alphabet[i] = i + 32;
    memcpy(alphabet + 95, "\xe2\x80\x94\xe2\x80\x9c\xf0\x9f\x90\x99", 11);
    ht_scene_t scene;
    // Control bytes, every Latin-1 byte and punctuation/arrow fallback stay identical.
    for (int cache = 0; cache < 2; cache++) {
        ht_glyph_cache_enable(cache != 0);
        for (int font = 0; font < 6; font++) for (unsigned byte = 1; byte < 256; byte++) {
            char value[] = {(char)byte, 'A', (char)0xe2, (char)0x86, (char)0x97, 0};
            ht_scene_clear(&scene, 0x7bef);
            ht_text(&scene, -7, -3, 132, fonts[font], 0xefff, 0x031f, value);
            compare(&scene, (ht_rect_t){0, 0, 150, 32});
        }
    }
    ht_glyph_cache_enable(true);
    for (unsigned i = 0; i < 6000; i++) {
        ht_scene_clear(&scene, next());
        for (unsigned row = 0, count = 1 + next() % 12; row < count; row++) {
            const ht_font_t *font = fonts[next() % 6];
            ht_text(&scene, (int)(next() % 120) - 40, (int)(next() % 130) - 25,
                1 + next() % 465, font, next(), next() % 2 ? scene.background : next(),
                alphabet + next() % 95);
        }
        ht_rect_t clip = {next() % 80, next() % 110, 1 + next() % 380, 1 + next() % 40};
        compare(&scene, clip);
    }
    ht_tim_face_t face = {.recipient = "Firmware", .status = "Coalescing",
        .mood = HT_TIM_WORKING, .foreground = 0xffff, .dim = 0x7777, .ink = 0xafe0};
    for (int layout = 0; layout < 4; layout++) {
        face.focus = layout == 1;
        const char *recap = layout == 2 ? "Fixed. All checks pass." : layout == 3 ?
            "The update is installed. Voice input now sends to the selected agent. The result stays in the center." : NULL;
        for (int frame = 0; frame < HT_OCTOPUS_FRAMES; frame++) {
            face.pose = (ht_tim_pose_t){.blink = frame % 7 == 0, .level = frame % 5};
            face.mood = (frame % 8);
            face.unread = frame % 3 == 0;
            ht_scene_clear(&scene, ht_rgb(0x080c08));
            ht_octopus_face(&scene, &face, frame, ht_rgb(0xc8a9f0), recap);
            compare(&scene, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT});
            uint32_t builds = ht_glyph_cache_builds();
            for (int y = 0; y < HT_HEIGHT; y += 24)
                compare(&scene, (ht_rect_t){0, y, HT_WIDTH, y + 24 > HT_HEIGHT ? HT_HEIGHT - y : 24});
            assert(ht_glyph_cache_builds() == builds); // full-to-strip reuse, no palette churn
        }
    }
    // The budget follows the widest atlas the face has: 24 slots of 5x10 on the dial, of 8x16 on the Pro.
#if HT_FACE_PX >= 720
    assert(ht_glyph_cache_bytes() <= 6400);
#else
    assert(ht_glyph_cache_bytes() <= 2600);
#endif
    puts("ASCII raster: 6000 clipped mixed scenes + 252 complete poses match the Unicode renderer; guards and warm reuse pass");
}
