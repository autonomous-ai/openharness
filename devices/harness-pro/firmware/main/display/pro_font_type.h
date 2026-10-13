#pragma once
/* Pro text atlas types: all that the generated pro_fonts.c needs, with no dependency on the compositor.
 * pro_canvas.h includes this file. */
#include <stdint.h>

typedef struct { uint32_t offset; uint8_t width, advance; } ht_pro_glyph_t;
struct ht_pro_font {
    uint16_t first, last;
    uint8_t height;
    uint16_t glyph_count; // includes the Vietnamese entries after Latin-1
    const ht_pro_glyph_t *glyphs;
    const uint8_t *alpha;
};
typedef struct ht_pro_font ht_pro_font_t;

extern const ht_pro_font_t ht_pro_24, ht_pro_32, ht_pro_42, ht_pro_56;
