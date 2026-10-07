#pragma once
// Allocation-free text compositor. No ESP-IDF, LVGL or floating point.
// Rasterization owns two bounded curved-text caches; call it from one renderer.
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
// THE FACE. One device, one size: the 466 round dial.
//
// This was a -D from the build for as long as there were two boards; it is a literal again now that the
// Pro has its own firmware. Kept as a named pair rather than 466 sprinkled through the compositor,
// because the arithmetic that reads it — chords, the rim annulus, the damage bands — is about a face
// and not about a number.
#define HT_WIDTH 466
#define HT_HEIGHT 466
#define HT_RUNS 40
#define HT_TEXT_BYTES 128
#define HT_DAMAGE_MAX 24
typedef struct {
    uint16_t first, last;
    uint8_t width, height;
    const uint8_t *pixels;
} ht_font_t;
// One glyph of a PROPORTIONAL face, exactly as lv_font_conv stored it: the ink box as a continuous
// 4-bit stream (high nibble first, no row padding), its advance in 1/16 px, where the box sits.
typedef struct {
    uint32_t offset;   // into the face's pixels, in bytes
    uint16_t adv;      // 1/16 px, before kerning
    uint8_t w, h;      // ink box
    int8_t ox, oy;     // ink box from the pen's x, and from the top of the line
} ht_glyph_t;
/*
 * A PROPORTIONAL FACE — the Focus skin's Inter (scripts/gen_focus_faces.py) and the two Montserrat icon
 * glyphs copied from the LVGL firmware (scripts/gen_lvgl_assets.py). It IS an ht_font_t, as its first member, so a run
 * carries it like any other font; `first > last` is what marks it, a range no fixed-cell atlas can
 * have. A separate type rather than fields appended to ht_font_t so every fixed-cell atlas keeps its
 * positional initializer. `base.width` is the space's advance and `base.height` the line; pass
 * `&face.base` wherever a font is wanted.
 */
typedef struct ht_pfont {
    ht_font_t base;
    const ht_glyph_t *glyphs;
    const uint16_t *codes;        // sorted; glyphs[i] draws codes[i]
    uint16_t count;
    uint8_t ascent;               // the baseline, from the top of the line (line - LVGL base_line)
    const uint8_t *kern_left, *kern_right;   // each glyph's kern class, 0 for none
    const int8_t *kern_values;    // [(left - 1) * kern_right_count + right - 1], 1/16 px
    uint8_t kern_right_count;
    const struct ht_pfont *fallback;   // for a codepoint this face does not have, or NULL
} ht_pfont_t;
static inline const ht_pfont_t *ht_pfont(const ht_font_t *f)
{
    return f && f->first > f->last ? (const ht_pfont_t *)f : NULL;
}
extern const ht_font_t ht_mono_16, ht_mono_20, ht_mono_24, ht_mono_28, ht_pixel_40;
// The Focus skin's icon faces (lvgl_fonts.c; see assets/lvgl/SPEC.md): Montserrat cut down to a space and one
// FontAwesome symbol each. Every word and number on Focus is Inter (focus_faces.h).
extern const ht_pfont_t ht_lv_montserrat_22, ht_lv_montserrat_14;
// FontAwesome in LVGL's Montserrat: the bell (montserrat_14) and the close cross (montserrat_22).
#define HT_LV_BELL  "\xef\x83\xb3"
#define HT_LV_CROSS "\xef\x80\x8d"
// A full-colour icon from the LVGL firmware (lvgl_icons.c): RGB565 in panel order plus alpha.
typedef struct { uint16_t w, h; const uint16_t *px; const uint8_t *a; } ht_icon_t;
// A CELL SPRITE (the pets' large scenes, scripts/gen_pets.py): cols x rows cells of `cell` px, one byte
// each — a palette index, 0 transparent — and the palette in RGB565 panel order, entry 0 unused.
// Packed when `row_at` is set (owner, 2026-10-06: transparent runs cost bytes): row r starts at cells + row_at[r]
// and is pairs of (transparent cells to skip, opaque cells that follow) bytes, each pair followed by those cells'
// indices, until the row's `cols` are covered. Unset, `cells` is the plain cols x rows grid.
typedef struct { uint8_t cols, rows, cell; const uint16_t *palette; const uint8_t *cells; const uint16_t *row_at; }
    ht_cell_frame_t;
