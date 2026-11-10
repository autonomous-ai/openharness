// Direct ASCII decoding must retain every pixel from the generic Unicode path,
// including clipping inside a cell, eviction, font/palette changes and fallback.
#include "../main/ui/habitat/terminal.h"
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
    const ht_font_t *fonts[] = {&ht_mono_16, &ht_mono_20, &ht_mono_24, &ht_mono_28, &ht_open_20, &ht_mono_20};
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
    puts("ASCII raster: 6000 clipped mixed scenes match the Unicode renderer");
}
