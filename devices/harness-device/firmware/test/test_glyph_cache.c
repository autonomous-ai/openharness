// Cached small-glyph rendering must be pixel-identical to the original path,
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
    ht_glyph_cache_enable(false); ht_raster(scene, clip, original + 1);
    ht_glyph_cache_enable(true); ht_raster(scene, clip, cached + 1);
    assert(!memcmp(cached, original, (end + 1) * sizeof *cached));
    assert(cached[0] == 0xabcd && cached[end] == 0xdcba);
}
int main(void)
{
    const ht_font_t *fonts[] = {&ht_mono_16, &ht_mono_20, &ht_mono_24, &ht_mono_28, &ht_open_20,
        &ht_mono_20};
    const unsigned nfonts = sizeof fonts / sizeof *fonts;
    char alphabet[128];
    for (int i = 0; i < 95; i++) alphabet[i] = i + 32;
    memcpy(alphabet + 95, "\xe2\x80\x94\xe2\x80\x9c\xf0\x9f\x90\x99", 11);
    ht_scene_t scene;
    for (unsigned i = 0; i < 6000; i++) {
        ht_scene_clear(&scene, next());
        for (unsigned row = 0, count = 1 + next() % 12; row < count; row++) {
            const ht_font_t *font = fonts[next() % nfonts];
            ht_text(&scene, (int)(next() % 120) - 40, (int)(next() % 130) - 25,
                1 + next() % 465, font, next(), next() % 2 ? scene.background : next(),
                alphabet + next() % 95);
        }
        ht_rect_t clip = {next() % 80, next() % 110, 1 + next() % 380, 1 + next() % 40};
        compare(&scene, clip);
    }
    puts("glyph cache: 6000 clipped mixed scenes match the original renderer");
}