// One cell of a frame, plain or packed (0 transparent).
uint8_t ht_cell_at(const ht_cell_frame_t *frame, int col, int row);
// The engines' marks in focus.c's ENGINES order: 20 px as the inbox drew them, and 27 px — LVGL's
// own 28/20 scaling of the same 20 px art, as the header drew it. And the microphone.
extern const ht_icon_t ht_icon_engine20[14], ht_icon_engine28[14], ht_icon_mic;
// The Focus face's 56 px marks (focus_marks.c, scripts/gen_focus_marks.py), in the same order.
extern const ht_icon_t ht_icon_engine56[14];
// Precomputed curved-label and larger inbox navigation glyphs.
extern const ht_font_t ht_open_20, ht_nav_32;
extern const ht_font_t ht_open_24, ht_right_24, ht_bell_24;
extern const uint8_t ht_mono_24_ink[224][4], ht_open_24_ink[1][4], ht_right_24_ink[1][4], ht_bell_24_ink[1][4];
extern const uint8_t ht_mono_20_ink[224][4], ht_open_20_ink[1][4];
extern const ht_font_t ht_right_20, ht_right_28, ht_open_28;
extern const uint8_t ht_right_20_ink[1][4];
// One authored outline bell in a normal terminal cell, not an emoji font.
#define HT_BELL "\xee\x80\x80"
#define HT_SPARK "\xee\x80\x82"
// One bar of the recording waveform, in sixteen heights — ht_wave's cell is ONE bar, not the whole
// meter, so the seven bars are seven runs placed at the old firmware's own 22.4 px pitch and each
// picks its own height. HT_WAVE_LEVELS - 1 is the tallest, 121 px, which is what bar four rested at.
#define HT_WAVE_FIRST  0xe010u
#define HT_WAVE_LEVELS 16
extern const ht_font_t ht_bell_20, ht_bell_28;
extern const ht_font_t ht_bell_footer, ht_done_28, ht_failed_28;
// The voice screen: one sparkle, and six bar heights that a row of nine draws a waveform with.
extern const ht_font_t ht_spark, ht_wave;
// One badge per engine, from U+E020 in the order focus.c lists them. 24 px in a 38 px cell, so a
// mark sits beside a name in ht_mono_28 without being squeezed into a letter's width.
extern const ht_font_t ht_engine;
#define HT_ENGINE_FIRST 0xe020u
#define HT_DONE "\xe2\x9c\x93"
#define HT_FAILED "\xe2\x9c\x97"
extern const uint8_t ht_bell_20_ink[1][4];
// The lock's dot is the only 40 px glyph used by the daily UI. Keep its exact
// pixels without retaining the other 94 glyphs of the gallery font in flash.
extern const ht_font_t ht_lock_dot;
// Vietnamese, one atlas per mono size. ht_font_t carries a single contiguous range and a dense
// 32..0x1EF9 would be 7,898 cells, so these cover 0x1EA0..0x1EF9 plus an eight-cell tail holding
// the letters that live outside it (A-breve, D-stroke, O-horn, U-horn and their lowercase).
// Same fixed cell as the mono face they stand in for; terminal.c routes them in glyph_font().
extern const ht_font_t ht_viet_16, ht_viet_20, ht_viet_24, ht_viet_28;
typedef struct {
    int16_t x, y, w, h;
} ht_rect_t;
typedef struct {
    const uint16_t *pixels;
    const uint8_t *alpha;
    const void *asset;
    uint32_t revision;
    uint16_t width, height;
    uint8_t species, colour, mark;
    // Blend as LVGL's lv_color_24_16_mix does — (src * a + dst * (255 - a)) >> 8 per 565 channel —
    // for the icons taken from the LVGL firmware, so they come out as that dial drew them.
    bool lvgl;
    // A cell sprite instead of pixels (ht_cell_sprite): width x height px of `cell`-px squares.
    const uint8_t *cells;
    const uint16_t *palette;
    const uint16_t *row_at;   // packed cells (ht_cell_frame_t), NULL plain
    uint8_t cell;
    // A cell sprite drawn smaller (ht_cell_sprite_zoom): width x height is the frame's src_w x src_h px times zoom / 8,
    // each pixel the area-weighted mean of the frame pixels it covers, over black. 0 = drawn at its own size.
    uint8_t zoom;
    uint16_t src_w, src_h;
} ht_sprite_t;
typedef struct {
    int16_t x, y, w;
    uint8_t arc; // 0 = straight, 1 = upper arc, 2 = lower arc
    uint8_t shimmer; // 0 = steady ink, 1..21 = cached-mask highlight sweep
    uint16_t fg, bg;
    const ht_font_t *font;
    char text[HT_TEXT_BYTES];
    // Optional immutable RGB565 foreground per text cell (straight runs only).
    // At least as many entries as text cells; storage outlives both scenes.
    const uint16_t *colors;
    ht_sprite_t sprite;
    // A ROUNDED BOX rather than text when `box.h` is set: w x h at x, y, corner radius, fill and an
    // optional 1 px border (border == fill for none), antialiased at the corners. ht_box() makes one.
    struct { uint16_t h, fill, border; uint8_t radius; } box;
    // A proportional arc label's tight bounds, set once by ht_arc_*_face (`ink` 1) from its text and
    // place, so equal runs hold equal bounds; ht_run_bounds returns them.
    uint8_t ink;
    ht_rect_t ink_box;
    // A proportional arc label's per-glyph brightness (ht_arc_status_sweep): `gained` set means glyph i of
    // the text is drawn at gain[i] / 255 of its coverage, a glyph past HT_ARC_GAINS at full.
    uint8_t gained;
    uint8_t gain[16];
    uint8_t arc_mid;   // a proportional arc label's face's `mid`, copied by ht_arc_*_face (0 = the default)
    // A RING ARC rather than text when `ring.set`: a band `w16` wide around radius `r16` from the centre
    // (cx16, cy16), over the angles mid +- half, in sixteenths of a pixel; (ux, uy) is the unit vector of mid
    // and `cosh` the cosine of half, all Q14 (y up). `w16` 0 draws nothing. ht_ring_arc() makes one.
    struct { uint8_t set; uint16_t colour, r16, w16; int16_t cx16, cy16, ux, uy, cosh; } ring;
} ht_run_t;
typedef struct {
    uint16_t background;
    uint8_t count;
    ht_run_t runs[HT_RUNS];
} ht_scene_t;
enum { HT_ARC_COLS = 26, HT_ARC_CELL_WIDTH = 15, HT_ARC_CELL_HEIGHT = 32, HT_ARC_X = 25, HT_ARC_Y = 12,
       HT_ARC_WIDTH = 416, HT_ARC_HEIGHT = 128 };
