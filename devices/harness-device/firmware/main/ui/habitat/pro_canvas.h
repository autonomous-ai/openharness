#pragma once
#include "terminal.h"

typedef struct { uint32_t offset; uint8_t width, advance; } ht_pro_glyph_t;
struct ht_pro_font {
    uint16_t first, last;
    uint8_t height;
    uint16_t glyph_count; // includes the Vietnamese entries after Latin-1
    const ht_pro_glyph_t *glyphs;
    const uint8_t *alpha;
};
extern const ht_pro_font_t ht_pro_24, ht_pro_32, ht_pro_42, ht_pro_56;
// Extra atlas entries follow Latin-1: the 90 Vietnamese precomposed letters,
// then the 12 letters outside that block. Keep in sync with generate_fonts.py.
static inline int ht_pro_vietnamese_index(uint32_t cp)
{
    if (cp < 256) return -1;
    if (cp >= 0x1ea0 && cp <= 0x1ef9) return (int)(cp - 0x1ea0);
    static const uint16_t extra[] = {0x102,0x103,0x110,0x111,0x128,0x129,
                                   0x168,0x169,0x1a0,0x1a1,0x1af,0x1b0};
    for (unsigned i = 0; i < sizeof extra / sizeof extra[0]; i++)
        if (cp == extra[i]) return 90 + (int)i;
    return -1;
}
int ht_pro_width(const ht_pro_font_t *font, const char *text);
int ht_pro_text_rows(const char *text, const ht_pro_font_t *font, int width);
bool ht_pro_text(ht_scene_t *s, int x, int y, int width, const ht_pro_font_t *font,
                 uint16_t ink, const char *text);
int ht_pro_wrap(ht_scene_t *s, int x, int y, int width, int rows, int skip,
                const ht_pro_font_t *font, uint16_t ink, const char *text);
void ht_pro_center(ht_scene_t *s, int y, const ht_pro_font_t *font, uint16_t ink, const char *text);
bool ht_pro_rect(ht_scene_t *s, int x, int y, int w, int h, int radius, uint16_t ink);
bool ht_pro_image(ht_scene_t *s, int x, int y, const ht_pro_bitmap_t *bitmap);
bool ht_pro_image_faded(ht_scene_t *s, int x, int y, const ht_pro_bitmap_t *bitmap, unsigned opacity);   // opacity 1..254 of 255
void ht_pro_raster(const ht_run_t *run, ht_rect_t clip, uint16_t *out);
