#pragma once
/* Pro text atlas types: all that the generated pro_fonts.c needs, with no dependency on the compositor.
 * pro_canvas.h includes this file. */
#include <stdint.h>

// rows == 0: the mask is the font's full height. Otherwise it holds only `rows` rows, starting `top` rows down
// the cell (the Pets faces; the rows above and below are empty).
typedef struct { uint32_t offset; uint8_t width, advance, top, rows; } ht_pro_glyph_t;
struct ht_pro_font {
    uint16_t first, last;
    uint16_t height;      // the cell's height (ph_num_230's is 317)
    uint16_t glyph_count; // includes the Vietnamese entries after Latin-1
    const ht_pro_glyph_t *glyphs;
    const uint8_t *alpha;
    // The code points baked after the Vietnamese entries, in glyph order (gen_fonts.py: CONSOLE_EXTRA);
    // NULL/0 on a face without any. The face draws exactly these marks natively.
    const uint16_t *extras;
    uint8_t extra_count;
};
typedef struct ht_pro_font ht_pro_font_t;

extern const ht_pro_font_t ht_pro_24, ht_pro_32, ht_pro_42, ht_pro_56;
// Pets: Inter SemiBold / Medium / Regular and JetBrains Mono Medium, always from fonts/ (see scripts/gen_fonts.py).
extern const ht_pro_font_t ph_sb_48, ph_sb_34, ph_sb_26, ph_sb_22, ph_rg_24,
                           ph_mono_26, ph_mono_18, ph_sb_32, ph_rg_36, ph_mono_22, ph_rg_28,
                           ph_num_230,   // digits only
                           ph_bd_84;     // "Harness" only (the wordmark)