typedef struct {
    uint8_t count;
    ht_rect_t rect[HT_DAMAGE_MAX];
    uint32_t pixels;
} ht_damage_t;
uint16_t ht_rgb(unsigned rgb);
void ht_scene_clear(ht_scene_t *scene, uint16_t background);
bool ht_text(ht_scene_t *scene, int x, int y, int width, const ht_font_t *font, uint16_t fg,
             uint16_t bg, const char *text);
// Prevalidated printable ASCII assets: exactly `cells` readable bytes, one cell
// each. Copies into the scene; no UTF-8 scan, allocation, or retained pointer.
bool ht_ascii_text(ht_scene_t *scene, int x, int y, int width, const ht_font_t *font,
                   uint16_t fg, uint16_t bg, const char *text, size_t cells);
void ht_center(ht_scene_t *scene, int y, const ht_font_t *font, uint16_t fg, const char *text);
// One icon, as a sprite run at x, y.
bool ht_icon(ht_scene_t *scene, int x, int y, const ht_icon_t *icon);
// A cell sprite (ht_cell_frame_t) as one run; its frame pointer is what ht_damage compares.
bool ht_cell_sprite(ht_scene_t *scene, int x, int y, const ht_cell_frame_t *frame);
// The frame at zoom / 8 of its size (1..8; 8 = ht_cell_sprite), box-filtered so one picture drawn large reads sharp at
// every smaller size (the pets: one 2x drawing shown at 1x, 1.5x, 1.75x and 2x). Edges darken toward the black ground,
// as the art's own anti-aliasing does; a pixel less than a quarter covered is left as it was.
bool ht_cell_sprite_zoom(ht_scene_t *scene, int x, int y, const ht_cell_frame_t *frame, unsigned zoom);
// A rounded box — the Focus skin's pills and cards. Colours are already mixed over what they sit on.
bool ht_box(ht_scene_t *scene, int x, int y, int w, int h, int radius, uint16_t fill, uint16_t border);
// A RING ARC — a piece of a circle's band, drawn in one colour (already mixed over the ground), anti-aliased
// across the band, hard at its two ends. The centre, radius and width are in sixteenths of a pixel; the span
// is `mid_deg` +- `half_deg` whole degrees, counted anticlockwise from 3 o'clock (0 = right, 180 = left).
// `width16` 0 makes an empty placeholder (nothing drawn, no bounds) that keeps the run's slot: its place
// (the centre) never depends on the radius, so a ring that comes and goes does not reshape the damage.
bool ht_ring_arc(ht_scene_t *scene, int cx16, int cy16, int radius16, int width16, int mid_deg, int half_deg,
                 uint16_t colour);
// PROPORTIONAL TEXT. The width `text` would take in `font` (mono: glyphs x width). A line of it that
// fits `width` px, breaking after a word where it can (the cursor moves past the spaces it ends on).
// And `text` fitted to `width`: whole if it fits, else as much as does and "…"; returns its width.
int ht_measure(const ht_font_t *font, const char *text);
/*
 * An LVGL label, laid out the way LVGL 9.5 lays one out: its word wrap, centre alignment and
 * LV_LABEL_LONG_DOT. `width` is the label's, `lines` how many it shows; with `dots` a text that needs
 * more ends in "..." on the last of them. Returns how many lines the text needed before any cut.
 * Line n is text + line[n].at for line[n].len bytes, drawn at x + line[n].x.
 */
enum { HT_LV_LINES = 5 };
typedef struct { uint16_t at, len; int16_t x, w; } ht_lv_line_t;
typedef struct { char text[320]; ht_lv_line_t line[HT_LV_LINES]; int lines, w; } ht_lv_label_t;
int ht_lv_label(ht_lv_label_t *label, const ht_font_t *font, const char *text, int width, int lines,
                bool dots);
int ht_fit_width(char *dst, size_t cap, const char *text, int width, const ht_font_t *font);
// Fixed 24 px upper/lower arcs. Text stays in the scene; each mask is cached on
// first rasterization and reused across strips, animation and color changes.
// An arc face: the 24 px mono atlas and its ink bounds, the Vietnamese atlas, and the three icon
// atlases (with ink) glyph_font() substitutes for U+2197, U+2192 and U+E000. A curved run stores
// the face's mono atlas as its font, so the mask cache and the damage diff tell faces apart.
typedef struct {
    const ht_font_t *mono, *viet, *open, *right, *bell;
    const uint8_t (*ink)[4], (*open_ink)[4], (*right_ink)[4], (*bell_ink)[4];
    // A PROPORTIONAL arc face (NULL for the mono faces above, which are then all unused): the label is laid
    // out by advance and kerning in 1/16 px and each glyph stands upright at its own place on the curve.
    // The curved run's font is this face's base, as it is the mono atlas for the other faces.
    const ht_pfont_t *prop;
    // A proportional face's mid-caps offset above the baseline on the curve, px; 0 = terminal.c's
    // ARC_PROP_MID. Inter's taller stacked marks need it larger (focus_faces.c).
    uint8_t mid;
    // A proportional label too long for the span ends at a word with no "…" (the Focus name: owner,
    // 2026-10-03); false keeps the "…".
    bool bare;
} ht_arc_face_t;
extern const ht_arc_face_t ht_arc_geist;
// Inter Medium 26 on the same arcs (focus_faces.c, which holds the face): ht_arc_inter_prop is the Focus
// name on the upper arc; ht_arc_inter_lower the lower-arc status and the Listening sweep.
extern const ht_arc_face_t ht_arc_inter_prop, ht_arc_inter_lower;
// The arc length a proportional label may span, in px: the 26 cells the mono arcs allow.
enum { HT_ARC_SPAN = HT_ARC_COLS * HT_ARC_CELL_WIDTH };
void ht_arc_title(ht_scene_t *scene, uint16_t fg, const char *text);
void ht_arc_title_face(ht_scene_t *scene, uint16_t fg, const char *text, const ht_arc_face_t *face);
// The lower arc, in GeistMono (the non-Focus skins); ht_arc_status_face takes any face, like ht_arc_title_face.
void ht_arc_status(ht_scene_t *scene, uint16_t fg, const char *text);
void ht_arc_status_face(ht_scene_t *scene, uint16_t fg, const char *text, const ht_arc_face_t *face);
// What `text` takes of the arc in `face`, in px of arc length (a proportional face rounds up; fits when
// <= HT_ARC_SPAN). A proportional title or status longer than that ends at a word and "…" (no "…"
// for a `bare` face).
int ht_arc_measure(const ht_arc_face_t *face, const char *text);
// The lower arc with a brightness per glyph (the voice screen's "Listening" sweep): `gain` is
// HT_ARC_GAINS entries, 0..255 for each glyph of `text` in order (the glyph's coverage scales by it; the
// ground is black, so that is the dimmed colour), NULL = all 255, which is exactly ht_arc_status_face.
// Proportional faces only. One run, as ht_arc_status_face; the mask cache is keyed by the gains too.
enum { HT_ARC_GAINS = 16 };
void ht_arc_status_sweep(ht_scene_t *scene, uint16_t fg, const char *text, const ht_arc_face_t *face,
                         const uint8_t *gain);
// Same conservative bounds used for damage; useful for matching curved hit areas.
ht_rect_t ht_run_bounds(const ht_run_t *run);
uint32_t ht_arc_cache_builds(void);
// A 1.28-second sweep and 0.768-second rest. Pure, wrap-safe integer clock.
uint8_t ht_shimmer_phase(uint32_t now);
uint32_t ht_shimmer_wake_ms(uint32_t now);
#ifdef DEVICE_LAYOUT_BENCH
void ht_arc_fast_sampling(bool enabled);
void ht_arc_tight_bounds(bool enabled);
void ht_damage_fast_ascii(bool enabled);
void ht_damage_banded(bool enabled);
void ht_raster_fast_ascii(bool enabled);
#endif
// Bounded small-ASCII cache. Toggle only from the renderer, for A/B profiling.
void ht_glyph_cache_enable(bool enabled);
uint32_t ht_glyph_cache_builds(void);
size_t ht_glyph_cache_bytes(void);
// Consume one word-wrapped UTF-8 line; shared by rectangular and round reading areas.
const char *ht_take_line(const char **cursor, int cells);
// Display-only normalization, before measuring/wrapping. Bounded, no allocation;
// false means the destination was truncated. Source and destination must differ.
bool ht_display_text(char *dst, size_t capacity, const char *src, const ht_font_t *font);
const char *ht_take_display_line(const char **cursor, int cells, const ht_font_t *font);
int ht_wrap(ht_scene_t *scene, int x, int y, int width, int lines, int skip, const ht_font_t *font,
            uint16_t fg, const char *text);
void ht_damage(const ht_scene_t *before, const ht_scene_t *after, ht_damage_t *out);
// Output is RGB565 in THIS BOARD'S panel order — byte-swapped for the dial's CO5300 over QSPI, native
// for the Pro's ST7703 DPI framebuffer. See panel16() in terminal.c. Buffer holds region.w * region.h.
void ht_raster(const ht_scene_t *scene, ht_rect_t region, uint16_t *out);
uint32_t ht_utf8_next(const char **cursor);
// Question/answer text must fit in full and contain glyphs available on this device.
bool ht_can_display(const char *text, const ht_font_t *font, int width, int lines);
int ht_text_rows(const char *text, const ht_font_t *font, int width);
